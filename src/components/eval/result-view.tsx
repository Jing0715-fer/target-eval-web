'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  AlertTriangle,
  ArrowLeft,
  BookOpenText,
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
  RotateCcw,
  SearchX,
  ShieldCheck,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { describeBlastStatus } from '@/lib/eval/types'
import { RatingBadge } from './badges'
import { formatDuration, formatPercent, formatResolution, scoreLevel } from './format'
import { PdbTable } from './pdb-table'
import { BlastTable } from './blast-table'
import { LiteratureList } from './literature-list'
import { AssetGallery } from './asset-gallery'
import { InteractionStructures } from './interaction-structures'
import type { BlastStatusCode, JobDetail, ScoreItem } from './types'

/* ---------------- 通用小组件 ---------------- */

/** 规格栅格单元（仪器读数风）：mono 眉题 + 大数字 + 注释 */
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
    <div className={cn('flex flex-col gap-1 bg-white px-4 py-3.5 dark:bg-stone-900', className)}>
      <span className="eval-eyebrow text-stone-400 dark:text-stone-500">{label}</span>
      <span className="flex flex-wrap items-baseline gap-2">
        <span className="text-xl font-bold tabular-nums text-stone-900 dark:text-stone-50">
          {value}
        </span>
        {badge}
      </span>
      {sub && <span className="truncate text-[11px] text-stone-400 dark:text-stone-500" title={sub}>{sub}</span>}
    </div>
  )
}

/** 纯 CSS 评分条（细轨 + 档位色） */
function ScoreBar({ label, item, delay = 0 }: { label: string; item: ScoreItem; delay?: number }) {
  const maxScore = item.maxScore && item.maxScore > 0 ? item.maxScore : 10
  const pct = Math.max(2, Math.min(100, (item.score / maxScore) * 100))
  const level = scoreLevel(item.score)
  const barCls = {
    emerald: 'bg-emerald-700 dark:bg-emerald-500',
    amber: 'bg-amber-500',
    red: 'bg-red-500',
  }[level]

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-stone-700 dark:text-stone-300">{label}</span>
        <span className="flex items-center gap-2">
          <span className="font-mono text-sm font-semibold tabular-nums text-stone-900 dark:text-stone-100">
            {Number(item.score.toFixed(1))}
            <span className="text-[11px] font-normal text-stone-400"> /{maxScore}</span>
          </span>
          <RatingBadge score={item.score} rating={item.rating} />
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-stone-100 dark:bg-stone-800">
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
      ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-400'
      : v < 0
        ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-400'
        : 'border-stone-200 bg-stone-100 text-stone-500 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-400'
  return (
    <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10.5px] font-bold whitespace-nowrap', cls)}>
      {label} {v > 0 ? `+${v}` : v < 0 ? `−${Math.abs(v)}` : '±0'}
    </span>
  )
}

/** 章节标题（编号 + 衬线中文 + mono 英文眉题 + 右侧计数） */
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
    <div className="flex flex-wrap items-baseline gap-2.5 border-b border-stone-200 pb-2 dark:border-stone-800">
      <span className="eval-eyebrow text-emerald-700 dark:text-emerald-500">{no}</span>
      <h2 className="font-display text-lg font-bold text-stone-900 dark:text-stone-50">{title}</h2>
      <span className="eval-eyebrow hidden text-stone-400 dark:text-stone-500 sm:inline">{en}</span>
      {count && (
        <span className="ml-auto font-mono text-[11px] tabular-nums text-stone-400 dark:text-stone-500">
          {count}
        </span>
      )}
      {right}
    </div>
  )
}

/* ---------------- LLM 报告 markdown 渲染 ---------------- */

/** 与站点编辑风一致的 markdown 样式映射（react-markdown + remark-gfm 表格支持；merged-report-view 复用） */
export const mdComponents: React.ComponentProps<typeof ReactMarkdown>['components'] = {
  h2: ({ children }) => (
    <h2 className="mt-8 mb-3 border-b border-stone-200 pb-2 font-display text-base font-bold text-stone-900 first:mt-0 dark:border-stone-800 dark:text-stone-50">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-5 mb-2 text-sm font-semibold text-stone-800 dark:text-stone-200">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mt-4 mb-1.5 text-sm font-semibold text-stone-700 dark:text-stone-300">{children}</h4>
  ),
  p: ({ children }) => <p className="mb-3 text-sm leading-7 text-stone-600 last:mb-0 dark:text-stone-300">{children}</p>,
  ul: ({ children }) => <ul className="mb-3 ml-5 list-disc space-y-1.5 text-sm leading-relaxed text-stone-600 marker:text-stone-400 last:mb-0 dark:text-stone-300 dark:marker:text-stone-500">{children}</ul>,
  ol: ({ children }) => <ol className="mb-3 ml-5 list-decimal space-y-1.5 text-sm leading-relaxed text-stone-600 marker:text-stone-400 last:mb-0 dark:text-stone-300 dark:marker:text-stone-500">{children}</ol>,
  li: ({ children }) => <li className="pl-1 [>&p]:mb-0">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-stone-800 dark:text-stone-100">{children}</strong>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer" className="font-medium text-emerald-700 underline-offset-2 hover:underline dark:text-emerald-400">
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="mb-3 rounded-sm border-l-2 border-emerald-600 bg-emerald-50/50 px-3.5 py-2.5 text-sm leading-relaxed text-stone-600 dark:bg-emerald-950/20 dark:text-stone-300">{children}</blockquote>
  ),
  table: ({ children }) => (
    <div className="eval-scroll mb-4 overflow-x-auto rounded-md border border-stone-200 dark:border-stone-800">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-stone-50 dark:bg-stone-900/80">{children}</thead>,
  th: ({ children }) => (
    <th className="eval-eyebrow border-b border-stone-200 px-2.5 py-2 text-left font-medium whitespace-nowrap text-stone-500 dark:border-stone-800 dark:text-stone-400">{children}</th>
  ),
  td: ({ children }) => (
    <td className="border-b border-stone-100 px-2.5 py-2 align-top leading-relaxed text-stone-600 dark:border-stone-800/60 dark:text-stone-300">{children}</td>
  ),
  hr: () => <hr className="my-6 border-stone-200 dark:border-stone-800" />,
  code: ({ children }) => (
    <code className="rounded-sm bg-stone-100 px-1.5 py-0.5 font-mono text-[11px] text-stone-700 dark:bg-stone-800 dark:text-stone-200">{children}</code>
  ),
}

/** BLAST 空态说明框（0 命中/跳过/失败原因 — 不再凭空消失） */
function BlastStatusBox({ status, note, provider }: { status?: BlastStatusCode; note?: string; provider?: 'ncbi' | 'rcsb' }) {
  const info = status ? describeBlastStatus({ status, note, provider }) : describeBlastStatus(null)
  const tone =
    status === 'failed'
      ? 'border-amber-200 bg-amber-50/60 dark:border-amber-900/60 dark:bg-amber-950/20'
      : status === 'skipped-antibody'
        ? 'border-violet-200 bg-violet-50/60 dark:border-violet-900/60 dark:bg-violet-950/20'
        : status === 'skipped-homolog'
          ? 'border-teal-200 bg-teal-50/60 dark:border-teal-900/60 dark:bg-teal-950/20'
          : 'border-stone-200 bg-stone-50/60 dark:border-stone-800 dark:bg-stone-900/40'
  const iconTone =
    status === 'failed'
      ? 'text-amber-600 dark:text-amber-400'
      : status === 'skipped-antibody'
        ? 'text-violet-600 dark:text-violet-400'
        : status === 'skipped-homolog'
          ? 'text-teal-600 dark:text-teal-400'
          : 'text-stone-400 dark:text-stone-500'
  return (
    <div className={cn('flex items-start gap-3 rounded-lg border px-4 py-5', tone)}>
      <SearchX className={cn('mt-0.5 size-4.5 shrink-0', iconTone)} aria-hidden />
      <div className="min-w-0 text-sm leading-relaxed text-stone-600 dark:text-stone-300">
        {info}
        {status !== 'failed' && (
          <p className="mt-1.5 text-xs text-stone-400 dark:text-stone-500">
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
}: {
  jobId: string
  iframeRef: React.RefObject<HTMLIFrameElement | null>
  onFail: () => void
}) {
  const [height, setHeight] = useState(1600)
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
    <div className="relative overflow-hidden rounded-lg border border-stone-200 bg-white shadow-none dark:border-stone-800">
      {!loaded && (
        <div className="absolute inset-0 z-10 flex min-h-72 flex-col items-center justify-center gap-3 bg-white dark:bg-stone-950">
          <Loader2 className="size-6 animate-spin text-emerald-700 dark:text-emerald-500" aria-hidden />
          <p className="font-mono text-xs text-stone-400">正在加载完整 HTML 报告（与下载文件同一份）…</p>
        </div>
      )}
      <iframe
        ref={iframeRef}
        src={`/api/jobs/${jobId}/report`}
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
      <Card className="rounded-lg border-stone-200 bg-white shadow-none dark:border-stone-800 dark:bg-stone-900">
        <CardContent className="flex flex-col items-center gap-3 px-6 py-10 text-center">
          <p className="text-sm text-stone-600 dark:text-stone-400">
            该作业已完成，但暂无摘要数据（可能由后端数据不完整导致）。
          </p>
          <Button variant="outline" onClick={onNewEvaluation} className="gap-2 rounded-md">
            <RotateCcw className="size-4" />
            返回新评估
          </Button>
        </CardContent>
      </Card>
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
  const reportMd = job.reportMarkdown?.trim() || null
  const reportLlmFailed = summary.reportLlmOk === false
  const reportDeferred = summary.reportDeferred === true
  /** v1.31：web 端直接内嵌完整 HTML 报告（与「下载 HTML」同一份文件，样式 100% 一致）。
   *  单靶点作业且报告已生成时启用；deferred（并入合并报告）或文件丢失时降级为下方 React 数据区块。 */
  const embedReport = !reportDeferred && job.reportAvailable === true && !embedFailed

  const downloadReport = () => {
    window.open(`/api/jobs/${job.id}/report?download=1`, '_blank')
  }

  /** 章节编号按存在性递增 */
  let secNo = 0
  const nextNo = () => String(++secNo).padStart(2, '0')

  const scoreNo = nextNo()
  const reportNo = nextNo()
  const assetsNo = assets.length > 0 ? nextNo() : null
  const pdbNo = nextNo()
  const blastNo = nextNo()
  const litNo = literature.length > 0 ? nextNo() : null

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
    ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-400'
    : oligo?.category === 'hetero-complex'
      ? 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-400'
      : 'border-stone-300 bg-stone-100 text-stone-700 dark:border-stone-700 dark:bg-stone-800/60 dark:text-stone-300'

  /** v1.26/v1.27：分子量增重策略（小分子量靶点）— 融入评分卡（不单独成章） */
  const mw = summary.mwAugment?.applicable ? summary.mwAugment : null
  const mwAdj = summary.scores?.mwAugmentAdjust ?? null
  const mwPathZh = mw?.assemblyPath === 'complex' ? '已有复合物结构' : mw?.assemblyPath === 'oligomer' ? '自身寡聚装配' : mw?.assemblyPath === 'homolog-complex' ? '同源复合物推断（BLAST）' : mw?.assemblyPath === 'partner' ? '互作伙伴推断' : '无生物装配路径'
  const mwHomologs = mw?.homologComplexes ?? []
  const mwIsHomologPath = mw?.assemblyPath === 'homolog-complex'
  const mwBadgeCls = mwIsHomologPath
    ? (mw?.assemblyKda != null && mw.assemblyKda >= 100
        ? 'border-teal-300 bg-teal-50 text-teal-800 dark:border-teal-800 dark:bg-teal-950/50 dark:text-teal-400'
        : 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-400')
    : mw?.assemblyKda != null && mw.assemblyKda >= 100
      ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-400'
      : mw?.assemblyKda != null && mw.assemblyKda >= 50
        ? 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-400'
        : 'border-stone-300 bg-stone-100 text-stone-700 dark:border-stone-700 dark:bg-stone-800/60 dark:text-stone-300'
  const sizedPartners = mw?.partners.filter(p => p.kda != null) ?? []

  /** v1.30：互作复合物证据（无直接结构时）— 融入评分卡，不单独成章 */
  const itx = summary.interaction?.applicable && summary.interaction.hasEvidence ? summary.interaction : null
  const itxAdj = summary.scores?.interactionAdjust ?? null
  const itxBest = itx?.complexes[0]

  return (
    <div className="flex flex-col gap-8">
      {/* 0. 返回导航条 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button
          variant="outline"
          onClick={onNewEvaluation}
          className="h-9 gap-1.5 rounded-md border-stone-300 px-3 text-xs font-medium text-stone-600 hover:border-emerald-400 hover:text-emerald-800 dark:border-stone-700 dark:text-stone-300 dark:hover:border-emerald-700 dark:hover:text-emerald-400"
        >
          <ArrowLeft className="size-3.5" />
          新建评估
        </Button>
        {/* 当前靶点徽标：批量切换/同蛋白家族场景下让「正在看哪个靶点」一目了然 */}
        <span className="inline-flex min-h-7 items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 font-mono text-[11px] font-semibold text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-400">
          <Crosshair className="size-3 shrink-0" aria-hidden />
          当前靶点 {u.uniprotId}
        </span>
        <span className="font-mono text-[11px] text-stone-400 dark:text-stone-500">
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
        <p className="eval-eyebrow text-emerald-800 dark:text-emerald-500">
          Evaluation Report · 评估结果
        </p>
        <h1 className="font-display text-2xl leading-snug font-bold text-stone-900 sm:text-3xl dark:text-stone-50">
          {u.proteinName || u.entryName || u.uniprotId}
        </h1>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 font-mono text-xs text-stone-500 dark:text-stone-400">
          {u.entryName && <span className="font-semibold">{u.entryName}</span>}
          <a
            href={`https://www.uniprot.org/uniprotkb/${u.uniprotId}/entry`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-sm border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 font-semibold text-emerald-800 transition-colors hover:bg-emerald-100 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-400 dark:hover:bg-emerald-900/60"
          >
            {u.uniprotId}
            <Database className="size-3" />
          </a>
          {(u.geneNames ?? []).slice(0, 6).map((g) => (
            <span key={g} className="rounded-sm border border-stone-200 px-1.5 py-0.5 dark:border-stone-700">
              {g}
            </span>
          ))}
          <span className="font-sans text-stone-400 dark:text-stone-500">
            {u.organism || '未知物种'} · {u.sequenceLength?.toLocaleString?.() ?? '—'} aa
          </span>
        </div>
        {job.goal && (
          <p className="mt-1 max-w-3xl border-l-2 border-amber-400 pl-3 text-sm leading-relaxed text-stone-600 dark:text-stone-300">
            <span className="eval-eyebrow mr-2 text-amber-700 dark:text-amber-500">客户目标</span>
            {job.goal}
          </p>
        )}
        {summary.construct && (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-stone-500 dark:text-stone-400">
            <span className="eval-eyebrow text-stone-400">客户构建</span>
            <span className="rounded-sm border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-400">
              {summary.construct.providedLength.toLocaleString()} aa
              {summary.construct.start != null && summary.construct.end != null
                ? ` · 全长 ${summary.construct.start}–${summary.construct.end} 位`
                : ` / 全长 ${summary.construct.fullLength.toLocaleString()} aa`}
            </span>
            <span className={summary.construct.sameTarget ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-500'}>
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
        className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-stone-200 bg-stone-200 sm:grid-cols-3 dark:border-stone-800 dark:bg-stone-800 lg:grid-cols-6"
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
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-emerald-700/25 bg-emerald-50/60 px-4 py-3 dark:border-emerald-700/30 dark:bg-emerald-950/20">
            <FileCheck2 className="size-4 shrink-0 text-emerald-800 dark:text-emerald-400" aria-hidden />
            <p className="min-w-0 flex-1 text-xs leading-relaxed text-stone-600 dark:text-stone-300">
              下方内嵌<b className="mx-1 text-emerald-800 dark:text-emerald-400">与「下载 HTML」完全相同</b>的报告文件
              （评分 / 评估分析 / PDB 与互作复合物结构清单 / BLAST / 文献 / 实验数据全在其中），
              点击结构 ID、PMID 可直跳 RCSB / PubMed；折叠区可展开查看全量结构列表。
            </p>
            <div className="flex shrink-0 flex-wrap gap-1.5">
              <Button
                variant="outline"
                size="sm"
                onClick={openPreview}
                className="h-8 gap-1.5 rounded-md border-stone-300 bg-white px-2.5 font-mono text-[11px] text-stone-600 hover:border-emerald-400 hover:text-emerald-800 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300"
              >
                <Eye className="size-3.5" />
                全屏预览
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => reportFrameRef.current?.contentWindow?.print()}
                className="h-8 gap-1.5 rounded-md border-stone-300 bg-white px-2.5 font-mono text-[11px] text-stone-600 hover:border-emerald-400 hover:text-emerald-800 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300"
              >
                <Printer className="size-3.5" />
                打印
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => window.open(`/api/jobs/${job.id}/report`, '_blank')}
                className="h-8 gap-1.5 rounded-md border-stone-300 bg-white px-2.5 font-mono text-[11px] text-stone-600 hover:border-emerald-400 hover:text-emerald-800 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300"
              >
                <ExternalLink className="size-3.5" />
                新窗口
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={downloadReport}
                className="h-8 gap-1.5 rounded-md border-stone-300 bg-white px-2.5 font-mono text-[11px] text-stone-600 hover:border-emerald-400 hover:text-emerald-800 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300"
              >
                <Download className="size-3.5" />
                下载 HTML
              </Button>
            </div>
          </div>
          <ReportFrame jobId={job.id} iframeRef={reportFrameRef} onFail={() => setEmbedFailed(true)} />
        </motion.section>
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
            count={scores ? `${Number(scores.overall.score.toFixed(1))}/10 综合${oligo ? ' · 含聚集形式调整' : ''}` : undefined}
          />
        </div>
        <Card className="gap-0 rounded-lg border-stone-200 bg-white shadow-none dark:border-stone-800 dark:bg-stone-900">
          <CardContent className="flex flex-col gap-5 px-5 py-5">
            <div className="grid gap-5 sm:grid-cols-2">
              {scores && (
                <>
                  <ScoreBar label="X-ray 结晶学" item={scores.xray} delay={0.05} />
                  <ScoreBar label="Cryo-EM 冷冻电镜" item={scores.cryoem} delay={0.15} />
                  <ScoreBar label="NMR 核磁共振" item={scores.nmr} delay={0.25} />
                  <ScoreBar label="总体可行性" item={scores.overall} delay={0.35} />
                </>
              )}
            </div>
            {oligo && (
              <div className="flex flex-col gap-3 border-t border-dashed border-stone-200 pt-4 dark:border-stone-800">
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className={cn('inline-flex min-h-7 items-center rounded-md border px-2.5 text-xs font-semibold', oligoBadgeCls)}>
                    {oligoCatZh}
                  </span>
                  <span className="text-xs text-stone-500 dark:text-stone-400">
                    聚集形式
                    <b className="mx-1 font-semibold text-stone-800 dark:text-stone-200">{oligoLabel}</b>
                  </span>
                  {oligo.stoichiometry && (
                    <span className="rounded-md border border-stone-200 bg-stone-50 px-2.5 py-1 font-mono text-[11px] text-stone-700 dark:border-stone-700 dark:bg-stone-800/60 dark:text-stone-300">
                      {oligo.stoichiometry}
                    </span>
                  )}
                  <span className="font-mono text-[11px] text-stone-400 dark:text-stone-500">置信度 {oligoConfZh}</span>
                  {adj && (
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-[10px] tracking-wider text-stone-400 dark:text-stone-500">调整</span>
                      <AdjChip label="X-ray" v={adj.xray} />
                      <AdjChip label="Cryo-EM" v={adj.cryoem} />
                      <AdjChip label="NMR" v={adj.nmr} />
                    </span>
                  )}
                </div>
                {adj ? (
                  <p className="text-xs leading-6 text-stone-500 dark:text-stone-400">
                    {adj.note}（上述整数调整已计入三方法分数与综合评分；判定证据链见下方折叠）
                  </p>
                ) : (
                  <p className="text-xs leading-6 text-stone-500 dark:text-stone-400">{oligo.summary}</p>
                )}
                {oligo.evidence.length > 0 && (
                  <details className="group overflow-hidden rounded-lg border border-stone-200 dark:border-stone-800">
                    <summary className="flex cursor-pointer select-none items-center gap-1.5 border-b border-stone-200 bg-stone-50 px-3.5 py-2 text-[11px] font-medium text-emerald-800 list-none transition-colors hover:bg-stone-100 dark:border-stone-800 dark:bg-stone-900/80 dark:text-emerald-500 dark:hover:bg-stone-800/60 [&::-webkit-details-marker]:hidden">
                      <ChevronDown className="size-3.5 shrink-0 transition-transform duration-200 group-open:rotate-180" aria-hidden />
                      聚集形式判定证据链 · {oligo.evidence.length} 条（按优先级：已有结构 → 同源结构 → UniProt interaction → 文献）
                    </summary>
                    <ul className="divide-y divide-stone-100 dark:divide-stone-800/60">
                      {oligo.evidence.map((e, i) => (
                        <li key={`${e.ref}-${i}`} className="flex flex-col gap-1 px-3.5 py-2.5 sm:flex-row sm:items-baseline sm:gap-3">
                          <span className="w-36 shrink-0 text-[11px] font-medium text-emerald-800 dark:text-emerald-500">
                            {e.source === 'pdb-title' ? '已有结构 · 标题' : e.source === 'pdb-stoichiometry' ? '已有结构 · 链化学计量' : e.source === 'blast-title' ? '同源结构 · 标题（推断）' : e.source === 'uniprot-subunit' ? 'UniProt · 亚基注释' : e.source === 'uniprot-interaction' ? 'UniProt · 相互作用' : '文献标题'}
                          </span>
                          <span className="w-24 shrink-0 font-mono text-[11px] text-stone-500 dark:text-stone-400">{e.ref}</span>
                          <span className="min-w-0 flex-1 text-xs leading-relaxed text-stone-600 dark:text-stone-300">{e.text}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
            {mw && (
              <div className="flex flex-col gap-3 border-t border-dashed border-stone-200 pt-4 dark:border-stone-800">
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className={cn('inline-flex min-h-7 items-center rounded-md border px-2.5 text-xs font-semibold', mwBadgeCls)}>
                    小分子量靶点
                  </span>
                  <span className="text-xs text-stone-500 dark:text-stone-400">
                    分子量
                    <b className="mx-1 font-semibold text-stone-800 dark:text-stone-200">
                      单体 ~{mw.monomerKda} kDa{mw.assemblyKda != null ? ` → 装配 ~${mw.assemblyKda} kDa${mwIsHomologPath ? '（同源推断）' : ''}` : ''}
                    </b>
                  </span>
                  <span className="rounded-md border border-stone-200 bg-stone-50 px-2.5 py-1 font-mono text-[11px] text-stone-700 dark:border-stone-700 dark:bg-stone-800/60 dark:text-stone-300">
                    {mwPathZh}
                  </span>
                  {mwAdj && (
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-[10px] tracking-wider text-stone-400 dark:text-stone-500">调整</span>
                      <AdjChip label="X-ray" v={mwAdj.xray} />
                      <AdjChip label="Cryo-EM" v={mwAdj.cryoem} />
                      <AdjChip label="NMR" v={mwAdj.nmr} />
                    </span>
                  )}
                </div>
                {mwAdj ? (
                  <p className="text-xs leading-6 text-stone-500 dark:text-stone-400">
                    {mwAdj.note}（分子量调整已计入 Cryo-EM 分数与综合评分；X-ray/NMR 不受增重影响{mw.assemblyKda != null ? '；装配分子量已知时，聚集形式的 Cryo-EM 分量并入本维度计分（避免双重加分）' : ''}）
                  </p>
                ) : (
                  <p className="text-xs leading-6 text-stone-500 dark:text-stone-400">{mw.zoneNote}</p>
                )}
                {mw.homologSearchNote && (
                  <p className="rounded-md border border-teal-200/70 bg-teal-50/60 px-3 py-2 text-xs leading-6 text-teal-800 dark:border-teal-900 dark:bg-teal-950/30 dark:text-teal-300">
                    {mw.homologSearchNote}
                  </p>
                )}
                {(mw.complexes.length > 0 || mwHomologs.length > 0 || sizedPartners.length > 0 || mw.conflicts.length > 0) && (
                  <details className="group overflow-hidden rounded-lg border border-stone-200 dark:border-stone-800">
                    <summary className="flex cursor-pointer select-none items-center gap-1.5 border-b border-stone-200 bg-stone-50 px-3.5 py-2 text-[11px] font-medium text-emerald-800 list-none transition-colors hover:bg-stone-100 dark:border-stone-800 dark:bg-stone-900/80 dark:text-emerald-500 dark:hover:bg-stone-800/60 [&::-webkit-details-marker]:hidden">
                      <ChevronDown className="size-3.5 shrink-0 transition-transform duration-200 group-open:rotate-180" aria-hidden />
                      增重路径明细 · 复合物结构 {mw.complexes.length} · 同源复合物 {mwHomologs.length} · 互作伙伴 {sizedPartners.length} · 目的比对 {mw.conflicts.length} 条
                    </summary>
                    <div className="flex flex-col gap-4 px-3.5 py-3.5">
                      {mw.complexes.length > 0 && (
                        <div className="flex flex-col gap-2">
                          <p className="text-[11px] font-semibold text-stone-700 dark:text-stone-300">已有复合物结构 — 组分总分子量统计</p>
                          <ul className="divide-y divide-stone-100 dark:divide-stone-800/60">
                            {mw.complexes.map(c => (
                              <li key={c.pdbId} className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-baseline sm:gap-3">
                                <a
                                  href={`https://www.rcsb.org/structure/${c.pdbId}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="w-20 shrink-0 font-mono text-[11px] font-semibold text-emerald-800 hover:underline dark:text-emerald-500"
                                >
                                  {c.pdbId}
                                </a>
                                <span className="min-w-0 flex-1 text-xs leading-relaxed text-stone-600 dark:text-stone-300">
                                  {c.components.map(x => (
                                    <span
                                      key={`${c.pdbId}-${x.name}-${x.kda}`}
                                      className={cn(
                                        'mr-1.5 inline-block rounded-sm border px-1.5 py-0.5 text-[11px]',
                                        x.isTarget
                                          ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-400'
                                          : 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-500',
                                      )}
                                    >
                                      {x.isTarget ? '靶点' : x.name.slice(0, 36)} ~{x.kda} kDa
                                    </span>
                                  ))}
                                  <b className="ml-1 text-stone-800 dark:text-stone-200">= 装配 ~{c.totalKda} kDa</b>
                                  <span className="mt-0.5 block font-mono text-[10.5px] text-stone-400 dark:text-stone-500">{c.note}</span>
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {mwHomologs.length > 0 && (
                        <div className="flex flex-col gap-2">
                          <p className="text-[11px] font-semibold text-stone-700 dark:text-stone-300">
                            同源结构形成的大复合物（BLAST 扩展检索）— 直接装配路径不足 50 kDa 时检索；同源亚基按靶点单体换算
                          </p>
                          <ul className="divide-y divide-stone-100 dark:divide-stone-800/60">
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
                                <span className="min-w-0 flex-1 text-xs leading-relaxed text-stone-600 dark:text-stone-300">
                                  {h.componentSummary}
                                  <b className="ml-1 text-stone-800 dark:text-stone-200">
                                    = 同源装配 ~{h.totalKda} kDa → 靶点换算 ~{h.estimatedKda} kDa
                                  </b>
                                  <span className="mt-0.5 block font-mono text-[10.5px] text-stone-400 dark:text-stone-500">{h.note}</span>
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {sizedPartners.length > 0 && (
                        <div className="flex flex-col gap-1.5">
                          <p className="text-[11px] font-semibold text-stone-700 dark:text-stone-300">UniProt 互作伙伴（可作增重路径，按 1:1 估计；无结构先例，化学计量需 SEC-MALS 验证）</p>
                          <p className="text-xs leading-6 text-stone-600 dark:text-stone-300">
                            {sizedPartners.slice(0, 6).map(p => `${p.geneName ?? p.proteinName ?? p.accession}（${p.accession}，${p.lengthAa} aa ~${p.kda} kDa）`).join('、')}
                          </p>
                        </div>
                      )}
                      <div className="flex flex-col gap-1.5">
                        <p className="text-[11px] font-semibold text-stone-700 dark:text-stone-300">技术增重工具箱</p>
                        <ul className="flex flex-col gap-1.5">
                          {mw.options.map(o => (
                            <li key={o.name} className="text-xs leading-6 text-stone-600 dark:text-stone-300">
                              <b className="text-stone-800 dark:text-stone-200">{o.name}</b>
                              <span className="mx-1.5 font-mono text-[10.5px] text-emerald-700 dark:text-emerald-500">{o.addKda}</span>
                              — {o.note}
                            </li>
                          ))}
                        </ul>
                      </div>
                      {mw.conflicts.length > 0 && (
                        <div className="flex flex-col gap-1.5">
                          <p className="text-[11px] font-semibold text-stone-700 dark:text-stone-300">与客户目的的比对（加入的蛋白是否与目的冲突）</p>
                          <ul className="flex flex-col gap-1.5">
                            {mw.conflicts.map((c, i) => (
                              <li key={`conflict-${i}`} className="flex items-baseline gap-2 text-xs leading-6 text-stone-600 dark:text-stone-300">
                                <span
                                  className={cn(
                                    'inline-flex shrink-0 items-center rounded-sm border px-1.5 py-0.5 font-mono text-[10px] font-bold',
                                    c.level === 'aligned'
                                      ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-400'
                                      : c.level === 'caution'
                                        ? 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-500'
                                        : 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400',
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
              <div className="flex flex-col gap-3 border-t border-dashed border-stone-200 pt-4 dark:border-stone-800">
                <div className="flex flex-wrap items-center gap-2.5">
                  <span
                    className={cn(
                      'inline-flex min-h-7 items-center rounded-md border px-2.5 text-xs font-semibold',
                      itxAdj?.level === 'curated'
                        ? 'border-teal-300 bg-teal-50 text-teal-800 dark:border-teal-800 dark:bg-teal-950/50 dark:text-teal-400'
                        : 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-400',
                    )}
                  >
                    {itxAdj?.level === 'curated' ? 'Complex Portal' : 'IntAct 互作'}
                  </span>
                  <span className="text-xs text-stone-500 dark:text-stone-400">
                    互作证据
                    <b className="mx-1 font-semibold text-stone-800 dark:text-stone-200">
                      {itxBest ? `${itxBest.complexAc}${itxBest.assembly ? ` · ${itxBest.assembly}` : ''}` : 'binary 伙伴'}
                    </b>
                  </span>
                  {itxAdj && (
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-[10px] tracking-wider text-stone-400 dark:text-stone-500">调整</span>
                      <AdjChip label="X-ray" v={itxAdj.xray} />
                      <AdjChip label="Cryo-EM" v={itxAdj.cryoem} />
                      <AdjChip label="NMR" v={itxAdj.nmr} />
                    </span>
                  )}
                </div>
                <p className="text-xs leading-6 text-stone-500 dark:text-stone-400">
                  {itx.summary}
                  {itxAdj && '（上述调整已计入对应方法分数与综合评分；curated 复合物接管 Cryo-EM 分子量分量时，分子量增重与聚集形式维度的 Cryo-EM 分量不再重复计分）'}
                  {itx.complexes.length > 0 && ' — 组分结构清单（共有结构/单独结构分类）见下方「PDB 结构清单」章节。'}
                </p>
                {itx.notes.length > 0 && (
                  <details className="group overflow-hidden rounded-lg border border-stone-200 dark:border-stone-800">
                    <summary className="flex cursor-pointer select-none items-center gap-1.5 border-b border-stone-200 bg-stone-50 px-3.5 py-2 text-[11px] font-medium text-emerald-800 list-none transition-colors hover:bg-stone-100 dark:border-stone-800 dark:bg-stone-900/80 dark:text-emerald-500 dark:hover:bg-stone-800/60 [&::-webkit-details-marker]:hidden">
                      <ChevronDown className="size-3.5 shrink-0 transition-transform duration-200 group-open:rotate-180" aria-hidden />
                      互作证据要点与策略影响 · {itx.notes.length} 条
                    </summary>
                    <ul className="divide-y divide-stone-100 dark:divide-stone-800/60">
                      {itx.notes.map((n, i) => (
                        <li key={`itx-note-${i}`} className="px-3.5 py-2.5 text-xs leading-relaxed text-stone-600 dark:text-stone-300">{n}</li>
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
          'flex flex-col gap-4 rounded-lg border px-5 py-4 sm:flex-row sm:items-center',
          reportDeferred
            ? 'border-violet-300 bg-violet-50/60 dark:border-violet-800 dark:bg-violet-950/20'
            : reportLlmFailed
              ? 'border-amber-300 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/20'
              : 'border-emerald-700/25 bg-emerald-50/60 dark:border-emerald-700/30 dark:bg-emerald-950/20'
        )}
      >
        <div className="flex items-center gap-3">
          <div className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-md text-white',
            reportDeferred ? 'bg-violet-700 dark:bg-violet-800' : reportLlmFailed ? 'bg-amber-600 dark:bg-amber-700' : 'bg-emerald-800 dark:bg-emerald-700'
          )}>
            {reportDeferred ? <Layers className="size-4.5" /> : reportLlmFailed ? <AlertTriangle className="size-4.5" /> : <FileCheck2 className="size-4.5" />}
          </div>
          <div>
            <div className="text-sm font-semibold text-stone-900 dark:text-stone-100">
              {reportDeferred ? '分析已并入合并评估报告' : reportLlmFailed ? '报告生成（LLM 部分失败）' : '评估报告已生成'}
            </div>
            <div className="font-mono text-[11px] text-stone-500 dark:text-stone-400">
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
              className="h-10 gap-2 rounded-md bg-emerald-800 px-4 font-medium text-white hover:bg-emerald-700 dark:bg-emerald-700 dark:hover:bg-emerald-600"
            >
              <Eye className="size-4" />
              在线预览报告
            </Button>
            <Button
              variant="outline"
              onClick={downloadReport}
              className="h-10 gap-2 rounded-md border-stone-300 bg-white px-4 dark:border-stone-700 dark:bg-stone-900"
            >
              <Download className="size-4" />
              下载 HTML
            </Button>
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
            count={reportMd ? `${reportMd.length.toLocaleString()} 字` : undefined}
          />
        </div>
        {reportLlmFailed && (
          <div className="flex items-start gap-2.5 rounded-md border border-amber-200 bg-amber-50/70 px-3.5 py-2.5 text-xs leading-relaxed text-amber-800 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            LLM 报告生成失败或部分失败，以下可能仅包含成功生成的章节；结构化数据区块（评分 / PDB / 文献）不受影响，可重新评估以重试报告生成。
          </div>
        )}
        {reportDeferred ? (
          <Card className="rounded-lg border-violet-200 bg-white shadow-none dark:border-violet-900 dark:bg-stone-900">
            <CardContent className="flex flex-col items-center gap-2.5 px-6 py-8 text-center">
              <Layers className="size-5 text-violet-500 dark:text-violet-400" aria-hidden />
              <p className="text-sm text-stone-600 dark:text-stone-300">
                本靶点与批次内其他靶点经分析判定为<span className="font-semibold text-violet-700 dark:text-violet-400">关联靶点</span>，
                分析章节（执行摘要 / 靶点关系分析 / 各靶点综述 / 整合策略）已合并至本批次的合并评估报告
              </p>
              <p className="text-xs text-stone-400 dark:text-stone-500">
                下方数据区块（评分 / PDB / BLAST / 文献）为该靶点的独立数据；合并报告可经上方切换栏查看
              </p>
            </CardContent>
          </Card>
        ) : reportMd ? (
          <Card className="rounded-lg border-stone-200 bg-white shadow-none dark:border-stone-800 dark:bg-stone-900">
            <CardContent className="px-5 py-5 sm:px-7 sm:py-6">
              <div className="mb-4 flex items-center gap-2 text-stone-400 dark:text-stone-500">
                <BookOpenText className="size-3.5" aria-hidden />
                <span className="eval-eyebrow">Analysis · 由大语言模型基于下方结构化数据生成，结论供参考</span>
              </div>
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                {reportMd}
              </ReactMarkdown>
            </CardContent>
          </Card>
        ) : (
          <Card className="rounded-lg border-stone-200 bg-white shadow-none dark:border-stone-800 dark:bg-stone-900">
            <CardContent className="flex flex-col items-center gap-2.5 px-6 py-8 text-center">
              <BookOpenText className="size-5 text-stone-300 dark:text-stone-600" aria-hidden />
              <p className="text-sm text-stone-500 dark:text-stone-400">
                该作业未内联保存报告文本（历史版本作业）
              </p>
              <p className="text-xs text-stone-400 dark:text-stone-500">
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
              ? `${pdbs.length} 个`
              : itx
                ? `直接结构 0 · 互作组分证据${itxBest?.sharedPdbTotal ? `（共有 ${itxBest.sharedPdbTotal}）` : ''}`
                : '0 个'
          }
        />
        {itx && pdbs.length === 0 && (
          <div className="flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50/70 px-4 py-3.5 text-xs leading-relaxed text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
            <span>
              <b>暂无直接关联的 PDB 结构 — 全新结构靶点。</b>
              该靶点在 RCSB 无直接关联结构条目，但存在互作复合物证据 — 下方列出其复合物其他组分的结构清单
              （共有结构突出显示、单独结构默认折叠），作为组装路线与构建边界设计的评估依据。
            </span>
          </div>
        )}
        {itx && pdbs.length === 0 && <InteractionStructures itx={itx} />}
        <PdbTable pdbs={pdbs} ligandCount={summary.ligandCount} literature={literature} />
      </motion.section>

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
              ? `${blastHits.length} 条命中${blastShared ? ' · 家族共享' : blastViaRcsb ? ' · RCSB 兜底' : ''}`
              : blastInfo
                ? '未运行'
                : '—'
          }
        />
        {blastViaRcsb && blastHits.length > 0 && (
          <div className="flex items-start gap-2.5 rounded-md border border-emerald-200 bg-emerald-50/60 px-3.5 py-2.5 text-xs leading-relaxed text-emerald-800 dark:border-emerald-900/70 dark:bg-emerald-950/30 dark:text-emerald-300">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {describeBlastStatus(blastInfo)} — NCBI BLAST 队列拥堵/故障时自动改用 RCSB 序列检索（mmseqs2）获得等效同源结构，命中含一致性/E 值/覆盖度，可信度与 BLAST 同源结构相当。
          </div>
        )}
        {blastHits.length > 0 ? (
          <BlastTable hits={blastHits} />
        ) : (
          <BlastStatusBox status={blastInfo?.status} note={blastInfo?.note} provider={blastInfo?.provider} />
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
      </>}

      {/* 底部操作 */}
      <div className="flex justify-center border-t border-stone-200 pt-6 dark:border-stone-800">
        <Button
          variant="outline"
          onClick={onNewEvaluation}
          className="h-10 gap-2 rounded-md border-stone-300 px-6 dark:border-stone-700"
        >
          <RotateCcw className="size-4" />
          返回新评估
        </Button>
      </div>

      {/* 报告在线预览（大窗口 iframe + 加载态 + 新窗口/打印） */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent
          showCloseButton
          className="flex h-[88vh] w-full max-w-6xl flex-col gap-0 overflow-hidden rounded-lg p-0 sm:max-w-6xl"
        >
          <DialogHeader className="flex-row items-center justify-between gap-4 border-b border-stone-200 px-5 py-3 pr-14 text-left dark:border-stone-800">
            <div className="flex flex-col gap-0.5">
              <DialogTitle className="flex items-center gap-2 font-display text-base">
                评估报告 · {u.proteinName || u.uniprotId}
              </DialogTitle>
              <DialogDescription className="font-mono text-[11px] text-stone-400 dark:text-stone-500">
                完整 HTML 报告 · 可直接打印
              </DialogDescription>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                variant="outline"
                size="sm"
                onClick={() => iframeRef.current?.contentWindow?.print()}
                className="h-8 gap-1.5 rounded-md border-stone-300 bg-white px-2.5 font-mono text-[11px] text-stone-600 hover:border-emerald-400 hover:text-emerald-800 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300"
              >
                <Printer className="size-3.5" />
                打印
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => window.open(`/api/jobs/${job.id}/report`, '_blank')}
                className="h-8 gap-1.5 rounded-md border-stone-300 bg-white px-2.5 font-mono text-[11px] text-stone-600 hover:border-emerald-400 hover:text-emerald-800 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300"
              >
                <ExternalLink className="size-3.5" />
                新窗口
              </Button>
            </div>
          </DialogHeader>
          <div className="relative min-h-0 flex-1">
            {!previewLoaded && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-white dark:bg-stone-950">
                <Loader2 className="size-6 animate-spin text-emerald-700 dark:text-emerald-500" />
                {previewSlow ? (
                  <div className="flex max-w-xs flex-col items-center gap-3 px-4 text-center">
                    <p className="text-xs text-stone-500 dark:text-stone-400">
                      报告加载较慢（含内嵌图片时体积较大），也可选择其他方式查看：
                    </p>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => window.open(`/api/jobs/${job.id}/report`, '_blank')}
                        className="h-8 gap-1.5 rounded-md"
                      >
                        <ExternalLink className="size-3.5" />
                        新窗口打开
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={downloadReport}
                        className="h-8 gap-1.5 rounded-md"
                      >
                        <Download className="size-3.5" />
                        下载
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="font-mono text-xs text-stone-400">报告加载中…</p>
                )}
              </div>
            )}
            <iframe
              ref={iframeRef}
              src={`/api/jobs/${job.id}/report`}
              title="评估报告预览"
              onLoad={() => setPreviewLoaded(true)}
              className="h-full w-full bg-white dark:bg-stone-950"
            />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
