'use client'

/**
 * 高通量评估运行视图（v2.22）：running / paused / stopped / done 四态共用。
 *
 *  · 刊头：状态徽标（运行中 / 已暂停（限流或手动）/ 已停止（可恢复）/ 已完成）+ 组进度 + GOAL 摘要
 *  · 总进度条：组 × 靶点双轨
 *  · 暂停横幅：原因 + 「重新开始运行」（配额恢复后手动续跑）— 用户核心诉求
 *  · v2.38 停止横幅：手动停止后可恢复（继续运行 / 重跑失败项 / 返回输入）
 *  · v2.38 靶点级操作（非 running）：每个靶点 chip 可跳过/恢复/重跑；组级
 *    「重跑失败」「跳过未开始」；「导入报告（zip）」把已有报告的靶点标跳过
 *  · 组矩阵（v2.25 紧凑化）：响应式多列网格（sm 2 列 / xl 3 列 / 2xl 4 列），
 *    一行可容纳多个组卡；组内靶点 chips 自换行
 *  · 当前组详情（running）：复用 ProgressPanel — 继承 v2.21 的阶段时间线与日志控制台
 *  · 日志回看（v2.25）：「运行日志」按钮开独立弹窗；弹窗内复用 EvalLogConsole 全功能
 *  · v2.25 批量下载：当前运行 / 每组均可一键打包 zip（每组子文件夹 + 合并报告 + README）
 */

import { useRef, useState } from 'react'
import {
  AlertTriangle,
  Ban,
  CircleCheckBig,
  Download,
  FileArchive,
  FileDown,
  FileText,
  Gauge,
  Hourglass,
  Layers,
  LoaderCircle,
  Pause,
  PauseCircle,
  Play,
  RotateCcw,
  ExternalLink,
  Terminal,
  Undo2,
  XCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { toast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import { formatDuration } from './format'
import { cacheJobDetail, getCachedJobDetail } from './job-cache'
import { EvalLogConsole } from './log-console'
import { ProgressPanel } from './progress-panel'
import type { BatchItem, BatchState } from './use-evaluation-flow'
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

/** 组状态 → 图标 + 文案；v2.42 诚实化：done 组内含失败/取消/报告不完整项时
 *  不再显示绿色「已完成」，改琥珀色「完成（N 未成功）」— 与靶点真实结局一致
 *  （用户反馈：作业被取消后组徽章仍显示已完成，误导判断） */
function groupStatusMeta(g: HTGroupState): { icon: React.ReactNode; label: string; cls: string } {
  switch (g.status) {
    case 'judging':
      return { icon: <LoaderCircle className="size-3.5 animate-spin text-violet-600 dark:text-violet-400" />, label: '关系判断中', cls: 'border-violet-500/40 bg-violet-500/[0.08] text-violet-700 dark:text-violet-400' }
    case 'evaluating':
      return { icon: <LoaderCircle className="size-3.5 animate-spin text-primary" />, label: '评估中', cls: 'border-primary/40 bg-primary/[0.07] text-primary' }
    case 'merging':
      return { icon: <LoaderCircle className="size-3.5 animate-spin text-violet-600 dark:text-violet-400" />, label: '合并报告生成中', cls: 'border-violet-500/40 bg-violet-500/[0.08] text-violet-700 dark:text-violet-400' }
    case 'done': {
      const notOk = g.items.filter((it) => (it.status === 'error' || it.status === 'canceled' || (it.status === 'done' && it.reportIncomplete))).length
      if (notOk > 0) {
        return { icon: <AlertTriangle className="size-3.5 text-amber-600 dark:text-amber-400" />, label: `完成（${notOk} 未成功）`, cls: 'border-amber-500/40 bg-amber-500/[0.08] text-amber-600 dark:text-amber-400' }
      }
      return { icon: <CircleCheckBig className="size-3.5 text-emerald-600 dark:text-emerald-400" />, label: '已完成', cls: 'border-emerald-500/40 bg-emerald-500/[0.08] text-emerald-600 dark:text-emerald-400' }
    }
    case 'paused':
      return { icon: <PauseCircle className="size-3.5 text-amber-600 dark:text-amber-400" />, label: '已暂停', cls: 'border-amber-500/40 bg-amber-500/[0.08] text-amber-600 dark:text-amber-400' }
    case 'canceled':
      return { icon: <XCircle className="size-3.5 text-muted-foreground" />, label: '已停止', cls: 'border-border bg-muted text-muted-foreground' }
    default:
      return { icon: <Hourglass className="size-3.5 text-muted-foreground" />, label: '排队', cls: 'border-border bg-muted text-muted-foreground' }
  }
}

/** v2.60：导入既有报告而跳过的靶点（完成口径计入「载入」；旧版运行回退 skipNote 前缀） */
function isImportedItem(it: { imported?: boolean; status: string; skipNote?: string }): boolean {
  return it.imported === true || (it.status === 'skipped' && (it.skipNote ?? '').startsWith('已导入'))
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
    case 'skipped':
      return 'bg-sky-500/60'
    case 'canceled':
      return 'bg-muted-foreground/40'
    default:
      return 'bg-muted-foreground/25'
  }
}

/** v2.42：单靶点「查看报告」— 新标签页打开。
 *  序列靶点/非关联组 = 独立报告 HTML（/api/jobs/{id}/report）；
 *  关联复合物组（deferred，无独立 HTML）→ 组合并报告 inline（含本靶点单独评估页） */
function openTargetReport(g: HTGroupState, it: { jobId?: string; label: string; sequence?: string }): void {
  if (!it.jobId) return
  const deferred = !it.sequence && g.relation?.related === true && g.items.length > 1
  if (deferred) {
    if (g.mergedReportId) {
      window.open(`/api/evaluate/batch-report?id=${encodeURIComponent(g.mergedReportId)}&inline=1`, '_blank', 'noopener')
    } else {
      toast({
        title: '暂无可打开的报告',
        description: '该靶点属关联复合物组，报告并入组合并评估报告（本组尚未生成合并报告 — 可先重跑/补齐后查看）。',
        variant: 'destructive',
      })
    }
    return
  }
  window.open(`/api/jobs/${it.jobId}/report`, '_blank', 'noopener')
}

/** 当前组 → ProgressPanel 的 BatchState 形状（继承组内进度呈现；v2.38 跳过项不进面板） */
function buildBatchForPanel(g: HTGroupState | undefined): BatchState | null {
  if (!g) return null
  const started = g.items.filter((it) => it.status !== 'skipped' && (it.jobId || it.status !== 'pending'))
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
      // skipped 已在上方过滤；TS 无法从 filter 收窄 — 显式排除
      status: (it.status === 'pending' ? 'running' : it.status === 'skipped' ? 'canceled' : it.status) as BatchItem['status'],
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
  /** v2.38 报告 zip 导入（非 running 阶段） */
  const [importingZip, setImportingZip] = useState(false)
  const zipInputRef = useRef<HTMLInputElement>(null)

  if (!run) return null

  const allItems = run.groups.flatMap((g) => g.items)
  const doneGroups = run.groups.filter((g) => g.status === 'done').length
  const doneTargets = allItems.filter((it) => it.status === 'done').length
  /** v2.60：导入既有报告而跳过的靶点（计入完成口径 — 「N 评估 + M 载入」；
   *  旧版 localStorage 运行无 imported 字段，回退按 skipNote 前缀「已导入」识别） */
  const importedTargets = allItems.filter((it) => isImportedItem(it)).length
  /** 完成口径：评估完成 + 载入（进度条与完成数展示） */
  const settledTargets = doneTargets + importedTargets
  const skippedTargets = allItems.filter((it) => it.status === 'skipped' && !isImportedItem(it)).length
  const failedTargets = allItems.filter((it) => it.status === 'error' || it.status === 'canceled').length
  /** v2.41：done 但 LLM 报告未完整生成（部分章节失败）— 可重跑补齐 */
  const incompleteTargets = allItems.filter((it) => it.status === 'done' && it.reportIncomplete).length
  /** v2.41：全局重跑入口的靶点数（失败/中断 + 报告不完整） */
  const retryableTargets = failedTargets + incompleteTargets
  const currentGroup = run.groups.find((g) => g.index === run.currentIndex && (g.status !== 'done' && g.status !== 'canceled'))
  const isRunning = flow.phase === 'running'
  const isPaused = flow.phase === 'paused'
  const isStopped = flow.phase === 'stopped'
  const isDone = flow.phase === 'done'
  /** 非运行阶段（可编辑靶点选择 / 导入 zip） */
  const editable = !isRunning
  /** 已产出报告的组数（v2.25 批量下载入口可用性） */
  const reportableGroups = run.groups.filter(
    (g) => g.mergedReportId || g.items.some((it) => it.status === 'done' && it.jobId),
  ).length

  const phasePill = isRunning
    ? { icon: <LoaderCircle className="size-3 animate-spin" />, text: '高通量运行中', cls: 'border-primary/40 bg-primary/[0.07] text-primary' }
    : isPaused
      ? { icon: <PauseCircle className="size-3" />, text: run.status === 'interrupted' ? '已中断 · 可恢复' : '已暂停（可恢复）', cls: 'border-amber-500/40 bg-amber-500/[0.08] text-amber-600 dark:text-amber-400' }
      : isStopped
        ? { icon: <PauseCircle className="size-3" />, text: '已停止 · 可恢复', cls: 'border-amber-500/40 bg-amber-500/[0.08] text-amber-600 dark:text-amber-400' }
        : { icon: <CircleCheckBig className="size-3" />, text: '已完成', cls: 'border-emerald-500/40 bg-emerald-500/[0.08] text-emerald-600 dark:text-emerald-400' }

  /** v2.38→v2.49 报告导入（当前运行；zip 归档 / 单独 HTML，可多选）：匹配到的未评估靶点标跳过；
   *  未命中文件附带逐文件原因（v2.49 — 此前只有一句「未命中」，用户无从排查） */
  const handleZipImport = async (files: FileList | null | undefined) => {
    const list = files ? Array.from(files) : []
    if (list.length === 0 || importingZip) return
    setImportingZip(true)
    try {
      const result = await flow.importArchive(list)
      // v2.49 逐文件诊断文本（未命中原因 + 已完成提示）
      const missTail = result.missLines.length > 0
        ? `\n未命中文件原因：\n${result.missLines.slice(0, 5).join('\n')}${result.missLines.length > 5 ? `\n…等共 ${result.missLines.length} 个文件` : ''}`
        : ''
      const doneNote = result.doneOnlyCount > 0
        ? `\n另有 ${result.doneOnlyCount} 个文件的靶点在当前运行中已完成/进行中（无需导入）。`
        : ''
      // v2.70：原文留存失败提示（统计解析不受影响 — 仅弹出页无原文可嵌）
      const uploadNote = result.uploadMissed > 0
        ? `\n注意：${result.uploadMissed} 份报告原文未能内嵌（体积超 32MB 上限或服务端留存失败）— 评分与结论已照常解析进汇总表格，对应「完整报告」弹出页将显示已解析的评分统计；完整原文可直接打开导入的报告文件。`
        : ''
      if (result.matched > 0) {
        toast({
          title: `已导入 ${result.matched} 个靶点的既有报告`,
          description: (
            <div className="whitespace-pre-line">
              {`这些靶点将跳过评估（报告见导入的文件）；点击「继续运行」评估其余靶点。${doneNote}${uploadNote}${missTail}`}
            </div>
          ),
        })
      } else if (result.doneOnlyCount > 0 && result.missLines.length === 0) {
        toast({
          title: '导入的报告对应靶点均已完成',
          description: '报告对应的靶点在当前运行中已完成或正在进行 — 无需导入。',
        })
      } else {
        toast({
          title: '导入的报告中没有匹配到当前运行的靶点',
          description: (
            <div className="whitespace-pre-line">
              {`已识别报告但未命中任何待评估靶点（UniProt/序列/区间需一致）。${doneNote}${missTail || '\n可改用「批量下载全部」的 zip 导入（清单含组号与序列指纹，匹配最可靠）。'}`}
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

  /** 组日志回看：拉取组内全部作业的持久化日志并拼接。
   *  v2.42：每次打开都重新拉取（旧缓存永不刷新 — 停止/重跑后 item.jobId 变了，
   *  弹窗仍在展示旧作业的日志，用户误以为任务被取消/未重跑）。
   *  服务端 404（Serverless 实例回收）→ 回退浏览器缓存副本的日志 */
  const openGroupLogs = async (g: HTGroupState) => {
    setLogDialogGroup(g.index)
    setGroupLogs((prev) => ({ ...prev, [g.index]: { loading: true, lines: prev[g.index]?.lines ?? [] } }))
    const jobIds = [...new Set(g.items.map((it) => it.jobId).filter((x): x is string => Boolean(x)))]
    const fetched: string[] = []
    if (jobIds.length === 0) {
      fetched.push('（本组没有已提交的作业 — 无运行日志）')
    } else {
      const results = await Promise.allSettled(
        jobIds.map((id) =>
          fetch(`/api/jobs/${id}`, { cache: 'no-store' }).then(async (r) => {
            if (r.ok) {
              const data = (await r.json()) as JobDetail
              // v2.37：服务端仍在的终态详情 → 立即留入本地缓存
              // （本弹窗下次打开、以及实例回收后均可离线回看）
              if (data.status === 'done' || data.status === 'error') cacheJobDetail(data)
              return data
            }
            // 404 → 尝试浏览器本地缓存副本（作业完成/回看时已自动存入）
            if (r.status === 404) {
              const cached = getCachedJobDetail(id)
              if (cached) return cached
            }
            return null
          }),
        ),
      )
      results.forEach((res, i) => {
        const item = g.items.find((it) => it.jobId === jobIds[i])
        fetched.push(`── 靶点 ${item?.label ?? jobIds[i]} · 作业 ${jobIds[i]} ──`)
        if (res.status === 'fulfilled' && res.value) {
          if (res.value.fromCache) fetched.push('（服务端数据已随部署实例回收，以下为浏览器缓存副本）')
          fetched.push(...(res.value.logs ?? []))
        } else {
          fetched.push(
            '（日志不可用：服务端已无此作业（部署平台为 Serverless 实例，空闲回收后运行数据不持久），本浏览器当时未留存副本。）',
            '提示：报告 HTML 已在作业完成时自动下载到本机下载目录（如未拦截弹窗），可从那里查看结果。',
          )
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
    <div className="flex flex-col gap-5 pb-5 sm:pb-7">
      {/* ── 刊头 ── */}
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <p className="lin-eyebrow text-primary">High-Throughput</p>
          <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-medium', phasePill.cls)}>
            {phasePill.icon}
            {phasePill.text}
          </span>
          <span className="ml-auto font-mono text-[10px] text-muted-foreground/80">
            {run.resumedCount > 0 ? `重新开始 × ${run.resumedCount}` : '首次运行'}
          </span>
        </div>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
          <h1 className="text-2xl leading-snug font-semibold tracking-[-0.02em] text-foreground sm:text-[28px]">高通量评估</h1>
          <span className="font-mono text-sm font-normal text-muted-foreground">
            组 {doneGroups}/{run.groups.length} 完成 · 靶点 {settledTargets}/{run.totalTargetCount}
            {importedTargets > 0 ? `（${doneTargets} 评估 + ${importedTargets} 载入）` : ''}
            {skippedTargets > 0 ? ` · 跳过 ${skippedTargets}` : ''}
            {!isRunning && failedTargets > 0 ? ` · 失败 ${failedTargets}` : ''}
            {!isRunning && incompleteTargets > 0 ? ` · 报告不完整 ${incompleteTargets}` : ''}
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
            已用时 {formatDuration(flow.elapsedSec)} · {doneGroups}/{run.groups.length} 组完成 · {settledTargets}/{run.totalTargetCount} 靶点完成{importedTargets > 0 ? `（${doneTargets} 评估 + ${importedTargets} 载入）` : ''}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-8 shrink-0 font-mono text-[10px] text-muted-foreground/85">组</span>
          <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${(doneGroups / Math.max(1, run.groups.length)) * 100}%` }} />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-8 shrink-0 font-mono text-[10px] text-muted-foreground/85">靶点</span>
          <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary/60 transition-[width] duration-500" style={{ width: `${(settledTargets / Math.max(1, run.totalTargetCount)) * 100}%` }} />
          </div>
        </div>
      </div>

      {/* ── 暂停横幅（限流自动暂停 / 手动暂停 / 中断恢复） ── */}
      {(isPaused || run.status === 'interrupted') && (
        <div className="flex flex-col gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] px-4 py-3.5">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-amber-700 dark:text-amber-300">
                {run.status === 'interrupted' ? '运行被中断（页面刷新/关闭）' : '评估已暂停'}
              </p>
              <p className="mt-0.5 break-words text-xs leading-relaxed text-amber-700/85 dark:text-amber-400/85">
                {run.pausedReason ?? '前端编排因页面刷新中断；服务器侧仍在执行的作业会继续，恢复后自动接上等待结果。'}
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                点击下方「继续运行」从断点恢复（已完成的组与靶点不会重复评估，不浪费配额）；也可先在组卡片中跳过/重跑指定靶点，或导入既有报告 zip 跳过已完成靶点。
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
              继续运行
            </Button>
            {retryableTargets > 0 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void flow.retryFailed()}
                className="h-9 gap-1.5 rounded-lg px-3.5 text-[12.5px] font-medium"
                title={`重置全部 ${retryableTargets} 个失败/中断${incompleteTargets > 0 ? `/报告不完整（${incompleteTargets}）` : ''}靶点并立即继续运行`}
              >
                <Play className="size-3.5" aria-hidden />
                {incompleteTargets > 0 && failedTargets === 0
                  ? `重跑报告不完整项（${incompleteTargets}）并继续`
                  : `重跑失败/不完整项（${retryableTargets}）并继续`}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={importingZip}
              onClick={() => zipInputRef.current?.click()}
              className="h-9 gap-1.5 rounded-lg px-3.5 text-[12.5px] font-medium"
              title="导入既有报告（zip 归档或单独的报告 HTML，可多选）— 匹配到的靶点直接跳过，不重复评估"
            >
              {importingZip ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : <FileArchive className="size-3.5" aria-hidden />}
              {importingZip ? '导入中…' : '导入报告（zip/HTML）'}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={onNewEvaluation} className="h-9 gap-1.5 rounded-lg px-3.5 text-[12.5px] font-medium">
              保留记录并返回输入
            </Button>
          </div>
        </div>
      )}

      {/* ── v2.38 停止横幅（手动停止 — 可恢复） ── */}
      {isStopped && (
        <div className="flex flex-col gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] px-4 py-3.5">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-amber-700 dark:text-amber-300">运行已手动停止（可恢复）</p>
              <p className="mt-0.5 break-words text-xs leading-relaxed text-amber-700/85 dark:text-amber-400/85">
                已完成 {settledTargets} 个靶点的结果保留{importedTargets > 0 ? `（${doneTargets} 个评估完成 + ${importedTargets} 个载入既有报告）` : ''}{skippedTargets > 0 ? `；另手动跳过 ${skippedTargets} 个` : ''}；未开始/被中断的靶点可随时继续，失败的靶点可单独重跑。
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                「继续运行」从断点恢复（已完成的靶点不重复评估）；也可先在组卡片中跳过不需要的靶点、重跑失败项，或导入既有报告 zip 跳过已完成靶点。
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
              继续运行
            </Button>
            {retryableTargets > 0 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void flow.retryFailed()}
                className="h-9 gap-1.5 rounded-lg px-3.5 text-[12.5px] font-medium"
                title={`重置全部 ${retryableTargets} 个失败/中断${incompleteTargets > 0 ? `/报告不完整（${incompleteTargets}）` : ''}靶点并立即继续运行`}
              >
                <Play className="size-3.5" aria-hidden />
                {incompleteTargets > 0 && failedTargets === 0
                  ? `重跑报告不完整项（${incompleteTargets}）并继续`
                  : `重跑失败/不完整项（${retryableTargets}）并继续`}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={importingZip}
              onClick={() => zipInputRef.current?.click()}
              className="h-9 gap-1.5 rounded-lg px-3.5 text-[12.5px] font-medium"
              title="导入既有报告（zip 归档或单独的报告 HTML，可多选）— 匹配到的靶点直接跳过，不重复评估"
            >
              {importingZip ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : <FileArchive className="size-3.5" aria-hidden />}
              {importingZip ? '导入中…' : '导入报告（zip/HTML）'}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={onNewEvaluation} className="h-9 gap-1.5 rounded-lg px-3.5 text-[12.5px] font-medium">
              保留记录并返回输入
            </Button>
          </div>
        </div>
      )}

      {/* v2.38 隐藏的报告文件选择器（暂停/停止/完成阶段共用；v2.44 支持 zip + 单独 HTML 多选） */}
      <input
        ref={zipInputRef}
        type="file"
        accept=".zip,.html,.htm"
        multiple
        className="hidden"
        onChange={(e) => void handleZipImport(e.target.files)}
      />

      {/* ── 当前组详情（running：复用 ProgressPanel — 阶段时间线 + 实时日志） ── */}
      {isRunning && currentGroup && (
        <section aria-label="当前组详情" className={cn('rounded-xl border bg-card', currentGroup.index === run.currentIndex ? 'border-primary/30' : 'border-border')}>
          <div className="flex flex-wrap items-center gap-2 border-b border-border/70 px-4 py-2.5">
            <Layers className="size-3.5 shrink-0 text-primary" aria-hidden />
            <p className="text-[12.5px] font-semibold text-foreground">当前组 G{String(currentGroup.index + 1).padStart(2, '0')}</p>
            <span className="font-mono text-[10.5px] text-muted-foreground/85">
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
          <p className="lin-eyebrow text-muted-foreground/85">Groups · 分组矩阵（{run.groups.length} 组 · 每组独立报告）</p>
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
            const gFailed = g.items.filter((it) => it.status === 'error' || it.status === 'canceled').length
            /** v2.41：本组报告不完整（done 但部分章节失败）靶点数 */
            const gIncomplete = g.items.filter((it) => it.status === 'done' && it.reportIncomplete).length
            const gPending = g.items.filter((it) => it.status === 'pending').length
            const gImported = g.items.filter((it) => isImportedItem(it)).length
            const gSkipped = g.items.filter((it) => it.status === 'skipped' && !isImportedItem(it)).length
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
                  <span className="font-mono text-[9.5px] text-muted-foreground/85">
                    {g.targets.length === 0
                      ? (g.items.length > 1 ? `序列 ×${g.items.length}` : '单序列')
                      : g.targets.length > 1
                        ? `复合物 ×${g.targets.length}`
                        : '单靶点'}
                    {gImported > 0 ? ` · 载入 ${gImported}` : ''}
                    {gSkipped > 0 ? ` · 跳过 ${gSkipped}` : ''}
                    {gIncomplete > 0 ? ` · 报告不完整 ${gIncomplete}` : ''}
                    {g.startedAt && g.finishedAt ? ` · ${formatDuration((g.finishedAt - g.startedAt) / 1000)}` : ''}
                  </span>
                </div>

                {/* 靶点 chips（状态点 + 标签 + 区间后缀 + 错误摘要；紧凑字号）
                    v2.38：非运行阶段 chip 尾部附小操作钮 — 跳过/恢复（Ban/Undo2）、
                    重跑（RotateCcw，失败/中断/跳过项）；v2.41：报告不完整的 done 项
                    琥珀色标记 + 可重跑（补齐缺失章节） */}
                <div className="flex flex-wrap gap-1">
                  {g.items.map((it) => {
                    // v2.41：done+报告不完整 → 可操作（重跑）；其余 done 不可操作
                    const actionable = editable && it.status !== 'running' && (it.status !== 'done' || it.reportIncomplete)
                    // v2.60：导入既有报告的靶点 — emerald 徽标（计入完成，不似手动跳过的删除线）
                    const imported = isImportedItem(it)
                    return (
                      <span
                        key={it.key}
                        className={cn(
                          'inline-flex max-w-full items-center gap-1 rounded-md border py-0.5 pl-1.5 font-mono text-[10px]',
                          actionable ? 'pr-0.5' : 'pr-1.5',
                          it.status === 'error'
                            ? 'border-red-500/30 bg-red-500/[0.05] text-red-700 dark:text-red-400'
                            : it.status === 'skipped'
                              ? imported
                                ? 'border-emerald-500/30 bg-emerald-500/[0.05] text-emerald-700/90 dark:text-emerald-400/90'
                                : 'border-sky-500/30 bg-sky-500/[0.05] text-sky-700/80 line-through decoration-sky-500/40 dark:text-sky-400/80'
                              : it.status === 'done' && it.reportIncomplete
                                ? 'border-amber-500/40 bg-amber-500/[0.06] text-amber-700 dark:text-amber-400'
                                : 'border-border bg-muted/40 text-foreground/90',
                        )}
                        title={it.reportMissingNote ?? it.skipNote ?? it.error ?? (it.range ? `${it.label} · 评估区间 ${it.range[0]}-${it.range[1]}（仅保留链范围重叠的结构）` : it.label)}
                      >
                        <span className={cn('size-1.5 shrink-0 rounded-full', it.status === 'done' && it.reportIncomplete ? 'bg-amber-500' : imported ? 'bg-emerald-500/70' : itemDotCls(it.status))} aria-hidden />
                        <span className="truncate">
                          {it.label}
                          {it.range && <span className="text-primary/90">:{it.range[0]}-{it.range[1]}</span>}
                        </span>
                        {imported && (
                          <span className="shrink-0 font-sans text-[9px] font-medium text-emerald-600/90 dark:text-emerald-400/90" title={it.skipNote}>载入</span>
                        )}
                        {it.status === 'done' && it.reportIncomplete && (
                          <span className="shrink-0 font-sans text-[9px] font-medium text-amber-600/90 dark:text-amber-400/90" title={it.reportMissingNote}>不完整</span>
                        )}
                        {/* v2.42：靶点完成后即可新标签页查看报告（独立报告 / 关联组并入合并报告） */}
                        {it.status === 'done' && it.jobId && (
                          <button
                            type="button"
                            onClick={() => openTargetReport(g, it)}
                            className="flex size-4.5 shrink-0 items-center justify-center rounded text-primary/70 transition-colors hover:bg-accent hover:text-primary"
                            title="新标签页查看此靶点的报告"
                            aria-label={`查看靶点 ${it.label} 的报告`}
                          >
                            <ExternalLink className="size-2.5" aria-hidden />
                          </button>
                        )}
                        {actionable && (
                          <span className="inline-flex shrink-0 items-center gap-0.5">
                            {(it.status === 'error' || it.status === 'canceled' || it.status === 'skipped' || (it.status === 'done' && it.reportIncomplete)) && (
                              <button
                                type="button"
                                onClick={() => flow.retryItem(g.index, it.key)}
                                className="flex size-4.5 items-center justify-center rounded text-muted-foreground/85 transition-colors hover:bg-accent hover:text-primary"
                                title={it.status === 'done' ? '重跑此靶点（补齐缺失的报告章节）' : '重跑此靶点（重置为待评估）'}
                                aria-label={`重跑靶点 ${it.label}`}
                              >
                                <RotateCcw className="size-2.5" aria-hidden />
                              </button>
                            )}
                            {it.status === 'skipped' ? (
                              <button
                                type="button"
                                onClick={() => flow.toggleSkipItem(g.index, it.key)}
                                className="flex size-4.5 items-center justify-center rounded text-muted-foreground/85 transition-colors hover:bg-accent hover:text-emerald-600"
                                title="恢复评估此靶点"
                                aria-label={`恢复靶点 ${it.label}`}
                              >
                                <Undo2 className="size-2.5" aria-hidden />
                              </button>
                            ) : it.status !== 'done' ? (
                              <button
                                type="button"
                                onClick={() => flow.toggleSkipItem(g.index, it.key)}
                                className="flex size-4.5 items-center justify-center rounded text-muted-foreground/85 transition-colors hover:bg-accent hover:text-amber-600"
                                title="跳过此靶点（不评估，可随时恢复）"
                                aria-label={`跳过靶点 ${it.label}`}
                              >
                                <Ban className="size-2.5" aria-hidden />
                              </button>
                            ) : null}
                          </span>
                        )}
                      </span>
                    )
                  })}
                </div>

                {/* 组级错误摘要（限两行，全文 tooltip） */}
                {(g.relationError || g.mergedError) && (
                  <p className="line-clamp-2 break-words text-[10px] leading-relaxed text-amber-600 dark:text-amber-400" title={[g.relationError ? `关系判断：${g.relationError}` : null, g.mergedError ? `合并报告：${g.mergedError}` : null].filter(Boolean).join(' · ')}>
                    {g.relationError ? `关系判断：${g.relationError}` : ''}
                    {g.relationError && g.mergedError ? ' · ' : ''}
                    {g.mergedError ? `合并报告：${g.mergedError}` : ''}
                  </p>
                )}

                {/* 操作行：报告入口 · 单组批量下载 · 日志弹窗 · v2.38 组级重跑失败/跳过未开始 */}
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
                  {editable && (gFailed > 0 || gIncomplete > 0) && (
                    <button
                      type="button"
                      onClick={() => flow.retryGroupFailures(g.index)}
                      className="inline-flex h-7 items-center gap-1 rounded-lg border border-border bg-muted/40 px-2 font-mono text-[10px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-primary"
                      title={`重置本组 ${gFailed + gIncomplete} 个失败/中断${gIncomplete > 0 ? `/报告不完整（${gIncomplete}）` : ''}靶点（点击「继续运行」后重跑）`}
                    >
                      <RotateCcw className="size-3" aria-hidden />
                      重跑失败/不完整（{gFailed + gIncomplete}）
                    </button>
                  )}
                  {editable && gPending > 0 && (
                    <button
                      type="button"
                      onClick={() => flow.skipGroupPending(g.index)}
                      className="inline-flex h-7 items-center gap-1 rounded-lg border border-border bg-muted/40 px-2 font-mono text-[10px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-amber-600"
                      title={`跳过本组 ${gPending} 个未开始的靶点（不评估，可随时恢复）`}
                    >
                      <Ban className="size-3" aria-hidden />
                      跳过未开始（{gPending}）
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

      {/* ── v2.28 统计看板横幅（运行完成：生成中 / 回看入口 / 生成失败提示） ── */}
      {isDone && (run.dashboardId || run.dashboardError || run.dashboardPending) && (
        <div className={cn(
          'flex flex-wrap items-center gap-2.5 rounded-xl border px-4 py-3',
          run.dashboardId
            ? 'border-primary/30 bg-primary/[0.05]'
            : run.dashboardPending
              ? 'border-border bg-muted/40'
              : 'border-amber-500/30 bg-amber-500/[0.06]',
        )}>
          <Gauge
            className={cn(
              'size-4 shrink-0',
              run.dashboardId
                ? 'text-primary'
                : run.dashboardPending
                  ? 'animate-pulse text-muted-foreground'
                  : 'text-amber-600 dark:text-amber-400',
            )}
            aria-hidden
          />
          {run.dashboardId ? (
            <>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold text-foreground">汇总报告 · 统计看板 + 全靶点总表已生成</p>
                <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                  单文件离线自包含：批次统计（分布/方法可用性/覆盖率）+ 全靶点结论总表（靶点 / UniProt / 序列三列分列，总分与 X-ray/Cryo-EM/NMR 评分可单独排序，回补 UniProt 徽标醒目可点，序列一键复制，「完整报告」弹出与下载版完全一致的单靶点报告 — 原文内嵌）+ AI 整体可行性报告；页宽随浏览器自适应；HTML 已自动下载，zip「批量下载全部」后离线链接可直接点开。
                </p>
              </div>
              <a
                href={`/api/evaluate/ht-dashboard?id=${encodeURIComponent(run.dashboardId)}&inline=1`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[12px] font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
              >
                <Gauge className="size-3.5" aria-hidden />
                打开汇总报告
              </a>
              {/* v2.44：回看已完成运行时可手动重新生成汇总报告（重跑后刷新 / 旧报告过期） */}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={run.dashboardPending}
                onClick={() => void flow.regenerateDashboard()}
                className="h-8 gap-1.5 rounded-lg px-3 text-[12px] font-medium"
                title="重新生成汇总报告（按当前全部已完成靶点重新汇总批次统计 + 全靶点总表 + AI 整体可行性，完成后自动下载新 HTML — 重跑/补齐靶点后刷新用）"
              >
                <RotateCcw className="size-3.5" aria-hidden />
                重新生成
              </Button>
            </>
          ) : run.dashboardPending ? (
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-foreground">汇总报告生成中…</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                正在汇总批次统计、每靶点结论与 AI 整体可行性报告（内嵌全部报告正文与原始表内容），完成后自动下载 HTML；此过程通常需要 1-3 分钟，期间可自由查看各组结果。
              </p>
            </div>
          ) : (
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold text-amber-700 dark:text-amber-400">
                  {run.dashboardError === '__done__' ? '本次运行没有成功完成的靶点，未生成汇总报告' : '汇总报告生成失败'}
                </p>
                <p className="mt-0.5 text-[11px] leading-relaxed text-amber-700/90 dark:text-amber-400/90">
                  {run.dashboardError === '__done__'
                    ? '全部靶点均失败/被取消/被跳过，无可统计的评估结果（运行中作业被停止或服务实例回收时会出现此情况）。可点击「重跑失败/不完整项」补齐后重新生成。'
                    : <>{run.dashboardError}（运行结果不受影响；可重新生成或重新下载 zip 重试打包可用的看板）</>}
                </p>
              </div>
              {run.dashboardError !== '__done__' && doneTargets > 0 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={run.dashboardPending}
                  onClick={() => void flow.regenerateDashboard()}
                  className="h-8 gap-1.5 rounded-lg border-amber-500/40 px-3 text-[12px] font-medium text-amber-700 hover:bg-amber-500/10 hover:text-amber-700 dark:text-amber-400"
                  title="重新生成汇总报告（按当前全部已完成靶点重新汇总，完成后自动下载新 HTML）"
                >
                  <RotateCcw className="size-3.5" aria-hidden />
                  重新生成汇总报告
                </Button>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── 底部操作（v2.25：取消按钮与内容区拉开间距 mt-2；说明文字上移） ── */}
      <div className="flex flex-col gap-2.5">
        <span className="font-mono text-[10.5px] text-muted-foreground/80">
          每组报告完成即自动下载到本机下载目录的同一文件夹（TargetEval_HT_日期_Ng/…）· 运行完成后汇总报告（统计看板 + 全靶点总表 + AI 整体可行性报告，单文件）自动下载 · 报告与日志保留在服务端 30 天 · 运行结构保留在浏览器 30 天
        </span>
        <div className="flex flex-wrap items-center gap-2.5">
          {isRunning && (
            <>
              {/* v2.38 手动暂停：不取消服务器作业（跑完照常记结果），随时可恢复 */}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => flow.pauseRun()}
                className="h-9 gap-1.5 rounded-lg px-3.5 text-[12.5px] font-medium text-amber-600 hover:bg-amber-500/10 hover:text-amber-600 dark:text-amber-400"
                title="暂停编排（不再开新作业；正在执行的作业会跑完并记录结果）— 可随时从断点继续"
              >
                <Pause className="size-3.5" aria-hidden />
                暂停（可恢复）
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={flow.canceling}
                onClick={() => void flow.cancelRun()}
                className="h-9 gap-1.5 rounded-lg px-3.5 text-[12.5px] font-medium text-red-600 hover:bg-red-500/10 hover:text-red-600 dark:text-red-400"
                title="停止运行并取消服务器上正在执行的作业（已完成的结果保留；可随时「继续运行」恢复）"
              >
                <XCircle className="size-3.5" aria-hidden />
                {flow.canceling ? '正在停止…' : '停止运行（可恢复）'}
              </Button>
            </>
          )}
          {isDone && (
            <>
              <Button type="button" size="sm" onClick={onNewEvaluation} className="h-9 gap-1.5 rounded-lg bg-primary px-3.5 text-[12.5px] font-semibold text-primary-foreground">
                开始新的高通量评估
              </Button>
              {retryableTargets > 0 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void flow.retryFailed()}
                  className="h-9 gap-1.5 rounded-lg px-3.5 text-[12.5px] font-medium"
                  title={`重置全部 ${retryableTargets} 个失败/中断${incompleteTargets > 0 ? `/报告不完整（${incompleteTargets}）` : ''}靶点并立即重新运行（汇总报告将重新生成）`}
                >
                  <Play className="size-3.5" aria-hidden />
                  {incompleteTargets > 0 && failedTargets === 0
                    ? `重跑报告不完整项（${incompleteTargets}）`
                    : `重跑失败/不完整项（${retryableTargets}）`}
                </Button>
              )}
              {/* v2.44：无汇总报告状态的兜底入口（旧运行/生成标记被清 — 横幅未渲染时） */}
              {!run.dashboardId && !run.dashboardPending && !run.dashboardError && doneTargets > 0 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void flow.regenerateDashboard()}
                  className="h-9 gap-1.5 rounded-lg px-3.5 text-[12.5px] font-medium"
                  title="生成汇总报告（统计看板 + 全靶点总表 + AI 整体可行性，单文件 — 完成后自动下载）"
                >
                  <Gauge className="size-3.5" aria-hidden />
                  生成汇总报告
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={importingZip}
                onClick={() => zipInputRef.current?.click()}
                className="h-9 gap-1.5 rounded-lg px-3.5 text-[12.5px] font-medium"
                title="导入既有报告（zip 归档或单独的报告 HTML，可多选）— 匹配到的未评估靶点标跳过（用于补齐清单后重跑剩余靶点）"
              >
                {importingZip ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : <FileArchive className="size-3.5" aria-hidden />}
                {importingZip ? '导入中…' : '导入报告（zip/HTML）'}
              </Button>
            </>
          )}
          {isStopped && (
            <Button
              type="button"
              size="sm"
              onClick={() => void flow.resumeRun()}
              className="h-9 gap-1.5 rounded-lg bg-primary px-3.5 text-[12.5px] font-semibold text-primary-foreground"
            >
              <RotateCcw className="size-3.5" aria-hidden />
              继续运行
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
              title="打包本次运行全部报告为单个 zip（每组一个子文件夹，含合并报告与 README 清单；内附靶点清单可回导跳过已完成靶点）"
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
                <span className="font-mono text-[11px] font-normal text-muted-foreground/85">
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
