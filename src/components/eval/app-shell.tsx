'use client'

import { useTheme } from 'next-themes'
import {
  ArrowLeft,
  Github,
  History,
  Moon,
  SlidersHorizontal,
  Sun,
} from 'lucide-react'
import { cn } from '@/lib/utils'

/** 项目 GitHub 仓库地址 */
const GITHUB_REPO_URL = 'https://github.com/Jing0715-fer/target-eval-web'

function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme()
  return (
    <button
      type="button"
      aria-label="切换深浅色主题"
      onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
      className={cn(
        'inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/30',
        className,
      )}
    >
      <Sun className="size-4 dark:hidden" />
      <Moon className="hidden size-4 dark:block" />
    </button>
  )
}

/** 品牌字标（顶部栏共用）：Linear 式标记 + 600 字重紧凑字标 */
export function BrandMark({
  onClick,
  canHome,
  compact = false,
}: {
  onClick?: () => void
  canHome?: boolean
  compact?: boolean
}) {
  return (
    <button
      type="button"
      onClick={() => canHome && onClick?.()}
      aria-label={canHome ? '返回首页，开始新的评估' : 'TargetEval 首页'}
      className={cn(
        'group flex min-w-0 items-center gap-2.5 rounded-lg py-1 pr-2 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30',
        canHome && 'cursor-pointer',
      )}
    >
      {/* 品牌标记：薰衣草蓝圆角方块 + 白色螺旋/靶点字符 */}
      <span
        aria-hidden
        className="flex size-6 shrink-0 items-center justify-center rounded-[7px] bg-primary text-[13px] font-bold text-primary-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]"
      >
        T
      </span>
      <span className="flex min-w-0 flex-col leading-none">
        <span className="truncate text-[14.5px] font-semibold tracking-[-0.01em] text-foreground">
          TargetEval
        </span>
        {!compact && (
          <span className="lin-eyebrow mt-1 hidden text-muted-foreground/80 lg:block">
            结构解析可行性
          </span>
        )}
      </span>
    </button>
  )
}

/* ---------------- 顶部应用栏（v1.3：恢复原顶栏布局，替代侧边栏） ---------------- */

export interface AppHeaderProps {
  onOpenHistory: () => void
  onHome: () => void
  canGoHome: boolean
  onOpenLlmConfig: () => void
  engineIsBuiltin?: boolean
  /** idle 视图才显示的新建态 */
  isIdle: boolean
}

/**
 * 顶部应用栏（全断点）：品牌 + 返回 + 历史评估 / LLM 引擎 / GitHub / 主题切换。
 * 「其他功能放在顶部」—— 与原版 app-header 布局一致，Linear 视觉。
 */
export function AppHeader({
  onOpenHistory,
  onHome,
  canGoHome,
  onOpenLlmConfig,
  engineIsBuiltin = true,
  isIdle,
}: AppHeaderProps) {
  return (
    <header
      className="sticky top-0 z-40 flex h-12 shrink-0 items-center gap-1.5 border-b border-border bg-background/90 px-3 backdrop-blur-md sm:h-14 sm:gap-2 sm:px-6"
    >
      {canGoHome ? (
        <button
          type="button"
          onClick={onHome}
          aria-label="返回首页，开始新的评估"
          className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
        </button>
      ) : null}
      <BrandMark onClick={onHome} canHome={canGoHome} compact={!isIdle} />
      <span className="mx-1 hidden h-4 w-px bg-border md:block" aria-hidden />

      {/* 右侧功能组：历史评估 · LLM 引擎 · GitHub · 主题 */}
      <div className="ml-auto flex items-center gap-0.5 sm:gap-1">
        <button
          type="button"
          onClick={onOpenLlmConfig}
          aria-label="LLM 分析引擎配置"
          title="LLM 分析引擎配置"
          className={cn(
            'relative inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12.5px] font-medium text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/30 sm:px-2.5',
            !engineIsBuiltin && 'text-foreground',
          )}
        >
          <SlidersHorizontal className="size-4 shrink-0" aria-hidden />
          <span className="hidden sm:inline">LLM 引擎</span>
          {!engineIsBuiltin && (
            <span
              className="absolute top-1 right-1 size-1.5 rounded-full bg-emerald-500 sm:static sm:ml-1"
              aria-label="正在使用自定义 LLM 引擎"
            />
          )}
        </button>
        <button
          type="button"
          onClick={onOpenHistory}
          aria-label="历史评估"
          title="历史评估"
          className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12.5px] font-medium text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/30 sm:px-2.5"
        >
          <History className="size-4 shrink-0" aria-hidden />
          <span className="hidden sm:inline">历史评估</span>
        </button>
        <a
          href={GITHUB_REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="GitHub 仓库"
          title="GitHub 仓库"
          className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Github className="size-4" />
        </a>
        <ThemeToggle />
      </div>
    </header>
  )
}
