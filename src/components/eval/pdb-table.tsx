'use client'

import { useMemo, useState } from 'react'
import { ExternalLink, Inbox } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { MethodBadge } from './badges'
import { formatDate, formatResolution } from './format'
import type { PdbEntry } from './types'

type MethodFilter = 'all' | 'xray' | 'cryoem' | 'nmr'

const FILTERS: { key: MethodFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'xray', label: 'X-ray' },
  { key: 'cryoem', label: 'Cryo-EM' },
  { key: 'nmr', label: 'NMR' },
]

export interface PdbTableProps {
  pdbs: PdbEntry[]
  ligandCount?: number | null
}

/** PDB 结构表：方法筛选 chips + 斑马纹滚动表格 */
export function PdbTable({ pdbs, ligandCount }: PdbTableProps) {
  const [filter, setFilter] = useState<MethodFilter>('all')

  const counts = useMemo(() => {
    const c = { all: pdbs.length, xray: 0, cryoem: 0, nmr: 0 }
    for (const p of pdbs) {
      if (p.isXray) c.xray += 1
      if (p.isCryoem) c.cryoem += 1
      if (p.isNmr) c.nmr += 1
    }
    return c
  }, [pdbs])

  const filtered = useMemo(() => {
    if (filter === 'all') return pdbs
    return pdbs.filter((p) =>
      filter === 'xray' ? p.isXray : filter === 'cryoem' ? p.isCryoem : p.isNmr
    )
  }, [pdbs, filter])

  return (
    <Card className="gap-3 rounded-xl border-stone-200 bg-white shadow-sm dark:border-stone-800 dark:bg-stone-900">
      <CardContent className="flex flex-col gap-3 px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          {FILTERS.map((f) => {
            const active = filter === f.key
            const count = counts[f.key]
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                disabled={count === 0 && f.key !== 'all'}
                className={cn(
                  'min-h-10 rounded-full border px-3 text-xs font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-emerald-500/40 disabled:cursor-not-allowed disabled:opacity-40',
                  active
                    ? 'border-emerald-600 bg-emerald-600 text-white shadow-sm'
                    : 'border-stone-300 bg-white text-stone-600 hover:border-emerald-400 hover:text-emerald-700 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-400 dark:hover:border-emerald-700'
                )}
              >
                {f.label}
                <span className={cn('ml-1.5 tabular-nums', active ? 'text-emerald-100' : 'text-stone-400')}>
                  {count}
                </span>
              </button>
            )
          })}
          {ligandCount != null && ligandCount > 0 && (
            <Badge variant="secondary" className="ml-auto text-[11px]">
              涉及配体 {ligandCount} 个
            </Badge>
          )}
        </div>

        <div className="eval-scroll max-h-96 overflow-auto rounded-lg border border-stone-200 dark:border-stone-800">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-stone-50 dark:bg-stone-900">
              <TableRow className="hover:bg-transparent dark:hover:bg-transparent">
                <TableHead className="pl-3">PDB ID</TableHead>
                <TableHead>方法</TableHead>
                <TableHead>分辨率</TableHead>
                <TableHead className="min-w-48">标题</TableHead>
                <TableHead>释放日期</TableHead>
                <TableHead>配体</TableHead>
                <TableHead>期刊</TableHead>
                <TableHead className="pr-3">PMID</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="h-28 text-center text-sm text-stone-400">
                    <span className="flex flex-col items-center gap-1.5">
                      <Inbox className="size-5" />
                      当前筛选条件下暂无结构
                    </span>
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((p, i) => {
                  const ligandList = p.ligands ?? []
                  return (
                    <TableRow
                      key={`${p.pdbId}-${i}`}
                      className={cn(i % 2 === 1 && 'bg-stone-50/60 dark:bg-stone-900/40')}
                    >
                      <TableCell className="pl-3">
                        <a
                          href={`https://www.rcsb.org/structure/${p.pdbId}`}
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono text-xs font-semibold text-emerald-700 hover:underline dark:text-emerald-400"
                        >
                          {p.pdbId}
                        </a>
                      </TableCell>
                      <TableCell>
                        <MethodBadge
                          method={p.method}
                          isXray={p.isXray}
                          isCryoem={p.isCryoem}
                          isNmr={p.isNmr}
                        />
                      </TableCell>
                      <TableCell className="text-xs tabular-nums text-stone-600 dark:text-stone-400">
                        {formatResolution(p.resolution)}
                      </TableCell>
                      <TableCell
                        className="max-w-56 truncate text-xs text-stone-600 dark:text-stone-400"
                        title={p.title}
                      >
                        {p.title || '—'}
                      </TableCell>
                      <TableCell className="text-xs tabular-nums text-stone-600 dark:text-stone-400">
                        {formatDate(p.releaseDate)}
                      </TableCell>
                      <TableCell
                        className="max-w-32 truncate text-xs text-stone-600 dark:text-stone-400"
                        title={ligandList.join(', ')}
                      >
                        {ligandList.length > 0
                          ? ligandList.slice(0, 3).join(', ') +
                            (ligandList.length > 3 ? ` +${ligandList.length - 3}` : '')
                          : '—'}
                      </TableCell>
                      <TableCell
                        className="max-w-36 truncate text-xs text-stone-600 dark:text-stone-400"
                        title={p.journal}
                      >
                        {p.journal || '—'}
                      </TableCell>
                      <TableCell className="pr-3">
                        {p.pubmedId ? (
                          <a
                            href={`https://pubmed.ncbi.nlm.nih.gov/${p.pubmedId}/`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-stone-600 hover:text-emerald-700 hover:underline dark:text-stone-400 dark:hover:text-emerald-400"
                          >
                            {p.pubmedId}
                            <ExternalLink className="size-3" />
                          </a>
                        ) : (
                          <span className="text-xs text-stone-400">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  )
}
