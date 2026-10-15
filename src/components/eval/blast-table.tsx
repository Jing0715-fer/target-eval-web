'use client'

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
import { formatEvalue, formatPercent, formatResolution } from './format'
import type { BlastHit } from './types'

/** BLAST 同源结构表 */
export function BlastTable({ hits }: { hits: BlastHit[] }) {
  return (
    <Card className="gap-3 rounded-xl border-stone-200 bg-white shadow-sm dark:border-stone-800 dark:bg-stone-900">
      <CardContent className="px-5 py-4">
        <div className="eval-scroll max-h-96 overflow-auto rounded-lg border border-stone-200 dark:border-stone-800">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-stone-50 dark:bg-stone-900">
              <TableRow className="hover:bg-transparent dark:hover:bg-transparent">
                <TableHead className="pl-3">PDB ID</TableHead>
                <TableHead className="min-w-48">描述</TableHead>
                <TableHead>Identity</TableHead>
                <TableHead>E-value</TableHead>
                <TableHead>覆盖率</TableHead>
                <TableHead>方法</TableHead>
                <TableHead className="pr-3">分辨率</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {hits.map((h, i) => (
                <TableRow
                  key={`${h.pdbId}-${i}`}
                  className={cn(i % 2 === 1 && 'bg-stone-50/60 dark:bg-stone-900/40')}
                >
                  <TableCell className="pl-3">
                    <a
                      href={`https://www.rcsb.org/structure/${h.pdbId}`}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-xs font-semibold text-emerald-700 hover:underline dark:text-emerald-400"
                    >
                      {h.pdbId}
                    </a>
                  </TableCell>
                  <TableCell
                    className="max-w-64 truncate text-xs text-stone-600 dark:text-stone-400"
                    title={h.description}
                  >
                    {h.description || '—'}
                  </TableCell>
                  <TableCell className="text-xs tabular-nums text-stone-700 dark:text-stone-300">
                    {h.identity != null ? `${Number(h.identity.toFixed(1))}%` : '—'}
                  </TableCell>
                  <TableCell className="font-mono text-xs tabular-nums text-stone-600 dark:text-stone-400">
                    {formatEvalue(h.evalue)}
                  </TableCell>
                  <TableCell className="text-xs tabular-nums text-stone-600 dark:text-stone-400">
                    {formatPercent(h.queryCoverage)}
                  </TableCell>
                  <TableCell>
                    <MethodBadge method={h.method} />
                  </TableCell>
                  <TableCell className="pr-3 text-xs tabular-nums text-stone-600 dark:text-stone-400">
                    {formatResolution(h.resolution)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  )
}
