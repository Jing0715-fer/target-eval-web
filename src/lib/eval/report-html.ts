/**
 * 独立 HTML 评估报告渲染：
 *  - 内联 CSS，无外部依赖，单文件可离线打开/打印
 *  - LLM 章节用轻量 Markdown 子集渲染器（无 JSDOM/react-markdown，零额外内存）
 *  - 确定性数据区块（评分/结构表/文献/实验图）模板直出，图片按预算 base64 内嵌
 * 图片预算：单图 ≤2MB（解析时已限），内嵌总数 ≤8 张、总预算 ≤6MB，gel/sec 优先。
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { BlastHit, LiteratureItem, ParsedImage, PdbEntry, Scores, UniprotInfo, MethodStats } from './types'
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

function pdbRowsHtml(pdbs: PdbEntry[], max: number): string {
  return pdbs.slice(0, max).map(p => `
    <tr>
      <td><a href="https://www.rcsb.org/structure/${p.pdbId}" target="_blank" rel="noopener">${p.pdbId}</a></td>
      <td><span class="mth mth-${p.isXray ? 'xray' : p.isCryoem ? 'cryoem' : p.isNmr ? 'nmr' : 'other'}">${esc(methodLabel(p))}</span></td>
      <td class="num">${p.resolution != null ? p.resolution.toFixed(2) + ' Å' : '—'}</td>
      <td class="t-title">${esc(p.title)}</td>
      <td>${esc(p.releaseDate || '—')}</td>
      <td class="t-lig">${esc(p.ligands.slice(0, 3).join(', ') || '—')}</td>
      <td>${esc(p.journal || '—')}</td>
      <td>${p.pubmedId ? `<a href="https://pubmed.ncbi.nlm.nih.gov/${p.pubmedId}/" target="_blank" rel="noopener">${p.pubmedId}</a>` : '—'}</td>
    </tr>`).join('')
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
      <td>${h.pdbId ? `<a href="https://www.rcsb.org/structure/${h.pdbId}" target="_blank" rel="noopener">${h.pdbId}</a>` : '—'}</td>
      <td class="t-title">${esc(h.description)}</td>
      <td class="num">${h.identity.toFixed(1)}%</td>
      <td class="num">${esc(h.evalueRaw)}</td>
      <td class="num">${h.queryCoverage || '—'}</td>
      <td>${esc(h.method || '—')}</td>
      <td class="num">${h.resolution != null ? h.resolution.toFixed(2) + ' Å' : '—'}</td>
    </tr>`).join('')
}

function litItemsHtml(lits: LiteratureItem[]): string {
  return lits.map(l => `
    <div class="lit-item">
      <div class="lit-title"><a href="https://pubmed.ncbi.nlm.nih.gov/${l.pmid}/" target="_blank" rel="noopener">${esc(l.title)}</a></div>
      <div class="lit-meta">${esc(l.journal)}${l.year ? ` · ${esc(l.year)}` : ''}${l.doi ? ` · DOI: <a href="https://doi.org/${esc(l.doi)}" target="_blank" rel="noopener">${esc(l.doi)}</a>` : ''} · PMID ${esc(l.pmid)}</div>
      ${l.abstractExcerpt ? `<div class="lit-abs">${esc(l.abstractExcerpt)}</div>` : ''}
    </div>`).join('')
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
  /** 图片文件路径解析（由 pipeline 提供，图片存于 db/reports/{id}/assets/） */
  resolveImagePath: (meta: ParsedImage) => string
}

export async function renderReportHtml(input: ReportRenderInput): Promise<string> {
  const { ctx, methodStats, llmMarkdown } = input
  const u = ctx.uniprot
  const dateStr = new Date().toISOString().slice(0, 10)
  const proteinTitle = u ? `${u.proteinName}（${u.uniprotId}）` : '序列靶点评估'
  const geneStr = u?.geneNames.join(', ') || '—'

  const embedded = await embedImages(ctx.images, input.resolveImagePath)

  // 动态章节编号：一 llm / 二 scores / 三 pdbs / 后续按存在性编号
  const cnNums = ['一', '二', '三', '四', '五', '六', '七']
  let secNo = 3
  const blastNo = ctx.blastHits.length ? ++secNo : 0
  const litNo = ctx.literature.length ? ++secNo : 0
  const assetsNo = embedded.length ? ++secNo : 0

  const scoreColor = (n: number) => (n >= 7 ? '#059669' : n >= 5 ? '#d97706' : '#dc2626')

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
    ${embedded.map(({ meta, dataUri }, i) => `
    <figure class="fig">
      ${dataUri
      ? `<img src="${dataUri}" alt="${esc(meta.caption)}" loading="lazy">`
      : `<div class="fig-missing">图片体积超出内嵌预算，请通过系统查看</div>`}
      <figcaption><span class="fig-tag fig-${meta.kind}">${meta.kind === 'gel' ? 'SDS-PAGE' : meta.kind === 'sec' ? 'SEC' : '图'}</span>图 ${i + 1}：${esc(meta.caption)}</figcaption>
    </figure>`).join('')}
  </section>` : ''

  const pdbCountHtml = `${ctx.directPdbs.length}${input.totalPdbFound > ctx.directPdbs.length ? ` / 检索命中 ${input.totalPdbFound}` : ''}`

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>靶点结构解析可行性评估报告 — ${esc(proteinTitle)}</title>
<style>
  :root { --ink:#1c1917; --sub:#57534e; --line:#e7e5e4; --accent:#047857; --accent-bg:#ecfdf5; --bg:#fafaf9; }
  * { margin:0; padding:0; box-sizing:border-box; }
  html { -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  body { font-family:"PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif; color:var(--ink); background:var(--bg); line-height:1.75; font-size:14px; }
  .page { max-width:900px; margin:0 auto; padding:48px 40px 64px; }
  @media (max-width:640px){ .page{padding:24px 16px} }
  @media print { body{background:#fff} .page{padding:0;max-width:none} .no-print{display:none!important} .sec{break-inside:avoid-page} .fig{break-inside:avoid} table{break-inside:auto} tr{break-inside:avoid} }

  /* 报告头 */
  .rpt-head { border-bottom:3px solid var(--accent); padding-bottom:24px; margin-bottom:28px; }
  .rpt-eyebrow { color:var(--accent); font-weight:600; font-size:12px; letter-spacing:2px; text-transform:uppercase; margin-bottom:8px; }
  h1.rpt-title { font-size:26px; line-height:1.35; margin-bottom:14px; }
  .meta-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:10px 18px; font-size:13px; color:var(--sub); }
  .meta-grid b { color:var(--ink); font-weight:600; }
  .meta-grid a { color:var(--accent); text-decoration:none; }
  .meta-grid a:hover { text-decoration:underline; }
  .rpt-badges { margin-top:14px; display:flex; flex-wrap:wrap; gap:8px; }
  .badge { display:inline-block; padding:3px 12px; border-radius:999px; font-size:12px; font-weight:600; background:var(--accent-bg); color:var(--accent); border:1px solid #a7f3d0; }
  .badge.amber { background:#fffbeb; color:#b45309; border-color:#fde68a; }

  /* 目录 */
  .toc { background:#f5f5f4; border:1px solid var(--line); border-radius:10px; padding:16px 20px; margin-bottom:28px; font-size:13px; }
  .toc b { display:block; margin-bottom:6px; font-size:12px; letter-spacing:1px; color:var(--sub); }
  .toc ol { margin-left:18px; }
  .toc a { color:var(--ink); text-decoration:none; }
  .toc a:hover { color:var(--accent); }

  /* 章节 */
  .sec { margin-bottom:34px; }
  .sec > h2 { font-size:19px; padding:10px 14px; background:var(--accent-bg); border-left:4px solid var(--accent); border-radius:0 8px 8px 0; margin-bottom:16px; }
  .sec h3 { font-size:15.5px; margin:18px 0 8px; color:#065f46; }
  .sec h4 { font-size:14px; margin:14px 0 6px; }
  p { margin:8px 0; text-align:justify; }
  ul { margin:8px 0 8px 22px; }
  li { margin:4px 0; }
  blockquote { border-left:3px solid #d6d3d1; padding:6px 14px; margin:10px 0; color:var(--sub); background:#f5f5f4; border-radius:0 6px 6px 0; }
  strong { font-weight:700; }
  em { font-style:italic; }
  code { background:#f5f5f4; padding:1px 5px; border-radius:4px; font-size:.92em; }

  /* 表格 */
  .tbl-wrap { overflow-x:auto; margin:12px 0; }
  table { width:100%; border-collapse:collapse; font-size:12.5px; }
  th { background:#f5f5f4; text-align:left; }
  th, td { border:1px solid var(--line); padding:7px 9px; vertical-align:top; }
  tbody tr:nth-child(even) { background:#fafaf9; }
  td.num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
  .t-title { max-width:300px; }
  .t-lig { max-width:170px; font-size:12px; }
  .mth { display:inline-block; padding:1px 8px; border-radius:4px; font-size:11px; font-weight:600; white-space:nowrap; }
  .mth-xray { background:#ecfdf5; color:#047857; }
  .mth-cryoem { background:#fef3c7; color:#92400e; }
  .mth-nmr { background:#f3e8ff; color:#6b21a8; }
  .mth-other { background:#f5f5f4; color:#57534e; }

  /* 评分卡 */
  .score-card { background:#fff; border:1px solid var(--line); border-radius:12px; padding:18px 20px; margin:14px 0 22px; }
  .score-row { display:grid; grid-template-columns:92px 1fr 64px 120px; gap:12px; align-items:center; margin:9px 0; }
  .score-label { font-weight:600; font-size:13px; }
  .score-track { height:10px; border-radius:999px; background:#e7e5e4; overflow:hidden; }
  .score-fill { height:100%; border-radius:999px; }
  .score-num { font-size:16px; font-weight:700; text-align:right; font-variant-numeric:tabular-nums; }
  .score-max { color:var(--sub); font-size:11px; font-weight:400; }
  .score-rating { font-size:12px; color:var(--sub); text-align:right; }
  .score-rationale { margin-top:12px; padding-top:12px; border-top:1px dashed var(--line); font-size:12.5px; color:var(--sub); line-height:1.9; }

  /* 文献 */
  .lit-item { padding:10px 0; border-bottom:1px solid var(--line); }
  .lit-item:last-child { border-bottom:none; }
  .lit-title a { color:var(--ink); font-weight:600; text-decoration:none; }
  .lit-title a:hover { color:var(--accent); }
  .lit-meta { font-size:12px; color:var(--sub); margin:3px 0; }
  .lit-meta a { color:var(--accent); text-decoration:none; }
  .lit-abs { font-size:12.5px; color:var(--sub); margin-top:4px; }

  /* 图 */
  .fig { margin:18px 0; text-align:center; }
  .fig img { max-width:100%; max-height:420px; border:1px solid var(--line); border-radius:8px; background:#fff; }
  .fig-missing { padding:40px; background:#f5f5f4; border:1px dashed var(--line); border-radius:8px; color:var(--sub); }
  .fig figcaption { font-size:12.5px; color:var(--sub); margin-top:8px; }
  .fig-tag { display:inline-block; padding:1px 8px; border-radius:4px; font-size:11px; font-weight:600; margin-right:6px; }
  .fig-gel { background:#ecfdf5; color:#047857; }
  .fig-sec { background:#fef3c7; color:#92400e; }
  .fig-other { background:#f5f5f4; color:#57534e; }

  /* 页脚 */
  .rpt-foot { margin-top:44px; padding-top:18px; border-top:1px solid var(--line); font-size:12px; color:var(--sub); line-height:1.9; }
  .warn-box { background:#fffbeb; border:1px solid #fde68a; color:#92400e; border-radius:8px; padding:12px 16px; font-size:12.5px; margin:12px 0; }
  .note { font-size:12.5px; color:var(--sub); }
</style>
</head>
<body>
<div class="page">

  <header class="rpt-head">
    <div class="rpt-eyebrow">TargetEval · 蛋白靶点结构解析可行性评估报告</div>
    <h1 class="rpt-title">${esc(proteinTitle)}</h1>
    <div class="meta-grid">
      <div><b>UniProt</b>：${u ? `<a href="https://www.uniprot.org/uniprotkb/${u.uniprotId}" target="_blank" rel="noopener">${u.uniprotId}</a>（${esc(u.entryName)}）` : '—（序列直接输入）'}</div>
      <div><b>蛋白名称</b>：${esc(u?.proteinName ?? '—')}</div>
      <div><b>基因</b>：${esc(geneStr)}</div>
      <div><b>物种</b>：${esc(u?.organism ?? '—')}</div>
      <div><b>序列长度</b>：${u ? u.sequenceLength + ' aa' : ctx.sequence ? ctx.sequence.length + ' aa' : '—'}</div>
      <div><b>结构覆盖率</b>：${ctx.coverage ? ctx.coverage.coveragePercent + '%' : '—'}</div>
      <div><b>PDB 结构数</b>：${pdbCountHtml}（X-ray ${methodStats.xrayCount} / Cryo-EM ${methodStats.cryoemCount} / NMR ${methodStats.nmrCount}）</div>
      <div><b>最佳分辨率</b>：${methodStats.bestResolution != null ? methodStats.bestResolution.toFixed(2) + ' Å' : '—'}</div>
      <div><b>BLAST 同源</b>：${ctx.blastHits.length} 个</div>
      <div><b>文献证据</b>：${ctx.literature.length} 篇</div>
      <div><b>报告日期</b>：${dateStr}</div>
    </div>
    <div class="rpt-badges">
      <span class="badge">综合评分 ${ctx.scores.overall.score}/10 · ${esc(ctx.scores.overall.rating)}</span>
      <span class="badge">数据源：UniProt · RCSB · PDBe${ctx.blastHits.length ? ' · BLAST' : ''}${ctx.literature.length ? ' · PubMed' : ''}</span>
      ${input.llmOk ? '<span class="badge">LLM 分析：已完成</span>' : '<span class="badge amber">LLM 分析：失败（见数据区块）</span>'}
    </div>
  </header>

  <nav class="toc">
    <b>报告目录</b>
    <ol>
      <li><a href="#llm">评估分析（LLM 生成：摘要 / 目标可行性 / 研究全景 / 实验策略）</a></li>
      <li><a href="#scores">可行性评分</a></li>
      <li><a href="#pdbs">PDB 结构清单</a></li>
      ${ctx.blastHits.length ? '<li><a href="#blast">BLAST 同源结构</a></li>' : ''}
      ${ctx.literature.length ? '<li><a href="#literature">关键文献</a></li>' : ''}
      ${embedded.length ? '<li><a href="#assets">客户实验数据（评估表）</a></li>' : ''}
    </ol>
  </nav>

  ${input.llmOk ? '' : `<div class="warn-box">LLM 分析生成失败（${esc(input.llmErrors.join('；')) || '未知原因'}）。以下为系统收集的确定性数据，评估分析部分缺失，可稍后重试生成。</div>`}

  <section class="sec" id="llm">
    <h2>一、评估分析</h2>
    ${renderMarkdown(llmMarkdown || '（LLM 分析不可用 — 未能生成，请参考下方数据区块）', 1)}
  </section>

  <section class="sec" id="scores">
    <h2>二、可行性评分</h2>
    ${scoreHtml}
    <p class="note">评分由系统规则计算（1-10）：基于序列长度、跨膜特征、已有结构先例（方法学+分辨率）、BLAST 同源 identity 加成。评分数值仅供参考，最终可行性需结合实验条件判断。</p>
  </section>

  <section class="sec" id="pdbs">
    <h2>三、PDB 结构清单（${ctx.directPdbs.length} 个，按分辨率排序）</h2>
    ${ctx.directPdbs.length ? `
    <div class="tbl-wrap"><table>
      <thead><tr><th>PDB ID</th><th>方法</th><th>分辨率</th><th>标题</th><th>释放日期</th><th>主要配体</th><th>期刊</th><th>PMID</th></tr></thead>
      <tbody>${pdbRowsHtml(ctx.directPdbs, 150)}</tbody>
    </table></div>
    ${input.totalPdbFound > 150 ? `<p class="note">共检索命中 ${input.totalPdbFound} 个结构，表中展示前 150 个（按分辨率排序）。</p>` : ''}`
    : '<p>该靶点（或该 UniProt）暂无直接关联的 PDB 结构。同源结构请见 BLAST 章节。</p>'}
  </section>

  ${ctx.blastHits.length ? `
  <section class="sec" id="blast">
    <h2>${cnNums[blastNo - 1]}、BLAST 同源结构（${ctx.blastHits.length} 个）</h2>
    <div class="tbl-wrap"><table>
      <thead><tr><th>PDB ID</th><th>描述</th><th>Identity</th><th>E-value</th><th>覆盖(aa)</th><th>方法</th><th>分辨率</th></tr></thead>
      <tbody>${blastRowsHtml(ctx.blastHits)}</tbody>
    </table></div>
  </section>` : ''}

  ${ctx.literature.length ? `
  <section class="sec" id="literature">
    <h2>${cnNums[litNo - 1]}、关键文献（PubMed，${ctx.literature.length} 篇）</h2>
    ${litItemsHtml(ctx.literature)}
  </section>` : ''}

  ${imagesHtml}

  <footer class="rpt-foot">
    <div><b>数据来源</b>：UniProt REST API · RCSB PDB · PDBe (EBI) · NCBI BLAST (pdbaa) · PubMed eutils${ctx.images.length ? ' · 客户评估表' : ''}</div>
    <div>本报告由 TargetEval 系统自动生成：数据区块为数据库实时检索结果；「评估分析」章节由大语言模型基于上述数据生成，可能存在解读偏差，关键决策请以原始数据库与文献为准。</div>
    <div>作业编号：${esc(input.jobId)} · 生成耗时 ${(input.durationMs / 1000).toFixed(1)}s · 生成时间 ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC</div>
  </footer>
</div>
</body>
</html>`
  return html
}
