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
import type { ReportContext } from './report'

// ─── Markdown 子集 → HTML ─────────────────────────────────────────────────────

function esc(s: string): string {
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

function renderMarkdown(md: string, headingOffset = 0): string {
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

function scoreBar(label: string, item: { score: number; rating: string }, color: string): string {
  const pct = Math.round((item.score / 10) * 100)
  return `
  <div class="score-row">
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
  <col style="width:74px"><col style="width:62px"><col style="width:64px"><col>
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
    <thead><tr><th>PDB ID</th><th>方法</th><th class="num">分辨率 (Å)</th><th>标题</th><th class="num">释放日期</th><th>主要配体</th><th>期刊</th><th>文献</th></tr></thead>
    <tbody>${pdbRowsHtml(head, preview, litByPmid)}</tbody>
  </table></div>`
  if (rest.length === 0) return headHtml
  return `${headHtml}
  <details class="fold">
    <summary>展开其余 ${rest.length} 条结构（共 ${shown.length} 条，打印时自动展开）</summary>
    <div class="tbl-wrap"><table class="tbl-data">
      ${PDB_COLGROUP}
      <thead><tr><th>PDB ID</th><th>方法</th><th class="num">分辨率 (Å)</th><th>标题</th><th class="num">释放日期</th><th>主要配体</th><th>期刊</th><th>文献</th></tr></thead>
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

function blastRowsHtml(hits: BlastHit[]): string {
  return hits.map(h => `
    <tr>
      <td class="td-id">${h.pdbId ? `<a href="https://www.rcsb.org/structure/${h.pdbId}" target="_blank" rel="noopener">${h.pdbId}</a>` : '—'}</td>
      <td class="t-desc">${esc(h.description)}</td>
      <td class="num">${h.identity.toFixed(1)}%</td>
      <td class="num">${esc(h.evalueRaw)}</td>
      <td class="num">${esc(h.queryCoverage != null ? String(h.queryCoverage) : '—')}</td>
      <td class="t-nowrap">${esc(h.method || '—')}</td>
      <td class="num">${h.resolution != null ? h.resolution.toFixed(2) : '—'}</td>
    </tr>`).join('')
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

const EMBED_MAX_COUNT = 8
const EMBED_MAX_TOTAL = 6 * 1024 * 1024

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
  const proteinTitle = u ? `${u.proteinName}（${u.uniprotId}）` : '序列靶点评估'
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

  // 动态章节编号：一 llm / 二 scores / 三 pdbs / 后续按存在性编号
  const cnNums = ['一', '二', '三', '四', '五', '六', '七']
  let secNo = 3
  const blastNo = ctx.blastHits.length ? ++secNo : 0
  const litNo = ctx.literature.length ? ++secNo : 0
  const assetsNo = embedded.length ? ++secNo : 0

  const scoreColor = (n: number) => (n >= 7 ? '#047857' : n >= 5 ? '#b45309' : '#b91c1c')

  const scoreHtml = `
  <div class="score-card">
    ${scoreBar('X-ray 结晶', ctx.scores.xray, scoreColor(ctx.scores.xray.score))}
    ${scoreBar('Cryo-EM', ctx.scores.cryoem, scoreColor(ctx.scores.cryoem.score))}
    ${scoreBar('NMR', ctx.scores.nmr, scoreColor(ctx.scores.nmr.score))}
    ${scoreBar('综合评估', ctx.scores.overall, scoreColor(ctx.scores.overall.score))}
    <div class="score-rationale">
      <div>· X-ray：${esc(ctx.scores.rationale.xray)}</div>
      <div>· Cryo-EM：${esc(ctx.scores.rationale.cryoem)}</div>
      <div>· NMR：${esc(ctx.scores.rationale.nmr)}</div>
      <div>· 综合：${esc(ctx.scores.rationale.overall)}</div>
    </div>
  </div>`

  const imagesHtml = embedded.length ? `
  <section class="sec" id="assets">
    <h2>${cnNums[assetsNo - 1]}、客户提供的实验数据（${embedded.length} 张）</h2>
    <div class="fig-grid">
    ${embedded.map(({ meta, dataUri }, i) => `
    <figure class="fig">
      ${dataUri
      ? `<img src="${dataUri}" alt="${esc(meta.caption)}" loading="lazy">`
      : `<div class="fig-missing">图片体积超出内嵌预算，请通过系统查看</div>`}
      <figcaption><span class="fig-tag fig-${meta.kind}">${meta.kind === 'gel' ? 'SDS-PAGE' : meta.kind === 'sec' ? 'SEC' : '图'}</span>图 ${i + 1}：${esc(meta.caption)}</figcaption>
    </figure>`).join('')}
    </div>
  </section>` : ''

  const pdbCountHtml = `${ctx.directPdbs.length}${input.totalPdbFound > ctx.directPdbs.length ? ` / 检索命中 ${input.totalPdbFound}` : ''}`

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>靶点结构解析可行性评估报告 — ${esc(proteinTitle)}</title>
<style>
  :root {
    --ink:#1c1917; --sub:#57534e; --faint:#a8a29e; --line:#e7e5e4; --hairline:#efedeb;
    --accent:#065f46; --accent-2:#047857; --accent-bg:#f0fdf7; --bg:#fcfcfb; --paper:#ffffff;
    --serif:Georgia,"Times New Roman","Songti SC","Noto Serif SC","SimSun","STSong",serif;
    --mono:ui-monospace,"SF Mono",Menlo,Consolas,"Courier New",monospace;
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  html { -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  body { font-family:var(--serif); color:var(--ink); background:var(--bg); line-height:1.85; font-size:14.5px; }
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
    table{break-inside:auto} tr{break-inside:avoid} details{display:block}
  }

  /* ── 报告封面头（期刊风双线）── */
  .rpt-head { padding-bottom:22px; margin-bottom:30px; border-bottom:1px solid var(--ink); position:relative; }
  .rpt-head::after { content:''; display:block; position:absolute; left:0; bottom:3px; width:100%; border-bottom:3px solid var(--ink); }
  .rpt-eyebrow { font-family:var(--mono); color:var(--accent); font-weight:600; font-size:10.5px; letter-spacing:2.4px; text-transform:uppercase; margin-bottom:14px; }
  h1.rpt-title { font-size:27px; line-height:1.4; margin-bottom:6px; font-weight:700; }
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

  /* ── 章节 ── */
  .sec { margin-bottom:38px; }
  .sec > h2 { font-size:19px; padding-bottom:8px; margin-bottom:16px; border-bottom:1px solid var(--ink); font-weight:700; display:flex; align-items:baseline; gap:10px; }
  .sec > h2 .sec-en { margin-left:auto; font-family:var(--mono); font-size:10px; font-weight:500; letter-spacing:1.8px; color:var(--faint); text-transform:uppercase; white-space:nowrap; }
  .sec h3 { font-size:15.5px; margin:20px 0 8px; color:#064e3b; font-weight:700; }
  .sec h4 { font-size:14px; margin:16px 0 6px; font-weight:700; }
  .sec h5, .sec h6 { font-size:13.5px; margin:12px 0 5px; font-weight:700; }
  p { margin:8px 0; text-align:justify; }
  ul { margin:8px 0 8px 22px; }
  li { margin:4px 0; }
  blockquote { border-left:3px solid #d6d3d1; padding:5px 14px; margin:12px 0; color:var(--sub); background:#fafaf9; border-radius:0 4px 4px 0; font-size:13.5px; }
  strong { font-weight:700; }
  em { font-style:italic; }
  code { font-family:var(--mono); background:#f5f5f4; padding:1px 5px; border-radius:3px; font-size:.88em; }

  /* ── 表格 ── */
  .tbl-wrap { overflow-x:auto; margin:12px 0 6px; }
  table { width:100%; border-collapse:collapse; font-size:12px; font-family:var(--mono); }
  /* 数据表（PDB/BLAST）：固定列宽防长串挤压重叠；窄屏由 .tbl-wrap 横向滚动 */
  table.tbl-data { table-layout:fixed; min-width:760px; }
  table.tbl-blast { min-width:640px; }
  th { background:#f7f7f5; text-align:left; font-size:10px; letter-spacing:1px; text-transform:uppercase; color:var(--sub); font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  th.num { text-align:right; }
  th, td { border-top:1px solid var(--line); border-bottom:1px solid var(--line); padding:6px 8px; vertical-align:top; }
  thead th { border-top:none; border-bottom:1.5px solid #d6d3d1; }
  tbody tr:last-child td { border-bottom:none; }
  tbody tr:nth-child(even) td { background:#fbfaf8; }
  tbody tr:hover td { background:#f5f4ef; }
  td { overflow-wrap:anywhere; }
  td.num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
  td.td-id a, .t-nowrap { white-space:nowrap; }
  .t-title, .t-desc { font-family:var(--serif); overflow-wrap:break-word; }
  .t-lig { font-size:11px; overflow-wrap:anywhere; }
  .t-journal { font-size:11px; }
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
  .note { font-size:12px; color:var(--sub); margin-top:6px; }

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

  /* ── 页脚 ── */
  .rpt-foot { margin-top:48px; padding-top:18px; border-top:1px solid var(--ink); font-size:11.5px; color:var(--sub); line-height:2; font-family:var(--mono); }
  .warn-box { background:#fffbeb; border:1px solid #fde68a; color:#92400e; border-radius:4px; padding:12px 16px; font-size:12.5px; margin:14px 0; }
</style>
</head>
<body>
<div class="page">

  <header class="rpt-head">
    <div class="rpt-eyebrow">TargetEval · Structure Feasibility Report</div>
    <h1 class="rpt-title">${esc(proteinTitle)}</h1>
    <div class="rpt-subtitle">蛋白靶点结构解析可行性评估报告</div>
    <div class="meta-grid">
      <div><b>UniProt</b> ${u ? `<a href="https://www.uniprot.org/uniprotkb/${u.uniprotId}" target="_blank" rel="noopener">${u.uniprotId}</a>（${esc(u.entryName)}）` : '—（序列直接输入）'}</div>
      <div><b>蛋白名称</b> ${esc(u?.proteinName ?? '—')}</div>
      <div><b>基因</b> ${esc(geneStr)}</div>
      <div><b>物种</b> ${esc(u?.organism ?? '—')}</div>
      <div><b>序列长度</b> ${u ? u.sequenceLength + ' aa' : ctx.sequence ? ctx.sequence.length + ' aa' : '—'}</div>
      <div><b>结构覆盖率</b> ${ctx.coverage ? ctx.coverage.coveragePercent + '%' : '—'}</div>
      <div><b>PDB 结构</b> ${pdbCountHtml}（X-ray ${methodStats.xrayCount} / Cryo-EM ${methodStats.cryoemCount} / NMR ${methodStats.nmrCount}）</div>
      <div><b>最佳分辨率</b> ${methodStats.bestResolution != null ? methodStats.bestResolution.toFixed(2) + ' Å' : '—'}</div>
      <div><b>BLAST 同源</b> ${ctx.blastHits.length} 个</div>
      <div><b>文献证据</b> ${ctx.literature.length} 篇${linkedLitCount ? `（${linkedLitCount} 篇与结构条目直接关联）` : ''}</div>
      ${cmp ? `<div><b>客户构建</b> ${constructHtml}</div>` : ''}
      <div><b>分析引擎</b> ${esc(input.engineSummary || '—')}</div>
      <div><b>报告日期</b> ${dateStr}</div>
    </div>
    <div class="rpt-badges">
      <span class="badge">综合评分 ${ctx.scores.overall.score}/10 · ${esc(ctx.scores.overall.rating)}</span>
      <span class="badge">数据源：UniProt · RCSB · PDBe${ctx.blastHits.length ? ' · BLAST' : ''}${ctx.literature.length ? ' · PubMed' : ''}</span>
      ${input.llmOk ? '<span class="badge">LLM 分析：已完成</span>' : '<span class="badge amber">LLM 分析：失败（见数据区块）</span>'}
    </div>
  </header>

  <nav class="toc">
    <b>Contents · 目录</b>
    <ol>
      <li><a href="#llm">评估分析（摘要 / 目标可行性 / 研究全景 / 实验策略）</a></li>
      <li><a href="#scores">可行性评分</a></li>
      <li><a href="#pdbs">PDB 结构清单</a></li>
      ${ctx.blastHits.length ? '<li><a href="#blast">BLAST 同源结构</a></li>' : ''}
      ${ctx.literature.length ? '<li><a href="#literature">关键文献</a></li>' : ''}
      ${embedded.length ? '<li><a href="#assets">客户实验数据（评估表）</a></li>' : ''}
    </ol>
  </nav>

  ${input.llmOk ? '' : `<div class="warn-box">LLM 分析生成失败（${esc(input.llmErrors.join('；')) || '未知原因'}）。以下为系统收集的确定性数据，评估分析部分缺失，可稍后重试生成。</div>`}

  <section class="sec" id="llm">
    <h2>一、评估分析<span class="sec-en">Analysis</span></h2>
    ${renderMarkdown(llmMarkdown || '（LLM 分析不可用 — 未能生成，请参考下方数据区块）', 1)}
  </section>

  <section class="sec" id="scores">
    <h2>二、可行性评分<span class="sec-en">Scores</span></h2>
    ${scoreHtml}
    <p class="note">评分由系统规则计算（1-10）：基于序列长度、跨膜特征、已有结构先例（方法学+分辨率）、BLAST 同源 identity 加成。评分数值仅供参考，最终可行性需结合实验条件判断。</p>
  </section>

  <section class="sec" id="pdbs">
    <h2>三、PDB 结构清单<span class="sec-en">Structures · ${ctx.directPdbs.length}</span></h2>
    ${ctx.directPdbs.length ? pdbTableHtml(ctx.directPdbs, PDB_PREVIEW, 150, litByPmid) +
      (input.totalPdbFound > 150 ? `<p class="note">共检索命中 ${input.totalPdbFound} 个结构，表中展示前 150 个（按分辨率排序）。</p>`
      : (input.totalPdbFound > ctx.directPdbs.length ? `<p class="note">共检索命中 ${input.totalPdbFound} 个结构，表中展示详情完整的前 ${ctx.directPdbs.length} 个。</p>` : ''))
    : '<p>该靶点（或该 UniProt）暂无直接关联的 PDB 结构。同源结构请见 BLAST 章节。</p>'}
  </section>

  ${ctx.blastHits.length ? `
  <section class="sec" id="blast">
    <h2>${cnNums[blastNo - 1]}、BLAST 同源结构<span class="sec-en">Homologs · ${ctx.blastHits.length}</span></h2>
    <div class="tbl-wrap"><table class="tbl-data tbl-blast">
      <colgroup>
        <col style="width:74px"><col><col style="width:78px"><col style="width:88px">
        <col style="width:74px"><col style="width:104px"><col style="width:74px">
      </colgroup>
      <thead><tr><th>PDB ID</th><th>描述</th><th class="num">Identity</th><th class="num">E-value</th><th class="num">覆盖(aa)</th><th>方法</th><th class="num">分辨率 (Å)</th></tr></thead>
      <tbody>${blastRowsHtml(ctx.blastHits)}</tbody>
    </table></div>
  </section>` : ''}

  ${ctx.literature.length ? `
  <section class="sec" id="literature">
    <h2>${cnNums[litNo - 1]}、关键文献<span class="sec-en">References · ${ctx.literature.length}${linkedLitCount ? ` · ${linkedLitCount} linked` : ''}</span></h2>
    ${litItemsHtml(ctx.literature, pdbByPmid, LIT_PREVIEW)}
  </section>` : ''}

  ${imagesHtml}

  <footer class="rpt-foot">
    <div>SOURCES — UniProt REST · RCSB PDB · PDBe (EBI) · NCBI BLAST (pdbaa) · PubMed eutils${ctx.images.length ? ' · 客户评估表' : ''}</div>
    <div>本报告由 TargetEval 系统自动生成：数据区块为数据库实时检索结果；「评估分析」章节由大语言模型基于上述数据生成，可能存在解读偏差，关键决策请以原始数据库与文献为准。</div>
    <div>JOB ${esc(input.jobId)} · GENERATED ${(input.durationMs / 1000).toFixed(1)}s · ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC</div>
  </footer>
</div>
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
})();
</script>
</body>
</html>`
  return html
}
