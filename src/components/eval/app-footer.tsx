/** 紧凑底部信息条：数据源说明 + 当前 LLM 引擎 + 数据隔离提示（Linear 式低调页脚） */
import { ShieldCheck } from 'lucide-react'
import { APP_VERSION } from '@/lib/version'

export function AppFooter({ engineSummary }: { engineSummary?: string }) {
  return (
    <footer className="mt-auto border-t border-border bg-background">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-center gap-x-3 gap-y-1 px-4 py-2.5 text-center sm:px-5 lg:px-6 xl:max-w-[1440px] 2xl:max-w-[1720px]">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold tracking-[-0.01em] text-muted-foreground">
          <span className="size-1.5 rounded-[2px] bg-primary" aria-hidden />
          TargetEval
          <span className="font-normal text-muted-foreground/50" aria-hidden>·</span>
          {/* v2.79：版本号改用单一来源（此前硬编码 v2.60.0 从未随版本推进更新 —
              排查用户部署版本时页脚版本号完全失真） */}
          <span className="font-mono text-[10px] font-normal text-muted-foreground/85">{APP_VERSION}</span>
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
        <p className="flex items-center gap-1 text-[11px] text-muted-foreground" title="服务器端评估记录与报告为运行数据：按保留策略定期清理（约 30 天），运行环境重置时会被一并清空；报告生成完成时会自动下载 HTML 到本机下载目录">
          <ShieldCheck className="size-3 text-emerald-600/80 dark:text-emerald-500/80" aria-hidden />
          记录仅本人可见 · 服务器数据保留约 30 天（环境重置后清空），重要报告请及时下载到本机
        </p>
      </div>
    </footer>
  )
}
