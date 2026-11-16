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
  PillBottle,
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
  /** 已选 UniProt 靶点（多选，每个靶点一份独立报告） */
  selectedUniprots: string[]
  /** 可选靶点数上限 */
  maxBatchUniprot: number
  selectedSequenceIndex: number | null
  /** LLM 智能解析结果（null = 尚未解析） */
  insights: FormInsights | null
  insightsLoading: boolean
  insightsError: string | null
  onFileSelected: (file: File) => void
  onClearUpload: () => void
  onToggleUniprot: (id: string) => void
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
    selectedUniprots,
    maxBatchUniprot,
    selectedSequenceIndex,
    insights,
    insightsLoading,
    insightsError,
    onFileSelected,
    onClearUpload,
    onToggleUniprot,
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
            'flex min-h-28 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed px-6 py-5 text-center outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/30',
            dragOver
              ? 'border-primary bg-primary/[0.05]'
              : 'border-border bg-muted/50 hover:border-ring hover:bg-primary/[0.03]',
            uploading && 'pointer-events-none opacity-80'
          )}
        >
          {uploading ? (
            <LoaderCircle className="size-6 animate-spin text-primary" />
          ) : (
            <FileUp className="size-6 text-muted-foreground/60" />
          )}
          <div className="text-[13px] font-medium text-foreground/90">
            {uploading
              ? uploadProgress?.phase === 'uploading'
                ? `正在上传评估表… ${Math.min(100, Math.round((uploadProgress.loaded / Math.max(1, uploadProgress.total)) * 100))}%`
                : '正在解析评估表（含图片 AI 识别）…'
              : '拖拽 Word 评估表到此处，或点击选择文件'}
          </div>
          {uploading && uploadProgress?.phase === 'uploading' && (
            <div className="h-1.5 w-full max-w-72 overflow-hidden rounded-full bg-border" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((uploadProgress.loaded / Math.max(1, uploadProgress.total)) * 100)}>
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${Math.min(100, (uploadProgress.loaded / Math.max(1, uploadProgress.total)) * 100)}%` }}
              />
            </div>
          )}
          {uploading && uploadProgress?.phase === 'parsing' && (
            <div className="text-[11px] text-muted-foreground/80">分块上传完成，后台解析中（多图识别约需 10–90 秒）…</div>
          )}
          <div className="font-mono text-[10.5px] leading-relaxed text-muted-foreground/70">
            .docx（≤ 20MB）· 自动解析 UniProt ID、序列与实验图片，AI 提取目标与科学问题
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
  const hasBoth = Boolean(selectedUniprots.length > 0 && selectedSequenceIndex != null)
  // 要点文本渲染时省略长序列片段（兼容历史缓存 insights），并配合 break-words 防溢出
  const eGoals = (insights?.goals ?? []).map(elideSequenceRuns)
  const eQuestions = (insights?.scientificQuestions ?? []).map(elideSequenceRuns)
  const eExpSummary = elideSequenceRuns(insights?.experimentalSummary)
  const eSeqNotes = elideSequenceRuns(insights?.sequenceNotes)
  const eHomologs = elideSequenceRuns(insights?.homologs)
  const eConcerns = (insights?.keyConcerns ?? []).map(elideSequenceRuns)
  // v2.4：AI 从评估表提取到的配体（提交评估时自动作为研究输入）
  const eLigands = (insights?.ligands ?? []).map(x => x.trim()).filter(Boolean)
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/40 p-3.5">
      {/* 解析摘要 */}
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <CircleCheckBig className="size-4 shrink-0 text-primary" />
        <span className="font-medium text-foreground">评估表解析完成</span>
        <span className="text-xs text-muted-foreground">
          {parsed.uniprotIds.length} 个 UniProt · {parsed.sequences.length} 条序列 ·{' '}
          {parsed.images.length} 张图片
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-8 px-2.5 text-xs text-muted-foreground hover:text-foreground"
          onClick={onClearUpload}
          disabled={uploading}
        >
          重新上传
        </Button>
      </div>

      {/* 基因名 */}
      {(parsed.genes.length > 0 || (insights?.geneNames?.length ?? 0) > 0) && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">基因名：</span>
          {[...new Set([...(parsed.genes ?? []), ...(insights?.geneNames ?? [])])].slice(0, 8).map((g) => (
            <Badge key={g} variant="secondary" className="font-mono text-[11px]">
              {g}
            </Badge>
          ))}
        </div>
      )}

      {/* AI 智能解析要点 */}
      {insightsLoading && (
        <div className="flex items-center gap-2.5 rounded-lg border border-primary/25 bg-primary/[0.05] px-3.5 py-3 text-xs text-foreground/90">
          <LoaderCircle className="size-4 shrink-0 animate-spin text-primary" />
          AI 正在解析评估表：提取客户目标、待解决科学问题与实验数据要点…
        </div>
      )}
      {!insightsLoading && (insights || insightsError) && (
        <div className="rounded-lg border border-border bg-card px-3.5 py-3">
          <div className="mb-2 flex items-center gap-2">
            <Sparkles className="size-3.5 shrink-0 text-primary" />
            <span className="text-xs font-semibold text-foreground">AI 智能解析要点</span>
            {insights?.source === 'llm' ? (
              <span className="lin-eyebrow rounded-md bg-primary/10 px-1.5 py-0.5 text-primary">
                LLM 提取
              </span>
            ) : insights ? (
              <span className="lin-eyebrow rounded-md bg-muted px-1.5 py-0.5 text-muted-foreground">
                规则提取（LLM 不可用）
              </span>
            ) : null}
            {insights?.proteinName && (
              <span
                className="ml-auto min-w-0 truncate font-mono text-[11px] text-muted-foreground/70"
                title={`${insights.proteinName}${insights.organism ? ` · ${insights.organism}` : ''}`}
              >
                {insights.proteinName}{insights.organism ? ` · ${insights.organism}` : ''}
              </span>
            )}
          </div>

          {insightsError && !insights && (
            <div className="flex flex-col gap-2 text-xs text-amber-600 dark:text-amber-400">
              <span className="flex items-center gap-1.5">
                <CircleAlert className="size-3.5 shrink-0" />
                {insightsError}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={onRetryInsights}
                className="h-7 w-fit gap-1.5 rounded-lg px-2.5 text-[11px]"
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
                  <div className="mb-1 flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                    <Target className="size-3 text-amber-500" />
                    客户目标（点击可填入下方目标输入框）
                  </div>
                  <div className="flex flex-col gap-1">
                    {eGoals.map((g, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => onApplyGoal(g)}
                        className="break-words rounded-sm border-l-2 border-amber-400 bg-amber-500/[0.07] px-2.5 py-1.5 text-left text-xs leading-relaxed text-foreground/90 transition-colors hover:bg-amber-500/[0.12]"
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
                  <div className="mb-1 flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                    <HelpCircle className="size-3 text-primary" />
                    待解决的科学问题
                  </div>
                  <ol className="ml-4 list-decimal space-y-0.5">
                    {eQuestions.map((q, i) => (
                      <li key={i} className="break-words text-xs leading-relaxed text-foreground/80">{q}</li>
                    ))}
                  </ol>
                </div>
              )}

              {/* 实验数据要点 */}
              {eExpSummary && (
                <div>
                  <div className="mb-1 flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                    <FileCheck2 className="size-3 text-primary" />
                    实验数据要点
                  </div>
                  <p className={cn('break-words text-xs leading-relaxed text-foreground/80', !expExpanded && 'line-clamp-3')}>
                    {eExpSummary}
                  </p>
                  {eExpSummary.length > 90 && (
                    <button
                      type="button"
                      onClick={() => setExpExpanded(v => !v)}
                      className="mt-0.5 font-mono text-[10px] text-primary hover:underline"
                    >
                      {expExpanded ? '－ 收起' : '＋ 展开全部'}
                    </button>
                  )}
                </div>
              )}

              {/* v2.4 评估表提取的配体（自动作为研究输入，报告含配体研究数据） */}
              {eLigands.length > 0 && (
                <div>
                  <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                    <PillBottle className="size-3 text-primary" />
                    从评估表提取的配体
                    <span className="font-normal text-muted-foreground/70">
                      （提交评估时自动归一为 PDB 化学组分 / PubChem 信息，无需手动输入）
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {eLigands.map((name, i) => (
                      <span
                        key={`${name}-${i}`}
                        className="rounded-md border border-primary/25 bg-primary/[0.06] px-1.5 py-0.5 text-[11px] font-medium text-foreground/90"
                        title="评估表 AI 识别的配体 — 将随评估请求自动提交"
                      >
                        {name}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* 构建说明 / 同源 / 风险 */}
              <div className="flex flex-col gap-1.5">
                {eSeqNotes && (
                  <p className="break-words text-xs leading-relaxed text-muted-foreground">
                    <span className="lin-eyebrow mr-1.5 text-muted-foreground/70">构建</span>
                    {eSeqNotes}
                  </p>
                )}
                {eHomologs && (
                  <p className="break-words text-xs leading-relaxed text-muted-foreground">
                    <span className="lin-eyebrow mr-1.5 text-muted-foreground/70">同源</span>
                    {eHomologs}
                  </p>
                )}
                {eConcerns.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="lin-eyebrow text-muted-foreground/70">风险</span>
                    {eConcerns.map((c, i) => (
                      <span key={i} className="break-words rounded-sm border border-amber-500/30 bg-amber-500/[0.07] px-1.5 py-0.5 text-[11px] text-amber-700 dark:text-amber-400">
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

      {/* UniProt ID chips（多选：每个靶点一份独立评估报告） */}
      {parsed.uniprotIds.length > 0 && (
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs font-medium text-foreground/80">
            <span>识别出的 UniProt ID（可多选，全部将逐个评估并各生成一份报告）</span>
            <span className="rounded-md bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-primary">
              已选 {selectedUniprots.length}/{parsed.uniprotIds.length}
            </span>
            {selectedUniprots.length >= maxBatchUniprot && (
              <span className="text-[11px] font-normal text-amber-600 dark:text-amber-400">（一次最多评估 {maxBatchUniprot} 个靶点）</span>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {parsed.uniprotIds.map((id) => {
              const selected = selectedUniprots.includes(id)
              const disabled = !selected && selectedUniprots.length >= maxBatchUniprot
              return (
                <button
                  key={id}
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    onToggleUniprot(id)
                  }}
                  title={disabled ? `已达一次 ${maxBatchUniprot} 个靶点上限` : selected ? '点击取消选择该靶点' : '点击选中该靶点'}
                  className={cn(
                    'min-h-9 rounded-lg border px-3 font-mono text-[13px] transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-40',
                    selected
                      ? 'border-primary bg-primary font-semibold text-primary-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.15)]'
                      : 'border-border bg-card text-foreground/80 hover:border-ring hover:text-primary'
                  )}
                >
                  {id}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* 序列列表（可叠加选择作构建对照） */}
      {parsed.sequences.length > 0 && (
        <div>
          <div className="mb-2 text-xs font-medium text-foreground/80">
            {selectedUniprots.length > 0
              ? `识别出的序列（可选一条作为构建对照 — 随每个所选 UniProt 提交，仅与同一靶点时合并为构建边界分析）`
              : '识别出的序列（点选作为评估对象）'}
          </div>
          <div className="flex flex-col gap-2">
            {parsed.sequences.map((s, i) => {
              const selected = selectedSequenceIndex === i
              const isAntibody = s.role === 'antibody'
              return (
                <button
                  key={`${s.header}-${i}`}
                  type="button"
                  onClick={() => {
                    onSelectSequence(selected ? null : i)
                  }}
                  className={cn(
                    'rounded-lg border p-2.5 text-left transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30',
                    selected
                      ? 'border-primary bg-primary/[0.06] ring-1 ring-primary'
                      : 'border-border bg-card hover:border-ring/60'
                  )}
                >
                  <div className="flex flex-wrap items-baseline gap-2">
                    {selected && <Dna className="size-3.5 shrink-0 self-center text-primary" aria-hidden />}
                    <span className="min-w-0 truncate text-xs font-medium text-foreground/90">
                      {s.header?.trim() || `序列 ${i + 1}`}
                    </span>
                    {isAntibody && (
                      <span
                        className="flex shrink-0 items-center gap-1 rounded-sm border border-violet-500/30 bg-violet-500/[0.07] px-1.5 py-0.5 text-[10px] font-medium text-violet-600 dark:text-violet-400"
                        title="检测为抗体序列（Fab/Fc/scFv 等）：BLAST 同源检索将自动跳过（抗体结构库命中众多但参考价值低）"
                      >
                        <PillBottle className="size-2.5" aria-hidden />
                        抗体 · 跳过 BLAST
                      </span>
                    )}
                    <span className="ml-auto shrink-0 text-[11px] text-primary">
                      {s.length || s.seq?.length || 0} aa
                    </span>
                  </div>
                  {s.seq && (
                    <p
                      className="mt-1 truncate font-mono text-[11px] text-muted-foreground/70"
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
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs font-medium text-foreground/80">
            <span>提取的实验图片</span>
            {parsed.images.some(im => im.vlmKind) ? (
              <span className="lin-eyebrow flex items-center gap-1 rounded-md bg-primary/10 px-1.5 py-0.5 text-primary">
                <ScanEye className="size-2.5" aria-hidden />
                AI 视觉识别类型
              </span>
            ) : null}
            {(() => {
              const gel = parsed.images.filter(im => im.kind === 'gel').length
              const sec = parsed.images.filter(im => im.kind === 'sec').length
              if (!gel && !sec) return null
              return (
                <span className="text-muted-foreground/70">
                  （{[gel ? `${gel} 张 SDS-PAGE 胶图` : null, sec ? `${sec} 张 SEC 分子筛图` : null].filter(Boolean).join(' · ')}）
                </span>
              )
            })()}
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {parsed.images.map((img) => (
              <div
                key={img.id}
                className="overflow-hidden rounded-lg border border-border bg-card"
              >
                <div className="relative h-24 bg-muted">
                  <img
                    src={img.dataUri ?? `/api/assets/${img.id}`}
                    alt={img.caption || '实验图片'}
                    loading="lazy"
                    className="size-full object-contain"
                  />
                  <KindBadge kind={img.kind} className="absolute top-1.5 left-1.5" />
                  {img.vlmKind && (
                    <span
                      className="absolute top-1.5 right-1.5 flex items-center gap-0.5 rounded-sm border border-primary/40 bg-card/90 px-1 py-px font-mono text-[9px] font-semibold text-primary backdrop-blur-sm"
                      title="类型由 AI 视觉识别判定"
                    >
                      <ScanEye className="size-2.5" aria-hidden />
                      AI
                    </span>
                  )}
                </div>
                <div className="flex items-start gap-1 px-2 py-1.5">
                  <FileCheck2 className="mt-0.5 size-3 shrink-0 text-muted-foreground/60" />
                  <p
                    className="line-clamp-2 text-[11px] leading-snug text-muted-foreground"
                    title={img.caption || `${img.sizeKB} KB`}
                  >
                    {img.caption?.trim() || `${img.mime || '图片'} · ${img.sizeKB}KB`}
                  </p>
                </div>
              </div>
            ))}
          </div>
          {parsed.skippedImages && parsed.skippedImages > 0 && (
            <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
              <ImageOff className="mt-0.5 size-3 shrink-0" aria-hidden />
              另有 {parsed.skippedImages} 张图片无法提取（格式不支持、损坏或超过 6MB），可将其另存为 PNG/JPG 后重新插入文档再上传
            </p>
          )}
        </div>
      )}
      {parsed.images.length === 0 && (parsed.skippedImages ?? 0) > 0 && (
        <p className="flex items-start gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">
          <ImageOff className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          未能提取出可用图片（{parsed.skippedImages} 张格式不支持、损坏或超限）。可将图片另存为 PNG/JPG 后重新插入文档再上传。
        </p>
      )}

      {/* 选择状态提示 */}
      <p
        className={cn(
          'text-xs leading-relaxed',
          selectionReady
            ? 'text-primary'
            : 'text-amber-600 dark:text-amber-400'
        )}
      >
        {hasBoth
          ? selectedUniprots.length > 1
            ? `所选序列将作为 ${selectedUniprots.length} 个靶点的构建对照提交（系统逐个自动校验是否同一靶点，仅同靶点时合并为构建边界分析）`
            : '将合并为一次评估：以 UniProt 为主，所选序列用于构建边界分析（系统会自动校验二者是否同一靶点）'
          : selectionReady
            ? selectedUniprots.length > 1
              ? `已选择 ${selectedUniprots.length} 个 UniProt 靶点，将逐个评估并各生成一份报告`
              : '已选择评估对象，可以开始评估'
            : '请从上方点选 UniProt ID 或序列作为评估对象'}
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
