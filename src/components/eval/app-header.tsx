'use client'

import { useTheme } from 'next-themes'
import { ArrowLeft, History, Moon, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-9 rounded-md text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
      aria-label="切换深浅色主题"
      onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
    >
      <Sun className="size-4 dark:hidden" />
      <Moon className="hidden size-4 dark:block" />
    </Button>
  )
}

export interface AppHeaderProps {
  onOpenHistory: () => void
  /** 非 idle 阶段时点击字标返回首页（新评估） */
  onHome?: () => void
  /** 当前是否处于非首页视图（显示返回按钮） */
  canGoHome?: boolean
}

/** 顶栏：衬线字标（可点击返回）+ 历史记录 + 主题切换 */
export function AppHeader({ onOpenHistory, onHome, canGoHome }: AppHeaderProps) {
  return (
    <header className="sticky top-0 z-40 border-b border-stone-200/90 bg-[#fafaf9]/90 backdrop-blur-md dark:border-stone-800/90 dark:bg-stone-950/90">
      {/* 顶部细线（期刊风双线） */}
      <div className="h-[3px] bg-emerald-800 dark:bg-emerald-700" aria-hidden />
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-3 px-4 sm:px-6">
        <button
          type="button"
          onClick={() => canGoHome && onHome?.()}
          aria-label={canGoHome ? '返回首页，开始新的评估' : 'TargetEval 首页'}
          className={cn(
            'flex min-w-0 items-center gap-2.5 rounded-md py-1 pr-2 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-emerald-500/40',
            canGoHome && 'cursor-pointer'
          )}
        >
          <span className="flex size-2 shrink-0 rounded-[2px] bg-emerald-700 dark:bg-emerald-500" aria-hidden />
          <span className="min-w-0 leading-tight">
            <span className="font-display block truncate text-[17px] font-bold tracking-tight text-stone-900 dark:text-stone-50">
              TargetEval
            </span>
            <span className="eval-eyebrow block text-stone-400 dark:text-stone-500">
              结构解析可行性评估
            </span>
          </span>
        </button>

        <div className="ml-auto flex items-center gap-0.5">
          {canGoHome && (
            <Button
              variant="ghost"
              onClick={onHome}
              className="mr-1 hidden h-9 gap-1.5 rounded-md px-3 text-xs font-medium text-stone-500 hover:text-emerald-800 dark:text-stone-400 dark:hover:text-emerald-400 sm:inline-flex"
            >
              <ArrowLeft className="size-3.5" />
              新建评估
            </Button>
          )}
          <Button
            variant="ghost"
            onClick={onOpenHistory}
            className="h-9 gap-1.5 rounded-md px-3 text-xs font-medium text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
          >
            <History className="size-3.5" />
            <span className="hidden sm:inline">历史评估</span>
          </Button>
          <ThemeToggle />
        </div>
      </div>
    </header>
  )
}
