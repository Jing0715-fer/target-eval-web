'use client'

import { useRef, useState } from 'react'
import {
  CircleAlert,
  CircleCheckBig,
  Dna,
  FileCheck2,
  FileUp,
  HelpCircle,
  ImageOff,
  Lightbulb,
  LoaderCircle,
  RefreshCw,
  ScanEye,
  Sparkles,
  Target,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { elideSequenceRuns } from '@/lib/eval/seq-elide'
import { KindBadge } from './badges'
import type { UploadProgress } from './api'
import type { FormInsights, UploadResponse } from './types'

export interface DocxUploadPanelProps {
  upload: UploadResponse | null
  uploading: boolean
  /** 分块上传/后台解析进度（null = 未开始或旧流程） */
  uploadProgress: UploadProgress | null
  uploadError: string | null
  selectionReady: boolean
  selectedUniprot: string | null
  selectedSequenceIndex: number | null
  /** LLM 智能解析结果（null = 尚未解析） */
  insights: FormInsights | null
  insightsLoading: boolean
  insightsError: string | null
  onFileSelected: (file: File) => void
  onClearUpload: () => void
  onSelectUniprot: (id: string | null) => void
  onSelectSequence: (index: number | null) => void
  onRetryInsights: () => void
  /** 将某条客户目标应用到目标输入框 */
  onApplyGoal: (text: string) => void
}

const MAX_SIZE_BYTES = 20 * 1024 * 1024

/** Word 评估表上传与解析结果展示（拖拽/点击上传 → UniProt/序列点选 + AI 智能解析要点 → 图片网格） */
export function DocxUploadPanel(props: DocxUploadPanelProps) {
  const {
    upload,
    uploading,
    uploadProgress,
    uploadError,
    selectionReady,
    selectedUniprot,
    selectedSequenceIndex,
    insights,
    insightsLoading,
    insightsError,
    onFileSelected,
    onClearUpload,
    onSelectUniprot,
    onSelectSequence,
    onRetryInsights,
    onApplyGoal,
  } = props
  const [dragOver, setDragOver] = useState(false)
  const [expExpanded, setExpExpanded] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFile = (file: File | undefined | null) => {
    if (!file) return
    // 扩展名/大小校验统一由父级 validateDocxFile 处理并提示
    onFileSelected(file)
  }

  if (!upload) {
    return (
      <div className="flex flex-col gap-2">
        <div
          role="button"
          tabIndex={0}
          aria-label="上传 Word 评估表"
          onClick={() => !uploading && inputRef.current?.click()}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === ' ') && !uploading) {
              e.preventDefault()
              inputRef.current?.click()
            }
          }}
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            handleFile(e.dataTransfer.files?.[0])
          }}
          className={cn(
            'flex min-h-40 cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed px-6 py-8 text-center outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-emerald-500/40',
            dragOver
              ? 'border-emerald-600 bg-emerald-50/70 dark:bg-emerald-950/40'
              : 'border-stone-300 bg-stone-50/60 hover:border-emerald-500 hover:bg-emerald-50/30 dark:border-stone-700 dark:bg-stone-900/40 dark:hover:border-emerald-600',
            uploading && 'pointer-events-none opacity-80'
          )}
        >
          {uploading ? (
            <LoaderCircle className="size-7 animate-spin text-emerald-700" />
          ) : (
            <FileUp className="size-7 text-stone-400 dark:text-stone-500" />
          )}
          <div className="text-sm font-medium text-stone-700 dark:text-stone-300">
            {uploading
              ? uploadProgress?.phase === 'uploading'
                ? `正在上传评估表… ${Math.min(100, Math.round((uploadProgress.loaded / Math.max(1, uploadProgress.total)) * 100))}%`
                : '正在解析评估表（含图片 AI 识别）…'
              : '拖拽 Word 评估表到此处，或点击选择文件'}
          </div>
          {uploading && uploadProgress?.phase === 'uploading' && (
            <div className="h-1.5 w-full max-w-72 overflow-hidden rounded-full bg-stone-200 dark:bg-stone-800" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((uploadProgress.loaded / Math.max(1, uploadProgress.total)) * 100)}>
              <div
                className="h-full rounded-full bg-emerald-600 transition-all"
                style={{ width: `${Math.min(100, (uploadProgress.loaded / Math.max(1, uploadProgress.total)) * 100)}%` }}
              />
            </div>
          )}
          {uploading && uploadProgress?.phase === 'parsing' && (
            <div className="text-[11px] text-stone-400 dark:text-stone-500">分块上传完成，服务器后台解析中（多图识别约需 10–90 秒）…</div>
          )}
          <div className="font-mono text-[11px] text-stone-400 dark:text-stone-500">
            支持 .docx 格式（≤ 20MB），上传后自动解析 UniProt ID、序列与实验图片（自动区分 SDS-PAGE 胶图与 SEC 分子筛图），并由 AI 提取目标与科学问题
          </div>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".docx"
          className="hidden"
          onChange={(e) => {
            handleFile(e.target.files?.[0])
            e.target.value = ''
          }}
        />
        {uploadError && (
          <p className="text-xs text-red-600 dark:text-red-400">{uploadError}</p>
        )}
      </div>
    )
  }

  const { parsed } = upload
  const hasBoth = Boolean(selectedUniprot && selectedSequenceIndex != null)
  // 要点文本渲染时省略长序列片段（兼容历史缓存 insights），并配合 break-words 防溢出
  const eGoals = (insights?.goals ?? []).map(elideSequenceRuns)
  const eQuestions = (insights?.scientificQuestions ?? []).map(elideSequenceRuns)
  const eExpSummary = elideSequenceRuns(insights?.experimentalSummary)
  const eSeqNotes = elideSequenceRuns(insights?.sequenceNotes)
  const eHomologs = elideSequenceRuns(insights?.homologs)
  const eConcerns = (insights?.keyConcerns ?? []).map(elideSequenceRuns)
  return (
    <div className="flex flex-col gap-4 rounded-md border border-stone-200 bg-stone-50/50 p-4 dark:border-stone-800 dark:bg-stone-900/40">
      {/* 解析摘要 */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <CircleCheckBig className="size-4 shrink-0 text-emerald-700" />
        <span className="font-medium text-stone-800 dark:text-stone-200">评估表解析完成</span>
        <span className="text-xs text-stone-500 dark:text-stone-500">
          {parsed.uniprotIds.length} 个 UniProt · {parsed.sequences.length} 条序列 ·{' '}
          {parsed.images.length} 张图片
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-8 px-2.5 text-xs text-stone-500 hover:text-stone-800 dark:hover:text-stone-200"
          onClick={onClearUpload}
          disabled={uploading}
        >
          重新上传
        </Button>
      </div>

      {/* 基因名 */}
      {(parsed.genes.length > 0 || (insights?.geneNames?.length ?? 0) > 0) && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium text-stone-500 dark:text-stone-500">基因名：</span>
          {[...new Set([...(parsed.genes ?? []), ...(insights?.geneNames ?? [])])].slice(0, 8).map((g) => (
            <Badge key={g} variant="secondary" className="font-mono text-[11px]">
              {g}
            </Badge>
          ))}
        </div>
      )}

      {/* AI 智能解析要点 */}
      {insightsLoading && (
        <div className="flex items-center gap-2.5 rounded-md border border-emerald-200 bg-emerald-50/60 px-3.5 py-3 text-xs text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300">
          <LoaderCircle className="size-4 shrink-0 animate-spin text-emerald-700" />
          AI 正在解析评估表：提取客户目标、待解决科学问题与实验数据要点…
        </div>
      )}
      {!insightsLoading && (insights || insightsError) && (
        <div className="rounded-md border border-emerald-200/80 bg-white/70 px-3.5 py-3 dark:border-emerald-900/70 dark:bg-stone-900/60">
          <div className="mb-2 flex items-center gap-2">
            <Sparkles className="size-3.5 shrink-0 text-emerald-700 dark:text-emerald-500" />
            <span className="text-xs font-semibold text-stone-800 dark:text-stone-200">AI 智能解析要点</span>
            {insights?.source === 'llm' ? (
              <span className="eval-eyebrow rounded-sm bg-emerald-100 px-1.5 py-0.5 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-400">
                LLM 提取
              </span>
            ) : insights ? (
              <span className="eval-eyebrow rounded-sm bg-stone-100 px-1.5 py-0.5 text-stone-500 dark:bg-stone-800 dark:text-stone-400">
                规则提取（LLM 不可用）
              </span>
            ) : null}
            {insights?.proteinName && (
              <span
                className="ml-auto min-w-0 truncate font-mono text-[11px] text-stone-400"
                title={`${insights.proteinName}${insights.organism ? ` · ${insights.organism}` : ''}`}
              >
                {insights.proteinName}{insights.organism ? ` · ${insights.organism}` : ''}
              </span>
            )}
          </div>

          {insightsError && !insights && (
            <div className="flex flex-col gap-2 text-xs text-amber-700 dark:text-amber-400">
              <span className="flex items-center gap-1.5">
                <CircleAlert className="size-3.5 shrink-0" />
                {insightsError}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={onRetryInsights}
                className="h-7 w-fit gap-1.5 rounded-md px-2.5 text-[11px]"
              >
                <RefreshCw className="size-3" />
                重新解析
              </Button>
            </div>
          )}

          {insights && (
            <div className="flex flex-col gap-2.5">
              {/* 客户目标 */}
              {eGoals.length > 0 && (
                <div>
                  <div className="mb-1 flex items-center gap-1 text-[11px] font-medium text-stone-500 dark:text-stone-400">
                    <Target className="size-3 text-amber-600" />
                    客户目标（点击可填入下方目标输入框）
                  </div>
                  <div className="flex flex-col gap-1">
                    {eGoals.map((g, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => onApplyGoal(g)}
                        className="break-words rounded-sm border-l-2 border-amber-400 bg-amber-50/60 px-2.5 py-1.5 text-left text-xs leading-relaxed text-stone-700 transition-colors hover:bg-amber-100/80 dark:border-amber-600 dark:bg-amber-950/20 dark:text-stone-300 dark:hover:bg-amber-950/40"
                        title="点击填入客户目标"
                      >
                        {g}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* 科学问题 */}
              {eQuestions.length > 0 && (
                <div>
                  <div className="mb-1 flex items-center gap-1 text-[11px] font-medium text-stone-500 dark:text-stone-400">
                    <HelpCircle className="size-3 text-emerald-700 dark:text-emerald-500" />
                    待解决的科学问题
                  </div>
                  <ol className="ml-4 list-decimal space-y-0.5">
                    {eQuestions.map((q, i) => (
                      <li key={i} className="break-words text-xs leading-relaxed text-stone-700 dark:text-stone-300">{q}</li>
                    ))}
                  </ol>
                </div>
              )}

              {/* 实验数据要点 */}
              {eExpSummary && (
                <div>
                  <div className="mb-1 flex items-center gap-1 text-[11px] font-medium text-stone-500 dark:text-stone-400">
                    <FileCheck2 className="size-3 text-emerald-700 dark:text-emerald-500" />
                    实验数据要点
                  </div>
                  <p className={cn('break-words text-xs leading-relaxed text-stone-600 dark:text-stone-400', !expExpanded && 'line-clamp-3')}>
                    {eExpSummary}
                  </p>
                  {eExpSummary.length > 90 && (
                    <button
                      type="button"
                      onClick={() => setExpExpanded(v => !v)}
                      className="mt-0.5 font-mono text-[10px] text-emerald-700 hover:underline dark:text-emerald-500"
                    >
                      {expExpanded ? '－ 收起' : '＋ 展开全部'}
                    </button>
                  )}
                </div>
              )}

              {/* 构建说明 / 同源 / 风险 */}
              <div className="flex flex-col gap-1.5">
                {eSeqNotes && (
                  <p className="break-words text-xs leading-relaxed text-stone-500 dark:text-stone-400">
                    <span className="eval-eyebrow mr-1.5 text-stone-400">构建</span>
                    {eSeqNotes}
                  </p>
                )}
                {eHomologs && (
                  <p className="break-words text-xs leading-relaxed text-stone-500 dark:text-stone-400">
                    <span className="eval-eyebrow mr-1.5 text-stone-400">同源</span>
                    {eHomologs}
                  </p>
                )}
                {eConcerns.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="eval-eyebrow text-stone-400">风险</span>
                    {eConcerns.map((c, i) => (
                      <span key={i} className="break-words rounded-sm border border-amber-200 bg-amber-50/70 px-1.5 py-0.5 text-[11px] text-amber-800 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-400">
                        <Lightbulb className="mr-0.5 inline size-2.5" aria-hidden />
                        {c}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* UniProt ID chips */}
      {parsed.uniprotIds.length > 0 && (
        <div>
          <div className="mb-2 text-xs font-medium text-stone-600 dark:text-stone-400">
            识别出的 UniProt ID（点选作为评估对象）
          </div>
          <div className="flex flex-wrap gap-2">
            {parsed.uniprotIds.map((id) => {
              const selected = selectedUniprot === id
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    onSelectUniprot(selected ? null : id)
                  }}
                  className={cn(
                    'min-h-10 rounded-md border px-3.5 font-mono text-sm transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-emerald-500/40',
                    selected
                      ? 'border-emerald-700 bg-emerald-800 font-semibold text-white'
                      : 'border-stone-300 bg-white text-stone-700 hover:border-emerald-500 hover:text-emerald-800 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300 dark:hover:border-emerald-600 dark:hover:text-emerald-400'
                  )}
                >
                  {id}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* 序列列表（已选 UniProt 时 → 构建对照序列，可叠加选择） */}
      {parsed.sequences.length > 0 && (
        <div>
          <div className="mb-2 text-xs font-medium text-stone-600 dark:text-stone-400">
            {selectedUniprot
              ? '识别出的序列（可选一条作为构建对照 — 与所选 UniProt 合并为一次评估，用于构建边界分析）'
              : '识别出的序列（点选作为评估对象）'}
          </div>
          <div className="flex flex-col gap-2">
            {parsed.sequences.map((s, i) => {
              const selected = selectedSequenceIndex === i
              return (
                <button
                  key={`${s.header}-${i}`}
                  type="button"
                  onClick={() => {
                    onSelectSequence(selected ? null : i)
                  }}
                  className={cn(
                    'rounded-md border p-3 text-left transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-emerald-500/40',
                    selected
                      ? 'border-emerald-700 bg-emerald-50 ring-1 ring-emerald-700 dark:border-emerald-600 dark:bg-emerald-950/40'
                      : 'border-stone-200 bg-white hover:border-emerald-400 dark:border-stone-800 dark:bg-stone-900 dark:hover:border-emerald-700'
                  )}
                >
                  <div className="flex items-baseline gap-2">
                    {selected && <Dna className="size-3.5 shrink-0 self-center text-emerald-700 dark:text-emerald-500" aria-hidden />}
                    <span className="min-w-0 truncate text-xs font-medium text-stone-700 dark:text-stone-300">
                      {s.header?.trim() || `序列 ${i + 1}`}
                    </span>
                    <span className="ml-auto shrink-0 text-[11px] text-emerald-700 dark:text-emerald-500">
                      {s.length || s.seq?.length || 0} aa
                    </span>
                  </div>
                  {s.seq && (
                    <p
                      className="mt-1 truncate font-mono text-[11px] text-stone-400 dark:text-stone-500"
                      title={s.seq}
                    >
                      {s.seq}
                    </p>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* 图片缩略图网格（自动区分胶图 / SEC） */}
      {parsed.images.length > 0 && (
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs font-medium text-stone-600 dark:text-stone-400">
            <span>提取的实验图片</span>
            {parsed.images.some(im => im.vlmKind) ? (
              <span className="eval-eyebrow flex items-center gap-1 rounded-sm bg-emerald-100 px-1.5 py-0.5 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-400">
                <ScanEye className="size-2.5" aria-hidden />
                AI 视觉识别类型
              </span>
            ) : null}
            {(() => {
              const gel = parsed.images.filter(im => im.kind === 'gel').length
              const sec = parsed.images.filter(im => im.kind === 'sec').length
              if (!gel && !sec) return null
              return (
                <span className="text-stone-400 dark:text-stone-500">
                  （{[gel ? `${gel} 张 SDS-PAGE 胶图` : null, sec ? `${sec} 张 SEC 分子筛图` : null].filter(Boolean).join(' · ')}）
                </span>
              )
            })()}
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {parsed.images.map((img) => (
              <div
                key={img.id}
                className="overflow-hidden rounded-lg border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900"
              >
                <div className="relative h-28 bg-stone-100 dark:bg-stone-800">
                  <img
                    src={`/api/assets/${img.id}`}
                    alt={img.caption || '实验图片'}
                    loading="lazy"
                    className="size-full object-contain"
                  />
                  <KindBadge kind={img.kind} className="absolute top-1.5 left-1.5" />
                  {img.vlmKind && (
                    <span
                      className="absolute top-1.5 right-1.5 flex items-center gap-0.5 rounded-sm border border-emerald-300/80 bg-white/90 px-1 py-px font-mono text-[9px] font-semibold text-emerald-800 backdrop-blur-sm dark:border-emerald-800 dark:bg-stone-900/90 dark:text-emerald-400"
                      title="类型由 AI 视觉识别判定"
                    >
                      <ScanEye className="size-2.5" aria-hidden />
                      AI
                    </span>
                  )}
                </div>
                <div className="flex items-start gap-1 px-2 py-1.5">
                  <FileCheck2 className="mt-0.5 size-3 shrink-0 text-stone-400" />
                  <p
                    className="line-clamp-2 text-[11px] leading-snug text-stone-500 dark:text-stone-500"
                    title={img.caption || `${img.sizeKB} KB`}
                  >
                    {img.caption?.trim() || `${img.mime || '图片'} · ${img.sizeKB}KB`}
                  </p>
                </div>
              </div>
            ))}
          </div>
          {parsed.skippedImages && parsed.skippedImages > 0 && (
            <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">
              <ImageOff className="mt-0.5 size-3 shrink-0" aria-hidden />
              另有 {parsed.skippedImages} 张图片无法提取（格式不支持、损坏或超过 6MB），可将其另存为 PNG/JPG 后重新插入文档再上传
            </p>
          )}
        </div>
      )}
      {parsed.images.length === 0 && (parsed.skippedImages ?? 0) > 0 && (
        <p className="flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50/60 px-3 py-2 text-[11px] leading-relaxed text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-400">
          <ImageOff className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          未能提取出可用图片（{parsed.skippedImages} 张格式不支持、损坏或超限）。可将图片另存为 PNG/JPG 后重新插入文档再上传。
        </p>
      )}

      {/* 选择状态提示 */}
      <p
        className={cn(
          'text-xs leading-relaxed',
          selectionReady
            ? 'text-emerald-700 dark:text-emerald-400'
            : 'text-amber-600 dark:text-amber-400'
        )}
      >
        {hasBoth
          ? '将合并为一次评估：以 UniProt 为主，所选序列用于构建边界分析（系统会自动校验二者是否同一靶点）'
          : selectionReady
            ? '已选择评估对象，可以开始评估'
            : '请从上方点选一个 UniProt ID 或序列作为评估对象'}
      </p>

      {uploadError && <p className="text-xs text-red-600 dark:text-red-400">{uploadError}</p>}
    </div>
  )
}

/** 客户端文件预校验（扩展名 / 大小） */
export function validateDocxFile(file: File): string | null {
  if (!file.name.toLowerCase().endsWith('.docx')) {
    return '仅支持 .docx 格式的 Word 文档'
  }
  if (file.size > MAX_SIZE_BYTES) {
    return '文件大小超过 20MB 上限'
  }
  return null
}
