'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  AlertTriangle,
  ArrowLeft,
  BookOpenText,
  CircleAlert,
  Crosshair,
  Database,
  Download,
  ExternalLink,
  Eye,
  FileCheck2,
  Layers,
  Loader2,
  ChevronDown,
  Printer,
  RefreshCw,
  RotateCcw,
  Ruler,
  SearchX,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { toast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import { describeBlastStatus } from '@/lib/eval/types'
import { RatingBadge } from './badges'
import { EvalLogConsole } from './log-console'
import { formatDuration, formatPercent, formatResolution, logLevel, scoreLevel } from './format'
import { PdbTable } from './pdb-table'
import { BlastTable, BlastNrTable } from './blast-table'
import { LiteratureList } from './literature-list'
import { AssetGallery } from './asset-gallery'
import { Ligand2dFigure } from './ligand-2d'
import { InteractionStructures } from './interaction-structures'
import { ReportDownloadMenu } from './report-download-menu'
import type { BlastStatusCode, JobDetail, LigandDetail, ScoreItem } from './types'
import { regenerateJobReport } from './api'

/* ---------------- 通用小组件 ---------------- */

/** v2.7：配体 PubChem 计算性质行（XLogP/TPSA/氢供受体/可旋转键/重原子/精确质量；无数据时渲染空） */
function LigandPropsRow({ d }: { d?: LigandDetail }) {
  if (!d) return null
  const items: Array<[string, string]> = []
  if (d.xlogp != null) items.push(['XLogP', String(d.xlogp)])
  if (d.tpsa != null) items.push(['TPSA', `${d.tpsa} Å²`])
  if (d.hBondDonor != null) items.push(['氢供体', String(d.hBondDonor)])
  if (d.hBondAcceptor != null) items.push(['氢受体', String(d.hBondAcceptor)])
  if (d.rotatableBonds != null) items.push(['可旋转键', String(d.rotatableBonds)])
  if (d.heavyAtoms != null) items.push(['重原子', String(d.heavyAtoms)])
  if (d.exactMass != null) items.push(['精确质量', String(d.exactMass)])
  if (d.charge != null && d.charge !== 0) items.push(['形式电荷', `${d.charge > 0 ? '+' : ''}${d.charge}`])
  if (!items.length) return null
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 border-t border-dashed border-border pt-2 text-[11px] text-muted-foreground">
      {items.map(([k, v]) => (
        <span key={k}>{k} <b className="font-mono text-foreground/75">{v}</b></span>
      ))}
    </div>
  )
}

/** 规格栅格单元（Linear 仪表读数）：mono 眉题 + 大数字 + 注释 */
function SpecCell({
  label,
  value,
  sub,
  badge,
  className,
}: {
  label: string
  value: string
  sub?: string
  badge?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-col gap-1 bg-card px-4 py-3.5', className)}>
      <span className="lin-eyebrow text-muted-foreground/85">{label}</span>
      <span className="flex flex-wrap items-baseline gap-2">
        <span className="num-glow text-xl font-semibold tabular-nums tracking-[-0.02em] text-foreground">
          {value}
        </span>
        {badge}
      </span>
      {sub && <span className="truncate text-[11px] text-muted-foreground/85" title={sub}>{sub}</span>}
    </div>
  )
}

/** 纯 CSS 评分条（细轨 + 档位色 — 语义色保留但克制）；v2.18：AI 复核 delta 徽章（≠0 时紧随分值） */
function ScoreBar({ label, item, delay = 0, delta = 0 }: { label: string; item: ScoreItem; delay?: number; delta?: number }) {
  const maxScore = item.maxScore && item.maxScore > 0 ? item.maxScore : 10
  const pct = Math.max(2, Math.min(100, (item.score / maxScore) * 100))
  const level = scoreLevel(item.score)
  const barCls = {
    emerald: 'bg-emerald-600 dark:bg-emerald-500',
    amber: 'bg-amber-500',
    red: 'bg-red-500',
  }[level]

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-foreground/90">{label}</span>
        <span className="flex items-center gap-2">
          <span className="num-glow font-mono text-sm font-semibold tabular-nums text-foreground">
            {Number(item.score.toFixed(1))}
            <span className="text-[11px] font-normal text-muted-foreground"> /{maxScore}</span>
          </span>
          {delta !== 0 && (
            <span
              title={`AI 复核${delta > 0 ? '上调' : '下调'} ${Math.abs(delta)} 分`}
              className={cn(
                'inline-flex items-center rounded-full border px-1.5 py-0 font-mono text-[10px] font-bold',
                delta > 0
                  ? 'border-violet-500/40 bg-violet-500/[0.08] text-violet-700 dark:text-violet-400'
                  : 'border-red-500/30 bg-red-500/[0.08] text-red-700 dark:text-red-400',
              )}
            >
              AI {delta > 0 ? '+' : '−'}{Math.abs(delta)}
            </span>
          )}
          <RatingBadge score={item.score} rating={item.rating} />
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.7, delay, ease: 'easeOut' }}
          className={cn('h-full rounded-full', barCls)}
        />
      </div>
    </div>
  )
}

/** 聚集形式调整 chip（+1 绿 / −1 红 / ±0 灰） */
function AdjChip({ label, v }: { label: string; v: number }) {
  const cls =
    v > 0
      ? 'border-emerald-500/30 bg-emerald-500/[0.08] text-emerald-700 dark:text-emerald-400'
      : v < 0
        ? 'border-red-500/30 bg-red-500/[0.08] text-red-700 dark:text-red-400'
        : 'border-border bg-muted text-muted-foreground'
  return (
    <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10.5px] font-bold whitespace-nowrap', cls)}>
      {label} {v > 0 ? `+${v}` : v < 0 ? `−${Math.abs(v)}` : '±0'}
    </span>
  )
}

/** 章节标题（编号 + 中文标题 + mono 英文眉题 + 右侧计数） */
function SectionHeader({
  no,
  title,
  en,
  count,
  right,
}: {
  no: string
  title: string
  en: string
  count?: string
  right?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-2.5 border-b border-border pb-2">
      <span className="lin-eyebrow text-primary">{no}</span>
      <h2 className="text-[17px] font-semibold tracking-[-0.015em] text-foreground">{title}</h2>
      <span className="lin-eyebrow hidden text-muted-foreground/80 sm:inline">{en}</span>
      {count && (
        <span className="ml-auto font-mono text-[11px] tabular-nums text-muted-foreground/85">
          {count}
        </span>
      )}
      {right}
    </div>
  )
}

/* ---------------- LLM 报告 markdown 渲染 ---------------- */

/** 与 Linear 站点编辑风一致的 markdown 样式映射（react-markdown + remark-gfm 表格支持；merged-report-view 复用） */
export const mdComponents: React.ComponentProps<typeof ReactMarkdown>['components'] = {
  h2: ({ children }) => (
    <h2 className="mt-8 mb-3 border-b border-border pb-2 text-base font-semibold tracking-[-0.01em] text-foreground first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-5 mb-2 text-sm font-semibold text-foreground/90">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mt-4 mb-1.5 text-sm font-semibold text-foreground/80">{children}</h4>
  ),
  p: ({ children }) => <p className="mb-3 text-sm leading-7 text-foreground/80 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="mb-3 ml-5 list-disc space-y-1.5 text-sm leading-relaxed text-foreground/80 marker:text-muted-foreground/50 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-3 ml-5 list-decimal space-y-1.5 text-sm leading-relaxed text-foreground/80 marker:text-muted-foreground/50 last:mb-0">{children}</ol>,
  li: ({ children }) => <li className="pl-1 [>&p]:mb-0">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer" className="font-medium text-primary underline-offset-2 hover:underline">
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="mb-3 rounded-sm border-l-2 border-primary bg-primary/[0.05] px-3.5 py-2.5 text-sm leading-relaxed text-foreground/80">{children}</blockquote>
  ),
  table: ({ children }) => (
    <div className="eval-scroll mb-4 overflow-x-auto rounded-lg border border-border">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-muted/70">{children}</thead>,
  th: ({ children }) => (
    <th className="lin-eyebrow border-b border-border px-2.5 py-2 text-left font-medium whitespace-nowrap text-muted-foreground">{children}</th>
  ),
  td: ({ children }) => (
    <td className="border-b border-border/60 px-2.5 py-2 align-top leading-relaxed text-foreground/80">{children}</td>
  ),
  hr: () => <hr className="my-6 border-border" />,
  code: ({ children }) => (
    <code className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground/90">{children}</code>
  ),
}

/** BLAST 空态说明框（0 命中/跳过/失败原因 — 不再凭空消失） */
function BlastStatusBox({ status, note, provider }: { status?: BlastStatusCode; note?: string; provider?: 'ncbi' | 'rcsb' }) {
  const info = status ? describeBlastStatus({ status, note, provider }) : describeBlastStatus(null)
  const tone =
    status === 'failed'
      ? 'border-amber-500/30 bg-amber-500/[0.05]'
      : status === 'skipped-antibody'
        ? 'border-violet-500/30 bg-violet-500/[0.05]'
        : status === 'skipped-homolog'
          ? 'border-teal-500/30 bg-teal-500/[0.05]'
          : 'border-border bg-muted/50'
  const iconTone =
    status === 'failed'
      ? 'text-amber-600 dark:text-amber-400'
      : status === 'skipped-antibody'
        ? 'text-violet-600 dark:text-violet-400'
        : status === 'skipped-homolog'
          ? 'text-teal-600 dark:text-teal-400'
          : 'text-muted-foreground/80'
  return (
    <div className={cn('flex items-start gap-3 rounded-xl border px-4 py-5', tone)}>
      <SearchX className={cn('mt-0.5 size-4.5 shrink-0', iconTone)} aria-hidden />
      <div className="min-w-0 text-sm leading-relaxed text-foreground/80">
        {info}
        {status !== 'failed' && (
          <p className="mt-1.5 text-xs text-muted-foreground/85">
            可行性结论主要基于直接结构与文献证据；如需同源检索，可在高级选项中开启「强制 BLAST」后重新评估。
          </p>
        )}
      </div>
    </div>
  )
}

/* ---------------- v1.31 内嵌 HTML 报告（与下载同一份文件） ---------------- */

/**
 * 同源 iframe 内嵌完整 HTML 报告：web 展示与「下载 HTML」共用同一文件，样式 100% 一致。
 * - 自动高度：注入内嵌适配样式（取消 .page 100vh 最小高 / 隐藏回顶部钮）后按内容同步；
 *   ResizeObserver 监听 body（details 折叠展开 / 图片懒加载引起的高度变化）
 * - 加载失败（报告文件丢失 404）→ onFail 降级为旧版 React 数据区块
 */
function ReportFrame({
  jobId,
  iframeRef,
  onFail,
  reportHtml,
  reloadNonce,
}: {
  jobId: string
  iframeRef: React.RefObject<HTMLIFrameElement | null>
  onFail: () => void
  /** v2.4 无状态同步评估：内联 HTML 报告（srcDoc 直接渲染，不经 /api/jobs/{id}/report） */
  reportHtml?: string | null
  /** v2.51：报告原地重跑完成后 +1 → src 追加 cache-bust 强制 iframe 重拉新 HTML */
  reloadNonce?: number
}) {
  const [height, setHeight] = useState(560) // v2.55：加载占位从 1600px 收窄 — 报告到达后同步真实高度，避免白屏期巨型空洞
  const [loaded, setLoaded] = useState(false)

  const syncHeight = useCallback(() => {
    const doc = iframeRef.current?.contentDocument
    if (!doc) return
    try {
      if (!doc.getElementById('embed-tweaks')) {
        const st = doc.createElement('style')
        st.id = 'embed-tweaks'
        st.textContent = '.page{min-height:auto!important}.backtop{display:none!important}'
        doc.head.appendChild(st)
      }
      const h = Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight)
      if (Number.isFinite(h) && h > 100) setHeight(h + 16)
    } catch { /* 跨域异常不应发生（同源）；忽略 */ }
  }, [iframeRef])

  useEffect(() => {
    if (!loaded) return
    let ro: ResizeObserver | null = null
    try {
      const doc = iframeRef.current?.contentDocument
      if (doc?.body) {
        ro = new ResizeObserver(() => syncHeight())
        ro.observe(doc.body)
      }
    } catch { /* ignore */ }
    // rAF 延迟一帧再同步高度（避免 effect 内同步 setState 触发级联渲染）
    const raf = requestAnimationFrame(() => syncHeight())
    return () => {
      cancelAnimationFrame(raf)
      ro?.disconnect()
    }
  }, [loaded, syncHeight])

  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-card studio-card">
      {!loaded && (
        <div className="absolute inset-0 z-10 flex min-h-72 flex-col items-center justify-center gap-3 bg-card">
          <Loader2 className="size-6 animate-spin text-primary" aria-hidden />
          <p className="font-mono text-xs text-muted-foreground">正在加载完整 HTML 报告（与下载文件同一份）…</p>
        </div>
      )}
      <iframe
        ref={iframeRef}
        srcDoc={reportHtml ?? undefined}
        src={reportHtml ? undefined : `/api/jobs/${jobId}/report${reloadNonce ? `?_r=${reloadNonce}` : ''}`}
        title="评估报告（与下载 HTML 一致）"
        aria-label="评估报告（与下载 HTML 一致）"
        onLoad={() => {
          setLoaded(true)
          syncHeight()
          // 报告丢失（404 JSON）→ 降级旧版数据区块
          try {
            const doc = iframeRef.current?.contentDocument
            if (doc && !doc.querySelector('.rpt-head')) onFail()
          } catch { /* ignore */ }
        }}
        style={{ height }}
        className="block w-full bg-white transition-[height] duration-200 ease-out"
      />
    </div>
  )
}

/* ---------------- 结果视图 ---------------- */

export interface ResultViewProps {
  job: JobDetail
  onNewEvaluation: () => void
}

/** 结果视图（done）：返回栏 → 刊头 → 规格格栅 → 评分 → 报告操作 → 实验数据 → PDB → BLAST → 文献 */
export function ResultView({ job, onNewEvaluation }: ResultViewProps) {
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewLoaded, setPreviewLoaded] = useState(false)
  const [previewSlow, setPreviewSlow] = useState(false)
  /** v1.31：内嵌报告加载失败（文件丢失）→ 降级旧版 React 数据区块 */
  const [embedFailed, setEmbedFailed] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const reportFrameRef = useRef<HTMLIFrameElement>(null)

  // ── v2.51：单靶点报告 LLM 原地重跑（沿用既有数据，仅重跑 LLM 章节）──
  const [regenOpen, setRegenOpen] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [regenElapsed, setRegenElapsed] = useState(0)
  /** 重跑成功后的本地覆盖（reportMarkdown / 章节标记 — props.job 不重拉） */
  const [regenFresh, setRegenFresh] = useState<{ reportMarkdown?: string | null; reportLlmOk?: boolean; reportLlmMissing?: number } | null>(null)
  /** 重跑完成后 +1 → 内嵌/预览 iframe 追加 cache-bust 强制重拉新 HTML */
  const [reloadNonce, setReloadNonce] = useState(0)
  const regenStartRef = useRef(0)

  // 重跑进行中计时（分钟级 — 展示已等待时长，避免误认为卡死）
  useEffect(() => {
    if (!regenerating) return
    const t = setInterval(() => {
      setRegenElapsed(Math.floor((Date.now() - regenStartRef.current) / 1000))
    }, 1000)
    return () => clearInterval(t)
  }, [regenerating])

  const runRegen = async () => {
    if (regenerating) return
    setRegenOpen(false)
    regenStartRef.current = Date.now()
    setRegenElapsed(0)
    setRegenerating(true)
    try {
      const result = await regenerateJobReport(job.id)
      // 拉取最新作业详情（reportMarkdown / summary 章节标记 / 日志）
      let fresh: JobDetail | null = null
      try {
        const res = await fetch(`/api/jobs/${job.id}`, { cache: 'no-store' })
        if (res.ok) fresh = (await res.json()) as JobDetail
      } catch { /* 详情拉取失败 → 用重跑接口返回的缺章数兜底 */ }
      setRegenFresh({
        reportMarkdown: fresh ? fresh.reportMarkdown ?? null : undefined,
        reportLlmOk: fresh?.summary?.reportLlmOk ?? true,
        reportLlmMissing: fresh?.summary?.reportLlmMissing ?? result.missing,
      })
      setReloadNonce(n => n + 1)
      setEmbedFailed(false)
      if (result.missing > 0) {
        toast({
          title: '报告已重新生成（部分章节失败）',
          description: `${result.missing} 个章节未生成（供应商限流/超时常见）— 已展示成功章节；可再次「重新生成报告」补齐。`,
          variant: 'destructive',
        })
      } else {
        toast({
          title: '报告已重新生成',
          description: 'LLM 分析已按既有数据原地重跑，在线展示与下载文件均已更新。',
        })
      }
    } catch (e) {
      toast({
        title: '报告重新生成失败',
        description: e instanceof Error ? e.message : '请稍后重试（当前版本内容未受影响）',
        variant: 'destructive',
      })
    } finally {
      setRegenerating(false)
    }
  }

  const openPreview = () => {
    setPreviewLoaded(false)
    setPreviewSlow(false)
    setPreviewOpen(true)
  }

  // 预览加载超过 12s 提供降级提示（新窗口打开 / 下载）
  useEffect(() => {
    if (!previewOpen || previewLoaded) return
    const t = setTimeout(() => setPreviewSlow(true), 12_000)
    return () => clearTimeout(t)
  }, [previewOpen, previewLoaded])

  const summary = job.summary
  if (!summary?.uniprot) {
    return (
      <div className="flex flex-col gap-6">
        <Card className="rounded-xl border-border bg-card studio-card">
          <CardContent className="flex flex-col items-center gap-3 px-6 py-10 text-center">
            <p className="text-sm text-muted-foreground">
              该作业已完成，但暂无摘要数据（可能由后端数据不完整导致）。
            </p>
            <Button variant="outline" onClick={onNewEvaluation} className="gap-2 rounded-lg transition-all hover:border-primary/40 active:scale-[0.98]">
              <RotateCcw className="size-4" />
              返回新评估
            </Button>
          </CardContent>
        </Card>
        {(job.logs ?? []).length > 0 && <EvalLogConsole logs={job.logs ?? []} live={false} />}
      </div>
    )
  }

  const u = summary.uniprot
  const scores = summary.scores
  const pdbs = job.pdbs ?? []
  const blastHits = job.blastHits ?? []
  const literature = job.literature ?? []
  const assets = job.assets ?? []
  const ms = summary.methodStats
  const blastInfo = summary.blast ?? null
  const ligands = summary.ligands ?? []
  /** v2.51：重跑后的本地覆盖优先（props.job 未变时展示最新版本） */
  const reportMd = ((regenFresh && regenFresh.reportMarkdown !== undefined ? regenFresh.reportMarkdown : job.reportMarkdown))?.trim() || null
  const reportMissing = regenFresh ? (regenFresh.reportLlmMissing ?? 0) : (summary.reportLlmMissing ?? 0)
  const reportLlmFailed = (regenFresh ? regenFresh.reportLlmOk : summary.reportLlmOk) === false || reportMissing > 0
  const reportDeferred = summary.reportDeferred === true
  /** v2.29：评估区间与范围外结构（重叠优先展示 / 折叠保留） */
  const rangeInfo = summary.range ?? null
  const rangeLabel = rangeInfo
    ? `${rangeInfo[0]}-${rangeInfo[1]}${summary.rangeSource === '结构域匹配（UniProt 注释）' ? ' · 结构域匹配' : summary.rangeSource === '构建比对推导' ? ' · 截短构建推导' : summary.rangeSource === 'BLAST nr 比对推导' ? ' · BLAST 比对推导' : summary.rangeSource === '手动指定' ? ' · 手动指定' : ''}`
    : undefined
  const outsidePdbs = summary.rangeOutsidePdbs ?? []
  const outsideBlastHits = summary.rangeOutsideBlastHits ?? []
  /** v2.59：BLAST nr 全库检索命中（nr 级联实际执行时存档 — BLAST 章节展示） */
  const nrHits = summary.blastNrHits ?? []
  /** v2.4：内联 HTML 报告（无状态同步评估）— srcDoc 渲染 + Blob 下载，不经 /api/jobs/{id}/report */
  const inlineReportHtml = job.stateless ? (job.reportHtml ?? null) : null
  /** v1.31：web 端直接内嵌完整 HTML 报告（与「下载 HTML」同一份文件，样式 100% 一致）。
   *  单靶点作业且报告已生成时启用；deferred（并入合并报告）或文件丢失时降级为下方 React 数据区块。
   *  v2.36：浏览器缓存副本（服务端实例已回收）无服务端文件 → 直接走 markdown 数据区块 */
  const embedReport = !reportDeferred && !job.fromCache && (job.reportAvailable === true || Boolean(inlineReportHtml)) && !embedFailed
  /** v2.51：报告 LLM 原地重跑可用（服务端单靶点报告 + v2.51 后完成的作业才有快照；
   *  旧作业无快照时接口返回明确错误引导重新评估，按钮仍展示让用户知道能力存在） */
  const canRegen = job.status === 'done' && !reportDeferred && !job.fromCache && !job.stateless && job.reportAvailable === true
  /** v2.87：服务端 PDF 导出可用（服务端报告文件在 — 缓存副本/无状态内联无服务端文件不提供） */
  const reportPdfUrl = !job.fromCache && !inlineReportHtml && job.reportAvailable === true ? `/api/jobs/${job.id}/report?download=1` : null

  const downloadReport = () => {
    // v2.36：缓存副本无服务端文件 → 导出 markdown 文本（另存 .md）
    if (job.fromCache) {
      if (!reportMd) {
        toast({ title: '暂无可导出的报告正文', description: '本地缓存副本中未包含报告正文（作业完成时未生成）。', variant: 'destructive' })
        return
      }
      try {
        const blob = new Blob([reportMd], { type: 'text/markdown;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `TargetEval_${(job.uniprotId || job.id).replace(/[^\w-]/g, '_')}_${new Date().toISOString().slice(0, 10)}.md`
        a.rel = 'noopener'
        document.body.appendChild(a)
        a.click()
        a.remove()
        setTimeout(() => URL.revokeObjectURL(url), 10_000)
        toast({ title: '已导出 Markdown 副本', description: '服务端 HTML 报告已随部署实例回收，已改为导出本地缓存的报告正文。' })
      } catch {
        toast({ title: '导出失败', description: '本地缓存数据生成下载文件失败，请重试', variant: 'destructive' })
      }
      return
    }
    // v2.4 无状态：内联报告 → Blob 下载（服务器不保留文件）
    if (inlineReportHtml) {
      try {
        const blob = new Blob([inlineReportHtml], { type: 'text/html;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `TargetEval_${(job.uniprotId || job.id).replace(/[^\w-]/g, '_')}_${new Date().toISOString().slice(0, 10)}.html`
        a.rel = 'noopener'
        document.body.appendChild(a)
        a.click()
        a.remove()
        setTimeout(() => URL.revokeObjectURL(url), 10_000)
      } catch {
        toast({ title: '下载失败', description: '报告数据生成下载文件失败，请重试', variant: 'destructive' })
      }
      return
    }
    window.open(`/api/jobs/${job.id}/report?download=1`, '_blank')
  }

  /** 章节编号按存在性递增 */
  let secNo = 0
  const nextNo = () => String(++secNo).padStart(2, '0')

  const scoreNo = nextNo()
  const reportNo = nextNo()
  const assetsNo = assets.length > 0 ? nextNo() : null
  const pdbNo = nextNo()
  const ligandNo = ligands.length > 0 ? nextNo() : null
  const blastNo = nextNo()
  const litNo = literature.length > 0 ? nextNo() : null
  /** v2.21：运行日志回看（完成后不再丢弃 — 过滤/搜索/复制/下载都在日志控制台内） */
  const logLines = job.logs ?? []
  const logNo = logLines.length > 0 ? nextNo() : null
  const logWarn = logLines.filter(l => logLevel(l) === 'warn').length
  const logErr = logLines.filter(l => logLevel(l) === 'error').length

  /** 规格栅 BLAST 单元注释：按状态给出简短说明（不再是干巴巴的 0） */
  const blastSubMap: Record<string, string> = {
    ok: 'NCBI BLAST 已完成',
    'no-hits': '无显著同源命中',
    'skipped-covered': '覆盖充分，未运行',
    'skipped-disabled': '已在选项中关闭',
    'skipped-antibody': '抗体序列，已跳过',
    'skipped-homolog': '同源家族共享检索',
    failed: '检索失败，可重试',
  }
  const blastViaRcsb = blastInfo?.provider === 'rcsb'
  const blastShared = (blastInfo?.note ?? '').includes('共享自家族代表')
  const blastSub = blastShared
    ? '同源家族共享检索（≥90% 一致）'
    : blastViaRcsb
      ? 'RCSB 序列检索（NCBI 拥堵兜底）'
      : (blastInfo ? blastSubMap[blastInfo.status] : undefined) ?? 'NCBI BLAST'

  /** v1.25：聚集形式（寡聚态）— 融入评分卡（不单独成章） */
  const oligo = summary.oligomer
  const adj = summary.scores?.oligomerAdjust ?? null
  const oligoLabel = oligo?.label || oligo?.summary.split('—')[0].split('（')[0].trim() || ''
  const oligoCatZh = oligo?.category === 'monomer' ? '单体' : oligo?.category === 'homo-oligomer' ? '同源寡聚体' : oligo?.category === 'hetero-complex' ? '异源复合物' : '未知'
  const oligoConfZh = oligo ? (oligo.confidence === 'high' ? '高' : oligo.confidence === 'medium' ? '中' : '低') : ''
  const oligoBadgeCls = oligo?.category === 'monomer'
    ? 'border-emerald-500/40 bg-emerald-500/[0.08] text-emerald-700 dark:text-emerald-400'
    : oligo?.category === 'hetero-complex'
      ? 'border-amber-500/40 bg-amber-500/[0.08] text-amber-700 dark:text-amber-400'
      : 'border-border bg-muted text-foreground/70'

  /** v1.26/v1.27：分子量增重策略（小分子量靶点）— 融入评分卡（不单独成章） */
  const mw = summary.mwAugment?.applicable ? summary.mwAugment : null
  const mwAdj = summary.scores?.mwAugmentAdjust ?? null
  const mwPathZh = mw?.assemblyPath === 'complex' ? '已有复合物结构' : mw?.assemblyPath === 'oligomer' ? '自身寡聚装配' : mw?.assemblyPath === 'homolog-complex' ? '同源复合物推断（BLAST）' : mw?.assemblyPath === 'partner' ? (mw.assemblyEvidence === 'complex' ? '互作伙伴推断（复合物结构支持）' : mw.assemblyEvidence === 'homolog' ? '互作伙伴推断（同源复合物结构支持）' : '互作伙伴推断') : '无生物装配路径'
  const mwHomologs = mw?.homologComplexes ?? []
  const mwIsHomologPath = mw?.assemblyPath === 'homolog-complex'
  const mwBadgeCls = mwIsHomologPath
    ? (mw?.assemblyKda != null && mw.assemblyKda >= 100
        ? 'border-teal-500/40 bg-teal-500/[0.08] text-teal-700 dark:text-teal-400'
        : 'border-amber-500/40 bg-amber-500/[0.08] text-amber-700 dark:text-amber-400')
    : mw?.assemblyKda != null && mw.assemblyKda >= 100
      ? 'border-emerald-500/40 bg-emerald-500/[0.08] text-emerald-700 dark:text-emerald-400'
      : mw?.assemblyKda != null && mw.assemblyKda >= 50
        ? 'border-amber-500/40 bg-amber-500/[0.08] text-amber-700 dark:text-amber-400'
        : 'border-border bg-muted text-foreground/70'
  const sizedPartners = mw?.partners.filter(p => p.kda != null) ?? []

  /** v1.30：互作复合物证据（无直接结构时）— 融入评分卡，不单独成章 */
  const itx = summary.interaction?.applicable && summary.interaction.hasEvidence ? summary.interaction : null
  const itxAdj = summary.scores?.interactionAdjust ?? null
  const itxBest = itx?.complexes[0]

  /** v2.18：LLM 智能复核（规则分之上的 AI 专家修正层 — 紫色系视觉与规则维度区分） */
  const llmA = summary.scores?.llmAdjust ?? null

  return (
    <div className="flex flex-col gap-8">
      {/* v2.36：缓存副本模式横幅（服务端实例已回收，本地副本回看） */}
      {job.fromCache && (
        <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/40 bg-amber-500/[0.07] px-3.5 py-2.5 text-[12.5px] text-amber-700 dark:text-amber-400">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p className="leading-relaxed">
            正在查看<b>浏览器本地缓存副本</b>：部署平台为 Serverless 实例，空闲回收后服务端运行数据不持久，该作业在服务端已不可用。
            「下载报告」将导出本地缓存的 Markdown 正文；完整 HTML 报告已在作业完成时自动下载到本机下载目录。
          </p>
        </div>
      )}

      {/* 0. 返回导航条 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button
          variant="outline"
          onClick={onNewEvaluation}
          className="h-9 gap-1.5 rounded-lg px-3 text-xs font-medium"
        >
          <ArrowLeft className="size-3.5" />
          新建评估
        </Button>
        {/* 当前靶点徽标：批量切换/同蛋白家族场景下让「正在看哪个靶点」一目了然；
            v2.16：序列靶点（无 UniProt）显示身份识别来源 */}
        <span className="inline-flex min-h-7 items-center gap-1.5 rounded-md border border-primary/30 bg-primary/[0.06] px-2.5 font-mono text-[11px] font-semibold text-primary">
          <Crosshair className="size-3 shrink-0" aria-hidden />
          {u.uniprotId ? `当前靶点 ${u.uniprotId}` : `序列靶点${summary.targetIdentity ? ` · ${summary.targetIdentity.sourceLabel}` : ''}`}
        </span>
        <span className="font-mono text-[11px] text-muted-foreground/85">
          作业 {job.id.slice(0, 8)} · 耗时 {formatDuration(Math.round((summary.durationMs ?? 0) / 1000))}
        </span>
      </div>

      {/* 1. 刊头 */}
      <motion.header
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: 'easeOut' }}
        className="flex flex-col gap-3"
      >
        <p className="lin-eyebrow text-primary">
          Evaluation Report · 评估结果
        </p>
        <h1 className="text-2xl leading-snug font-semibold tracking-[-0.02em] text-foreground sm:text-[28px]">
          {u.proteinName || u.entryName || u.uniprotId}
          {/* v2.31：聚合蛋白截短的 nsp 标注（如 P0DTD1 不同 nsp 构建 — 同名靶点可区分） */}
          {u.nspLabel && <span className="ml-1.5 font-mono text-[0.72em] font-semibold text-primary">{u.nspLabel}</span>}
        </h1>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 font-mono text-xs text-muted-foreground">
          {u.entryName && <span className="font-semibold">{u.entryName}</span>}
          {u.uniprotId ? (
            <a
              href={`https://www.uniprot.org/uniprotkb/${u.uniprotId}/entry`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-md border border-primary/30 bg-primary/[0.06] px-1.5 py-0.5 font-semibold text-primary transition-colors hover:bg-primary/[0.12]"
            >
              {u.uniprotId}
              <Database className="size-3" />
            </a>
          ) : summary.targetIdentity ? (
            /* v2.16：序列靶点身份徽标（评估表/nr 识别/同源推断 — 含近似 UniProt 条目时外链） */
            <span
              className="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-amber-50 px-1.5 py-0.5 font-semibold text-amber-700 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
              title={summary.targetIdentity.note ?? summary.targetIdentity.sourceLabel}
            >
              {summary.targetIdentity.sourceLabel}
              {summary.targetIdentity.identity != null ? ` ${Math.round(summary.targetIdentity.identity)}%` : ''}
              {summary.targetIdentity.uniprotId && (
                <a
                  href={`https://www.uniprot.org/uniprotkb/${summary.targetIdentity.uniprotId}`}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-0.5 inline-flex items-center gap-0.5 hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  {summary.targetIdentity.uniprotId}
                  <Database className="size-3" />
                </a>
              )}
            </span>
          ) : null}
          {(u.geneNames ?? []).slice(0, 6).map((g) => (
            <span key={g} className="rounded-md border border-border px-1.5 py-0.5">
              {g}
            </span>
          ))}
          <span className="font-sans text-muted-foreground/85">
            {u.organism || '未知物种'} · {u.sequenceLength?.toLocaleString?.() ?? '—'} aa
          </span>
        </div>
        {job.goal && (
          <p className="mt-1 max-w-3xl border-l-2 border-amber-400 pl-3 text-sm leading-relaxed text-foreground/80">
            <span className="lin-eyebrow mr-2 text-amber-600 dark:text-amber-500">客户目标</span>
            {job.goal}
          </p>
        )}
        {summary.construct && (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-muted-foreground">
            <span className="lin-eyebrow text-muted-foreground/85">客户构建</span>
            <span className="rounded-md border border-primary/30 bg-primary/[0.06] px-1.5 py-0.5 text-primary">
              {summary.construct.providedLength.toLocaleString()} aa
              {summary.construct.start != null && summary.construct.end != null
                ? ` · 全长 ${summary.construct.start}–${summary.construct.end} 位`
                : ` / 全长 ${summary.construct.fullLength.toLocaleString()} aa`}
            </span>
            <span className={summary.construct.sameTarget ? 'text-primary' : 'text-amber-600 dark:text-amber-500'}>
              一致性 {summary.construct.identity}%{summary.construct.sameTarget ? ' · 已合并为单次评估（构建边界分析）' : ' · 疑似不同靶点，按 UniProt 评估'}
            </span>
          </p>
        )}
      </motion.header>

      {/* 2. 规格格栅（hairline 网格） */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: 0.06, ease: 'easeOut' }}
        className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border studio-card sm:grid-cols-3 lg:grid-cols-6"
      >
        <SpecCell
          label="PDB 结构"
          value={String(summary.directPdbCount ?? pdbs.length)}
          sub={ms ? `${ms.xrayCount ?? 0} X-ray · ${ms.cryoemCount ?? 0} EM · ${ms.nmrCount ?? 0} NMR` : '直接关联'}
        />
        <SpecCell
          label="序列覆盖率"
          value={formatPercent(summary.coverage)}
          sub="PDBe 结构覆盖"
        />
        <SpecCell
          label="总体评分"
          value={scores?.overall ? Number(scores.overall.score.toFixed(1)).toString() : '—'}
          badge={scores?.overall ? <RatingBadge score={scores.overall.score} rating={scores.overall.rating} /> : undefined}
          sub="三方法综合"
        />
        <SpecCell
          label="文献证据"
          value={String(summary.literatureCount ?? literature.length)}
          sub="PubMed 检索"
        />
        <SpecCell
          label="BLAST 同源"
          value={String(summary.blastHitCount ?? blastHits.length)}
          sub={blastSub}
        />
        <SpecCell
          label="最佳分辨率"
          value={ms?.bestResolution != null ? formatResolution(ms.bestResolution).replace(' Å', '') : '—'}
          sub={ms?.bestResolution != null ? 'Å' : '暂无结构'}
        />
      </motion.div>

      {/* 3. 评估报告（v1.31：web 端内嵌与下载完全一致的 HTML — 单一数据源，杜绝样式分叉） */}
      {embedReport && (
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.12, ease: 'easeOut' }}
          className="flex flex-col gap-3"
        >
          <SectionHeader
            no={scoreNo}
            title="评估报告（完整版）"
            en="Full Report"
            count="与下载 HTML 同一文件 · 样式一致"
          />
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-primary/25 bg-primary/[0.05] px-4 py-3">
            <FileCheck2 className="size-4 shrink-0 text-primary" aria-hidden />
            <p className="min-w-0 flex-1 text-xs leading-relaxed text-foreground/80">
              下方内嵌<b className="mx-1 text-primary">与「下载 HTML」完全相同</b>的报告文件
              （评分 / 评估分析 / PDB 与互作复合物结构清单 / BLAST / 文献 / 实验数据全在其中），
              点击结构 ID、PMID 可直跳 RCSB / PubMed；折叠区可展开查看全量结构列表。
            </p>
            <div className="flex shrink-0 flex-wrap gap-1.5">
              <Button
                variant="outline"
                size="sm"
                onClick={openPreview}
                className="h-8 gap-1.5 rounded-lg bg-card px-2.5 font-mono text-[11px] transition-all hover:border-primary/40 active:scale-[0.98]"
              >
                <Eye className="size-3.5" />
                全屏预览
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => reportFrameRef.current?.contentWindow?.print()}
                className="h-8 gap-1.5 rounded-lg bg-card px-2.5 font-mono text-[11px] transition-all hover:border-primary/40 active:scale-[0.98]"
              >
                <Printer className="size-3.5" />
                打印
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => window.open(`/api/jobs/${job.id}/report`, '_blank')}
                className="h-8 gap-1.5 rounded-lg bg-card px-2.5 font-mono text-[11px] transition-all hover:border-primary/40 active:scale-[0.98]"
              >
                <ExternalLink className="size-3.5" />
                新窗口
              </Button>
              {/* v2.87：下载报告菜单（HTML / PDF 双格式 — 服务端报告提供 PDF） */}
              <ReportDownloadMenu
                size="sm"
                onDownloadHtml={downloadReport}
                pdfUrl={reportPdfUrl}
                pdfFallbackName={`TargetEval_${(job.uniprotId || job.id).replace(/[^\w-]/g, '_')}_${new Date().toISOString().slice(0, 10)}`}
              />
              {/* v2.51：报告 LLM 原地重跑（内嵌报告工具条主入口 — 正常路径恒可见） */}
              {canRegen && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setRegenOpen(true)}
                  disabled={regenerating}
                  title="沿用本作业既有数据（结构/同源/文献/评分不重收集），仅 LLM 分析章节重新生成（通常 1-3 分钟）"
                  className="h-8 gap-1.5 rounded-lg bg-card px-2.5 font-mono text-[11px] transition-all hover:border-primary/40 active:scale-[0.98]"
                >
                  <RefreshCw className={cn('size-3.5', regenerating && 'animate-spin')} aria-hidden />
                  {regenerating ? '重新生成中…' : '重新生成报告'}
                </Button>
              )}
            </div>
          </div>
          <ReportFrame jobId={job.id} iframeRef={reportFrameRef} onFail={() => setEmbedFailed(true)} reportHtml={inlineReportHtml} reloadNonce={reloadNonce} />
        </motion.section>
      )}

      {/* v2.51：重跑进行中横幅（分钟级 — 已等待时长 + 期间可继续查看当前版本；
          独立于 embed/降级视图，两条展示路径下均可见） */}
      {regenerating && (
        <div className="flex items-start gap-2.5 rounded-lg border border-primary/30 bg-primary/[0.06] px-3.5 py-2.5 text-xs leading-relaxed text-foreground/80">
          <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-primary" aria-hidden />
          <p>
            正在原地重新生成 LLM 报告章节（沿用既有数据，通常 1-3 分钟）· 已等待 {' '}
            <span className="font-mono tabular-nums">{Math.floor(regenElapsed / 60)}:{String(regenElapsed % 60).padStart(2, '0')}</span>。
            期间可继续查看当前版本，完成后在线展示与下载文件自动更新。
          </p>
        </div>
      )}

      {/* 3-9 旧版 React 数据区块：仅 deferred（并入合并报告）或内嵌报告不可用时降级展示 */}
      {!embedReport && <>
      {/* 3. 评分（v1.25：含聚集形式调整明细 — 寡聚态分析融入评分卡，不单独成章） */}
      <motion.section
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: 0.12, ease: 'easeOut' }}
        className="flex flex-col gap-3"
        aria-labelledby="sec-scores"
      >
        <div id="sec-scores">
          <SectionHeader
            no={scoreNo}
            title="方法学可行性评分"
            en="Feasibility Scores"
            count={scores ? `${Number(scores.overall.score.toFixed(1))}/10 综合${oligo ? ' · 含聚集形式调整' : ''}${llmA ? (llmA.applied ? ' · AI 复核微调' : ' · AI 复核确认') : ''}` : undefined}
          />
        </div>
        <Card className="gap-0 rounded-xl border-border bg-card studio-card">
          <CardContent className="flex flex-col gap-5 px-5 py-5">
            <div className="grid gap-5 sm:grid-cols-2">
              {scores && (
                <>
                  {scores.xray && <ScoreBar label="X-ray 结晶学" item={scores.xray} delay={0.05} delta={llmA?.xray ?? 0} />}
                  {scores.cryoem && <ScoreBar label="Cryo-EM 冷冻电镜" item={scores.cryoem} delay={0.15} delta={llmA?.cryoem ?? 0} />}
                  {scores.nmr && <ScoreBar label="NMR 核磁共振" item={scores.nmr} delay={0.25} delta={llmA?.nmr ?? 0} />}
                  {scores.overall && <ScoreBar label="总体可行性" item={scores.overall} delay={0.35} delta={llmA?.overall ?? 0} />}
                </>
              )}
            </div>
            {llmA && (
              <div className="flex flex-col gap-3 border-t border-dashed border-border pt-4">
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className="inline-flex min-h-7 items-center gap-1.5 rounded-md border border-violet-500/40 bg-violet-500/[0.08] px-2.5 text-xs font-semibold text-violet-700 dark:text-violet-400">
                    <Sparkles className="size-3.5 shrink-0" aria-hidden />
                    AI 复核
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {llmA.applied ? '已微调系统评分' : '复核确认维持系统评分'}
                    {llmA.applied && llmA.overall !== 0 ? `（总体 ${llmA.overall > 0 ? '+' : '−'}${Math.abs(llmA.overall)}）` : ''}
                  </span>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-[10px] tracking-wider text-muted-foreground/80">调整</span>
                    <AdjChip label="X-ray" v={llmA.xray} />
                    <AdjChip label="Cryo-EM" v={llmA.cryoem} />
                    <AdjChip label="NMR" v={llmA.nmr} />
                  </span>
                  <span className="font-mono text-[11px] text-muted-foreground/85">
                    置信度 {llmA.confidence === 'high' ? '高' : llmA.confidence === 'medium' ? '中' : '低'}
                    {llmA.engine ? ` · ${llmA.engine}` : ''} · {(llmA.durationMs / 1000).toFixed(1)}s
                  </span>
                </div>
                {(llmA.notes.xray || llmA.notes.cryoem || llmA.notes.nmr || llmA.notes.overall) && (
                  <ul className="grid gap-1.5 text-xs leading-6 text-muted-foreground sm:grid-cols-1">
                    {llmA.notes.xray && <li><b className="mr-1.5 font-semibold text-violet-700 dark:text-violet-400">X-ray</b>{llmA.notes.xray}</li>}
                    {llmA.notes.cryoem && <li><b className="mr-1.5 font-semibold text-violet-700 dark:text-violet-400">Cryo-EM</b>{llmA.notes.cryoem}</li>}
                    {llmA.notes.nmr && <li><b className="mr-1.5 font-semibold text-violet-700 dark:text-violet-400">NMR</b>{llmA.notes.nmr}</li>}
                    {llmA.notes.overall && <li><b className="mr-1.5 font-semibold text-violet-700 dark:text-violet-400">总体</b>{llmA.notes.overall}</li>}
                  </ul>
                )}
                <p className="text-xs leading-6 text-muted-foreground">
                  系统规则分先行计算，随后由 AI 专家基于同一证据链复核（调整幅度经服务端钳制 ±2 以内，已计入上述分值）；评分数值仅供参考，最终可行性需结合实验条件判断。
                </p>
              </div>
            )}
            {oligo && (
              <div className="flex flex-col gap-3 border-t border-dashed border-border pt-4">
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className={cn('inline-flex min-h-7 items-center rounded-md border px-2.5 text-xs font-semibold', oligoBadgeCls)}>
                    {oligoCatZh}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    聚集形式
                    <b className="mx-1 font-semibold text-foreground">{oligoLabel}</b>
                  </span>
                  {oligo.stoichiometry && (
                    <span className="rounded-md border border-border bg-muted/60 px-2.5 py-1 font-mono text-[11px] text-foreground/80">
                      {oligo.stoichiometry}
                    </span>
                  )}
                  <span className="font-mono text-[11px] text-muted-foreground/85">置信度 {oligoConfZh}</span>
                  {adj && (
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-[10px] tracking-wider text-muted-foreground/80">调整</span>
                      <AdjChip label="X-ray" v={adj.xray} />
                      <AdjChip label="Cryo-EM" v={adj.cryoem} />
                      <AdjChip label="NMR" v={adj.nmr} />
                    </span>
                  )}
                </div>
                {adj ? (
                  <p className="text-xs leading-6 text-muted-foreground">
                    {adj.note}（上述整数调整已计入三方法分数与综合评分；判定证据链见下方折叠）
                  </p>
                ) : (
                  <p className="text-xs leading-6 text-muted-foreground">{oligo.summary}</p>
                )}
                {oligo.evidence.length > 0 && (
                  <details className="group overflow-hidden rounded-lg border border-border">
                    <summary className="flex cursor-pointer select-none items-center gap-1.5 border-b border-border bg-muted/50 px-3.5 py-2 text-[11px] font-medium text-primary list-none transition-colors hover:bg-muted [&::-webkit-details-marker]:hidden">
                      <ChevronDown className="size-3.5 shrink-0 transition-transform duration-200 group-open:rotate-180" aria-hidden />
                      聚集形式判定证据链 · {oligo.evidence.length} 条（按优先级：已有结构 → 同源结构 → UniProt interaction → 文献）
                    </summary>
                    <ul className="divide-y divide-border/60">
                      {oligo.evidence.map((e, i) => (
                        <li key={`${e.ref}-${i}`} className="flex flex-col gap-1 px-3.5 py-2.5 sm:flex-row sm:items-baseline sm:gap-3">
                          <span className="w-36 shrink-0 text-[11px] font-medium text-primary">
                            {e.source === 'pdb-title' ? '已有结构 · 标题' : e.source === 'pdb-stoichiometry' ? '已有结构 · 链化学计量' : e.source === 'blast-title' ? '同源结构 · 标题（推断）' : e.source === 'uniprot-subunit' ? 'UniProt · 亚基注释' : e.source === 'uniprot-interaction' ? 'UniProt · 相互作用' : '文献标题'}
                          </span>
                          <span className="w-24 shrink-0 font-mono text-[11px] text-muted-foreground">{e.ref}</span>
                          <span className="min-w-0 flex-1 text-xs leading-relaxed text-foreground/80">{e.text}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
            {mw && (
              <div className="flex flex-col gap-3 border-t border-dashed border-border pt-4">
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className={cn('inline-flex min-h-7 items-center rounded-md border px-2.5 text-xs font-semibold', mwBadgeCls)}>
                    小分子量靶点
                  </span>
                  <span className="text-xs text-muted-foreground">
                    分子量
                    <b className="mx-1 font-semibold text-foreground">
                      单体 ~{mw.monomerKda} kDa{mw.assemblyKda != null ? ` → 装配 ~${mw.assemblyKda} kDa${mwIsHomologPath ? '（同源推断）' : ''}` : ''}
                    </b>
                  </span>
                  <span className="rounded-md border border-border bg-muted/60 px-2.5 py-1 font-mono text-[11px] text-foreground/80">
                    {mwPathZh}
                  </span>
                  {mwAdj && (
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-[10px] tracking-wider text-muted-foreground/80">调整</span>
                      <AdjChip label="X-ray" v={mwAdj.xray} />
                      <AdjChip label="Cryo-EM" v={mwAdj.cryoem} />
                      <AdjChip label="NMR" v={mwAdj.nmr} />
                    </span>
                  )}
                </div>
                {mwAdj ? (
                  <p className="text-xs leading-6 text-muted-foreground">
                    {mwAdj.note}（分子量调整已计入 Cryo-EM 分数与综合评分；X-ray/NMR 不受增重影响{mw.assemblyKda != null ? '；装配分子量已知时，聚集形式的 Cryo-EM 分量并入本维度计分（避免双重加分）' : ''}）
                  </p>
                ) : (
                  <p className="text-xs leading-6 text-muted-foreground">{mw.zoneNote}</p>
                )}
                {mw.homologSearchNote && (
                  <p className="rounded-lg border border-teal-500/30 bg-teal-500/[0.06] px-3 py-2 text-xs leading-6 text-teal-700 dark:text-teal-300">
                    {mw.homologSearchNote}
                  </p>
                )}
                {(mw.complexes.length > 0 || mwHomologs.length > 0 || sizedPartners.length > 0 || mw.conflicts.length > 0) && (
                  <details className="group overflow-hidden rounded-lg border border-border">
                    <summary className="flex cursor-pointer select-none items-center gap-1.5 border-b border-border bg-muted/50 px-3.5 py-2 text-[11px] font-medium text-primary list-none transition-colors hover:bg-muted [&::-webkit-details-marker]:hidden">
                      <ChevronDown className="size-3.5 shrink-0 transition-transform duration-200 group-open:rotate-180" aria-hidden />
                      增重路径明细 · 复合物结构 {mw.complexes.length} · 同源复合物 {mwHomologs.length} · 互作伙伴 {sizedPartners.length} · 目的比对 {mw.conflicts.length} 条
                    </summary>
                    <div className="flex flex-col gap-4 px-3.5 py-3.5">
                      {mw.complexes.length > 0 && (
                        <div className="flex flex-col gap-2">
                          <p className="text-[11px] font-semibold text-foreground/90">已有复合物结构 — 组分总分子量统计</p>
                          <ul className="divide-y divide-border/60">
                            {mw.complexes.map(c => (
                              <li key={c.pdbId} className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-baseline sm:gap-3">
                                <a
                                  href={`https://www.rcsb.org/structure/${c.pdbId}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="w-20 shrink-0 font-mono text-[11px] font-semibold text-primary hover:underline"
                                >
                                  {c.pdbId}
                                </a>
                                <span className="min-w-0 flex-1 text-xs leading-relaxed text-foreground/80">
                                  {c.components.map(x => (
                                    <span
                                      key={`${c.pdbId}-${x.name}-${x.kda}`}
                                      className={cn(
                                        'mr-1.5 inline-block rounded-sm border px-1.5 py-0.5 text-[11px]',
                                        x.isTarget
                                          ? 'border-primary/30 bg-primary/[0.06] text-primary'
                                          : 'border-amber-500/30 bg-amber-500/[0.07] text-amber-700 dark:text-amber-400',
                                      )}
                                    >
                                      {x.isTarget ? '靶点' : x.name.slice(0, 36)} ~{x.kda} kDa
                                    </span>
                                  ))}
                                  <b className="ml-1 text-foreground">= 装配 ~{c.totalKda} kDa</b>
                                  <span className="mt-0.5 block font-mono text-[10.5px] text-muted-foreground/80">{c.note}</span>
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {mwHomologs.length > 0 && (
                        <div className="flex flex-col gap-2">
                          <p className="text-[11px] font-semibold text-foreground/90">
                            同源结构形成的大复合物（BLAST 扩展检索）— 直接装配路径不足 50 kDa 时检索；同源亚基按靶点单体换算
                          </p>
                          <ul className="divide-y divide-border/60">
                            {mwHomologs.map(h => (
                              <li key={h.pdbId} className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-baseline sm:gap-3">
                                <a
                                  href={`https://www.rcsb.org/structure/${h.pdbId}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="w-20 shrink-0 font-mono text-[11px] font-semibold text-teal-700 hover:underline dark:text-teal-400"
                                >
                                  {h.pdbId}
                                </a>
                                <span className="w-14 shrink-0 font-mono text-[11px] font-bold text-teal-700 dark:text-teal-400">
                                  {Math.round(h.identity)}%
                                </span>
                                <span className="min-w-0 flex-1 text-xs leading-relaxed text-foreground/80">
                                  {h.componentSummary}
                                  <b className="ml-1 text-foreground">
                                    = 同源装配 ~{h.totalKda} kDa → 靶点换算 ~{h.estimatedKda} kDa
                                  </b>
                                  <span className="mt-0.5 block font-mono text-[10.5px] text-muted-foreground/80">{h.note}</span>
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {sizedPartners.length > 0 && (
                        <div className="flex flex-col gap-1.5">
                          <p className="text-[11px] font-semibold text-foreground/90">UniProt 互作伙伴（按 1:1 估计；可信度分级 — 仅复合物/同源复合物结构证据支持者计入装配估计，其余仅作参考并警示）</p>
                          <ul className="flex flex-col gap-1">
                            {sizedPartners.slice(0, 8).map(p => (
                              <li key={`mwp-${p.accession}`} className="text-xs leading-6 text-foreground/80">
                                <b className="text-foreground">{p.geneName ?? p.proteinName ?? p.accession}</b>
                                <span className="mx-1.5 font-mono text-[10.5px] text-muted-foreground/85">{p.accession}</span>
                                <span className="mr-1.5 font-mono text-[11px]">{p.lengthAa} aa ~{p.kda} kDa</span>
                                <span
                                  className={cn(
                                    'mr-1.5 inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] font-bold',
                                    p.evidenceLevel === 'complex'
                                      ? 'border-emerald-500/30 bg-emerald-500/[0.08] text-emerald-700 dark:text-emerald-400'
                                      : p.evidenceLevel === 'homolog'
                                        ? 'border-teal-500/30 bg-teal-500/[0.08] text-teal-700 dark:text-teal-400'
                                        : 'border-amber-500/30 bg-amber-500/[0.08] text-amber-700 dark:text-amber-400',
                                  )}
                                >
                                  {p.evidenceLevel === 'complex' ? '复合物结构' : p.evidenceLevel === 'homolog' ? '同源复合物结构' : '仅实验证据'}
                                </span>
                                {p.evidencePdbIds?.length
                                  ? <span className="font-mono text-[10.5px] text-muted-foreground/85">证据：{p.evidencePdbIds.join('、')}</span>
                                  : (p.evidenceLevel === 'complex' || p.evidenceLevel === 'homolog')
                                    ? null
                                    : <span className="text-amber-700 dark:text-amber-400">无结构证据支持，未计入装配估计 — 不可据此认定可用于 Cryo-EM 增重</span>}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      <div className="flex flex-col gap-1.5">
                        <p className="text-[11px] font-semibold text-foreground/90">技术增重工具箱</p>
                        <ul className="flex flex-col gap-1.5">
                          {mw.options.map(o => (
                            <li key={o.name} className="text-xs leading-6 text-foreground/80">
                              <b className="text-foreground">{o.name}</b>
                              <span className="mx-1.5 font-mono text-[10.5px] text-primary">{o.addKda}</span>
                              — {o.note}
                            </li>
                          ))}
                        </ul>
                      </div>
                      {mw.conflicts.length > 0 && (
                        <div className="flex flex-col gap-1.5">
                          <p className="text-[11px] font-semibold text-foreground/90">与客户目的的比对（加入的蛋白是否与目的冲突）</p>
                          <ul className="flex flex-col gap-1.5">
                            {mw.conflicts.map((c, i) => (
                              <li key={`conflict-${i}`} className="flex items-baseline gap-2 text-xs leading-6 text-foreground/80">
                                <span
                                  className={cn(
                                    'inline-flex shrink-0 items-center rounded-sm border px-1.5 py-0.5 font-mono text-[10px] font-bold',
                                    c.level === 'aligned'
                                      ? 'border-emerald-500/30 bg-emerald-500/[0.08] text-emerald-700 dark:text-emerald-400'
                                      : c.level === 'caution'
                                        ? 'border-amber-500/30 bg-amber-500/[0.08] text-amber-700 dark:text-amber-400'
                                        : 'border-red-500/30 bg-red-500/[0.08] text-red-700 dark:text-red-400',
                                  )}
                                >
                                  {c.level === 'aligned' ? '契合' : c.level === 'caution' ? '需注意' : '冲突'}
                                </span>
                                <span className="min-w-0 flex-1">{c.text}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  </details>
                )}
              </div>
            )}
            {itx && (
              <div className="flex flex-col gap-3 border-t border-dashed border-border pt-4">
                <div className="flex flex-wrap items-center gap-2.5">
                  <span
                    className={cn(
                      'inline-flex min-h-7 items-center rounded-md border px-2.5 text-xs font-semibold',
                      itxAdj?.level === 'curated'
                        ? 'border-teal-500/40 bg-teal-500/[0.08] text-teal-700 dark:text-teal-400'
                        : 'border-amber-500/40 bg-amber-500/[0.08] text-amber-700 dark:text-amber-400',
                    )}
                  >
                    {itxAdj?.level === 'curated' ? 'Complex Portal' : 'IntAct 互作'}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    互作证据
                    <b className="mx-1 font-semibold text-foreground">
                      {itxBest ? `${itxBest.complexAc}${itxBest.assembly ? ` · ${itxBest.assembly}` : ''}` : 'binary 伙伴'}
                    </b>
                  </span>
                  {itxAdj && (
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-[10px] tracking-wider text-muted-foreground/80">调整</span>
                      <AdjChip label="X-ray" v={itxAdj.xray} />
                      <AdjChip label="Cryo-EM" v={itxAdj.cryoem} />
                      <AdjChip label="NMR" v={itxAdj.nmr} />
                    </span>
                  )}
                </div>
                <p className="text-xs leading-6 text-muted-foreground">
                  {itx.summary}
                  {itxAdj && '（上述调整已计入对应方法分数与综合评分；curated 复合物接管 Cryo-EM 分子量分量时，分子量增重与聚集形式维度的 Cryo-EM 分量不再重复计分）'}
                  {itx.complexes.length > 0 && ' — 组分结构清单（共有结构/单独结构分类）见下方「PDB 结构清单」章节。'}
                </p>
                {itx.notes.length > 0 && (
                  <details className="group overflow-hidden rounded-lg border border-border">
                    <summary className="flex cursor-pointer select-none items-center gap-1.5 border-b border-border bg-muted/50 px-3.5 py-2 text-[11px] font-medium text-primary list-none transition-colors hover:bg-muted [&::-webkit-details-marker]:hidden">
                      <ChevronDown className="size-3.5 shrink-0 transition-transform duration-200 group-open:rotate-180" aria-hidden />
                      互作证据要点与策略影响 · {itx.notes.length} 条
                    </summary>
                    <ul className="divide-y divide-border/60">
                      {itx.notes.map((n, i) => (
                        <li key={`itx-note-${i}`} className="px-3.5 py-2.5 text-xs leading-relaxed text-foreground/80">{n}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </motion.section>

      {/* 4. 报告操作条 */}
      <motion.section
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: 0.18, ease: 'easeOut' }}
        className={cn(
          'flex flex-col gap-4 rounded-xl border px-5 py-4 sm:flex-row sm:items-center',
          reportDeferred
            ? 'border-violet-500/30 bg-violet-500/[0.06]'
            : reportLlmFailed
              ? 'border-amber-500/30 bg-amber-500/[0.06]'
              : 'border-primary/25 bg-primary/[0.05]'
        )}
      >
        <div className="flex items-center gap-3">
          <div className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-lg text-primary-foreground shadow-[0_2px_8px_-2px_rgb(22_23_29/0.18)]',
            reportDeferred ? 'bg-violet-600 dark:bg-violet-700' : reportLlmFailed ? 'bg-amber-600 dark:bg-amber-700' : 'bg-gradient-to-br from-[#5e6ad2] to-[#7a5ce4]'
          )}>
            {reportDeferred ? <Layers className="size-4.5" /> : reportLlmFailed ? <AlertTriangle className="size-4.5" /> : <FileCheck2 className="size-4.5" />}
          </div>
          <div>
            <div className="text-sm font-semibold text-foreground">
              {reportDeferred ? '分析已并入合并评估报告' : reportLlmFailed ? '报告生成（LLM 部分失败）' : '评估报告已生成'}
            </div>
            <div className="font-mono text-[11px] text-muted-foreground">
              {reportDeferred
                ? `关联靶点批次 · 数据收集 ${formatDuration(Math.round((summary.durationMs ?? 0) / 1000))} · 合并报告见上方切换栏`
                : `HTML · ${formatDuration(Math.round((summary.durationMs ?? 0) / 1000))} · 可独立下载分享`}
            </div>
          </div>
        </div>
        {!reportDeferred && (
          <div className="flex flex-wrap gap-2 sm:ml-auto">
            <Button
              onClick={openPreview}
              className="btn-brand h-10 gap-2 rounded-lg px-4 font-medium text-primary-foreground"
            >
              <Eye className="size-4" />
              在线预览报告
            </Button>
            {/* v2.87：下载报告菜单（HTML / PDF 双格式） */}
            <ReportDownloadMenu
              size="default"
              onDownloadHtml={downloadReport}
              pdfUrl={reportPdfUrl}
              pdfFallbackName={`TargetEval_${(job.uniprotId || job.id).replace(/[^\w-]/g, '_')}_${new Date().toISOString().slice(0, 10)}`}
            />
            {canRegen && (
              <Button
                variant="outline"
                onClick={() => setRegenOpen(true)}
                disabled={regenerating}
                title="沿用本作业既有数据（结构/同源/文献/评分不重收集），仅 LLM 分析章节重新生成（通常 1-3 分钟）"
                className="h-10 gap-2 rounded-lg bg-card px-4 transition-all hover:border-primary/40 active:scale-[0.98]"
              >
                <RefreshCw className={cn('size-4', regenerating && 'animate-spin')} aria-hidden />
                {regenerating ? '重新生成中…' : '重新生成报告'}
              </Button>
            )}
          </div>
        )}
      </motion.section>

      {/* 5. AI 评估报告（LLM 分析全文内联展示） */}
      <motion.section
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: 0.21, ease: 'easeOut' }}
        className="flex flex-col gap-3"
        aria-labelledby="sec-report"
      >
        <div id="sec-report">
          <SectionHeader
            no={reportNo}
            title="AI 评估报告"
            en="LLM Analysis"
            count={!reportDeferred && reportMd ? `${reportMd.length.toLocaleString()} 字` : undefined}
          />
        </div>
        {reportLlmFailed && (
          <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-3.5 py-2.5 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            LLM 报告生成失败或部分失败{reportMissing > 0 ? `（${reportMissing} 个章节未生成）` : ''}，以下可能仅包含成功生成的章节；结构化数据区块（评分 / PDB / 文献）不受影响{canRegen ? '，可点击上方「重新生成报告」补齐缺失章节' : '，可重新评估以重试报告生成'}。
          </div>
        )}
        {reportDeferred ? (
          <Card className="rounded-xl border-violet-500/30 bg-card studio-card">
            <CardContent className="flex flex-col items-center gap-2.5 px-6 py-8 text-center">
              <Layers className="size-5 text-violet-500 dark:text-violet-400" aria-hidden />
              <p className="text-sm text-foreground/80">
                本靶点与批次内其他靶点经分析判定为<span className="font-semibold text-violet-600 dark:text-violet-400">关联靶点</span>，
                已按单靶点流程生成完整独立评估报告，展示于合并报告的该靶点单独评估页（与单独评估同格式：评估分析 / 可行性评分 / PDB 结构与文献全量展开 / 同源 / 客户实验数据）
              </p>
              <p className="text-xs text-muted-foreground/85">
                下方数据区块（评分 / PDB / BLAST / 文献）为该靶点的独立数据；合并报告可经上方切换栏查看
              </p>
            </CardContent>
          </Card>
        ) : reportMd ? (
          <Card className="rounded-xl border-border bg-card studio-card">
            <CardContent className="px-5 py-5 sm:px-7 sm:py-6">
              <div className="mb-4 flex items-center gap-2 text-muted-foreground/85">
                <BookOpenText className="size-3.5" aria-hidden />
                <span className="lin-eyebrow">Analysis · 由大语言模型基于下方结构化数据生成，结论供参考</span>
              </div>
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                {reportMd}
              </ReactMarkdown>
            </CardContent>
          </Card>
        ) : (
          <Card className="rounded-xl border-border bg-card studio-card">
            <CardContent className="flex flex-col items-center gap-2.5 px-6 py-8 text-center">
              <BookOpenText className="size-5 text-muted-foreground/40" aria-hidden />
              <p className="text-sm text-muted-foreground">
                该作业未内联保存报告文本（历史版本作业）
              </p>
              <p className="text-xs text-muted-foreground/85">
                可点击上方「在线预览报告」或「下载 HTML」查看完整报告
              </p>
            </CardContent>
          </Card>
        )}
      </motion.section>

      {/* 6. 实验数据（胶图/SEC） */}
      {assets.length > 0 && (
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.22, ease: 'easeOut' }}
          className="flex flex-col gap-3"
        >
          <SectionHeader no={assetsNo!} title="客户实验数据" en="Assay Images" count={`${assets.length} 张`} />
          <AssetGallery assets={assets} />
        </motion.section>
      )}

      {/* 7. PDB 结构表（v1.30：无直接结构且有互作证据时，展示互作复合物组分结构清单 — 与 HTML 报告一致） */}
      <motion.section
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: 0.26, ease: 'easeOut' }}
        className="flex flex-col gap-3"
      >
        <SectionHeader
          no={pdbNo}
          title="PDB 结构清单"
          en="Structures"
          count={
            pdbs.length > 0
              ? `${pdbs.length} 个${outsidePdbs.length > 0 ? ` · 范围外 ${outsidePdbs.length}` : ''}`
              : itx
                ? `直接结构 0 · 互作组分证据${itxBest?.sharedPdbTotal ? `（共有 ${itxBest.sharedPdbTotal}）` : ''}`
                : '0 个'
          }
        />
        {rangeInfo && (
          <div className="flex items-start gap-2.5 rounded-xl border border-emerald-500/30 bg-emerald-500/[0.06] px-4 py-3 text-xs leading-relaxed text-emerald-800 dark:text-emerald-300">
            <Ruler className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
            <span>
              <b>评估区间 {rangeInfo[0]}-{rangeInfo[1]}</b>
              （{summary.rangeSource === '结构域匹配（UniProt 注释）'
                ? '评估表结构域名 → UniProt domain 匹配'
                : summary.rangeSource === '构建比对推导'
                  ? '截短构建比对推导'
                  : summary.rangeSource === 'BLAST nr 比对推导'
                    ? 'BLAST 比对推导（提交序列在 UniProt 条目内的覆盖区间）'
                    : '手动指定'}）—
              结构列表按「链范围与区间重叠优先」展示{outsidePdbs.length + outsideBlastHits.length > 0
                ? `；无重叠的结构已折叠保留在下方（灰色行：PDB ${outsidePdbs.length} 条${outsideBlastHits.length ? ` · 同源 ${outsideBlastHits.length} 条` : ''}）`
                : '；当前全部结构均与区间重叠'}。
            </span>
          </div>
        )}
        {itx && pdbs.length === 0 && (
          <div className="flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] px-4 py-3.5 text-xs leading-relaxed text-amber-800 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
            <span>
              <b>暂无直接关联的 PDB 结构 — 全新结构靶点。</b>
              该靶点在 RCSB 无直接关联结构条目，但存在互作复合物证据 — 下方列出其复合物其他组分的结构清单
              （共有结构突出显示、单独结构默认折叠），作为组装路线与构建边界设计的评估依据。
            </span>
          </div>
        )}
        {itx && pdbs.length === 0 && <InteractionStructures itx={itx} />}
        <PdbTable pdbs={pdbs} ligandCount={summary.ligandCount} literature={literature} outsidePdbs={outsidePdbs} rangeLabel={rangeLabel} />
      </motion.section>

      {/* 7.5 配体研究数据（v2.0：非标准输入归一 + 含该配体结构） */}
      {ligands.length > 0 && (
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.28, ease: 'easeOut' }}
          className="flex flex-col gap-3"
        >
          <div id="sec-ligands">
            <SectionHeader
              no={ligandNo!}
              title="配体研究数据"
              en="Ligand Research"
              count={`${ligands.filter(l => l.ok).length}/${ligands.length} 识别`}
            />
          </div>
          <div className="grid gap-3.5 md:grid-cols-2">
            {ligands.map(l => !l.ok ? (
              <Card key={`${l.raw}-fail`} className="gap-0 rounded-xl border-dashed border-amber-500/40 bg-amber-500/[0.04] studio-card">
                <CardContent className="flex flex-col gap-1.5 px-4.5 py-4">
                  <div className="text-sm font-semibold text-foreground">{l.raw.length > 44 ? l.raw.slice(0, 43) + '…' : l.raw}</div>
                  <p className="text-xs text-amber-600 dark:text-amber-400">未能归一 — {l.error ?? '未知原因'}</p>
                </CardContent>
              </Card>
            ) : !l.compId ? (
              /* v2.2：PubChem 已识别但 PDB 无对应组分（如 Resmetirom）→ CID 详情卡（v2.7 + 结构式/性质） */
              <Card key={`${l.raw}-pc`} className="gap-0 overflow-hidden rounded-xl border-border bg-card studio-card">
                <CardContent className="flex gap-3.5 px-4.5 py-4">
                  {l.detail?.structure2d && (
                    /* v2.7.5：缩略图点击放大（Dialog 预览 + 原始分辨率） */
                    <Ligand2dFigure src={l.detail.structure2d} cid={l.detail.cid} name={l.name || l.raw} />
                  )}
                  <div className="flex min-w-0 flex-1 flex-col gap-3">
                  <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                    {l.pubchem ? (
                      <a
                        href={`https://pubchem.ncbi.nlm.nih.gov/compound/${l.pubchem.cid}`}
                        target="_blank"
                        rel="noopener"
                        title="在 PubChem 查看化合物详情"
                        className="inline-flex min-h-7 items-center rounded-md border border-violet-500/30 bg-violet-500/[0.08] px-2.5 font-mono text-sm font-bold tracking-wide text-violet-600 transition-colors hover:bg-violet-500/[0.16] dark:text-violet-400"
                      >
                        CID {l.pubchem.cid}
                      </a>
                    ) : (
                      <span className="inline-flex min-h-7 items-center rounded-md border border-violet-500/30 bg-violet-500/[0.08] px-2.5 font-mono text-sm font-bold tracking-wide text-violet-600 dark:text-violet-400">已识别</span>
                    )}
                    <span className="min-w-0 flex-1 text-sm font-semibold text-foreground">{l.name || l.raw}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>分子式 <b className="font-mono text-foreground/80">{l.formula || '—'}</b></span>
                    {l.weight != null && <span>MW <b className="font-mono text-foreground/80">{l.weight.toFixed(1)}</b></span>}
                  </div>
                  <LigandPropsRow d={l.detail} />
                  {(l.detail?.iupacName ?? l.pubchem?.iupacName) && (
                    <p className="text-[11px] leading-relaxed break-all text-muted-foreground/85">
                      IUPAC 名 <span className="font-mono">{l.detail?.iupacName ?? l.pubchem?.iupacName}</span>
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground/85">
                    PDB 化学组分库无对应条目 — 已通过 PubChem 识别{ l.pubchem && <>，点击 <span className="font-mono">CID {l.pubchem.cid}</span> 查看化合物详情</> }
                  </p>
                  <p className="border-t border-dashed border-border pt-2.5 font-mono text-[10px] tracking-wide text-muted-foreground/80">
                    输入「{l.raw.length > 30 ? l.raw.slice(0, 29) + '…' : l.raw}」· 归一 {l.strategy || '—'}{l.source === 'eval-table' ? ' · 评估表识别' : l.source === 'file' ? ` · 文件 ${l.fileName ?? ''}` : ''}
                  </p>
                  </div>
                </CardContent>
              </Card>
            ) : (
              <Card key={`${l.raw}-ok`} className="gap-0 overflow-hidden rounded-xl border-border bg-card studio-card">
                <CardContent className="flex gap-3.5 px-4.5 py-4">
                  {l.detail?.structure2d && (
                    /* v2.7.5：缩略图点击放大（Dialog 预览 + 原始分辨率） */
                    <Ligand2dFigure src={l.detail.structure2d} cid={l.detail.cid} name={l.name || l.raw} />
                  )}
                  <div className="flex min-w-0 flex-1 flex-col gap-3">
                  <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                    <span className="inline-flex min-h-7 items-center rounded-md border border-primary/30 bg-primary/[0.06] px-2.5 font-mono text-sm font-bold tracking-wide text-primary">{l.compId}</span>
                    <span className="min-w-0 flex-1 text-sm font-semibold text-foreground">{l.name || l.raw}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>分子式 <b className="font-mono text-foreground/80">{l.formula || '—'}</b></span>
                    {l.weight != null && <span>MW <b className="font-mono text-foreground/80">{l.weight.toFixed(1)}</b></span>}
                    <span>含该配体结构 <b className="font-mono text-foreground/80">{l.totalStructures}</b> 个</span>
                  </div>
                  <LigandPropsRow d={l.detail} />
                  {l.structures.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {l.structures.slice(0, 12).map(s => (
                        <a
                          key={s.pdbId}
                          href={`https://www.rcsb.org/structure/${s.pdbId}`}
                          target="_blank"
                          rel="noopener"
                          title={`${s.title}${s.resolution != null ? ` · ${s.resolution}Å` : ''}${s.method ? ` · ${s.method}` : ''}${s.alsoTarget ? ' · 本靶点直接结构' : ''}`}
                          className={cn(
                            'inline-flex min-h-7 items-center rounded-md border px-2 font-mono text-[11px] font-semibold transition-colors',
                            s.alsoTarget
                              ? 'border-primary/40 bg-primary/[0.08] text-primary hover:bg-primary/[0.14]'
                              : 'border-border bg-muted/60 text-foreground/80 hover:border-primary/40 hover:text-primary',
                          )}
                        >
                          {s.pdbId}{s.resolution != null && <span className="ml-1.5 font-normal text-muted-foreground/85">{s.resolution.toFixed(1)}</span>}
                          {s.alsoTarget && <span className="ml-1 text-primary">★</span>}
                        </a>
                      ))}
                      {l.totalStructures > 12 && (
                        <span className="inline-flex min-h-7 items-center px-1 font-mono text-[11px] text-muted-foreground/80">+{l.totalStructures - 12}</span>
                      )}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground/85">暂无含该配体的 PDB 结构记录</p>
                  )}
                  <p className="border-t border-dashed border-border pt-2.5 font-mono text-[10px] tracking-wide text-muted-foreground/80">
                    输入「{l.raw.length > 30 ? l.raw.slice(0, 29) + '…' : l.raw}」· 归一 {l.strategy || '—'}{l.source === 'eval-table' ? ' · 评估表识别' : l.source === 'file' ? ` · 文件 ${l.fileName ?? ''}` : ''}{l.detail?.inchiKey ? ` · InChIKey ${l.detail.inchiKey}` : ''}
                  </p>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </motion.section>
      )}

      {/* 8. BLAST 同源表（0 命中/跳过/失败时展示状态说明，不再凭空消失） */}
      <motion.section
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: 0.3, ease: 'easeOut' }}
        className="flex flex-col gap-3"
      >
        <SectionHeader
          no={blastNo}
          title="BLAST 同源结构"
          en="Homologs"
          count={
            blastHits.length > 0
              ? `${blastHits.length} 条命中${blastShared ? ' · 家族共享' : ''}${blastViaRcsb ? ' · RCSB 兜底' : ''}${nrHits.length ? ` · nr ${nrHits.length}` : ''}`
              : nrHits.length > 0
                ? `nr ${nrHits.length} 命中`
                : blastInfo
                  ? '未运行'
                  : '—'
          }
        />
        {blastViaRcsb && blastHits.length > 0 && (
          <div className="flex items-start gap-2.5 rounded-lg border border-primary/25 bg-primary/[0.05] px-3.5 py-2.5 text-xs leading-relaxed text-primary dark:text-primary">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {describeBlastStatus(blastInfo)} — NCBI BLAST 队列拥堵/故障时自动改用 RCSB 序列检索（mmseqs2）获得等效同源结构，命中含一致性/E 值/覆盖度，可信度与 BLAST 同源结构相当。
          </div>
        )}
        {blastHits.length > 0 ? (
          <BlastTable hits={blastHits} outsideHits={outsideBlastHits} rangeLabel={rangeLabel} />
        ) : (
          <BlastStatusBox status={blastInfo?.status} note={blastInfo?.note} provider={blastInfo?.provider} />
        )}
        {/* v2.59：nr 全库检索命中（靶点身份识别证据 — 前 5 条直出 + 折叠） */}
        {nrHits.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
          >
            <BlastNrTable hits={nrHits} />
          </motion.div>
        )}
        {/* v2.82：EBI UniProt 库序列匹配命中（身份级联 v2.44 通道 — 检索证据展示） */}
        {(summary.uniprotBlastHits?.length ?? 0) > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
          >
            <BlastNrTable hits={summary.uniprotBlastHits!} variant="uniprot" />
          </motion.div>
        )}
      </motion.section>

      {/* 9. 文献列表 */}
      {literature.length > 0 && (
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.34, ease: 'easeOut' }}
          className="flex flex-col gap-3"
        >
          <SectionHeader no={litNo!} title="相关文献" en="References" count={`${literature.length} 篇`} />
          <LiteratureList items={literature} pdbs={pdbs} />
        </motion.section>
      )}

      {/* 10. 运行日志（v2.21：完成后可回看 — 此前结果页完全没有日志入口，排查只能重跑） */}
      {logNo && (
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.36, ease: 'easeOut' }}
          className="flex flex-col gap-3"
        >
          <SectionHeader
            no={logNo}
            title="运行日志"
            en="Run Logs"
            count={
              logWarn + logErr > 0
                ? `${logLines.length} 行 · ${logWarn} 警告 · ${logErr} 错误`
                : `${logLines.length} 行`
            }
          />
          <EvalLogConsole logs={logLines} live={false} />
        </motion.section>
      )}
      </>}

      {/* 底部操作 */}
      <div className="flex justify-center border-t border-border pt-6">
        <Button
          variant="outline"
          onClick={onNewEvaluation}
          className="h-10 gap-2 rounded-lg px-6 transition-all hover:border-primary/40 active:scale-[0.98]"
        >
          <RotateCcw className="size-4" />
          返回新评估
        </Button>
      </div>

      {/* 报告在线预览（大窗口 iframe + 加载态 + 新窗口/打印） */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent
          showCloseButton
          className="flex h-[88vh] w-[calc(100vw-2rem)] max-w-6xl flex-col gap-0 overflow-hidden rounded-xl p-0 sm:w-full xl:max-w-[1280px] 2xl:max-w-[1560px]"
        >
          <DialogHeader className="flex-row items-center justify-between gap-4 border-b border-border px-5 py-3 pr-14 text-left">
            <div className="flex flex-col gap-0.5">
              <DialogTitle className="flex items-center gap-2 text-base font-semibold tracking-[-0.01em]">
                评估报告 · {u.proteinName || u.uniprotId}{u.nspLabel ? ` ${u.nspLabel}` : ''}
              </DialogTitle>
              <DialogDescription className="font-mono text-[11px] text-muted-foreground/85">
                完整 HTML 报告 · 可直接打印
              </DialogDescription>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                variant="outline"
                size="sm"
                onClick={() => iframeRef.current?.contentWindow?.print()}
                className="h-8 gap-1.5 rounded-lg bg-card px-2.5 font-mono text-[11px] transition-all hover:border-primary/40 active:scale-[0.98]"
              >
                <Printer className="size-3.5" />
                打印
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => window.open(`/api/jobs/${job.id}/report`, '_blank')}
                className="h-8 gap-1.5 rounded-lg bg-card px-2.5 font-mono text-[11px] transition-all hover:border-primary/40 active:scale-[0.98]"
              >
                <ExternalLink className="size-3.5" />
                新窗口
              </Button>
            </div>
          </DialogHeader>
          <div className="relative min-h-0 flex-1">
            {!previewLoaded && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-card">
                <Loader2 className="size-6 animate-spin text-primary" />
                {previewSlow ? (
                  <div className="flex max-w-xs flex-col items-center gap-3 px-4 text-center">
                    <p className="text-xs text-muted-foreground">
                      报告加载较慢（含内嵌图片时体积较大），也可选择其他方式查看：
                    </p>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => window.open(`/api/jobs/${job.id}/report`, '_blank')}
                        className="h-8 gap-1.5 rounded-lg transition-all hover:border-primary/40 active:scale-[0.98]"
                      >
                        <ExternalLink className="size-3.5" />
                        新窗口打开
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={downloadReport}
                        className="h-8 gap-1.5 rounded-lg transition-all hover:border-primary/40 active:scale-[0.98]"
                      >
                        <Download className="size-3.5" />
                        下载
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="font-mono text-xs text-muted-foreground/85">报告加载中…</p>
                )}
              </div>
            )}
            <iframe
              ref={iframeRef}
              src={`/api/jobs/${job.id}/report${reloadNonce ? `?_r=${reloadNonce}` : ''}`}
              title="评估报告预览"
              onLoad={() => setPreviewLoaded(true)}
              className="h-full w-full bg-white"
            />
          </div>
        </DialogContent>
      </Dialog>

      {/* v2.51：报告原地重跑确认弹窗（沿用既有数据 — 仅 LLM 章节重新生成） */}
      <Dialog open={regenOpen} onOpenChange={setRegenOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RefreshCw className="size-4 text-primary" aria-hidden />
              重新生成报告
            </DialogTitle>
            <DialogDescription>
              沿用本作业既有数据（结构 / 同源 / 文献 / 评分不重收集），仅 LLM 分析章节（10 章）重新生成，通常 1-3 分钟。
            </DialogDescription>
          </DialogHeader>
          <ul className="flex flex-col gap-1.5 rounded-lg border border-border bg-muted/40 px-3.5 py-3 text-xs leading-relaxed text-muted-foreground">
            <li>· 适合补齐缺失章节、换引擎后重写分析、或对结论不满意时重新生成</li>
            <li>· 成功后在线展示与下载文件同步更新为新一版（同一作业原地覆盖）</li>
            <li>· 全部章节生成失败时保留当前版本内容（不影响现有报告）</li>
            <li>· v2.51 之前完成的旧报告缺少数据快照，无法原地重跑（会明确提示）</li>
          </ul>
          <p className="text-[11px] leading-relaxed text-muted-foreground/85">
            LLM 引擎使用当前配置（顶栏引擎徽标所示）；可在顶栏「引擎设置」中切换后再重新生成。评分与结构化数据区块保持原值。
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setRegenOpen(false)} className="h-9 rounded-lg px-4 text-xs transition-all hover:border-primary/40 active:scale-[0.98]">
              取消
            </Button>
            <Button
              onClick={() => void runRegen()}
              className="btn-brand h-9 gap-1.5 rounded-lg px-4 text-xs font-medium text-primary-foreground"
            >
              <RefreshCw className="size-3.5" />
              开始重新生成
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
