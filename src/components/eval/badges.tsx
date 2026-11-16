'use client'

import { cn } from '@/lib/utils'
import type { AssetKind, JobStatus } from './types'
import { scoreLevel } from './format'

/** 结构解析方法标签（X-ray / Cryo-EM / NMR）：细边框 + 浅底色（Linear 克制语义色） */
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
    'border-border bg-muted text-muted-foreground'
  if (isXray || /x-?ray|diffraction/i.test(label)) {
    label = 'X-ray'
    cls = 'border-primary/30 bg-primary/[0.06] text-primary'
  } else if (isCryoem || /cryo|electron/i.test(label)) {
    label = 'Cryo-EM'
    cls = 'border-teal-500/30 bg-teal-500/[0.06] text-teal-700 dark:text-teal-300'
  } else if (isNmr || /nmr|nuclear/i.test(label)) {
    label = 'NMR'
    cls = 'border-amber-500/30 bg-amber-500/[0.06] text-amber-700 dark:text-amber-400'
  }
  if (!label) label = '—'
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border px-1.5 py-px text-[10px] font-semibold tracking-wide whitespace-nowrap',
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
      cls: 'border-amber-500/40 bg-amber-500/90 text-amber-50 backdrop-blur-sm',
    },
    sec: {
      label: 'SEC',
      cls: 'border-teal-500/40 bg-teal-500/90 text-teal-50 backdrop-blur-sm',
    },
    other: {
      label: '其他',
      cls: 'border-border bg-card/90 text-muted-foreground backdrop-blur-sm',
    },
  }
  const item = map[kind] ?? map.other
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border px-1.5 py-px text-[10px] font-semibold tracking-wide',
        item.cls,
        className
      )}
    >
      {item.label}
    </span>
  )
}

/** 作业状态标签（Linear status pill） */
export function StatusBadge({ status, className }: { status: JobStatus; className?: string }) {
  const map: Record<JobStatus, { label: string; cls: string; pulse?: boolean }> = {
    done: { label: '完成', cls: 'border-emerald-500/30 bg-emerald-500/[0.08] text-emerald-700 dark:text-emerald-400' },
    running: { label: '运行中', cls: 'border-primary/30 bg-primary/[0.08] text-primary', pulse: true },
    pending: { label: '排队中', cls: 'border-border bg-muted text-muted-foreground' },
    error: { label: '失败', cls: 'border-red-500/30 bg-red-500/[0.08] text-red-600 dark:text-red-400' },
    canceled: { label: '已取消', cls: 'border-border bg-muted/60 text-muted-foreground/70' },
  }
  const item = map[status] ?? map.pending
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-1.5 py-px text-[10px] font-semibold tracking-wide whitespace-nowrap',
        item.cls,
        className
      )}
    >
      {item.pulse && <span className="relative flex size-1.5">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75" />
        <span className="relative inline-flex size-1.5 rounded-full bg-primary" />
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
    emerald: 'border-emerald-500/30 bg-emerald-500/[0.08] text-emerald-700 dark:text-emerald-400',
    amber: 'border-amber-500/30 bg-amber-500/[0.08] text-amber-700 dark:text-amber-400',
    red: 'border-red-500/30 bg-red-500/[0.08] text-red-600 dark:text-red-400',
  }[level]
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border px-1.5 py-px text-[10px] font-semibold tracking-wide whitespace-nowrap',
        levelCls,
        className
      )}
    >
      {rating?.trim() || (score != null ? `${Number(score.toFixed(1))}/10` : '—')}
    </span>
  )
}
