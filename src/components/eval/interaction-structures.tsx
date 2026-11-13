'use client'

import { ExternalLink, Layers3, Network } from 'lucide-react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'
import type { InteractionAnalysis, InteractionComplexInfo } from './types'

/** 化学计量短显示："minValue: 1, maxValue: 2" → "1–2" */
function stochShort(text: string): string {
  return text.replace(/minValue:\s*/g, '').replace(/maxValue:\s*/g, '').replace(/,\s*/g, '–').trim()
}

/** 共有结构单条：PDB ID + 方法徽标 + 分辨率 + 覆盖组分 chips（对齐 HTML 报告 csi-main） */
function SharedPdbItem({
  pdbId,
  method,
  isXray,
  isCryoem,
  isNmr,
  resolution,
  componentNames,
  componentCount,
  title,
}: {
  pdbId: string
  method: string
  isXray: boolean
  isCryoem: boolean
  isNmr: boolean
  resolution: number | null
  componentNames: string[]
  componentCount: number
  title: string
}) {
  return (
    <li className="flex flex-col gap-1 px-3.5 py-2.5">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <a
          href={`https://www.rcsb.org/structure/${pdbId}`}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-[13px] font-bold text-emerald-800 hover:underline dark:text-emerald-400"
        >
          {pdbId}
        </a>
        <span className="inline-flex items-center rounded-sm border border-stone-200 bg-stone-50 px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-stone-600 dark:border-stone-700 dark:bg-stone-800/60 dark:text-stone-300">
          {isXray ? 'X-ray' : isCryoem ? 'Cryo-EM' : isNmr ? 'NMR' : method.slice(0, 10) || '—'}
        </span>
        <span className="font-mono text-[11.5px] tabular-nums text-stone-500 dark:text-stone-400">
          {resolution != null ? `${resolution.toFixed(2)} Å` : '—'}
        </span>
        <span className="inline-flex flex-wrap items-center rounded-sm border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[11px] text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-400">
          {componentNames.join(' + ')}
          <i className="ml-1.5 font-mono text-[10px] not-italic text-emerald-700 dark:text-emerald-500">{componentCount} 组分</i>
        </span>
      </div>
      {title && <p className="text-[11.5px] leading-relaxed text-stone-400 dark:text-stone-500">{title}</p>}
    </li>
  )
}

/** 单个 curated 复合物卡片（对齐 HTML 报告 complexCardHtml）：
 *  头部 chips → 组分表（共有/单独列，靶点行高亮）→ 共有结构绿色面板（突出）→ 单独结构折叠 */
function ComplexCard({ c }: { c: InteractionComplexInfo }) {
  const others = c.components.filter(x => !x.isTarget)
  const shared = c.sharedPdbs ?? []
  const sharedTotal = c.sharedPdbTotal ?? 0
  const soloTotal = c.soloPdbTotal ?? others.reduce((s, x) => s + (x.soloPdbCount ?? 0), 0)
  const sharedShowMore = sharedTotal - shared.length
  const soloItems = others.filter(x => (x.soloPdbCount ?? 0) > 0 || (x.soloRepresentativePdbs ?? []).length > 0)

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-stone-200 bg-white p-4 sm:p-5 dark:border-stone-800 dark:bg-stone-900">
      {/* 头部：badge + CPX 名称 + chips */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center rounded-sm bg-teal-800 px-2.5 py-1 font-mono text-[10.5px] font-bold tracking-wide text-white dark:bg-teal-700">
          Complex Portal
        </span>
        <a
          href={`https://www.ebi.ac.uk/complexportal/complex/${c.complexAc}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-sm font-bold text-stone-900 hover:text-emerald-800 dark:text-stone-50 dark:hover:text-emerald-400"
        >
          {c.complexAc}
          <ExternalLink className="size-3 text-stone-400" />
        </a>
        {c.name && <span className="min-w-0 text-xs leading-relaxed text-stone-500 dark:text-stone-400">{c.name}</span>}
        {c.assembly && (
          <span className="rounded-sm border border-stone-200 bg-stone-50 px-2 py-0.5 font-mono text-[10.5px] text-stone-600 dark:border-stone-700 dark:bg-stone-800/60 dark:text-stone-300">
            {c.assembly}
          </span>
        )}
        {c.assemblyKda != null && (
          <span className="rounded-sm border border-stone-200 bg-stone-50 px-2 py-0.5 font-mono text-[10.5px] text-stone-600 dark:border-stone-700 dark:bg-stone-800/60 dark:text-stone-300">
            装配 ~{c.assemblyKda} kDa
          </span>
        )}
        <span
          className={cn(
            'rounded-sm border px-2 py-0.5 font-mono text-[10.5px]',
            c.componentsWithStructure > 0
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-400'
              : 'border-stone-200 bg-stone-50 text-stone-500 dark:border-stone-700 dark:bg-stone-800/60 dark:text-stone-400',
          )}
        >
          {c.componentsWithStructure}/{others.length} 其他组分有结构
        </span>
        {sharedTotal > 0 && (
          <span className="rounded-sm bg-emerald-900 px-2 py-0.5 font-mono text-[10.5px] font-bold text-white dark:bg-emerald-800">
            共有结构 {sharedTotal}
          </span>
        )}
      </div>

      {/* 组分构成表：共有/单独分列，靶点行高亮 */}
      <div className="eval-scroll overflow-x-auto rounded-md border border-stone-200 dark:border-stone-800">
        <Table className="w-full border-collapse text-xs">
          <TableHeader>
            <TableRow className="bg-stone-50 dark:bg-stone-900/80">
              <TableHead className="eval-eyebrow text-left">组分</TableHead>
              <TableHead className="eval-eyebrow w-24 text-left">UniProt</TableHead>
              <TableHead className="eval-eyebrow w-14 text-left">计量</TableHead>
              <TableHead className="eval-eyebrow w-20 text-right">分子量</TableHead>
              <TableHead className="eval-eyebrow w-14 text-right">共有</TableHead>
              <TableHead className="eval-eyebrow w-14 text-right">单独</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {c.components.map(x => (
              <TableRow
                key={`${c.complexAc}-${x.accession}`}
                className={cn(
                  x.isTarget && 'bg-emerald-50/80 dark:bg-emerald-950/30',
                )}
              >
                <TableCell className="border-b border-stone-100 px-2.5 py-2 align-top leading-relaxed dark:border-stone-800/60">
                  {x.isTarget && <b className="mr-1 text-emerald-800 dark:text-emerald-400">【靶点】</b>}
                  {x.name}
                  {x.description && <span className="ml-1 text-[10.5px] text-stone-400 dark:text-stone-500"> · {x.description.slice(0, 44)}</span>}
                </TableCell>
                <TableCell className="border-b border-stone-100 px-2.5 py-2 align-top font-mono text-[11px] dark:border-stone-800/60">
                  <a
                    href={`https://www.uniprot.org/uniprotkb/${x.accession}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-emerald-800 hover:underline dark:text-emerald-400"
                  >
                    {x.accession}
                  </a>
                </TableCell>
                <TableCell className="border-b border-stone-100 px-2.5 py-2 align-top font-mono text-[11px] tabular-nums dark:border-stone-800/60">
                  {stochShort(x.stoichiometryText) || '—'}
                </TableCell>
                <TableCell className="border-b border-stone-100 px-2.5 py-2 text-right font-mono text-[11px] tabular-nums dark:border-stone-800/60">
                  {x.kda != null ? `~${x.kda}` : '—'}
                </TableCell>
                <TableCell className="border-b border-stone-100 px-2.5 py-2 text-right font-mono text-[11px] tabular-nums dark:border-stone-800/60">
                  {x.isTarget ? '—' : String(x.sharedPdbIds?.length ?? 0)}
                </TableCell>
                <TableCell
                  className="border-b border-stone-100 px-2.5 py-2 text-right font-mono text-[11px] tabular-nums dark:border-stone-800/60"
                  title={x.isTarget ? '评估对象 — 无直接结构（本分析前提）' : undefined}
                >
                  {x.isTarget ? '—' : String(x.soloPdbCount ?? 0)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* 共有结构：绿色面板突出（组装先例） */}
      {shared.length > 0 && (
        <div className="rounded-lg border border-emerald-200 bg-gradient-to-b from-emerald-50/70 to-white p-3.5 dark:border-emerald-900 dark:from-emerald-950/30 dark:to-stone-900">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm font-bold text-emerald-900 dark:text-emerald-300">
            <Layers3 className="size-4 self-center text-emerald-700 dark:text-emerald-500" aria-hidden />
            共有结构 <span className="font-mono text-base text-emerald-800 dark:text-emerald-400">{sharedTotal}</span> 个
            <span className="basis-full text-[11px] font-normal leading-relaxed text-stone-500 dark:text-stone-400">
              同一 PDB 条目含 ≥2 个复合物组分 — 共组装先例，复合物路线最直接的结构证据
            </span>
          </div>
          <ul className="mt-1 divide-y divide-stone-100 dark:divide-stone-800/60">
            {shared.map(s => (
              <SharedPdbItem key={`${c.complexAc}-${s.pdbId}`} {...s} />
            ))}
          </ul>
          {sharedShowMore > 0 && (
            <p className="mt-1.5 text-[11px] text-stone-400 dark:text-stone-500">
              另有 {sharedShowMore} 个共有结构未列出（按覆盖组分数与分辨率取前 {shared.length} 个）。
            </p>
          )}
        </div>
      )}

      {/* 单独结构：默认折叠（次要参考） */}
      {soloItems.length > 0 && (
        <details className="group overflow-hidden rounded-lg border border-stone-200 dark:border-stone-800">
          <summary className="flex cursor-pointer select-none items-center gap-1.5 border-b border-stone-200 bg-stone-50 px-3.5 py-2 text-[11px] font-medium text-emerald-800 list-none transition-colors hover:bg-stone-100 dark:border-stone-800 dark:bg-stone-900/80 dark:text-emerald-500 dark:hover:bg-stone-800/60 [&::-webkit-details-marker]:hidden">
            <Network className="size-3.5 shrink-0" aria-hidden />
            单独结构（各组分独立解析，共 {soloTotal} 个 — 次要参考：边界借鉴/构象对照，默认折叠）
          </summary>
          <div className="flex flex-col gap-2 px-3.5 py-3">
            <ul className="divide-y divide-stone-100 dark:divide-stone-800/60">
              {soloItems.map(x => (
                <li key={`${c.complexAc}-solo-${x.accession}`} className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-baseline sm:gap-3">
                  <span className="w-44 shrink-0 truncate text-xs font-semibold text-stone-800 dark:text-stone-200">
                    {x.name} <span className="ml-1 font-mono text-[10.5px] font-normal text-stone-400">{x.accession}</span>
                  </span>
                  <span className="min-w-0 flex-1 text-xs leading-relaxed text-stone-600 dark:text-stone-300">
                    {x.soloPdbCount ?? 0} 个单独结构
                    {(x.soloRepresentativePdbs ?? []).length > 0 && (
                      <span className="ml-1.5">
                        代表：
                        {(x.soloRepresentativePdbs ?? []).map(p => (
                          <a
                            key={`${x.accession}-solo-${p.pdbId}`}
                            href={`https://www.rcsb.org/structure/${p.pdbId}`}
                            target="_blank"
                            rel="noreferrer"
                            className="mx-0.5 font-mono text-[11px] font-semibold text-emerald-800 hover:underline dark:text-emerald-400"
                          >
                            {p.pdbId}
                            <span className="ml-0.5 font-normal text-stone-400">
                              {p.resolution != null ? p.resolution.toFixed(1) + 'Å' : ''}
                            </span>
                          </a>
                        ))}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-[11px] leading-relaxed text-stone-400 dark:text-stone-500">
              单独结构仅含单一组分（不含复合物其他组分）— 可用于组分域边界设计与构象状态对照，但不能证明复合物组装形式。
            </p>
          </div>
        </details>
      )}
    </div>
  )
}

export interface InteractionStructuresProps {
  itx: InteractionAnalysis
}

/**
 * 互作复合物组分结构清单（网页端 — 与下载 HTML 报告格式一致）：
 * 靶点无直接结构时，列出其复合物其他组分的结构，按「共有 / 单独」分类。
 */
export function InteractionStructures({ itx }: InteractionStructuresProps) {
  if (!itx.applicable || !itx.hasEvidence) return null
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="text-sm font-bold text-stone-900 dark:text-stone-50">互作复合物组分结构</h3>
        <span className="font-mono text-[10.5px] text-stone-400 dark:text-stone-500">
          Complex Portal curated · {itx.complexes.length} 个复合物
        </span>
      </div>
      <p className="text-xs leading-relaxed text-stone-500 dark:text-stone-400">
        靶点无直接结构 — 以下为其所在复合物其他组分的结构清单，按「共有 / 单独」分类：
        <b className="mx-1 text-emerald-800 dark:text-emerald-400">共有结构</b>
        （同一 PDB 含 ≥2 个组分）是复合物共组装的直接先例，重点展示；
        <b className="mx-1 text-stone-700 dark:text-stone-300">单独结构</b>
        （组分独立解析）为次要参考，默认折叠。
      </p>
      {itx.complexes.map(c => (
        <ComplexCard key={c.complexAc} c={c} />
      ))}
      {itx.binaryPartners.length > 0 && (
        <details className="group overflow-hidden rounded-lg border border-stone-200 dark:border-stone-800">
          <summary className="flex cursor-pointer select-none items-center gap-1.5 border-b border-stone-200 bg-stone-50 px-3.5 py-2 text-[11px] font-medium text-emerald-800 list-none transition-colors hover:bg-stone-100 dark:border-stone-800 dark:bg-stone-900/80 dark:text-emerald-500 dark:hover:bg-stone-800/60 [&::-webkit-details-marker]:hidden">
            <Network className="size-3.5 shrink-0" aria-hidden />
            IntAct binary 互作伙伴（复合物之外，{itx.binaryPartners.length} 个有结构 — 互作界面参考，默认折叠）
          </summary>
          <ul className="divide-y divide-stone-100 dark:divide-stone-800/60">
            {itx.binaryPartners.map(b => (
              <li key={`bin-${b.accession}`} className="flex flex-col gap-1 px-3.5 py-2.5 sm:flex-row sm:items-baseline sm:gap-3">
                <span className="w-40 shrink-0 text-xs font-semibold text-stone-800 dark:text-stone-200">
                  {b.geneName ?? b.accession} <span className="ml-1 font-mono text-[10.5px] font-normal text-stone-400">{b.accession}</span>
                </span>
                <span className="min-w-0 flex-1 text-xs leading-relaxed text-stone-600 dark:text-stone-300">
                  {b.pdbCount} 个结构
                  {b.representativePdbs.length > 0 && (
                    <span className="ml-1.5">
                      代表：
                      {b.representativePdbs.map(p => (
                        <a
                          key={`bin-${b.accession}-${p.pdbId}`}
                          href={`https://www.rcsb.org/structure/${p.pdbId}`}
                          target="_blank"
                          rel="noreferrer"
                          className="mx-0.5 font-mono text-[11px] font-semibold text-emerald-800 hover:underline dark:text-emerald-400"
                        >
                          {p.pdbId}
                          <span className="ml-0.5 font-normal text-stone-400">
                            {p.resolution != null ? p.resolution.toFixed(1) + 'Å' : ''}
                          </span>
                        </a>
                      ))}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <p className="border-t border-stone-100 px-3.5 py-2.5 text-[11px] leading-relaxed text-stone-400 dark:border-stone-800/60 dark:text-stone-500">
            binary 互作（IntAct 实验证据）伙伴有结构 — 互作界面建模与 pull-down/SPR 验证设计可参考，非 curated 复合物，化学计量需实验确认。
          </p>
        </details>
      )}
    </div>
  )
}
