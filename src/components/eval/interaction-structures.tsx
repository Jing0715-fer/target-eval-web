'use client'

import { ChevronDown, ExternalLink, Layers3, Network } from 'lucide-react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'
import type { InteractionAnalysis, InteractionComplexInfo, InteractionSharedPdb, PdbEntry } from './types'

/** 化学计量短显示："minValue: 1, maxValue: 2" → "1–2" */
function stochShort(text: string): string {
  return text.replace(/minValue:\s*/g, '').replace(/maxValue:\s*/g, '').replace(/,\s*/g, '–').trim()
}

/** 方法徽标（X-ray/Cryo-EM/NMR） */
function MethodBadgeSm({ isXray, isCryoem, isNmr, method }: { isXray: boolean; isCryoem: boolean; isNmr: boolean; method: string }) {
  const label = isXray ? 'X-ray' : isCryoem ? 'Cryo-EM' : isNmr ? 'NMR' : method.slice(0, 10) || '—'
  return (
    <span className="inline-flex items-center rounded-sm border border-stone-200 bg-stone-50 px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-stone-600 dark:border-stone-700 dark:bg-stone-800/60 dark:text-stone-300">
      {label}
    </span>
  )
}

/** PubMed 文献列（与下载 HTML 报告一致 — 直跳 PubMed） */
function PmidCell({ pubmedId }: { pubmedId?: string }) {
  if (!pubmedId) return <span className="text-stone-300 dark:text-stone-600">—</span>
  return (
    <a
      href={`https://pubmed.ncbi.nlm.nih.gov/${pubmedId}/`}
      target="_blank"
      rel="noreferrer"
      title={`跳转 PubMed 文献 ${pubmedId}`}
      className="font-mono text-[11px] font-semibold whitespace-nowrap text-emerald-800 underline-offset-2 hover:underline dark:text-emerald-400"
    >
      PMID {pubmedId}
    </a>
  )
}

const cxTh = 'eval-eyebrow h-9 text-left text-stone-500 dark:text-stone-400'

/** 共有结构表（v1.31 全量列表 — 覆盖组分绿 chip + 其他组分琥珀 chip（如 FBXO22）+ 文献直跳） */
function SharedTable({ list }: { list: InteractionSharedPdb[] }) {
  return (
    <div className="eval-scroll overflow-x-auto rounded-md border border-emerald-200/70 dark:border-emerald-900/60">
      <Table className="w-full border-collapse text-xs">
        <TableHeader className="bg-emerald-50/60 dark:bg-stone-900/80">
          <TableRow className="hover:bg-transparent dark:hover:bg-transparent">
            <TableHead className={cxTh}>PDB ID</TableHead>
            <TableHead className={cxTh}>方法</TableHead>
            <TableHead className={cxTh}>分辨率</TableHead>
            <TableHead className={cxTh}>覆盖组分</TableHead>
            <TableHead className={cxTh}>其他组分</TableHead>
            <TableHead className={cxTh}>标题</TableHead>
            <TableHead className={cxTh}>释放日期</TableHead>
            <TableHead className={cxTh}>期刊</TableHead>
            <TableHead className={cxTh}>文献</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {list.map(s => (
            <TableRow key={s.pdbId} className="border-stone-100 dark:border-stone-800/60 hover:bg-stone-50/70 dark:hover:bg-stone-800/40">
              <TableCell className="px-2.5 py-2 font-mono text-[11px]">
                <a
                  href={`https://www.rcsb.org/structure/${s.pdbId}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-semibold text-emerald-800 underline-offset-2 hover:underline dark:text-emerald-400"
                >
                  {s.pdbId}
                </a>
              </TableCell>
              <TableCell className="px-2.5 py-2"><MethodBadgeSm {...s} /></TableCell>
              <TableCell className="px-2.5 py-2 font-mono text-[11px] tabular-nums text-stone-600 dark:text-stone-400">
                {s.resolution != null ? `${s.resolution.toFixed(2)} Å` : '—'}
              </TableCell>
              <TableCell className="px-2.5 py-2">
                <span className="inline-flex flex-wrap items-center rounded-sm border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[11px] text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-400">
                  {s.componentNames.join(' + ')}
                  <i className="ml-1.5 font-mono text-[10px] not-italic text-emerald-700 dark:text-emerald-500">{s.componentCount} 组分</i>
                </span>
              </TableCell>
              <TableCell className="px-2.5 py-2">
                {(s.extraComponents ?? []).length > 0 ? (
                  <span className="flex flex-wrap gap-1">
                    {(s.extraComponents ?? []).slice(0, 3).map((n, i) => (
                      <span
                        key={`${s.pdbId}-x-${i}`}
                        title={s.extraAccessions?.[i] ?? ''}
                        className="inline-flex items-center rounded-sm border border-dashed border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-400"
                      >
                        + {n}
                      </span>
                    ))}
                    {(s.extraComponents ?? []).length > 3 && (
                      <span className="font-mono text-[10px] text-amber-700 dark:text-amber-500">
                        等{(s.extraComponents ?? []).length}
                      </span>
                    )}
                  </span>
                ) : (
                  <span className="text-stone-300 dark:text-stone-600">—</span>
                )}
              </TableCell>
              <TableCell className="max-w-56 px-2.5 py-2 text-[11px] leading-relaxed text-stone-600 dark:text-stone-400">
                <span className="line-clamp-2" title={s.title}>{s.title || '—'}</span>
              </TableCell>
              <TableCell className="px-2.5 py-2 font-mono text-[11px] whitespace-nowrap text-stone-500 dark:text-stone-400">
                {s.releaseDate || '—'}
              </TableCell>
              <TableCell className="px-2.5 py-2 text-[11px] text-stone-500 dark:text-stone-400">{s.journal || '—'}</TableCell>
              <TableCell className="px-2.5 py-2"><PmidCell pubmedId={s.pubmedId} /></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

/** 单独结构表（v1.31 全量列表 — 组分独立解析，次要参考） */
function SoloTable({ list }: { list: PdbEntry[] }) {
  return (
    <div className="eval-scroll overflow-x-auto rounded-md border border-stone-200 dark:border-stone-800">
      <Table className="w-full border-collapse text-xs">
        <TableHeader className="bg-stone-50 dark:bg-stone-900/80">
          <TableRow className="hover:bg-transparent dark:hover:bg-transparent">
            <TableHead className={cxTh}>PDB ID</TableHead>
            <TableHead className={cxTh}>方法</TableHead>
            <TableHead className={cxTh}>分辨率</TableHead>
            <TableHead className={cxTh}>标题</TableHead>
            <TableHead className={cxTh}>释放日期</TableHead>
            <TableHead className={cxTh}>期刊</TableHead>
            <TableHead className={cxTh}>文献</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {list.map(p => (
            <TableRow key={p.pdbId} className="border-stone-100 dark:border-stone-800/60 hover:bg-stone-50/70 dark:hover:bg-stone-800/40">
              <TableCell className="px-2.5 py-2 font-mono text-[11px]">
                <a
                  href={`https://www.rcsb.org/structure/${p.pdbId}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-semibold text-emerald-800 underline-offset-2 hover:underline dark:text-emerald-400"
                >
                  {p.pdbId}
                </a>
              </TableCell>
              <TableCell className="px-2.5 py-2"><MethodBadgeSm isXray={p.isXray} isCryoem={p.isCryoem} isNmr={p.isNmr} method={p.method} /></TableCell>
              <TableCell className="px-2.5 py-2 font-mono text-[11px] tabular-nums text-stone-600 dark:text-stone-400">
                {p.resolution != null ? `${p.resolution.toFixed(2)} Å` : '—'}
              </TableCell>
              <TableCell className="max-w-64 px-2.5 py-2 text-[11px] leading-relaxed text-stone-600 dark:text-stone-400">
                <span className="line-clamp-2" title={p.title}>{p.title || '—'}</span>
              </TableCell>
              <TableCell className="px-2.5 py-2 font-mono text-[11px] whitespace-nowrap text-stone-500 dark:text-stone-400">
                {p.releaseDate || '—'}
              </TableCell>
              <TableCell className="px-2.5 py-2 text-[11px] text-stone-500 dark:text-stone-400">{p.journal || '—'}</TableCell>
              <TableCell className="px-2.5 py-2"><PmidCell pubmedId={p.pubmedId} /></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

/** 折叠展开条（与 HTML 报告 details.fold 语义一致 — 展开后全量可见） */
function FoldMore({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <details className="group overflow-hidden rounded-md border border-stone-200 dark:border-stone-800">
      <summary className="flex cursor-pointer select-none items-center gap-1.5 border-b border-stone-200 bg-stone-50 px-3.5 py-2 text-[11px] font-medium text-emerald-800 list-none transition-colors hover:bg-stone-100 dark:border-stone-800 dark:bg-stone-900/80 dark:text-emerald-500 dark:hover:bg-stone-800/60 [&::-webkit-details-marker]:hidden">
        <ChevronDown className="size-3.5 shrink-0 transition-transform duration-200 group-open:rotate-180" aria-hidden />
        {label}
      </summary>
      <div className="px-2.5 py-2.5">{children}</div>
    </details>
  )
}

/** 共有结构直出条数（其余折叠；展开后全量可见 — 与 HTML 报告一致） */
const SHARED_PREVIEW = 12
/** 单组分单独结构直出条数（其余折叠） */
const SOLO_PREVIEW = 6

/** 单个 curated 复合物卡片（与 HTML 报告 complexCardHtml 一致）：
 *  头部 chips → 组分表（共有/单独列，靶点行高亮）→ 共有结构绿色面板（全量表，突出）→ 单独结构分组折叠（全量表） */
function ComplexCard({ c }: { c: InteractionComplexInfo }) {
  const others = c.components.filter(x => !x.isTarget)
  const shared = c.sharedPdbs ?? []
  const sharedTotal = c.sharedPdbTotal ?? 0
  const sharedOmitted = c.sharedPdbOmitted ?? Math.max(0, sharedTotal - shared.length)
  const soloTotal = c.soloPdbTotal ?? others.reduce((s, x) => s + (x.soloPdbCount ?? 0), 0)
  const sharedHead = shared.slice(0, SHARED_PREVIEW)
  const sharedRest = shared.slice(SHARED_PREVIEW)
  const soloComps = others
    .map(x => ({
      comp: x,
      list: x.soloPdbs ?? x.soloRepresentativePdbs ?? [],
      omitted: x.soloPdbOmitted ?? Math.max(0, (x.soloPdbCount ?? 0) - (x.soloPdbs ?? x.soloRepresentativePdbs ?? []).length),
    }))
    .filter(g => g.list.length > 0 || (g.comp.soloPdbCount ?? 0) > 0)

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

      {/* 共有结构：绿色面板突出（组装先例）— 全量表 + 折叠展开全量 */}
      {shared.length > 0 && (
        <div className="flex flex-col gap-2 rounded-lg border border-emerald-200 bg-gradient-to-b from-emerald-50/70 to-white p-3.5 dark:border-emerald-900 dark:from-emerald-950/30 dark:to-stone-900">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm font-bold text-emerald-900 dark:text-emerald-300">
            <Layers3 className="size-4 self-center text-emerald-700 dark:text-emerald-500" aria-hidden />
            共有结构 <span className="font-mono text-base text-emerald-800 dark:text-emerald-400">{sharedTotal}</span> 个
            <span className="basis-full text-[11px] font-normal leading-relaxed text-stone-500 dark:text-stone-400">
              同一 PDB 条目含 ≥2 个复合物组分 — 共组装先例，复合物路线最直接的结构证据；「其他组分」列为该 PDB
              中复合物组分之外的蛋白（如 F-box 家族底物受体），提示更大装配语境
            </span>
          </div>
          <SharedTable list={sharedHead} />
          {sharedRest.length > 0 && (
            <FoldMore label={`展开其余 ${sharedRest.length} 个共有结构（共 ${sharedTotal} 个）`}>
              <SharedTable list={sharedRest} />
            </FoldMore>
          )}
          {sharedOmitted > 0 && (
            <p className="text-[11px] text-stone-400 dark:text-stone-500">
              另有 {sharedOmitted} 个共有结构超出详情拉取上限未列出（总数已计入）。
            </p>
          )}
        </div>
      )}

      {/* 单独结构：默认折叠（次要参考）— 按组分分组，展开全量表 */}
      {soloComps.length > 0 && (
        <details className="group overflow-hidden rounded-lg border border-stone-200 dark:border-stone-800">
          <summary className="flex cursor-pointer select-none items-center gap-1.5 border-b border-stone-200 bg-stone-50 px-3.5 py-2 text-[11px] font-medium text-emerald-800 list-none transition-colors hover:bg-stone-100 dark:border-stone-800 dark:bg-stone-900/80 dark:text-emerald-500 dark:hover:bg-stone-800/60 [&::-webkit-details-marker]:hidden">
            <Network className="size-3.5 shrink-0" aria-hidden />
            单独结构（各组分独立解析，共 {soloTotal} 个 — 次要参考：边界借鉴/构象对照，默认折叠）
          </summary>
          <div className="flex flex-col gap-3 px-3.5 py-3">
            {soloComps.map(({ comp, list, omitted }) => {
              const head = list.slice(0, SOLO_PREVIEW)
              const rest = list.slice(SOLO_PREVIEW)
              return (
                <div key={`${c.complexAc}-solo-${comp.accession}`} className="flex flex-col gap-2 rounded-md border border-stone-100 bg-stone-50/40 p-2.5 dark:border-stone-800/60 dark:bg-stone-900/40">
                  <div className="text-xs font-semibold text-stone-800 dark:text-stone-200">
                    {comp.name} <span className="ml-1 font-mono text-[10.5px] font-normal text-stone-400">{comp.accession}</span>
                    <span className="ml-1.5 font-normal text-stone-500 dark:text-stone-400">
                      — {comp.soloPdbCount ?? list.length} 个单独结构
                      <span className="ml-1 text-[10.5px] text-stone-400 dark:text-stone-500">（不含复合物其他组分）</span>
                    </span>
                  </div>
                  {list.length > 0 && <SoloTable list={head} />}
                  {rest.length > 0 && (
                    <FoldMore label={`展开 ${comp.name} 其余 ${rest.length} 个单独结构`}>
                      <SoloTable list={rest} />
                    </FoldMore>
                  )}
                  {omitted > 0 && (
                    <p className="text-[11px] text-stone-400 dark:text-stone-500">
                      另有 {omitted} 个单独结构超出详情拉取上限未列出（总数已计入）。
                    </p>
                  )}
                </div>
              )
            })}
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
 * 靶点无直接结构时，列出其复合物其他组分的结构，按「共有 / 单独」分类；
 * v1.31 全量列表（折叠展开可见）+ 其他组分标注 + PubMed 文献直跳。
 */
export function InteractionStructures({ itx }: InteractionStructuresProps) {
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
        （组分独立解析）为次要参考，默认折叠（展开可见全量列表）。
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
