'use client'

import { cn } from '@/lib/utils'
import type { AssetKind, JobStatus } from './types'
import { scoreLevel } from './format'

/** 结构解析方法标签（X-ray / Cryo-EM / NMR）：细边框 + 浅底色 */
export function MethodBadge({
  method,
  isXray,
  isCryoem,
  isNmr,
  className,
}: {
  method?: string
  isXray?: boolean
  isCryoem?: boolean
  isNmr?: boolean
  className?: string
}) {
  let label = (method ?? '').trim()
  let cls =
    'border-stone-200 bg-stone-50 text-stone-500 dark:border-stone-700 dark:bg-stone-800/60 dark:text-stone-400'
  if (isXray || /x-?ray|diffraction/i.test(label)) {
    label = 'X-ray'
    cls = 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-400'
  } else if (isCryoem || /cryo|electron/i.test(label)) {
    label = 'Cryo-EM'
    cls = 'border-teal-200 bg-teal-50 text-teal-800 dark:border-teal-900 dark:bg-teal-950/60 dark:text-teal-400'
  } else if (isNmr || /nmr|nuclear/i.test(label)) {
    label = 'NMR'
    cls = 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-400'
  }
  if (!label) label = '—'
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-sm border px-1.5 py-px text-[10px] font-semibold tracking-wide whitespace-nowrap',
        cls,
        className
      )}
    >
      {label}
    </span>
  )
}

/** 实验图片类型标签 */
export function KindBadge({ kind, className }: { kind: AssetKind | string; className?: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    gel: {
      label: 'SDS-PAGE',
      cls: 'border-amber-300/80 bg-amber-50/95 text-amber-800 dark:border-amber-800 dark:bg-amber-950/90 dark:text-amber-400',
    },
    sec: {
      label: 'SEC',
      cls: 'border-teal-300/80 bg-teal-50/95 text-teal-800 dark:border-teal-800 dark:bg-teal-950/90 dark:text-teal-400',
    },
    other: {
      label: '其他',
      cls: 'border-stone-300/80 bg-stone-50/95 text-stone-600 dark:border-stone-700 dark:bg-stone-800/90 dark:text-stone-400',
    },
  }
  const item = map[kind] ?? map.other
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-sm border px-1.5 py-px text-[10px] font-semibold tracking-wide backdrop-blur-sm',
        item.cls,
        className
      )}
    >
      {item.label}
    </span>
  )
}

/** 作业状态标签 */
export function StatusBadge({ status, className }: { status: JobStatus; className?: string }) {
  const map: Record<JobStatus, { label: string; cls: string; pulse?: boolean }> = {
    done: { label: '完成', cls: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-400' },
    running: { label: '运行中', cls: 'border-teal-200 bg-teal-50 text-teal-800 dark:border-teal-800 dark:bg-teal-950/60 dark:text-teal-400', pulse: true },
    pending: { label: '排队中', cls: 'border-stone-200 bg-stone-50 text-stone-500 dark:border-stone-700 dark:bg-stone-800/60 dark:text-stone-400' },
    error: { label: '失败', cls: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/60 dark:text-red-400' },
    canceled: { label: '已取消', cls: 'border-stone-200 bg-stone-50 text-stone-400 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-500' },
  }
  const item = map[status] ?? map.pending
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-px text-[10px] font-semibold tracking-wide whitespace-nowrap',
        item.cls,
        className
      )}
    >
      {item.pulse && <span className="relative flex size-1.5">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-teal-500 opacity-75" />
        <span className="relative inline-flex size-1.5 rounded-full bg-teal-600" />
      </span>}
      {item.label}
    </span>
  )
}

/** 评分档位标签 */
export function RatingBadge({
  score,
  rating,
  className,
}: {
  score: number | null | undefined
  rating?: string | null
  className?: string
}) {
  const level = scoreLevel(score)
  const levelCls = {
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-400',
    amber: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-400',
    red: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/60 dark:text-red-400',
  }[level]
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-sm border px-1.5 py-px text-[10px] font-semibold tracking-wide whitespace-nowrap',
        levelCls,
        className
      )}
    >
      {rating?.trim() || (score != null ? `${Number(score.toFixed(1))}/10` : '—')}
    </span>
  )
}
