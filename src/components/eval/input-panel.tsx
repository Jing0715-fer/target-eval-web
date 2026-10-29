'use client'

import { useMemo, useState } from 'react'
import {
  ChevronDown,
  CircleAlert,
  CircleCheckBig,
  Dna,
  FileText,
  LoaderCircle,
  Ruler,
  Settings2,
  Sparkles,
  Target,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { countResidues, parseMultiUniprotIds, parseMultiFasta, type FastaEntry } from './format'
import { fetchDocxInsights, uploadEvaluateDocx, type UploadProgress } from './api'
import { DocxUploadPanel, validateDocxFile } from './docx-upload-panel'
import type { EvaluateOptions, EvaluateRequest, FormInsights, InputMode, UploadResponse } from './types'
import type { StartResult } from './use-evaluation-flow'

type TabMode = InputMode

const EXAMPLE_UNIPROTS = [
  { id: 'P00533', name: 'EGFR' },
  { id: 'P04637', name: 'p53' },
]

const MIN_SEQUENCE_LENGTH = 10
const MIN_COMPANION_LENGTH = 30
/** docx 批量评估的 UniProt 靶点数上限（串行执行，防止排队过久） */
const MAX_BATCH_UNIPROT = 5

export interface InputPanelProps {
  submitting: boolean
  submitError: string | null
  /** v1.10：docxSequences = 评估表原始序列（关系判断归属后按靶点附构建序列） */
  onStart: (requests: EvaluateRequest[], opts?: { docxSequences?: string[] }) => Promise<StartResult>
  onClearSubmitError: () => void
}

/** 输入视图（idle）：编辑刊头 + 三种输入模式 + 客户目标 + 高级选项 + 开始评估 */
export function InputPanel({ submitting, submitError, onStart, onClearSubmitError }: InputPanelProps) {
  const [mode, setMode] = useState<TabMode>('uniprot')

  // UniProt 输入（v1.22：支持多 ID，逗号/空格/换行分隔）
  const [uniprot, setUniprot] = useState('')
  const uniprotParsed = useMemo(() => parseMultiUniprotIds(uniprot), [uniprot])
  const uniprotValid = uniprotParsed.valid.length >= 1 && uniprotParsed.invalid.length === 0
  const uniprotMulti = uniprotParsed.valid.length > 1
  const uniprotOverLimit = uniprotParsed.valid.length > MAX_BATCH_UNIPROT

  // UniProt Tab 的可选伴随序列（合并评估）
  const [companionOpen, setCompanionOpen] = useState(false)
  const [companionText, setCompanionText] = useState('')
  const companionInfo = useMemo(() => countResidues(companionText), [companionText])
  const companionValid = companionInfo.count >= MIN_COMPANION_LENGTH

  // v1.23 评估范围限定（UniProt 残基编号，1-based 闭区间）— 仅 UniProt 单靶点无伴随序列时启用
  const [rangeOpen, setRangeOpen] = useState(false)
  const [rangeStart, setRangeStart] = useState('')
  const [rangeEnd, setRangeEnd] = useState('')
  const rangeStartN = parseInt(rangeStart, 10)
  const rangeEndN = parseInt(rangeEnd, 10)
  const rangeValid = Number.isFinite(rangeStartN) && Number.isFinite(rangeEndN)
    && rangeStartN >= 1 && rangeEndN >= rangeStartN && rangeEndN <= 100000
  // 多靶点或有伴随序列时不启用范围（语义不适用：多靶点各自范围不同；伴随序列已隐含构建边界）
  const rangeEnabled = uniprotParsed.valid.length === 1 && !companionValid
  const range = rangeEnabled && rangeValid ? [rangeStartN, rangeEndN] as [number, number] : undefined

  // 序列输入（v1.22：支持多 FASTA，每个 `>` 标题段一条）
  const [sequenceText, setSequenceText] = useState('')
  const seqInfo = useMemo(() => countResidues(sequenceText), [sequenceText])
  const seqEntries = useMemo(() => parseMultiFasta(sequenceText), [sequenceText])
  const seqMulti = seqEntries.length > 1
  const seqValidEntries = seqEntries.filter(e => e.length >= MIN_SEQUENCE_LENGTH)
  const seqOverLimit = seqEntries.length > MAX_BATCH_UNIPROT

  // Word 评估表上传
  const [upload, setUpload] = useState<UploadResponse | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  /** 已选 UniProt 靶点（多选：每个靶点生成一份独立评估报告） */
  const [selectedUniprots, setSelectedUniprots] = useState<string[]>([])
  const [selectedSequenceIndex, setSelectedSequenceIndex] = useState<number | null>(null)

  // AI 智能解析
  const [insights, setInsights] = useState<FormInsights | null>(null)
  const [insightsLoading, setInsightsLoading] = useState(false)
  const [insightsError, setInsightsError] = useState<string | null>(null)
  const [goalAutoFilled, setGoalAutoFilled] = useState(false)

  const docxReady = Boolean(
    upload && (selectedUniprots.length > 0 || (selectedSequenceIndex != null && upload.parsed.sequences[selectedSequenceIndex]))
  )

  // 客户目标
  const [goal, setGoal] = useState('')

  // 高级选项
  const [advOpen, setAdvOpen] = useState(false)
  const [blastEnabled, setBlastEnabled] = useState(true)
  const [forceBlast, setForceBlast] = useState(false)
  const [maxPdb, setMaxPdb] = useState(150)

  /** 上传成功后自动执行 LLM 智能解析（不阻塞选择评估对象） */
  const runInsights = async (uploadId: string) => {
    setInsightsLoading(true)
    setInsightsError(null)
    setInsights(null)
    try {
      const res = await fetchDocxInsights(uploadId)
      const data = res.insights
      if (!data) throw new Error('解析结果为空')
      setInsights(data)
      // 目标输入框为空时自动填入解析出的客户目标
      if (data.goals.length > 0 && goal.trim() === '') {
        setGoal(data.goals.slice(0, 3).join('；'))
        setGoalAutoFilled(true)
      }
    } catch (e) {
      setInsightsError(e instanceof Error ? e.message : '智能解析失败')
    } finally {
      setInsightsLoading(false)
    }
  }

  const handleFileSelected = async (file: File) => {
    const invalid = validateDocxFile(file)
    if (invalid) {
      setUploadError(invalid)
      return
    }
    setUploading(true)
    setUploadProgress(null)
    setUploadError(null)
    setInsights(null)
    setInsightsError(null)
    try {
      const res = await uploadEvaluateDocx(file, setUploadProgress)
      setUpload(res)
      // 默认选中全部 UniProt（用户要求：表中的 UniProt 都要评估，不落下；上限 MAX_BATCH_UNIPROT 个）
      if (res.parsed.uniprotIds.length > 0) {
        setSelectedUniprots(res.parsed.uniprotIds.slice(0, MAX_BATCH_UNIPROT))
        setSelectedSequenceIndex(null)
      } else if (res.parsed.sequences.length > 0) {
        setSelectedUniprots([])
        setSelectedSequenceIndex(0)
      } else {
        setSelectedUniprots([])
        setSelectedSequenceIndex(null)
      }
      // 后台执行 LLM 智能解析
      void runInsights(res.uploadId)
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : '上传解析失败，请稍后重试')
    } finally {
      setUploading(false)
      setUploadProgress(null)
    }
  }

  const clearUpload = () => {
    setUpload(null)
    setSelectedUniprots([])
    setSelectedSequenceIndex(null)
    setUploadError(null)
    setUploadProgress(null)
    setInsights(null)
    setInsightsError(null)
  }

  const applyGoal = (text: string) => {
    setGoal(text)
    setGoalAutoFilled(false)
  }

  const inputReady =
    mode === 'uniprot'
      ? uniprotValid && !uniprotOverLimit
      : mode === 'sequence'
        ? seqInfo.count >= MIN_SEQUENCE_LENGTH && !seqOverLimit
        : docxReady

  /** 切换 UniProt 靶点选中态（多选，上限 MAX_BATCH_UNIPROT） */
  const toggleUniprot = (id: string) => {
    setSelectedUniprots(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : prev.length < MAX_BATCH_UNIPROT ? [...prev, id] : prev,
    )
  }

  const handleStart = async () => {
    if (!inputReady || submitting) return
    onClearSubmitError()
    const options: EvaluateOptions = {
      skipBlast: !blastEnabled,
      forceBlast: blastEnabled && forceBlast,
      maxPdb,
    }
    const trimmedGoal = goal.trim() || undefined
    let requests: EvaluateRequest[]
    if (mode === 'uniprot') {
      // v1.22：支持多 UniProt ID — 每个 ID 一份独立作业（批量编排 + 关系判断 + 共有结构）。
      // 单 ID 时保留可选伴随序列（同靶点合并评估）；多 ID 时伴随序列不附加（语义不适用）。
      // v1.23：单 ID 无伴随序列时支持评估范围限定（range）。
      const ids = uniprotParsed.valid.slice(0, MAX_BATCH_UNIPROT)
      const companion = companionText.trim() && companionValid && ids.length === 1 ? companionText.trim() : undefined
      const reqRange = ids.length === 1 && !companion ? range : undefined
      requests = ids.map(id => ({
        mode: 'uniprot' as const,
        uniprot: id,
        sequence: companion,
        goal: trimmedGoal,
        options: { ...options, range: reqRange },
      }))
    } else if (mode === 'sequence') {
      // v1.22：支持多 FASTA — 每条序列一份独立作业（批量编排 + 关系判断 + 共有结构）。
      // 单条序列直接提交；多条按 `>` 标题段拆分，每条 ≥MIN_SEQUENCE_LENGTH 的独立评估。
      const entries = seqEntries.slice(0, MAX_BATCH_UNIPROT)
      if (entries.length === 0) return
      requests = entries.map(e => ({
        mode: 'sequence' as const,
        sequence: e.seq,
        goal: trimmedGoal,
        options,
      }))
    } else if (!upload) {
      return
    } else {
      const selectedSeq =
        selectedSequenceIndex != null
          ? (upload.parsed.sequences[selectedSequenceIndex]?.seq ?? undefined)
          : undefined
      // 多 UniProt 靶点 → 每个靶点一份独立作业（串行执行，全部不落下）；
      // 仅选序列时 → 单作业。伴随序列随每个作业提交，由后端同靶点校验决定是否合并；
      // v1.10：评估表全部序列一并上送 — 关系判断归属后（同源家族/构建归属）按靶点附构建序列
      const targets = selectedUniprots.length > 0 ? selectedUniprots : [null]
      requests = targets.map(u => ({
        mode: 'docx' as const,
        // 契约字段 docxJobId + 兼容别名 uploadId（同值），后端取任一均可
        docxJobId: upload.uploadId,
        uploadId: upload.uploadId,
        uniprotFromDocx: u ?? undefined,
        sequence: selectedSeq,
        sequenceFromDocx: selectedSeq,
        goal: trimmedGoal,
        options,
      }))
      const docxSequences = upload.parsed.sequences.map(s => s.seq ?? '')
      await onStart(requests, { docxSequences })
      return
    }
    await onStart(requests)
  }

  return (
    <div className="flex flex-col gap-8">
      {/* 刊头（编辑风） */}
      <header className="flex flex-col gap-3">
        <p className="eval-eyebrow text-emerald-800 dark:text-emerald-500">
          Protein Structure Feasibility · 新建评估
        </p>
        <h1 className="font-display text-2xl leading-snug font-bold text-stone-900 sm:text-3xl dark:text-stone-50">
          靶点结构解析可行性评估
        </h1>
        <p className="max-w-2xl text-sm leading-relaxed text-stone-500 dark:text-stone-400">
          输入 UniProt ID、氨基酸序列，或上传 Word 评估表。系统将自动聚合
          <span className="font-mono text-xs text-stone-600 dark:text-stone-300"> UniProt · RCSB PDB · PDBe · PubMed · BLAST </span>
          数据，生成结构研究全景综述与三方法（X-ray / Cryo-EM / NMR）可行性评估报告。
        </p>
      </header>

      {/* 输入主体 */}
      <div className="rounded-lg border border-stone-200 bg-white shadow-[0_1px_2px_rgba(28,25,23,0.04)] dark:border-stone-800 dark:bg-stone-900">
        <Tabs value={mode} onValueChange={(v) => setMode(v as TabMode)}>
          {/* 下划线式 Tab */}
          <TabsList className="h-auto w-full justify-start gap-0 rounded-none border-b border-stone-200 bg-transparent p-0 dark:border-stone-800">
            <TabsTrigger
              value="uniprot"
              className="h-12 min-h-12 flex-none gap-2 rounded-none border-b-2 border-transparent bg-transparent px-4 text-xs font-medium text-stone-500 shadow-none transition-colors sm:px-5 sm:text-sm data-[state=active]:border-emerald-700 data-[state=active]:bg-transparent data-[state=active]:text-emerald-800 data-[state=active]:shadow-none dark:data-[state=active]:border-emerald-500 dark:data-[state=active]:text-emerald-400"
            >
              UniProt ID
            </TabsTrigger>
            <TabsTrigger
              value="sequence"
              className="h-12 min-h-12 flex-none gap-2 rounded-none border-b-2 border-transparent bg-transparent px-4 text-xs font-medium text-stone-500 shadow-none transition-colors sm:px-5 sm:text-sm data-[state=active]:border-emerald-700 data-[state=active]:bg-transparent data-[state=active]:text-emerald-800 data-[state=active]:shadow-none dark:data-[state=active]:border-emerald-500 dark:data-[state=active]:text-emerald-400"
            >
              氨基酸序列
            </TabsTrigger>
            <TabsTrigger
              value="docx"
              className="h-12 min-h-12 flex-none gap-2 rounded-none border-b-2 border-transparent bg-transparent px-4 text-xs font-medium text-stone-500 shadow-none transition-colors sm:px-5 sm:text-sm data-[state=active]:border-emerald-700 data-[state=active]:bg-transparent data-[state=active]:text-emerald-800 data-[state=active]:shadow-none dark:data-[state=active]:border-emerald-500 dark:data-[state=active]:text-emerald-400"
            >
              Word 评估表
            </TabsTrigger>
          </TabsList>

          <div className="px-5 py-5 sm:px-6">
            <TabsContent value="uniprot" className="mt-0">
              <div className="flex flex-col gap-2.5">
                <Label htmlFor="uniprot-input" className="eval-eyebrow text-stone-500 dark:text-stone-400">
                  UniProt Accession {uniprotMulti && (
                    <span className="ml-1 rounded-sm bg-emerald-100 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-400">
                      {uniprotParsed.valid.length} 个靶点 · 批量评估
                    </span>
                  )}
                </Label>
                <Textarea
                  id="uniprot-input"
                  value={uniprot}
                  onChange={(e) => setUniprot(e.target.value)}
                  placeholder={'支持多个 UniProt ID，用逗号、空格或换行分隔（最多 ' + MAX_BATCH_UNIPROT + ' 个），例如：\nP00533 (EGFR)\nP04637 (p53)\nQ9NZ08'}
                  className="min-h-20 resize-y rounded-md font-mono text-sm uppercase placeholder:font-sans placeholder:normal-case"
                  spellCheck={false}
                />
                {uniprot.trim() !== '' && uniprotParsed.invalid.length > 0 && (
                  <p className="flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
                    <CircleAlert className="size-3.5" />
                    {uniprotParsed.invalid.length} 个格式不正确：{uniprotParsed.invalid.slice(0, 5).join('、')}{uniprotParsed.invalid.length > 5 ? '…' : ''}（UniProt accession 为 6 或 10 位，如 P00533、Q9NZ08）
                  </p>
                )}
                {uniprotOverLimit && (
                  <p className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                    <CircleAlert className="size-3.5" />
                    超过上限 {MAX_BATCH_UNIPROT} 个，将只评估前 {MAX_BATCH_UNIPROT} 个：{uniprotParsed.valid.slice(0, MAX_BATCH_UNIPROT).join('、')}
                  </p>
                )}
                {uniprotValid && (
                  <p className="flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400">
                    <CircleCheckBig className="size-3.5" />
                    {uniprotMulti
                      ? `已识别 ${uniprotParsed.valid.length} 个靶点，将批量评估并分析关系性与共有结构`
                      : '格式正确，将自动获取该蛋白的元数据与结构信息'}
                  </p>
                )}
                {uniprot.trim() === '' && (
                  <div className="flex flex-wrap items-center gap-2 text-xs text-stone-400 dark:text-stone-500">
                    <span className="eval-eyebrow">示例</span>
                    {EXAMPLE_UNIPROTS.map((ex) => (
                      <button
                        key={ex.id}
                        type="button"
                        onClick={() => setUniprot(ex.id)}
                        className="min-h-8 rounded-md border border-stone-200 bg-stone-50 px-2.5 font-mono text-[11px] text-stone-600 transition-colors hover:border-emerald-500 hover:text-emerald-800 dark:border-stone-700 dark:bg-stone-800/60 dark:text-stone-300 dark:hover:border-emerald-600 dark:hover:text-emerald-400"
                      >
                        {ex.id} · {ex.name}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => setUniprot(EXAMPLE_UNIPROTS.map(ex => ex.id).join(', '))}
                      className="min-h-8 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 font-mono text-[11px] text-emerald-700 transition-colors hover:border-emerald-500 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-400"
                    >
                      多靶点示例（EGFR + p53）
                    </button>
                  </div>
                )}

                {/* 可选伴随序列：与 UniProt 合并为一次评估 */}
                <Collapsible open={companionOpen} onOpenChange={setCompanionOpen} className="mt-2.5">
                  <div className="rounded-md border border-stone-200 dark:border-stone-800">
                    <CollapsibleTrigger className="flex min-h-11 w-full items-center gap-2 rounded-md px-3.5 py-2.5 text-xs font-medium text-stone-600 outline-none transition-colors hover:bg-stone-50 dark:text-stone-400 dark:hover:bg-stone-900/60">
                      <Dna className={cn('size-4', companionValid ? 'text-emerald-700 dark:text-emerald-500' : 'text-stone-400')} />
                      补充构建序列（可选）
                      {companionValid && (
                        <span className="rounded-sm bg-emerald-100 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-400">
                          {companionInfo.count.toLocaleString()} aa · 将合并评估
                        </span>
                      )}
                      <span className="ml-auto font-mono text-[10px] font-normal text-stone-400 dark:text-stone-500">
                        {companionValid ? '以 UniProt 为主 · 序列做构建边界分析' : '同一靶点时自动合并，避免重复评估'}
                      </span>
                      <ChevronDown
                        className={cn(
                          'size-4 shrink-0 text-stone-400 transition-transform duration-200',
                          companionOpen && 'rotate-180'
                        )}
                      />
                    </CollapsibleTrigger>
                    <CollapsibleContent className="data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-1">
                      <div className="flex flex-col gap-2 border-t border-stone-100 px-3.5 py-3.5 dark:border-stone-800">
                        <Textarea
                          value={companionText}
                          onChange={(e) => setCompanionText(e.target.value)}
                          placeholder={'粘贴该靶点的构建序列（截短体/突变体，FASTA 或裸序列）。\n与 UniProt 属同一靶点时将合并为一次评估，并自动分析构建边界（对应全长区间）。'}
                          className="min-h-24 resize-y rounded-md font-mono text-xs leading-relaxed"
                          spellCheck={false}
                          aria-label="补充构建序列（可选）"
                        />
                        {companionText.trim() !== '' && (
                          <p className={cn(
                            'flex items-center gap-1 text-xs',
                            companionValid ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'
                          )}>
                            <CircleCheckBig className="size-3.5" />
                            已识别 {companionInfo.count.toLocaleString()} 个残基
                            {companionValid
                              ? '，将与 UniProt 合并为一次评估'
                              : `，少于 ${MIN_COMPANION_LENGTH} 个残基将被忽略`}
                          </p>
                        )}
                      </div>
                    </CollapsibleContent>
                  </div>
                </Collapsible>

                {/* v1.23 评估范围限定（可选）— 仅单靶点无伴随序列时启用 */}
                <Collapsible open={rangeOpen} onOpenChange={setRangeOpen} className="mt-2.5">
                  <div className="rounded-md border border-stone-200 dark:border-stone-800">
                    <CollapsibleTrigger
                      className={cn(
                        'flex min-h-11 w-full items-center gap-2 rounded-md px-3.5 py-2.5 text-xs font-medium outline-none transition-colors',
                        rangeEnabled
                          ? 'text-stone-600 hover:bg-stone-50 dark:text-stone-400 dark:hover:bg-stone-900/60'
                          : 'cursor-not-allowed text-stone-300 dark:text-stone-600',
                      )}
                    >
                      <Ruler className={cn('size-4', rangeValid ? 'text-emerald-700 dark:text-emerald-500' : 'text-stone-400')} />
                      评估范围（可选）
                      {rangeValid && (
                        <span className="rounded-sm bg-emerald-100 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-400">
                          残基 {rangeStartN}-{rangeEndN}
                        </span>
                      )}
                      <span className="ml-auto font-mono text-[10px] font-normal text-stone-400 dark:text-stone-500">
                        {!rangeEnabled
                          ? '多靶点/有伴随序列时不可用'
                          : rangeValid
                            ? '过滤 PDB/BLAST 命中为与该区间重叠的结构'
                            : '限定分析与该区间重叠的结构'}
                      </span>
                      <ChevronDown
                        className={cn(
                          'size-4 shrink-0 text-stone-400 transition-transform duration-200',
                          rangeOpen && 'rotate-180',
                        )}
                      />
                    </CollapsibleTrigger>
                    <CollapsibleContent className="data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-1">
                      <div className="flex flex-col gap-2 border-t border-stone-100 px-3.5 py-3.5 dark:border-stone-800">
                        <div className="flex flex-wrap items-end gap-3">
                          <div className="flex flex-col gap-1">
                            <Label htmlFor="range-start" className="eval-eyebrow text-stone-500 dark:text-stone-400">起始残基</Label>
                            <Input
                              id="range-start"
                              type="number"
                              min={1}
                              value={rangeStart}
                              onChange={(e) => setRangeStart(e.target.value)}
                              placeholder="如 695"
                              className="h-9 w-28 rounded-md font-mono text-sm"
                              disabled={!rangeEnabled}
                            />
                          </div>
                          <span className="pb-2 text-stone-400">—</span>
                          <div className="flex flex-col gap-1">
                            <Label htmlFor="range-end" className="eval-eyebrow text-stone-500 dark:text-stone-400">结束残基</Label>
                            <Input
                              id="range-end"
                              type="number"
                              min={1}
                              value={rangeEnd}
                              onChange={(e) => setRangeEnd(e.target.value)}
                              placeholder="如 1022"
                              className="h-9 w-28 rounded-md font-mono text-sm"
                              disabled={!rangeEnabled}
                            />
                          </div>
                          {rangeValid && (
                            <span className="pb-2 font-mono text-[11px] text-emerald-700 dark:text-emerald-400">
                              覆盖 {rangeEndN - rangeStartN + 1} aa
                            </span>
                          )}
                        </div>
                        {!rangeEnabled && (
                          <p className="text-xs text-stone-400 dark:text-stone-500">
                            范围限定仅在单个 UniProt ID 且无伴随序列时可用（多靶点各自范围不同；伴随序列已隐含构建边界）。
                          </p>
                        )}
                        {rangeEnabled && (rangeStart !== '' || rangeEnd !== '') && !rangeValid && (
                          <p className="flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
                            <CircleAlert className="size-3.5" />
                            范围无效：需 1 ≤ 起始 ≤ 结束（如 EGFR 激酶域 695-1022）
                          </p>
                        )}
                        {rangeValid && (
                          <p className="text-xs leading-relaxed text-stone-500 dark:text-stone-400">
                            将过滤 PDB 列表与 BLAST 同源命中，仅保留链范围（UniProt 交叉引用）或查询区间与 {rangeStartN}-{rangeEndN} 重叠的结构；报告题目与摘要中也会体现该范围。无范围信息的结构默认保留。
                          </p>
                        )}
                      </div>
                    </CollapsibleContent>
                  </div>
                </Collapsible>
              </div>
            </TabsContent>

            <TabsContent value="sequence" className="mt-0">
              <div className="flex flex-col gap-2.5">
                <Label htmlFor="sequence-input" className="eval-eyebrow text-stone-500 dark:text-stone-400">
                  氨基酸序列 · FASTA 或裸序列 {seqMulti && (
                    <span className="ml-1 rounded-sm bg-emerald-100 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-400">
                      {seqEntries.length} 条序列 · 批量评估
                    </span>
                  )}
                </Label>
                <Textarea
                  id="sequence-input"
                  value={sequenceText}
                  onChange={(e) => setSequenceText(e.target.value)}
                  placeholder={'支持多条 FASTA 序列（每个 > 标题段一条，最多 ' + MAX_BATCH_UNIPROT + ' 条），例如：\n>EGFR kinase domain\nMVPKPVA...\n>p53 DNA-binding domain\nSSSVPSQ...'}
                  className="min-h-40 resize-y rounded-md font-mono text-xs leading-relaxed md:min-h-48"
                  spellCheck={false}
                />
                {seqOverLimit && (
                  <p className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                    <CircleAlert className="size-3.5" />
                    超过上限 {MAX_BATCH_UNIPROT} 条，将只评估前 {MAX_BATCH_UNIPROT} 条序列
                  </p>
                )}
                {seqMulti ? (
                  <p className="flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400">
                    <CircleCheckBig className="size-3.5" />
                    已识别 {seqEntries.length} 条序列（{seqValidEntries.length} 条 ≥{MIN_SEQUENCE_LENGTH} aa），将批量评估并分析关系性与共有结构
                  </p>
                ) : seqInfo.count > 0 && (
                  <p
                    className={cn(
                      'flex items-center gap-1 text-xs',
                      seqInfo.count >= MIN_SEQUENCE_LENGTH
                        ? 'text-emerald-700 dark:text-emerald-400'
                        : 'text-amber-600 dark:text-amber-400'
                    )}
                  >
                    <CircleCheckBig className="size-3.5" />
                    已识别 {seqInfo.count.toLocaleString()} 个氨基酸残基
                    {seqInfo.hasFastaHeader && '（FASTA 格式，已忽略标题行）'}
                    {seqInfo.count < MIN_SEQUENCE_LENGTH && `，建议不少于 ${MIN_SEQUENCE_LENGTH} 个残基`}
                  </p>
                )}
              </div>
            </TabsContent>

            <TabsContent value="docx" className="mt-0">
              <DocxUploadPanel
                upload={upload}
                uploading={uploading}
                uploadProgress={uploadProgress}
                uploadError={uploadError}
                selectionReady={docxReady}
                selectedUniprots={selectedUniprots}
                maxBatchUniprot={MAX_BATCH_UNIPROT}
                selectedSequenceIndex={selectedSequenceIndex}
                insights={insights}
                insightsLoading={insightsLoading}
                insightsError={insightsError}
                onFileSelected={handleFileSelected}
                onClearUpload={clearUpload}
                onToggleUniprot={toggleUniprot}
                onSelectSequence={setSelectedSequenceIndex}
                onRetryInsights={() => upload && void runInsights(upload.uploadId)}
                onApplyGoal={applyGoal}
              />
            </TabsContent>
          </div>
        </Tabs>
      </div>

      {/* 客户目标 */}
      <section
        className="rounded-lg border-l-2 border-amber-400 bg-amber-50/50 py-4 pr-4 pl-5 dark:border-amber-600 dark:bg-amber-950/20"
        aria-labelledby="goal-input-label"
      >
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Target className="size-3.5 text-amber-600 dark:text-amber-500" />
          <Label
            id="goal-input-label"
            htmlFor="goal-input"
            className="text-sm font-semibold text-stone-800 dark:text-stone-200"
          >
            客户目标 / 科学问题
          </Label>
          {goalAutoFilled ? (
            <span className="eval-eyebrow flex items-center gap-1 rounded-sm bg-emerald-100 px-1.5 py-0.5 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-400">
              <Sparkles className="size-2.5" aria-hidden />
              已从评估表自动填入
            </span>
          ) : (
            <span className="eval-eyebrow rounded-sm bg-amber-100 px-1.5 py-0.5 text-amber-800 dark:bg-amber-900/50 dark:text-amber-400">
              建议填写
            </span>
          )}
        </div>
        <Textarea
          id="goal-input"
          value={goal}
          onChange={(e) => {
            setGoal(e.target.value)
            setGoalAutoFilled(false)
          }}
          placeholder="例如：解析 EGFR 激酶域与抑制剂复合物的冷冻电镜结构，评估 CRO 可行性（上传评估表后 AI 将自动提取并填入）"
          className="min-h-20 resize-y rounded-md border-amber-200 bg-white/80 focus-visible:border-amber-400 focus-visible:ring-amber-500/20 dark:border-amber-900/60 dark:bg-stone-900/60"
        />
        <p className="mt-1.5 text-xs text-stone-500 dark:text-stone-400">
          明确的客户目标将直接用于 LLM 报告中的可行性结论与实验策略推荐（可选；评估表中提取的目标会自动填入）
        </p>
      </section>

      {/* 高级选项 */}
      <Collapsible open={advOpen} onOpenChange={setAdvOpen}>
        <div className="rounded-lg border border-stone-200 dark:border-stone-800">
          <CollapsibleTrigger className="flex min-h-11 w-full items-center gap-2 rounded-md px-4 py-2.5 text-sm font-medium text-stone-700 outline-none transition-colors hover:bg-stone-50 dark:text-stone-300 dark:hover:bg-stone-900/60">
            <Settings2 className="size-4 text-stone-400" />
            高级选项
            <span className="ml-auto font-mono text-[11px] font-normal text-stone-400 dark:text-stone-500">
              BLAST {blastEnabled ? (forceBlast ? '强制' : '自动') : '关闭'} · PDB ≤ {maxPdb}
            </span>
            <ChevronDown
              className={cn(
                'size-4 text-stone-400 transition-transform duration-200',
                advOpen && 'rotate-180'
              )}
            />
          </CollapsibleTrigger>
          <CollapsibleContent className="data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-1">
            <div className="grid gap-5 rounded-b-md border-t border-stone-100 px-4 py-4 dark:border-stone-800 sm:grid-cols-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-stone-800 dark:text-stone-200">
                    自动 BLAST 同源检索
                  </div>
                  <div className="mt-0.5 text-xs leading-relaxed text-stone-500 dark:text-stone-500">
                    结构覆盖不足时自动执行 NCBI BLAST 检索同源结构
                  </div>
                </div>
                <Switch
                  checked={blastEnabled}
                  onCheckedChange={setBlastEnabled}
                  aria-label="自动 BLAST 同源检索"
                  className="data-[state=checked]:bg-emerald-700"
                />
              </div>

              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-stone-800 dark:text-stone-200">
                    强制 BLAST
                  </div>
                  <div className="mt-0.5 text-xs leading-relaxed text-stone-500 dark:text-stone-500">
                    无论覆盖情况如何，始终执行同源结构检索
                  </div>
                </div>
                <Switch
                  checked={forceBlast && blastEnabled}
                  disabled={!blastEnabled}
                  onCheckedChange={setForceBlast}
                  aria-label="强制 BLAST"
                  className="data-[state=checked]:bg-emerald-700"
                />
              </div>

              <div className="sm:col-span-2">
                <div className="text-sm font-medium text-stone-800 dark:text-stone-200">
                  PDB 结构详情数量上限
                </div>
                <div className="mt-0.5 text-xs text-stone-500 dark:text-stone-500">
                  限制逐条拉取的 RCSB 结构详情数量，越大耗时越长
                </div>
                <Select value={String(maxPdb)} onValueChange={(v) => setMaxPdb(Number(v))}>
                  <SelectTrigger className="mt-2 h-9 w-full rounded-md sm:w-44" aria-label="PDB 详情数上限">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[50, 100, 150, 300].map((n) => (
                      <SelectItem key={n} value={String(n)}>
                        {n} 条
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>

      {/* 提交错误提示 */}
      {submitError && (
        <Alert variant="destructive" className="rounded-md border-red-300 dark:border-red-900">
          <CircleAlert />
          <AlertTitle>无法开始评估</AlertTitle>
          <AlertDescription>
            {submitError}
            {!/上限|繁忙|排队|稍后再试|明日再试|正在或排队/.test(submitError) && (
              <span className="text-xs text-stone-500">（评估服务可能尚未就绪，请稍后重试）</span>
            )}
          </AlertDescription>
        </Alert>
      )}

      {/* 开始评估 */}
      <div className="flex flex-col gap-2.5">
        <Button
          size="lg"
          disabled={!inputReady || submitting}
          onClick={handleStart}
          className="h-12 w-full rounded-md bg-emerald-800 text-base font-semibold text-white shadow-none transition-colors hover:bg-emerald-700 disabled:opacity-40 dark:bg-emerald-700 dark:hover:bg-emerald-600"
        >
          {submitting ? (
            <LoaderCircle className="size-5 animate-spin" />
          ) : (
            <FileText className="size-4.5" />
          )}
          {submitting
            ? '正在创建评估作业…'
            : mode === 'docx' && selectedUniprots.length > 1
              ? `开始评估（${selectedUniprots.length} 个靶点）`
              : mode === 'uniprot' && uniprotMulti
                ? `开始评估（${uniprotParsed.valid.slice(0, MAX_BATCH_UNIPROT).length} 个靶点）`
                : mode === 'sequence' && seqMulti
                  ? `开始评估（${seqEntries.slice(0, MAX_BATCH_UNIPROT).length} 条序列）`
                  : '开始评估'}
        </Button>
        <p className="text-center font-mono text-[11px] text-stone-400 dark:text-stone-500">
          UNIPROT — RCSB — PDBE — PUBMED — BLAST — LLM ANALYSIS
        </p>
      </div>
    </div>
  )
}
