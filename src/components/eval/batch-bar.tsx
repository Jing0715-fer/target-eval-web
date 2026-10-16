'use client'

import {
  CheckCircle2,
  FileStack,
  Layers,
  Link2,
  LoaderCircle,
  ShieldAlert,
  XCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { describeRelationType } from './types'
import type { BatchState } from './use-evaluation-flow'

export interface BatchBarProps {
  batch: BatchState
  /** 当前展示的作业 id */
  currentJobId?: string | null
  onSelect: (jobId: string) => void
  /** 切换到合并报告视图（关联批次） */
  onShowMerged?: () => void
}

/**
 * 批量评估切换栏（docx 多 UniProt 评估）：
 * 进度态显示「批量 i/N + 当前靶点」；完成态显示各靶点状态 chips，点击切换结果。
 * v1.8：关系判定横幅（关联 → 合并报告按钮；独立 → 说明banner）+ 并发窗口双靶点进行中。
 */
export function BatchBar({ batch, currentJobId, onSelect, onShowMerged }: BatchBarProps) {
  if (batch.items.length <= 1 && !batch.mergedReport) return null
  const doneCount = batch.items.filter(x => x.status === 'done').length
  const failCount = batch.items.filter(x => x.status === 'error' || x.status === 'canceled').length
  const runningCount = batch.items.filter(x => x.status === 'running').length
  const running = !batch.done
  const rel = batch.relation ?? null
  const mergedActive = batch.view === 'merged' && Boolean(batch.mergedReport)

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
          {running && runningCount > 1 ? ` · ${runningCount} 个并行执行中` : ''}
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

      {/* 关系判定横幅（v1.8） */}
      {batch.relationJudging && (
        <div className="flex items-center gap-2 rounded-md border border-stone-200 bg-stone-50/70 px-3 py-2 text-xs text-stone-600 dark:border-stone-800 dark:bg-stone-900/60 dark:text-stone-300">
          <LoaderCircle className="size-3.5 shrink-0 animate-spin text-emerald-700 dark:text-emerald-500" aria-hidden />
          正在分析 {batch.total} 个靶点之间的关联关系（复合物 / 抗体-抗原 / 融合构建 / 独立项目）…
        </div>
      )}
      {!batch.relationJudging && batch.merging && (
        <div className="flex items-center gap-2 rounded-md border border-violet-200 bg-violet-50/70 px-3 py-2 text-xs text-violet-800 dark:border-violet-900/70 dark:bg-violet-950/30 dark:text-violet-300">
          <LoaderCircle className="size-3.5 shrink-0 animate-spin text-violet-600 dark:text-violet-400" aria-hidden />
          靶点关联（{rel ? describeRelationType(rel.relationType) : '关联'}）— 正在生成合并评估报告（含关系分析章节）…
        </div>
      )}
      {!batch.relationJudging && !batch.merging && rel && (
        <div
          className={cn(
            'flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-3 py-2 text-xs leading-relaxed',
            rel.related
              ? 'border-violet-200 bg-violet-50/70 text-violet-800 dark:border-violet-900/70 dark:bg-violet-950/30 dark:text-violet-300'
              : 'border-stone-200 bg-stone-50/70 text-stone-600 dark:border-stone-800 dark:bg-stone-900/60 dark:text-stone-300'
          )}
        >
          <Link2 className={cn('size-3.5 shrink-0', rel.related ? 'text-violet-600 dark:text-violet-400' : 'text-stone-400')} aria-hidden />
          {rel.related ? (
            <>
              <span className="font-medium">关联靶点 · {describeRelationType(rel.relationType)}</span>
              <span className="text-stone-500 dark:text-stone-400">已合并生成一份报告（含关系性分析）</span>
            </>
          ) : (
            <>
              <span className="font-medium">{describeRelationType(rel.relationType)}</span>
              <span className="text-stone-500 dark:text-stone-400">分别生成报告（报告中已注明批次定位）</span>
            </>
          )}
          {rel.rationale && (
            <span
              className="hidden max-w-full truncate text-stone-400 dark:text-stone-500 md:inline"
              title={rel.rationale}
            >
              — {rel.rationale}
            </span>
          )}
        </div>
      )}
      {!batch.relationJudging && !rel && batch.relationError && (
        <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-300">
          <ShieldAlert className="size-3.5 shrink-0" aria-hidden />
          靶点关系判断未能完成（{batch.relationError}），已按独立项目分别生成报告
        </div>
      )}
      {!batch.merging && batch.mergedError && (
        <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-300">
          <ShieldAlert className="size-3.5 shrink-0" aria-hidden />
          合并报告生成失败（{batch.mergedError}）— 各靶点数据仍可正常查看，可重新发起评估重试
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        {/* 合并报告切换（关联批次，生成后显示） */}
        {batch.mergedReport && onShowMerged && (
          <button
            type="button"
            onClick={onShowMerged}
            title="查看本批次的合并评估报告（含靶点关系分析）"
            className={cn(
              'flex min-h-8 items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-semibold transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-violet-500/40',
              mergedActive
                ? 'border-violet-700 bg-violet-800 text-white'
                : 'border-violet-200 bg-violet-50 text-violet-700 hover:border-violet-400 hover:text-violet-800 dark:border-violet-900 dark:bg-violet-950/40 dark:text-violet-300 dark:hover:border-violet-700',
            )}
          >
            <FileStack className="size-3 shrink-0" aria-hidden />
            合并报告
          </button>
        )}
        {batch.items.map((item) => {
          const active = Boolean(item.jobId && item.jobId === currentJobId) && !mergedActive
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
