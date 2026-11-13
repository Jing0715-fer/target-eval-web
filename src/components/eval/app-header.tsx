'use client'

import { useTheme } from 'next-themes'
import { ArrowLeft, Github, History, Moon, SlidersHorizontal, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/** 项目 GitHub 仓库地址 */
const GITHUB_REPO_URL = 'https://github.com/Jing0715-fer/target-eval-web'

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-8 rounded-md text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
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
  /** 打开 LLM 引擎配置 */
  onOpenLlmConfig: () => void
  /** 当前是否为内置引擎（false 时配置按钮显示绿点） */
  engineIsBuiltin?: boolean
}

/** 紧凑顶栏（h-12）：衬线字标（可点击返回）+ 历史记录 + LLM 引擎配置 + 主题切换 */
export function AppHeader({ onOpenHistory, onHome, canGoHome, onOpenLlmConfig, engineIsBuiltin = true }: AppHeaderProps) {
  return (
    <header className="sticky top-0 z-40 border-b border-stone-200/90 bg-[#fafaf9]/92 backdrop-blur-md dark:border-stone-800/90 dark:bg-stone-950/92">
      {/* 顶部发丝渐变线（emerald → 透明） */}
      <div
        className="h-[2px] bg-gradient-to-r from-emerald-800 via-emerald-700/70 to-transparent dark:from-emerald-600 dark:via-emerald-600/60"
        aria-hidden
      />
      <div className="mx-auto flex h-11 w-full max-w-6xl items-center gap-2.5 px-4 sm:px-5">
        <button
          type="button"
          onClick={() => canGoHome && onHome?.()}
          aria-label={canGoHome ? '返回首页，开始新的评估' : 'TargetEval 首页'}
          className={cn(
            'flex min-w-0 items-center gap-2 rounded-md py-0.5 pr-2 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-emerald-500/40',
            canGoHome && 'cursor-pointer'
          )}
        >
          <span className="size-1.5 shrink-0 rounded-[1.5px] bg-emerald-700 dark:bg-emerald-500" aria-hidden />
          <span className="font-display truncate text-[15px] font-bold tracking-tight text-stone-900 dark:text-stone-50">
            TargetEval
          </span>
          <span className="eval-eyebrow hidden truncate text-stone-400 md:block dark:text-stone-500">
            结构解析可行性评估
          </span>
        </button>

        <div className="ml-auto flex items-center gap-0.5">
          {canGoHome && (
            <Button
              variant="ghost"
              onClick={onHome}
              className="mr-1 hidden h-8 gap-1.5 rounded-md px-2.5 text-xs font-medium text-stone-500 hover:text-emerald-800 dark:text-stone-400 dark:hover:text-emerald-400 sm:inline-flex"
            >
              <ArrowLeft className="size-3.5" />
              新建评估
            </Button>
          )}
          <Button
            variant="ghost"
            onClick={onOpenHistory}
            className="h-8 gap-1.5 rounded-md px-2.5 text-xs font-medium text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
          >
            <History className="size-3.5" />
            <span className="hidden sm:inline">历史评估</span>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onOpenLlmConfig}
            aria-label="LLM 分析引擎配置"
            title="LLM 分析引擎配置"
            className="relative size-8 rounded-md text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
          >
            <SlidersHorizontal className="size-4" />
            {!engineIsBuiltin && (
              <span
                className="absolute top-1 right-1 size-1.5 rounded-full bg-emerald-500"
                aria-label="正在使用自定义 LLM 引擎"
              />
            )}
          </Button>
          <a
            href={GITHUB_REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="GitHub 仓库"
            title="GitHub 仓库"
            className="inline-flex size-8 items-center justify-center rounded-md text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-900 dark:text-stone-400 dark:hover:bg-stone-800/60 dark:hover:text-stone-100"
          >
            <Github className="size-4" />
          </a>
          <ThemeToggle />
        </div>
      </div>
    </header>
  )
}
