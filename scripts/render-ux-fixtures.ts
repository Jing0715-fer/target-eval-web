/**
 * 报告六项优化 E2E fixture 渲染（bun 直接跑 TS，v2.7.6）：
 *  1. 富上下文 mock（含 SVG/PNG 两种配体结构式 + PDBe 覆盖区间）→ renderReportHtml
 *     → report-new.html（覆盖率 SVG 轨道 + A4 打印 CSS + UX JS 原生内嵌）
 *  2. 剥离全部升级块（响应式/灯箱/打印/UX）→ report-legacy.html（模拟 v2.7.4 旧报告）
 *  3. applyResponsiveOverride + applyZoomUpgrade + applyUxUpgrade → report-legacy-injected.html
 *  4. 合并报告 mock（含无 detail 旧作业配体；fetch 全灭模拟离线）→ report-merged.html
 *     （配体卡补 2D 图：detail 完整的直接渲染；无 detail 的离线充实失败优雅降级）
 *  5. 字符串断言：标记 / 覆盖率 SVG 内容 / SVG-PNG 优先级 / 复制行 / 注入幂等 / 内容完整性
 * 配套交互断言见 scripts/e2e-report-ux.mjs（playwright：复制按钮/横滚指示/打印仿真）。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as zlib from 'node:zlib'
import { renderReportHtml, applyResponsiveOverride, applyZoomUpgrade, applyUxUpgrade, RESPONSIVE_PAGE_CSS, LIGHTBOX_CSS, LIGHTBOX_JS, PRINT_PAGE_CSS, UX_PAGE_CSS, UX_PAGE_JS } from '../src/lib/eval/report-html'
import { renderMergedReportHtml } from '../src/lib/eval/report-merged'
import type { ReportContext } from '../src/lib/eval/report'

const OUT = '/tmp/ux-fixtures'
const ASSETS = `${OUT}/assets`
fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(ASSETS, { recursive: true })

// ─── 确定性 PNG 生成（node:zlib，无外部依赖）──────────────────────────────────
function crc32(buf: Buffer): number {
  const table: number[] = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  let crc = 0xffffffff
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
function pngChunk(type: string, data: Buffer): Buffer {
  const t = Buffer.from(type, 'ascii')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0)
  return Buffer.concat([len, t, data, crc])
}
function makePng(w: number, h: number, draw: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = Buffer.alloc(h * (1 + w * 3))
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 3)
    raw[row] = 0
    for (let x = 0; x < w; x++) {
      const [r, g, b] = draw(x, y)
      raw[row + 1 + x * 3] = r
      raw[row + 2 + x * 3] = g
      raw[row + 3 + x * 3] = b
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2 // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** 配体 2D 结构式样图（600×600 位图 — PNG 回落分支） */
const ligPng = makePng(600, 600, (x, y) => {
  const dx = x - 300, dy = y - 300
  const ring = Math.abs(Math.hypot(dx, dy) - 170) < 26
  const bond = Math.abs(dx * 0.62 - dy) < 9 && dx > 60 && dx < 285
  if (x < 14 || x > 585 || y < 14 || y > 585) return [225, 222, 218]
  if (ring || bond) return [22, 78, 99]
  return [255, 255, 255]
})
/** SDS-PAGE 样图（胶孔 + 梯度条带） */
const gelPng = makePng(420, 560, (x, y) => {
  const lanes = x > 40 && x < 380
  const bands = [120, 178, 236, 294, 352, 410, 468]
  const inBand = bands.some((b) => y > b && y < b + 18 + (b % 3) * 6)
  const well = y > 28 && y < 66 && lanes && (x - 40) % 56 < 40
  if (y < 24 || x < 24 || x > 396 || y > 536) return [70, 70, 74]
  if (well) return [30, 30, 34]
  if (lanes && inBand) return [52, 46, 40]
  return [250, 248, 244]
})
const uri = (b: Buffer) => `data:image/png;base64,${b.toString('base64')}`

/** 配体 2D 结构式样图（SVG 矢量 — 优先分支：环 + 键 + 端点原子） */
const ligSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300"><rect width="300" height="300" fill="#ffffff"/><circle cx="150" cy="150" r="62" fill="none" stroke="#16525e" stroke-width="7"/><circle cx="228" cy="150" r="40" fill="none" stroke="#16525e" stroke-width="6"/><path d="M212 150 H190" stroke="#16525e" stroke-width="6"/><path d="M268 150 H285" stroke="#16525e" stroke-width="5"/><circle cx="150" cy="88" r="9" fill="#16525e"/><text x="132" y="72" font-size="18" fill="#16525e">N</text></svg>`
const svgUri = `data:image/svg+xml;base64,${Buffer.from(ligSvg, 'utf-8').toString('base64')}`

// ─── mock 上下文（EGFR：激酶区覆盖 713-979，胞外区/尾部未覆盖 — 典型真实形态）──
const ligands = [
  {
    raw: 'erlotinib',
    source: 'manual',
    ok: true,
    compId: '394', // erlotinib 真实 PDB 化学组分 ID（RCSB CCD 3/394.svg）
    name: 'ERLOTINIB',
    formula: 'C22H23N3O4',
    weight: 393.44,
    strategy: 'pubchem',
    totalStructures: 24,
    structures: [
      { pdbId: '4HJO', title: 'EGFR kinase domain with erlotinib', method: 'X-RAY DIFFRACTION', resolution: 2.0, releaseDate: '2012-12-12', alsoTarget: true },
      { pdbId: '1M17', title: 'EGFR tyrosine kinase domain with erlotinib', method: 'X-RAY DIFFRACTION', resolution: 2.6, releaseDate: '2002-04-03', alsoTarget: true },
    ],
    pubchem: { cid: 176870, iupacName: 'N-(3-ethynylphenyl)-6,7-bis(2-methoxyethoxy)quinazolin-4-amine' },
    // v2.7.6：SVG 矢量结构式（优先分支）
    detail: { cid: 176870, iupacName: 'N-(3-ethynylphenyl)-6,7-bis(2-methoxyethoxy)quinazolin-4-amine', xlogp: 3.0, tpsa: 74.7, hBondDonor: 1, hBondAcceptor: 6, rotatableBonds: 8, heavyAtoms: 29, exactMass: 393.17, inchiKey: 'AAKJLRGGTJKAMG-UHFFFAOYSA-N', canonicalSmiles: 'COCCOCCOC1=C2C=CC(=NC2=NC=C1NC3=CC=CC(=C3)C#C)N', structure2dSvg: svgUri },
  },
  {
    raw: 'gefitinib',
    source: 'manual',
    ok: true,
    compId: 'IRE', // gefitinib 真实 PDB 化学组分 ID（RCSB CCD I/IRE.svg）
    name: 'GEFITINIB',
    formula: 'C22H24ClFN4O3',
    weight: 446.9,
    strategy: 'alias',
    totalStructures: 17,
    structures: [
      { pdbId: '2ITY', title: 'EGFR kinase domain with gefitinib', method: 'X-RAY DIFFRACTION', resolution: 2.8, releaseDate: '2007-02-12', alsoTarget: true },
    ],
    pubchem: { cid: 123631, iupacName: '4-(3-chloro-4-fluoroanilino)-7-methoxy-6-(3-morpholinopropoxy)quinazoline' },
    // PNG-only（SVG 通道失败的回落分支）
    detail: { cid: 123631, iupacName: '4-(3-chloro-4-fluoroanilino)-7-methoxy-6-(3-morpholinopropoxy)quinazoline', xlogp: 3.2, tpsa: 68.7, hBondDonor: 1, hBondAcceptor: 8, rotatableBonds: 8, heavyAtoms: 31, exactMass: 446.15, inchiKey: 'FBBKSGBWKVRONA-UHFFFAOYSA-N', canonicalSmiles: 'COc1cc2ncnc(Nc3ccc(F)c(Cl)c3)c2cc1OCCCN1CCOCC1', structure2d: uri(ligPng) },
  },
  {
    raw: 'resmetirom',
    source: 'eval-table',
    ok: true,
    compId: '',
    name: 'RESMETIROM',
    formula: 'C17H12Cl2N6O4',
    weight: 435.2,
    strategy: 'pubchem',
    totalStructures: 0,
    structures: [],
    pubchem: { cid: 15981237, iupacName: '2-[3,5-dichloro-4-(5-isopropyl-2-methoxy-3-pyridyl)oxyphenyl]acetamide' },
    // 无 detail（模拟 v2.7 前旧作业 — 合并报告渲染时离线充实失败优雅降级）
  },
]

const ctx = {
  uniprot: {
    uniprotId: 'P00533',
    entryName: 'EGFR_HUMAN',
    proteinName: 'Epidermal growth factor receptor',
    geneNames: ['EGFR', 'ERBB1'],
    organism: 'Homo sapiens',
    sequenceLength: 1210,
    sequence: 'M'.repeat(100),
    features: [{ type: 'TRANSMEM', location: { start: { position: 646 }, end: { position: 668 } } }],
  },
  sequence: 'M'.repeat(100),
  goal: '客户希望获得 EGFR 激酶区与新型抑制剂的复合物结构',
  goalHints: [],
  directPdbs: [
    { pdbId: 'A1B6E', method: 'X-RAY DIFFRACTION', resolution: 1.85, title: 'EGFR kinase domain in complex with a strain-release covalent inhibitor', releaseDate: '2026-01-01', ligands: ['Erlotinib'], journal: 'J. Biol. Chem.', doi: '10.0000/x', pubmedId: '39000000', organisms: ['Homo sapiens'], isXray: true, isCryoem: false, isNmr: false },
  ],
  blastHits: [
    { pdbId: '7XYZ1', description: 'EGFR homolog from Mus musculus, kinase domain with inhibitor', identity: 92.5, evalueRaw: '2e-180', evalue: 2e-180, queryCoverage: 267, method: 'X-RAY DIFFRACTION', resolution: 2.0 },
  ],
  // v2.7.6 ④：PDBe 覆盖区间（真实形状 coveredRanges — EGFR 激酶区 713-979 覆盖）
  coverage: { coveragePercent: 22.1, mappings: [], coveredRanges: [[713, 979]] },
  coverageText: '713-979 (267 aa)',
  gapText: '1-712 (712 aa), 980-1210 (231 aa)',
  literature: [
    { pmid: '39000000', title: 'Structure of EGFR kinase domain with covalent inhibitor', journal: 'J. Biol. Chem.', year: '2026', doi: '10.0000/x', fromPdb: true },
  ],
  images: [
    { id: 'img1', kind: 'gel', caption: 'SDS-PAGE 纯度检测：目标带 ~ 43 kDa，纯度 > 95%', mime: 'image/png', sizeKB: 3, dataUri: uri(gelPng) } as never,
  ],
  scores: {
    xray: { score: 9, maxScore: 10, rating: '优' },
    cryoem: { score: 8, maxScore: 10, rating: '良' },
    nmr: { score: 3, maxScore: 10, rating: '差' },
    overall: { score: 8, maxScore: 10, rating: '良' },
    rationale: { xray: '大量高分辨率结构', cryoem: '有全长结构先例', nmr: '蛋白过大', overall: '综合优' },
    oligomerAdjust: { label: '同源二聚体', stoichiometry: '2 × 相同亚基', confidence: 'high', xray: 0, cryoem: 1, nmr: 0, note: '同源二聚组装使有效分子量倍增' } as never,
  },
  ligands: ligands as never,
  alphafold: { available: true, modelId: 'AF-P00533F1', globalPlddt: 87.4, fracVeryHigh: 0.62, latestVersion: 4 } as never,
} as unknown as ReportContext

const input = {
  ctx,
  methodStats: { xrayCount: 1, cryoemCount: 0, nmrCount: 0, bestResolution: 1.85 } as never,
  llmMarkdown: '## 执行摘要\n**EGFR 激酶区结构解析可行性高**，X-ray 已有 1.85 Å 共晶先例。',
  llmOk: true,
  llmErrors: [],
  jobId: 'ux-e2e-fixture',
  durationMs: 12345,
  totalPdbFound: 1,
  engineSummary: 'Z.ai GLM-4.6（内置）',
  alphafoldFigure: { dataUri: uri(ligPng), modelId: 'AF-P00533F1', globalPlddt: 87.4, version: 4, fracVeryHigh: 0.62 },
  resolveImagePath: () => '',
}

const html = await renderReportHtml(input)
fs.writeFileSync(`${OUT}/report-new.html`, html, 'utf-8')

// ─── 模拟旧报告（v2.7.4 及以前）：剥离响应式版心 + 灯箱 + 打印/UX 升级块 ──────
let legacy = html.replace(`\n${RESPONSIVE_PAGE_CSS}`, '').replace(`${LIGHTBOX_CSS}`, '').replace(`\n${LIGHTBOX_JS}`, '\n')
legacy = legacy.replace(`${PRINT_PAGE_CSS}`, '').replace(`${UX_PAGE_CSS}`, '').replace(`\n${UX_PAGE_JS}`, '\n')
legacy = legacy.replace(`<style id="rpt-zoom"></style>\n`, '') // 兜底：CSS 常量前无换行的注入形
// 覆盖率区段图是服务端渲染的 body HTML — 真实旧报告不存在，一并剥离（含首尾空白行）
legacy = legacy.replace(/\n  <figure class="cov-fig"[\s\S]*?<\/figure>\n/, '\n')
fs.writeFileSync(`${OUT}/report-legacy.html`, legacy, 'utf-8')

// ─── 旧报告 serve 路径：路由注入（版心 + 灯箱 + A4 打印/复制/横滚）─────────────
const injected = applyUxUpgrade(applyZoomUpgrade(applyResponsiveOverride(legacy)))
fs.writeFileSync(`${OUT}/report-legacy-injected.html`, injected, 'utf-8')

// ─── 合并报告 mock（fetch 全灭 — 无 detail 配体离线充实失败优雅降级）───────────
fs.writeFileSync(`${ASSETS}/img1.png`, gelPng)
// v2.7.6 预置 IRE 磁盘缓存（模拟历史渲染已下载的 CCD 描述）：合并报告的
// PNG-only 详情配体经 ensureLigand2dVector 回补 SVG 时应命中磁盘而非网络 ——
// 预置后本用例对「fetch 全灭仍能回补」具备确定性（跑完还原现场）
const IRE_CACHE = 'db/cache/ligand2d/IRE.svg'
fs.mkdirSync('db/cache/ligand2d', { recursive: true })
const prevIRE = fs.existsSync(IRE_CACHE) ? fs.readFileSync(IRE_CACHE, 'utf-8') : null
fs.writeFileSync(IRE_CACHE, ligSvg.length > 200 ? ligSvg : ligSvg + '<!-- pad -->'.repeat(3), 'utf-8')
const realFetch = globalThis.fetch
globalThis.fetch = (() => Promise.reject(new Error('offline fixture'))) as typeof fetch
try {
  const tgt = {
    jobId: 'job-egfr',
    label: 'EGFR',
    uniprotId: 'P00533',
    proteinName: 'Epidermal growth factor receptor',
    geneNames: ['EGFR'],
    organism: 'Homo sapiens',
    sequenceLength: 1210,
    scores: ctx.scores,
    methodStats: { xrayCount: 1, cryoemCount: 0, nmrCount: 0, bestResolution: 1.85 },
    directPdbs: ctx.directPdbs,
    blastHits: ctx.blastHits,
    coveragePercent: 22.1,
    literature: ctx.literature,
    literatureCount: 1,
    ligandCount: 3,
    durationMs: 8000,
    ligands: ligands as never,
  }
  const mergedHtml = await renderMergedReportHtml({
    targets: [tgt, { ...tgt, jobId: 'job-erbb2', label: 'ERBB2', uniprotId: 'P04626', proteinName: 'Receptor tyrosine-protein kinase erbB-2', directPdbs: [], blastHits: [], literature: [], literatureCount: 0, ligandCount: 0, coveragePercent: 0, ligands: [] }] as never,
    relation: { related: true, relationType: 'homologous' as never, confidence: 'high', rationale: 'EGFR 家族成员，激酶域高度同源。', strategy: '共表达复合物或分别解析后比对。' },
    goal: '家族激酶区复合物结构',
    markdown: '# 合并评估\n两靶点激酶域结构可行性高，建议分子置换路线。',
    title: 'EGFR / ERBB2 家族合并评估',
    llmOk: true,
    llmErrors: [],
    images: [
      { id: 'img1', kind: 'gel', caption: 'SDS-PAGE 纯度检测', mime: 'image/png', sizeKB: 3 },
    ] as never,
    assetDir: ASSETS,
    batchReportId: 'ux-e2e-merged',
    engineSummary: 'Z.ai GLM-4.6（内置）',
  })
  fs.writeFileSync(`${OUT}/report-merged.html`, mergedHtml, 'utf-8')
  var mergedHtmlOut = mergedHtml
} finally {
  globalThis.fetch = realFetch
  // 还原磁盘缓存现场（预置 mock 前的真实内容或无缓存）
  if (prevIRE !== null) fs.writeFileSync(IRE_CACHE, prevIRE)
  else fs.rmSync(IRE_CACHE, { force: true })
}

// ─── 字符串断言 ─────────────────────────────────────────────────────────────
const svgFigCount = (html.match(/data:image\/svg\+xml;base64,/g) ?? []).length
const covSvgCount = (html.match(/<svg viewBox="0 0 820 64"/g) ?? []).length
const identRows = (html.match(/<div><b>InChIKey<\/b>/g) ?? []).length
const smilesRows = (html.match(/<div><b>Canonical SMILES<\/b>/g) ?? []).length
const mergedSvgFigs = (mergedHtmlOut.match(/data:image\/svg\+xml;base64,/g) ?? []).length
const mergedPngFigs = (mergedHtmlOut.match(/<figure class="lig-struct">/g) ?? []).length
const checks: [string, boolean][] = [
  // ① A4 打印
  ['新报告含 A4 打印标记 rpt-pr-v1 与 @page', html.includes('rpt-pr-v1') && html.includes('@page { size: A4; margin: 12mm 10mm 14mm; }')],
  ['打印分页避让 + 表格自动布局在打印块内', /@media print[\s\S]*break-after: avoid-page[\s\S]*table-layout: auto !important/.test(html)],
  ['打印隐藏复制按钮/角标', /@media print[\s\S]*\.copy-btn, \.rpt-zoom-badge, \.backtop \{ display: none !important; \}/.test(html)],
  // ② SVG 矢量结构式
  ['配体 1 结构式为 SVG data URI（data:image/svg+xml）', svgFigCount >= 1],
  ['配体 1 figcaption 标注 SVG 矢量', html.includes('SVG 矢量（缩放不失真）')],
  ['配体 2 PNG 回落仍在（不含矢量标注计 2 处 cid）', html.includes('CID 123631')],
  // ③ 一键复制（JS 自挂按钮 + 标识符行）
  ['标识符行：InChIKey ≥ 2 / SMILES ≥ 2', identRows >= 2 && smilesRows >= 2],
  ['UX JS 含复制挂载与 clipboard 降级', html.includes('rpt-ux-v1') && html.includes('legacyCopy') && html.includes("data-copy")],
  ['标识符折叠 summary 提示可一键复制', html.includes('结构标识符（InChIKey / SMILES · 可一键复制）')],
  // ④ 覆盖率区段图
  ['覆盖率 SVG 轨道存在（viewBox 820×64）', covSvgCount === 1],
  ['覆盖率刻度标签（1 与 1210）', html.includes('>COVERAGE MAP · 1210 aa</text>') && html.includes('text-anchor="end" font-size="9.5" font-family="JetBrains Mono,ui-monospace,Menlo,monospace" fill="#a8a29e">1210')],
  ['覆盖段 713-979 绿色 rect + 悬停 title', html.includes('<title>713-979 · 267 aa 已覆盖</title>')],
  ['未覆盖段 1-712 琥珀 rect + 悬停 title', html.includes('<title>1-712 · 712 aa 未覆盖</title>')],
  ['figcaption 汇总：22.1% · 未覆盖 2 段', html.includes('结构覆盖率 22.1%') && html.includes('未覆盖 2 段（琥珀）1-712、980-1210')],
  ['.cov-fig CSS 存在', html.includes('.cov-fig svg { display: block;')],
  // ⑥ 横滚指示
  ['横滚指示 CSS（rw-right/rw-left 渐变）', html.includes('.tbl-wrap.rw-right::after, .tbl-wrap.rw-left::before')],
  ['横滚指示 JS（scrollWidth 检测）', html.includes('w.scrollWidth - w.clientWidth > 4')],
  // 结构完整性
  ['UX JS 位于 </body> 前（新报告）', html.indexOf('/* rpt-ux-v1 InChIKey/SMILES') > 0 && html.indexOf('/* rpt-ux-v1 InChIKey/SMILES') < html.indexOf('</body>')],
  ['响应式版心 + 灯箱未被破坏（rpt-rw-v3 / rpt-zoom-v1）', html.includes('rpt-rw-v3') && html.includes('rpt-zoom-v1')],
  // 旧报告注入路径
  ['旧模拟报告已剥离全部升级标记', !legacy.includes('rpt-ux-v1') && !legacy.includes('rpt-pr-v1') && !legacy.includes('rpt-zoom-v1') && !legacy.includes('rpt-rw-v3')],
  ['注入后恢复 UX/打印/灯箱/版心标记', injected.includes('rpt-ux-v1') && injected.includes('rpt-pr-v1') && injected.includes('rpt-zoom-v1') && injected.includes('rpt-rw-v3')],
  ['注入含 UX JS 与复制挂载', injected.includes('legacyCopy') && injected.includes("querySelectorAll('.lig-ident')")],
  ['注入幂等（applyUxUpgrade 二次不变）', applyUxUpgrade(injected) === injected && applyZoomUpgrade(injected) === injected && applyResponsiveOverride(injected) === injected],
  ['注入保留内容完整性（剥离三个注入块后等于旧报告）', injected
    .replace('<style id="rpt-zoom">' + LIGHTBOX_CSS + '</style>\n', '')
    .replace('\n' + LIGHTBOX_JS, '')
    .replace('<style id="rpt-rw">' + RESPONSIVE_PAGE_CSS + '</style>\n', '')
    .replace('<style id="rpt-ux">' + PRINT_PAGE_CSS + UX_PAGE_CSS + '</style>\n', '')
    .replace('\n' + UX_PAGE_JS, '') === legacy],
  // ⑤ 合并报告（gefitinib 配体 PNG-only 详情 + 预置 IRE 磁盘缓存 + fetch 全灭 → 回补 SVG）
  ['合并报告配体卡含 2D 结构式 figure ≥ 2（回补后全 SVG）', mergedPngFigs >= 2 && mergedSvgFigs >= 2],
  ['合并报告配体卡含标识符折叠行', (mergedHtmlOut.match(/<div><b>InChIKey<\/b>/g) ?? []).length >= 2],
  ['合并报告含性质 chips（XLogP）', mergedHtmlOut.includes('XLogP')],
  ['合并报告原生内嵌 UX/打印 CSS+JS', mergedHtmlOut.includes('rpt-ux-v1') && mergedHtmlOut.includes('rpt-pr-v1') && mergedHtmlOut.includes('legacyCopy')],
  ['合并报告离线降级：无 detail 配体无结构图但不报错', !mergedHtmlOut.includes('RESMETIROM</span>\n        </div>\n        <div class="lig-main">\n        <figure')],
  ['合并报告策略中文标签（PubChem 而非裸 strategy）', mergedHtmlOut.includes('· PubChem')],
]

let pass = 0
for (const [name, ok] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (ok) pass++
}
console.log(`\nfixtures: ${OUT}/report-{new,legacy,legacy-injected,merged}.html (${(html.length / 1024).toFixed(0)}KB new / ${(injected.length / 1024).toFixed(0)}KB injected / ${(mergedHtmlOut.length / 1024).toFixed(0)}KB merged)`)
console.log(`${pass}/${checks.length} passed`)
if (pass !== checks.length) process.exit(1)
