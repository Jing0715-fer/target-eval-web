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
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="eval-scroll overflow-auto">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-muted/60">
            <TableRow className="hover:bg-transparent dark:hover:bg-transparent">
              <TableHead className="eval-eyebrow h-9 pl-4 text-muted-foreground">PDB ID</TableHead>
              <TableHead className="eval-eyebrow h-9 min-w-44 text-muted-foreground">描述</TableHead>
              <TableHead className="eval-eyebrow h-9 text-muted-foreground">Identity</TableHead>
              <TableHead className="eval-eyebrow h-9 text-muted-foreground">E-value</TableHead>
              <TableHead className="eval-eyebrow h-9 min-w-28 text-muted-foreground" title="BLAST 命中在查询序列（=输入序列/UniProt 全长）上的起止残基位置（1-based 闭区间）">
                覆盖范围
              </TableHead>
              <TableHead className="eval-eyebrow h-9 text-muted-foreground">方法</TableHead>
              <TableHead className="eval-eyebrow h-9 text-muted-foreground">分辨率</TableHead>
              <TableHead className="eval-eyebrow h-9 pr-4 text-muted-foreground">文献</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((h, i) => (
              <TableRow
                key={`${h.pdbId}-${i}`}
                className="border-border/60 hover:bg-accent/50"
              >
                <TableCell className="pl-4">
                  <a
                    href={`https://www.rcsb.org/structure/${h.pdbId}`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-xs font-semibold text-primary underline-offset-2 hover:underline"
                  >
                    {h.pdbId}
                  </a>
                </TableCell>
                <TableCell
                  className="max-w-64 truncate text-xs text-foreground/80"
                  title={h.description}
                >
                  {h.description || '—'}
                </TableCell>
                <TableCell className="font-mono text-xs tabular-nums text-foreground/90">
                  {h.identity != null ? `${Number(h.identity.toFixed(1))}%` : '—'}
                </TableCell>
                <TableCell className="font-mono text-xs tabular-nums text-foreground/80">
                  {formatEvalue(h.evalue)}
                </TableCell>
                <TableCell className="font-mono text-xs tabular-nums text-foreground/80">
                  {h.queryFrom != null && h.queryTo != null && h.queryFrom > 0 && h.queryTo > 0
                    ? `${h.queryFrom}-${h.queryTo}`
                    : h.queryCoverage != null && h.queryCoverage > 0
                      ? `${h.queryCoverage} aa`
                      : '—'}
                </TableCell>
                <TableCell>
                  <MethodBadge method={h.method} />
                </TableCell>
                <TableCell className="pr-4 font-mono text-xs tabular-nums text-foreground/80">
                  {formatResolution(h.resolution)}
                </TableCell>
                <TableCell className="pr-4">
                  {h.pubmedId ? (
                    <a
                      href={`https://pubmed.ncbi.nlm.nih.gov/${h.pubmedId}/`}
                      target="_blank"
                      rel="noreferrer"
                      title={`跳转 PubMed 文献 ${h.pubmedId}`}
                      className="font-mono text-[11px] font-semibold text-primary underline-offset-2 hover:underline"
                    >
                      PMID {h.pubmedId}
                    </a>
                  ) : (
                    <span className="text-muted-foreground/40">—</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {hits.length > COLLAPSED_COUNT && (
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
