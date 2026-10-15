'use client'

import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { AssetKind, JobStatus } from './types'
import { scoreLevel } from './format'

/** 结构解析方法徽章（X-ray / Cryo-EM / NMR） */
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
    'border-stone-300 bg-stone-100 text-stone-600 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-400'
  if (isXray || /x-?ray|diffraction/i.test(label)) {
    label = 'X-ray'
    cls = 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-400'
  } else if (isCryoem || /cryo|electron/i.test(label)) {
    label = 'Cryo-EM'
    cls = 'border-teal-300 bg-teal-50 text-teal-700 dark:border-teal-900 dark:bg-teal-950 dark:text-teal-400'
  } else if (isNmr || /nmr|nuclear/i.test(label)) {
    label = 'NMR'
    cls = 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-400'
  }
  if (!label) label = '—'
  return (
    <Badge variant="outline" className={cn('text-[11px]', cls, className)}>
      {label}
    </Badge>
  )
}

/** 实验图片类型徽章 */
export function KindBadge({ kind, className }: { kind: AssetKind | string; className?: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    gel: {
      label: 'SDS-PAGE 胶图',
      cls: 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-400',
    },
    sec: {
      label: 'SEC 分子筛',
      cls: 'border-teal-300 bg-teal-50 text-teal-700 dark:border-teal-800 dark:bg-teal-950 dark:text-teal-400',
    },
    other: {
      label: '其他',
      cls: 'border-stone-300 bg-stone-100 text-stone-600 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-400',
    },
  }
  const item = map[kind] ?? map.other
  return (
    <Badge
      variant="outline"
      className={cn('bg-white/90 text-[10px] backdrop-blur-sm dark:bg-stone-900/90', item.cls, className)}
    >
      {item.label}
    </Badge>
  )
}

/** 作业状态徽章 */
export function StatusBadge({ status, className }: { status: JobStatus; className?: string }) {
  const map: Record<JobStatus, { label: string; cls: string; pulse?: boolean }> = {
    done: { label: '完成', cls: 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-400' },
    running: { label: '运行中', cls: 'border-teal-300 bg-teal-50 text-teal-700 dark:border-teal-800 dark:bg-teal-950 dark:text-teal-400', pulse: true },
    pending: { label: '排队中', cls: 'border-stone-300 bg-stone-100 text-stone-600 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-400' },
    error: { label: '失败', cls: 'border-red-300 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400' },
    canceled: { label: '已取消', cls: 'border-stone-300 bg-stone-50 text-stone-500 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-400' },
  }
  const item = map[status] ?? map.pending
  return (
    <Badge variant="outline" className={cn('gap-1.5 text-[11px]', item.cls, className)}>
      {item.pulse && <span className="relative flex size-1.5">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-teal-500 opacity-75" />
        <span className="relative inline-flex size-1.5 rounded-full bg-teal-500" />
      </span>}
      {item.label}
    </Badge>
  )
}

/** 评分档位徽章 */
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
    emerald: 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-400',
    amber: 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-400',
    red: 'border-red-300 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400',
  }[level]
  return (
    <Badge variant="outline" className={cn('text-[11px]', levelCls, className)}>
      {rating?.trim() || (score != null ? `${Number(score.toFixed(1))}/10` : '—')}
    </Badge>
  )
}
