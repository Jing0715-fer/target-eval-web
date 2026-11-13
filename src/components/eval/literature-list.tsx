'use client'

import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { ChevronDown, ChevronUp, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { LiteratureItem, PdbEntry } from './types'

/** 折叠阈值：超过该数量时默认只显示前 N 条 */
const COLLAPSED_COUNT = 8
/** 每条文献最多展示的关联结构数 */
const MAX_LINKED_PDB = 6

export interface LiteratureListProps {
  items: LiteratureItem[]
  /** PDB 列表（用于建立 PMID → 结构关联） */
  pdbs?: PdbEntry[] | null
}

/** 文献列表：编号列表 + 关联 PDB chips + 长列表折叠 */
export function LiteratureList({ items, pdbs }: LiteratureListProps) {
  const [expanded, setExpanded] = useState(false)

  // PMID → 关联的 PDB 结构（同一篇文献常对应多个结构条目）
  const pdbsByPmid = useMemo(() => {
    const m = new Map<string, PdbEntry[]>()
    for (const p of pdbs ?? []) {
      const key = String(p.pubmedId ?? '').trim()
      if (!key) continue
      const arr = m.get(key)
      if (arr) arr.push(p)
      else m.set(key, [p])
    }
    return m
  }, [pdbs])

  const collapsed = !expanded && items.length > COLLAPSED_COUNT
  const visible = collapsed ? items.slice(0, COLLAPSED_COUNT) : items

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <ol className="divide-y divide-border/60">
        {visible.map((it, i) => {
          const linked = pdbsByPmid.get(String(it.pmid ?? '').trim()) ?? []
          return (
            <motion.li
              key={it.pmid || `${it.title}-${i}`}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, delay: Math.min(i * 0.03, 0.3), ease: 'easeOut' }}
              className="group relative"
            >
              <div className="flex items-start gap-3 px-4 py-3.5 transition-colors hover:bg-accent/50 sm:px-5">
                {/* 序号 */}
                <span className="mt-0.5 w-6 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground/40">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <div className="min-w-0 flex-1">
                  <a
                    href={it.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${it.pmid}/` : undefined}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm leading-snug font-medium text-foreground underline-offset-2 transition-colors hover:text-primary hover:underline"
                  >
                    {it.title || '无标题文献'}
                  </a>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    {it.journal && <span className="italic">{it.journal}</span>}
                    {it.year && <span>{it.journal ? '· ' : ''}{it.year}</span>}
                    {it.doi && (
                      <span className="max-w-full truncate font-mono text-[11px] text-muted-foreground/70" title={it.doi}>
                        DOI: {it.doi}
                      </span>
                    )}
                    {it.pmid && (
                      <span className="rounded-sm border border-border px-1.5 py-px font-mono text-[10px] text-muted-foreground">
                        PMID {it.pmid}
                      </span>
                    )}
                    {it.fromPdb && (
                      <span className="rounded-sm border border-primary/30 bg-primary/[0.06] px-1.5 py-px text-[10px] font-semibold text-primary">
                        结构解析文献
                      </span>
                    )}
                  </div>
                  {/* 关联结构 */}
                  {linked.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-1">
                      <span className="eval-eyebrow text-muted-foreground/70">关联结构</span>
                      {linked.slice(0, MAX_LINKED_PDB).map((p) => (
                        <a
                          key={p.pdbId}
                          href={`https://www.rcsb.org/structure/${p.pdbId}`}
                          target="_blank"
                          rel="noreferrer"
                          title={p.title || p.pdbId}
                          className="rounded-sm border border-primary/30 bg-primary/[0.06] px-1.5 py-px font-mono text-[10px] font-semibold text-primary transition-colors hover:bg-primary/[0.12]"
                        >
                          {p.pdbId}
                        </a>
                      ))}
                      {linked.length > MAX_LINKED_PDB && (
                        <span
                          className="font-mono text-[10px] text-muted-foreground/60"
                          title={linked.slice(MAX_LINKED_PDB).map((p) => p.pdbId).join(', ')}
                        >
                          +{linked.length - MAX_LINKED_PDB}
                        </span>
                      )}
                    </div>
                  )}
                </div>
                <ExternalLink className="mt-1 size-3.5 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-primary" />
              </div>
            </motion.li>
          )
        })}
      </ol>

      {/* 折叠/展开控制 */}
      {items.length > COLLAPSED_COUNT && (
        <div className="border-t border-border/70">
          <Button
            variant="ghost"
            onClick={() => setExpanded((v) => !v)}
            className="h-10 w-full gap-1.5 rounded-none font-mono text-[11px] text-muted-foreground hover:bg-accent hover:text-primary"
            aria-expanded={expanded}
          >
            {expanded ? (
              <>
                <ChevronUp className="size-3.5" />
                收起文献列表
              </>
            ) : (
              <>
                <ChevronDown className="size-3.5" />
                展开全部 {items.length} 篇（当前显示前 {COLLAPSED_COUNT} 篇）
              </>
            )}
          </Button>
        </div>
      )}
    </div>
  )
}
