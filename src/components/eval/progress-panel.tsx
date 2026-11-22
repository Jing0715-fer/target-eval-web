'use client'

import { STAGE_DEFS } from '@/lib/eval/types'
import {
  CircleCheckBig,
  CircleDashed,
  Hourglass,
  Layers,
  LoaderCircle,
  ShieldCheck,
  WifiOff,
  XCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'
import { EvalLogConsole } from './log-console'
import { formatDuration } from './format'
import type { JobDetail, StageInfo } from './types'
import type { BatchState } from './use-evaluation-flow'

/** 后端未返回 stages 时的兜底（与 STAGE_DEFS 真实管线一致：
 *  v2.21 修复旧 fallback 与后端顺序/文案漂移 — 文献检索先于 BLAST） */
const FALLBACK_STAGES: StageInfo[] = STAGE_DEFS.map(s => ({
  key: s.key,
  label: s.label,
  state: 'pending',
  percent: 0,
}))

/** 批量条目状态图标 */
function BatchItemIcon({ status }: { status: 'running' | 'done' | 'error' | 'canceled' }) {
  if (status === 'running') return <LoaderCircle className="size-3 shrink-0 animate-spin text-primary" aria-hidden />
  if (status === 'done') return <CircleCheckBig className="size-3 shrink-0 text-primary" aria-hidden />
  return <XCircle className="size-3 shrink-0 text-red-500/80" aria-hidden />
}

export interface ProgressPanelProps {
  job: JobDetail | null
  elapsedSec: number
  networkIssue: boolean
  canceling: boolean
  onCancel: () => void
  /** 批量评估（docx 多 UniProt）时的批量进度提示 */
  batch?: BatchState | null
}

/**
 * 进度视图（running）— v2.21 重构：
 *  · 刊头：状态徽标（排队/评估中/关系判断/合并报告）+ 靶点 chips + GOAL 摘要（两行截断）
 *  · 主进度卡：当前消息 + 大号百分比 + 进度条 + 元数据条（已用时/阶段进度/当前阶段/批量进度）
 *    （旧版把百分比、计时器挤在一行，且时间与队列信息重复出现两次）
 *  · 批量：主卡下方逐靶点状态 chips（此前批量运行时只有一个标题徽标，看不出各靶点状态）
 *  · 阶段时间线：编号 + 连接线 + 激活行高亮（此前无编号、无高亮、视觉平铺）
 *  · 日志：EvalLogConsole（智能跟随 + 过滤/搜索/复制/下载/展开）
 */
export function ProgressPanel({ job, elapsedSec, networkIssue, canceling, onCancel, batch }: ProgressPanelProps) {
  const progress = job?.progress ?? null
  const isQueued = job?.status === 'pending'
  // 阶段列表：后端 stages 优先；兜底对齐 STAGE_DEFS 真实管线
  // （v2.21 修复旧 fallback 与后端顺序/文案漂移 — 文献检索先于 BLAST）
  // 排队态一律显示全 pending（防御异常快照混入激活态 — 排队时不可能有阶段进行）
  const rawStages =
    progress?.stages && progress.stages.length > 0 ? progress.stages : FALLBACK_STAGES
  const stages: StageInfo[] = isQueued
    ? rawStages.map(s => ({ ...s, state: 'pending', percent: 0 }))
    : rawStages
  const percent = Math.min(100, Math.max(0, progress?.percent ?? 0))
  const queuePos = job?.queuePosition ?? 0
  const relationJudging = batch?.relationJudging === true
  const merging = batch?.merging === true
  const message = relationJudging
    ? '正在分析批次内靶点的关联关系（系统序列比对 + LLM 判断）…'
    : merging
      ? '靶点数据已就绪，正在生成合并评估报告（含关系分析章节）…'
      : isQueued
        ? queuePos > 0
          ? `排队等待中 — 前方还有 ${queuePos} 个作业`
          : '下一个执行，正在分配资源…'
        : progress?.message?.trim() || '正在启动评估…'

  const doneStages = stages.filter(s => s.state === 'done').length
  const activeStage = stages.find(s => s.state === 'active') ?? null
  const activeLabel = relationJudging ? '关系判断' : merging ? '合并报告' : activeStage?.label ?? (isQueued ? '排队' : '启动')

  // 状态徽标
  const pill = relationJudging || merging
    ? { icon: <LoaderCircle className="size-3 animate-spin" />, text: relationJudging ? '关系判断中' : '合并报告生成中', cls: 'border-violet-500/40 bg-violet-500/[0.08] text-violet-700 dark:text-violet-400' }
    : isQueued
      ? { icon: <Hourglass className="size-3" />, text: queuePos > 0 ? `排队中 · 前方 ${queuePos}` : '排队中', cls: 'border-amber-500/40 bg-amber-500/[0.08] text-amber-700 dark:text-amber-400' }
      : { icon: <span className="size-1.5 animate-pulse rounded-full bg-primary" />, text: '评估中', cls: 'border-primary/40 bg-primary/[0.07] text-primary' }

  const batchRunning = batch && batch.total > 1 && !batch.done

  return (
    <div className="flex flex-col gap-6 pb-5 sm:pb-7">
      {/* ── 刊头：眉题 + 状态徽标 + 标题 + 靶点 chips + GOAL ── */}
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <p className="lin-eyebrow text-primary">Evaluation in Progress</p>
          <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-medium', pill.cls)}>
            {pill.icon}
            {pill.text}
          </span>
        </div>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
          <h1 className="text-2xl leading-snug font-semibold tracking-[-0.02em] text-foreground sm:text-[28px]">
            评估进行中
          </h1>
          {job?.uniprotId && (
            <span className="font-mono text-sm font-normal text-muted-foreground">{job.uniprotId}</span>
          )}
        </div>
        {batch && batch.total > 1 && (
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/[0.06] px-2 py-0.5 font-mono text-xs font-medium text-primary">
              <Layers className="size-3" aria-hidden />
              批量 {batch.currentIndex + 1}/{batch.total}
              <span className="hidden font-sans font-normal text-primary/70 sm:inline">
                {batch.items[batch.currentIndex]?.label}
              </span>
            </span>
          </div>
        )}
        {job?.goal && (
          <div className="max-w-2xl rounded-lg border border-border/70 bg-muted/30 px-3 py-2">
            <span className="lin-eyebrow mr-2 text-amber-600 dark:text-amber-500">GOAL</span>
            <p className="line-clamp-2 text-[13px] leading-relaxed text-muted-foreground" title={job.goal}>
              {job.goal}
            </p>
          </div>
        )}
      </header>

      {/* ── v1.8 阶段横幅：关系判断 / 合并报告生成（特殊虚拟阶段）── */}
      {(relationJudging || merging) && (
        <div className="flex items-start gap-3 rounded-xl border border-violet-500/25 bg-violet-500/[0.06] px-4 py-3.5">
          <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin text-violet-600 dark:text-violet-400" aria-hidden />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-violet-700 dark:text-violet-300">
              {relationJudging ? '正在分析靶点关系' : '正在生成合并评估报告'}
            </p>
            <p className="mt-0.5 text-xs leading-relaxed text-violet-700/80 dark:text-violet-400/80">
              {relationJudging
                ? `批次内 ${batch?.total ?? 0} 个靶点正由 LLM 判断关联关系 — 关联（复合物亚基 / 抗体-抗原配对 / 融合构建）则合并为一份含关系分析的报告；相互独立则分别生成报告并注明批次定位。通常需要 10–30 秒。`
                : '各靶点数据已全部收集完成，LLM 正在撰写合并分析（执行摘要 / 靶点关系分析 / 各靶点综述 / 整合策略）。通常需要 1–3 分钟。'}
            </p>
          </div>
        </div>
      )}

      {/* ── 主进度卡：消息 + 进度条 + 元数据条 ── */}
      <Card className="gap-0 rounded-xl border-border bg-card shadow-none">
        <CardContent className="flex flex-col gap-3.5 px-5 py-4">
          <div className="flex items-center gap-3">
            {isQueued ? (
              <Hourglass className="size-4.5 shrink-0 animate-pulse text-amber-600 dark:text-amber-400" />
            ) : (
              <LoaderCircle className="size-4.5 shrink-0 animate-spin text-primary" />
            )}
            <span className="min-w-0 flex-1 truncate text-sm text-foreground/80">{message}</span>
            {!isQueued && (
              <span className="shrink-0 font-mono text-lg font-semibold tabular-nums text-primary">
                {percent}%
              </span>
            )}
          </div>
          <Progress value={isQueued ? 0 : percent} className="h-1 bg-muted" />

          {/* 元数据条（旧版计时/百分比重复两处，收敛到此一行） */}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t border-border/70 pt-3 font-mono text-[11px] tabular-nums text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span className="lin-eyebrow text-muted-foreground/80">已用时</span>
              <span className="font-medium text-foreground/80">{formatDuration(elapsedSec)}</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="lin-eyebrow text-muted-foreground/80">阶段</span>
              <span className="font-medium text-foreground/80">{doneStages}/{stages.length}</span>
              <span className="text-muted-foreground/80">· {activeLabel}</span>
            </span>
            {batchRunning && (
              <span className="inline-flex items-center gap-1.5">
                <span className="lin-eyebrow text-muted-foreground/80">批量</span>
                <span className="font-medium text-foreground/80">
                  {batch.items.filter(x => x.status === 'done').length}/{batch.total} 完成
                </span>
              </span>
            )}
          </div>

          {/* 批量逐靶点状态 chips（旧版运行期只有标题徽标，各靶点状态不可见） */}
          {batchRunning && batch.items.length > 1 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {batch.items.map(item => (
                <span
                  key={item.key}
                  title={item.error ?? `${item.label} · ${item.status}`}
                  className={cn(
                    'inline-flex max-w-52 items-center gap-1.5 rounded-md border px-1.5 py-0.5 font-mono text-[10px]',
                    item.status === 'running'
                      ? 'border-primary/35 bg-primary/[0.06] text-primary'
                      : item.status === 'done'
                        ? 'border-border bg-muted/50 text-muted-foreground'
                        : 'border-red-500/30 bg-red-500/[0.05] text-red-600 dark:text-red-400',
                  )}
                >
                  <BatchItemIcon status={item.status} />
                  <span className="truncate">{item.label}</span>
                </span>
              ))}
            </div>
          )}

          {isQueued && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
              <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
              服务器按队列依次执行评估以保障稳定性，你的作业即将开始。页面可保持打开，也可稍后从「历史评估」中查看结果。
            </div>
          )}
          {networkIssue && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
              <WifiOff className="mt-0.5 size-3.5 shrink-0" />
              网络连接不稳定，已连续多次获取进度失败，正在继续重试…
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── 双栏：阶段时间线 + 日志控制台 ── */}
      <div className="grid gap-5 lg:grid-cols-[1fr_1.25fr]">
        <Card className="gap-3 rounded-xl border-border bg-card shadow-none">
          <CardContent className="flex flex-col gap-3 px-5 py-4">
            <div className="flex items-center justify-between">
              <h3 className="lin-eyebrow text-muted-foreground">评估阶段 · Stages</h3>
              <span className="font-mono text-[10px] tabular-nums text-muted-foreground/85">
                {doneStages}/{stages.length} 完成
              </span>
            </div>
            <ol className="flex flex-col">
              {stages.map((s, i) => (
                <li key={s.key} className="flex gap-3">
                  {/* 左轨：编号 → 状态图标 → 连接线（self-stretch + flex-1 撑满行高） */}
                  <div className="flex w-4.5 flex-col items-center self-stretch" aria-hidden>
                    <span
                      className={cn(
                        'font-mono text-[9px] leading-none tabular-nums',
                        s.state === 'active' ? 'text-primary' : 'text-muted-foreground/40',
                      )}
                    >
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    {s.state === 'done' ? (
                      <CircleCheckBig className="mt-1 size-4 text-primary" />
                    ) : s.state === 'active' ? (
                      <LoaderCircle className="mt-1 size-4 animate-spin text-primary" />
                    ) : (
                      <CircleDashed className="mt-1 size-4 text-muted-foreground/40" />
                    )}
                    {i < stages.length - 1 && (
                      <span className={cn('my-1 w-px flex-1', s.state === 'done' ? 'bg-primary/40' : 'bg-border')} />
                    )}
                  </div>
                  {/* 标签行：激活态高亮 + 阶段内百分比 */}
                  <div
                    className={cn(
                      'mb-1 flex min-h-8 flex-1 items-center gap-2 rounded-md px-2 transition-colors',
                      s.state === 'active' && 'bg-primary/[0.05]',
                    )}
                  >
                    <span
                      className={cn(
                        'min-w-0 truncate text-sm',
                        s.state === 'done' && 'text-muted-foreground',
                        s.state === 'active' && 'font-medium text-foreground',
                        s.state === 'pending' && 'text-muted-foreground/80',
                      )}
                    >
                      {s.label}
                    </span>
                    {s.state === 'active' && s.percent > 0 && (
                      <span className="ml-auto shrink-0 font-mono text-[11px] font-medium tabular-nums text-primary">
                        {s.percent}%
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>

        <EvalLogConsole logs={job?.logs ?? []} live />
      </div>

      {/* ── 底部操作 ── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground/85">
          完整评估通常需要 1–3 分钟 · 页面可保持打开，完成后自动展示结果
        </p>
        <Button
          variant="outline"
          onClick={onCancel}
          disabled={canceling}
          className="h-9 gap-2 rounded-lg text-muted-foreground text-xs hover:border-red-400/60 hover:bg-red-500/[0.06] hover:text-red-600"
        >
          <XCircle className="size-3.5" />
          {canceling ? '正在取消…' : '取消评估'}
        </Button>
      </div>
    </div>
  )
}
