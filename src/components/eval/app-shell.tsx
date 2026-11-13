'use client'

import { useTheme } from 'next-themes'
import {
  ArrowLeft,
  Github,
  History,
  Moon,
  Plus,
  SlidersHorizontal,
  Sun,
  Workflow,
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

/** 品牌字标（侧边栏 / 移动顶栏共用）：Linear 式标记 + 600 字重紧凑字标 */
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
          <span className="lin-eyebrow mt-1 hidden text-muted-foreground/80 xl:block">
            结构解析可行性
          </span>
        )}
      </span>
    </button>
  )
}

/* ---------------- 侧边导航（桌面 lg+） ---------------- */

export interface AppSidebarProps {
  onOpenHistory: () => void
  onHome: () => void
  canGoHome: boolean
  onOpenLlmConfig: () => void
  engineIsBuiltin?: boolean
  /** idle 视图才显示的新建态 */
  isIdle: boolean
  /** 侧栏底部：最近评估插槽（children） */
  children?: React.ReactNode
}

/** 桌面侧边导航：品牌 + 工作区导航 + 最近评估插槽 + 底部工具行（Linear 应用壳） */
export function AppSidebar({
  onOpenHistory,
  onHome,
  canGoHome,
  onOpenLlmConfig,
  engineIsBuiltin = true,
  isIdle,
  children,
}: AppSidebarProps) {
  return (
    <aside
      aria-label="应用导航"
      className="hidden w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar lg:sticky lg:top-0 lg:flex lg:h-dvh"
    >
      {/* 品牌区 */}
      <div className="flex h-14 shrink-0 items-center px-4">
        <BrandMark onClick={onHome} canHome={canGoHome} />
      </div>

      {/* 工作区导航 */}
      <nav className="flex flex-col gap-0.5 px-2 pt-1" aria-label="工作区">
        <p className="lin-eyebrow px-2.5 pt-2 pb-1.5 text-muted-foreground/70">工作区</p>
        <button
          type="button"
          onClick={onHome}
          disabled={!canGoHome}
          aria-current={isIdle ? 'page' : undefined}
          className={cn(
            'relative flex min-h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/30',
            isIdle
              ? 'lin-nav-active bg-accent text-foreground'
              : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground',
            !canGoHome && 'cursor-default opacity-60 hover:bg-transparent',
          )}
        >
          {isIdle ? <Workflow className="size-4 shrink-0 text-primary" aria-hidden /> : <Plus className="size-4 shrink-0" aria-hidden />}
          新建评估
        </button>
        <button
          type="button"
          onClick={onOpenHistory}
          className="flex min-h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium text-muted-foreground outline-none transition-colors hover:bg-accent/70 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/30"
        >
          <History className="size-4 shrink-0" aria-hidden />
          历史评估
        </button>
        <button
          type="button"
          onClick={onOpenLlmConfig}
          className="flex min-h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium text-muted-foreground outline-none transition-colors hover:bg-accent/70 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/30"
        >
          <SlidersHorizontal className="size-4 shrink-0" aria-hidden />
          LLM 引擎
          {!engineIsBuiltin && (
            <span
              className="ml-auto size-1.5 shrink-0 rounded-full bg-emerald-500"
              aria-label="正在使用自定义 LLM 引擎"
            />
          )}
        </button>
      </nav>

      {/* 最近评估插槽（滚动） */}
      <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>

      {/* 底部工具行 */}
      <div className="flex h-12 shrink-0 items-center gap-0.5 border-t border-sidebar-border px-3">
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
        <span className="ml-auto font-mono text-[10px] tabular-nums text-muted-foreground/70">
          v1.11
        </span>
      </div>
    </aside>
  )
}

/* ---------------- 移动端顶栏（< lg） ---------------- */

export interface MobileHeaderProps {
  onOpenHistory: () => void
  onHome: () => void
  canGoHome: boolean
  onOpenLlmConfig: () => void
  engineIsBuiltin?: boolean
}

/** 移动端顶栏：品牌 + 返回 + 历史 / LLM / GitHub / 主题图标组 */
export function MobileHeader({
  onOpenHistory,
  onHome,
  canGoHome,
  onOpenLlmConfig,
  engineIsBuiltin = true,
}: MobileHeaderProps) {
  return (
    <header className="sticky top-0 z-40 flex h-12 shrink-0 items-center gap-1.5 border-b border-border bg-background/90 px-3 backdrop-blur-md lg:hidden">
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
      <BrandMark onClick={onHome} canHome={canGoHome} compact />
      <div className="ml-auto flex items-center gap-0.5">
        <button
          type="button"
          onClick={onOpenHistory}
          aria-label="历史评估"
          className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <History className="size-4" />
        </button>
        <button
          type="button"
          onClick={onOpenLlmConfig}
          aria-label="LLM 分析引擎配置"
          title="LLM 分析引擎配置"
          className="relative inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <SlidersHorizontal className="size-4" />
          {!engineIsBuiltin && (
            <span
              className="absolute top-1 right-1 size-1.5 rounded-full bg-emerald-500"
              aria-label="正在使用自定义 LLM 引擎"
            />
          )}
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
