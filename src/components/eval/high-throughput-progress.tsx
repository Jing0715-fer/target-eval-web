'use client'

/**
 * 高通量评估运行视图（v2.22）：running / paused / done 三态共用。
 *
 *  · 刊头：状态徽标（运行中 / 已暂停（限流）/ 已完成）+ 组进度 + GOAL 摘要
 *  · 总进度条：组 × 靶点双轨
 *  · 暂停横幅：限流原因 + 「重新开始运行」（配额恢复后手动续跑）— 用户核心诉求
 *  · 组矩阵（v2.25 紧凑化）：响应式多列网格（sm 2 列 / xl 3 列 / 2xl 4 列），
 *    一行可容纳多个组卡；组内靶点 chips 自换行
 *  · 当前组详情（running）：复用 ProgressPanel — 继承 v2.21 的阶段时间线与日志控制台
 *  · 日志回看（v2.25）：「运行日志」按钮开独立弹窗（不再卡片内联展开 — 解决
 *    「展开后无法收回」且大幅压缩组卡占位）；弹窗内复用 EvalLogConsole 全功能
 *  · v2.25 批量下载：当前运行 / 每组均可一键打包 zip（每组子文件夹 + 合并报告 + README）
 */

import { useState } from 'react'
import {
  AlertTriangle,
  CircleCheckBig,
  Download,
  FileDown,
  FileText,
  Gauge,
  Hourglass,
  Layers,
  LoaderCircle,
  PauseCircle,
  RotateCcw,
  Terminal,
  XCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { formatDuration } from './format'
import { EvalLogConsole } from './log-console'
import { ProgressPanel } from './progress-panel'
import type { BatchState } from './use-evaluation-flow'
import type { useHighThroughputFlow } from './use-high-throughput-flow'
import type { HTGroupState, JobDetail } from './types'

export interface HighThroughputViewProps {
  flow: ReturnType<typeof useHighThroughputFlow>
  /** 打开单靶点报告（退出 HT 视图 → 普通结果视图） */
  onOpenJob: (id: string) => void
  /** 打开合并报告（退出 HT 视图 → 合并报告视图） */
  onOpenBatchReport: (id: string) => void
  onNewEvaluation: () => void
}

/** 组状态 → 图标 + 文案 */
function groupStatusMeta(g: HTGroupState): { icon: React.ReactNode; label: string; cls: string } {
  switch (g.status) {
    case 'judging':
      return { icon: <LoaderCircle className="size-3.5 animate-spin text-violet-600 dark:text-violet-400" />, label: '关系判断中', cls: 'border-violet-500/40 bg-violet-500/[0.08] text-violet-700 dark:text-violet-400' }
    case 'evaluating':
      return { icon: <LoaderCircle className="size-3.5 animate-spin text-primary" />, label: '评估中', cls: 'border-primary/40 bg-primary/[0.07] text-primary' }
    case 'merging':
      return { icon: <LoaderCircle className="size-3.5 animate-spin text-violet-600 dark:text-violet-400" />, label: '合并报告生成中', cls: 'border-violet-500/40 bg-violet-500/[0.08] text-violet-700 dark:text-violet-400' }
    case 'done':
      return { icon: <CircleCheckBig className="size-3.5 text-emerald-600 dark:text-emerald-400" />, label: '已完成', cls: 'border-emerald-500/40 bg-emerald-500/[0.08] text-emerald-600 dark:text-emerald-400' }
    case 'paused':
      return { icon: <PauseCircle className="size-3.5 text-amber-600 dark:text-amber-400" />, label: '已暂停', cls: 'border-amber-500/40 bg-amber-500/[0.08] text-amber-600 dark:text-amber-400' }
    case 'canceled':
      return { icon: <XCircle className="size-3.5 text-muted-foreground" />, label: '已停止', cls: 'border-border bg-muted text-muted-foreground' }
    default:
      return { icon: <Hourglass className="size-3.5 text-muted-foreground" />, label: '排队', cls: 'border-border bg-muted text-muted-foreground' }
  }
}

/** 组内靶点 chip 状态点颜色 */
function itemDotCls(status: string): string {
  switch (status) {
    case 'running':
      return 'bg-primary animate-pulse'
    case 'done':
      return 'bg-emerald-500'
    case 'error':
      return 'bg-red-500'
    case 'canceled':
      return 'bg-muted-foreground/40'
    default:
      return 'bg-muted-foreground/25'
  }
}

/** 当前组 → ProgressPanel 的 BatchState 形状（继承组内进度呈现） */
function buildBatchForPanel(g: HTGroupState | undefined): BatchState | null {
  if (!g) return null
  const started = g.items.filter((it) => it.jobId || it.status !== 'pending')
  if (started.length === 0 && g.status === 'judging') {
    return {
      total: g.targets.length,
      currentIndex: 0,
      items: [],
      done: false,
      relationJudging: true,
      relation: g.relation,
    }
  }
  return {
    total: g.targets.length,
    currentIndex: Math.max(0, started.length - 1),
    items: started.map((it) => ({
      key: it.key,
      label: it.label,
      jobId: it.jobId,
      status: it.status === 'pending' ? ('running' as const) : it.status,
      error: it.error,
    })),
    done: g.status === 'done',
    relation: g.relation,
    relationJudging: g.status === 'judging',
    relationError: g.relationError,
    merging: g.status === 'merging',
    mergedError: g.mergedError,
  }
}

export function HighThroughputView({ flow, onOpenJob, onOpenBatchReport, onNewEvaluation }: HighThroughputViewProps) {
  const run = flow.run
  const [groupLogs, setGroupLogs] = useState<Record<number, { loading: boolean; lines: string[] }>>({})
  /** v2.25 日志弹窗：当前打开的组（null = 关闭） */
  const [logDialogGroup, setLogDialogGroup] = useState<number | null>(null)

  if (!run) return null

  const doneGroups = run.groups.filter((g) => g.status === 'done').length
  const doneTargets = run.groups.flatMap((g) => g.items).filter((it) => it.status === 'done').length
  const currentGroup = run.groups.find((g) => g.index === run.currentIndex && (g.status !== 'done' && g.status !== 'canceled'))
  const isRunning = flow.phase === 'running'
  const isPaused = flow.phase === 'paused'
  const isDone = flow.phase === 'done'
  /** 已产出报告的组数（v2.25 批量下载入口可用性） */
  const reportableGroups = run.groups.filter(
    (g) => g.mergedReportId || g.items.some((it) => it.status === 'done' && it.jobId),
  ).length

  const phasePill = isRunning
    ? { icon: <LoaderCircle className="size-3 animate-spin" />, text: '高通量运行中', cls: 'border-primary/40 bg-primary/[0.07] text-primary' }
    : isPaused
      ? { icon: <PauseCircle className="size-3" />, text: run.status === 'interrupted' ? '已中断 · 可恢复' : '已自动暂停（限流）', cls: 'border-amber-500/40 bg-amber-500/[0.08] text-amber-600 dark:text-amber-400' }
      : { icon: <CircleCheckBig className="size-3" />, text: '已完成', cls: 'border-emerald-500/40 bg-emerald-500/[0.08] text-emerald-600 dark:text-emerald-400' }

  /** 组日志回看：拉取组内全部作业的持久化日志并拼接（打开弹窗时按需拉取一次） */
  const openGroupLogs = async (g: HTGroupState) => {
    setLogDialogGroup(g.index)
    if (groupLogs[g.index]) return
    setGroupLogs((prev) => ({ ...prev, [g.index]: { loading: true, lines: [] } }))
    const jobIds = [...new Set(g.items.map((it) => it.jobId).filter((x): x is string => Boolean(x)))]
    const fetched: string[] = []
    if (jobIds.length === 0) {
      fetched.push('（本组没有已提交的作业 — 无运行日志）')
    } else {
      const results = await Promise.allSettled(
        jobIds.map((id) => fetch(`/api/jobs/${id}`, { cache: 'no-store' }).then((r) => (r.ok ? (r.json() as Promise<JobDetail>) : null))),
      )
      results.forEach((res, i) => {
        const item = g.items.find((it) => it.jobId === jobIds[i])
        fetched.push(`── 靶点 ${item?.label ?? jobIds[i]} · 作业 ${jobIds[i]} ──`)
        if (res.status === 'fulfilled' && res.value) {
          fetched.push(...(res.value.logs ?? []))
        } else {
          fetched.push('（日志不可用：作业已清理或服务暂不可用）')
        }
      })
    }
    setGroupLogs((prev) => ({ ...prev, [g.index]: { loading: false, lines: fetched } }))
  }

  /** v2.25 单组批量下载（该组全部报告 → zip 子文件夹归档） */
  const archiveOneGroup = (g: HTGroupState) => {
    void flow.archiveRun(undefined, g.index)
  }

  const groupReportEntry = (g: HTGroupState) => {
    if (g.status !== 'done') return null
    if (g.mergedReportId) {
      return (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onOpenBatchReport(g.mergedReportId as string)}
          className="h-7 gap-1 rounded-lg px-2.5 text-[11px] font-medium"
        >
          <FileText className="size-3" aria-hidden />
          打开合并报告
        </Button>
      )
    }
    const doneItem = g.items.find((it) => it.status === 'done' && it.jobId)
    if (doneItem?.jobId) {
      return (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onOpenJob(doneItem.jobId as string)}
          className="h-7 gap-1 rounded-lg px-2.5 text-[11px] font-medium"
        >
          <FileText className="size-3" aria-hidden />
          查看报告
        </Button>
      )
    }
    return null
  }

  const logDialogState = logDialogGroup != null ? groupLogs[logDialogGroup] : undefined
  const logDialogGroupData = logDialogGroup != null ? run.groups.find((g) => g.index === logDialogGroup) : undefined

  return (
    <div className="flex flex-col gap-5">
      {/* ── 刊头 ── */}
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <p className="lin-eyebrow text-primary">High-Throughput</p>
          <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-medium', phasePill.cls)}>
            {phasePill.icon}
            {phasePill.text}
          </span>
          <span className="ml-auto font-mono text-[10px] text-muted-foreground/60">
            {run.resumedCount > 0 ? `重新开始 × ${run.resumedCount}` : '首次运行'}
          </span>
        </div>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
          <h1 className="text-2xl leading-snug font-semibold tracking-[-0.02em] text-foreground sm:text-[28px]">高通量评估</h1>
          <span className="font-mono text-sm font-normal text-muted-foreground">
            组 {Math.min(run.currentIndex + 1, run.groups.length)}/{run.groups.length} · 靶点 {doneTargets}/{run.totalTargetCount}
          </span>
        </div>
        {run.goal && (
          <div className="max-w-2xl rounded-lg border border-border/70 bg-muted/30 px-3 py-2">
            <span className="lin-eyebrow mr-2 text-amber-600 dark:text-amber-500">GOAL</span>
            <p className="line-clamp-2 text-[13px] leading-relaxed text-muted-foreground" title={run.goal}>
              {run.goal}
            </p>
          </div>
        )}
      </header>

      {/* ── 总进度（组 × 靶点双轨） ── */}
      <div className="flex flex-col gap-2 rounded-xl border border-border bg-card px-4 py-3.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[12.5px] font-medium text-foreground">总体进度</span>
          <span className="font-mono text-[11px] text-muted-foreground">
            已用时 {formatDuration(flow.elapsedSec)} · {doneGroups}/{run.groups.length} 组完成 · {doneTargets}/{run.totalTargetCount} 靶点完成
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-8 shrink-0 font-mono text-[10px] text-muted-foreground/70">组</span>
          <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${(doneGroups / Math.max(1, run.groups.length)) * 100}%` }} />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-8 shrink-0 font-mono text-[10px] text-muted-foreground/70">靶点</span>
          <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary/60 transition-[width] duration-500" style={{ width: `${(doneTargets / Math.max(1, run.totalTargetCount)) * 100}%` }} />
          </div>
        </div>
      </div>

      {/* ── 暂停横幅（限流自动暂停 / 中断恢复） ── */}
      {(isPaused || run.status === 'interrupted') && (
        <div className="flex flex-col gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] px-4 py-3.5">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-amber-700 dark:text-amber-300">
                {run.status === 'interrupted' ? '运行被中断（页面刷新/关闭）' : '评估已自动暂停'}
              </p>
              <p className="mt-0.5 break-words text-xs leading-relaxed text-amber-700/85 dark:text-amber-400/85">
                {run.pausedReason ?? '前端编排因页面刷新中断；服务器侧仍在执行的作业会继续，恢复后自动接上等待结果。'}
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                配额恢复后点击下方「重新开始运行」— 从断点继续（已完成的组与靶点不会重复评估，不浪费配额）。
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => void flow.resumeRun()}
              className="h-9 gap-1.5 rounded-lg bg-primary px-3.5 text-[12.5px] font-semibold text-primary-foreground"
            >
              <RotateCcw className="size-3.5" aria-hidden />
              重新开始运行
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={onNewEvaluation} className="h-9 gap-1.5 rounded-lg px-3.5 text-[12.5px] font-medium">
              保留记录并返回输入
            </Button>
          </div>
        </div>
      )}

      {/* ── 当前组详情（running：复用 ProgressPanel — 阶段时间线 + 实时日志） ── */}
      {isRunning && currentGroup && (
        <section aria-label="当前组详情" className={cn('rounded-xl border bg-card', currentGroup.index === run.currentIndex ? 'border-primary/30' : 'border-border')}>
          <div className="flex flex-wrap items-center gap-2 border-b border-border/70 px-4 py-2.5">
            <Layers className="size-3.5 shrink-0 text-primary" aria-hidden />
            <p className="text-[12.5px] font-semibold text-foreground">当前组 G{String(currentGroup.index + 1).padStart(2, '0')}</p>
            <span className="font-mono text-[10.5px] text-muted-foreground/70">
              {currentGroup.targets.join(' · ')}
            </span>
          </div>
          <div className="px-0 pt-4 sm:px-4">
            <ProgressPanel
              job={flow.displayJob}
              elapsedSec={flow.elapsedSec}
              networkIssue={flow.networkIssue}
              canceling={flow.canceling}
              onCancel={() => void flow.cancelRun()}
              batch={buildBatchForPanel(currentGroup)}
            />
          </div>
        </section>
      )}

      {/* ── 组矩阵（v2.25 紧凑网格：一行多组；xl 3 列 / 2xl 4 列） ── */}
      <section aria-label="分组进度矩阵" className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <p className="lin-eyebrow text-muted-foreground/70">Groups · 分组矩阵（{run.groups.length} 组 · 每组独立报告）</p>
          {/* v2.25 批量下载：当前运行全部报告 → zip（每组子文件夹 + 合并报告 + README） */}
          {reportableGroups > 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={flow.archiving}
              onClick={() => void flow.archiveRun()}
              className="ml-auto h-7 gap-1.5 rounded-lg px-2.5 text-[11px] font-medium"
              title="打包本次运行全部报告为单个 zip（每组一个子文件夹，含合并报告与 README 清单）"
            >
              {flow.archiving
                ? <LoaderCircle className="size-3 animate-spin" aria-hidden />
                : <Download className="size-3" aria-hidden />}
              {flow.archiving ? '打包中…' : `批量下载全部（${reportableGroups} 组）`}
            </Button>
          )}
        </div>
        <ol className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {run.groups.map((g) => {
            const meta = groupStatusMeta(g)
            const logs = groupLogs[g.index]
            const hasReport = g.status === 'done' && (g.mergedReportId || g.items.some((it) => it.status === 'done' && it.jobId))
            return (
              <li
                key={g.index}
                className={cn(
                  'flex flex-col gap-1.5 rounded-xl border bg-card px-3 py-2.5 transition-colors',
                  g.index === run.currentIndex && isRunning ? 'border-primary/40' : 'border-border',
                )}
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="rounded-md bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-primary">
                    G{String(g.index + 1).padStart(2, '0')}
                  </span>
                  <span className={cn('inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 font-mono text-[9.5px] font-medium', meta.cls)}>
                    {meta.icon}
                    {meta.label}
                  </span>
                  <span className="font-mono text-[9.5px] text-muted-foreground/70">
                    {g.targets.length === 0
                      ? (g.items.length > 1 ? `序列 ×${g.items.length}` : '单序列')
                      : g.targets.length > 1
                        ? `复合物 ×${g.targets.length}`
                        : '单靶点'}
                    {g.startedAt && g.finishedAt ? ` · ${formatDuration((g.finishedAt - g.startedAt) / 1000)}` : ''}
                  </span>
                </div>

                {/* 靶点 chips（状态点 + 标签 + 区间后缀 + 错误摘要；紧凑字号） */}
                <div className="flex flex-wrap gap-1">
                  {g.items.map((it) => (
                    <span
                      key={it.key}
                      className={cn(
                        'inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[10px]',
                        it.status === 'error' ? 'border-red-500/30 bg-red-500/[0.05] text-red-700 dark:text-red-400' : 'border-border bg-muted/40 text-foreground/90',
                      )}
                      title={it.error ?? (it.range ? `${it.label} · 评估区间 ${it.range[0]}-${it.range[1]}（仅保留链范围重叠的结构）` : it.label)}
                    >
                      <span className={cn('size-1.5 shrink-0 rounded-full', itemDotCls(it.status))} aria-hidden />
                      <span className="truncate">
                        {it.label}
                        {it.range && <span className="text-primary/90">:{it.range[0]}-{it.range[1]}</span>}
                      </span>
                    </span>
                  ))}
                </div>

                {/* 组级错误摘要（限两行，全文 tooltip） */}
                {(g.relationError || g.mergedError) && (
                  <p className="line-clamp-2 break-words text-[10px] leading-relaxed text-amber-600 dark:text-amber-400" title={[g.relationError ? `关系判断：${g.relationError}` : null, g.mergedError ? `合并报告：${g.mergedError}` : null].filter(Boolean).join(' · ')}>
                    {g.relationError ? `关系判断：${g.relationError}` : ''}
                    {g.relationError && g.mergedError ? ' · ' : ''}
                    {g.mergedError ? `合并报告：${g.mergedError}` : ''}
                  </p>
                )}

                {/* 操作行：报告入口 · 单组批量下载 · 日志弹窗 */}
                <div className="mt-auto flex flex-wrap items-center gap-1 pt-0.5">
                  {hasReport && groupReportEntry(g)}
                  {hasReport && (
                    <button
                      type="button"
                      onClick={() => archiveOneGroup(g)}
                      disabled={flow.archiving}
                      className="inline-flex h-7 items-center gap-1 rounded-lg border border-border bg-muted/40 px-2 font-mono text-[10px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
                      title="打包本组全部报告为 zip 子文件夹归档"
                    >
                      <FileDown className="size-3" aria-hidden />
                      本组打包
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void openGroupLogs(g)}
                    disabled={!g.items.some((it) => it.jobId)}
                    className="inline-flex h-7 items-center gap-1 rounded-lg border border-border bg-muted/40 px-2 font-mono text-[10px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
                    title="新窗口查看本组全部作业的运行日志"
                  >
                    <Terminal className="size-3" aria-hidden />
                    运行日志
                  </button>
                </div>
              </li>
            )
          })}
        </ol>
      </section>

      {/* ── v2.28 统计看板横幅（运行完成：回看入口 / 生成失败提示 / 生成中提示） ── */}
      {isDone && (run.dashboardId || run.dashboardError) && (
        <div className={cn(
          'flex flex-wrap items-center gap-2.5 rounded-xl border px-4 py-3',
          run.dashboardId ? 'border-primary/30 bg-primary/[0.05]' : 'border-amber-500/30 bg-amber-500/[0.06]',
        )}>
          <Gauge className={cn('size-4 shrink-0', run.dashboardId ? 'text-primary' : 'text-amber-600 dark:text-amber-400')} aria-hidden />
          {run.dashboardId ? (
            <>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold text-foreground">统计看板 · AI 整体可行性报告已生成</p>
                <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                  评分统计（分布/方法可用性/覆盖率）+ 每靶点一句话结论（能否做）+ 单独报告离线链接；HTML 已自动下载，zip「批量下载全部」后链接可直接点开。
                </p>
              </div>
              <a
                href={`/api/evaluate/ht-dashboard?id=${encodeURIComponent(run.dashboardId)}&inline=1`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[12px] font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
              >
                <Gauge className="size-3.5" aria-hidden />
                打开统计看板
              </a>
            </>
          ) : (
            <p className="min-w-0 flex-1 text-[12px] leading-relaxed text-amber-700/90 dark:text-amber-400/90">
              统计看板生成失败：{run.dashboardError}（运行结果不受影响；重新下载 zip 会重试打包可用的看板）
            </p>
          )}
        </div>
      )}

      {/* ── 底部操作（v2.25：取消按钮与内容区拉开间距 mt-2；说明文字上移） ── */}
      <div className="flex flex-col gap-2.5">
        <span className="font-mono text-[10.5px] text-muted-foreground/60">
          每组报告完成即自动下载到本机下载目录的同一文件夹（TargetEval_HT_日期_Ng/…）· 运行完成后统计看板（评分统计 + AI 整体可行性报告）自动下载 · 报告与日志保留在服务端 30 天 · 运行结构保留在浏览器（最近 5 次）
        </span>
        <div className="flex flex-wrap items-center gap-2.5">
          {isRunning && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={flow.canceling}
              onClick={() => void flow.cancelRun()}
              className="h-9 gap-1.5 rounded-lg px-3.5 text-[12.5px] font-medium text-red-600 hover:bg-red-500/10 hover:text-red-600 dark:text-red-400"
            >
              <XCircle className="size-3.5" aria-hidden />
              {flow.canceling ? '正在停止…' : '停止运行（保留已完成组）'}
            </Button>
          )}
          {isDone && (
            <Button type="button" size="sm" onClick={onNewEvaluation} className="h-9 gap-1.5 rounded-lg bg-primary px-3.5 text-[12.5px] font-semibold text-primary-foreground">
              开始新的高通量评估
            </Button>
          )}
          {reportableGroups > 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={flow.archiving}
              onClick={() => void flow.archiveRun()}
              className="h-9 gap-1.5 rounded-lg px-3.5 text-[12.5px] font-medium"
              title="打包本次运行全部报告为单个 zip（每组一个子文件夹，含合并报告与 README 清单）"
            >
              {flow.archiving
                ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
                : <Download className="size-3.5" aria-hidden />}
              {flow.archiving ? '打包中…' : `批量下载全部报告（${reportableGroups} 组）`}
            </Button>
          )}
        </div>
      </div>

      {/* ── v2.25 组运行日志弹窗（替代卡片内联展开：可随时关闭、不占组卡空间） ── */}
      <Dialog open={logDialogGroup != null} onOpenChange={(open) => { if (!open) setLogDialogGroup(null) }}>
        <DialogContent className="flex max-h-[85dvh] min-w-0 flex-col gap-3 overflow-hidden p-0 sm:max-w-3xl lg:max-w-4xl">
          <DialogHeader className="shrink-0 border-b border-border/70 px-5 pt-4 pb-3">
            <DialogTitle className="flex flex-wrap items-center gap-2 text-base font-semibold">
              <Terminal className="size-4 shrink-0 text-primary" aria-hidden />
              第 {logDialogGroup != null ? logDialogGroup + 1 : 0} 组运行日志
              {logDialogGroupData && (
                <span className="font-mono text-[11px] font-normal text-muted-foreground/70">
                  {logDialogGroupData.targets.length > 0
                    ? logDialogGroupData.targets.join(' · ')
                    : `${logDialogGroupData.items.length} 条序列`}
                </span>
              )}
            </DialogTitle>
            <DialogDescription className="text-xs">
              组内全部作业的持久化日志拼接回看（过滤 / 搜索 / 复制 / 下载与实时页一致）
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-auto px-4 pb-4">
            {!logDialogState ? (
              <p className="flex items-center gap-1.5 px-1 py-6 text-xs text-muted-foreground">
                <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
                正在拉取本组运行日志…
              </p>
            ) : logDialogState.loading ? (
              <p className="flex items-center gap-1.5 px-1 py-6 text-xs text-muted-foreground">
                <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
                正在拉取本组运行日志…
              </p>
            ) : (
              <EvalLogConsole logs={logDialogState.lines} live={false} title={`第 ${(logDialogGroup ?? 0) + 1} 组运行日志`} className="shadow-none" />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
