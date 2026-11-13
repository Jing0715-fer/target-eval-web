/** 紧凑底部信息条：单行数据源说明（含当前 LLM 分析引擎 / 数据隔离说明） */
import { ShieldCheck } from 'lucide-react'

export function AppFooter({ engineSummary }: { engineSummary?: string }) {
  return (
    <footer className="mt-auto border-t border-stone-200 bg-[#fafaf9] dark:border-stone-800 dark:bg-stone-950">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-center gap-x-3 gap-y-1 px-4 py-2.5 text-center sm:px-6">
        <span className="font-display text-[11px] font-bold tracking-tight text-stone-500 dark:text-stone-400">
          TargetEval
          <span className="mx-1.5 font-sans font-normal text-stone-300 dark:text-stone-600" aria-hidden>·</span>
          <span className="font-mono text-[10px] font-normal text-stone-400 dark:text-stone-500">v1.11</span>
        </span>
        <span className="hidden h-3 w-px bg-stone-200 sm:block dark:bg-stone-800" aria-hidden />
        <p className="text-[11px] leading-relaxed text-stone-400 dark:text-stone-500">
          数据源：UniProt · RCSB PDB · PDBe · PubMed · NCBI BLAST — LLM 分析仅供参考
          {engineSummary && (
            <>
              {' — '}
              <span className="font-mono">引擎：{engineSummary}</span>
            </>
          )}
        </p>
        <span className="hidden h-3 w-px bg-stone-200 sm:block dark:bg-stone-800" aria-hidden />
        <p className="flex items-center gap-1 text-[11px] text-stone-400 dark:text-stone-500">
          <ShieldCheck className="size-3 text-emerald-600/70 dark:text-emerald-500/70" aria-hidden />
          记录按网络隔离，仅本人可见，保留 7 天
        </p>
      </div>
    </footer>
  )
}
