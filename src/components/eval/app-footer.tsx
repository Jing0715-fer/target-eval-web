export function AppFooter() {
  return (
    <footer className="mt-auto border-t border-stone-200 bg-white/60 dark:border-stone-800 dark:bg-stone-950/60">
      <div className="mx-auto w-full max-w-6xl px-4 py-3.5 text-center text-[11px] leading-relaxed text-stone-500 dark:text-stone-500 sm:px-6">
        TargetEval — 数据源：UniProt · RCSB PDB · PDBe · PubMed · NCBI BLAST | LLM 生成评估摘要，仅供参考
      </div>
    </footer>
  )
}
