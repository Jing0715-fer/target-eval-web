'use client'

import { useTheme } from 'next-themes'
import { Dna, Github, History, Moon, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-11 text-stone-600 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
      aria-label="切换深浅色主题"
      onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
    >
      <Sun className="size-4 dark:hidden" />
      <Moon className="hidden size-4 dark:block" />
    </Button>
  )
}

export function AppHeader({ onOpenHistory }: { onOpenHistory: () => void }) {
  return (
    <header className="sticky top-0 z-40 border-b border-stone-200/80 bg-white/85 backdrop-blur-md dark:border-stone-800/80 dark:bg-stone-950/85">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-3 px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-emerald-600 text-white shadow-sm">
            <Dna className="size-5" />
          </div>
          <div className="min-w-0 leading-tight">
            <div className="truncate text-sm font-bold tracking-tight text-stone-900 dark:text-stone-50">
              TargetEval
              <span className="mx-1.5 font-normal text-stone-300 dark:text-stone-600">·</span>
              <span className="font-medium text-stone-600 dark:text-stone-400">
                靶点结构解析可行性评估
              </span>
            </div>
            <div className="hidden text-[11px] text-stone-500 dark:text-stone-500 sm:block">
              UniProt · RCSB PDB · PDBe · PubMed · BLAST
            </div>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            onClick={onOpenHistory}
            className="h-11 gap-1.5 px-3 text-stone-600 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
          >
            <History className="size-4" />
            <span className="hidden sm:inline">历史评估</span>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-11 text-stone-600 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
            asChild
          >
            <a
              href="https://github.com/Jing0715-fer/pdb-tracker-web-v5"
              target="_blank"
              rel="noreferrer"
              aria-label="GitHub 仓库"
            >
              <Github className="size-4" />
            </a>
          </Button>
          <ThemeToggle />
        </div>
      </div>
    </header>
  )
}
