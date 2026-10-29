'use client'

import { useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { MethodBadge } from './badges'
import { formatEvalue, formatResolution } from './format'
import type { BlastHit } from './types'

/** 折叠阈值：超过该数量时默认只显示前 N 条 */
const COLLAPSED_COUNT = 15

/** BLAST 同源结构表（长列表可折叠） */
export function BlastTable({ hits }: { hits: BlastHit[] }) {
  const [expanded, setExpanded] = useState(false)
  const collapsed = !expanded && hits.length > COLLAPSED_COUNT
  const visible = collapsed ? hits.slice(0, COLLAPSED_COUNT) : hits

  return (
    <div className="overflow-hidden rounded-lg border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900">
      <div className="eval-scroll overflow-auto">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-stone-50 dark:bg-stone-900">
            <TableRow className="hover:bg-transparent dark:hover:bg-transparent">
              <TableHead className="eval-eyebrow h-9 pl-4 text-stone-500 dark:text-stone-400">PDB ID</TableHead>
              <TableHead className="eval-eyebrow h-9 min-w-44 text-stone-500 dark:text-stone-400">描述</TableHead>
              <TableHead className="eval-eyebrow h-9 text-stone-500 dark:text-stone-400">Identity</TableHead>
              <TableHead className="eval-eyebrow h-9 text-stone-500 dark:text-stone-400">E-value</TableHead>
              <TableHead className="eval-eyebrow h-9 min-w-28 text-stone-500 dark:text-stone-400" title="BLAST 命中在查询序列（=输入序列/UniProt 全长）上的起止残基位置（1-based 闭区间）">
                覆盖范围
              </TableHead>
              <TableHead className="eval-eyebrow h-9 text-stone-500 dark:text-stone-400">方法</TableHead>
              <TableHead className="eval-eyebrow h-9 pr-4 text-stone-500 dark:text-stone-400">分辨率</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((h, i) => (
              <TableRow
                key={`${h.pdbId}-${i}`}
                className="border-stone-100 dark:border-stone-800/60 hover:bg-stone-50/70 dark:hover:bg-stone-800/40"
              >
                <TableCell className="pl-4">
                  <a
                    href={`https://www.rcsb.org/structure/${h.pdbId}`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-xs font-semibold text-emerald-800 underline-offset-2 hover:underline dark:text-emerald-400"
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
                <TableCell className="font-mono text-xs tabular-nums text-stone-700 dark:text-stone-300">
                  {h.identity != null ? `${Number(h.identity.toFixed(1))}%` : '—'}
                </TableCell>
                <TableCell className="font-mono text-xs tabular-nums text-stone-600 dark:text-stone-400">
                  {formatEvalue(h.evalue)}
                </TableCell>
                <TableCell className="font-mono text-xs tabular-nums text-stone-600 dark:text-stone-400">
                  {h.queryFrom != null && h.queryTo != null && h.queryFrom > 0 && h.queryTo > 0
                    ? `${h.queryFrom}-${h.queryTo}`
                    : h.queryCoverage != null && h.queryCoverage > 0
                      ? `${h.queryCoverage} aa`
                      : '—'}
                </TableCell>
                <TableCell>
                  <MethodBadge method={h.method} />
                </TableCell>
                <TableCell className="pr-4 font-mono text-xs tabular-nums text-stone-600 dark:text-stone-400">
                  {formatResolution(h.resolution)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {hits.length > COLLAPSED_COUNT && (
        <div className="border-t border-stone-100 dark:border-stone-800">
          <Button
            variant="ghost"
            onClick={() => setExpanded((v) => !v)}
            className="h-10 w-full gap-1.5 rounded-none font-mono text-[11px] text-stone-500 hover:bg-stone-50 hover:text-emerald-800 dark:text-stone-400 dark:hover:bg-stone-900/60 dark:hover:text-emerald-400"
            aria-expanded={expanded}
          >
            {expanded ? (
              <>
                <ChevronUp className="size-3.5" />
                收起 · 仍可滚动查看全部 {hits.length} 条
              </>
            ) : (
              <>
                <ChevronDown className="size-3.5" />
                展开全部 {hits.length} 条（当前显示前 {COLLAPSED_COUNT} 条）
              </>
            )}
          </Button>
        </div>
      )}
    </div>
  )
}
