'use client'

import { BrainCircuit, Check, Database, FileText, PencilLine } from 'lucide-react'
import { cn } from '@/lib/utils'

const STEPS = [
  { label: '输入', icon: PencilLine },
  { label: '数据收集', icon: Database },
  { label: '分析生成', icon: BrainCircuit },
  { label: '报告', icon: FileText },
]

/**
 * 顶部步骤指示器
 * @param step 已完成的步骤数（0-4）。done 时传 4 表示全部完成。
 */
export function Stepper({ step, className }: { step: number; className?: string }) {
  return (
    <ol className={cn('flex items-center gap-1.5 sm:gap-3', className)} aria-label="评估流程步骤">
      {STEPS.map((s, i) => {
        const done = i < step
        const active = i === step
        return (
          <li key={s.label} className="flex min-w-0 flex-1 items-center gap-1.5 sm:gap-2.5">
            <span
              className={cn(
                'flex size-6 shrink-0 items-center justify-center rounded-full transition-colors sm:size-7',
                done && 'bg-emerald-600 text-white',
                active &&
                  'border-2 border-emerald-600 bg-emerald-50 text-emerald-700 dark:border-emerald-500 dark:bg-emerald-950 dark:text-emerald-400',
                !done &&
                  !active &&
                  'border border-stone-300 text-stone-400 dark:border-stone-700 dark:text-stone-500'
              )}
            >
              {done ? (
                <Check className="size-3 sm:size-3.5" />
              ) : (
                <s.icon className="size-3 sm:size-3.5" />
              )}
            </span>
            <span
              className={cn(
                'truncate text-xs font-medium whitespace-nowrap',
                (done || active) && 'text-stone-800 dark:text-stone-200',
                !done && !active && 'text-stone-400 dark:text-stone-500'
              )}
            >
              {s.label}
            </span>
            {i < STEPS.length - 1 && (
              <span
                className={cn(
                  'h-px min-w-2 flex-1 transition-colors',
                  done ? 'bg-emerald-500' : 'bg-stone-200 dark:bg-stone-700'
                )}
              />
            )}
          </li>
        )
      })}
    </ol>
  )
}
