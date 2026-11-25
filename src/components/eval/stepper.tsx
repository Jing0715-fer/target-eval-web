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
 * Refined Studio 流程指示器（v2.86）：编号节点 + 渐变填充连线；
 * 当前步光晕呼吸、完成步渐变打勾、连接线完成态 shimmer 流动
 * @param step 已完成的步骤数（0-4）。done 时传 4 表示全部完成。
 */
export function Stepper({ step, className }: { step: number; className?: string }) {
  return (
    <ol className={cn('flex items-center gap-1 sm:gap-1.5', className)} aria-label="评估流程步骤">
      {STEPS.map((s, i) => {
        const done = i < step
        const active = i === step
        return (
          <li
            key={s.label}
            className={cn(
              'flex min-w-0 items-center gap-1 sm:gap-1.5',
              // v2.55：末步不占 flex-1 — 此前 4 段等分导致「报告」节点后拖出约 1/4 宽的悬空连线空白
              i < STEPS.length - 1 ? 'flex-1' : 'shrink-0',
            )}
          >
            <span className="flex shrink-0 items-center gap-1.5">
              <span
                className={cn(
                  'relative flex size-5 shrink-0 items-center justify-center rounded-full border transition-all duration-300',
                  done
                    ? 'border-transparent bg-gradient-to-br from-[#6d74e0] to-[#7a5ce4] text-white shadow-[0_2px_8px_-2px_rgb(94_106_210/0.5)]'
                    : active
                      ? 'border-primary text-primary pulse-ring'
                      : 'border-border text-transparent',
                )}
                aria-hidden
              >
                {done ? (
                  <Check className="size-3" strokeWidth={3} />
                ) : active ? (
                  <span className="size-1.5 rounded-full bg-primary" />
                ) : null}
              </span>
              <span
                className={cn(
                  'text-[11.5px] font-medium whitespace-nowrap transition-colors duration-300',
                  done || active ? 'text-foreground' : 'text-muted-foreground/80',
                )}
              >
                {s.label}
              </span>
            </span>
            {i < STEPS.length - 1 && (
              <span
                aria-hidden
                className={cn(
                  'h-px min-w-1 flex-1 overflow-hidden rounded-full transition-colors duration-500',
                  done ? 'bg-primary/60' : 'bg-border',
                )}
              >
                {/* v2.86：完成段上的流动微光 — 缓慢从左到右扫过 */}
                {done && (
                  <span
                    className="block h-full w-1/3 bg-gradient-to-r from-transparent via-white/70 to-transparent"
                    style={{ animation: 'step-flow 2.4s ease-in-out infinite' }}
                  />
                )}
              </span>
            )}
          </li>
        )
      })}
    </ol>
  )
}
