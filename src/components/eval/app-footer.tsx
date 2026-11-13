/** 紧凑底部信息条：数据源说明 + 当前 LLM 引擎 + 数据隔离提示（Linear 式低调页脚） */
import { ShieldCheck } from 'lucide-react'

export function AppFooter({ engineSummary }: { engineSummary?: string }) {
  return (
    <footer className="mt-auto border-t border-border bg-background">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-center gap-x-3 gap-y-1 px-4 py-2.5 text-center sm:px-5 lg:px-6">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold tracking-[-0.01em] text-muted-foreground">
          <span className="size-1.5 rounded-[2px] bg-primary" aria-hidden />
          TargetEval
          <span className="font-normal text-muted-foreground/50" aria-hidden>·</span>
          <span className="font-mono text-[10px] font-normal text-muted-foreground/70">v1.11</span>
        </span>
        <span className="hidden h-3 w-px bg-border sm:block" aria-hidden />
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          数据源：UniProt · RCSB PDB · PDBe · PubMed · NCBI BLAST — LLM 分析仅供参考
          {engineSummary && (
            <>
              {' — '}
              <span className="font-mono text-[10px]">引擎：{engineSummary}</span>
            </>
          )}
        </p>
        <span className="hidden h-3 w-px bg-border sm:block" aria-hidden />
        <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <ShieldCheck className="size-3 text-emerald-600/80 dark:text-emerald-500/80" aria-hidden />
          记录按网络隔离，仅本人可见，保留 7 天
        </p>
      </div>
    </footer>
  )
}
