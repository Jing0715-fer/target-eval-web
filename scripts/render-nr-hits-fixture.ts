/**
 * v2.59→v2.67 fixture：BLAST nr 结果展示渲染验证（与 PDB 库同款表格全量直出 + 库切换）。
 * 场景 A：近似身份（nr 最佳命中 <85% 未回填 UniProt — 用户报告的「未回填」典型态），
 *         2 条 PDB 同源 + 8 条 nr 命中（sp/tr/other 混合、长描述、缺 entryName 边界）
 *         → 库切换按钮 + 双面板（PDB 默认 / nr hidden），nr 表 8 行全量（无折叠）。
 * 场景 B：PDB BLAST 失败 + nr 兜底成功回填（blastStatus failed 但 nrHits 存在）
 *         → 无切换按钮，nr 单独全量展示（h3 标题 + 6 行）。
 * 字符串断言：切换按钮 / 面板 hidden / 全量行数 / 库 chips / UniProt 链接 / 章节头计数。
 */
import * as fs from 'node:fs/promises'
import { renderReportHtml } from '../src/lib/eval/report-html'
import type { ReportContext } from '../src/lib/eval/report'
import type { BlastHit, BlastNrHit, PdbEntry, Scores, TargetIdentityInfo } from '../src/lib/eval/types'

const scores: Scores & { rationale: { xray: string; cryoem: string; nmr: string; overall: string } } = {
  xray: { score: 6, maxScore: 10, rating: '优先推荐' },
  cryoem: { score: 4, maxScore: 10, rating: '中等' },
  nmr: { score: 5, maxScore: 10, rating: '可行' },
  overall: { score: 5, maxScore: 10, rating: '中等' },
  rationale: { xray: 'mock', cryoem: 'mock', nmr: 'mock', overall: 'mock' },
}
const ti: TargetIdentityInfo = {
  name: 'Uncharacterized protein Cxorf51-like', source: 'blast-nr', sourceLabel: 'BLAST nr 识别', identity: 54.3,
  uniprotId: 'Q8N4C6', uniprotEntry: 'CXorf51_HUMAN', organism: 'Homo sapiens', geneName: 'CXorf51',
  note: 'BLAST nr 最佳命中（覆盖度加权）未达「85% 一致性 + 40% 覆盖」回填阈值，记录为近似身份',
}
const blast: BlastHit[] = [
  { pdbId: '1A1A', description: 'Chain A, hypothetical protein, putative kinase domain', identity: 27.4, evalue: 3e-4, evalueRaw: '3e-04', queryCoverage: 180, queryFrom: 12, queryTo: 191, method: 'X-ray', resolution: 2.1 },
  { pdbId: '2B2B', description: 'Chain A, uncharacterized protein fragment', identity: 24.1, evalue: 0.002, evalueRaw: '2e-03', queryCoverage: 95, queryFrom: 40, queryTo: 134, method: 'X-ray', resolution: 2.8 },
]
const nrHits: BlastNrHit[] = [
  { accession: 'Q8N4C6', entryName: 'CXorf51_HUMAN', description: 'Uncharacterized protein Cxorf51', organism: 'Homo sapiens', geneName: 'CXorf51', identity: 54.3, evalue: 1e-42, evalueRaw: '1e-42', queryCoverage: 285, queryFrom: 3, queryTo: 287, hitFrom: 5, hitTo: 289, db: 'sp' },
  { accession: 'A0A8G0KJC2', entryName: 'CXorf51_PONAB', description: 'Uncharacterized protein Cxorf51-like', organism: 'Pongo abelii', geneName: 'CXorf51', identity: 52.8, evalue: 7e-41, evalueRaw: '7e-41', queryCoverage: 285, queryFrom: 3, queryTo: 287, hitFrom: 5, hitTo: 289, db: 'tr' },
  { accession: 'Q9H2W4', entryName: 'KLHL34_HUMAN', description: 'Kelch-like protein 34 (Kelch repeat-containing protein 34) variant 2', organism: 'Homo sapiens', geneName: 'KLHL34', identity: 31.6, evalue: 2e-18, evalueRaw: '2e-18', queryCoverage: 160, queryFrom: 90, queryTo: 249, hitFrom: 120, hitTo: 279, db: 'sp' },
  { accession: 'WP_012345678.1', description: 'hypothetical protein W5S non-ribosomal peptide synthetase fragment with an unusually long descriptive defline that should clamp in the description cell and show full text on hover only', organism: 'Streptomyces coelicolor', identity: 26.9, evalue: 0.004, evalueRaw: '4e-03', queryCoverage: 88, queryFrom: 20, queryTo: 107, hitFrom: 44, hitTo: 131, db: 'other' },
  { accession: 'Q8N4C6-2', description: 'Isoform 2 of Uncharacterized protein Cxorf51', organism: 'Homo sapiens', identity: 54.3, evalue: 1e-42, evalueRaw: '1e-42', queryCoverage: 285, queryFrom: 3, queryTo: 287, hitFrom: 5, hitTo: 289, db: 'sp' },
  { accession: 'H2QIS8', entryName: 'KLHL34_PANTR', description: 'Kelch-like protein 34', organism: 'Pan troglodytes', identity: 30.8, evalue: 9e-18, evalueRaw: '9e-18', queryCoverage: 158, queryFrom: 92, queryTo: 249, hitFrom: 122, hitTo: 279, db: 'tr' },
  { accession: 'XP_016868902.1', description: 'PREDICTED: uncharacterized protein LOC105371161 isoform X2', organism: 'Macaca fascicularis', identity: 28.4, evalue: 0.001, evalueRaw: '1e-03', queryCoverage: 140, queryFrom: 60, queryTo: 199, hitFrom: 80, hitTo: 219, db: 'other' },
  { accession: 'B4E0S5', description: 'cDNA FLJ61030, highly similar to Homo sapiens kelch-like 34', organism: 'Homo sapiens', identity: 29.7, evalue: 3e-16, evalueRaw: '3e-16', queryCoverage: 155, queryFrom: 95, queryTo: 249, hitFrom: 125, hitTo: 279, db: 'tr' },
]
const ctxA: ReportContext = {
  uniprot: null,
  sequence: 'MSGTNQSSVSEFLLLGLSRQPQQQHLLFVFFLSMYLATVLGNLLIILSVSIDSCLHTPMYFFLSNLSFVDICFSFTT',
  sequenceHeader: 'nr-fixture 构建样本',
  goal: '验证 BLAST nr 命中块渲染（v2.59）',
  goalHints: [],
  targetIdentity: ti,
  directPdbs: [] as PdbEntry[],
  blastHits: blast,
  blastStatus: { status: 'ok', note: '完成' },
  blastNrHits: nrHits,
  coverage: null,
  coverageText: '',
  gapText: '',
  literature: [],
  images: [],
  scores,
}
const ctxB: ReportContext = {
  ...ctxA,
  targetIdentity: {
    name: 'Olfactory receptor 1F1', source: 'blast-nr', sourceLabel: 'BLAST nr 识别', identity: 100,
    uniprotId: 'O43749', uniprotEntry: 'OR1F1_HUMAN', organism: 'Homo sapiens', geneName: 'OR1F1',
    note: 'BLAST nr 识别（一致性 100%）→ 已归属 UniProt O43749',
  },
  blastHits: [],
  blastStatus: { status: 'failed', note: 'NCBI pdbaa 队列超时' },
  blastNrHits: nrHits.slice(0, 6),
}

function assert(cond: boolean, msg: string): void {
  if (!cond) { console.error('ASSERT FAIL:', msg); process.exitCode = 1 }
  else console.log('ok -', msg)
}

async function main() {
  const htmlA = await renderReportHtml({
    ctx: ctxA,
    methodStats: { xrayCount: 2, cryoemCount: 0, nmrCount: 0, bestResolution: 2.1 },
    llmMarkdown: '## 执行摘要\n**nr 命中块渲染样例（场景 A：近似身份）。**',
    llmOk: true, llmErrors: [], jobId: 'sample_nr_a', durationMs: 42000, totalPdbFound: 0,
    engineSummary: 'sample-engine', resolveImagePath: () => '',
  })
  const htmlB = await renderReportHtml({
    ctx: ctxB,
    methodStats: { xrayCount: 0, cryoemCount: 0, nmrCount: 0, bestResolution: null },
    llmMarkdown: '## 执行摘要\n**nr 命中块渲染样例（场景 B：PDB 失败 + nr 兜底回填）。**',
    llmOk: true, llmErrors: [], jobId: 'sample_nr_b', durationMs: 88000, totalPdbFound: 0,
    engineSummary: 'sample-engine', resolveImagePath: () => '',
  })
  await fs.mkdir('/tmp/render', { recursive: true })
  await fs.writeFile('/tmp/render/nr-report-a.html', htmlA, 'utf-8')
  await fs.writeFile('/tmp/render/nr-report-b.html', htmlB, 'utf-8')
  console.log('written /tmp/render/nr-report-{a,b}.html', htmlA.length, htmlB.length)

  // ─── 场景 A 断言（v2.67：切换 + 双面板 + 全量 nr 表）───
  assert(htmlA.includes('class="lib-toggle"'), 'A: 库切换按钮容器')
  assert(htmlA.includes('PDB 库 · 2 同源结构'), 'A: PDB 库按钮文案与计数')
  assert(htmlA.includes('nr 全库 · 8 命中'), 'A: nr 库按钮文案与计数')
  assert(htmlA.includes('data-libpanel="pdb"'), 'A: PDB 面板标记')
  assert(htmlA.includes('<div data-libpanel="nr" hidden>'), 'A: nr 面板默认隐藏')
  assert((htmlA.match(/data-tbl="blastnr"/g) ?? []).length === 1, 'A: 单张 nr 表（全量，无折叠副表）')
  const tblA = htmlA.indexOf('data-tbl="blastnr"')
  const nrTableA = htmlA.slice(tblA, htmlA.indexOf('</table>', tblA))
  assert((nrTableA.match(/<tr /g) ?? []).length === 8, 'A: nr 表数据行 = 8（全量直出）')
  assert(!htmlA.slice(htmlA.indexOf('data-libpanel="nr"')).includes('<details class="fold">'), 'A: nr 面板内无折叠 details')
  assert(htmlA.includes('Homologs · 2 · nr 8'), 'A: 章节头计数含 nr 8')
  assert(htmlA.includes('href="https://www.uniprot.org/uniprotkb/Q8N4C6"'), 'A: sp 命中 UniProt 链接')
  assert(htmlA.includes('CXorf51_HUMAN'), 'A: entryName 副行')
  assert(htmlA.includes('Swiss-Prot</span>'), 'A: Swiss-Prot chip')
  assert(htmlA.includes('TrEMBL</span>'), 'A: TrEMBL chip')
  assert(htmlA.includes('nr 其他</span>'), 'A: nr 其他 chip')
  assert(htmlA.includes('WP_012345678.1'), 'A: other 命中编号原样（不链接）')
  assert(!htmlA.includes('href="https://www.uniprot.org/uniprotkb/WP_012345678.1"'), 'A: other 命中无 UniProt 链接')
  assert(nrTableA.includes('data-ident="54.3"'), 'A: nr 行携带排序属性 data-ident')
  // 切换 JS + CSS 注入（TABLE_FILTER_JS / TABLE_FILTER_CSS 携带 v2.67 逻辑）
  assert(htmlA.includes("querySelectorAll('.lib-toggle')"), 'A: 库切换 JS 已注入')
  assert(htmlA.includes('.lt-btn.lt-on'), 'A: 切换按钮 CSS 已注入')
  // ─── 场景 B 断言（PDB 失败 → nr 单独全量展示，无切换按钮）───
  assert(htmlB.includes('同源检索失败 — 本报告不含同源结构证据'), 'B: PDB 失败 callout 保留')
  assert(!htmlB.includes('class="lib-toggle"'), 'B: 无 PDB 命中 → 无切换按钮')
  assert(htmlB.includes('BLAST nr 全库检索'), 'B: nr 面板 h3 标题（单独展示）')
  assert(!htmlB.includes('data-libpanel='), 'B: 无面板标记（nr 直接展示）')
  assert(htmlB.includes('NCBI nr · 6 hits · 靶点身份识别'), 'B: 命中计数副标题（6 命中）')
  assert(htmlB.includes('Homologs · 0 · nr 6'), 'B: 章节头 Homologs · 0 · nr 6')
  const tblB = htmlB.indexOf('data-tbl="blastnr"')
  const nrTableB = htmlB.slice(tblB, htmlB.indexOf('</table>', tblB))
  assert((nrTableB.match(/<tr /g) ?? []).length === 6, 'B: nr 表数据行 = 6（全量直出）')
  // 场景 C：无 nrHits 时不应出现 nr 块（回归）
  const htmlC = await renderReportHtml({
    ctx: { ...ctxA, blastNrHits: undefined },
    methodStats: { xrayCount: 2, cryoemCount: 0, nmrCount: 0, bestResolution: 2.1 },
    llmMarkdown: '## 执行摘要\n**回归：无 nr 命中时不渲染 nr 块。**',
    llmOk: true, llmErrors: [], jobId: 'sample_nr_c', durationMs: 1000, totalPdbFound: 0,
    engineSummary: 'sample-engine', resolveImagePath: () => '',
  })
  assert(!htmlC.includes('class="nr-block"'), 'C: 无 blastNrHits 时不渲染 nr 块')
  assert(!htmlC.includes('nr-chip nr-chip-'), 'C: 无 nr chips 泄漏')
  // 注：lib-toggle/data-libpanel 字样存在于注入的 TABLE_FILTER_JS/CSS 文本中，
  // 断言须锚定 DOM 标记（class="…" / <div data-…），不能裸搜子串
  assert(!htmlC.includes('class="lib-toggle"'), 'C: 无 nr 命中 → 无切换按钮（DOM）')
  assert(!htmlC.includes('<div data-libpanel'), 'C: 无面板标记（DOM）')
  console.log(process.exitCode ? 'FIXTURE ASSERT FAILED' : 'ALL ASSERTS PASSED')
}
main().catch(e => { console.error(e); process.exit(1) })
