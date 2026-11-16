'use client'

import { useEffect, useRef } from 'react'
import {
  CircleCheckBig,
  CircleDashed,
  Clock,
  Hourglass,
  Layers,
  LoaderCircle,
  ShieldCheck,
  Terminal,
  WifiOff,
  XCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'
import { formatDuration, logLevel, toLogLines } from './format'
import type { JobDetail, StageInfo } from './types'
import type { BatchState } from './use-evaluation-flow'

/** 后端未返回 stages 时的兜底阶段列表 */
const FALLBACK_STAGES: StageInfo[] = [
  { key: 'parse', label: '输入解析', state: 'pending', percent: 0 },
  { key: 'uniprot', label: 'UniProt 元数据', state: 'pending', percent: 0 },
  { key: 'collect-pdb', label: 'PDB 结构检索', state: 'pending', percent: 0 },
  { key: 'pdbe', label: 'PDBe 映射 / 覆盖率', state: 'pending', percent: 0 },
  { key: 'blast', label: 'BLAST 同源检索（可选）', state: 'pending', percent: 0 },
  { key: 'pubmed', label: '文献检索', state: 'pending', percent: 0 },
  { key: 'score', label: '评分计算', state: 'pending', percent: 0 },
  { key: 'llm', label: 'LLM 报告生成', state: 'pending', percent: 0 },
]

function logLineClass(line: string): string {
  const level = logLevel(line)
  if (level === 'error') return 'text-red-400'
  if (level === 'warn') return 'text-amber-400'
  return 'text-stone-300'
}

/** 实时日志卡片（Linear 深色终端窗、自动滚动到底部、自定义滚动条） */
export function LogCard({ logs, title = '实时日志' }: { logs: string[]; title?: string }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const lines = toLogLines(logs)
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines.length])

  return (
    <Card className="gap-3 rounded-xl border-border bg-card shadow-none">
      <CardContent className="flex flex-col gap-2.5 px-5 py-4">
        <div className="flex items-center gap-2">
          <Terminal className="size-3.5 text-muted-foreground/60" />
          <h3 className="lin-eyebrow text-muted-foreground">{title}</h3>
          <span className="ml-auto font-mono text-[10px] tabular-nums text-muted-foreground/70">
            {lines.length} lines
          </span>
        </div>
        <div
          ref={scrollRef}
          className="eval-scroll lin-terminal max-h-72 min-h-48 overflow-y-auto rounded-lg p-3"
        >
          {lines.length === 0 ? (
            <p className="font-mono text-[11px] text-[#62666d]">等待日志输出…</p>
          ) : (
            lines.map((line, i) => (
              <div
                key={i}
                className={cn(
                  'whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed',
                  logLineClass(line)
                )}
              >
                {line}
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  )
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

/** 进度视图（running）：总体进度 + 阶段列表 + 实时日志 + 计时/取消（含 v1.8 关系判断/合并报告生成阶段） */
export function ProgressPanel({ job, elapsedSec, networkIssue, canceling, onCancel, batch }: ProgressPanelProps) {
  const progress = job?.progress ?? null
  const stages =
    progress?.stages && progress.stages.length > 0 ? progress.stages : FALLBACK_STAGES
  const percent = Math.min(100, Math.max(0, progress?.percent ?? 0))
  const isQueued = job?.status === 'pending'
  const queuePos = job?.queuePosition ?? 0
  const relationJudging = batch?.relationJudging === true
  const merging = batch?.merging === true
  const message = relationJudging
    ? '正在分析批次内靶点的关联关系（系统序列比对 + LLM 判断：同源家族 / 复合物 / 抗体-抗原 / 融合构建 / 独立项目）…'
    : merging
      ? '靶点数据已就绪，正在生成合并评估报告（含关系分析章节）…'
      : isQueued
        ? queuePos > 0
          ? `排队等待中（前方还有 ${queuePos} 个作业）`
          : '下一个执行，正在分配资源…'
        : progress?.message?.trim() || '正在启动评估…'

  return (
    <div className="flex flex-col gap-6">
      {/* 刊头 */}
      <header className="flex flex-col gap-3">
        <p className="lin-eyebrow text-primary">
          Evaluation in Progress
        </p>
        <h1 className="text-2xl leading-snug font-semibold tracking-[-0.02em] text-foreground sm:text-[28px]">
          评估进行中
          {job?.uniprotId && (
            <span className="ml-3 font-mono text-sm font-normal text-muted-foreground">
              {job.uniprotId}
            </span>
          )}
          {batch && batch.total > 1 && (
            <span className="ml-3 inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/[0.06] px-2 py-0.5 align-middle font-mono text-xs font-medium text-primary">
              <Layers className="size-3" aria-hidden />
              批量 {batch.currentIndex + 1}/{batch.total}
              <span className="hidden font-sans font-normal text-primary/70 sm:inline">
                {batch.items[batch.currentIndex]?.label}
              </span>
            </span>
          )}
        </h1>
        {job?.goal && (
          <p className="max-w-2xl truncate text-sm text-muted-foreground" title={job.goal}>
            <span className="lin-eyebrow mr-2 text-amber-600 dark:text-amber-500">GOAL</span>
            {job.goal}
          </p>
        )}
      </header>

      {/* v1.8 阶段横幅：关系判断 / 合并报告生成（优先展示） */}
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

      {/* 总体进度 */}
      <Card className="gap-0 rounded-xl border-border bg-card shadow-none">
        <CardContent className="flex flex-col gap-3.5 px-5 py-4">
          <div className="flex flex-wrap items-center gap-2">
            {isQueued ? (
              <Hourglass className="size-4 animate-pulse text-amber-600 dark:text-amber-400" />
            ) : (
              <LoaderCircle className="size-4 animate-spin text-primary" />
            )}
            <span className="min-w-0 flex-1 truncate text-sm text-foreground/80">
              {message}
            </span>
            {!isQueued && (
              <span className="font-medium tabular-nums text-primary">
                {percent}%
              </span>
            )}
            <span className="ml-2 flex items-center gap-1.5 rounded-md border border-border bg-muted/60 px-2 py-0.5 font-mono text-xs tabular-nums text-muted-foreground">
              <Clock className="size-3" />
              {formatDuration(elapsedSec)}
            </span>
          </div>
          <Progress value={isQueued ? 0 : percent} className="h-1 bg-muted" />
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

      {/* 阶段 + 日志 双栏 */}
      <div className="grid gap-5 lg:grid-cols-[1fr_1.25fr]">
        <Card className="gap-3 rounded-xl border-border bg-card shadow-none">
          <CardContent className="flex flex-col gap-3 px-5 py-4">
            <h3 className="lin-eyebrow text-muted-foreground">评估阶段 · Stages</h3>
            <ol className="flex flex-col">
              {stages.map((s, i) => (
                <li
                  key={s.key}
                  className={cn(
                    'flex min-h-10 items-center gap-3 border-border/70 px-1',
                    i > 0 && 'border-t'
                  )}
                >
                  {s.state === 'done' ? (
                    <CircleCheckBig className="size-4 shrink-0 text-primary" />
                  ) : s.state === 'active' ? (
                    <LoaderCircle className="size-4 shrink-0 animate-spin text-primary" />
                  ) : (
                    <CircleDashed className="size-4 shrink-0 text-muted-foreground/40" />
                  )}
                  <span
                    className={cn(
                      'min-w-0 truncate text-sm',
                      s.state === 'done' && 'text-muted-foreground',
                      s.state === 'active' &&
                        'font-medium text-foreground',
                      s.state === 'pending' && 'text-muted-foreground/60'
                    )}
                  >
                    {s.label}
                  </span>
                  {s.state === 'active' && s.percent > 0 && (
                    <span className="ml-auto shrink-0 font-mono text-[11px] font-medium tabular-nums text-primary">
                      {s.percent}%
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>

        <LogCard logs={job?.logs ?? []} />
      </div>

      {/* 底部操作 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground/70">
          完整评估通常需要 1–3 分钟，可随时取消
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
