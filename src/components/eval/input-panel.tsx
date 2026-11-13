'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ChevronDown,
  CircleAlert,
  CircleCheckBig,
  Dna,
  FileText,
  LoaderCircle,
  Paperclip,
  Plus,
  Ruler,
  Settings2,
  Sparkles,
  Target,
  X,
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
import { parseLigandFileText, type LigandFileParsed } from '@/lib/eval/ligand-parse'

type TabMode = InputMode

const EXAMPLE_UNIPROTS = [
  { id: 'P00533', name: 'EGFR' },
  { id: 'P04637', name: 'p53' },
]

const MIN_SEQUENCE_LENGTH = 10
const MIN_COMPANION_LENGTH = 30
/** docx 批量评估的 UniProt 靶点数上限（串行执行，防止排队过久） */
const MAX_BATCH_UNIPROT = 5
/** 配体输入条数上限（后端同样按 8 截断） */
const MAX_LIGANDS = 8
/** 配体文件格式（结构/序列文件 → 客户端解析身份线索） */
const LIGAND_FILE_ACCEPT = '.sdf,.mol,.smi,.pdb,.ent,.txt'

export interface InputPanelProps {
  submitting: boolean
  submitError: string | null
  /** v1.10：docxSequences = 评估表原始序列（关系判断归属后按靶点附构建序列） */
  onStart: (requests: EvaluateRequest[], opts?: { docxSequences?: string[] }) => Promise<StartResult>
  onClearSubmitError: () => void
}

// ─── 配体芯片 ─────────────────────────────────────────────────────────────────

interface LigandChip {
  id: number
  raw: string
  source: 'text' | 'file'
  fileName?: string
  parsed?: LigandFileParsed
}

/** 文件解析结果 → 提交后端的归一输入串（优先三位 ID，其次 名称+分子式） */
function ligandRawFromParsed(p: LigandFileParsed, fileName: string): string {
  if (p.compId) return p.compId
  const parts = [p.name, p.formula].filter(Boolean)
  if (parts.length > 0) return parts.join(' ')
  return fileName.replace(/\.[^.]+$/, '').trim().slice(0, 60)
}

// ─── 步骤轨道区段 ─────────────────────────────────────────────────────────────

/** 表单步骤区段：左侧编号节点 + 连续竖轨（完成后节点点亮为翡翠实心），引导逐项填写 */
function StepSection({
  no,
  title,
  hint,
  tone = 'empty',
  right,
  last = false,
  children,
}: {
  no: string
  title: string
  hint?: string
  /** done = 已完成（实心翡翠） · optional = 可选未填（虚线框） · empty = 待填写（必填） */
  tone?: 'done' | 'optional' | 'empty'
  right?: ReactNode
  /** 末段：轨道向下渐隐 */
  last?: boolean
  children: ReactNode
}) {
  return (
    <section
      className={cn(
        'px-4 py-3',
        // 首段（01）无上边线；后续段以发丝线分隔（轨道连续穿行）
        no !== '01' && 'border-t border-stone-100/90 dark:border-stone-800/60',
      )}
    >
      <div className="flex gap-3">
        {/* 步骤轨道：连线（贯穿上下段）+ 编号节点 */}
        <div className="flex flex-col items-center" aria-hidden>
          {no !== '01' && <span className="-mt-3 h-3 w-px bg-stone-200 dark:bg-stone-800" />}
          <span
            className={cn(
              'flex size-5 shrink-0 items-center justify-center rounded-[5px] border font-mono text-[9.5px] font-semibold tabular-nums transition-colors duration-300',
              tone === 'done'
                ? 'border-emerald-700 bg-emerald-700 text-white shadow-[0_0_0_3px_rgba(4,120,87,0.14)] dark:border-emerald-500 dark:bg-emerald-500 dark:text-stone-950 dark:shadow-[0_0_0_3px_rgba(16,185,129,0.18)]'
                : tone === 'optional'
                  ? 'border-dashed border-stone-300 bg-white text-stone-400 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-500'
                  : 'border-stone-300 bg-white text-stone-500 dark:border-stone-600 dark:bg-stone-900 dark:text-stone-400',
            )}
          >
            {no}
          </span>
          {last ? (
            <span className="w-px flex-1 bg-gradient-to-b from-stone-200 to-transparent dark:from-stone-800" />
          ) : (
            <span className="mt-1.5 w-px flex-1 bg-stone-200 dark:bg-stone-800" />
          )}
        </div>

        {/* 字段内容：标题行 + 输入区 */}
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-[13px] font-semibold tracking-tight text-stone-800 dark:text-stone-100">
              {title}
            </h3>
            {hint && <span className="text-[11px] text-stone-400 dark:text-stone-500">{hint}</span>}
            {right && <span className="ml-auto flex flex-wrap items-center gap-1.5">{right}</span>}
          </div>
          {children}
        </div>
      </div>
    </section>
  )
}

/** 输入视图（idle）：一屏工作台卡片 — 步骤轨道（靶点 / 配体 / 目标）+ 高级选项 + 提交条 */
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

  // v2.0 配体输入（文本草稿 + 芯片；文件经 ligand-parse 客户端解析）
  const [ligandDraft, setLigandDraft] = useState('')
  const [ligandChips, setLigandChips] = useState<LigandChip[]>([])
  const ligandFileInputRef = useRef<HTMLInputElement>(null)
  const ligandSeqRef = useRef(1)

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

  // 快捷键提示文案（挂载后按平台修正，避免 SSR 水合不一致）
  const [kbdHint, setKbdHint] = useState('⌘ ↵')
  useEffect(() => {
    if (typeof navigator !== 'undefined' && !/Mac|iPhone|iPad/.test(navigator.platform ?? navigator.userAgent)) {
      setKbdHint('Ctrl ↵')
    }
  }, [])

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

  // ─── 配体芯片操作 ───────────────────────────────────────────────────────────

  const addLigandChip = (raw: string, source: 'text' | 'file', fileName?: string, parsed?: LigandFileParsed) => {
    const v = raw.trim().slice(0, 160)
    if (!v) return
    setLigandChips(prev => {
      if (prev.some(c => c.raw.toLowerCase() === v.toLowerCase())) return prev
      if (prev.length >= MAX_LIGANDS) return prev
      return [...prev, { id: ligandSeqRef.current++, raw: v, source, fileName, parsed }]
    })
  }

  const commitLigandDraft = () => {
    const v = ligandDraft.trim()
    if (!v) return
    addLigandChip(v, 'text')
    setLigandDraft('')
  }

  const removeLigandChip = (id: number) => {
    setLigandChips(prev => prev.filter(c => c.id !== id))
  }

  const handleLigandFile = async (file: File) => {
    if (file.size > 2 * 1024 * 1024) return
    try {
      const text = await file.text()
      const parsed = parseLigandFileText(file.name, text)
      addLigandChip(ligandRawFromParsed(parsed, file.name), 'file', file.name, parsed.kind !== 'unknown' ? parsed : undefined)
    } catch {
      addLigandChip(file.name.replace(/\.[^.]+$/, '').slice(0, 60), 'file', file.name)
    }
  }

  const handleStart = async () => {
    if (!inputReady || submitting) return
    onClearSubmitError()
    const options: EvaluateOptions = {
      skipBlast: !blastEnabled,
      forceBlast: blastEnabled && forceBlast,
      maxPdb,
    }
    const ligands = ligandChips.length
      ? ligandChips.map(c => ({ raw: c.raw, source: c.source, fileName: c.fileName }))
      : undefined
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
        ligands,
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
        ligands,
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
        ligands,
        options,
      }))
      const docxSequences = upload.parsed.sequences.map(s => s.seq ?? '')
      await onStart(requests, { docxSequences })
      return
    }
    await onStart(requests)
  }

  // ⌘/Ctrl + Enter 快捷开始评估（不设依赖数组：始终绑定最新闭包）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        if (inputReady && !submitting) void handleStart()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const inputBase =
    'w-full rounded-md border border-stone-200 bg-white text-stone-900 shadow-none outline-none transition-[border-color,box-shadow] duration-200 placeholder:text-stone-400 focus-visible:border-emerald-500 focus-visible:ring-[3px] focus-visible:ring-emerald-500/10 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100 dark:placeholder:text-stone-600 dark:focus-visible:border-emerald-600 dark:focus-visible:ring-emerald-500/15'

  const hintText = 'flex items-center gap-1 text-[11px]'

  // ─── 步骤头元信息（按当前输入模式计算徽章与提示） ───────────────────────────

  const badgeCls =
    'rounded-sm bg-emerald-100 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-400'
  const targetHint =
    mode === 'uniprot' ? 'UniProt accession' : mode === 'sequence' ? 'FASTA 或裸序列' : '上传 Word 评估表'
  const step1Badge: ReactNode =
    mode === 'uniprot' && uniprotMulti ? (
      <span className={badgeCls}>{uniprotParsed.valid.length} 个靶点 · 批量评估</span>
    ) : mode === 'sequence' && seqMulti ? (
      <span className={badgeCls}>{seqEntries.length} 条序列 · 批量评估</span>
    ) : mode === 'docx' && selectedUniprots.length > 1 ? (
      <span className={badgeCls}>{selectedUniprots.length} 个靶点 · 批量评估</span>
    ) : null

  const startLabel = submitting
    ? '正在创建评估作业…'
    : mode === 'docx' && selectedUniprots.length > 1
      ? `开始评估（${selectedUniprots.length} 个靶点）`
      : mode === 'uniprot' && uniprotMulti
        ? `开始评估（${uniprotParsed.valid.slice(0, MAX_BATCH_UNIPROT).length} 个靶点）`
        : mode === 'sequence' && seqMulti
          ? `开始评估（${seqEntries.slice(0, MAX_BATCH_UNIPROT).length} 条序列）`
          : '开始评估'

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-stone-200/80 bg-white ring-1 ring-stone-950/[0.03] shadow-[0_1px_2px_rgba(28,25,23,0.04),0_12px_32px_-20px_rgba(28,25,23,0.16)] dark:border-stone-800 dark:bg-stone-900 dark:ring-white/[0.04] dark:shadow-[0_1px_2px_rgba(0,0,0,0.4),0_16px_40px_-24px_rgba(0,0,0,0.6)]">
      <Tabs value={mode} onValueChange={(v) => setMode(v as TabMode)} className="flex min-h-0 flex-1 flex-col gap-0">
        {/* 卡头工具条：输入方式切换（分段控件） */}
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-stone-100 bg-stone-50/60 px-4 py-2 dark:border-stone-800/70 dark:bg-stone-950/40">
          <span className="eval-eyebrow text-stone-400 dark:text-stone-500">Input · 输入方式</span>
          <TabsList className="ml-auto h-8 w-auto justify-start gap-0.5 rounded-lg bg-stone-200/50 p-0.5 dark:bg-stone-800/70">
            {([
              { value: 'uniprot', label: 'UniProt ID', icon: Dna },
              { value: 'sequence', label: '序列', icon: FileText },
              { value: 'docx', label: '评估表', icon: Paperclip },
            ] as const).map(({ value, label, icon: Icon }) => (
              <TabsTrigger
                key={value}
                value={value}
                className="h-7 gap-1.5 rounded-[6px] px-2.5 text-[11.5px] font-medium text-stone-500 shadow-none transition-all data-[state=active]:bg-white data-[state=active]:text-emerald-800 data-[state=active]:shadow-[0_1px_3px_rgba(28,25,23,0.12)] sm:px-3 dark:text-stone-400 dark:data-[state=active]:bg-stone-950 dark:data-[state=active]:text-emerald-400 [&_svg]:size-3"
              >
                <Icon aria-hidden />
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        {/* 字段区（卡片内的滚动窗口，上下缘渐隐） */}
        <div className="eval-scroll eval-scroll-fade min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col">
            {/* ── 01 靶点输入 ─────────────────────────────────────── */}
            <StepSection
              no="01"
              title="靶点输入"
              hint={targetHint}
              tone={inputReady ? 'done' : 'empty'}
              right={step1Badge}
            >
              <TabsContent value="uniprot" className="mt-0">
                <div className="flex flex-col gap-2">
                  <Textarea
                    aria-label="UniProt ID 输入"
                    value={uniprot}
                    onChange={(e) => setUniprot(e.target.value)}
                    placeholder={'支持多个 UniProt ID，逗号 / 空格 / 换行分隔（最多 ' + MAX_BATCH_UNIPROT + ' 个），如 P00533、P04637'}
                    className={cn(inputBase, 'min-h-[64px] resize-y px-3 py-2 font-mono text-[13px] leading-[22px] uppercase placeholder:font-sans placeholder:normal-case placeholder:text-[12px] placeholder:leading-[20px]')}
                    spellCheck={false}
                  />
                  {uniprot.trim() !== '' && uniprotParsed.invalid.length > 0 && (
                    <p className={cn(hintText, 'text-red-600 dark:text-red-400')}>
                      <CircleAlert className="size-3.5" />
                      {uniprotParsed.invalid.length} 个格式不正确：{uniprotParsed.invalid.slice(0, 5).join('、')}{uniprotParsed.invalid.length > 5 ? '…' : ''}（accession 为 6 或 10 位，如 P00533）
                    </p>
                  )}
                  {uniprotOverLimit && (
                    <p className={cn(hintText, 'text-amber-600 dark:text-amber-400')}>
                      <CircleAlert className="size-3.5" />
                      超过上限 {MAX_BATCH_UNIPROT} 个，将只评估前 {MAX_BATCH_UNIPROT} 个
                    </p>
                  )}
                  {uniprotValid && (
                    <p className={cn(hintText, 'text-emerald-700 dark:text-emerald-400')}>
                      <CircleCheckBig className="size-3.5" />
                      {uniprotMulti
                        ? `已识别 ${uniprotParsed.valid.length} 个靶点，将批量评估并分析关系性与共有结构`
                        : '格式正确，将自动获取该蛋白的元数据与结构信息'}
                    </p>
                  )}
                  {uniprot.trim() === '' && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="eval-eyebrow text-stone-400 dark:text-stone-500">示例</span>
                      {EXAMPLE_UNIPROTS.map((ex) => (
                        <button
                          key={ex.id}
                          type="button"
                          onClick={() => setUniprot(ex.id)}
                          className="min-h-7 rounded-md border border-stone-200 bg-stone-50 px-2 font-mono text-[10.5px] text-stone-600 transition-colors hover:border-emerald-500 hover:text-emerald-800 dark:border-stone-700 dark:bg-stone-800/60 dark:text-stone-300 dark:hover:border-emerald-600 dark:hover:text-emerald-400"
                        >
                          {ex.id} · {ex.name}
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={() => setUniprot(EXAMPLE_UNIPROTS.map(ex => ex.id).join(', '))}
                        className="min-h-7 rounded-md border border-emerald-200 bg-emerald-50 px-2 font-mono text-[10.5px] text-emerald-700 transition-colors hover:border-emerald-500 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-400"
                      >
                        多靶点示例（EGFR + p53）
                      </button>
                    </div>
                  )}

                  {/* 可选伴随序列：与 UniProt 合并为一次评估 */}
                  <Collapsible open={companionOpen} onOpenChange={setCompanionOpen} className="mt-0.5">
                    <div className="rounded-md border border-stone-200 dark:border-stone-800">
                      <CollapsibleTrigger className="flex min-h-8 w-full items-center gap-2 rounded-md px-3 text-[11.5px] font-medium text-stone-600 outline-none transition-colors hover:bg-stone-50 dark:text-stone-400 dark:hover:bg-stone-900/60">
                        <Dna className={cn('size-3.5', companionValid ? 'text-emerald-700 dark:text-emerald-500' : 'text-stone-400')} />
                        补充构建序列（可选）
                        {companionValid && (
                          <span className={badgeCls}>
                            {companionInfo.count.toLocaleString()} aa · 将合并评估
                          </span>
                        )}
                        <span className="ml-auto hidden font-mono text-[10px] font-normal text-stone-400 sm:inline dark:text-stone-500">
                          {companionValid ? 'UniProt 为主 · 序列做构建边界' : '同一靶点时自动合并'}
                        </span>
                        <ChevronDown
                          className={cn(
                            'size-3.5 shrink-0 text-stone-400 transition-transform duration-200',
                            companionOpen && 'rotate-180',
                          )}
                        />
                      </CollapsibleTrigger>
                      <CollapsibleContent className="data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-1">
                        <div className="flex flex-col gap-2 border-t border-stone-100 px-3 py-2.5 dark:border-stone-800/70">
                          <Textarea
                            value={companionText}
                            onChange={(e) => setCompanionText(e.target.value)}
                            placeholder={'粘贴该靶点的构建序列（截短体/突变体，FASTA 或裸序列）。与 UniProt 属同一靶点时将合并为一次评估，并自动分析构建边界（对应全长区间）。'}
                            className={cn(inputBase, 'min-h-[64px] resize-y px-3 py-2 font-mono text-xs leading-relaxed')}
                            spellCheck={false}
                            aria-label="补充构建序列（可选）"
                          />
                          {companionText.trim() !== '' && (
                            <p className={cn(
                              hintText,
                              companionValid ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400',
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
                  <Collapsible open={rangeOpen} onOpenChange={setRangeOpen} className="mt-0.5">
                    <div className="rounded-md border border-stone-200 dark:border-stone-800">
                      <CollapsibleTrigger
                        className={cn(
                          'flex min-h-8 w-full items-center gap-2 rounded-md px-3 text-[11.5px] font-medium outline-none transition-colors',
                          rangeEnabled
                            ? 'text-stone-600 hover:bg-stone-50 dark:text-stone-400 dark:hover:bg-stone-900/60'
                            : 'cursor-not-allowed text-stone-300 dark:text-stone-600',
                        )}
                      >
                        <Ruler className={cn('size-3.5', rangeValid ? 'text-emerald-700 dark:text-emerald-500' : 'text-stone-400')} />
                        评估范围（可选）
                        {rangeValid && (
                          <span className={badgeCls}>
                            残基 {rangeStartN}-{rangeEndN}
                          </span>
                        )}
                        <span className="ml-auto hidden font-mono text-[10px] font-normal text-stone-400 sm:inline dark:text-stone-500">
                          {!rangeEnabled
                            ? '多靶点/有伴随序列时不可用'
                            : rangeValid
                              ? '过滤为该区间重叠的结构'
                              : '限定重叠结构'}
                        </span>
                        <ChevronDown
                          className={cn(
                            'size-3.5 shrink-0 text-stone-400 transition-transform duration-200',
                            rangeOpen && 'rotate-180',
                          )}
                        />
                      </CollapsibleTrigger>
                      <CollapsibleContent className="data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-1">
                        <div className="flex flex-col gap-2 border-t border-stone-100 px-3 py-2.5 dark:border-stone-800/70">
                          <div className="flex flex-wrap items-end gap-2.5">
                            <div className="flex flex-col gap-1">
                              <Label htmlFor="range-start" className="eval-eyebrow text-stone-500 dark:text-stone-400">起始残基</Label>
                              <Input
                                id="range-start"
                                type="number"
                                min={1}
                                value={rangeStart}
                                onChange={(e) => setRangeStart(e.target.value)}
                                placeholder="如 695"
                                className={cn(inputBase, 'h-9 w-24 px-2.5 font-mono text-[13px]')}
                                disabled={!rangeEnabled}
                              />
                            </div>
                            <span className="pb-2.5 text-stone-300 dark:text-stone-600">—</span>
                            <div className="flex flex-col gap-1">
                              <Label htmlFor="range-end" className="eval-eyebrow text-stone-500 dark:text-stone-400">结束残基</Label>
                              <Input
                                id="range-end"
                                type="number"
                                min={1}
                                value={rangeEnd}
                                onChange={(e) => setRangeEnd(e.target.value)}
                                placeholder="如 1022"
                                className={cn(inputBase, 'h-9 w-24 px-2.5 font-mono text-[13px]')}
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
                            <p className="text-[11px] leading-relaxed text-stone-400 dark:text-stone-500">
                              仅单个 UniProt ID 且无伴随序列时可用（多靶点各自范围不同；伴随序列已隐含构建边界）。
                            </p>
                          )}
                          {rangeEnabled && (rangeStart !== '' || rangeEnd !== '') && !rangeValid && (
                            <p className={cn(hintText, 'text-red-600 dark:text-red-400')}>
                              <CircleAlert className="size-3.5" />
                              范围无效：需 1 ≤ 起始 ≤ 结束（如 EGFR 激酶域 695-1022）
                            </p>
                          )}
                          {rangeValid && (
                            <p className="text-[11px] leading-relaxed text-stone-500 dark:text-stone-400">
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
                <div className="flex flex-col gap-2">
                  <div className="relative">
                    <Textarea
                      aria-label="氨基酸序列输入"
                      value={sequenceText}
                      onChange={(e) => setSequenceText(e.target.value)}
                      placeholder={'支持多条 FASTA 序列（每个 > 标题段一条，最多 ' + MAX_BATCH_UNIPROT + ' 条），如：\n>EGFR kinase domain\nMVPKPVA...\n>p53 DNA-binding domain\nSSSVPSQ...'}
                      className={cn(inputBase, 'min-h-[120px] resize-y px-3 py-2 font-mono text-[12.5px] leading-[21px]')}
                      spellCheck={false}
                    />
                    {seqInfo.count > 0 && (
                      <span className="pointer-events-none absolute right-2.5 bottom-2 rounded-sm bg-stone-100/90 px-1.5 py-0.5 font-mono text-[10px] text-stone-500 dark:bg-stone-800/90 dark:text-stone-400">
                        {seqInfo.count.toLocaleString()} aa
                      </span>
                    )}
                  </div>
                  {seqOverLimit && (
                    <p className={cn(hintText, 'text-amber-600 dark:text-amber-400')}>
                      <CircleAlert className="size-3.5" />
                      超过上限 {MAX_BATCH_UNIPROT} 条，将只评估前 {MAX_BATCH_UNIPROT} 条序列
                    </p>
                  )}
                  {seqMulti ? (
                    <p className={cn(hintText, 'text-emerald-700 dark:text-emerald-400')}>
                      <CircleCheckBig className="size-3.5" />
                      已识别 {seqEntries.length} 条序列（{seqValidEntries.length} 条 ≥{MIN_SEQUENCE_LENGTH} aa），将批量评估并分析关系性与共有结构
                    </p>
                  ) : seqInfo.count > 0 && (
                    <p
                      className={cn(
                        hintText,
                        seqInfo.count >= MIN_SEQUENCE_LENGTH
                          ? 'text-emerald-700 dark:text-emerald-400'
                          : 'text-amber-600 dark:text-amber-400',
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
                <div className="flex flex-col gap-2">
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
                </div>
              </TabsContent>
            </StepSection>

            {/* ── 02 配体输入（v2.0）─────────────────────────────────── */}
            <StepSection
              no="02"
              title="配体 · 化合物"
              hint={mode === 'docx' ? '可选 · 评估表提及的配体将自动识别' : '可选 · 名称 / 分子式 / 三位 ID'}
              tone={ligandChips.length > 0 ? 'done' : 'optional'}
              right={
                ligandChips.length > 0 ? (
                  <span className="font-mono text-[10px] text-stone-400 dark:text-stone-500">
                    {ligandChips.length}/{MAX_LIGANDS}
                  </span>
                ) : undefined
              }
            >
              <div
                className={cn(
                  'flex flex-col gap-2 rounded-md border border-stone-200 bg-stone-50/60 p-2 transition-colors focus-within:border-emerald-400 focus-within:bg-white dark:border-stone-700 dark:bg-stone-800/40 dark:focus-within:border-emerald-600 dark:focus-within:bg-stone-900',
                )}
              >
                {ligandChips.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {ligandChips.map(c => (
                      <span
                        key={c.id}
                        className="group inline-flex min-h-7 max-w-full items-center gap-1.5 rounded-md border border-stone-200 bg-white pl-2 pr-1 shadow-[0_1px_2px_rgba(28,25,23,0.05)] dark:border-stone-700 dark:bg-stone-900"
                      >
                        {c.source === 'file'
                          ? <Paperclip className="size-3 shrink-0 text-emerald-700 dark:text-emerald-500" aria-hidden />
                          : <span className="font-mono text-[11px] text-emerald-700 dark:text-emerald-500">T</span>}
                        <span className="truncate font-mono text-[11px] text-stone-700 dark:text-stone-200" title={c.raw}>
                          {c.raw.length > 34 ? c.raw.slice(0, 33) + '…' : c.raw}
                        </span>
                        {c.source === 'file' && c.parsed && (
                          <span className="shrink-0 rounded-sm bg-emerald-100 px-1 py-0.5 font-mono text-[9px] font-semibold text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-400">
                            {c.parsed.compId
                              ? `ID ${c.parsed.compId}`
                              : c.parsed.formula
                                ? c.parsed.formula
                                : c.parsed.name
                                  ? '已解析'
                                  : '线索'}
                          </span>
                        )}
                        {c.source === 'file' && !c.parsed && (
                          <span className="shrink-0 rounded-sm bg-amber-100 px-1 py-0.5 font-mono text-[9px] font-semibold text-amber-800 dark:bg-amber-900/40 dark:text-amber-400">未识别格式</span>
                        )}
                        <button
                          type="button"
                          onClick={() => removeLigandChip(c.id)}
                          aria-label="移除配体"
                          className="flex size-5.5 shrink-0 items-center justify-center rounded text-stone-400 transition-colors hover:bg-stone-100 hover:text-red-600 dark:hover:bg-stone-800 dark:hover:text-red-400"
                        >
                          <X className="size-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}

                <div className="flex items-center gap-1.5">
                  <input
                    aria-label="配体输入"
                    value={ligandDraft}
                    onChange={(e) => setLigandDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ',' || e.key === '；' || e.key === ';') {
                        e.preventDefault()
                        commitLigandDraft()
                      }
                    }}
                    disabled={ligandChips.length >= MAX_LIGANDS}
                    placeholder={ligandChips.length >= MAX_LIGANDS
                      ? `已达上限 ${MAX_LIGANDS} 条`
                      : '名称 / 分子式 / 三位 ID，回车添加 — 如 伊马替尼 · C9H8O4 · ATP · STU'}
                    className="h-9 min-w-0 flex-1 rounded-md border-0 bg-transparent px-2.5 text-[13px] text-stone-900 outline-none ring-0 transition-colors placeholder:text-stone-400 focus-visible:ring-0 dark:text-stone-100 dark:placeholder:text-stone-600"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={commitLigandDraft}
                    disabled={!ligandDraft.trim() || ligandChips.length >= MAX_LIGANDS}
                    className="h-8 gap-1 rounded-md border-stone-200 px-2.5 text-[11.5px] font-medium text-stone-600 hover:border-emerald-400 hover:text-emerald-800 dark:border-stone-700 dark:text-stone-300 dark:hover:border-emerald-700 dark:hover:text-emerald-400"
                  >
                    <Plus className="size-3.5" aria-hidden />
                    添加
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => ligandFileInputRef.current?.click()}
                    disabled={ligandChips.length >= MAX_LIGANDS}
                    className="h-8 gap-1 rounded-md border-stone-200 px-2.5 text-[11.5px] font-medium text-stone-600 hover:border-emerald-400 hover:text-emerald-800 dark:border-stone-700 dark:text-stone-300 dark:hover:border-emerald-700 dark:hover:text-emerald-400"
                  >
                    <Paperclip className="size-3.5" aria-hidden />
                    配体文件
                  </Button>
                  <input
                    ref={ligandFileInputRef}
                    type="file"
                    accept={LIGAND_FILE_ACCEPT}
                    className="hidden"
                    multiple
                    onChange={(e) => {
                      const files = Array.from(e.target.files ?? [])
                      for (const f of files) void handleLigandFile(f)
                      e.target.value = ''
                    }}
                  />
                </div>
              </div>

              <p className="text-[11px] leading-relaxed text-stone-400 dark:text-stone-500">
                支持中英文名、分子式、品牌药名与三位 ID；SDF / MOL / SMI / PDB 文件自动提取名称、分子式与残基名。非标准输入经
                <span className="font-mono text-[10px] text-stone-500 dark:text-stone-400"> 别名表 · PDBe 检索 · AI </span>
                多策略归一到 RCSB 三位化学组分 ID，并检索含该配体的 PDB 结构列表。
              </p>
            </StepSection>

            {/* ── 03 客户目标 ───────────────────────────────────────── */}
            <StepSection
              no="03"
              title="客户目标 / 科学问题"
              hint="可选 · 建议填写"
              tone={goal.trim() !== '' ? 'done' : 'optional'}
              last
              right={
                goalAutoFilled ? (
                  <span className="eval-eyebrow flex items-center gap-1 rounded-sm bg-emerald-100 px-1.5 py-0.5 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-400">
                    <Sparkles className="size-2.5" aria-hidden />
                    已从评估表自动填入
                  </span>
                ) : (
                  <span className="eval-eyebrow rounded-sm bg-amber-100 px-1.5 py-0.5 text-amber-800 dark:bg-amber-900/50 dark:text-amber-400">
                    AI 将提取
                  </span>
                )
              }
            >
              <Textarea
                aria-label="客户目标输入"
                value={goal}
                onChange={(e) => {
                  setGoal(e.target.value)
                  setGoalAutoFilled(false)
                }}
                placeholder="例如：解析 EGFR 激酶域与抑制剂复合物的冷冻电镜结构，评估 CRO 可行性（上传评估表后 AI 将自动提取并填入）"
                className={cn(inputBase, 'min-h-[52px] resize-y px-3 py-2 text-[13px] leading-[22px]')}
              />
              <p className="text-[11px] leading-relaxed text-stone-500 dark:text-stone-400">
                明确的客户目标将直接用于 LLM 报告中的可行性结论与实验策略推荐（可选）
              </p>
            </StepSection>

            {/* ── 高级选项（卡片内静默折叠）──────────────────────────── */}
            <Collapsible open={advOpen} onOpenChange={setAdvOpen}>
              <div className="border-t border-stone-100 dark:border-stone-800/70">
                <CollapsibleTrigger className="flex min-h-10 w-full items-center gap-2 px-4 text-[12.5px] font-medium text-stone-600 outline-none transition-colors hover:bg-stone-50 dark:text-stone-300 dark:hover:bg-stone-900/60">
                  <Settings2 className="size-3.5 text-stone-400" />
                  高级选项
                  <span className="ml-auto font-mono text-[10.5px] font-normal text-stone-400 dark:text-stone-500">
                    BLAST {blastEnabled ? (forceBlast ? '强制' : '自动') : '关闭'} · PDB ≤ {maxPdb}
                  </span>
                  <ChevronDown
                    className={cn(
                      'size-3.5 text-stone-400 transition-transform duration-200',
                      advOpen && 'rotate-180',
                    )}
                  />
                </CollapsibleTrigger>
                <CollapsibleContent className="data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-1">
                  <div className="grid gap-4 border-t border-stone-100 px-4 py-3 dark:border-stone-800/70 sm:grid-cols-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium text-stone-800 dark:text-stone-200">
                          自动 BLAST 同源检索
                        </div>
                        <div className="mt-0.5 text-[11px] leading-relaxed text-stone-500 dark:text-stone-500">
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
                        <div className="text-[13px] font-medium text-stone-800 dark:text-stone-200">
                          强制 BLAST
                        </div>
                        <div className="mt-0.5 text-[11px] leading-relaxed text-stone-500 dark:text-stone-500">
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
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-[13px] font-medium text-stone-800 dark:text-stone-200">
                          PDB 结构详情数量上限
                          <span className="ml-2 text-[11px] font-normal text-stone-500 dark:text-stone-500">
                            限制逐条拉取的 RCSB 结构详情数量，越大耗时越长
                          </span>
                        </div>
                        <Select value={String(maxPdb)} onValueChange={(v) => setMaxPdb(Number(v))}>
                          <SelectTrigger className="h-9 w-full rounded-md sm:w-36" aria-label="PDB 详情数上限">
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
                  </div>
                </CollapsibleContent>
              </div>
            </Collapsible>
          </div>
        </div>

        {/* ── 提交条（卡底固定）────────────────────────────────── */}
        <div className="shrink-0 border-t border-stone-100 bg-gradient-to-b from-white to-stone-50/70 px-4 py-2.5 dark:border-stone-800/70 dark:from-stone-900 dark:to-stone-950/60">
          {submitError && (
            <Alert variant="destructive" className="mb-2.5 rounded-md border-red-300 py-2.5 dark:border-red-900">
              <CircleAlert />
              <AlertTitle className="text-[13px]">无法开始评估</AlertTitle>
              <AlertDescription className="text-xs">
                {submitError}
                {!/上限|繁忙|排队|稍后再试|明日再试|正在或排队/.test(submitError) && (
                  <span className="text-[11px] text-stone-500">（评估服务可能尚未就绪，请稍后重试）</span>
                )}
              </AlertDescription>
            </Alert>
          )}
          <div className="flex items-center gap-3">
            <Button
              size="lg"
              disabled={!inputReady || submitting}
              onClick={handleStart}
              className="group relative h-10 flex-1 overflow-hidden rounded-lg bg-gradient-to-b from-emerald-700 to-emerald-800 text-[13.5px] font-semibold tracking-[0.02em] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_8px_20px_-8px_rgba(4,120,87,0.55)] transition-all hover:from-emerald-600 hover:to-emerald-700 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_10px_24px_-8px_rgba(4,120,87,0.6)] disabled:opacity-55 disabled:saturate-[0.6] disabled:shadow-none dark:from-emerald-600 dark:to-emerald-800 dark:hover:from-emerald-500 dark:hover:to-emerald-700"
            >
              {submitting ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <Target className="size-4 transition-transform duration-200 group-hover:scale-110" />
              )}
              {startLabel}
              {!submitting && <span className="ml-0.5 font-mono text-[12px] transition-transform duration-200 group-hover:translate-x-0.5">→</span>}
              {/* 悬停流光 */}
              <span
                aria-hidden
                className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/[0.09] to-transparent transition-transform duration-700 group-hover:translate-x-full"
              />
            </Button>
            <div className="hidden shrink-0 flex-col items-end gap-1 sm:flex">
              <span className="eval-kbd">{kbdHint}</span>
              <span className="text-[10px] leading-none text-stone-400 dark:text-stone-500">开始评估</span>
            </div>
          </div>
        </div>
      </Tabs>
    </div>
  )
}
