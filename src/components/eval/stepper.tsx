'use client'

import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

const STEPS = [
  { label: '输入', num: '01' },
  { label: '数据收集', num: '02' },
  { label: '分析生成', num: '03' },
  { label: '报告', num: '04' },
]

/**
 * 流程指示器（极简编号风）：mono 数字 + 文字 + 发丝线连接
 * @param step 已完成的步骤数（0-4）。done 时传 4 表示全部完成。
 */
export function Stepper({ step, className }: { step: number; className?: string }) {
  return (
    <ol className={cn('flex items-center gap-2 sm:gap-3', className)} aria-label="评估流程步骤">
      {STEPS.map((s, i) => {
        const done = i < step
        const active = i === step
        return (
          <li key={s.label} className="flex min-w-0 flex-1 items-center gap-2 sm:gap-2.5">
            <span className="flex shrink-0 items-center gap-1.5">
              <span
                className={cn(
                  'eval-eyebrow tabular-nums transition-colors',
                  done || active ? 'text-emerald-700 dark:text-emerald-500' : 'text-stone-300 dark:text-stone-600'
                )}
              >
                {done ? <Check className="size-3" /> : s.num}
              </span>
              <span
                className={cn(
                  'text-xs font-medium whitespace-nowrap transition-colors',
                  done || active
                    ? 'text-stone-800 dark:text-stone-200'
                    : 'text-stone-300 dark:text-stone-600'
                )}
              >
                {s.label}
              </span>
            </span>
            {i < STEPS.length - 1 && (
              <span
                aria-hidden
                className={cn(
                  'h-px min-w-3 flex-1 transition-colors duration-500',
                  done ? 'bg-emerald-600/70 dark:bg-emerald-700/70' : 'bg-stone-200 dark:bg-stone-800'
                )}
              />
            )}
          </li>
        )
      })}
    </ol>
  )
}
