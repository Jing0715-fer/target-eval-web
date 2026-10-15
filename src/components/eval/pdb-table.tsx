'use client'

import { useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, ExternalLink, Inbox } from 'lucide-react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { MethodBadge } from './badges'
import { formatDate, formatResolution } from './format'
import type { LiteratureItem, PdbEntry } from './types'

type MethodFilter = 'all' | 'xray' | 'cryoem' | 'nmr'

/** 折叠阈值：超过该数量时默认只显示前 N 条 */
const COLLAPSED_COUNT = 15

const FILTERS: { key: MethodFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'xray', label: 'X-ray' },
  { key: 'cryoem', label: 'Cryo-EM' },
  { key: 'nmr', label: 'NMR' },
]

export interface PdbTableProps {
  pdbs: PdbEntry[]
  ligandCount?: number | null
  /** 文献列表（用于 PMID ↔ 文献标题关联提示） */
  literature?: LiteratureItem[] | null
}

/** PDB 结构表：方法筛选 + 长列表折叠 + PMID 关联文献提示 */
export function PdbTable({ pdbs, ligandCount, literature }: PdbTableProps) {
  const [filter, setFilter] = useState<MethodFilter>('all')
  const [expanded, setExpanded] = useState(false)

  // PMID → 文献标题（悬停 PMID 时提示对应文献）
  const litByPmid = useMemo(() => {
    const m = new Map<string, LiteratureItem>()
    for (const l of literature ?? []) {
      if (l.pmid) m.set(String(l.pmid), l)
    }
    return m
  }, [literature])

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

  // 切换筛选时在事件处理中回到折叠态，避免超长列表直接展开
  const applyFilter = (key: MethodFilter) => {
    setFilter(key)
    setExpanded(false)
  }

  const collapsed = !expanded && filtered.length > COLLAPSED_COUNT
  const visible = collapsed ? filtered.slice(0, COLLAPSED_COUNT) : filtered

  return (
    <div className="overflow-hidden rounded-lg border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900">
      {/* 工具行：方法筛选 + 配体统计 */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-stone-100 px-4 py-3 dark:border-stone-800">
        {FILTERS.map((f) => {
          const active = filter === f.key
          const count = counts[f.key]
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => applyFilter(f.key)}
              disabled={count === 0 && f.key !== 'all'}
              className={cn(
                'min-h-8 rounded-md border px-2.5 font-mono text-[11px] transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-emerald-500/40 disabled:cursor-not-allowed disabled:opacity-40',
                active
                  ? 'border-emerald-700 bg-emerald-800 text-white'
                  : 'border-stone-200 bg-white text-stone-500 hover:border-emerald-400 hover:text-emerald-800 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-400 dark:hover:border-emerald-600 dark:hover:text-emerald-400'
              )}
            >
              {f.label}
              <span className={cn('ml-1.5 tabular-nums', active ? 'text-emerald-200' : 'text-stone-400')}>
                {count}
              </span>
            </button>
          )
        })}
        {ligandCount != null && ligandCount > 0 && (
          <span className="ml-auto font-mono text-[11px] text-stone-400 dark:text-stone-500">
            涉及配体 {ligandCount} 个
          </span>
        )}
      </div>

      {/* 表格 */}
      <div className="eval-scroll overflow-auto">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-stone-50 dark:bg-stone-900">
            <TableRow className="hover:bg-transparent dark:hover:bg-transparent">
              <TableHead className="eval-eyebrow h-9 pl-4 text-stone-500 dark:text-stone-400">PDB ID</TableHead>
              <TableHead className="eval-eyebrow h-9 text-stone-500 dark:text-stone-400">方法</TableHead>
              <TableHead className="eval-eyebrow h-9 text-stone-500 dark:text-stone-400">分辨率</TableHead>
              <TableHead className="eval-eyebrow h-9 min-w-44 text-stone-500 dark:text-stone-400">标题</TableHead>
              <TableHead className="eval-eyebrow h-9 text-stone-500 dark:text-stone-400">释放日期</TableHead>
              <TableHead className="eval-eyebrow h-9 min-w-28 text-stone-500 dark:text-stone-400">配体</TableHead>
              <TableHead className="eval-eyebrow h-9 min-w-32 text-stone-500 dark:text-stone-400">期刊</TableHead>
              <TableHead className="eval-eyebrow h-9 pr-4 text-stone-500 dark:text-stone-400">文献</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="h-28 text-center text-sm text-stone-400">
                  <span className="flex flex-col items-center gap-1.5">
                    <Inbox className="size-5" />
                    当前筛选条件下暂无结构
                  </span>
                </TableCell>
              </TableRow>
            ) : (
              visible.map((p, i) => {
                const ligandList = p.ligands ?? []
                const lit = p.pubmedId ? litByPmid.get(String(p.pubmedId)) : undefined
                return (
                  <TableRow
                    key={`${p.pdbId}-${i}`}
                    className="border-stone-100 dark:border-stone-800/60 hover:bg-stone-50/70 dark:hover:bg-stone-800/40"
                  >
                    <TableCell className="pl-4">
                      <a
                        href={`https://www.rcsb.org/structure/${p.pdbId}`}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-xs font-semibold text-emerald-800 underline-offset-2 hover:underline dark:text-emerald-400"
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
                    <TableCell className="font-mono text-xs tabular-nums text-stone-600 dark:text-stone-400">
                      {formatResolution(p.resolution)}
                    </TableCell>
                    <TableCell
                      className="max-w-56 truncate text-xs text-stone-600 dark:text-stone-400"
                      title={p.title}
                    >
                      {p.title || '—'}
                    </TableCell>
                    <TableCell className="font-mono text-xs tabular-nums text-stone-600 dark:text-stone-400">
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
                    <TableCell className="pr-4">
                      {p.pubmedId ? (
                        <a
                          href={`https://pubmed.ncbi.nlm.nih.gov/${p.pubmedId}/`}
                          target="_blank"
                          rel="noreferrer"
                          title={lit ? `PMID ${p.pubmedId} — ${lit.title}` : `PubMed ${p.pubmedId}`}
                          className="inline-flex items-center gap-1 font-mono text-xs text-stone-600 underline-offset-2 hover:text-emerald-800 hover:underline dark:text-stone-400 dark:hover:text-emerald-400"
                        >
                          {p.pubmedId}
                          {lit && <span className="size-1 rounded-full bg-emerald-600" aria-label="已关联文献" />}
                          <ExternalLink className="size-3" />
                        </a>
                      ) : (
                        <span className="text-xs text-stone-300 dark:text-stone-600">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* 折叠/展开控制 */}
      {filtered.length > COLLAPSED_COUNT && (
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
                收起 · 仍可滚动查看全部 {filtered.length} 条
              </>
            ) : (
              <>
                <ChevronDown className="size-3.5" />
                展开全部 {filtered.length} 条（当前显示前 {COLLAPSED_COUNT} 条）
              </>
            )}
          </Button>
        </div>
      )}
    </div>
  )
}
