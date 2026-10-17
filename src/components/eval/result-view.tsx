'use client'

import { useEffect, useRef, useState } from 'react'
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
  const iframeRef = useRef<HTMLIFrameElement>(null)

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

      {/* 3. 评分 */}
      <motion.section
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: 0.12, ease: 'easeOut' }}
        className="flex flex-col gap-3"
        aria-labelledby="sec-scores"
      >
        <div id="sec-scores">
          <SectionHeader no={scoreNo} title="方法学可行性评分" en="Feasibility Scores" count={scores ? `${Number(scores.overall.score.toFixed(1))}/10 综合` : undefined} />
        </div>
        <Card className="gap-0 rounded-lg border-stone-200 bg-white shadow-none dark:border-stone-800 dark:bg-stone-900">
          <CardContent className="grid gap-5 px-5 py-5 sm:grid-cols-2">
            {scores && (
              <>
                <ScoreBar label="X-ray 结晶学" item={scores.xray} delay={0.05} />
                <ScoreBar label="Cryo-EM 冷冻电镜" item={scores.cryoem} delay={0.15} />
                <ScoreBar label="NMR 核磁共振" item={scores.nmr} delay={0.25} />
                <ScoreBar label="总体可行性" item={scores.overall} delay={0.35} />
              </>
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

      {/* 7. PDB 结构表 */}
      <motion.section
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: 0.26, ease: 'easeOut' }}
        className="flex flex-col gap-3"
      >
        <SectionHeader no={pdbNo} title="PDB 结构清单" en="Structures" count={`${pdbs.length} 个`} />
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
