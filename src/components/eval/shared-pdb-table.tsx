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
    <div className="overflow-hidden rounded-lg border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900">
      <div className="overflow-auto">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-stone-50 dark:bg-stone-900">
            <TableRow className="hover:bg-transparent dark:hover:bg-transparent">
              <TableHead className="eval-eyebrow h-9 pl-4 text-stone-500 dark:text-stone-400">PDB ID</TableHead>
              <TableHead className="eval-eyebrow h-9 text-stone-500 dark:text-stone-400">方法</TableHead>
              <TableHead className="eval-eyebrow h-9 text-stone-500 dark:text-stone-400">分辨率</TableHead>
              <TableHead className="eval-eyebrow h-9 min-w-48 text-stone-500 dark:text-stone-400" title="该 PDB 覆盖的各输入 UniProt 及其链范围">
                覆盖靶点
              </TableHead>
              <TableHead className="eval-eyebrow h-9 min-w-44 text-stone-500 dark:text-stone-400">标题</TableHead>
              <TableHead className="eval-eyebrow h-9 text-stone-500 dark:text-stone-400">释放日期</TableHead>
              <TableHead className="eval-eyebrow h-9 pr-4 text-stone-500 dark:text-stone-400">文献</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shared.map((s, i) => (
              <TableRow
                key={`${s.pdbId}-${i}`}
                className="border-stone-100 dark:border-stone-800/60 hover:bg-stone-50/70 dark:hover:bg-stone-800/40"
              >
                <TableCell className="pl-4">
                  <a
                    href={`https://www.rcsb.org/structure/${s.pdbId}`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-xs font-semibold text-emerald-800 underline-offset-2 hover:underline dark:text-emerald-400"
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
                <TableCell className="font-mono text-xs tabular-nums text-stone-600 dark:text-stone-400">
                  {formatResolution(s.resolution)}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {s.coverage.map((c, j) => (
                      <span
                        key={`${c.uniprotId}-${j}`}
                        title={`${c.proteinName}${c.chainRanges ? ` · ${c.chainRanges}（UniProt 残基编号范围）` : ''}`}
                        className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 font-mono text-[11px] text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-400"
                      >
                        {c.uniprotId}
                        {c.chainRanges && (
                          <span className="rounded-sm bg-emerald-100 px-1 text-[10px] text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300">
                            {c.chainRanges}
                          </span>
                        )}
                      </span>
                    ))}
                  </div>
                </TableCell>
                <TableCell
                  className="max-w-56 truncate text-xs text-stone-600 dark:text-stone-400"
                  title={s.title}
                >
                  {s.title || '—'}
                </TableCell>
                <TableCell className="font-mono text-xs tabular-nums text-stone-600 dark:text-stone-400">
                  {formatDate(s.releaseDate)}
                </TableCell>
                <TableCell className="pr-4">
                  {s.pubmedId ? (
                    <a
                      href={`https://pubmed.ncbi.nlm.nih.gov/${s.pubmedId}/`}
                      target="_blank"
                      rel="noreferrer"
                      title={`PubMed ${s.pubmedId}`}
                      className="inline-flex items-center gap-1 font-mono text-xs text-stone-600 underline-offset-2 hover:text-emerald-800 hover:underline dark:text-stone-400 dark:hover:text-emerald-400"
                    >
                      {s.pubmedId}
                      <ExternalLink className="size-3" />
                    </a>
                  ) : (
                    <span className="text-xs text-stone-300 dark:text-stone-600">—</span>
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
      <Layers className="size-3.5 text-emerald-700 dark:text-emerald-500" />
      <span className="eval-eyebrow text-stone-500 dark:text-stone-400">
        Shared Structures · 共有结构（{count} 个 · 覆盖 {total} 个靶点中的多个）
      </span>
    </div>
  )
}
