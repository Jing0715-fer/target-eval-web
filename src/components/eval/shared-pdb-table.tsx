'use client'

import { ExternalLink, Layers } from 'lucide-react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { MethodBadge } from './badges'
import { formatDate, formatResolution } from './format'
import type { SharedStructure } from './types'

export interface SharedPdbTableProps {
  shared: SharedStructure[]
}

/**
 * 共有结构表（v1.22）：同一 PDB 覆盖多个输入 UniProt 的结构。
 * "覆盖靶点"列以 chip 形式分开展示该 PDB 引用的各 UniProt 及其链范围（UniProt 残基编号）。
 */
export function SharedPdbTable({ shared }: SharedPdbTableProps) {
  if (shared.length === 0) return null
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="overflow-auto">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-muted/60">
            <TableRow className="hover:bg-transparent dark:hover:bg-transparent">
              <TableHead className="eval-eyebrow h-9 pl-4 text-muted-foreground">PDB ID</TableHead>
              <TableHead className="eval-eyebrow h-9 text-muted-foreground">方法</TableHead>
              <TableHead className="eval-eyebrow h-9 text-muted-foreground">分辨率</TableHead>
              <TableHead className="eval-eyebrow h-9 min-w-48 text-muted-foreground" title="该 PDB 覆盖的各输入 UniProt 及其链范围">
                覆盖靶点
              </TableHead>
              <TableHead className="eval-eyebrow h-9 min-w-44 text-muted-foreground">标题</TableHead>
              <TableHead className="eval-eyebrow h-9 text-muted-foreground">释放日期</TableHead>
              <TableHead className="eval-eyebrow h-9 pr-4 text-muted-foreground">文献</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shared.map((s, i) => (
              <TableRow
                key={`${s.pdbId}-${i}`}
                className="border-border/60 hover:bg-accent/50"
              >
                <TableCell className="pl-4">
                  <a
                    href={`https://www.rcsb.org/structure/${s.pdbId}`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-xs font-semibold text-primary underline-offset-2 hover:underline"
                  >
                    {s.pdbId}
                  </a>
                </TableCell>
                <TableCell>
                  <MethodBadge
                    method={s.method}
                    isXray={s.isXray}
                    isCryoem={s.isCryoem}
                    isNmr={s.isNmr}
                  />
                </TableCell>
                <TableCell className="font-mono text-xs tabular-nums text-foreground/80">
                  {formatResolution(s.resolution)}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {s.coverage.map((c, j) => (
                      <span
                        key={`${c.uniprotId}-${j}`}
                        title={`${c.proteinName}${c.chainRanges ? ` · ${c.chainRanges}（UniProt 残基编号范围）` : ''}`}
                        className="inline-flex items-center gap-1 rounded-md border border-primary/30 bg-primary/[0.06] px-1.5 py-0.5 font-mono text-[11px] text-primary"
                      >
                        {c.uniprotId}
                        {c.chainRanges && (
                          <span className="rounded-sm bg-primary/10 px-1 text-[10px] text-primary">
                            {c.chainRanges}
                          </span>
                        )}
                      </span>
                    ))}
                  </div>
                </TableCell>
                <TableCell
                  className="max-w-56 truncate text-xs text-foreground/80"
                  title={s.title}
                >
                  {s.title || '—'}
                </TableCell>
                <TableCell className="font-mono text-xs tabular-nums text-foreground/80">
                  {formatDate(s.releaseDate)}
                </TableCell>
                <TableCell className="pr-4">
                  {s.pubmedId ? (
                    <a
                      href={`https://pubmed.ncbi.nlm.nih.gov/${s.pubmedId}/`}
                      target="_blank"
                      rel="noreferrer"
                      title={`PubMed ${s.pubmedId}`}
                      className="inline-flex items-center gap-1 font-mono text-xs text-foreground/80 underline-offset-2 hover:text-primary hover:underline"
                    >
                      {s.pubmedId}
                      <ExternalLink className="size-3" />
                    </a>
                  ) : (
                    <span className="text-xs text-muted-foreground/40">—</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

/** 区块标题（eyebrow 样式，复用于 merged-report-view） */
export function SharedStructuresHeader({ count, total }: { count: number; total: number }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Layers className="size-3.5 text-primary" />
      <span className="eval-eyebrow text-muted-foreground">
        Shared Structures · 共有结构（{count} 个 · 覆盖 {total} 个靶点中的多个）
      </span>
    </div>
  )
}
