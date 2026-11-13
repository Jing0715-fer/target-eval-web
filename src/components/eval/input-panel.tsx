'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { PillBottle,
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
import { fetchDocxInsights, isStatelessEnv, uploadEvaluateDocx, type UploadProgress } from './api'
import { DocxUploadPanel, validateDocxFile } from './docx-upload-panel'
import type { EvaluateOptions, EvaluateRequest, FormInsights, InputMode, UploadResponse } from './types'
import { MAX_PDB_UNLIMITED } from './types'
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
  /** v2.6：eval-table = 评估表 AI 识别后自动回填的芯片（可见可删） */
  source: 'text' | 'file' | 'eval-table'
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

/** 表单步骤区段（Linear 式）：左侧编号节点 + 连续竖轨（完成后节点点亮为薰衣草实心），引导逐项填写 */
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
  /** done = 已完成（实心主色） · optional = 可选未填（虚线框） · empty = 待填写（必填） */
  tone?: 'done' | 'optional' | 'empty'
  right?: ReactNode
  /** 末段：轨道向下渐隐 */
  last?: boolean
  children: ReactNode
}) {
  return (
    <section
      className={cn(
        'px-4 py-4 sm:px-5',
        // 首段（01）无上边线；后续段以发丝线分隔（轨道连续穿行）
        no !== '01' && 'border-t border-border/70',
      )}
    >
      <div className="flex gap-3 sm:gap-3.5">
        {/* 步骤轨道：连线（跨段连续，紧贴节点无断口）+ 编号节点 */}
        <div className="-mb-4 flex flex-col items-center" aria-hidden>
          {no !== '01' && <span className="-mt-4 h-4 w-px bg-border" />}
          <span
            className={cn(
              'flex size-5.5 shrink-0 items-center justify-center rounded-full border font-mono text-[9.5px] font-semibold tabular-nums transition-colors duration-300',
              tone === 'done'
                ? 'border-primary bg-primary text-primary-foreground shadow-[0_0_0_3px_rgb(94_106_210/0.15)]'
                : tone === 'optional'
                  ? 'border-dashed border-border bg-background text-muted-foreground/70'
                  : 'border-border bg-background text-muted-foreground',
            )}
          >
            {no}
          </span>
          {last ? (
            <span className="w-px flex-1 bg-gradient-to-b from-border to-transparent" />
          ) : (
            <span className="w-px flex-1 bg-border" />
          )}
        </div>

        {/* 字段内容：标题行 + 输入区 */}
        <div className="flex min-w-0 flex-1 flex-col gap-2.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-[13px] font-semibold tracking-[-0.01em] text-foreground">
              {title}
            </h3>
            {hint && <span className="text-[11px] text-muted-foreground/80">{hint}</span>}
            {right && <span className="ml-auto flex flex-wrap items-center gap-1.5">{right}</span>}
          </div>
          {children}
        </div>
      </div>
    </section>
  )
}

/** 输入视图（idle）：Linear 工作台卡片 — 步骤轨道（靶点 / 配体 / 目标）+ 高级选项 + 提交条 */
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
  // 移动端配体说明展开（sm 起全展开无需切换）
  const [ligandHintOpen, setLigandHintOpen] = useState(false)

  // 快捷键提示文案（挂载后按平台修正，避免 SSR 水合不一致）
  const [kbdHint, setKbdHint] = useState('⌘ ↵')
  useEffect(() => {
    if (typeof navigator !== 'undefined' && !/Mac|iPhone|iPad/.test(navigator.platform ?? navigator.userAgent)) {
      setKbdHint('Ctrl ↵')
    }
  }, [])

  /** 上传成功后自动执行 LLM 智能解析（不阻塞选择评估对象）
   *  v2.4：无状态模式内联携带全文（服务器磁盘读不到 parsed 数据） */
  const runInsights = async (uploadId: string, inline?: { text: string; goalHints?: string[] }) => {
    setInsightsLoading(true)
    setInsightsError(null)
    setInsights(null)
    try {
      const res = await fetchDocxInsights(uploadId, false, inline)
      const data = res.insights
      if (!data) throw new Error('解析结果为空')
      setInsights(data)
      // 目标输入框为空时自动填入解析出的客户目标
      if (data.goals.length > 0 && goal.trim() === '') {
        setGoal(data.goals.slice(0, 3).join('；'))
        setGoalAutoFilled(true)
      }
      // v2.6：评估表识别出的配体自动回填输入框芯片（用户可见/可删 — 此前仅静默随请求
      // 提交，用户看不到“已识别”，反馈为“配体没有自动识别到输入框”）
      if (data.ligands?.length) {
        const normKey = (raw: string) => raw.toLowerCase().replace(/[\s-]/g, '')
        setLigandChips(prev => {
          const have = new Set(prev.map(c => normKey(c.raw)))
          const auto = data.ligands!
            .map(name => name.trim())
            .filter(Boolean)
            .filter(name => !have.has(normKey(name)))
            .map(name => ({ id: ligandSeqRef.current++, raw: name, source: 'eval-table' as const }))
          return auto.length ? [...prev, ...auto] : prev
        })
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
      // 后台执行 LLM 智能解析（v2.4：直传模式响应带 fullText → 内联携带，不依赖磁盘）
      const inline = res.stateless && res.fullText
        ? { text: res.fullText, goalHints: res.parsed.goalHints }
        : undefined
      void runInsights(res.uploadId, inline)
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
    // v2.2：一次粘贴/输入多个配体 — 按逗号、顿号、分号、换行拆分为独立芯片
    const parts = ligandDraft
      .split(/[、,，;；\n]+/)
      .map(s => s.trim())
      .filter(Boolean)
    if (!parts.length) return
    for (const p of parts) addLigandChip(p, 'text')
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
    // v2.4 配体输入组装：手动芯片 + 评估表 AI 提取的配体（合并去重，≤8 条）。
    // 评估表配体直接随请求发送 — 不再依赖服务器从磁盘 insights.json 回读
    // （无状态部署磁盘读不到；本地部署也有「insights 未完成即提交」的竞态）。
    const manualLigands = ligandChips.map(c => ({ raw: c.raw, source: c.source, fileName: c.fileName }))
    const tableLigands = (insights?.ligands ?? [])
      .map(name => name.trim())
      .filter(Boolean)
      .map(name => ({ raw: name, source: 'eval-table' as const }))
    const seenLig = new Set<string>()
    const ligands = [...manualLigands, ...tableLigands]
      .filter(l => {
        const k = l.raw.toLowerCase().replace(/[\s-]/g, '')
        if (!k || seenLig.has(k)) return false
        seenLig.add(k)
        return true
      })
      .slice(0, MAX_LIGANDS)
    const trimmedGoal = goal.trim() || undefined

    // v2.4 无状态部署：评估表数据随请求内联携带（磁盘不跨请求保留）
    const evalTable = upload && (upload.stateless || isStatelessEnv())
      ? {
          fullText: upload.fullText,
          goalHints: upload.parsed.goalHints,
          images: upload.parsed.images.filter(im => im.dataUri).slice(0, 8),
          insights: insights ?? undefined,
        }
      : undefined
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
        evalTable,
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

  // Linear 式输入框：8px 圆角 + 发丝线 + 表面底 + 薰衣草焦点环
  const inputBase =
    'w-full rounded-lg border border-input bg-card text-foreground outline-none transition-[border-color,box-shadow] duration-200 placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20 dark:placeholder:text-muted-foreground/60'

  const hintText = 'flex items-center gap-1 text-[11px]'

  // ─── 步骤头元信息（按当前输入模式计算徽章与提示） ───────────────────────────

  const badgeCls =
    'rounded-md bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-primary dark:bg-primary/15'
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
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_2px_rgb(22_23_29/0.04)] dark:shadow-[0_1px_2px_rgb(0_0_0/0.4)]">
      <Tabs value={mode} onValueChange={(v) => setMode(v as TabMode)} className="flex min-h-0 flex-1 flex-col gap-0">
        {/* 卡头工具条：输入方式切换（Linear 分段控件 — 选中 = 表面抬升；移动端占满整行） */}
        <div className="flex shrink-0 items-center gap-x-3 gap-y-2 border-b border-border bg-secondary/50 px-4 py-2.5 sm:px-5">
          <span className="lin-eyebrow hidden text-muted-foreground/80 sm:inline">Input · 输入方式</span>
          <TabsList className="h-8 w-full justify-between gap-0.5 rounded-lg border border-border bg-muted p-0.5 sm:ml-auto sm:w-auto sm:justify-start">
            {([
              { value: 'uniprot', label: 'UniProt', icon: Dna },
              { value: 'sequence', label: '序列', icon: FileText },
              { value: 'docx', label: '评估表', icon: Paperclip },
            ] as const).map(({ value, label, icon: Icon }) => (
              <TabsTrigger
                key={value}
                value={value}
                className="h-7 flex-1 gap-1.5 rounded-[6px] px-2 text-[11.5px] font-medium text-muted-foreground shadow-none transition-all data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-[0_1px_3px_rgb(22_23_29/0.10)] sm:flex-none sm:px-3 dark:data-[state=active]:bg-[#191a1b] [&_svg]:size-3"
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
                    className={cn(inputBase, 'min-h-[92px] resize-y px-3.5 py-2.5 font-mono text-[13px] leading-[22px] uppercase placeholder:font-sans placeholder:normal-case placeholder:text-[12px] placeholder:leading-[20px]')}
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
                    <p className={cn(hintText, 'text-emerald-600 dark:text-emerald-400')}>
                      <CircleCheckBig className="size-3.5" />
                      {uniprotMulti
                        ? `已识别 ${uniprotParsed.valid.length} 个靶点，将批量评估并分析关系性与共有结构`
                        : '格式正确，将自动获取该蛋白的元数据与结构信息'}
                    </p>
                  )}
                  {uniprot.trim() === '' && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="lin-eyebrow text-muted-foreground/70">示例</span>
                      {EXAMPLE_UNIPROTS.map((ex) => (
                        <button
                          key={ex.id}
                          type="button"
                          onClick={() => setUniprot(ex.id)}
                          className="min-h-7 rounded-md border border-border bg-muted px-2 font-mono text-[10.5px] text-muted-foreground transition-colors hover:border-ring hover:text-primary"
                        >
                          {ex.id} · {ex.name}
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={() => setUniprot(EXAMPLE_UNIPROTS.map(ex => ex.id).join(', '))}
                        className="min-h-7 rounded-md border border-primary/30 bg-primary/[0.06] px-2 font-mono text-[10.5px] text-primary transition-colors hover:border-primary/60"
                      >
                        多靶点示例（EGFR + p53）
                      </button>
                    </div>
                  )}

                  {/* 可选伴随序列：与 UniProt 合并为一次评估 */}
                  <Collapsible open={companionOpen} onOpenChange={setCompanionOpen} className="mt-0.5">
                    <div className="rounded-lg border border-border">
                      <CollapsibleTrigger className="flex min-h-8 w-full items-center gap-2 rounded-lg px-3 text-[11.5px] font-medium text-muted-foreground outline-none transition-colors hover:bg-accent">
                        <Dna className={cn('size-3.5', companionValid ? 'text-primary' : 'text-muted-foreground/60')} />
                        补充构建序列（可选）
                        {companionValid && (
                          <span className={badgeCls}>
                            {companionInfo.count.toLocaleString()} aa · 将合并评估
                          </span>
                        )}
                        <span className="ml-auto hidden font-mono text-[10px] font-normal text-muted-foreground/70 sm:inline">
                          {companionValid ? 'UniProt 为主 · 序列做构建边界' : '同一靶点时自动合并'}
                        </span>
                        <ChevronDown
                          className={cn(
                            'size-3.5 shrink-0 text-muted-foreground/60 transition-transform duration-200',
                            companionOpen && 'rotate-180',
                          )}
                        />
                      </CollapsibleTrigger>
                      <CollapsibleContent className="data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-1">
                        <div className="flex flex-col gap-2 border-t border-border/70 px-3 py-2.5">
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
                              companionValid ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400',
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
                    <div className="rounded-lg border border-border">
                      <CollapsibleTrigger
                        className={cn(
                          'flex min-h-8 w-full items-center gap-2 rounded-lg px-3 text-[11.5px] font-medium outline-none transition-colors',
                          rangeEnabled
                            ? 'text-muted-foreground hover:bg-accent'
                            : 'cursor-not-allowed text-muted-foreground/40',
                        )}
                      >
                        <Ruler className={cn('size-3.5', rangeValid ? 'text-primary' : 'text-muted-foreground/60')} />
                        评估范围（可选）
                        {rangeValid && (
                          <span className={badgeCls}>
                            残基 {rangeStartN}-{rangeEndN}
                          </span>
                        )}
                        <span className="ml-auto hidden font-mono text-[10px] font-normal text-muted-foreground/70 sm:inline">
                          {!rangeEnabled
                            ? '多靶点/有伴随序列时不可用'
                            : rangeValid
                              ? '过滤为该区间重叠的结构'
                              : '限定重叠结构'}
                        </span>
                        <ChevronDown
                          className={cn(
                            'size-3.5 shrink-0 text-muted-foreground/60 transition-transform duration-200',
                            rangeOpen && 'rotate-180',
                          )}
                        />
                      </CollapsibleTrigger>
                      <CollapsibleContent className="data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-1">
                        <div className="flex flex-col gap-2 border-t border-border/70 px-3 py-2.5">
                          <div className="flex flex-wrap items-end gap-2.5">
                            <div className="flex flex-col gap-1">
                              <Label htmlFor="range-start" className="lin-eyebrow text-muted-foreground">起始残基</Label>
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
                            <span className="pb-2.5 text-muted-foreground/50">—</span>
                            <div className="flex flex-col gap-1">
                              <Label htmlFor="range-end" className="lin-eyebrow text-muted-foreground">结束残基</Label>
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
                              <span className="pb-2 font-mono text-[11px] text-primary">
                                覆盖 {rangeEndN - rangeStartN + 1} aa
                              </span>
                            )}
                          </div>
                          {!rangeEnabled && (
                            <p className="text-[11px] leading-relaxed text-muted-foreground/80">
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
                            <p className="text-[11px] leading-relaxed text-muted-foreground">
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
                      className={cn(inputBase, 'min-h-[168px] resize-y px-3.5 py-2.5 font-mono text-[12.5px] leading-[21px]')}
                      spellCheck={false}
                    />
                    {seqInfo.count > 0 && (
                      <span className="pointer-events-none absolute right-2.5 bottom-2 rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
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
                    <p className={cn(hintText, 'text-emerald-600 dark:text-emerald-400')}>
                      <CircleCheckBig className="size-3.5" />
                      已识别 {seqEntries.length} 条序列（{seqValidEntries.length} 条 ≥{MIN_SEQUENCE_LENGTH} aa），将批量评估并分析关系性与共有结构
                    </p>
                  ) : seqInfo.count > 0 && (
                    <p
                      className={cn(
                        hintText,
                        seqInfo.count >= MIN_SEQUENCE_LENGTH
                          ? 'text-emerald-600 dark:text-emerald-400'
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
                    onRetryInsights={() => upload && void runInsights(
                      upload.uploadId,
                      upload.stateless && upload.fullText
                        ? { text: upload.fullText, goalHints: upload.parsed.goalHints }
                        : undefined,
                    )}
                    onApplyGoal={applyGoal}
                  />
                </div>
              </TabsContent>
            </StepSection>

            {/* ── 02 配体输入（v2.0）─────────────────────────────────── */}
            <StepSection
              no="02"
              title="配体 · 化合物"
              hint={mode === 'docx' ? '可选 · 评估表提及的配体将自动识别' : '可选 · 名称 / 分子式 / ID，支持多个'}
              tone={ligandChips.length > 0 ? 'done' : 'optional'}
              right={
                ligandChips.length > 0 ? (
                  <span className="font-mono text-[10px] text-muted-foreground/70">
                    {ligandChips.length}/{MAX_LIGANDS}
                  </span>
                ) : undefined
              }
            >
              <div
                className={cn(
                  'flex flex-col gap-2 rounded-lg border border-border bg-muted/60 p-2.5 transition-colors focus-within:border-ring focus-within:bg-card dark:bg-muted/40',
                )}
              >
                {ligandChips.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {ligandChips.map(c => (
                      <span
                        key={c.id}
                        className="group inline-flex min-h-7 max-w-full items-center gap-1.5 rounded-md border border-border bg-card pl-2 pr-1 shadow-[0_1px_2px_rgb(22_23_29/0.05)]"
                      >
                        {c.source === 'file'
                          ? <Paperclip className="size-3 shrink-0 text-primary" aria-hidden />
                          : c.source === 'eval-table'
                            ? <PillBottle className="size-3 shrink-0 text-primary" aria-hidden />
                            : <span className="font-mono text-[11px] text-primary">T</span>}
                        {c.source === 'eval-table' && (
                          <span className="shrink-0 rounded-sm bg-primary/10 px-1 py-0.5 font-mono text-[9px] font-semibold text-primary" title="评估表 AI 识别的配体 — 已自动回填">表</span>
                        )}
                        <span className="truncate font-mono text-[11px] text-foreground/90" title={c.raw}>
                          {c.raw.length > 34 ? c.raw.slice(0, 33) + '…' : c.raw}
                        </span>
                        {c.source === 'file' && c.parsed && (
                          <span className="shrink-0 rounded-sm bg-primary/10 px-1 py-0.5 font-mono text-[9px] font-semibold text-primary">
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
                          <span className="shrink-0 rounded-sm bg-amber-500/10 px-1 py-0.5 font-mono text-[9px] font-semibold text-amber-600 dark:text-amber-400">未识别格式</span>
                        )}
                        <button
                          type="button"
                          onClick={() => removeLigandChip(c.id)}
                          aria-label="移除配体"
                          className="flex size-5.5 shrink-0 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-accent hover:text-red-600"
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
                      : '名称 / 分子式 / ID，逗号分隔'}
                    className="h-10 min-w-0 flex-1 rounded-md border-0 bg-transparent px-2.5 text-[13px] text-foreground outline-none ring-0 transition-colors placeholder:text-muted-foreground/70 focus-visible:ring-0"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={commitLigandDraft}
                    disabled={!ligandDraft.trim() || ligandChips.length >= MAX_LIGANDS}
                    className="h-9 shrink-0 gap-1 rounded-lg px-2.5 text-[11.5px] font-medium sm:px-2.5"
                    title="添加配体"
                  >
                    <Plus className="size-3.5" aria-hidden />
                    <span className="hidden sm:inline">添加</span>
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => ligandFileInputRef.current?.click()}
                    disabled={ligandChips.length >= MAX_LIGANDS}
                    className="h-9 shrink-0 gap-1 rounded-lg px-2.5 text-[11.5px] font-medium"
                    title="上传配体文件（SDF / MOL / SMI / PDB）"
                  >
                    <Paperclip className="size-3.5" aria-hidden />
                    <span className="hidden sm:inline">配体文件</span>
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

              <p className={cn('text-[11px] leading-relaxed text-muted-foreground/80', !ligandHintOpen && 'line-clamp-3 sm:line-clamp-none')}>
                支持中英文名、分子式、品牌药名与化学组分 ID，多个配体用逗号/顿号分隔；SDF / MOL / SMI / PDB 文件自动提取名称、分子式与残基名。非标准输入经
                <span className="font-mono text-[10px] text-muted-foreground"> 别名表 · PDBe 检索 · PubChem · AI </span>
                多策略归一到 RCSB 化学组分 ID（PubChem 详情兜底），并检索含该配体的 PDB 结构列表。
              </p>
              {/* v2.5 复验修复：展开链接置于 <p> 之外 —— line-clamp 会连带裁掉段落内元素 */}
              <button type="button" className="mt-0.5 font-mono text-[10px] text-primary hover:underline sm:hidden" onClick={() => setLigandHintOpen(v => !v)} aria-expanded={ligandHintOpen} aria-label={ligandHintOpen ? '－ 收起说明' : '＋ 展开全部说明'}>
                {ligandHintOpen ? '－ 收起说明' : '＋ 展开全部说明'}
              </button>
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
                  <span className="lin-eyebrow flex items-center gap-1 rounded-md bg-primary/10 px-1.5 py-0.5 text-primary">
                    <Sparkles className="size-2.5" aria-hidden />
                    已从评估表自动填入
                  </span>
                ) : (
                  <span className="lin-eyebrow rounded-md bg-amber-500/10 px-1.5 py-0.5 text-amber-600 dark:text-amber-400">
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
                className={cn(inputBase, 'min-h-[80px] resize-y px-3.5 py-2.5 text-[13px] leading-[22px]')}
              />
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                明确的客户目标将直接用于 LLM 报告中的可行性结论与实验策略推荐（可选）
              </p>
            </StepSection>

            {/* ── 高级选项（卡片内静默折叠）──────────────────────────── */}
            <Collapsible open={advOpen} onOpenChange={setAdvOpen}>
              <div className="border-t border-border/70">
                <CollapsibleTrigger className="flex min-h-11 w-full items-center gap-2 px-4 text-[12.5px] font-medium text-muted-foreground outline-none transition-colors hover:bg-accent sm:px-5">
                  <Settings2 className="size-3.5 shrink-0 text-muted-foreground/60" />
                  高级选项
                  <span className="ml-auto truncate font-mono text-[10.5px] font-normal text-muted-foreground/70">
                    BLAST {blastEnabled ? (forceBlast ? '强制' : '自动') : '关闭'} · PDB {maxPdb >= MAX_PDB_UNLIMITED ? '≤ ∞' : `≤ ${maxPdb}`}
                  </span>
                  <ChevronDown
                    className={cn(
                      'size-3.5 text-muted-foreground/60 transition-transform duration-200',
                      advOpen && 'rotate-180',
                    )}
                  />
                </CollapsibleTrigger>
                <CollapsibleContent className="data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-1">
                  <div className="grid gap-4 border-t border-border/70 px-4 py-3.5 sm:grid-cols-2 sm:px-5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium text-foreground">
                          自动 BLAST 同源检索
                        </div>
                        <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                          结构覆盖不足时自动执行 NCBI BLAST 检索同源结构
                        </div>
                      </div>
                      <Switch
                        checked={blastEnabled}
                        onCheckedChange={setBlastEnabled}
                        aria-label="自动 BLAST 同源检索"
                        className="data-[state=checked]:bg-primary"
                      />
                    </div>

                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium text-foreground">
                          强制 BLAST
                        </div>
                        <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                          无论覆盖情况如何，始终执行同源结构检索
                        </div>
                      </div>
                      <Switch
                        checked={forceBlast && blastEnabled}
                        disabled={!blastEnabled}
                        onCheckedChange={setForceBlast}
                        aria-label="强制 BLAST"
                        className="data-[state=checked]:bg-primary"
                      />
                    </div>

                    <div className="sm:col-span-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-[13px] font-medium text-foreground">
                          PDB 结构详情数量上限
                          <span className="ml-2 text-[11px] font-normal text-muted-foreground">
                            限制逐条拉取的 RCSB 结构详情数量，越大耗时越长（不限 = 拉取该靶点全部结构）
                          </span>
                        </div>
                        <Select value={String(maxPdb)} onValueChange={(v) => setMaxPdb(Number(v))}>
                          <SelectTrigger className="h-9 w-full rounded-lg sm:w-36" aria-label="PDB 详情数上限">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {[50, 100, 150, 300, MAX_PDB_UNLIMITED].map((n) => (
                              <SelectItem key={n} value={String(n)}>
                                {n >= MAX_PDB_UNLIMITED ? '不限（全部）' : `${n} 条`}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      {maxPdb >= MAX_PDB_UNLIMITED && (
                        <p className="mt-1.5 text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
                          已选择不限：将逐条拉取该靶点的全部关联结构（检索分页上限 1000 条），靶点结构多时拉取耗时可能明显增加（约每条 0.2–1 秒）
                        </p>
                      )}
                    </div>
                  </div>
                </CollapsibleContent>
              </div>
            </Collapsible>
          </div>
        </div>

        {/* ── 提交条（卡底固定）────────────────────────────────── */}
        <div className="shrink-0 border-t border-border bg-secondary/40 px-4 py-3 sm:px-5">
          {submitError && (
            <Alert variant="destructive" className="mb-2.5 rounded-lg py-2.5">
              <CircleAlert />
              <AlertTitle className="text-[13px]">无法开始评估</AlertTitle>
              <AlertDescription className="text-xs">
                {submitError}
                {!/上限|繁忙|排队|稍后再试|明日再试|正在或排队/.test(submitError) && (
                  <span className="text-[11px] text-muted-foreground">（评估服务可能尚未就绪，请稍后重试）</span>
                )}
              </AlertDescription>
            </Alert>
          )}
          <div className="flex items-center gap-3">
            <Button
              size="lg"
              disabled={!inputReady || submitting}
              onClick={handleStart}
              className="group relative h-10 flex-1 overflow-hidden rounded-lg bg-primary text-[13.5px] font-semibold tracking-[-0.01em] text-primary-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_6px_16px_-8px_rgb(94_106_210/0.5)] transition-all hover:bg-[#7a84dc] disabled:opacity-50 disabled:shadow-none dark:hover:bg-[#828fff]"
            >
              {submitting ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <Target className="size-4 transition-transform duration-200 group-hover:scale-110" />
              )}
              {startLabel}
              {!submitting && <span className="ml-0.5 font-mono text-[12px] transition-transform duration-200 group-hover:translate-x-0.5">→</span>}
            </Button>
            <div className="hidden shrink-0 flex-col items-end gap-1 sm:flex">
              <span className="eval-kbd">{kbdHint}</span>
              <span className="text-[10px] leading-none text-muted-foreground/70">开始评估</span>
            </div>
          </div>
        </div>
      </Tabs>
    </div>
  )
}
