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
  /** v2.29：与评估区间无链范围重叠的结构（折叠保留展示 — 灰色行 + 范围外 chip） */
  outsidePdbs?: PdbEntry[]
  /** v2.29：评估区间展示标签（如「712-979 · 结构域匹配」— 范围外折叠区标题用） */
  rangeLabel?: string
}

/** PDB 结构表：方法筛选 + 长列表折叠 + PMID 关联文献提示；v2.29 范围外结构折叠区（灰色行） */
export function PdbTable({ pdbs, ligandCount, literature, outsidePdbs, rangeLabel }: PdbTableProps) {
  const [filter, setFilter] = useState<MethodFilter>('all')
  const [expanded, setExpanded] = useState(false)
  /** v2.29：范围外折叠区展开态 */
  const [outsideExpanded, setOutsideExpanded] = useState(false)

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
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      {/* 工具行：方法筛选 + 配体统计 */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border/70 px-4 py-3">
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
                'min-h-8 rounded-md border px-2.5 font-mono text-[11px] transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-40',
                active
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-card text-muted-foreground hover:border-ring/60 hover:text-primary'
              )}
            >
              {f.label}
              <span className={cn('ml-1.5 tabular-nums', active ? 'text-primary-foreground/70' : 'text-muted-foreground/60')}>
                {count}
              </span>
            </button>
          )
        })}
        {ligandCount != null && ligandCount > 0 && (
          <span className="ml-auto font-mono text-[11px] text-muted-foreground/70">
            涉及配体 {ligandCount} 个
          </span>
        )}
      </div>

      {/* 表格 */}
      <div className="eval-scroll overflow-auto">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-muted/60">
            <TableRow className="hover:bg-transparent dark:hover:bg-transparent">
              <TableHead className="eval-eyebrow h-9 pl-4 text-muted-foreground">PDB ID</TableHead>
              <TableHead className="eval-eyebrow h-9 text-muted-foreground">方法</TableHead>
              <TableHead className="eval-eyebrow h-9 text-muted-foreground">分辨率</TableHead>
              <TableHead className="eval-eyebrow h-9 min-w-28 text-muted-foreground" title="该结构覆盖靶点 UniProt 序列的残基编号范围">范围</TableHead>
              <TableHead className="eval-eyebrow h-9 min-w-44 text-muted-foreground">标题</TableHead>
              <TableHead className="eval-eyebrow h-9 text-muted-foreground">释放日期</TableHead>
              <TableHead className="eval-eyebrow h-9 min-w-28 text-muted-foreground">配体</TableHead>
              <TableHead className="eval-eyebrow h-9 min-w-32 text-muted-foreground">期刊</TableHead>
              <TableHead className="eval-eyebrow h-9 pr-4 text-muted-foreground">文献</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="h-28 text-center text-sm text-muted-foreground">
                  <span className="flex flex-col items-center gap-1.5">
                    <Inbox className="size-5" />
                    {pdbs.length === 0 ? (
                      <>
                        <span>该靶点暂无直接关联的 PDB 结构</span>
                        <span className="text-xs text-muted-foreground/60">
                          同源结构证据见下方「BLAST 同源结构」章节；可行性结论以文献与同源证据为主
                        </span>
                      </>
                    ) : (
                      '当前筛选条件下暂有 0 个结构，试试「全部」筛选'
                    )}
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
                    className="border-border/60 hover:bg-accent/50"
                  >
                    <TableCell className="pl-4">
                      <a
                        href={`https://www.rcsb.org/structure/${p.pdbId}`}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-xs font-semibold text-primary underline-offset-2 hover:underline"
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
                    <TableCell className="font-mono text-xs tabular-nums text-foreground/80">
                      {formatResolution(p.resolution)}
                    </TableCell>
                    <TableCell
                      className="max-w-36 truncate font-mono text-xs tabular-nums text-foreground/80"
                      title={p.chainRanges ? `${p.chainRanges}（UniProt 残基编号范围）` : 'UniProt 交叉引用未提供范围（可能为旧记录或无对应链）'}
                    >
                      {p.chainRanges || '—'}
                    </TableCell>
                    <TableCell
                      className="max-w-56 truncate text-xs text-foreground/80"
                      title={p.title}
                    >
                      {p.title || '—'}
                    </TableCell>
                    <TableCell className="font-mono text-xs tabular-nums text-foreground/80">
                      {formatDate(p.releaseDate)}
                    </TableCell>
                    <TableCell
                      className="max-w-32 truncate text-xs text-foreground/80"
                      title={ligandList.join(', ')}
                    >
                      {ligandList.length > 0
                        ? ligandList.slice(0, 3).join(', ') +
                          (ligandList.length > 3 ? ` +${ligandList.length - 3}` : '')
                        : '—'}
                    </TableCell>
                    <TableCell
                      className="max-w-36 truncate text-xs text-foreground/80"
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
                          className="inline-flex items-center gap-1 font-mono text-xs text-foreground/80 underline-offset-2 hover:text-primary hover:underline"
                        >
                          {p.pubmedId}
                          {lit && <span className="size-1 rounded-full bg-primary" aria-label="已关联文献" />}
                          <ExternalLink className="size-3" />
                        </a>
                      ) : (
                        <span className="text-xs text-muted-foreground/40">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* v2.29 范围外结构折叠区：与评估区间无链范围重叠的结构（灰色行 + chip；不计入评分/覆盖率） */}
      {outsidePdbs && outsidePdbs.length > 0 && (
        <div className="border-t border-border/70 bg-muted/30">
          <Button
            variant="ghost"
            onClick={() => setOutsideExpanded((v) => !v)}
            className="h-10 w-full gap-1.5 rounded-none font-mono text-[11px] text-muted-foreground hover:bg-accent/60"
            aria-expanded={outsideExpanded}
          >
            {outsideExpanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
            {outsideExpanded
              ? `收起范围外结构`
              : `展开范围外结构 ${outsidePdbs.length} 条（与评估区间${rangeLabel ? ` ${rangeLabel}` : ''}无链范围重叠 — 灰色行）`}
          </Button>
          {outsideExpanded && (
            <div className="eval-scroll overflow-auto">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-muted/70">
                  <TableRow className="hover:bg-transparent dark:hover:bg-transparent">
                    <TableHead className="eval-eyebrow h-9 pl-4 text-muted-foreground">PDB ID</TableHead>
                    <TableHead className="eval-eyebrow h-9 text-muted-foreground">方法</TableHead>
                    <TableHead className="eval-eyebrow h-9 text-muted-foreground">分辨率</TableHead>
                    <TableHead className="eval-eyebrow h-9 min-w-28 text-muted-foreground" title="该结构覆盖靶点 UniProt 序列的残基编号范围">范围</TableHead>
                    <TableHead className="eval-eyebrow h-9 min-w-44 text-muted-foreground">标题</TableHead>
                    <TableHead className="eval-eyebrow h-9 text-muted-foreground">释放日期</TableHead>
                    <TableHead className="eval-eyebrow h-9 min-w-28 text-muted-foreground">配体</TableHead>
                    <TableHead className="eval-eyebrow h-9 min-w-32 text-muted-foreground">期刊</TableHead>
                    <TableHead className="eval-eyebrow h-9 pr-4 text-muted-foreground">文献</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {outsidePdbs.slice(0, 200).map((p, i) => {
                    const ligandList = p.ligands ?? []
                    const lit = p.pubmedId ? litByPmid.get(String(p.pubmedId)) : undefined
                    return (
                      <TableRow key={`outside-${p.pdbId}-${i}`} className="border-border/60 bg-muted/25 hover:bg-muted/40">
                        <TableCell className="pl-4">
                          <a
                            href={`https://www.rcsb.org/structure/${p.pdbId}`}
                            target="_blank"
                            rel="noreferrer"
                            className="font-mono text-xs font-semibold text-muted-foreground underline-offset-2 hover:underline"
                          >
                            {p.pdbId}
                          </a>
                        </TableCell>
                        <TableCell>
                          <MethodBadge method={p.method} isXray={p.isXray} isCryoem={p.isCryoem} isNmr={p.isNmr} />
                        </TableCell>
                        <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                          {formatResolution(p.resolution)}
                        </TableCell>
                        <TableCell className="max-w-36 truncate font-mono text-xs tabular-nums text-muted-foreground">
                          <span title={p.chainRanges ? `${p.chainRanges}（UniProt 残基编号范围）` : undefined}>
                            {p.chainRanges || '—'}
                          </span>
                          <span className="ml-1.5 inline-block rounded-full border border-border bg-muted px-1.5 py-px font-mono text-[9px] text-muted-foreground">范围外</span>
                        </TableCell>
                        <TableCell className="max-w-56 truncate text-xs text-muted-foreground" title={p.title}>
                          {p.title || '—'}
                        </TableCell>
                        <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                          {formatDate(p.releaseDate)}
                        </TableCell>
                        <TableCell className="max-w-32 truncate text-xs text-muted-foreground" title={ligandList.join(', ')}>
                          {ligandList.length > 0
                            ? ligandList.slice(0, 3).join(', ') + (ligandList.length > 3 ? ` +${ligandList.length - 3}` : '')
                            : '—'}
                        </TableCell>
                        <TableCell className="max-w-36 truncate text-xs text-muted-foreground" title={p.journal}>
                          {p.journal || '—'}
                        </TableCell>
                        <TableCell className="pr-4">
                          {p.pubmedId ? (
                            <a
                              href={`https://pubmed.ncbi.nlm.nih.gov/${p.pubmedId}/`}
                              target="_blank"
                              rel="noreferrer"
                              title={lit ? `PMID ${p.pubmedId} — ${lit.title}` : `PubMed ${p.pubmedId}`}
                              className="font-mono text-xs text-muted-foreground underline-offset-2 hover:underline"
                            >
                              {p.pubmedId}
                            </a>
                          ) : (
                            <span className="text-xs text-muted-foreground/40">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
              <p className="border-t border-border/60 px-4 py-2 text-[11px] leading-relaxed text-muted-foreground/80">
                以上结构链覆盖区间与评估区间无重叠（多为该 UniProt 名下其他片段/其他结构域的结构）；折叠保留可查，行颜色区别于上表，不计入评分、覆盖率与「已有结构先例」统计。
              </p>
            </div>
          )}
        </div>
      )}

      {/* 折叠/展开控制 */}
      {filtered.length > COLLAPSED_COUNT && (
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
