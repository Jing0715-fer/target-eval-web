'use client'

import { CheckCircle2, LoaderCircle, Layers, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { BatchState } from './use-evaluation-flow'

export interface BatchBarProps {
  batch: BatchState
  /** 当前展示的作业 id */
  currentJobId?: string | null
  onSelect: (jobId: string) => void
}

/**
 * 批量评估切换栏（docx 多 UniProt 评估）：
 * 进度态显示「批量 i/N + 当前靶点」；完成态显示各靶点状态 chips，点击切换结果。
 */
export function BatchBar({ batch, currentJobId, onSelect }: BatchBarProps) {
  if (batch.items.length <= 1) return null
  const doneCount = batch.items.filter(x => x.status === 'done').length
  const failCount = batch.items.filter(x => x.status === 'error' || x.status === 'canceled').length
  const running = !batch.done

  return (
    <div
      className="flex flex-col gap-2.5 rounded-lg border border-stone-200 bg-white px-4 py-3.5 dark:border-stone-800 dark:bg-stone-900"
      role="group"
      aria-label="批量评估靶点切换"
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Layers className="size-3.5 text-emerald-700 dark:text-emerald-500" aria-hidden />
        <span className="font-medium text-stone-700 dark:text-stone-200">
          {running ? '批量评估进行中' : '批量评估完成'}
        </span>
        <span className="font-mono tabular-nums text-stone-400 dark:text-stone-500">
          {doneCount}/{batch.total} 完成{failCount > 0 ? ` · ${failCount} 失败` : ''}
        </span>
        {/* 批量总进度条 */}
        <span className="ml-auto flex min-w-24 items-center gap-1.5" aria-hidden>
          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-stone-100 dark:bg-stone-800">
            <span
              className={cn('block h-full rounded-full transition-all', failCount > 0 && !running ? 'bg-emerald-600' : 'bg-emerald-700 dark:bg-emerald-500')}
              style={{ width: `${Math.round((batch.items.length / batch.total) * 100)}%` }}
            />
          </span>
          <span className="font-mono text-[10px] tabular-nums text-stone-400">{Math.round((batch.items.length / batch.total) * 100)}%</span>
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {batch.items.map((item) => {
          const active = Boolean(item.jobId && item.jobId === currentJobId)
          const clickable = Boolean(item.jobId && item.status === 'done')
          return (
            <button
              key={item.key}
              type="button"
              disabled={!clickable}
              onClick={() => item.jobId && onSelect(item.jobId)}
              title={
                item.status === 'error'
                  ? `评估失败${item.error ? `：${item.error}` : ''}`
                  : item.status === 'running'
                    ? `${item.label} 评估中…`
                    : `查看 ${item.label} 的评估结果`
              }
              className={cn(
                'flex min-h-8 items-center gap-1.5 rounded-md border px-2.5 font-mono text-[11px] transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-emerald-500/40 disabled:cursor-default',
                active
                  ? 'border-emerald-700 bg-emerald-800 font-semibold text-white'
                  : clickable
                    ? 'border-stone-200 bg-white text-stone-600 hover:border-emerald-500 hover:text-emerald-800 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300 dark:hover:border-emerald-600 dark:hover:text-emerald-400'
                    : 'border-stone-200 bg-stone-50 text-stone-400 dark:border-stone-800 dark:bg-stone-900/60 dark:text-stone-500'
              )}
            >
              {item.status === 'done' ? (
                <CheckCircle2 className="size-3 shrink-0 text-emerald-600 dark:text-emerald-500" aria-hidden />
              ) : item.status === 'running' ? (
                <LoaderCircle className="size-3 shrink-0 animate-spin text-emerald-600 dark:text-emerald-500" aria-hidden />
              ) : (
                <XCircle className="size-3 shrink-0 text-red-400" aria-hidden />
              )}
              {item.label}
            </button>
          )
        })}
        {/* 尚未开始的靶点占位 */}
        {batch.items.length < batch.total &&
          Array.from({ length: batch.total - batch.items.length }, (_, i) => (
            <span
              key={`pending-${i}`}
              className="flex min-h-8 items-center rounded-md border border-dashed border-stone-200 px-2.5 font-mono text-[11px] text-stone-300 dark:border-stone-800 dark:text-stone-600"
            >
              待排队
            </span>
          ))}
      </div>
    </div>
  )
}
