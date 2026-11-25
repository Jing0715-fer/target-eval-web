'use client'

import { useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { MethodBadge } from './badges'
import { formatEvalue, formatResolution } from './format'
import type { BlastHit, BlastNrHit } from './types'

/** 折叠阈值：超过该数量时默认只显示前 N 条 */
const COLLAPSED_COUNT = 15

/** BLAST 同源结构表（长列表可折叠）；v2.29 范围外命中折叠区（灰色行） */
export function BlastTable({ hits, outsideHits, rangeLabel }: { hits: BlastHit[]; outsideHits?: BlastHit[]; rangeLabel?: string }) {
  const [expanded, setExpanded] = useState(false)
  /** v2.29：范围外折叠区展开态 */
  const [outsideExpanded, setOutsideExpanded] = useState(false)
  const collapsed = !expanded && hits.length > COLLAPSED_COUNT
  const visible = collapsed ? hits.slice(0, COLLAPSED_COUNT) : hits

  return (
    <div className="studio-card overflow-hidden rounded-xl border border-border bg-card">
      <div className="eval-scroll overflow-auto">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-muted/70">
            <TableRow className="border-input hover:bg-transparent dark:hover:bg-transparent">
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
                className="border-border/60 hover:bg-muted/50"
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

      {/* v2.29 范围外命中折叠区：查询覆盖区间与评估区间无重叠（灰色行 + chip；不计入评分） */}
      {outsideHits && outsideHits.length > 0 && (
        <div className="border-t border-border/70 bg-muted/30">
          <Button
            variant="ghost"
            onClick={() => setOutsideExpanded((v) => !v)}
            className="h-10 w-full gap-1.5 rounded-none font-mono text-[11px] text-muted-foreground hover:bg-accent/60"
            aria-expanded={outsideExpanded}
          >
            {outsideExpanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
            {outsideExpanded
              ? '收起范围外同源结构'
              : `展开范围外同源结构 ${outsideHits.length} 条（与评估区间${rangeLabel ? ` ${rangeLabel}` : ''}无重叠 — 灰色行）`}
          </Button>
          {outsideExpanded && (
            <div className="eval-scroll overflow-auto">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-muted/70">
                  <TableRow className="border-input hover:bg-transparent dark:hover:bg-transparent">
                    <TableHead className="eval-eyebrow h-9 pl-4 text-muted-foreground">PDB ID</TableHead>
                    <TableHead className="eval-eyebrow h-9 min-w-44 text-muted-foreground">描述</TableHead>
                    <TableHead className="eval-eyebrow h-9 text-muted-foreground">Identity</TableHead>
                    <TableHead className="eval-eyebrow h-9 text-muted-foreground">E-value</TableHead>
                    <TableHead className="eval-eyebrow h-9 min-w-28 text-muted-foreground" title="BLAST 命中在查询序列（=输入序列/UniProt 全长）上的起止残基位置（1-based 闭区间）">覆盖范围</TableHead>
                    <TableHead className="eval-eyebrow h-9 text-muted-foreground">方法</TableHead>
                    <TableHead className="eval-eyebrow h-9 text-muted-foreground">分辨率</TableHead>
                    <TableHead className="eval-eyebrow h-9 pr-4 text-muted-foreground">文献</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {outsideHits.slice(0, 100).map((h, i) => (
                    <TableRow key={`outside-${h.pdbId}-${i}`} className="border-border/60 bg-muted/25 hover:bg-muted/40">
                      <TableCell className="pl-4">
                        <a
                          href={`https://www.rcsb.org/structure/${h.pdbId}`}
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono text-xs font-semibold text-muted-foreground underline-offset-2 hover:underline"
                        >
                          {h.pdbId}
                        </a>
                      </TableCell>
                      <TableCell className="max-w-64 truncate text-xs text-muted-foreground" title={h.description}>
                        {h.description || '—'}
                      </TableCell>
                      <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                        {h.identity != null ? `${Number(h.identity.toFixed(1))}%` : '—'}
                      </TableCell>
                      <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                        {formatEvalue(h.evalue)}
                      </TableCell>
                      <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                        <span>
                          {h.queryFrom != null && h.queryTo != null && h.queryFrom > 0 && h.queryTo > 0
                            ? `${h.queryFrom}-${h.queryTo}`
                            : h.queryCoverage != null && h.queryCoverage > 0
                              ? `${h.queryCoverage} aa`
                              : '—'}
                        </span>
                        <span className="ml-1.5 inline-block rounded-full border border-border bg-muted px-1.5 py-px font-mono text-[9px] text-muted-foreground">范围外</span>
                      </TableCell>
                      <TableCell>
                        <MethodBadge method={h.method} />
                      </TableCell>
                      <TableCell className="pr-4 font-mono text-xs tabular-nums text-muted-foreground">
                        {formatResolution(h.resolution)}
                      </TableCell>
                      <TableCell className="pr-4">
                        {h.pubmedId ? (
                          <a
                            href={`https://pubmed.ncbi.nlm.nih.gov/${h.pubmedId}/`}
                            target="_blank"
                            rel="noreferrer"
                            title={`跳转 PubMed 文献 ${h.pubmedId}`}
                            className="font-mono text-[11px] font-semibold text-muted-foreground underline-offset-2 hover:underline"
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
              <p className="border-t border-border/60 px-4 py-2 text-[11px] leading-relaxed text-muted-foreground/80">
                以上同源命中的查询覆盖区间与评估区间无重叠（对应其他片段/其他结构域的同源参考）；折叠保留可查，行颜色区别于上表，不计入评分与「已有同源先例」统计。
              </p>
            </div>
          )}
        </div>
      )}

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

/** v2.59→v2.67：BLAST nr 全库检索命中表（靶点身份识别证据 — PDB 库同源不足以
 *  归属 UniProt 时提交序列改查 NCBI nr 全库）。v2.67：与 HTML 报告同口径 — 全量
 *  直出（此前「前 5 条直出 + 其余折叠」），容器内滚动查看。
 *  v2.82：variant="uniprot" — EBI UniProt 库（Swiss-Prot）序列匹配命中（同款
 *  表格，标题/说明区分 — 身份级联 v2.44 通道的检索证据）。 */
export function BlastNrTable({ hits, variant = 'nr' }: { hits: BlastNrHit[]; variant?: 'nr' | 'uniprot' }) {
  const isUni = variant === 'uniprot'
  const rows = (list: BlastNrHit[]) => list.map((h, i) => {
    const isUniprot = h.db !== 'other' && /^[A-Z0-9]{6,10}$/.test(h.accession)
    return (
      <TableRow key={`${h.accession}-${i}`} className="border-border/60 hover:bg-muted/50">
        <TableCell className="pl-4 align-top">
          {isUniprot ? (
            <a
              href={`https://www.uniprot.org/uniprotkb/${h.accession}`}
              target="_blank"
              rel="noreferrer"
              title={`跳转 UniProt ${h.accession}`}
              className="font-mono text-xs font-semibold text-primary underline-offset-2 hover:underline"
            >
              {h.accession}
            </a>
          ) : (
            <span className="break-all font-mono text-xs text-foreground/80">{h.accession || '—'}</span>
          )}
          {h.entryName && (
            <div className="mt-0.5 max-w-44 truncate text-[10.5px] text-muted-foreground/80" title={h.entryName}>
              {h.entryName}
            </div>
          )}
        </TableCell>
        <TableCell
          className="max-w-64 truncate text-xs text-foreground/80"
          title={[h.description, h.organism, h.geneName].filter(Boolean).join(' · ')}
        >
          {h.description || '—'}
        </TableCell>
        <TableCell className="font-mono text-xs tabular-nums text-foreground/90">
          {h.identity != null ? `${Number(h.identity.toFixed(1))}%` : '—'}
        </TableCell>
        <TableCell className="font-mono text-xs tabular-nums text-foreground/80">
          {formatEvalue(h.evalue)}
        </TableCell>
        <TableCell
          className="font-mono text-xs tabular-nums text-foreground/80"
          title="首个 HSP 在提交序列上的残基区间（1-based 闭区间）"
        >
          {h.queryFrom != null && h.queryTo != null && h.queryFrom > 0 && h.queryTo > 0
            ? `${h.queryFrom}-${h.queryTo}`
            : h.queryCoverage > 0
              ? `${h.queryCoverage} aa`
              : '—'}
        </TableCell>
        <TableCell className="pr-4">
          <span
            className={cn(
              'inline-flex items-center rounded-full border px-2 py-px font-mono text-[10px] font-semibold whitespace-nowrap',
              h.db === 'sp'
                ? 'border-emerald-600/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                : h.db === 'tr'
                  ? 'border-amber-600/30 bg-amber-500/10 text-amber-700 dark:text-amber-400'
                  : 'border-border bg-muted text-muted-foreground',
            )}
            title={h.db === 'sp' ? 'Swiss-Prot 人工审校条目 — UniProt 归属可信度高' : h.db === 'tr' ? 'UniProt TrEMBL 自动注释条目' : 'nr 库其他来源条目（gb/ref 等，非 UniProt 形态）'}
          >
            {h.db === 'sp' ? 'Swiss-Prot' : h.db === 'tr' ? 'TrEMBL' : 'nr 其他'}
          </span>
        </TableCell>
      </TableRow>
    )
  })

  return (
    <div className="studio-card overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-border/70 bg-muted/40 px-4 py-2.5">
        <p className="text-xs font-semibold text-foreground">{isUni ? 'UniProt 库序列匹配' : 'BLAST nr 全库检索'}</p>
        <p className="font-mono text-[10px] tracking-wide text-muted-foreground/85">{isUni ? `EBI BLAST · Swiss-Prot · ${hits.length} hits · 靶点身份识别` : `NCBI nr · ${hits.length} hits · 靶点身份识别`}</p>
      </div>
      <div className="eval-scroll overflow-auto">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-muted/70">
            <TableRow className="border-input hover:bg-transparent dark:hover:bg-transparent">
              <TableHead className="eval-eyebrow h-9 pl-4 text-muted-foreground">UniProt / 编号</TableHead>
              <TableHead className="eval-eyebrow h-9 min-w-44 text-muted-foreground">描述</TableHead>
              <TableHead className="eval-eyebrow h-9 text-muted-foreground">Identity</TableHead>
              <TableHead className="eval-eyebrow h-9 text-muted-foreground">E-value</TableHead>
              <TableHead className="eval-eyebrow h-9 min-w-24 text-muted-foreground" title="首个 HSP 在提交序列上的残基区间（1-based 闭区间）">覆盖范围</TableHead>
              <TableHead className="eval-eyebrow h-9 pr-4 text-muted-foreground">库</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>{rows(hits)}</TableBody>
        </Table>
      </div>
      <p className="border-t border-border/60 px-4 py-2.5 text-[11px] leading-relaxed text-muted-foreground/85">
        {isUni
          ? 'PDB 库同源与 NCBI nr 全库均未能确定靶点身份（或检索失败）时，提交序列自动改查 EBI BLAST（UniProtKB Swiss-Prot 人工审校库）定位真实蛋白身份 — 最佳命中达「一致性 ≥85% 且覆盖 ≥40%」即回填 UniProt 元数据。Swiss-Prot = 人工审校条目；TrEMBL = 自动注释条目。'
          : 'PDB 库同源不足以归属 UniProt（一致性 <85% 或覆盖 <40%，或检索失败）时，提交序列自动改查 NCBI nr 全库定位真实蛋白身份 — 最佳命中达「一致性 ≥85% 且覆盖 ≥40%」即回填 UniProt 元数据。Swiss-Prot = 人工审校条目；TrEMBL = 自动注释条目。'}
      </p>
    </div>
  )
}
