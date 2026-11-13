/**
 * 独立 HTML 评估报告渲染（期刊版式）：
 *  - 内联 CSS，无外部依赖，单文件可离线打开/打印；衬线标题 + 等宽数据标签的学术排版
 *  - LLM 章节用轻量 Markdown 子集渲染器（无 JSDOM/react-markdown，零额外内存）
 *  - 确定性数据区块（评分/结构表/文献/实验图）模板直出，图片按预算 base64 内嵌
 *  - PDB ↔ 文献双向关联（PMID 映射）；长列表 details 折叠，打印时自动展开
 * 图片预算：单图 ≤2MB（解析时已限），内嵌总数 ≤8 张、总预算 ≤6MB，gel/sec 优先。
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { BlastHit, LiteratureItem, ParsedImage, PdbEntry, MethodStats } from './types'
import { describeBlastStatus } from './types'
import type { InteractionAnalysis, InteractionComplexInfo, InteractionSharedPdb } from './types'
import type { ReportContext } from './report'
import { describeEvidenceSource, describeOligoConfidence } from './oligomer'

// ─── Markdown 子集 → HTML ─────────────────────────────────────────────────────

export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function inlineMd(s: string): string {
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).。,，；;：:]|$)/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/PMID\s*(\d{6,9})/g, 'PMID <a href="https://pubmed.ncbi.nlm.nih.gov/$1/" target="_blank" rel="noopener">$1</a>')
}

export function renderMarkdown(md: string, headingOffset = 0): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let inList = false
  let tableBuf: string[][] = []

  const flushList = () => { if (inList) { out.push('</ul>'); inList = false } }
  const flushTable = () => {
    if (tableBuf.length > 0) {
      const [head, ...body] = tableBuf
      out.push('<div class="tbl-wrap"><table>')
      out.push(`<thead><tr>${head.map(c => `<th>${inlineMd(c)}</th>`).join('')}</tr></thead>`)
      if (body.length) out.push(`<tbody>${body.map(r => `<tr>${r.map(c => `<td>${inlineMd(c)}</td>`).join('')}</tr>`).join('')}</tbody>`)
      out.push('</table></div>')
      tableBuf = []
    }
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    if (/^\|(.+)\|\s*$/.test(line)) {
      flushList()
      const cells = line.slice(1, -1).split('|').map(c => c.trim())
      // 跳过分隔行 |---|---|
      if (cells.every(c => /^:?-{2,}:?$/.test(c) || c === '')) continue
      tableBuf.push(cells)
      continue
    }
    flushTable()
    if (!line.trim()) { flushList(); continue }
    const h = line.match(/^(#{2,4})\s+(.*)$/)
    if (h) {
      flushList()
      const level = Math.min(6, h[1].length + headingOffset)
      const text = h[2].trim()
      out.push(`<h${level} id="${slug(text)}">${inlineMd(text)}</h${level}>`)
      continue
    }
    if (/^>\s?/.test(line)) {
      flushList()
      out.push(`<blockquote>${inlineMd(line.replace(/^>\s?/, ''))}</blockquote>`)
      continue
    }
    const li = line.match(/^\s*(?:[-*•]|\d+[.、)])\s+(.*)$/)
    if (li) {
      if (!inList) { out.push('<ul>'); inList = true }
      out.push(`<li>${inlineMd(li[1])}</li>`)
      continue
    }
    flushList()
    out.push(`<p>${inlineMd(line.trim())}</p>`)
  }
  flushList()
  flushTable()
  return out.join('\n')
}

function slug(s: string): string {
  return 's-' + esc(s).replace(/[^\u4e00-\u9fa5a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
}

// ─── 确定性数据区块 ───────────────────────────────────────────────────────────

function scoreBar(label: string, item: { score: number; rating: string }, color: string, cls = ''): string {
  const pct = Math.round((item.score / 10) * 100)
  return `
  <div class="score-row ${cls}">
    <div class="score-label">${label}</div>
    <div class="score-track"><div class="score-fill" style="width:${pct}%;background:${color}"></div></div>
    <div class="score-num">${item.score}<span class="score-max">/10</span></div>
    <div class="score-rating">${esc(item.rating)}</div>
  </div>`
}

/** 配体短显示："A1B6E (N-[4-(3-chloro…))" → 截断化学名保留编号（悬停可见全名） */
function shortLigand(l: string, nameMax = 22): string {
  const m = l.match(/^(\S+)\s*\((.*)\)\s*$/)
  if (!m) return l.length > 32 ? l.slice(0, 31) + '…' : l
  const [, id, name] = m
  return name.length > nameMax ? `${id} (${name.slice(0, nameMax - 1)}…)` : `${id} (${name})`
}

/** 配体归一策略 → 中文短标签 */
function strategyZh(s: string): string {
  switch (s) {
    case 'direct-id': return '直接ID'
    case 'alias': return '别名表'
    case 'pdb-search': return 'PDBe检索'
    case 'llm': return 'AI'
    case 'llm+pdb-search': return 'AI+检索'
    default: return s || '—'
  }
}

/** PDB 表格行（配体截断悬停全名；PMID 悬停显示关联文献标题） */
function pdbRowsHtml(pdbs: PdbEntry[], max: number, litByPmid: Map<string, LiteratureItem>): string {
  return pdbs.slice(0, max).map(p => {
    const lit = p.pubmedId ? litByPmid.get(p.pubmedId) : undefined
    const ligShow = p.ligands.slice(0, 2).map(l => shortLigand(l)).join('; ')
    return `
    <tr>
      <td class="td-id"><a href="https://www.rcsb.org/structure/${p.pdbId}" target="_blank" rel="noopener">${p.pdbId}</a></td>
      <td><span class="mth mth-${p.isXray ? 'xray' : p.isCryoem ? 'cryoem' : p.isNmr ? 'nmr' : 'other'}">${esc(methodLabel(p))}</span></td>
      <td class="num">${p.resolution != null ? p.resolution.toFixed(2) : '—'}</td>
      <td class="t-rng"${p.chainRanges ? ` title="${esc(p.chainRanges)}（UniProt 残基编号范围）"` : ''}>${esc(p.chainRanges || '—')}</td>
      <td class="t-title">${esc(p.title)}</td>
      <td class="num">${esc(p.releaseDate || '—')}</td>
      <td class="t-lig" title="${esc(p.ligands.slice(0, 5).join('; '))}">${ligShow ? esc(ligShow) : '—'}${p.ligands.length > 2 ? `<span class="lig-more"> 等${p.ligands.length}</span>` : ''}</td>
      <td class="t-journal">${esc(p.journal || '—')}</td>
      <td class="td-id">${p.pubmedId
        ? `<a href="https://pubmed.ncbi.nlm.nih.gov/${p.pubmedId}/" target="_blank" rel="noopener" title="${esc(lit ? `PMID ${p.pubmedId} · ${lit.title}` : `PubMed ${p.pubmedId}`)}">${p.pubmedId}${lit ? '<span class="lit-dot"></span>' : ''}</a>`
        : '—'}</td>
    </tr>`
  }).join('')
}

/** PDB 数据表 colgroup（固定列宽，杜绝长内容挤压/重叠；窄屏由 .tbl-wrap 横向滚动） */
const PDB_COLGROUP = `<colgroup>
  <col style="width:74px"><col style="width:62px"><col style="width:64px"><col style="width:96px"><col>
  <col style="width:86px"><col style="width:146px"><col style="width:106px"><col style="width:72px">
</colgroup>`

/** PDB 表格：前 preview 条直出，剩余放入 details 折叠 */
function pdbTableHtml(pdbs: PdbEntry[], preview: number, max: number, litByPmid: Map<string, LiteratureItem>): string {
  const shown = pdbs.slice(0, max)
  const head = shown.slice(0, preview)
  const rest = shown.slice(preview)
  const headHtml = `
  <div class="tbl-wrap"><table class="tbl-data">
    ${PDB_COLGROUP}
    <thead><tr><th>PDB ID</th><th>方法</th><th class="num">分辨率 (Å)</th><th>范围</th><th>标题</th><th class="num">释放日期</th><th>主要配体</th><th>期刊</th><th>文献</th></tr></thead>
    <tbody>${pdbRowsHtml(head, preview, litByPmid)}</tbody>
  </table></div>`
  if (rest.length === 0) return headHtml
  return `${headHtml}
  <details class="fold">
    <summary>展开其余 ${rest.length} 条结构（共 ${shown.length} 条，打印时自动展开）</summary>
    <div class="tbl-wrap"><table class="tbl-data">
      ${PDB_COLGROUP}
      <thead><tr><th>PDB ID</th><th>方法</th><th class="num">分辨率 (Å)</th><th>范围</th><th>标题</th><th class="num">释放日期</th><th>主要配体</th><th>期刊</th><th>文献</th></tr></thead>
      <tbody>${pdbRowsHtml(rest, rest.length, litByPmid)}</tbody>
    </table></div>
  </details>`
}

function methodLabel(p: PdbEntry): string {
  if (p.isXray) return 'X-ray'
  if (p.isCryoem) return 'Cryo-EM'
  if (p.isNmr) return 'NMR'
  return p.method.slice(0, 12) || '—'
}

// ─── v1.29/v1.30 互作复合物证据（Complex Portal / IntAct，无直接结构时）──────────

function stochShort(text: string): string {
  return text.replace(/minValue:\s*/g, '').replace(/maxValue:\s*/g, '').replace(/,\s*/g, '–').trim()
}

/** 共有结构徽标方法标签（X-ray/Cryo-EM/NMR 配色与 PDB 表一致） */
function sharedMethodBadge(s: { isXray: boolean; isCryoem: boolean; isNmr: boolean; method: string }): string {
  const cls = s.isXray ? 'xray' : s.isCryoem ? 'cryoem' : s.isNmr ? 'nmr' : 'other'
  const label = s.isXray ? 'X-ray' : s.isCryoem ? 'Cryo-EM' : s.isNmr ? 'NMR' : s.method.slice(0, 10)
  return `<span class="mth mth-${cls}">${esc(label)}</span>`
}

/** v1.31 PubMed 链接（结构主引文 — 共有/单独/BLAST 列表的「文献」列；紧凑号位直显 PMID 号） */
function pmidLink(pubmedId: string | null | undefined): string {
  if (!pubmedId) return '<span class="t-pmid-none">—</span>'
  return `<a class="t-pmid" href="https://pubmed.ncbi.nlm.nih.gov/${esc(pubmedId)}/" target="_blank" rel="noopener" title="跳转 PubMed 文献 PMID ${esc(pubmedId)}">${esc(pubmedId)}</a>`
}

/** 共有/单独结构表 colgroup（与直接结构表同款列宽策略；紧凑字号 — 9 列在报告页面内免横向滚动） */
const CX_SHARED_COLGROUP = `<colgroup>
  <col style="width:66px"><col style="width:58px"><col style="width:50px"><col style="width:120px"><col style="width:84px">
  <col><col style="width:68px"><col style="width:72px"><col style="width:82px">
</colgroup>`
const CX_SHARED_THEAD = `<thead><tr><th>PDB ID</th><th>方法</th><th class="num" title="分辨率（Å）">分辨率</th><th>覆盖组分</th><th>其他组分</th><th>标题</th><th class="num">释放日期</th><th>期刊</th><th>文献</th></tr></thead>`
const CX_SOLO_COLGROUP = `<colgroup>
  <col style="width:66px"><col style="width:58px"><col style="width:50px"><col>
  <col style="width:68px"><col style="width:72px"><col style="width:82px">
</colgroup>`
const CX_SOLO_THEAD = `<thead><tr><th>PDB ID</th><th>方法</th><th class="num" title="分辨率（Å）">分辨率</th><th>标题</th><th class="num">释放日期</th><th>期刊</th><th>文献</th></tr></thead>`

/** 共有结构行：覆盖组分（绿 chip）+ 其他组分（琥珀 chip，如 FBXO22）+ 文献直跳 */
function sharedRowHtml(s: InteractionSharedPdb): string {
  const extras = s.extraComponents ?? []
  const extraShow = extras.slice(0, 3)
  const extraMore = extras.length - extraShow.length
  const accs = s.extraAccessions ?? []
  return `
    <tr>
      <td class="td-id"><a href="https://www.rcsb.org/structure/${esc(s.pdbId)}" target="_blank" rel="noopener">${esc(s.pdbId)}</a></td>
      <td>${sharedMethodBadge(s)}</td>
      <td class="num">${s.resolution != null ? s.resolution.toFixed(2) : '—'}</td>
      <td><span class="csi-comps" title="${esc(s.componentNames.join(' + '))}（覆盖 ${s.componentCount} 个复合物组分）">${esc(s.componentNames.join('+'))}<i>×${s.componentCount}</i></span></td>
      <td class="t-extras">${extraShow.length
        ? extraShow.map((n, i) => `<span class="csi-extra" title="${esc(accs[i] ?? '')}">+ ${esc(n)}</span>`).join('') + (extraMore > 0 ? `<span class="csi-extra-more">等${extraMore}</span>` : '')
        : '<span class="t-pmid-none">—</span>'}</td>
      <td class="t-title">${esc(s.title)}</td>
      <td class="num">${esc(s.releaseDate || '—')}</td>
      <td class="t-journal">${esc(s.journal || '—')}</td>
      <td class="td-id">${pmidLink(s.pubmedId)}</td>
    </tr>`
}

/** 单独结构行（组分独立解析 — 次要参考） */
function soloRowHtml(p: PdbEntry): string {
  return `
    <tr>
      <td class="td-id"><a href="https://www.rcsb.org/structure/${esc(p.pdbId)}" target="_blank" rel="noopener">${esc(p.pdbId)}</a></td>
      <td>${sharedMethodBadge(p)}</td>
      <td class="num">${p.resolution != null ? p.resolution.toFixed(2) : '—'}</td>
      <td class="t-title">${esc(p.title)}</td>
      <td class="num">${esc(p.releaseDate || '—')}</td>
      <td class="t-journal">${esc(p.journal || '—')}</td>
      <td class="td-id">${pmidLink(p.pubmedId)}</td>
    </tr>`
}

/** 共有/单独结构表壳（共有/单独复用 — 折叠区内外同款表头） */
function cxTableHtml(rows: string, colgroup: string, thead: string): string {
  return `<div class="tbl-wrap"><table class="tbl-data tbl-cx-pdb">${colgroup}${thead}<tbody>${rows}</tbody></table></div>`
}

/** 共有结构直出条数（其余折叠 — 折叠区展开后仍全量可见） */
const CX_SHARED_PREVIEW = 12
/** 单组分单独结构直出条数（其余折叠） */
const CX_SOLO_PREVIEW = 6

/**
 * v1.30/v1.31 单个 curated 复合物卡片：
 *  - 头部：CPX 编号 + 名称 + 装配/分子量/组分结构 chips
 *  - 组分构成表（靶点行高亮；共有/单独结构数分列）
 *  - 共有结构全量表（同一 PDB 含 ≥2 组分 — 组装先例，绿色面板突出；前 12 条直出、
 *    其余折叠展开可见；含其他组分标注（如 FBXO22）与 PubMed 文献直跳）
 *  - 单独结构全量表（各组分独立解析 — 次要参考，默认折叠；按组分分组，每组前 6 条
 *    直出、其余折叠展开可见）
 */
function complexCardHtml(c: InteractionComplexInfo): string {
  const others = c.components.filter(x => !x.isTarget)
  const shared = c.sharedPdbs ?? []
  const sharedTotal = c.sharedPdbTotal ?? 0
  const sharedOmitted = c.sharedPdbOmitted ?? Math.max(0, sharedTotal - shared.length)
  const soloTotal = c.soloPdbTotal ?? others.reduce((s, x) => s + (x.soloPdbCount ?? 0), 0)

  const sharedHeadRows = shared.slice(0, CX_SHARED_PREVIEW)
  const sharedRest = shared.slice(CX_SHARED_PREVIEW)
  const sharedListHtml = shared.length ? `
    <div class="cx-shared">
      <div class="cx-shared-head"><span class="cx-shared-ico" aria-hidden="true">◈</span>共有结构 <b>${sharedTotal}</b> 个<span class="cx-shared-sub">同一 PDB 条目含 ≥2 个复合物组分 — 共组装先例，复合物路线最直接的结构证据；「其他组分」列为该 PDB 中复合物组分之外的蛋白（如 F-box 家族底物受体），提示更大装配语境</span></div>
      ${cxTableHtml(sharedHeadRows.map(sharedRowHtml).join(''), CX_SHARED_COLGROUP, CX_SHARED_THEAD)}
      ${sharedRest.length ? `
      <details class="fold">
        <summary>展开其余 ${sharedRest.length} 个共有结构（共 ${sharedTotal} 个，打印时自动展开）</summary>
        ${cxTableHtml(sharedRest.map(sharedRowHtml).join(''), CX_SHARED_COLGROUP, CX_SHARED_THEAD)}
      </details>` : ''}
      ${sharedOmitted > 0 ? `<p class="note">另有 ${sharedOmitted} 个共有结构超出详情拉取上限未列出（总数已计入）。</p>` : ''}
    </div>` : ''

  const soloComps = others
    .map(x => ({ comp: x, list: x.soloPdbs ?? x.soloRepresentativePdbs ?? [], omitted: x.soloPdbOmitted ?? Math.max(0, (x.soloPdbCount ?? 0) - (x.soloPdbs ?? x.soloRepresentativePdbs ?? []).length) }))
    .filter(g => g.list.length > 0 || (g.comp.soloPdbCount ?? 0) > 0)
  const soloFoldHtml = soloComps.length ? `
    <details class="fold cx-solo-fold">
      <summary>单独结构（各组分独立解析，共 ${soloTotal} 个 — 次要参考：边界借鉴/构象对照，默认折叠）</summary>
      ${soloComps.map(({ comp, list, omitted }) => {
        const head = list.slice(0, CX_SOLO_PREVIEW)
        const rest = list.slice(CX_SOLO_PREVIEW)
        return `
      <div class="cx-solo-comp">
        <div class="cx-solo-head"><b>${esc(comp.name)}</b> <span class="mono">${esc(comp.accession)}</span> — ${comp.soloPdbCount ?? list.length} 个单独结构<span class="cx-solo-sub">（不含复合物其他组分）</span></div>
        ${list.length ? cxTableHtml(head.map(soloRowHtml).join(''), CX_SOLO_COLGROUP, CX_SOLO_THEAD) : ''}
        ${rest.length ? `
        <details class="fold">
          <summary>展开 ${esc(comp.name)} 其余 ${rest.length} 个单独结构（打印时自动展开）</summary>
          ${cxTableHtml(rest.map(soloRowHtml).join(''), CX_SOLO_COLGROUP, CX_SOLO_THEAD)}
        </details>` : ''}
        ${omitted > 0 ? `<p class="note">另有 ${omitted} 个单独结构超出详情拉取上限未列出（总数已计入）。</p>` : ''}
      </div>`
      }).join('')}
      <p class="note">单独结构仅含单一组分（不含复合物其他组分）— 可用于组分域边界设计与构象状态对照，但不能证明复合物组装形式。</p>
    </details>` : ''

  return `
  <div class="cx-card">
    <div class="cx-head">
      <span class="cx-badge">Complex Portal</span>
      <b class="cx-name"><a href="https://www.ebi.ac.uk/complexportal/complex/${esc(c.complexAc)}" target="_blank" rel="noopener">${esc(c.complexAc)}</a>${c.name ? ` ${esc(c.name)}` : ''}</b>
      ${c.assembly ? `<span class="cx-chip">${esc(c.assembly)}</span>` : ''}
      ${c.assemblyKda != null ? `<span class="cx-chip">装配 ~${c.assemblyKda} kDa</span>` : ''}
      <span class="cx-chip ${c.componentsWithStructure > 0 ? 'cx-ok' : ''}">${c.componentsWithStructure}/${others.length} 其他组分有结构</span>
      ${sharedTotal ? `<span class="cx-chip cx-chip-shared">共有结构 ${sharedTotal}</span>` : ''}
    </div>
    <div class="tbl-wrap"><table class="tbl-data tbl-cx">
      <thead><tr><th>组分</th><th style="width:88px">UniProt</th><th style="width:56px">计量</th><th style="width:82px" class="num">分子量</th><th style="width:60px" class="num">共有</th><th style="width:60px" class="num">单独</th></tr></thead>
      <tbody>${c.components.map(x => `
        <tr${x.isTarget ? ' class="cx-target"' : ''}>
          <td class="t-title">${x.isTarget ? '<b>【靶点】</b>' : ''}${esc(x.name)}${x.description ? `<span class="cx-desc"> · ${esc(x.description.slice(0, 44))}</span>` : ''}</td>
          <td class="td-id"><a href="https://www.uniprot.org/uniprotkb/${esc(x.accession)}" target="_blank" rel="noopener">${esc(x.accession)}</a></td>
          <td class="num">${esc(stochShort(x.stoichiometryText) || '—')}</td>
          <td class="num">${x.kda != null ? `~${x.kda}` : '—'}</td>
          <td class="num">${x.isTarget ? '—' : String(x.sharedPdbIds?.length ?? 0)}</td>
          <td class="num" ${x.isTarget ? 'title="评估对象 — 无直接结构（本分析前提）"' : ''}>${x.isTarget ? '—' : String(x.soloPdbCount ?? 0)}</td>
        </tr>`).join('')}</tbody>
    </table></div>
    ${sharedListHtml}
    ${soloFoldHtml}
  </div>`
}

/** 互作复合物证据全景（v1.30 接入 PDB 章节）：curated 复合物卡片（共有突出/单独折叠）+ binary 伙伴 */
export function interactionEvidenceHtml(itx: InteractionAnalysis | null | undefined): string {
  if (!itx || !itx.applicable || !itx.hasEvidence) return ''
  const complexes = itx.complexes.map(complexCardHtml).join('')
  const binaries = itx.binaryPartners.length ? `
  <details class="fold">
    <summary>IntAct binary 互作伙伴（复合物之外，${itx.binaryPartners.length} 个有结构 — 互作界面参考，默认折叠）</summary>
    <ul class="mw-list">${itx.binaryPartners.map(b => `<li><b>${esc(b.geneName ?? b.accession)}</b> <span class="mono">${esc(b.accession)}</span> — ${b.pdbCount} 个结构${b.representativePdbs.length ? `（${b.representativePdbs.map(p => `<a href="https://www.rcsb.org/structure/${p.pdbId}" target="_blank" rel="noopener">${p.pdbId}</a><span class="cx-res">${p.resolution != null ? p.resolution.toFixed(1) + 'Å' : ''}</span>`).join(' ')}）` : ''}</li>`).join('')}</ul>
    <p class="note">binary 互作（IntAct 实验证据）伙伴有结构 — 互作界面建模与 pull-down/SPR 验证设计可参考，非 curated 复合物，化学计量需实验确认。</p>
  </details>` : ''
  return `
  <h3 class="itx-h3">互作复合物组分结构 <span class="itx-h3-sub">Complex Portal curated · ${itx.complexes.length} 个复合物</span></h3>
  <p class="note">靶点无直接结构 — 以下为其所在复合物其他组分的结构清单，按「共有 / 单独」分类：<b>共有结构</b>（同一 PDB 含 ≥2 个组分）是复合物共组装的直接先例，重点展示；<b>单独结构</b>（组分独立解析）为次要参考，默认折叠。</p>
  ${complexes}
  ${binaries}`
}

function blastRowsHtml(hits: BlastHit[]): string {
  return hits.map(h => {
    const range = h.queryFrom != null && h.queryTo != null && h.queryFrom > 0 && h.queryTo > 0
      ? `${h.queryFrom}-${h.queryTo}`
      : (h.queryCoverage != null && h.queryCoverage > 0 ? `${h.queryCoverage} aa` : '—')
    return `
    <tr>
      <td class="td-id">${h.pdbId ? `<a href="https://www.rcsb.org/structure/${h.pdbId}" target="_blank" rel="noopener">${h.pdbId}</a>` : '—'}</td>
      <td class="t-desc">${esc(h.description)}</td>
      <td class="num">${h.identity.toFixed(1)}%</td>
      <td class="num">${esc(h.evalueRaw)}</td>
      <td class="num">${esc(range)}</td>
      <td class="t-nowrap">${esc(h.method || '—')}</td>
      <td class="num">${h.resolution != null ? h.resolution.toFixed(2) : '—'}</td>
      <td class="td-id">${pmidLink(h.pubmedId)}</td>
    </tr>`
  }).join('')
}

/** 文献条目（附关联 PDB chips） */
function litItemsHtml(lits: LiteratureItem[], pdbByPmid: Map<string, PdbEntry[]>, preview: number): string {
  const shown = lits.slice(0, preview)
  const rest = lits.slice(preview)
  const item = (l: LiteratureItem, i: number) => {
    const linked = (pdbByPmid.get(String(l.pmid).trim()) ?? []).slice(0, 6)
    return `
    <li class="lit-item">
      <div class="lit-no">${String(i + 1).padStart(2, '0')}</div>
      <div class="lit-body">
        <div class="lit-title"><a href="https://pubmed.ncbi.nlm.nih.gov/${l.pmid}/" target="_blank" rel="noopener">${esc(l.title)}</a>${l.fromPdb ? '<span class="lit-src">结构解析文献</span>' : ''}</div>
        <div class="lit-meta">${esc(l.journal)}${l.year ? ` · ${esc(l.year)}` : ''}${l.doi ? ` · DOI: <a href="https://doi.org/${esc(l.doi)}" target="_blank" rel="noopener">${esc(l.doi)}</a>` : ''} · PMID ${esc(l.pmid)}</div>
        ${l.abstractExcerpt ? `<div class="lit-abs">${esc(l.abstractExcerpt)}</div>` : ''}
        ${linked.length ? `<div class="lit-pdbs"><span class="lit-pdbs-label">关联结构</span>${linked.map(p => `<a href="https://www.rcsb.org/structure/${p.pdbId}" target="_blank" rel="noopener" title="${esc(p.title)}">${p.pdbId}</a>`).join('')}</div>` : ''}
      </div>
    </li>`
  }
  const headHtml = shown.map((l, i) => item(l, i)).join('')
  if (rest.length === 0) return `<ol class="lit-list">${headHtml}</ol>`
  return `<ol class="lit-list">${headHtml}</ol>
  <details class="fold">
    <summary>展开其余 ${rest.length} 篇文献（共 ${lits.length} 篇，打印时自动展开）</summary>
    <ol class="lit-list" start="${preview + 1}">${rest.map((l, i) => item(l, preview + i)).join('')}</ol>
  </details>`
}

// ─── 图片内嵌（预算控制）──────────────────────────────────────────────────────
// 与 docx 提取上限（12 张）对齐：任意张数/任意类型组合（仅胶图、仅 SEC、多张混合）全部内嵌；
// 体积预算超出时按 gel > sec > other 优先级截断（每张落盘前已软压 ≤800KB，典型总量 2-5MB）
const EMBED_MAX_COUNT = 12
const EMBED_MAX_TOTAL = 9 * 1024 * 1024

export interface EmbeddedImage {
  meta: ParsedImage
  dataUri: string | null // null = 超预算未嵌入
}

export async function embedImages(
  images: ParsedImage[],
  resolvePath: (meta: ParsedImage) => string,
): Promise<EmbeddedImage[]> {
  // gel/sec 优先，同 kind 内按原顺序
  const ordered = [...images].sort((a, b) => rank(b) - rank(a))
  const result: EmbeddedImage[] = []
  let total = 0
  let embeddedCount = 0
  for (const meta of ordered) {
    let dataUri: string | null = null
    if (embeddedCount < EMBED_MAX_COUNT) {
      try {
        const buf = await fs.readFile(resolvePath(meta))
        if (buf.length > 0 && total + buf.length <= EMBED_MAX_TOTAL) {
          dataUri = `data:${meta.mime};base64,${buf.toString('base64')}`
          total += buf.length
          embeddedCount++
        }
      } catch { /* 文件缺失 → 不嵌入 */ }
    }
    result.push({ meta, dataUri })
  }
  // 恢复原顺序
  result.sort((a, b) => images.indexOf(a.meta) - images.indexOf(b.meta))
  return result
}

function rank(i: ParsedImage): number {
  return i.kind === 'gel' ? 3 : i.kind === 'sec' ? 2 : 1
}

// ─── 报告组装 ────────────────────────────────────────────────────────────────

export interface ReportRenderInput {
  ctx: ReportContext
  methodStats: MethodStats
  llmMarkdown: string
  llmOk: boolean
  llmErrors: string[]
  jobId: string
  durationMs: number
  totalPdbFound: number
  /** 分析引擎摘要（如 “Z.ai GLM-4.6（内置）” / “OpenAI · gpt-4o”） */
  engineSummary: string
  /** 图片文件路径解析（由 pipeline 提供，图片存于 db/reports/{id}/assets/） */
  /** v2.0：AlphaFold 预测结构图（base64 data URI + 元数据；报告头右侧展示） */
  alphafoldFigure?: {
    dataUri: string
    modelId: string
    globalPlddt: number | null
    version: number
    fracVeryHigh: number | null
  }
  resolveImagePath: (meta: ParsedImage) => string
}

/** PDB 直出条数（其余折叠） */
const PDB_PREVIEW = 20
/** 文献直出条数（其余折叠） */
const LIT_PREVIEW = 10

export async function renderReportHtml(input: ReportRenderInput): Promise<string> {
  const { ctx, methodStats, llmMarkdown } = input
  const u = ctx.uniprot
  const dateStr = new Date().toISOString().slice(0, 10)
  // v1.23：题目体现评估范围（UniProt 残基编号区间）
  const rangeSuffix = ctx.range ? ` · 残基 ${ctx.range[0]}-${ctx.range[1]}` : ''
  const proteinTitle = u ? `${u.proteinName}（${u.uniprotId}${rangeSuffix}）` : (ctx.range ? `序列靶点评估 · 残基 ${ctx.range[0]}-${ctx.range[1]}` : '序列靶点评估')
  const geneStr = u?.geneNames.join(', ') || '—'

  // PMID ↔ PDB 双向关联
  const pdbByPmid = new Map<string, PdbEntry[]>()
  for (const p of ctx.directPdbs) {
    const key = (p.pubmedId ?? '').trim()
    if (!key) continue
    const arr = pdbByPmid.get(key)
    if (arr) arr.push(p)
    else pdbByPmid.set(key, [p])
  }
  const litByPmid = new Map<string, LiteratureItem>()
  for (const l of ctx.literature) {
    if (l.pmid) litByPmid.set(String(l.pmid).trim(), l)
  }
  const linkedLitCount = ctx.literature.filter(l => pdbByPmid.has(String(l.pmid).trim())).length

  const embedded = await embedImages(ctx.images, input.resolveImagePath)

  // 构建信息（合并评估：UniProt+伴随序列）
  const cmp = ctx.providedSequence?.comparison
  const constructHtml = cmp
    ? `${cmp.start != null && cmp.end != null ? `${cmp.start}–${cmp.end} 位 / 全长 ${cmp.fullLength} aa` : `${cmp.providedLength} / ${cmp.fullLength} aa`}${cmp.sameTarget ? ` · 一致性 ${cmp.identity}%` : ` · 相似度 ${cmp.identity}% 疑似不同靶点`}`
    : ''

  // 动态章节编号（v1.28：结构分明 — 全部章节统一编号与视觉锚点）：
  // 一 评估分析 / 二 客户评估表要点（如存在）/ 三 可行性评分 / 四 PDB 结构清单 / 后续按存在性编号
  // v1.25：聚集形式不再单独成章 — 融入评分卡（调整明细 + 证据链折叠）与 LLM 叙事
  const cnNums = ['一', '二', '三', '四', '五', '六', '七', '八']
  const hasInsights = Boolean(ctx.insights && (
    ctx.insights.goals?.length || ctx.insights.scientificQuestions?.length
    || ctx.insights.experimentalSummary || ctx.insights.sequenceNotes
    || ctx.insights.homologs || ctx.insights.keyConcerns?.length))
  let secIdx = 0
  const nextNo = () => cnNums[secIdx++]
  const llmNo = nextNo()
  const insightsNo = hasInsights ? nextNo() : ''
  const scoresNo = nextNo()
  const pdbsNo = nextNo()
  // v1.7+：BLAST 章节在 0 命中/跳过/失败时也渲染状态说明（不再凭空消失）
  const blastRan = ctx.blastStatus && (ctx.blastStatus.status === 'ok' || ctx.blastStatus.status === 'no-hits')
  const showBlastSec = ctx.blastHits.length > 0 || Boolean(ctx.blastStatus)
  const ligNo = (ctx.ligands?.length ?? 0) > 0 ? nextNo() : ''
  const ligandSecHtml = (ctx.ligands?.length ?? 0) > 0 ? `
  <section class="sec" id="ligands">
    <h2><span class="sec-no">${ligNo}</span><span class="sec-title">配体研究数据</span><span class="sec-en">Ligands · ${ctx.ligands!.filter(l => l.ok).length}/${ctx.ligands!.length}</span></h2>
    <p class="note">非标准配体输入经多策略归一（直接 ID / 别名表 / PDBe Solr 检索 / AI 兜底）映射为 RCSB 三位化学组分 ID；结构列表来自 PDBe 字段化检索（含该配体的 PDB 条目，按分辨率排序），绿底标记同时为本靶点直接结构的条目。</p>
    <div class="lig-grid">
    ${ctx.ligands!.map(l => {
      if (!l.ok) return `
      <div class="lig-card lig-fail">
        <div class="lig-head"><span class="lig-id lig-id-fail">?</span><span class="lig-name">${esc(l.raw.length > 40 ? l.raw.slice(0, 39) + '…' : l.raw)}</span></div>
        <div class="lig-meta"><span>未能归一 — ${esc(l.error ?? '未知原因')}</span></div>
      </div>`
      const best = l.structures.find(s => s.resolution != null)?.resolution
      const chips = l.structures.slice(0, 12).map(s =>
        `<a class="${s.alsoTarget ? 'lig-also' : ''}" href="https://www.rcsb.org/structure/${s.pdbId}" target="_blank" rel="noopener" title="${esc(s.title)}${s.resolution != null ? ` · ${s.resolution}Å` : ''}${s.method ? ` · ${s.method}` : ''}${s.alsoTarget ? ' · 本靶点直接结构' : ''}">${s.pdbId}${s.resolution != null ? ` <i>${s.resolution.toFixed(1)}</i>` : ''}</a>`,
      ).join('')
      return `
      <div class="lig-card">
        <div class="lig-head">
          <span class="lig-id">${esc(l.compId)}</span>
          <span class="lig-name">${esc(l.name || l.raw)}</span>
          <span class="lig-src">输入「${esc(l.raw.length > 24 ? l.raw.slice(0, 23) + '…' : l.raw)}」· ${esc(strategyZh(l.strategy))}${l.source === 'eval-table' ? ' · 评估表' : l.source === 'file' ? ' · 文件' : ''}</span>
        </div>
        <div class="lig-meta">
          <span>分子式 <b>${esc(l.formula || '—')}</b></span>
          ${l.weight != null ? `<span>MW <b>${l.weight.toFixed(1)}</b></span>` : ''}
          <span>含该配体结构 <b>${l.totalStructures}</b> 个</span>
          ${best != null ? `<span>最佳分辨率 <b>${best.toFixed(2)} Å</b></span>` : ''}
        </div>
        ${l.structures.length ? `
        <div class="lig-pdbs">${chips}${l.totalStructures > 12 ? `<span class="lig-more">+${l.totalStructures - 12}</span>` : ''}</div>` : `<div class="lig-pdbs lig-none">暂无含该配体的 PDB 结构记录</div>`}
      </div>`
    }).join('')}
    </div>
  </section>` : ''
  const blastNo = showBlastSec ? nextNo() : ''
  const litNo = ctx.literature.length ? nextNo() : ''
  const assetsNo = embedded.length ? nextNo() : ''
  /** v1.28 章节头：编号方块 + 标题 + 英文标签（结构分明、便于导航） */
  const secHead = (no: string, title: string, en: string) =>
    `<span class="sec-no">${no}</span><span class="sec-title">${esc(title)}</span><span class="sec-en">${esc(en)}</span>`

  const scoreColor = (n: number) => (n >= 7 ? '#047857' : n >= 5 ? '#b45309' : '#b91c1c')

  // v1.25：聚集形式（寡聚态）— 评分卡内嵌调整明细 + 证据链折叠（不单独成章）
  const oligo = ctx.oligomer
  const adj = ctx.scores.oligomerAdjust
  const oligoConfZh = oligo ? describeOligoConfidence(oligo.confidence) : ''
  const oligoBadgeColor = oligo?.category === 'monomer' ? '#047857' : oligo?.category === 'hetero-complex' ? '#b45309' : oligo?.category === 'homo-oligomer' ? '#065f46' : '#78716c'
  const oligoCategoryZh = oligo?.category === 'monomer' ? '单体' : oligo?.category === 'homo-oligomer' ? '同源寡聚体' : oligo?.category === 'hetero-complex' ? '异源复合物' : '未知'
  const adjChip = (label: string, v: number) =>
    `<span class="adj-chip ${v > 0 ? 'adj-pos' : v < 0 ? 'adj-neg' : 'adj-zero'}">${label} ${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v)}</span>`
  const oligoStripHtml = oligo ? `
    <div class="oligo-strip">
      <div class="oligo-strip-head">
        <span class="oligo-badge" style="background:${oligoBadgeColor}">${esc(oligoCategoryZh)}</span>
        <span class="oligo-strip-label">聚集形式<b>${esc(oligo.label || oligo.summary.split('—')[0].split('（')[0].trim())}</b></span>
        ${oligo.stoichiometry ? `<span class="oligo-stoich">${esc(oligo.stoichiometry)}</span>` : ''}
        <span class="oligo-conf">置信度：${esc(oligoConfZh)}</span>
        ${adj ? `<span class="oligo-chips">${adjChip('X-ray', adj.xray)}${adjChip('Cryo-EM', adj.cryoem)}${adjChip('NMR', adj.nmr)}</span>` : ''}
      </div>
      ${adj ? `<p class="oligo-strip-note">${esc(adj.note)}（上述调整已计入三方法分数与综合评分）</p>` : `<p class="oligo-strip-note">${esc(oligo.summary)}</p>`}
      ${oligo.evidence.length ? `
      <details class="fold"><summary>聚集形式判定证据链（${oligo.evidence.length} 条 · 按优先级：已有结构 → 同源结构 → UniProt interaction → 文献）</summary>
      <div class="tbl-wrap"><table class="tbl-data">
        <thead><tr><th style="width:150px">来源</th><th style="width:110px">引用</th><th>证据</th></tr></thead>
        <tbody>${oligo.evidence.map(e => `
          <tr>
            <td>${esc(describeEvidenceSource(e.source))}</td>
            <td class="td-id">${/^[0-9A-Z]{4}$/.test(e.ref) ? `<a href="https://www.rcsb.org/structure/${e.ref}" target="_blank" rel="noopener">${e.ref}</a>` : /^PMID /.test(e.ref) ? `<a href="https://pubmed.ncbi.nlm.nih.gov/${e.ref.slice(5)}/" target="_blank" rel="noopener">${e.ref}</a>` : esc(e.ref)}</td>
            <td class="t-title">${esc(e.text)}</td>
          </tr>`).join('')}</tbody>
      </table></div></details>` : ''}
    </div>` : ''

  // v1.26/v1.27：分子量增重策略（小分子量靶点）— 评分卡内嵌（不单独成章，与聚集形式同区呈现）
  const mwA = ctx.mwAugment
  const mwAdj = ctx.scores.mwAugmentAdjust
  const mwPathZh = mwA?.assemblyPath === 'complex' ? '已有复合物结构' : mwA?.assemblyPath === 'oligomer' ? '自身寡聚装配' : mwA?.assemblyPath === 'homolog-complex' ? '同源复合物推断（BLAST）' : mwA?.assemblyPath === 'partner' ? '互作伙伴推断' : '无生物装配路径'
  const mwBadgeColor = mwA?.assemblyPath === 'homolog-complex'
    ? (mwA.assemblyKda != null && mwA.assemblyKda >= 100 ? '#0f766e' : '#b45309')
    : mwA?.assemblyKda != null && mwA.assemblyKda >= 100 ? '#065f46' : mwA?.assemblyKda != null && mwA.assemblyKda >= 50 ? '#b45309' : '#78716c'
  const mwHomologs = mwA?.homologComplexes ?? []
  const mwStripHtml = mwA?.applicable ? `
    <div class="oligo-strip mw-strip">
      <div class="oligo-strip-head">
        <span class="oligo-badge" style="background:${mwBadgeColor}">小分子量靶点</span>
        <span class="oligo-strip-label">分子量<b>单体 ~${mwA.monomerKda} kDa${mwA.assemblyKda != null ? ` → 装配 ~${mwA.assemblyKda} kDa${mwA.assemblyPath === 'homolog-complex' ? '（同源推断）' : ''}` : ''}</b></span>
        <span class="oligo-stoich">${esc(mwPathZh)}</span>
        ${mwAdj ? `<span class="oligo-chips">${adjChip('X-ray', mwAdj.xray)}${adjChip('Cryo-EM', mwAdj.cryoem)}${adjChip('NMR', mwAdj.nmr)}</span>` : ''}
      </div>
      ${mwAdj ? `<p class="oligo-strip-note">${esc(mwAdj.note)}（分子量调整已计入 Cryo-EM 分数与综合评分；X-ray/NMR 不受增重影响${mwA.assemblyKda != null ? '；装配分子量已知时，聚集形式维度的 Cryo-EM 分量并入本维度计分（避免双重加分）' : ''}）</p>` : ''}
      ${mwA.homologSearchNote ? `<p class="oligo-strip-note">${esc(mwA.homologSearchNote)}</p>` : ''}
      ${mwA.complexes.length || mwHomologs.length || mwA.partners.some(p => p.kda != null) || mwA.conflicts.length ? `
      <details class="fold"><summary>增重路径明细（复合物结构 ${mwA.complexes.length} · 同源复合物 ${mwHomologs.length} · 互作伙伴 ${mwA.partners.filter(p => p.kda != null).length} · 目的比对 ${mwA.conflicts.length} 条）</summary>
        ${mwA.complexes.length ? `
        <p class="note"><b>已有复合物结构 — 组分总分子量统计</b>（RCSB 实体/装配口径）</p>
        <div class="tbl-wrap"><table class="tbl-data">
          <thead><tr><th style="width:86px">PDB</th><th style="width:150px">方法 · 分辨率</th><th>组分（+ 总分子量）</th><th style="width:110px">装配总 MW</th></tr></thead>
          <tbody>${mwA.complexes.map(c => `
            <tr>
              <td class="td-id"><a href="https://www.rcsb.org/structure/${c.pdbId}" target="_blank" rel="noopener">${c.pdbId}</a></td>
              <td>${esc(c.method.slice(0, 18))}${c.resolution != null ? ` · ${c.resolution}Å` : ''}</td>
              <td class="t-title">${c.components.map(x => `<span class="${x.isTarget ? 'mw-target' : 'mw-partner'}">${esc(x.name.slice(0, 34))} ~${x.kda} kDa</span>`).join(' + ')}<br><span class="mw-basis">${esc(c.note)}</span></td>
              <td><b>~${c.totalKda} kDa</b></td>
            </tr>`).join('')}</tbody>
        </table></div>` : ''}
        ${mwHomologs.length ? `
        <p class="note"><b>同源结构形成的大复合物（BLAST 扩展检索）</b>— 直接装配路径不足 50 kDa 时检索；同源亚基按靶点单体换算</p>
        <div class="tbl-wrap"><table class="tbl-data">
          <thead><tr><th style="width:86px">PDB</th><th style="width:64px">Identity</th><th style="width:132px">方法 · 分辨率</th><th>组分（同源装配口径）</th><th style="width:96px">同源装配</th><th style="width:96px">靶点换算</th></tr></thead>
          <tbody>${mwHomologs.map(h => `
            <tr>
              <td class="td-id"><a href="https://www.rcsb.org/structure/${h.pdbId}" target="_blank" rel="noopener">${h.pdbId}</a></td>
              <td><b>${Math.round(h.identity)}%</b></td>
              <td>${esc(h.method.slice(0, 16))}${h.resolution != null ? ` · ${h.resolution}Å` : ''}</td>
              <td class="t-title">${esc(h.componentSummary)}<br><span class="mw-basis">${esc(h.note)}</span></td>
              <td>~${h.totalKda} kDa</td>
              <td><b>~${h.estimatedKda} kDa</b></td>
            </tr>`).join('')}</tbody>
        </table></div>` : ''}
        ${(() => { const ps = mwA.partners.filter(p => p.kda != null); return ps.length ? `
        <p class="note"><b>UniProt 互作伙伴</b>（可作增重路径，按 1:1 估计；无结构先例，化学计量需 SEC-MALS 验证）</p>
        <ul class="mw-list">${ps.slice(0, 8).map(p => `<li><span class="mw-partner">${esc((p.geneName ?? p.proteinName ?? p.accession).slice(0, 40))}</span> <span class="mono">${esc(p.accession)}</span> — ${p.lengthAa} aa，~${p.kda} kDa${mwA.assemblyPath === 'partner' ? '（已按最大伙伴计入装配估计）' : ''}</li>`).join('')}</ul>` : '' })()}
        <p class="note"><b>技术增重工具箱</b>（无生物装配路径时的兜底策略；需评估开发周期）</p>
        <ul class="mw-list">${mwA.options.map(o => `<li><b>${esc(o.name)}</b>（${esc(o.addKda)}）— ${esc(o.note)}</li>`).join('')}</ul>
        ${mwA.conflicts.length ? `
        <p class="note"><b>与客户目的的比对</b>（加入的蛋白是否与目的冲突 — 契合 / 需注意 / 冲突）</p>
        <ul class="mw-list">${mwA.conflicts.map(c => `<li><span class="mw-conf-tag mw-${c.level}">${c.level === 'aligned' ? '契合' : c.level === 'caution' ? '需注意' : '冲突'}</span> ${esc(c.text)}</li>`).join('')}</ul>` : ''}
      </details>` : ''}
    </div>` : ''

  // v1.29：互作复合物证据条（无直接结构时；评分卡内嵌，不单独成章）
  const itxA = ctx.interaction
  const itxAdj = ctx.scores.interactionAdjust
  const itxBest = itxA?.complexes[0]
  const interactionStripHtml = itxA?.applicable && itxA.hasEvidence ? `
    <div class="oligo-strip itx-strip">
      <div class="oligo-strip-head">
        <span class="oligo-badge" style="background:${itxAdj?.level === 'curated' ? '#0f766e' : '#b45309'}">${itxAdj?.level === 'curated' ? 'Complex Portal' : 'IntAct 互作'}</span>
        <span class="oligo-strip-label">互作证据<b>${esc(itxBest ? `${itxBest.complexAc}${itxBest.assembly ? ` · ${itxBest.assembly}` : ''}` : 'binary 伙伴')}</b></span>
        ${itxAdj ? `<span class="oligo-chips">${adjChip('X-ray', itxAdj.xray)}${adjChip('Cryo-EM', itxAdj.cryoem)}${adjChip('NMR', itxAdj.nmr)}</span>` : ''}
      </div>
      <p class="oligo-strip-note">${esc(itxA.summary)}${itxAdj ? '（上述调整已计入对应方法分数与综合评分；curated 复合物接管 Cryo-EM 分子量分量时，分子量增重与聚集形式维度的 Cryo-EM 分量不再重复计分）' : ''}${itxA.complexes.length ? ' — 组分结构清单（共有结构/单独结构分类）见「PDB 结构清单」章节。' : ''}</p>
      ${itxA.notes.length ? `<details class="fold"><summary>互作证据要点与策略影响（${itxA.notes.length} 条）</summary><ul class="mw-list">${itxA.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul></details>` : ''}
    </div>` : ''

  const scoreHtml = `
  <div class="score-card">
    ${scoreBar('X-ray 结晶', ctx.scores.xray, scoreColor(ctx.scores.xray.score))}
    ${scoreBar('Cryo-EM', ctx.scores.cryoem, scoreColor(ctx.scores.cryoem.score))}
    ${scoreBar('NMR', ctx.scores.nmr, scoreColor(ctx.scores.nmr.score))}
    ${scoreBar('综合评估', ctx.scores.overall, scoreColor(ctx.scores.overall.score), 'row-overall')}
    <div class="score-rationale">
      <div>· X-ray：${esc(ctx.scores.rationale.xray)}</div>
      <div>· Cryo-EM：${esc(ctx.scores.rationale.cryoem)}</div>
      <div>· NMR：${esc(ctx.scores.rationale.nmr)}</div>
      <div>· 综合：${esc(ctx.scores.rationale.overall)}</div>
    </div>
    ${oligoStripHtml}
    ${mwStripHtml}
    ${interactionStripHtml}
  </div>`

  // ─── v1.28 核心结论速览（At a Glance）：关键结论前置，10 秒抓住要点 ──────
  const methodsRanked = [
    { label: 'X-ray 结晶', s: ctx.scores.xray },
    { label: 'Cryo-EM', s: ctx.scores.cryoem },
    { label: 'NMR', s: ctx.scores.nmr },
  ].sort((a, b) => b.s.score - a.s.score)
  const topM = methodsRanked[0]
  const secondM = methodsRanked[1]
  const methodTie = topM.s.score === secondM.s.score
  const recommendVal = methodTie ? `${topM.label} / ${secondM.label}` : topM.label
  const recommendSub = methodTie
    ? `两方法并列 ${topM.s.score}/10 — 按靶点特点与周期取舍`
    : `${topM.s.score}/10 · 备选 ${secondM.label} ${secondM.s.score}/10`

  const bestIdentity = ctx.blastHits.length ? Math.max(...ctx.blastHits.map(h => h.identity)) : null
  let blastTileVal: string
  let blastTileSub: string
  let blastTileWarn = false
  if (ctx.blastHits.length) {
    blastTileVal = `${ctx.blastHits.length} 个同源结构`
    blastTileSub = `最高 identity ${bestIdentity!.toFixed(0)}%${ctx.blastStatus?.provider === 'rcsb' ? ' · RCSB 检索' : ''}`
  } else if (ctx.blastStatus?.status === 'no-hits') {
    blastTileVal = '无显著同源命中'
    blastTileSub = '检索已完成 — 全新靶点，无先例可借鉴'
  } else if (ctx.blastStatus?.status === 'failed') {
    blastTileVal = '同源检索失败'
    blastTileSub = '本报告不含同源证据 — 建议重新评估'
    blastTileWarn = true
  } else if (ctx.blastStatus) {
    blastTileVal = '未单独检索'
    blastTileSub = describeBlastStatus(ctx.blastStatus).split('（')[0].slice(0, 30)
  } else {
    blastTileVal = '—'
    blastTileSub = '未记录检索状态'
  }

  const mwA2 = ctx.mwAugment
  let mwTileVal: string
  let mwTileSub: string
  if (mwA2?.applicable) {
    mwTileVal = mwA2.assemblyKda != null
      ? `单体 ~${mwA2.monomerKda} kDa → 装配 ~${mwA2.assemblyKda} kDa`
      : `单体 ~${mwA2.monomerKda} kDa（小分子量）`
    mwTileSub = mwA2.assemblyKda != null
      ? `${mwPathZh}${mwA2.assemblyPath === 'homolog-complex' ? ' — 需实验验证' : ''}`
      : '无生物装配增重路径 — 需技术增重'
  } else {
    mwTileVal = mwA2 ? `单体 ~${mwA2.monomerKda} kDa` : `${ctx.uniprot?.sequenceLength ?? ctx.sequence.length} aa`
    mwTileSub = '分子量处于常规适配区间'
  }

  // v1.29：互作复合物 tile（无直接结构且有证据时）
  const itxTile = ctx.interaction?.applicable && ctx.interaction.hasEvidence
    ? (() => {
        const best = ctx.interaction!.complexes[0]
        const val = best ? best.complexAc : 'binary 伙伴'
        const sub = best
          ? `${best.componentsWithStructure}/${best.components.length - 1} 组分有结构${best.sharedPdbTotal ? ` · 共有 ${best.sharedPdbTotal}` : ''}${best.assemblyKda != null ? ` · 装配 ~${best.assemblyKda} kDa` : ''}`
          : `${ctx.interaction!.binaryPartners.length} 个伙伴有结构`
        return `<div class="glance-tile"><div class="gt-label">互作复合物</div><div class="gt-value">${esc(val)}</div><div class="gt-sub">${esc(sub)} · ${best ? 'Complex Portal' : 'IntAct'}</div></div>`
      })()
    : ''

  const glanceHtml = `
  <section class="glance" id="glance" aria-label="核心结论速览">
    <div class="glance-kicker">Key Findings · 核心结论速览</div>
    <div class="glance-grid">
      <div class="glance-hero">
        <div class="glance-score" style="color:${scoreColor(ctx.scores.overall.score)}">${ctx.scores.overall.score}<span>/10</span></div>
        <div class="glance-hero-label">综合可行性 · ${esc(ctx.scores.overall.rating)}</div>
        <span class="glance-rating" style="background:${scoreColor(ctx.scores.overall.score)}">${esc(ctx.scores.overall.rating.split('·')[1] ?? ctx.scores.overall.rating)}</span>
      </div>
      <div class="glance-tiles">
        <div class="glance-tile"><div class="gt-label">推荐方法</div><div class="gt-value">${esc(recommendVal)}</div><div class="gt-sub">${esc(recommendSub)}</div></div>
        <div class="glance-tile ${ctx.directPdbs.length === 0 ? 'gt-warn' : ''}"><div class="gt-label">已有结构</div><div class="gt-value">${ctx.directPdbs.length > 0 ? `${ctx.directPdbs.length} 个` : '无（全新靶点）'}</div><div class="gt-sub">${ctx.directPdbs.length > 0 ? `X-ray ${methodStats.xrayCount} · Cryo-EM ${methodStats.cryoemCount} · NMR ${methodStats.nmrCount}${methodStats.bestResolution != null ? ` · 最佳 ${methodStats.bestResolution.toFixed(2)}Å` : ''}` : ctx.interaction?.hasEvidence ? '结构证据来自互作复合物组分（见互作复合物 tile）' : 'RCSB 无直接关联结构 — 依据同源与文献判断'}</div></div>
        ${itxTile}
        <div class="glance-tile ${blastTileWarn ? 'gt-warn' : ''}"><div class="gt-label">同源参考</div><div class="gt-value">${esc(blastTileVal)}</div><div class="gt-sub">${esc(blastTileSub)}</div></div>
        ${oligo ? `<div class="glance-tile"><div class="gt-label">聚集形式</div><div class="gt-value">${esc(oligo.label || oligoCategoryZh)}</div><div class="gt-sub">${esc(oligo.stoichiometry ? oligo.stoichiometry + ' · ' : '')}置信度${esc(oligoConfZh)}</div></div>` : ''}
        <div class="glance-tile"><div class="gt-label">分子量</div><div class="gt-value">${esc(mwTileVal)}</div><div class="gt-sub">${esc(mwTileSub)}</div></div>
        <div class="glance-tile"><div class="gt-label">结构覆盖率</div><div class="gt-value">${ctx.coverage ? ctx.coverage.coveragePercent + '%' : '—'}</div><div class="gt-sub">${ctx.coverage ? (ctx.gapText ? '存在未覆盖区间（见评分与结构章节）' : '已有结构覆盖完整') : '无覆盖率数据（PDBe 未返回）'}</div></div>
      </div>
    </div>
    <div class="glance-foot">推荐路线：${esc(topM.label)}为主${methodTie ? '' : `，${esc(secondM.label)}备选`} — 评分依据与增重/寡聚调整详见「可行性评分」章节，实验策略详见「评估分析」的推荐技术路线与实验方案建议。</div>
  </section>`

  // 实验图分组展示：gel / sec / other 各成小组，类型一目了然
  const figGroupDefs: Array<{ kind: 'gel' | 'sec' | 'other'; title: string; en: string }> = [
    { kind: 'gel', title: 'SDS-PAGE 胶图', en: 'SDS-PAGE' },
    { kind: 'sec', title: 'SEC 分子筛色谱图', en: 'SEC Profile' },
    { kind: 'other', title: '其他实验图', en: 'Others' },
  ]
  const vlmCount = embedded.filter(e => e.meta.vlmKind).length
  const figGroups = figGroupDefs
    .map(g => ({ ...g, items: embedded.filter(e => e.meta.kind === g.kind) }))
    .filter(g => g.items.length > 0)
  let figNo = 0
  const imagesHtml = embedded.length ? `
  <section class="sec" id="assets">
    <h2>${secHead(assetsNo, `客户提供的实验数据（${embedded.length} 张）`, `${figGroups.map(g => `${g.en} × ${g.items.length}`).join(' · ')}${vlmCount ? ' · AI 识别' : ''}`)}</h2>
    ${figGroups.map(g => `
    <h3 class="fig-group">${g.title}<span class="fig-group-count">${g.items.length} 张</span></h3>
    <div class="fig-grid">
    ${g.items.map(({ meta, dataUri }) => {
      figNo += 1
      return `
      <figure class="fig">
        ${dataUri
        ? `<img src="${dataUri}" alt="${esc(meta.caption)}" loading="lazy">`
        : `<div class="fig-missing">图片体积超出内嵌预算，请通过系统查看</div>`}
        <figcaption><span class="fig-tag fig-${meta.kind}">${meta.kind === 'gel' ? 'SDS-PAGE' : meta.kind === 'sec' ? 'SEC' : '图'}</span>${meta.vlmKind ? '<span class="fig-tag fig-ai">AI 视觉识别</span>' : ''}图 ${figNo}：${esc(meta.caption)}</figcaption>
      </figure>`
    }).join('')}
    </div>`).join('')}
  </section>` : ''

  const pdbCountHtml = `${ctx.directPdbs.length}${input.totalPdbFound > ctx.directPdbs.length ? ` / 检索命中 ${input.totalPdbFound}` : ''}`

  const afFigureHtml = input.alphafoldFigure ? `
      <figure class="af-fig">
        <img src="${input.alphafoldFigure.dataUri}" alt="AlphaFold 预测结构（pLDDT 着色）">
        <figcaption><b>AlphaFold 预测结构</b> · pLDDT 着色<br>${esc(input.alphafoldFigure.modelId)} · v${input.alphafoldFigure.version} · 平均 pLDDT ${input.alphafoldFigure.globalPlddt ?? '—'}<br><a href="https://alphafold.ebi.ac.uk/entry/${u ? u.uniprotId : ''}" target="_blank" rel="noopener">alphafold.ebi.ac.uk →</a></figcaption>
      </figure>` : ''

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;600;700;900&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;0,8..60,700;1,8..60,400&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<title>靶点结构解析可行性评估报告 — ${esc(proteinTitle)}</title>
<style>
  :root {
    --ink:#1c1917; --sub:#57534e; --faint:#a8a29e; --line:#e7e5e4; --hairline:#efedeb;
    --accent:#065f46; --accent-2:#047857; --accent-bg:#f0fdf7; --bg:#fcfcfb; --paper:#ffffff;
    --serif:"Source Serif 4","Noto Serif SC",Georgia,"Songti SC","STSong","SimSun","Times New Roman",serif;
    --mono:"JetBrains Mono",ui-monospace,"SF Mono",Menlo,Consolas,"Courier New",monospace;
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  html { -webkit-print-color-adjust:exact; print-color-adjust:exact; scroll-behavior:smooth; }
  [id] { scroll-margin-top:18px; }
  body { font-family:var(--serif); color:var(--ink); background:var(--bg); line-height:1.92; font-size:15px; letter-spacing:.006em; }
  .mono { font-family:var(--mono); }
  ::-webkit-scrollbar{width:10px;height:10px}
  ::-webkit-scrollbar-thumb{background:#d6d3d1;border-radius:99px;border:3px solid var(--paper)}
  ::-webkit-scrollbar-thumb:hover{background:#a8a29e}
  ::-webkit-scrollbar-track{background:transparent}
  html{scrollbar-width:thin;scrollbar-color:#d6d3d1 transparent}
  .page { max-width:920px; margin:0 auto; padding:56px 44px 72px; background:var(--paper); min-height:100vh; box-shadow:0 0 0 1px var(--hairline); }
  @media (max-width:640px){ .page{padding:28px 18px 40px} }
  @media print {
    body{background:#fff} .page{padding:0;max-width:none;box-shadow:none}
    .no-print{display:none!important} .sec{break-inside:avoid-page} .fig{break-inside:avoid}
    .glance{break-inside:avoid}
    table{break-inside:auto} tr{break-inside:avoid} details{display:block}
  }

  /* ── 报告封面头（期刊风双线）── */
  .rpt-head { padding-bottom:22px; margin-bottom:30px; border-bottom:1px solid var(--ink); position:relative; }
  .rpt-head::after { content:''; display:block; position:absolute; left:0; bottom:3px; width:100%; border-bottom:3px solid var(--ink); }
  .rpt-eyebrow { font-family:var(--mono); color:var(--accent); font-weight:600; font-size:10.5px; letter-spacing:2.4px; text-transform:uppercase; margin-bottom:14px; }
  h1.rpt-title { font-size:28px; line-height:1.4; margin-bottom:6px; font-weight:900; }
  .rpt-subtitle { font-size:13px; color:var(--sub); font-style:italic; margin-bottom:18px; }
  .meta-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:9px 22px; font-size:12.5px; color:var(--sub); }
  .meta-grid b { color:var(--ink); font-weight:600; margin-right:2px; }
  .meta-grid a { color:var(--accent-2); text-decoration:none; border-bottom:1px solid #a7f3d0; }
  .meta-grid a:hover { border-bottom-color:var(--accent-2); }
  .rpt-badges { margin-top:16px; display:flex; flex-wrap:wrap; gap:8px; }
  .badge { display:inline-block; padding:2px 11px; border-radius:3px; font-family:var(--mono); font-size:11px; font-weight:600; background:var(--accent-bg); color:var(--accent); border:1px solid #b8e6d2; }
  .badge.amber { background:#fffbeb; color:#92400e; border-color:#fde68a; }

  /* ── 目录 ── */
  .toc { border:1px solid var(--line); border-radius:6px; padding:16px 22px; margin-bottom:34px; font-size:13px; background:#fdfdfc; }
  .toc b { display:block; margin-bottom:8px; font-family:var(--mono); font-size:10px; letter-spacing:1.6px; color:var(--faint); text-transform:uppercase; }
  .toc ol { margin-left:20px; columns:2; column-gap:36px; }
  .toc li { margin:3px 0; break-inside:avoid; }
  .toc a { color:var(--ink); text-decoration:none; }
  .toc a:hover { color:var(--accent-2); }
  @media (max-width:640px){ .toc ol{columns:1} }

  /* ── v1.28 核心结论速览（At a Glance）── */
  .glance { border:1.5px solid var(--ink); border-radius:8px; margin:0 0 34px; background:#fff; overflow:hidden; }
  .glance-kicker { font-family:var(--mono); font-size:10px; letter-spacing:2.2px; text-transform:uppercase; color:var(--accent); padding:13px 20px 11px; font-weight:700; border-bottom:1px solid var(--line); background:linear-gradient(180deg,#ffffff,#f7fcf9); }
  .glance-grid { display:grid; grid-template-columns:200px 1fr; }
  .glance-hero { padding:18px 20px; border-right:1px solid var(--line); display:flex; flex-direction:column; justify-content:center; align-items:flex-start; background:#fbfdfc; }
  .glance-score { font-family:var(--mono); font-size:46px; font-weight:700; line-height:1; }
  .glance-score span { font-size:15px; color:var(--faint); font-weight:400; }
  .glance-hero-label { font-size:12px; color:var(--sub); margin-top:8px; }
  .glance-rating { display:inline-block; margin-top:9px; padding:2px 12px; border-radius:3px; font-size:12px; font-weight:700; color:#fff; letter-spacing:1px; }
  .glance-tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(158px,1fr)); }
  .glance-tile { padding:13px 16px 11px; border-right:1px solid var(--hairline); border-bottom:1px solid var(--hairline); min-width:0; }
  .glance-tile:nth-child(3n) { border-right:none; }
  .glance-tile.gt-warn { background:#fffbeb; }
  .glance-tile.gt-warn .gt-value { color:#b45309; }
  .gt-label { font-family:var(--mono); font-size:9.5px; letter-spacing:1.4px; text-transform:uppercase; color:var(--faint); font-weight:600; }
  .gt-value { font-size:14px; font-weight:700; margin-top:4px; line-height:1.5; overflow-wrap:anywhere; }
  .gt-sub { font-size:11px; color:var(--sub); margin-top:3px; line-height:1.55; }
  .glance-foot { padding:10px 20px; border-top:1px dashed var(--line); font-size:12px; color:var(--sub); background:#fbfdfc; line-height:1.8; }
  @media (max-width:680px){
    .glance-grid { grid-template-columns:1fr; }
    .glance-hero { border-right:none; border-bottom:1px solid var(--line); flex-direction:row; align-items:center; gap:16px; }
    .glance-score { font-size:36px; }
    .glance-tile { border-right:none; border-bottom:1px solid var(--hairline); }
  }

  /* ── v1.28 回顶部 ── */
  .backtop { position:fixed; right:26px; bottom:26px; width:42px; height:42px; border-radius:50%; background:var(--ink); color:#fff; display:flex; align-items:center; justify-content:center; font-size:17px; text-decoration:none; box-shadow:0 4px 14px rgba(0,0,0,.2); opacity:0; pointer-events:none; transition:opacity .25s, background .2s; z-index:50; }
  .backtop.show { opacity:1; pointer-events:auto; }
  .backtop:hover { background:var(--accent-2); }

  /* ── v1.28 空态/警示块 ── */
  .callout { border-radius:6px; padding:14px 18px; margin:12px 0; font-size:13px; line-height:1.95; border:1px solid; text-align:justify; }
  .callout b { display:block; margin-bottom:5px; font-size:13.5px; }
  .callout-amber { background:#fffbeb; border-color:#fde68a; color:#92400e; }

  /* ── 章节（v1.28：编号方块 + 标题 + 英文标签，结构分明）── */
  .sec { margin-bottom:40px; }
  .sec > h2 { font-size:19px; padding-bottom:10px; margin-bottom:16px; border-bottom:2px solid var(--ink); font-weight:700; display:flex; align-items:center; gap:12px; }
  .sec-no { flex:none; width:32px; height:32px; background:var(--ink); color:#fff; display:inline-flex; align-items:center; justify-content:center; font-size:15px; font-weight:700; border-radius:5px; }
  .sec-title { min-width:0; }
  .sec > h2 .sec-en { margin-left:auto; font-family:var(--mono); font-size:10px; font-weight:500; letter-spacing:1.8px; color:var(--faint); text-transform:uppercase; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .sec h3 { font-size:15.5px; margin:20px 0 8px; color:#064e3b; font-weight:700; }
  .sec h4 { font-size:14px; margin:16px 0 6px; font-weight:700; border-left:3px solid #a7f3d0; padding-left:10px; }
  .sec h5, .sec h6 { font-size:13.5px; margin:12px 0 5px; font-weight:700; }
  /* v1.30：LLM 章节层次强化 — 子章节编号徽章 + 分隔线 + 摘要导语 + 强调色 */
  #llm { counter-reset: llmch; }
  #llm h3 { counter-increment: llmch; display:flex; align-items:center; gap:11px; margin:34px 0 12px; padding-bottom:9px; border-bottom:1px solid var(--line); }
  #llm h3::before { content:"1." counter(llmch); flex:none; font-family:var(--mono); font-size:11px; font-weight:700; color:#fff; background:var(--accent-2); border-radius:4px; padding:2px 9px; letter-spacing:.5px; line-height:1.5; }
  #llm h3:first-child { margin-top:6px; }
  /* 执行摘要首段 = 全报告导语 — 大字号 + 主色竖线，突出总体结论 */
  #llm h3:first-of-type + p { font-size:15.5px; line-height:2.05; color:var(--ink); border-left:3px solid var(--accent-2); padding:2px 0 2px 15px; margin:12px 0 14px; }
  #llm p { margin:9px 0; }
  #llm ul li::marker, #llm ol li::marker { color:var(--accent-2); font-family:var(--mono); font-weight:600; }
  #llm strong { color:#064e3b; }
  #llm blockquote { border-left:3px solid #a7f3d0; background:#f7fdfb; }
  #llm .tbl-wrap { margin:16px 0 12px; }
  p { margin:8px 0; text-align:justify; }
  ul { margin:8px 0 8px 22px; }
  li { margin:4px 0; }
  blockquote { border-left:3px solid #d6d3d1; padding:5px 14px; margin:12px 0; color:var(--sub); background:#fafaf9; border-radius:0 4px 4px 0; font-size:13.5px; }
  strong { font-weight:700; }
  em { font-style:italic; }
  code { font-family:var(--mono); background:#f5f5f4; padding:1px 5px; border-radius:3px; font-size:.88em; }

  /* ── 表格 ── */
  .tbl-wrap { overflow-x:auto; margin:12px 0 6px; }
  table { width:100%; border-collapse:collapse; font-size:12.5px; font-family:var(--serif); }
  /* 数据表（PDB/BLAST）：固定列宽防长串挤压重叠；窄屏由 .tbl-wrap 横向滚动 */
  table.tbl-data { table-layout:fixed; min-width:856px; }
  table.tbl-blast { min-width:740px; }
  th { background:#f7f7f5; text-align:left; font-size:10px; letter-spacing:1px; text-transform:uppercase; color:var(--sub); font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  th.num { text-align:right; }
  th, td { border-top:1px solid var(--line); border-bottom:1px solid var(--line); padding:6px 8px; vertical-align:top; }
  thead th { border-top:none; border-bottom:1.5px solid #d6d3d1; }
  tbody tr:last-child td { border-bottom:none; }
  tbody tr:nth-child(even) td { background:#fafaf8; }
  tbody tr:hover td { background:#f5f5f4; }
  td { overflow-wrap:anywhere; }
  td.num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; font-family:var(--mono); }
  td.td-id a, .t-nowrap { white-space:nowrap; }
  td.td-id { font-family:var(--mono); }
  .t-title, .t-desc { font-family:var(--serif); overflow-wrap:break-word; }
  .t-lig { font-size:11px; overflow-wrap:anywhere; }
  .t-journal { font-size:11px; }
  .t-rng { font-family:var(--mono); font-size:11px; color:var(--sub); overflow-wrap:anywhere; }
  .lig-more { color:var(--faint); white-space:nowrap; }
  table a { color:var(--accent-2); text-decoration:none; border-bottom:1px solid #c7ece0; }
  table a:hover { border-bottom-color:var(--accent-2); }
  .lit-dot { display:inline-block; width:4px; height:4px; border-radius:99px; background:var(--accent-2); margin-left:4px; vertical-align:2px; }
  .mth { display:inline-block; padding:0 7px; border-radius:3px; font-size:10.5px; font-weight:600; white-space:nowrap; }
  .mth-xray { background:#ecfdf5; color:#065f46; }
  .mth-cryoem { background:#fef3c7; color:#92400e; }
  .mth-nmr { background:#f5f3ff; color:#5b21b6; }
  .mth-other { background:#f5f5f4; color:var(--sub); }

  /* ── 折叠区（details）── */
  details.fold { margin:2px 0 10px; border-top:1px dashed #d6d3d1; }
  details.fold summary { list-style:none; cursor:pointer; padding:9px 4px; font-family:var(--mono); font-size:11px; letter-spacing:.6px; color:var(--accent-2); user-select:none; }
  details.fold summary::-webkit-details-marker { display:none; }
  details.fold summary::before { content:'＋ '; font-family:var(--mono); }
  details.fold[open] summary::before { content:'－ '; }
  details.fold summary:hover { color:var(--accent); }

  /* ── 评分卡 ── */
  .score-card { background:#fdfdfc; border:1px solid var(--line); border-radius:6px; padding:18px 22px; margin:14px 0 10px; }
  .score-row { display:grid; grid-template-columns:96px 1fr 64px 110px; gap:14px; align-items:center; margin:10px 0; }
  .score-label { font-weight:700; font-size:13px; }
  .score-track { height:8px; border-radius:99px; background:#eceae6; overflow:hidden; }
  .score-fill { height:100%; border-radius:99px; }
  .score-num { font-family:var(--mono); font-size:16px; font-weight:700; text-align:right; font-variant-numeric:tabular-nums; }
  .score-max { color:var(--faint); font-size:11px; font-weight:400; }
  .score-rating { font-size:12px; color:var(--sub); text-align:right; font-family:var(--mono); }
  @media (max-width:560px){
    .score-card{ padding:14px 16px; }
    .score-row{ grid-template-columns:1fr auto; gap:5px 12px; }
    .score-label{ grid-column:1; grid-row:1; }
    .score-num{ grid-column:2; grid-row:1; }
    .score-track{ grid-column:1 / -1; grid-row:2; }
    .score-rating{ grid-column:1 / -1; grid-row:3; text-align:left; }
  }
  .score-rationale { margin-top:14px; padding-top:12px; border-top:1px dashed var(--line); font-size:12.5px; color:var(--sub); line-height:2; }
  /* v1.28：综合分行强调（突出关键信息）*/
  .score-row.row-overall { background:var(--accent-bg); border:1px solid #b8e6d2; border-radius:6px; padding:10px 12px; margin:16px -12px 4px; }
  .score-row.row-overall .score-label { color:var(--accent); font-size:14px; }
  .score-row.row-overall .score-num { font-size:19px; }
  .score-row.row-overall .score-track { height:10px; }

  /* ── 聚集形式（评分卡内嵌，v1.25）── */
  .oligo-card { background:#fdfdfc; border:1px solid var(--line); border-radius:6px; padding:16px 20px; margin:14px 0; }
  .oligo-head { display:flex; flex-wrap:wrap; align-items:center; gap:10px; margin-bottom:10px; }
  .oligo-badge { color:#fff; font-size:12px; font-weight:700; padding:3px 12px; border-radius:3px; letter-spacing:1px; }
  .oligo-stoich { font-family:var(--mono); font-size:12.5px; color:var(--ink); background:#f5f5f4; border:1px solid var(--line); padding:2px 10px; border-radius:3px; }
  .oligo-conf { font-size:12px; color:var(--sub); margin-left:auto; }
  .oligo-summary { margin:6px 0 0; font-size:13.5px; }
  .oligo-strip { margin-top:14px; padding-top:12px; border-top:1px dashed var(--line); }
  .oligo-strip-head { display:flex; flex-wrap:wrap; align-items:center; gap:8px 10px; }
  .oligo-strip-label { font-size:12.5px; color:var(--sub); }
  .oligo-strip-label b { color:var(--ink); font-weight:700; margin: 0 2px; }
  .oligo-chips { display:inline-flex; flex-wrap:wrap; gap:6px; }
  .adj-chip { font-family:var(--mono); font-size:11px; font-weight:700; padding:1px 9px; border-radius:99px; white-space:nowrap; }
  .adj-pos { background:#ecfdf5; color:#047857; border:1px solid #a7f3d0; }
  .adj-neg { background:#fef2f2; color:#b91c1c; border:1px solid #fecaca; }
  .adj-zero { background:#f5f5f4; color:var(--sub); border:1px solid var(--line); }
  .oligo-strip-note { font-size:12.5px; color:var(--sub); margin:8px 0 0; }
  .note { font-size:12px; color:var(--sub); margin-top:6px; }

  /* ── v1.26 分子量增重条（沿用聚集形式条布局，复用 .oligo-strip 类）── */
  .mw-target { background:#ecfdf5; color:#047857; border:1px solid #a7f3d0; border-radius:3px; padding:0 5px; font-weight:600; }
  .mw-partner { background:#fffbeb; color:#92400e; border:1px solid #fde68a; border-radius:3px; padding:0 5px; font-weight:600; }
  .mw-basis { font-family:var(--mono); font-size:10.5px; color:var(--faint); }
  ul.mw-list { list-style:none; margin:2px 0 10px; }
  ul.mw-list li { position:relative; padding:5px 0 5px 16px; border-bottom:1px solid var(--hairline); font-size:12.5px; color:var(--sub); line-height:1.7; }
  ul.mw-list li:last-child { border-bottom:none; }
  ul.mw-list li::before { content:'·'; position:absolute; left:4px; color:var(--accent-2); font-weight:700; }
  .mw-conf-tag { display:inline-block; min-width:44px; text-align:center; font-family:var(--mono); font-size:10.5px; font-weight:700; border-radius:3px; padding:0 6px; margin-right:6px; vertical-align:1px; }
  .mw-aligned { background:#ecfdf5; color:#047857; border:1px solid #a7f3d0; }
  .mw-caution { background:#fffbeb; color:#b45309; border:1px solid #fde68a; }
  .mw-conflict { background:#fef2f2; color:#b91c1c; border:1px solid #fecaca; }

  /* ── v1.30/v1.31 互作复合物结构清单（共有结构突出 / 单独结构折叠，全量表列）── */
  .itx-h3 { margin:22px 0 6px !important; display:flex; align-items:baseline; gap:10px; }
  .itx-h3-sub { font-family:var(--mono); font-size:10.5px; font-weight:500; letter-spacing:1px; color:var(--faint); }
  .cx-card { background:#fdfdfc; border:1px solid var(--line); border-radius:6px; padding:16px 20px; margin:14px 0; }
  .cx-head { display:flex; flex-wrap:wrap; align-items:center; gap:8px 10px; margin-bottom:12px; }
  .cx-badge { flex:none; font-family:var(--mono); font-size:10.5px; font-weight:700; letter-spacing:1px; color:#fff; background:#0f766e; border-radius:3px; padding:2px 10px; }
  .cx-name { font-size:14.5px; min-width:0; overflow-wrap:anywhere; }
  .cx-name a { color:var(--accent-2); text-decoration:none; border-bottom:1px solid #c7ece0; }
  .cx-name a:hover { border-bottom-color:var(--accent-2); }
  .cx-chip { font-family:var(--mono); font-size:11px; color:var(--sub); background:#f5f5f4; border:1px solid var(--line); border-radius:3px; padding:1px 9px; white-space:nowrap; }
  .cx-chip.cx-ok { background:#ecfdf5; color:#047857; border-color:#a7f3d0; }
  .cx-chip.cx-chip-shared { background:#065f46; color:#fff; border-color:#065f46; font-weight:700; }
  table.tbl-cx { min-width:660px; }
  .tbl-cx tr.cx-target td { background:#ecfdf5; border-top:1px solid #d1e9dd; border-bottom:1px solid #d1e9dd; }
  .cx-desc { font-family:var(--serif); font-size:11px; color:var(--faint); }
  .cx-res { font-family:var(--mono); font-size:10.5px; color:var(--faint); margin-left:2px; }
  /* 共有结构：绿色面板突出（组装先例）— v1.31 全量表列 */
  .cx-shared { border:1px solid #b8e6d2; background:linear-gradient(180deg,#f5fcf8,#ffffff); border-radius:6px; padding:12px 18px 10px; margin:14px 0 8px; }
  .cx-shared-head { display:flex; flex-wrap:wrap; align-items:baseline; gap:6px 10px; font-size:13.5px; font-weight:700; color:#065f46; margin-bottom:4px; }
  .cx-shared-ico { color:var(--accent-2); font-size:14px; }
  .cx-shared-head b { font-family:var(--mono); font-size:15px; color:#047857; }
  .cx-shared-sub { flex-basis:100%; font-size:11px; font-weight:400; color:var(--sub); line-height:1.7; }
  .cx-shared .tbl-wrap, .cx-solo-comp .tbl-wrap { margin:6px 0 4px; }
  /* v1.31 紧凑版式：9 列在报告页宽（.cx-card/.cx-shared 嵌套后 ~752px）内免横向滚动 */
  table.tbl-cx-pdb { min-width:748px; font-size:11.5px; }
  .tbl-cx-pdb th, .tbl-cx-pdb td { padding:5px 6px; }
  .tbl-cx-pdb .t-title { font-size:11px; }
  .tbl-cx-pdb .t-journal { font-size:10.5px; }
  .tbl-cx-pdb td.num { font-size:10px; }
  .tbl-cx-pdb .mth { padding:0 4px; font-size:9.5px; }
  .csi-comps { font-size:11px; color:#065f46; background:#ecfdf5; border:1px solid #a7f3d0; border-radius:3px; padding:0 6px; white-space:nowrap; display:inline-block; max-width:100%; }
  .csi-comps i { font-style:normal; font-family:var(--mono); font-size:10px; color:#047857; margin-left:4px; }
  .csi-extra { display:inline-block; font-size:10.5px; color:#92400e; background:#fffbeb; border:1px dashed #fde68a; border-radius:3px; padding:0 6px; margin:1px 3px 1px 0; white-space:nowrap; }
  .csi-extra-more { font-family:var(--mono); font-size:10px; color:#b45309; white-space:nowrap; }
  .t-extras { overflow-wrap:anywhere; }
  .t-pmid { font-family:var(--mono); font-size:10.5px; white-space:nowrap; }
  .t-pmid-none { color:var(--faint); }
  /* 单独结构：按组分分组（默认折叠，展开全量表） */
  .cx-solo-fold { margin-top:10px; }
  .cx-solo-comp { margin:10px 0 14px; padding:10px 14px 8px; border:1px solid var(--hairline); border-radius:6px; background:#fdfdfc; }
  .cx-solo-head { font-size:12.5px; color:var(--ink); margin-bottom:2px; }
  .cx-solo-head .mono { font-size:10.5px; color:var(--faint); }
  .cx-solo-sub { font-size:11px; color:var(--faint); }

  /* ── 文献 ── */
  ol.lit-list { list-style:none; }
  .lit-item { display:flex; gap:14px; padding:12px 2px; border-bottom:1px solid var(--hairline); }
  .lit-item:last-child { border-bottom:none; }
  .lit-no { font-family:var(--mono); font-size:11px; color:var(--faint); min-width:22px; text-align:right; padding-top:3px; }
  .lit-title a { color:var(--ink); font-weight:600; text-decoration:none; font-size:13.5px; }
  .lit-title a:hover { color:var(--accent-2); }
  .lit-src { display:inline-block; margin-left:8px; padding:0 7px; border-radius:3px; font-family:var(--mono); font-size:9.5px; font-weight:600; letter-spacing:1px; background:var(--accent-bg); color:var(--accent); border:1px solid #c7ece0; vertical-align:2px; }
  .lit-meta { font-family:var(--mono); font-size:11.5px; color:var(--sub); margin:3px 0 2px; }
  .lit-meta a { color:var(--accent-2); text-decoration:none; }
  .lit-abs { font-size:12.5px; color:var(--sub); margin-top:4px; text-align:justify; }
  .lit-pdbs { display:flex; flex-wrap:wrap; align-items:center; gap:5px; margin-top:6px; }
  .lit-pdbs-label { font-family:var(--mono); font-size:9.5px; letter-spacing:1.2px; text-transform:uppercase; color:var(--faint); margin-right:2px; }
  .lit-pdbs a { font-family:var(--mono); font-size:10.5px; font-weight:600; color:var(--accent); background:var(--accent-bg); border:1px solid #c7ece0; border-radius:3px; padding:0 6px; text-decoration:none; }
  .lit-pdbs a:hover { background:#d9f5e8; }

  /* ── 图 ── */
  .fig-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:20px; margin-top:6px; }
  .fig { text-align:center; }
  .fig img { max-width:100%; max-height:420px; border:1px solid var(--line); border-radius:4px; background:#fff; padding:8px; }
  .fig-missing { padding:40px; background:#fafaf9; border:1px dashed var(--line); border-radius:4px; color:var(--sub); }
  .fig figcaption { font-size:12.5px; color:var(--sub); margin-top:8px; text-align:left; }
  .fig-tag { display:inline-block; padding:0 7px; border-radius:3px; font-family:var(--mono); font-size:10px; font-weight:600; margin-right:6px; }
  .fig-gel { background:#ecfdf5; color:#065f46; }
  .fig-sec { background:#fef3c7; color:#92400e; }
  .fig-other { background:#f5f5f4; color:var(--sub); }
  .fig-ai { background:#f0fdfa; color:#0f766e; border:1px solid #99f6e4; }
  .fig-group { margin:18px 0 4px !important; font-size:14.5px !important; color:#064e3b; display:flex; align-items:baseline; gap:8px; }
  .fig-group-count { font-family:var(--mono); font-size:10.5px; font-weight:500; color:var(--faint); letter-spacing:1px; }

  /* ── 报告头图与元信息并排（v2.0 AlphaFold）── */
  .rpt-headflex { display:flex; gap:28px; align-items:flex-start; }
  .rpt-headflex .meta-grid { flex:1 1 auto; }
  .af-fig { flex:0 0 300px; margin:0; text-align:center; align-self:flex-start; }
  .af-fig img { display:block; width:300px; max-width:100%; height:auto; border:1px solid var(--line); border-radius:6px; background:#fff; padding:6px; box-shadow:0 1px 3px rgba(28,25,23,.06); }
  .af-fig figcaption { margin-top:9px; font-size:10.5px; line-height:1.75; color:var(--sub); font-family:var(--mono); }
  .af-fig figcaption b { color:var(--ink); font-weight:600; }
  .af-fig figcaption a { color:var(--accent-2); text-decoration:none; border-bottom:1px solid #c7ece0; }
  @media (max-width:720px){ .rpt-headflex{flex-direction:column} .af-fig{flex-basis:auto; width:100%; max-width:380px; margin:4px auto 0} }

  /* ── 配体卡（v2.0）── */
  .lig-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(340px,1fr)); gap:14px; margin-top:8px; }
  .lig-card { background:#fdfdfc; border:1px solid var(--line); border-radius:6px; padding:14px 18px; break-inside:avoid; }
  .lig-fail { border-style:dashed; opacity:.78; }
  .lig-head { display:flex; flex-wrap:wrap; align-items:baseline; gap:8px 10px; }
  .lig-id { font-family:var(--mono); font-size:14.5px; font-weight:700; color:#065f46; background:var(--accent-bg); border:1px solid #b8e6d2; border-radius:4px; padding:1px 10px; letter-spacing:.5px; }
  .lig-id-fail { color:#92400e; background:#fffbeb; border-color:#fde68a; }
  .lig-name { font-size:13px; font-weight:600; color:var(--ink); overflow-wrap:anywhere; min-width:120px; }
  .lig-src { margin-left:auto; font-family:var(--mono); font-size:10px; color:var(--faint); letter-spacing:.4px; }
  .lig-meta { display:flex; flex-wrap:wrap; gap:4px 16px; margin-top:9px; font-size:11.5px; color:var(--sub); }
  .lig-meta b { color:var(--ink); font-weight:600; font-variant-numeric:tabular-nums; }
  .lig-pdbs { display:flex; flex-wrap:wrap; gap:6px; margin-top:10px; padding-top:10px; border-top:1px dashed var(--hairline); }
  .lig-pdbs a { font-family:var(--mono); font-size:10.5px; font-weight:600; color:var(--accent); background:var(--accent-bg); border:1px solid #c7ece0; border-radius:3px; padding:1px 8px; text-decoration:none; white-space:nowrap; }
  .lig-pdbs a i { font-style:normal; color:var(--faint); font-weight:400; margin-left:3px; }
  .lig-pdbs a.lig-also { background:#e0faf1; border-color:#71cdb2; color:#04503c; }
  .lig-pdbs a:hover { background:#d9f5e8; }
  .lig-more { align-self:center; font-family:var(--mono); font-size:10.5px; color:var(--faint); }
  .lig-none { font-size:12px; color:var(--faint); border-top:1px dashed var(--hairline); margin-top:10px; padding-top:8px; }

  /* ── 页脚 ── */
  .rpt-foot { margin-top:48px; padding-top:18px; border-top:1px solid var(--ink); font-size:11.5px; color:var(--sub); line-height:2; font-family:var(--mono); }
  .warn-box { background:#fffbeb; border:1px solid #fde68a; color:#92400e; border-radius:4px; padding:12px 16px; font-size:12.5px; margin:14px 0; }
</style>
</head>
<body>
<div class="page" id="top">

  <header class="rpt-head">
    <div class="rpt-eyebrow">TargetEval · Structure Feasibility Report</div>
    <h1 class="rpt-title">${esc(proteinTitle)}</h1>
    <div class="rpt-subtitle">蛋白靶点结构解析可行性评估报告</div>
    <div class="rpt-headflex">
    <div class="meta-grid">
      <div><b>UniProt</b> ${u ? `<a href="https://www.uniprot.org/uniprotkb/${u.uniprotId}" target="_blank" rel="noopener">${u.uniprotId}</a>（${esc(u.entryName)}）` : '—（序列直接输入）'}</div>
      <div><b>蛋白名称</b> ${esc(u?.proteinName ?? '—')}</div>
      <div><b>基因</b> ${esc(geneStr)}</div>
      <div><b>物种</b> ${esc(u?.organism ?? '—')}</div>
      <div><b>序列长度</b> ${u ? u.sequenceLength + ' aa' : ctx.sequence ? ctx.sequence.length + ' aa' : '—'}</div>
      <div><b>结构证据</b> 直接结构 ${pdbCountHtml} · 同源 ${ctx.blastHits.length} 个 · 文献 ${ctx.literature.length} 篇${linkedLitCount ? `（${linkedLitCount} 篇与结构关联）` : ''}</div>
      ${cmp ? `<div><b>客户构建</b> ${constructHtml}</div>` : ''}
      ${ctx.batchNote ? `<div><b>批次关系</b> <span style="color:#92400e">${esc(ctx.batchNote.slice(0, 90))}${ctx.batchNote.length > 90 ? '…' : ''}</span></div>` : ''}
      <div><b>分析引擎</b> ${esc(input.engineSummary || '—')}</div>
      <div><b>报告日期</b> ${dateStr}</div>
    </div>
    ${afFigureHtml}
    </div>
    <div class="rpt-badges">
      <span class="badge">数据源：UniProt · RCSB · PDBe${blastRan ? (ctx.blastStatus?.provider === 'rcsb' ? ' · RCSB 序列检索' : ' · BLAST') : ''}${ctx.literature.length ? ' · PubMed' : ''}</span>
      ${input.llmOk ? '<span class="badge">LLM 分析：已完成</span>' : '<span class="badge amber">LLM 分析：失败（见数据区块）</span>'}
    </div>
  </header>

  ${glanceHtml}

  <nav class="toc">
    <b>Contents · 目录</b>
    <ol>
      <li><a href="#llm">评估分析（摘要 / 目标可行性 / 研究全景 / 实验策略）</a></li>
      ${hasInsights ? '<li><a href="#insights">客户评估表要点</a></li>' : ''}
      <li><a href="#scores">可行性评分（含聚集形式与分子量调整）</a></li>
      <li><a href="#pdbs">PDB 结构清单</a></li>
      ${ligandSecHtml ? '<li><a href="#ligands">配体研究数据</a></li>' : ''}
      ${showBlastSec ? '<li><a href="#blast">BLAST 同源结构</a></li>' : ''}
      ${ctx.literature.length ? '<li><a href="#literature">关键文献</a></li>' : ''}
      ${embedded.length ? '<li><a href="#assets">客户实验数据（评估表）</a></li>' : ''}
    </ol>
  </nav>

  ${input.llmOk ? '' : `<div class="warn-box">LLM 分析生成失败（${esc(input.llmErrors.join('；')) || '未知原因'}）。以下为系统收集的确定性数据与评估表 AI 解析要点，可稍后重试生成。</div>`}

  <section class="sec" id="llm">
    <h2>${secHead(llmNo, '评估分析', 'Analysis')}</h2>
    ${renderMarkdown(llmMarkdown || '（LLM 分析不可用 — 未能生成，请参考下方数据区块与评估表要点）', 1)}
  </section>

  ${ctx.insights ? (() => {
    const i = ctx.insights!
    if (!hasInsights) return ''
    return `
  <section class="sec" id="insights">
    <h2>${secHead(insightsNo, '客户评估表要点', 'Form Insights')}</h2>
    <p class="note">由 AI 从上传的评估表中结构化提取的关键要点 — 供比对 LLM 分析的复述是否忠于原始输入。</p>
    ${i.goals?.length ? `<h3>客户目标</h3><ul>${i.goals.map(g => `<li>${esc(g)}</li>`).join('')}</ul>` : ''}
    ${i.scientificQuestions?.length ? `<h3>待解决科学问题</h3><ol>${i.scientificQuestions.map(q => `<li>${esc(q)}</li>`).join('')}</ol>` : ''}
    ${i.experimentalSummary ? `<h3>实验数据要点</h3><blockquote>${esc(i.experimentalSummary)}</blockquote>` : ''}
    ${i.sequenceNotes ? `<h3>构建 / 序列说明</h3><blockquote>${esc(i.sequenceNotes)}</blockquote>` : ''}
    ${i.homologs ? `<h3>同源 / 参考信息</h3><blockquote>${esc(i.homologs)}</blockquote>` : ''}
    ${i.keyConcerns?.length ? `<h3>风险关注点</h3><ul>${i.keyConcerns.map(c => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
  </section>`
  })() : ''}

  <section class="sec" id="scores">
    <h2>${secHead(scoresNo, '可行性评分', 'Scores')}</h2>
    ${scoreHtml}
    <p class="note">评分由系统规则计算（1-10）：基础分（序列长度/跨膜特征/已有结构先例/结构域柔性）经舍入后叠加 BLAST 同源加成、蛋白聚集形式（寡聚态）与分子量增重调整（调整值见评分卡内明细）——两步调整均为整数，直接体现在最终分。评分数值仅供参考，最终可行性需结合实验条件判断；聚集形式判定的证据链与策略影响在评估分析章节中展开。</p>
  </section>

  <section class="sec" id="pdbs">
    <h2>${secHead(pdbsNo, 'PDB 结构清单', ctx.directPdbs.length ? `Structures · ${ctx.directPdbs.length}` : (ctx.interaction?.hasEvidence ? 'Structures · 互作组分证据' : 'Structures · 0'))}</h2>
    ${ctx.directPdbs.length ? `<p class="note">按分辨率升序排列；点击 PDB ID 跳转 RCSB 查看详情；「文献」列带绿点表示与本页文献章节互链。</p>${pdbTableHtml(ctx.directPdbs, PDB_PREVIEW, 150, litByPmid)}` +
      (input.totalPdbFound > 150 ? `<p class="note">共检索命中 ${input.totalPdbFound} 个结构，表中展示前 150 个（按分辨率排序）。</p>`
      : (input.totalPdbFound > ctx.directPdbs.length ? `<p class="note">共检索命中 ${input.totalPdbFound} 个结构，表中展示详情完整的前 ${ctx.directPdbs.length} 个。</p>` : ''))
    : `<div class="callout callout-amber"><b>暂无直接关联的 PDB 结构 — 全新结构靶点</b>该靶点（或该 UniProt）在 RCSB 无直接关联结构条目${ctx.interaction?.hasEvidence ? '，但存在互作复合物证据 — 下方列出其复合物其他组分的结构清单（共有结构突出显示、单独结构默认折叠），作为组装路线与构建边界设计的评估依据' : '，结构可行性判断主要依据同源结构先例（见 BLAST 章节）与文献证据'}；构建边界与实验策略需从零设计，风险与周期相应增加。</div>${interactionEvidenceHtml(ctx.interaction)}`}
  </section>

  ${ligandSecHtml}

  ${showBlastSec ? `
  <section class="sec" id="blast">
    <h2>${secHead(blastNo, 'BLAST 同源结构', `Homologs · ${ctx.blastHits.length}`)}</h2>
    ${ctx.blastHits.length ? `<p class="note">按 identity 降序排列（已排除直接结构重复项）；同源结构可用作分子置换模板 / Cryo-EM 初始模型 / 域边界参考。</p>${ctx.blastStatus?.provider === 'rcsb' ? '<p class="note">NCBI BLAST 队列拥堵/故障，本章节同源结构经 RCSB 序列检索（mmseqs2）获得，命中含一致性/E 值/覆盖度，与 BLAST 同源结构等效。</p>' : ''}<div class="tbl-wrap"><table class="tbl-data tbl-blast">
      <colgroup>
        <col style="width:74px"><col><col style="width:78px"><col style="width:88px">
        <col style="width:74px"><col style="width:104px"><col style="width:74px"><col style="width:92px">
      </colgroup>
      <thead><tr><th>PDB ID</th><th>描述</th><th class="num">Identity</th><th class="num">E-value</th><th class="num">覆盖范围</th><th>方法</th><th class="num">分辨率 (Å)</th><th>文献</th></tr></thead>
      <tbody>${blastRowsHtml(ctx.blastHits)}</tbody>
    </table></div>`
    : ctx.blastStatus?.status === 'failed'
      ? `<div class="callout callout-amber"><b>同源检索失败 — 本报告不含同源结构证据</b>${esc(describeBlastStatus(ctx.blastStatus))}。本报告结论主要基于直接结构与文献证据；同源先例缺失可能低估或高估可行性，建议重新评估补齐同源证据。</div>`
      : `<p class="note">${esc(describeBlastStatus(ctx.blastStatus))}。同源结构证据在本报告中缺位，结论主要基于直接结构与文献证据；如需同源检索可重新评估并勾选「强制 BLAST」。</p>`}
  </section>` : ''}

  ${ctx.literature.length ? `
  <section class="sec" id="literature">
    <h2>${secHead(litNo, '关键文献', `References · ${ctx.literature.length}${linkedLitCount ? ` · ${linkedLitCount} linked` : ''}`)}</h2>
    <p class="note">结构解析文献（与 PDB 条目直接关联）置前，其余按相关性排列；点击标题跳转 PubMed。</p>
    ${litItemsHtml(ctx.literature, pdbByPmid, LIT_PREVIEW)}
  </section>` : ''}

  ${imagesHtml}

  <footer class="rpt-foot">
    <div>SOURCES — UniProt REST · RCSB PDB · PDBe (EBI)${blastRan ? (ctx.blastStatus?.provider === 'rcsb' ? ' · RCSB 序列检索 (mmseqs2)' : ' · NCBI BLAST (pdbaa)') : ''} · PubMed eutils${ctx.images.length ? ' · 客户评估表' : ''}</div>
    <div>本报告由 TargetEval 系统自动生成：数据区块为数据库实时检索结果；「评估分析」章节由大语言模型基于上述数据生成，可能存在解读偏差，关键决策请以原始数据库与文献为准。</div>
    <div>JOB ${esc(input.jobId)} · GENERATED ${(input.durationMs / 1000).toFixed(1)}s · ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC</div>
  </footer>
</div>
<a href="#top" class="backtop no-print" id="backtop" aria-label="回到顶部" title="回到顶部">↑</a>
<script>
(function(){
  var els;
  window.addEventListener('beforeprint', function(){
    els = [];
    document.querySelectorAll('details').forEach(function(d){
      if(!d.open){ d.dataset.pc='1'; d.open = true; els.push(d); }
    });
  });
  window.addEventListener('afterprint', function(){
    (els||[]).forEach(function(d){ if(d.dataset.pc){ d.open=false; delete d.dataset.pc; } });
    els = [];
  });
  var btn = document.getElementById('backtop');
  if (btn) {
    var onScroll = function(){ btn.classList.toggle('show', window.scrollY > 600); };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }
})();
</script>
</body>
</html>`
  return html
}
