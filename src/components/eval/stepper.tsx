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
 * Linear 式流程指示器：编号节点 + 发丝线连接；当前步高亮、完成步打勾
 * @param step 已完成的步骤数（0-4）。done 时传 4 表示全部完成。
 */
export function Stepper({ step, className }: { step: number; className?: string }) {
  return (
    <ol className={cn('flex items-center gap-1 sm:gap-1.5', className)} aria-label="评估流程步骤">
      {STEPS.map((s, i) => {
        const done = i < step
        const active = i === step
        return (
          <li key={s.label} className="flex min-w-0 flex-1 items-center gap-1 sm:gap-1.5">
            <span className="flex shrink-0 items-center gap-1.5">
              <span
                className={cn(
                  'flex size-4.5 shrink-0 items-center justify-center rounded-full border transition-colors duration-300',
                  done
                    ? 'border-primary bg-primary text-primary-foreground'
                    : active
                      ? 'border-primary text-primary'
                      : 'border-border text-transparent',
                )}
                aria-hidden
              >
                {done ? (
                  <Check className="size-2.5" strokeWidth={3} />
                ) : active ? (
                  <span className="size-1.5 rounded-full bg-primary" />
                ) : null}
              </span>
              <span
                className={cn(
                  'text-[11.5px] font-medium whitespace-nowrap transition-colors',
                  done || active ? 'text-foreground' : 'text-muted-foreground/60',
                )}
              >
                {s.label}
              </span>
            </span>
            {i < STEPS.length - 1 && (
              <span
                aria-hidden
                className={cn(
                  'h-px min-w-1 flex-1 transition-colors duration-500',
                  done ? 'bg-primary/60' : 'bg-border',
                )}
              />
            )}
          </li>
        )
      })}
    </ol>
  )
}
