'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import {
  ArrowLeft,
  Database,
  Download,
  Eye,
  FileCheck2,
  RotateCcw,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { RatingBadge } from './badges'
import { formatDuration, formatPercent, formatResolution, scoreLevel } from './format'
import { PdbTable } from './pdb-table'
import { BlastTable } from './blast-table'
import { LiteratureList } from './literature-list'
import { AssetGallery } from './asset-gallery'
import type { JobDetail, ScoreItem } from './types'

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
}: {
  no: string
  title: string
  en: string
  count?: string
}) {
  return (
    <div className="flex items-baseline gap-2.5 border-b border-stone-200 pb-2 dark:border-stone-800">
      <span className="eval-eyebrow text-emerald-700 dark:text-emerald-500">{no}</span>
      <h2 className="font-display text-lg font-bold text-stone-900 dark:text-stone-50">{title}</h2>
      <span className="eval-eyebrow hidden text-stone-400 dark:text-stone-500 sm:inline">{en}</span>
      {count && (
        <span className="ml-auto font-mono text-[11px] tabular-nums text-stone-400 dark:text-stone-500">
          {count}
        </span>
      )}
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

  const downloadReport = () => {
    window.open(`/api/jobs/${job.id}/report?download=1`, '_blank')
  }

  /** 章节编号按存在性递增 */
  let secNo = 0
  const nextNo = () => String(++secNo).padStart(2, '0')

  const scoreNo = nextNo()
  const assetsNo = assets.length > 0 ? nextNo() : null
  const pdbNo = nextNo()
  const blastNo = blastHits.length > 0 ? nextNo() : null
  const litNo = literature.length > 0 ? nextNo() : null

  return (
    <div className="flex flex-col gap-8">
      {/* 0. 返回导航条 */}
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          onClick={onNewEvaluation}
          className="h-9 gap-1.5 rounded-md border-stone-300 px-3 text-xs font-medium text-stone-600 hover:border-emerald-400 hover:text-emerald-800 dark:border-stone-700 dark:text-stone-300 dark:hover:border-emerald-700 dark:hover:text-emerald-400"
        >
          <ArrowLeft className="size-3.5" />
          新建评估
        </Button>
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
          sub="NCBI BLAST"
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
        className="flex flex-col gap-4 rounded-lg border border-emerald-700/25 bg-emerald-50/60 px-5 py-4 sm:flex-row sm:items-center dark:border-emerald-700/30 dark:bg-emerald-950/20"
      >
        <div className="flex items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-emerald-800 text-white dark:bg-emerald-700">
            <FileCheck2 className="size-4.5" />
          </div>
          <div>
            <div className="text-sm font-semibold text-stone-900 dark:text-stone-100">
              评估报告已生成
            </div>
            <div className="font-mono text-[11px] text-stone-500 dark:text-stone-400">
              HTML · {formatDuration(Math.round((summary.durationMs ?? 0) / 1000))} · 可独立下载分享
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 sm:ml-auto">
          <Button
            onClick={() => setPreviewOpen(true)}
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
      </motion.section>

      {/* 5. 实验数据（胶图/SEC） */}
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

      {/* 6. PDB 结构表 */}
      <motion.section
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: 0.26, ease: 'easeOut' }}
        className="flex flex-col gap-3"
      >
        <SectionHeader no={pdbNo} title="PDB 结构清单" en="Structures" count={`${pdbs.length} 个`} />
        <PdbTable pdbs={pdbs} ligandCount={summary.ligandCount} literature={literature} />
      </motion.section>

      {/* 7. BLAST 同源表 */}
      {blastHits.length > 0 && (
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.3, ease: 'easeOut' }}
          className="flex flex-col gap-3"
        >
          <SectionHeader no={blastNo!} title="BLAST 同源结构" en="Homologs" count={`${blastHits.length} 条命中`} />
          <BlastTable hits={blastHits} />
        </motion.section>
      )}

      {/* 8. 文献列表 */}
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

      {/* 报告在线预览（大窗口 iframe） */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent
          showCloseButton
          className="flex h-[88vh] w-full max-w-6xl flex-col gap-0 overflow-hidden rounded-lg p-0 sm:max-w-6xl"
        >
          <DialogHeader className="border-b border-stone-200 px-5 py-3.5 dark:border-stone-800">
            <DialogTitle className="flex items-center gap-2 font-display text-base">
              评估报告 · {u.proteinName || u.uniprotId}
            </DialogTitle>
            <DialogDescription className="sr-only">
              在内嵌窗口中预览完整 HTML 评估报告
            </DialogDescription>
          </DialogHeader>
          <iframe
            src={`/api/jobs/${job.id}/report`}
            title="评估报告预览"
            className="min-h-0 w-full flex-1 bg-white dark:bg-stone-950"
          />
        </DialogContent>
      </Dialog>
    </div>
  )
}
