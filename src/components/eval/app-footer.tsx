/** 底部信息条：细线 + 数据源说明 */
export function AppFooter() {
  return (
    <footer className="mt-auto border-t border-stone-200 bg-[#fafaf9] dark:border-stone-800 dark:bg-stone-950">
      <div className="mx-auto flex w-full max-w-6xl flex-col items-center gap-1 px-4 py-4 text-center sm:px-6">
        <div className="eval-eyebrow text-stone-400 dark:text-stone-600">
          <span className="font-display text-[11px] font-bold normal-case tracking-normal text-stone-500 dark:text-stone-400">
            TargetEval
          </span>
          <span className="mx-1.5" aria-hidden>·</span>
          Protein Structure Feasibility Evaluation
        </div>
        <p className="text-[11px] leading-relaxed text-stone-400 dark:text-stone-500">
          数据源：UniProt · RCSB PDB · PDBe · PubMed · NCBI BLAST — LLM 生成的评估分析仅供参考
        </p>
      </div>
    </footer>
  )
}
