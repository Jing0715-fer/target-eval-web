'use client'

import { useEffect, useRef } from 'react'
import {
  CircleCheckBig,
  CircleDashed,
  Clock,
  LoaderCircle,
  Terminal,
  WifiOff,
  XCircle,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'
import { formatDuration, logLevel, toLogLines } from './format'
import type { JobDetail, StageInfo } from './types'

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

/** 实时日志卡片（等宽字体、自动滚动到底部、自定义滚动条） */
export function LogCard({ logs, title = '实时日志' }: { logs: string[]; title?: string }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const lines = toLogLines(logs)
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines.length])

  return (
    <Card className="gap-3 rounded-xl border-stone-200 bg-white shadow-sm dark:border-stone-800 dark:bg-stone-900">
      <CardContent className="flex flex-col gap-2.5 px-5 py-4">
        <div className="flex items-center gap-2">
          <Terminal className="size-4 text-stone-400" />
          <h3 className="text-sm font-semibold text-stone-800 dark:text-stone-200">{title}</h3>
          <Badge variant="secondary" className="ml-auto text-[10px] tabular-nums">
            {lines.length} 条
          </Badge>
        </div>
        <div
          ref={scrollRef}
          className="eval-scroll max-h-72 min-h-48 overflow-y-auto rounded-lg border border-stone-800/60 bg-stone-950 p-3 dark:border-stone-800"
        >
          {lines.length === 0 ? (
            <p className="font-mono text-[11px] text-stone-500">等待日志输出…</p>
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
}

/** 进度视图（running）：整体进度 + 阶段列表 + 实时日志 + 计时/取消 */
export function ProgressPanel({ job, elapsedSec, networkIssue, canceling, onCancel }: ProgressPanelProps) {
  const progress = job?.progress ?? null
  const stages =
    progress?.stages && progress.stages.length > 0 ? progress.stages : FALLBACK_STAGES
  const percent = Math.min(100, Math.max(0, progress?.percent ?? 0))
  const message = progress?.message?.trim() || '正在启动评估…'

  return (
    <div className="flex flex-col gap-5">
      {/* 总体进度 */}
      <Card className="gap-0 rounded-xl border-stone-200 bg-white shadow-sm dark:border-stone-800 dark:bg-stone-900">
        <CardContent className="flex flex-col gap-3.5 px-5 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-lg bg-emerald-50 dark:bg-emerald-950/60">
              <LoaderCircle className="size-4.5 animate-spin text-emerald-600" />
            </span>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-stone-900 dark:text-stone-100">
                评估进行中
                {job?.uniprotId && (
                  <span className="ml-1.5 font-mono text-xs font-normal text-stone-500">
                    {job.uniprotId}
                  </span>
                )}
              </div>
              {job?.goal && (
                <p className="truncate text-xs text-stone-500 dark:text-stone-500" title={job.goal}>
                  目标：{job.goal}
                </p>
              )}
            </div>
            <div className="ml-auto flex items-center gap-1.5 rounded-lg bg-stone-100 px-2.5 py-1 text-sm tabular-nums text-stone-600 dark:bg-stone-800 dark:text-stone-300">
              <Clock className="size-3.5" />
              {formatDuration(elapsedSec)}
            </div>
          </div>
          <Progress value={percent} className="h-2.5 bg-emerald-100/70 dark:bg-emerald-950/60" />
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="min-w-0 truncate text-stone-600 dark:text-stone-400">{message}</span>
            <span className="shrink-0 font-medium tabular-nums text-emerald-700 dark:text-emerald-400">
              {percent}%
            </span>
          </div>
          {networkIssue && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
              <WifiOff className="mt-0.5 size-3.5 shrink-0" />
              网络连接不稳定，已连续多次获取进度失败，正在继续重试…
            </div>
          )}
        </CardContent>
      </Card>

      {/* 阶段 + 日志 双栏 */}
      <div className="grid gap-5 lg:grid-cols-[1fr_1.25fr]">
        <Card className="gap-3 rounded-xl border-stone-200 bg-white shadow-sm dark:border-stone-800 dark:bg-stone-900">
          <CardContent className="flex flex-col gap-3 px-5 py-4">
            <h3 className="text-sm font-semibold text-stone-800 dark:text-stone-200">评估阶段</h3>
            <ol className="flex flex-col gap-1">
              {stages.map((s) => (
                <li
                  key={s.key}
                  className={cn(
                    'flex min-h-11 items-center gap-3 rounded-lg px-2.5 transition-colors',
                    s.state === 'active' && 'bg-emerald-50/80 dark:bg-emerald-950/30'
                  )}
                >
                  {s.state === 'done' ? (
                    <CircleCheckBig className="size-5 shrink-0 text-emerald-600" />
                  ) : s.state === 'active' ? (
                    <LoaderCircle className="size-5 shrink-0 animate-spin text-emerald-600" />
                  ) : (
                    <CircleDashed className="size-5 shrink-0 text-stone-300 dark:text-stone-600" />
                  )}
                  <span
                    className={cn(
                      'min-w-0 truncate text-sm',
                      s.state === 'done' && 'text-stone-500 dark:text-stone-400',
                      s.state === 'active' &&
                        'font-medium text-stone-900 dark:text-stone-100',
                      s.state === 'pending' && 'text-stone-400 dark:text-stone-500'
                    )}
                  >
                    {s.label}
                  </span>
                  {s.state === 'active' && s.percent > 0 && (
                    <span className="ml-auto shrink-0 text-xs font-medium tabular-nums text-emerald-700 dark:text-emerald-400">
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
        <p className="text-xs text-stone-500 dark:text-stone-500">
          完整评估通常需要 1–3 分钟，可随时取消
        </p>
        <Button
          variant="outline"
          onClick={onCancel}
          disabled={canceling}
          className="h-10 gap-2 border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700 dark:border-red-900/70 dark:text-red-400 dark:hover:bg-red-950/40"
        >
          <XCircle className="size-4" />
          {canceling ? '正在取消…' : '取消评估'}
        </Button>
      </div>
    </div>
  )
}
