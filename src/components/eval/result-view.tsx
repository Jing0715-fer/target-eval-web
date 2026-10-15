'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import {
  Atom,
  Award,
  BookOpen,
  Database,
  Download,
  Dna,
  Eye,
  FileCheck2,
  Images,
  Microscope,
  Percent,
  RotateCcw,
  Search,
  Target,
  Waypoints,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
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

function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  badge,
  className,
}: {
  label: string
  value: string
  sub?: string
  icon: React.ComponentType<{ className?: string }>
  badge?: React.ReactNode
  className?: string
}) {
  return (
    <Card className={cn('gap-0 rounded-xl border-stone-200 bg-white py-4 shadow-sm dark:border-stone-800 dark:bg-stone-900', className)}>
      <CardContent className="flex flex-col gap-1 px-4">
        <div className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-stone-500 dark:text-stone-500">
          <Icon className="size-3.5" />
          {label}
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-bold tabular-nums text-stone-900 dark:text-stone-100">
            {value}
          </span>
          {badge}
        </div>
        {sub && <div className="truncate text-xs text-stone-500 dark:text-stone-500">{sub}</div>}
      </CardContent>
    </Card>
  )
}

/** 纯 CSS 评分条 */
function ScoreBar({ label, item, delay = 0 }: { label: string; item: ScoreItem; delay?: number }) {
  const maxScore = item.maxScore && item.maxScore > 0 ? item.maxScore : 10
  const pct = Math.max(2, Math.min(100, (item.score / maxScore) * 100))
  const level = scoreLevel(item.score)
  const barCls = {
    emerald: 'bg-emerald-500',
    amber: 'bg-amber-500',
    red: 'bg-red-500',
  }[level]

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-stone-700 dark:text-stone-300">{label}</span>
        <span className="flex items-center gap-2">
          <span className="text-sm font-semibold tabular-nums text-stone-900 dark:text-stone-100">
            {Number(item.score.toFixed(1))}
            <span className="text-xs font-normal text-stone-400"> / {maxScore}</span>
          </span>
          <RatingBadge score={item.score} rating={item.rating} />
        </span>
      </div>
      <div className="h-2.5 overflow-hidden rounded-full bg-stone-100 dark:bg-stone-800">
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

/** 结果区块容器（带标题与入场动画） */
function Section({
  title,
  icon: Icon,
  action,
  delay = 0,
  children,
}: {
  title: string
  icon: React.ComponentType<{ className?: string }>
  action?: React.ReactNode
  delay?: number
  children: React.ReactNode
}) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay, ease: 'easeOut' }}
      className="flex flex-col gap-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Icon className="size-4 text-emerald-700 dark:text-emerald-500" />
        <h2 className="text-sm font-semibold text-stone-800 dark:text-stone-200">{title}</h2>
        {action}
      </div>
      {children}
    </motion.section>
  )
}

/* ---------------- 结果视图 ---------------- */

export interface ResultViewProps {
  job: JobDetail
  onNewEvaluation: () => void
}

/** 结果视图（done）：摘要卡片 → 评分卡 → 报告操作 → 实验数据 → PDB 表 → BLAST 表 → 文献 */
export function ResultView({ job, onNewEvaluation }: ResultViewProps) {
  const [previewOpen, setPreviewOpen] = useState(false)

  const summary = job.summary
  if (!summary?.uniprot) {
    return (
      <Card className="rounded-xl border-stone-200 bg-white shadow-sm dark:border-stone-800 dark:bg-stone-900">
        <CardContent className="flex flex-col items-center gap-3 px-6 py-10 text-center">
          <p className="text-sm text-stone-600 dark:text-stone-400">
            该作业已完成，但暂无摘要数据（可能由后端数据不完整导致）。
          </p>
          <Button variant="outline" onClick={onNewEvaluation} className="gap-2">
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

  return (
    <div className="flex flex-col gap-8">
      {/* 1. 摘要卡片区 */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: 'easeOut' }}
          className="col-span-2"
        >
          <Card className="h-full gap-0 rounded-xl border-stone-200 bg-white py-4 shadow-sm dark:border-stone-800 dark:bg-stone-900">
            <CardContent className="flex h-full flex-col gap-2 px-4">
              <div className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-stone-500 dark:text-stone-500">
                <Dna className="size-3.5" />
                蛋白信息
              </div>
              <div className="text-lg leading-snug font-semibold text-stone-900 dark:text-stone-100">
                {u.proteinName || u.entryName || u.uniprotId}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {(u.geneNames ?? []).slice(0, 6).map((g) => (
                  <Badge key={g} variant="secondary" className="font-mono text-[10px]">
                    {g}
                  </Badge>
                ))}
              </div>
              <div className="text-xs text-stone-500 dark:text-stone-500">
                {u.organism || '未知物种'} · {u.sequenceLength?.toLocaleString?.() ?? '—'} aa
                {u.entryName && <span className="ml-1.5 font-mono">({u.entryName})</span>}
              </div>
              <a
                href={`https://www.uniprot.org/uniprotkb/${u.uniprotId}/entry`}
                target="_blank"
                rel="noreferrer"
                className="mt-auto inline-flex w-fit items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-2.5 py-1 font-mono text-xs font-semibold text-emerald-700 transition-colors hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-400 dark:hover:bg-emerald-900/60"
              >
                {u.uniprotId}
                <Database className="size-3" />
              </a>
            </CardContent>
          </Card>
        </motion.div>

        <StatCard
          label="PDB 结构数"
          value={String(summary.directPdbCount ?? 0)}
          sub={
            ms
              ? `${ms.xrayCount ?? 0} X-ray · ${ms.cryoemCount ?? 0} Cryo-EM · ${ms.nmrCount ?? 0} NMR`
              : undefined
          }
          icon={Atom}
        />
        <StatCard
          label="序列覆盖率"
          value={formatPercent(summary.coverage)}
          sub="PDBe 结构覆盖"
          icon={Percent}
        />
        <StatCard
          label="总体评分"
          value={scores?.overall ? Number(scores.overall.score.toFixed(1)).toString() : '—'}
          badge={scores?.overall ? <RatingBadge score={scores.overall.score} rating={scores.overall.rating} /> : undefined}
          sub="三方法综合"
          icon={Award}
        />
        <StatCard
          label="文献数"
          value={String(summary.literatureCount ?? literature.length)}
          sub="PubMed 检索"
          icon={BookOpen}
        />
        <StatCard
          label="BLAST 同源数"
          value={String(summary.blastHitCount ?? blastHits.length)}
          sub="NCBI BLAST 检索"
          icon={Search}
        />
        <StatCard
          label="最佳分辨率"
          value={ms?.bestResolution != null ? formatResolution(ms.bestResolution).replace(' Å', '') : '—'}
          sub={ms?.bestResolution != null ? 'Å' : '暂无结构'}
          icon={Microscope}
        />
      </div>

      {/* 客户目标回顾 */}
      {job.goal && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.1 }}
          className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50/70 px-4 py-3 dark:border-amber-900/60 dark:bg-amber-950/25"
        >
          <Target className="mt-0.5 size-4 shrink-0 text-amber-600" />
          <p className="text-sm leading-relaxed text-stone-700 dark:text-stone-300">
            <span className="font-semibold text-amber-800 dark:text-amber-400">客户目标：</span>
            {job.goal}
          </p>
        </motion.div>
      )}

      {/* 2. 评分卡 */}
      <Section title="方法学可行性评分" icon={Award} delay={0.12}>
        <Card className="rounded-xl border-stone-200 bg-white shadow-sm dark:border-stone-800 dark:bg-stone-900">
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
      </Section>

      {/* 3. 报告操作条 */}
      <motion.section
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: 0.18, ease: 'easeOut' }}
      >
        <Card className="rounded-xl border-emerald-200 bg-emerald-50/60 shadow-sm dark:border-emerald-900/60 dark:bg-emerald-950/25">
          <CardContent className="flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-emerald-600 text-white shadow-sm">
                <FileCheck2 className="size-5" />
              </div>
              <div>
                <div className="text-sm font-semibold text-stone-900 dark:text-stone-100">
                  评估报告已生成
                </div>
                <div className="text-xs text-stone-500 dark:text-stone-400">
                  HTML 格式 · 耗时 {formatDuration(Math.round((summary.durationMs ?? 0) / 1000))} · 可独立下载分享
                </div>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => setPreviewOpen(true)}
                className="h-11 gap-2 bg-emerald-600 font-medium text-white hover:bg-emerald-700 dark:bg-emerald-600 dark:hover:bg-emerald-500"
              >
                <Eye className="size-4" />
                在线预览报告
              </Button>
              <Button
                variant="outline"
                onClick={downloadReport}
                className="h-11 gap-2 border-stone-300 bg-white dark:bg-stone-900"
              >
                <Download className="size-4" />
                下载 HTML 报告
              </Button>
              <Button variant="ghost" onClick={onNewEvaluation} className="h-11 gap-2 text-stone-600 dark:text-stone-300">
                <RotateCcw className="size-4" />
                新评估
              </Button>
            </div>
          </CardContent>
        </Card>
      </motion.section>

      {/* 4. 胶图 / SEC 实验数据 */}
      {assets.length > 0 && (
        <Section
          title="客户实验数据（胶图 / SEC）"
          icon={Images}
          delay={0.22}
          action={
            <Badge variant="secondary" className="text-[11px]">
              {assets.length} 张
            </Badge>
          }
        >
          <AssetGallery assets={assets} />
        </Section>
      )}

      {/* 5. PDB 结构表 */}
      <Section
        title="PDB 结构列表"
        icon={Atom}
        delay={0.26}
        action={
          <Badge variant="secondary" className="text-[11px]">
            {pdbs.length} 个结构
          </Badge>
        }
      >
        <PdbTable pdbs={pdbs} ligandCount={summary.ligandCount} />
      </Section>

      {/* 6. BLAST 同源表 */}
      {blastHits.length > 0 && (
        <Section
          title="BLAST 同源结构"
          icon={Waypoints}
          delay={0.3}
          action={
            <Badge variant="secondary" className="text-[11px]">
              {blastHits.length} 条命中
            </Badge>
          }
        >
          <BlastTable hits={blastHits} />
        </Section>
      )}

      {/* 7. 文献列表 */}
      {literature.length > 0 && (
        <Section
          title="相关文献"
          icon={BookOpen}
          delay={0.34}
          action={
            <Badge variant="secondary" className="text-[11px]">
              {literature.length} 篇
            </Badge>
          }
        >
          <LiteratureList items={literature} />
        </Section>
      )}

      {/* 底部操作 */}
      <div className="flex justify-center pt-2">
        <Button
          variant="outline"
          onClick={onNewEvaluation}
          className="h-11 gap-2 border-stone-300 px-6 dark:border-stone-700"
        >
          <RotateCcw className="size-4" />
          返回新评估
        </Button>
      </div>

      {/* 报告在线预览（大窗口 iframe） */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent
          showCloseButton
          className="flex h-[88vh] w-full max-w-6xl flex-col gap-0 overflow-hidden p-0 sm:max-w-6xl"
        >
          <DialogHeader className="border-b border-stone-200 px-5 py-3.5 dark:border-stone-800">
            <DialogTitle className="flex items-center gap-2 text-base">
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
