'use client'

/**
 * 高通量评估输入面板（v2.22；v2.23 增 Excel 导入）— 嵌入 InputPanel 的「高通量」Tab。
 *
 * 输入契约：「;」分隔组（一组 = 一份独立报告，按复合物批量评估出合并报告），
 * 组内「,」分隔靶点；组内仅一个靶点 = 独立评估。
 * 实时解析预览（组矩阵 + 复合物/单靶点徽章）+ 最近运行历史（恢复 / 回看 / 删除）。
 * v2.23：「从 Excel 导入」— 上传靶点表（.xlsx/.xls/.csv）由 LLM 语义提取分组
 * （组号/复合物列、同行多靶点等），一键填入分组输入（LLM 不可用时规则兜底），
 * 导入可撤销（恢复导入前的手输内容）。
 * v2.38：靶点选择（启动前勾选哪些要评估 — 未勾选的入运行记录但跳过，可事后
 * 恢复）；「导入报告（zip）」— 载入既有报告包（manifest 精确 / 文件名+题目
 * 兜底匹配），已有报告的靶点自动取消勾选（跳过评估，不占配额）。
 */

import { useRef, useState } from 'react'
import {
  AlertTriangle,
  CircleAlert,
  CircleCheckBig,
  Download,
  FileArchive,
  FileSpreadsheet,
  FileStack,
  LoaderCircle,
  Play,
  RotateCcw,
  Trash2,
  Undo2,
  Zap,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import { formatDateTime } from './format'
import { extractHtTargetsFromExcel } from './api'
import { parseHtImportFiles, planArchiveSkips, sha256Hex16, diagnoseArchiveImport, type HtMatchTarget } from './ht-archive-import'
import type { HTRunState, HtSeqTarget } from './types'

export interface HighThroughputPanelProps {
  value: string
  onChange: (v: string) => void
  parsed: {
    groups: string[][]
    groupRanges?: Array<Array<[number, number] | undefined>>
    /** v2.29：与 groups 对齐的结构域名提示（评估表不写区间而写域名时） */
    groupDomainHints?: Array<Array<string | undefined>>
    invalid: string[]
    duplicates: string[]
  }
  /** v2.23.1 序列兜底组（Excel 导入：行缺 UniProt 但有构建序列） */
  seqGroups: HtSeqTarget[][]
  onSeqGroupsChange: (groups: HtSeqTarget[][]) => void
  /** v2.36：原始 Excel 行快照（导入时留存 → 汇总报告「原表内容」列） */
  excelRows: Array<{ label: string; text: string }>
  onExcelRowsChange: (rows: Array<{ label: string; text: string }>) => void
  recentRuns: HTRunState[]
  onResumeRun: (id: string) => void
  onDeleteRun: (id: string) => void
  /** v2.25 批量下载该次运行报告（zip 归档；archiving = 打包中禁用） */
  onArchiveRun?: (id: string) => void
  archiving?: boolean
  /** v2.38：启动时跳过的靶点键（`g:${组}:${项}` / `sq:${组}:${项}` — 未勾选项） */
  skipKeys: string[]
  onSkipKeysChange: (keys: string[]) => void
}

const inputBase =
  'w-full rounded-lg border border-input bg-card text-foreground outline-none transition-[border-color,box-shadow] duration-200 placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20 dark:placeholder:text-muted-foreground/60'

/** Excel 导入客户端预校验上限（与服务端 HT_EXCEL_MAX_BYTES 一致） */
const MAX_EXCEL_BYTES = 10 * 1024 * 1024
const EXCEL_EXT_RE = /\.(xlsx|xlsm|xls|csv)$/i

interface ExcelImportMeta {
  fileName: string
  source: 'llm' | 'regex'
  groupCount: number
  targetCount: number
  /** v2.23.1 序列兜底：行缺 UniProt 但有构建序列 → 按序列评估（v2.34：行=组；v2.35：跨行去重后） */
  seqGroupCount: number
  seqTargetCount: number
  /** v2.34：行→组口径统计（抗体链忽略 / 同源多聚体合并 / 跳过行数） */
  seqAntibodyChains?: number
  seqHomologMerged?: number
  seqSkippedRows?: number
  /** v2.35：跨行去重统计（所有链 ≥95% 同源的重复交付行并入代表组） */
  seqCrossRowMerged?: number
  seqDataRows?: number
  /** v2.27：携带构建区间的靶点数（截短构建感知） */
  rangeTargetCount: number
  /** v2.29：携带结构域名提示的靶点数（管线内与 UniProt domain 匹配推导区间） */
  domainHintTargetCount: number
  invalid: string[]
  note?: string
}

function runStatusPill(run: HTRunState): { label: string; cls: string } {
  switch (run.status) {
    case 'running':
      return { label: '进行中', cls: 'border-primary/40 bg-primary/[0.07] text-primary' }
    case 'paused':
      return { label: '已暂停（可恢复）', cls: 'border-amber-500/40 bg-amber-500/[0.08] text-amber-600 dark:text-amber-400' }
    case 'interrupted':
      return { label: '已中断（可恢复）', cls: 'border-amber-500/40 bg-amber-500/[0.08] text-amber-600 dark:text-amber-400' }
    case 'stopped':
      return { label: '已停止（可恢复）', cls: 'border-amber-500/40 bg-amber-500/[0.08] text-amber-600 dark:text-amber-400' }
    default:
      return { label: '已完成', cls: 'border-emerald-500/40 bg-emerald-500/[0.08] text-emerald-600 dark:text-emerald-400' }
  }
}

export function HighThroughputPanel({ value, onChange, parsed, seqGroups, onSeqGroupsChange, excelRows, onExcelRowsChange, recentRuns, onResumeRun, onDeleteRun, onArchiveRun, archiving, skipKeys, onSkipKeysChange }: HighThroughputPanelProps) {
  const totalTargets = parsed.groups.reduce((n, g) => n + g.length, 0)
  const seqTargetTotal = seqGroups.reduce((n, g) => n + g.length, 0)
  const groupTotal = parsed.groups.length + seqGroups.length

  // ── v2.38 靶点选择（启动前勾选；未勾选 = 跳过） ──
  const skipSet = new Set(skipKeys)
  const toggleSkip = (key: string) => {
    const next = new Set(skipSet)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    onSkipKeysChange([...next])
  }
  const toggleGroupSkip = (kind: 'g' | 'sq', gi: number, count: number) => {
    const keys = Array.from({ length: count }, (_, j) => `${kind}:${gi}:${j}`)
    const allSkipped = keys.every((k) => skipSet.has(k))
    const next = new Set(skipSet)
    for (const k of keys) {
      if (allSkipped) next.delete(k)
      else next.add(k)
    }
    onSkipKeysChange([...next])
  }
  const selectedCount = totalTargets + seqTargetTotal - [...skipSet].filter((k) => {
    const [kind, gi, ti] = k.split(':')
    if (kind === 'g') return (parsed.groups[Number(gi)]?.[Number(ti)]) != null
    return (seqGroups[Number(gi)]?.[Number(ti)]) != null
  }).length

  // ── v2.38 报告导入（zip 归档 / v2.44 单独 HTML，可多选批量；既有报告匹配 → 自动取消勾选） ──
  const zipInputRef = useRef<HTMLInputElement>(null)
  const [importingZip, setImportingZip] = useState(false)
  const [zipMeta, setZipMeta] = useState<{ name: string; reports: number; matched: number } | null>(null)
  const handleZipImport = async (files: FileList | null | undefined) => {
    const list = files ? Array.from(files) : []
    if (list.length === 0 || importingZip) return
    setImportingZip(true)
    try {
      const reports = await parseHtImportFiles(list)
      if (reports.length === 0) throw new Error('所选文件中没有可识别的报告（支持 zip 归档与报告 HTML）')
      // v2.42 严格匹配（planArchiveSkips）：只有单靶点 job 报告参与；序列靶点
      // SHA 精确等值 / 标签+长度严格相等且无歧义才跳 — 杜绝短标签包含式误跳
      const targets: HtMatchTarget[] = []
      for (let i = 0; i < parsed.groups.length; i++) {
        for (let j = 0; j < parsed.groups[i].length; j++) {
          targets.push({ key: `g:${i}:${j}`, acc: parsed.groups[i][j], range: parsed.groupRanges?.[i]?.[j], groupIndex: i })
        }
      }
      for (let k = 0; k < seqGroups.length; k++) {
        for (let j = 0; j < seqGroups[k].length; j++) {
          const s = seqGroups[k][j]!
          const label = s.header
            ? `${s.header.length > 30 ? `${s.header.slice(0, 22)}…${s.header.slice(-7)}` : s.header} · ${s.length}aa`
            : `序列${j + 1} · ${s.length}aa`
          targets.push({ key: `sq:${k}:${j}`, header: s.header, label, length: s.length, seqSha: await sha256Hex16(s.seq), seq: s.seq, groupIndex: parsed.groups.length + k })
        }
      }
      const matchedKeys = planArchiveSkips(reports, targets, { totalGroups: groupTotal })
      const next = new Set(skipSet)
      let matched = 0
      for (const key of matchedKeys) {
        if (!next.has(key)) {
          next.add(key)
          matched++
        }
      }
      onSkipKeysChange([...next])
      setZipMeta({ name: list.length === 1 ? (list[0] as File).name : `${list.length} 个报告文件`, reports: reports.length, matched })
      // v2.49 逐文件诊断：未命中文件给出人话原因（用户此前只能看到「未命中」三个字）
      const missLines = diagnoseArchiveImport(reports, targets, { totalGroups: groupTotal })
        .filter((d) => !d.matched)
        .map((d) => `${d.file}：${d.reason}`)
      const missTail = missLines.length > 0
        ? `\n未命中文件原因：\n${missLines.slice(0, 5).join('\n')}${missLines.length > 5 ? `\n…等共 ${missLines.length} 个文件` : ''}`
        : ''
      if (matched > 0) {
        toast({
          title: `已匹配 ${matched} 个已有报告的靶点`,
          description: (
            <div className="whitespace-pre-line">
              {`这些靶点已取消勾选（启动时跳过，不重复评估）；报告见导入的文件。匹配依据：UniProt/序列/区间严格一致，或报告携带的组号（G{NN}，需总组数对齐；多靶点组内按序列 SHA/比对跨度/长度唯一定位）。可手动重新勾选恢复评估。${missTail}`}
            </div>
          ),
        })
      } else if (matchedKeys.size > 0) {
        toast({
          title: '导入的报告与此前导入重复',
          description: `对应靶点已在此前的导入中取消勾选（本次未重复计数）；可手动重新勾选恢复评估。`,
        })
      } else {
        toast({
          title: '导入的报告中没有匹配到当前清单的靶点',
          description: (
            <div className="whitespace-pre-line">
              {`已识别 ${reports.length} 条报告记录但未命中。${missTail || '\n常见原因：清单分组结构与导出报告的运行不一致（组数/组内靶点变化，组号无法对齐）；或旧版报告无序列标记且文件名无组号。可改用「批量下载全部」的 zip 导入（含精确清单）。注意：新建运行的分组结构需与导出报告的运行一致，组号才能对上。'}`}
            </div>
          ),
        })
      }
    } catch (e) {
      toast({ title: '导入失败', description: e instanceof Error ? e.message : '无法解析所选报告文件', variant: 'destructive' })
    } finally {
      setImportingZip(false)
      if (zipInputRef.current) zipInputRef.current.value = ''
    }
  }

  // ── v2.23 Excel 导入：LLM/规则提取分组 → 填入输入框（可撤销） ──
  const excelInputRef = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [importMeta, setImportMeta] = useState<ExcelImportMeta | null>(null)
  /** 导入前的手输内容（撤销恢复用；null = 本次会话尚无导入） */
  const [preImportText, setPreImportText] = useState<string | null>(null)
  /** 导入前的序列兜底组（撤销恢复用） */
  const [preImportSeqGroups, setPreImportSeqGroups] = useState<HtSeqTarget[][] | null>(null)

  const handleExcelImport = async (file: File | null | undefined) => {
    if (!file || importing) return
    if (!EXCEL_EXT_RE.test(file.name)) {
      setImportError('仅支持 .xlsx / .xlsm / .xls / .csv 格式的靶点表')
      return
    }
    if (file.size > MAX_EXCEL_BYTES) {
      setImportError(`文件超过 10MB 上限（当前 ${(file.size / 1048576).toFixed(1)}MB），请拆分后分次导入`)
      return
    }
    setImporting(true)
    setImportError(null)
    try {
      const r = await extractHtTargetsFromExcel(file)
      const seqs = r.seqGroups ?? []
      if (!r.groups?.length && seqs.length === 0) {
        setImportError(r.note || '未在表格中识别到 UniProt 靶点或构建序列（需含 UniProt accession 或序列列）')
        return
      }
      setPreImportText(value)
      setPreImportSeqGroups(seqGroups)
      // v2.27/v2.29：区间与域名提示均以后缀形式写进分组文本（「P0DTD1:4393-5324」/
      // 「P51685:胞外域」）— 文本往返中保活，用户可直接增删改；无后缀靶点保持原样
      if (r.groups.length > 0) {
        onChange(
          r.groups
            .map((g, gi) =>
              g
                .map((t, ti) => {
                  const rr = r.groupRanges?.[gi]?.[ti]
                  const dh = r.groupDomainHints?.[gi]?.[ti]
                  return rr ? `${t}:${rr[0]}-${rr[1]}` : dh ? `${t}:${dh}` : t
                })
                .join(', '),
            )
            .join(';\n'),
        )
      }
      onSeqGroupsChange(seqs)
      // v2.36：原始行快照留存（汇总报告「原表内容」列；撤销导入时同步清除）
      onExcelRowsChange((r.excelRows ?? []).slice(0, 600))
      setImportMeta({
        fileName: file.name,
        source: r.source,
        groupCount: r.groups.length,
        targetCount: r.groups.reduce((n, g) => n + g.length, 0),
        seqGroupCount: seqs.length,
        seqTargetCount: seqs.reduce((n, g) => n + g.length, 0),
        seqAntibodyChains: r.meta?.seqAntibodyChains,
        seqHomologMerged: r.meta?.seqHomologMerged,
        seqSkippedRows: r.meta?.seqSkippedRows,
        seqCrossRowMerged: r.meta?.seqCrossRowMerged,
        seqDataRows: r.meta?.seqDataRows,
        rangeTargetCount:
          r.meta?.rangeTargets ??
          (r.groupRanges ?? []).reduce((n, gr) => n + gr.filter(Boolean).length, 0),
        domainHintTargetCount:
          r.meta?.domainHintTargets ??
          (r.groupDomainHints ?? []).reduce((n, gh) => n + gh.filter(Boolean).length, 0),
        invalid: r.invalid ?? [],
        note: r.note,
      })
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Excel 解析失败，请稍后重试')
    } finally {
      setImporting(false)
    }
  }

  const undoExcelImport = () => {
    if (preImportText === null && preImportSeqGroups === null) return
    if (preImportText !== null) onChange(preImportText)
    if (preImportSeqGroups !== null) onSeqGroupsChange(preImportSeqGroups)
    onExcelRowsChange([])
    setPreImportText(null)
    setPreImportSeqGroups(null)
    setImportMeta(null)
    setImportError(null)
  }

  return (
    <div className="flex flex-col gap-2.5">
      <Textarea
        aria-label="高通量分组输入"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={
          '按组输入 UniProt ID — 组间用分号「;」分隔，组内用逗号「,」分隔：\n'
          + 'P04637, P00533, Q9Y6K9; O14746\n'
          + 'P0DTD1:4393-5324; P0DTD1:181-818（截短/聚蛋白片段可带「:起始-结束」区间）\n'
          + '（组内多个靶点按复合物批量评估并出合并报告；单个靶点则独立评估；带区间靶点仅统计链范围重叠的结构）'
        }
        className={cn(inputBase, 'min-h-[128px] resize-y px-3.5 py-2.5 font-mono text-[13px] leading-[22px] uppercase placeholder:font-sans placeholder:normal-case placeholder:text-[12px] placeholder:leading-[20px]')}
        spellCheck={false}
      />

      {/* v2.23 Excel 导入：LLM 解析靶点表 → 填充分组输入（覆盖手输，可撤销）；v2.38 报告 zip 导入 */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={excelInputRef}
          type="file"
          accept=".xlsx,.xlsm,.xls,.csv"
          className="hidden"
          onChange={(e) => {
            void handleExcelImport(e.target.files?.[0])
            e.target.value = ''
          }}
        />
        <input
          ref={zipInputRef}
          type="file"
          accept=".zip,.html,.htm"
          multiple
          className="hidden"
          onChange={(e) => {
            void handleZipImport(e.target.files)
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={importing}
          onClick={() => excelInputRef.current?.click()}
          className="h-7 gap-1.5 rounded-lg px-2.5 text-[11px] font-medium"
          title="上传 Excel/CSV 靶点表，由 LLM 语义提取分组（组号/复合物列、同行多靶点等）并填入下方输入；LLM 不可用时自动规则提取"
        >
          {importing
            ? <LoaderCircle className="size-3 animate-spin" aria-hidden />
            : <FileSpreadsheet className="size-3" aria-hidden />}
          {importing ? 'AI 解析中…' : '从 Excel 导入'}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={importingZip}
          onClick={() => zipInputRef.current?.click()}
          className="h-7 gap-1.5 rounded-lg px-2.5 text-[11px] font-medium"
          title="导入既有报告（zip 归档或单独的报告 HTML 文件，可多选批量 — 如浏览器下载的「G74_xxx.html」）— 已有报告的靶点自动取消勾选（跳过评估，不占配额）"
        >
          {importingZip
            ? <LoaderCircle className="size-3 animate-spin" aria-hidden />
            : <FileArchive className="size-3" aria-hidden />}
          {importingZip ? '导入中…' : '导入报告（zip/HTML）'}
        </Button>
        <span className="font-mono text-[10px] text-muted-foreground/70">
          .xlsx / .xls / .csv ≤ 10MB · AI 识别分组列与复合物行 · 序列行逐行成组（同链多靶点同组 · 抗体链忽略 · 同源多聚体只计 1 条 · 跨行完全同源 ≥95% 并为一组） · 导入会替换当前输入
        </span>
      </div>

      {importing && (
        <div className="flex items-center gap-2 rounded-lg border border-primary/25 bg-primary/[0.05] px-2.5 py-1.5 text-[11px] text-foreground/90">
          <LoaderCircle className="size-3.5 shrink-0 animate-spin text-primary" aria-hidden />
          AI 正在解析靶点表：识别 UniProt 靶点与分组语义（组号 / 复合物 / 同行多靶点）…
        </div>
      )}

      {importError && (
        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-red-600 dark:text-red-400">
          <CircleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
          {importError}
        </p>
      )}

      {importMeta && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-primary/25 bg-primary/[0.05] px-2.5 py-1.5">
          <CircleCheckBig className="size-3.5 shrink-0 text-primary" aria-hidden />
          <span className="max-w-52 truncate font-mono text-[11px] text-foreground/90" title={importMeta.fileName}>
            {importMeta.fileName}
          </span>
          <span
            className={cn(
              'rounded-md px-1.5 py-0.5 font-mono text-[9.5px] font-semibold',
              importMeta.source === 'llm'
                ? 'bg-primary/10 text-primary'
                : 'bg-muted text-muted-foreground',
            )}
            title={importMeta.source === 'llm' ? 'LLM 语义提取（组号/复合物列与同行多靶点识别）' : 'LLM 不可用或超时，已按规则提取（组列/同行语义）'}
          >
            {importMeta.source === 'llm' ? 'LLM 智能提取' : '规则提取（LLM 不可用）'}
          </span>
          <span className="font-mono text-[11px] text-foreground/90">
            提取 {importMeta.groupCount} 组 · {importMeta.targetCount} 靶点，已填入下方分组
          </span>
          {importMeta.rangeTargetCount > 0 && (
            <span
              className="font-mono text-[11px] text-primary"
              title="行内解析出截短构建区间（UniProt 列括号注释 / 构建列 / 序列标签头）→ 范围重叠结构优先展示，无重叠折叠保留；区间以「ID:起始-结束」后缀填入，可手改"
            >
              其中 {importMeta.rangeTargetCount} 靶点带构建区间（范围重叠优先展示）
            </span>
          )}
          {importMeta.domainHintTargetCount > 0 && (
            <span
              className="font-mono text-[11px] text-emerald-600 dark:text-emerald-400"
              title="评估表不写区间而写结构域名（如胞外域/kinase domain）→ 管线内与 UniProt domain 划分匹配推导区间，优先展示该区段结构（无重叠折叠保留）；域名以「ID:域名」后缀填入，可手改"
            >
              其中 {importMeta.domainHintTargetCount} 靶点带结构域名（UniProt domain 匹配推导区间）
            </span>
          )}
          {importMeta.seqGroupCount > 0 && (
            <span
              className="font-mono text-[11px] text-teal-600 dark:text-teal-400"
              title="行内无 UniProt ID 但有序列（结构交付表 FASTA 链 / 构建序列）→ 逐行成组：同一行的多个靶点作为同一组；抗体链已忽略；同源多聚体只计 1 条；跨行所有链 ≥95% 同源（相同 / 复测 / 双格式 / 重精修交付）并入同一组；组内每条序列独立评估"
            >
              {importMeta.seqCrossRowMerged
                ? `${importMeta.seqDataRows ?? importMeta.seqGroupCount + (importMeta.seqCrossRowMerged ?? 0)} 行序列 → 跨行去重后 ${importMeta.seqGroupCount} 组`
                : `另提取 ${importMeta.seqGroupCount} 组（行=组）`}
              {' '}· {importMeta.seqTargetCount} 条靶点序列
              {importMeta.seqCrossRowMerged ? ` · 跨行去重 ${importMeta.seqCrossRowMerged} 行` : ''}
              {importMeta.seqAntibodyChains ? ` · 忽略抗体链 ${importMeta.seqAntibodyChains}` : ''}
              {importMeta.seqHomologMerged ? ` · 同源合并 ${importMeta.seqHomologMerged}` : ''}
              {importMeta.seqSkippedRows ? ` · 跳过纯抗体行 ${importMeta.seqSkippedRows}` : ''}
            </span>
          )}
          {importMeta.note && (
            <span className="text-[10px] text-muted-foreground/80">{importMeta.note}</span>
          )}
          {excelRows.length > 0 && (
            <span
              className="font-mono text-[11px] text-muted-foreground"
              title="原始表全部数据行已留存折叠快照（序列只保留识别前缀）— 运行完成后的汇总报告「原表内容」列会展示对应行"
            >
              原表 {excelRows.length} 行快照已留存（汇总报告含「原表内容」列）
            </span>
          )}
          {importMeta.invalid.length > 0 && (
            <span className="text-[10px] text-amber-600 dark:text-amber-400">
              未识别条目：{importMeta.invalid.join('、')}
            </span>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={undoExcelImport}
            className="ml-auto h-6 gap-1 rounded-md px-2 text-[10.5px] font-medium text-muted-foreground hover:text-foreground"
            title="恢复导入前的手输内容（覆盖当前已填充分组）"
          >
            <Undo2 className="size-3" aria-hidden />
            撤销导入
          </Button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/60 px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
          <FileStack className="size-3" aria-hidden />
          {groupTotal} 组 · {selectedCount}/{totalTargets + seqTargetTotal} 靶点已选
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/60 px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
          <Zap className="size-3" aria-hidden />
          逐组出报告 · 限流自动暂停
        </span>
        {groupTotal > 0 && (
          <span className="font-mono text-[10px] text-muted-foreground/70">
            复合物组 {parsed.groups.filter((g) => g.length > 1).length} · 单靶点组 {parsed.groups.filter((g) => g.length === 1).length}
            {seqGroups.length > 0 ? ` · 序列兜底组 ${seqGroups.length}` : ''}
          </span>
        )}
        {skipKeys.length > 0 && groupTotal > 0 && (
          <button
            type="button"
            onClick={() => onSkipKeysChange([])}
            className="ml-auto inline-flex h-6 items-center gap-1 rounded-md px-1.5 font-mono text-[10px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="恢复勾选全部靶点（清除所有跳过标记）"
          >
            <Undo2 className="size-3" aria-hidden />
            全选
          </button>
        )}
      </div>

      {zipMeta && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-sky-500/25 bg-sky-500/[0.05] px-2.5 py-1.5">
          <FileArchive className="size-3.5 shrink-0 text-sky-600 dark:text-sky-400" aria-hidden />
          <span className="max-w-52 truncate font-mono text-[11px] text-foreground/90" title={zipMeta.name}>
            {zipMeta.name}
          </span>
          <span className="font-mono text-[11px] text-sky-700 dark:text-sky-400">
            识别 {zipMeta.reports} 条报告记录 · 匹配 {zipMeta.matched} 个已完成靶点（已取消勾选，启动时跳过）
          </span>
        </div>
      )}

      {/* 分组预览：每组一行（组号 + 靶点 chips + 复合物/单靶点徽章）；v2.23.1 序列兜底组；
          v2.38 每靶点勾选框（未勾选 = 启动时跳过，保留在记录里可恢复） */}
      {(parsed.groups.length > 0 || seqGroups.length > 0) && (
        <ol className="flex flex-col gap-1.5">
          {parsed.groups.map((g, i) => (
            <li key={i} className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-muted/40 px-2.5 py-1.5">
              <button
                type="button"
                onClick={() => toggleGroupSkip('g', i, g.length)}
                className="shrink-0 rounded-md bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-primary transition-opacity hover:opacity-80"
                title={g.every((_, ti) => skipSet.has(`g:${i}:${ti}`)) ? '全组已跳过 — 点击恢复全组' : '点击跳过/恢复全组'}
              >
                G{String(i + 1).padStart(2, '0')}
              </button>
              {g.map((t, ti) => {
                const rr = parsed.groupRanges?.[i]?.[ti]
                const dh = parsed.groupDomainHints?.[i]?.[ti]
                const skipped = skipSet.has(`g:${i}:${ti}`)
                return (
                  <span
                    key={t}
                    className={cn(
                      'inline-flex items-center gap-1 rounded-md border bg-card px-1.5 py-0.5 font-mono text-[11px]',
                      skipped ? 'border-sky-500/30 text-sky-700/60 line-through decoration-sky-500/40 dark:text-sky-400/60' : 'border-border text-foreground/90',
                    )}
                    title={
                      skipped
                        ? '已跳过（启动时不评估；运行中可恢复）'
                        : rr
                          ? `评估区间 ${rr[0]}-${rr[1]}（范围重叠结构优先展示，无重叠折叠保留）`
                          : dh
                            ? `结构域名提示「${dh}」— 管线内与 UniProt domain 划分匹配推导区间，优先展示该区段结构`
                            : undefined
                    }
                  >
                    <Checkbox
                      checked={!skipped}
                      onCheckedChange={() => toggleSkip(`g:${i}:${ti}`)}
                      className="size-3"
                      aria-label={`评估靶点 ${t}`}
                    />
                    {t}
                    {rr && <span className="text-primary/90">:{rr[0]}-{rr[1]}</span>}
                    {dh && <span className="text-emerald-600 dark:text-emerald-400">:{dh}</span>}
                  </span>
                )
              })}
              <span
                className={cn(
                  'ml-auto shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[9.5px] font-semibold',
                  g.length > 1 ? 'bg-violet-500/10 text-violet-600 dark:text-violet-400' : 'bg-muted text-muted-foreground',
                )}
                title={g.length > 1 ? '组内多靶点：关系判断 → 逐靶点评估 → 合并评估报告' : '单靶点独立评估，独立报告'}
              >
                {g.length > 1 ? `复合物 · ${g.length} 靶点` : '单靶点 · 独立评估'}
              </span>
            </li>
          ))}
          {seqGroups.map((g, gi) => (
            <li
              key={`seq-${gi}`}
              className="flex flex-wrap items-center gap-1.5 rounded-lg border border-teal-500/30 bg-teal-500/[0.04] px-2.5 py-1.5"
              title="该行无 UniProt ID 但有序列 → 逐行成组（同一行的多个靶点作为同一组）；抗体链已忽略、同源多聚体只计 1 条；跨行所有链 ≥95% 同源的重复交付行已并入本组（首个交付行为代表）；组内每条序列作为独立序列靶点评估（结构预测走 ESMFold 兜底）。评估区间由管线在 BLAST 归属后自动推导（构建比对 / BLAST nr 比对坐标 — 不取自 Excel 行文本，年份等数字不会被误当残基区间）"
            >
              <button
                type="button"
                onClick={() => toggleGroupSkip('sq', gi, g.length)}
                className="shrink-0 rounded-md bg-teal-500/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-teal-600 transition-opacity hover:opacity-80 dark:text-teal-400"
                title={g.every((_, si) => skipSet.has(`sq:${gi}:${si}`)) ? '全组已跳过 — 点击恢复全组' : '点击跳过/恢复全组'}
              >
                G{String(parsed.groups.length + gi + 1).padStart(2, '0')}
              </button>
              {g.map((s, si) => {
                const skipped = skipSet.has(`sq:${gi}:${si}`)
                return (
                  <span
                    key={`${s.header}-${si}`}
                    className={cn(
                      'inline-flex max-w-64 items-center gap-1 truncate rounded-md border bg-card px-1.5 py-0.5 font-mono text-[11px]',
                      skipped ? 'border-sky-500/30 text-sky-700/60 line-through decoration-sky-500/40 dark:text-sky-400/60' : 'border-border text-foreground/90',
                    )}
                    title={`${s.header || '裸序列'}（${s.length} aa）${skipped ? ' · 已跳过（启动时不评估；运行中可恢复）' : ''}`}
                  >
                    <Checkbox
                      checked={!skipped}
                      onCheckedChange={() => toggleSkip(`sq:${gi}:${si}`)}
                      className="size-3"
                      aria-label={`评估序列靶点 ${s.header || `序列${si + 1}`}`}
                    />
                    <span className="truncate">
                      {s.header ? `${s.header.slice(0, 24)} · ${s.length}aa` : `序列 · ${s.length}aa`}
                    </span>
                  </span>
                )
              })}
              <span className="ml-auto shrink-0 rounded-md bg-teal-500/10 px-1.5 py-0.5 font-mono text-[9.5px] font-semibold text-teal-600 dark:text-teal-400">
                行组 · {g.length} 条独立评估
              </span>
            </li>
          ))}
        </ol>
      )}

      {parsed.invalid.length > 0 && (
        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
          无效 UniProt ID（不符合编号规则，将被忽略）：{parsed.invalid.join('、')}
        </p>
      )}
      {parsed.duplicates.length > 0 && (
        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
          重复靶点已自动去重（仅保留首次出现的组）：{parsed.duplicates.join('、')}
        </p>
      )}

      <p className="text-[11px] leading-relaxed text-muted-foreground/80">
        支持手输或「从 Excel 导入」（AI 语义提取分组；行内无 UniProt ID 但有序列时逐行成组 — 同一行的多个靶点作为同一组，
        抗体链自动忽略，同源多聚体只计 1 条序列，跨行所有链 ≥95% 同源（相同 / 复测 / 双格式 / 重精修交付）自动并为一组，
        靶点名取自行内文件路径/标签）。
        每组按现有复合物批量评估链路执行（靶点关系判断 → 并发评估 → 合并评估报告），组间并行推进（共享 6 路并发窗口，慢 BLAST 等待期不阻塞其他靶点），启动时全部 BLAST 预热提交（限速 ~15s/发，作业排队期间 NCBI 已在计算）；
        遇 LLM 限流 / 服务配额（含每日作业配额）自动暂停，配额恢复后可从断点重新开始（已完成的组不会重复评估）。
        每组报告与运行日志在完成后均保留可回看。
      </p>

      {/* 最近高通量运行（恢复断点 / 回看结果） */}
      {recentRuns.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-2.5">
          <p className="lin-eyebrow text-muted-foreground/80">Recent Runs · 最近高通量运行</p>
          <ol className="flex flex-col gap-1">
            {recentRuns.slice(0, 3).map((r) => {
              const pill = runStatusPill(r)
              return (
                <li key={r.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border/70 bg-muted/30 px-2.5 py-1.5">
                  <span className={cn('rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium', pill.cls)}>{pill.label}</span>
                  <span className="font-mono text-[11px] text-foreground/90">
                    {r.groups.length} 组 · {r.totalTargetCount} 靶点
                  </span>
                  <span className="font-mono text-[10px] text-muted-foreground/70">{formatDateTime(new Date(r.createdAt).toISOString())}</span>
                  <span className="ml-auto flex items-center gap-1">
                    {r.status !== 'done' ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => onResumeRun(r.id)}
                        className="h-7 gap-1 rounded-lg px-2.5 text-[11px] font-medium"
                        title={r.status === 'paused' ? '从断点恢复运行' : '接上仍在执行的作业，从断点继续'}
                      >
                        <RotateCcw className="size-3" aria-hidden />
                        恢复运行
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => onResumeRun(r.id)}
                        className="h-7 gap-1 rounded-lg px-2.5 text-[11px] font-medium"
                        title="回看该次运行的组结果与日志"
                      >
                        <Play className="size-3" aria-hidden />
                        回看
                      </Button>
                    )}
                    {/* v2.25 批量下载（zip：每组子文件夹 + 合并报告 + README 清单） */}
                    {onArchiveRun && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={archiving || !r.groups.some((g) => g.mergedReportId || g.items.some((it) => it.status === 'done' && it.jobId))}
                        onClick={() => onArchiveRun(r.id)}
                        className="h-7 gap-1 rounded-lg px-2.5 text-[11px] font-medium"
                        title="打包该次运行全部报告为单个 zip（每组一个子文件夹，含合并报告与 README 清单）"
                      >
                        {archiving
                          ? <LoaderCircle className="size-3 animate-spin" aria-hidden />
                          : <Download className="size-3" aria-hidden />}
                        批量下载
                      </Button>
                    )}
                    <button
                      type="button"
                      onClick={() => onDeleteRun(r.id)}
                      aria-label="删除该运行记录"
                      className="flex size-7 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-accent hover:text-red-600"
                    >
                      <Trash2 className="size-3" />
                    </button>
                  </span>
                </li>
              )
            })}
          </ol>
        </div>
      )}
    </div>
  )
}
