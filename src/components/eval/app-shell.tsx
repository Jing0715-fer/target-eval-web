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
import { APP_VERSION } from '@/lib/version'

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
        'inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-all duration-200 outline-none hover:bg-accent hover:text-foreground hover:shadow-sm active:scale-95 focus-visible:ring-[3px] focus-visible:ring-ring/30',
        className,
      )}
    >
      <Sun className="size-4 transition-transform duration-300 dark:hidden dark:rotate-90" />
      <Moon className="hidden size-4 rotate-0 transition-transform duration-300 dark:block dark:-rotate-12" />
    </button>
  )
}

/** 品牌字标（顶部栏共用）：渐变标记 + 600 字重紧凑字标 + 版本 mono 角标 */
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
        'group flex min-w-0 items-center gap-2.5 rounded-lg py-1 pr-2 text-left outline-none transition-opacity focus-visible:ring-[3px] focus-visible:ring-ring/30',
        canHome && 'cursor-pointer',
      )}
    >
      {/* Claude 式品牌图标：渐变底 + 光晕阴影 + 20s 缓慢旋转（参考项目 header-icon-wrap） */}
      <span
        aria-hidden
        className="header-icon-wrap flex size-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-[#6d74e0] via-[#5e6ad2] to-[#7a5ce4] text-[13px] font-bold text-white shadow-[0_2px_8px_rgb(94_106_210/0.35)] ring-1 ring-[#5e6ad2]/20"
      >
        <span className="header-icon-spin">T</span>
      </span>
      <span className="flex min-w-0 flex-col leading-none">
        <span className="flex items-baseline gap-1.5">
          <span className="header-text-gradient truncate text-[15px] font-bold tracking-[-0.015em]">
            TargetEval
          </span>
          <span className="hidden font-mono text-[9.5px] font-medium text-muted-foreground/55 md:inline" aria-hidden>
            {APP_VERSION}
          </span>
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

/* ---------------- 顶部应用栏（v2.86 玻璃拟态升级） ---------------- */

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
 * 顶部应用栏（全断点）：玻璃拟态画布 + 渐变发丝线底边；
 * 品牌 + 返回 + 历史评估 / LLM 引擎 / GitHub / 主题切换。
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
      className="header-gradient-border header-enhanced-bg sticky top-0 z-40 flex h-12 shrink-0 items-center gap-1.5 px-3 sm:h-14 sm:gap-2 sm:px-6"
    >
      {/* Claude 式头部：对角微染背景 + 底边主色渐变描边（::after）— 去 backdrop 玻璃，质感靠色彩层 */}
      {canGoHome ? (
        <button
          type="button"
          onClick={onHome}
          aria-label="返回首页，开始新的评估"
          className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-all duration-200 hover:bg-accent hover:text-foreground active:scale-95"
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
            'relative inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12.5px] font-medium text-muted-foreground outline-none transition-all duration-200 hover:bg-accent hover:text-foreground active:scale-[0.97] focus-visible:ring-[3px] focus-visible:ring-ring/30 sm:px-2.5',
            !engineIsBuiltin && 'text-foreground',
          )}
        >
          <SlidersHorizontal className="size-4 shrink-0" aria-hidden />
          <span className="hidden sm:inline">LLM 引擎</span>
          {!engineIsBuiltin && (
            <span
              className="absolute top-1 right-1 size-1.5 rounded-full bg-emerald-500 shadow-[0_0_6px_rgb(16_185_129/0.8)] sm:static sm:ml-1"
              aria-label="正在使用自定义 LLM 引擎"
            />
          )}
        </button>
        <button
          type="button"
          onClick={onOpenHistory}
          aria-label="历史评估"
          title="历史评估"
          className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12.5px] font-medium text-muted-foreground outline-none transition-all duration-200 hover:bg-accent hover:text-foreground active:scale-[0.97] focus-visible:ring-[3px] focus-visible:ring-ring/30 sm:px-2.5"
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
          className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-all duration-200 hover:bg-accent hover:text-foreground hover:shadow-sm active:scale-95"
        >
          <Github className="size-4" />
        </a>
        <ThemeToggle />
      </div>
    </header>
  )
}
