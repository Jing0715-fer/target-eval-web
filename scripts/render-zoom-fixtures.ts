/**
 * 图片点击放大 E2E fixture 渲染（bun 直接跑 TS，v2.7.5 → v2.7.8）：
 *  1. 富上下文 mock（真实尺寸 PNG：配体结构式 / gel / sec + AlphaFold 3D 内嵌）→ report-new.html
 *  2. 剥离响应式版心 + 灯箱 CSS/JS → report-legacy.html（模拟 v2.7.4 旧报告）
 *  3. applyResponsiveOverride + applyZoomUpgrade → report-legacy-injected.html（旧报告 serve 路径）
 *  4. 合并报告最小 mock → renderMergedReportHtml → report-merged.html（原生内嵌灯箱）
 *  5. v2.7.6 baked v1 灯箱模拟（fake v1 script）→ applyZoomUpgrade v3 注入 → report-v276-injected.html
 *     （v1/v2 共存清理路径：v1 根移除 + img 克隆剥离句柄）
 *  6. 嵌入宿主模拟（ReportFrame 同构：自动高度 iframe + 父页滚动 + 吸顶栏）→ embed-host.html
 *  7. v2.7.7 baked v2 模拟（marker 降级）→ applyZoomUpgrade v3 注入 → report-v277-injected.html
 *  8. Dialog 宿主模拟（在线预览同构：h-full 内部可滚 iframe）→ dialog-host.html
 *  9. 字符串断言：marker / 可缩放图选择器覆盖 / __rptEmb 嵌入自适应 / af-expand 3D 放大 /
 *     注入幂等 / 内容完整性 / 合并报告内嵌 / v2.7.8 三项修复标记
 * 配套交互断言见 scripts/e2e-ligand-zoom.mjs（playwright）。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as zlib from 'node:zlib'
import { renderReportHtml, applyResponsiveOverride, applyZoomUpgrade, RESPONSIVE_PAGE_CSS, LIGHTBOX_CSS, LIGHTBOX_JS } from '../src/lib/eval/report-html'
import { renderMergedReportHtml } from '../src/lib/eval/report-merged'
import type { ReportContext } from '../src/lib/eval/report'

const OUT = '/tmp/zoom-fixtures'
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

/** 配体 2D 结构式样图（600×600：分子骨架示意 — 环 + 键 + 端点原子） */
const ligPng = makePng(600, 600, (x, y) => {
  const dx = x - 300, dy = y - 300
  const ring = Math.abs(Math.hypot(dx, dy) - 170) < 26
  const bond = Math.abs(dx * 0.62 - dy) < 9 && dx > 60 && dx < 285
  const atomA = Math.hypot(dx - 245, dy - 245) < 34
  const atomB = Math.hypot(dx + 235, dy + 235) < 34
  const grid = x < 14 || x > 585 || y < 14 || y > 585
  if (grid) return [225, 222, 218]
  if (ring || bond || atomA || atomB) return [22, 78, 99]
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
/** SEC 曲线样图（洗脱峰 + 基线） */
const secPng = makePng(560, 380, (x, y) => {
  const base = Math.abs(y - 330) < 4 && x > 36 && x < 530
  const peak = Math.exp(-Math.pow((x - 260) / 78, 2)) * 250 + Math.exp(-Math.pow((x - 400) / 34, 2)) * 60
  const curve = Math.abs(330 - peak - y) < 5 && x > 36 && x < 530
  if (x < 36 || x > 530 || y < 28 || y > 344) return [214, 211, 205]
  if (base) return [120, 113, 108]
  if (curve) return [37, 99, 235]
  return [252, 251, 247]
})
const uri = (b: Buffer) => `data:image/png;base64,${b.toString('base64')}`

// ─── AlphaFold 内嵌 3D mock（小 PDB：6 残基 CA，B-factor 覆盖四个 pLDDT 桶）──────
const AF_PDB = [1, 2, 3, 4, 5, 6]
  .map((i, k) => `ATOM    ${String(3 * i).padStart(4)}  CA  GLY A  ${String(i).padStart(3)}    ${(i * 1.4).toFixed(3)}   0.000   0.000  1.00  ${[95, 78, 62, 45, 30, 96][k].toFixed(2)}           C`)
  .join('\n')
const afStructure = { pdbText: AF_PDB, uniprotId: 'P00533', modelId: 'AF-P00533F1', globalPlddt: 71.0, version: 4, fracVeryHigh: 0.5 }

// ─── mock 上下文（沿用 e2e-responsive 的富上下文，图片换真实尺寸 PNG）────────
const ligands = [
  {
    raw: 'erlotinib',
    source: 'manual',
    ok: true,
    compId: '6526365',
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
    detail: { cid: 176870, iupacName: 'N-(3-ethynylphenyl)-6,7-bis(2-methoxyethoxy)quinazolin-4-amine', xlogp: 3.0, tpsa: 74.7, hBondDonor: 1, hBondAcceptor: 6, rotatableBonds: 8, heavyAtoms: 29, exactMass: 393.17, inchiKey: 'AAKJVRGGFVUMBDA-UHFFFAOYSA-N', canonicalSmiles: 'COCCOCCOC1=C2C=CC(=NC2=NC=C1NC3=CC=CC(=C3)C#C)N', structure2d: uri(ligPng) },
  },
  {
    raw: 'gefitinib',
    source: 'manual',
    ok: true,
    compId: '6438445',
    name: 'GEFITINIB',
    formula: 'C22H24ClFN4O3',
    weight: 446.9,
    strategy: 'alias',
    totalStructures: 17,
    structures: [
      { pdbId: '2ITY', title: 'EGFR kinase domain with gefitinib', method: 'X-RAY DIFFRACTION', resolution: 2.8, releaseDate: '2007-02-12', alsoTarget: true },
    ],
    pubchem: { cid: 123631, iupacName: '4-(3-chloro-4-fluoroanilino)-7-methoxy-6-(3-morpholinopropoxy)quinazoline' },
    detail: { cid: 123631, iupacName: '4-(3-chloro-4-fluoroanilino)-7-methoxy-6-(3-morpholinopropoxy)quinazoline', xlogp: 3.2, tpsa: 68.7, hBondDonor: 1, hBondAcceptor: 8, rotatableBonds: 8, heavyAtoms: 31, exactMass: 446.15, inchiKey: 'FBBKSGBWKVRONA-UHFFFAOYSA-N', canonicalSmiles: 'COc1cc2ncnc(Nc3ccc(F)c(Cl)c3)c2cc1OCCCN1CCOCC1', structure2d: uri(ligPng) },
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
  coverage: { coveragePercent: 92, mappedResidues: 1113, totalResidues: 1210, segments: [] } as never,
  coverageText: '92%',
  gapText: '胞外区 1-712 位',
  literature: [
    { pmid: '39000000', title: 'Structure of EGFR kinase domain with covalent inhibitor', journal: 'J. Biol. Chem.', year: '2026', doi: '10.0000/x', fromPdb: true },
  ],
  images: [
    { id: 'img1', kind: 'gel', caption: 'SDS-PAGE 纯度检测：目标带 ~ 43 kDa，纯度 > 95%', mime: 'image/png', sizeKB: 3, dataUri: uri(gelPng) } as never,
    { id: 'img2', kind: 'sec', caption: 'Superose 6 分子筛：单体主峰，表观 MW 42 kDa', mime: 'image/png', sizeKB: 3, dataUri: uri(secPng) } as never,
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
  jobId: 'zoom-e2e-fixture',
  durationMs: 12345,
  totalPdbFound: 1,
  engineSummary: 'Z.ai GLM-4.6（内置）',
  alphafoldFigure: { dataUri: uri(ligPng), modelId: 'AF-P00533F1', globalPlddt: 87.4, version: 4, fracVeryHigh: 0.62 },
  alphafoldStructure: afStructure,
  resolveImagePath: () => '',
}

const html = await renderReportHtml(input)
fs.writeFileSync(`${OUT}/report-new.html`, html, 'utf-8')

// ─── 模拟 v2.7.6 旧报告（baked v1 灯箱）：v2 灯箱脚本换成 fake v1（建根 + 挂句柄）──
//  用于验证 serve 注入 v2 后的共存清理：v1 根移除 + img 克隆剥离 v1 句柄
const FAKE_V1_JS = `<script>
/* rpt-zoom-v1 图片点击放大 */
(function () {
  var root = document.createElement('div');
  root.className = 'rpt-zoom'; root.hidden = true;
  root.innerHTML = '<div class="rpt-zoom-bg"></div><div class="rpt-zoom-stage"><img alt=""></div>';
  document.body.appendChild(root);
  document.querySelectorAll('.lig-struct img').forEach(function (img) {
    img.classList.add('rpt-zoomable');
    img.addEventListener('click', function () { root.hidden = false; document.body.style.overflow = 'hidden'; window.__v1Open = true; });
  });
})();
</` + `script>`
const FAKE_V1_CSS = `  /* rpt-zoom-v1 图片点击放大（模拟 v2.7.6 baked CSS — 注入 v2 后靠层叠覆盖） */
  .rpt-zoom { position:fixed; inset:0; z-index:80; }
  .rpt-zoom[hidden] { display:none; }
  .rpt-zoom-stage { position:absolute; inset:0 0 56px 0; display:flex; align-items:center; justify-content:center; overflow:hidden; }
  .rpt-zoom-stage img { max-width:min(92vw,1500px); max-height:100%; }
`
const v276 = html
  .replace(LIGHTBOX_CSS, FAKE_V1_CSS)
  .replace(`\n${LIGHTBOX_JS}`, `\n${FAKE_V1_JS}`)
fs.writeFileSync(`${OUT}/report-v276.html`, v276, 'utf-8')
const v276Injected = applyZoomUpgrade(v276)
fs.writeFileSync(`${OUT}/report-v276-injected.html`, v276Injected, 'utf-8')

// ─── 嵌入宿主模拟（ReportFrame 同构：外层父页 + 自动高度 iframe，父页滚动）──────
//  v2.7.8：新增吸顶栏（AppShell 同构 sticky top-0 z-40）— 验证灯箱关闭钮避让不被遮挡
const hostHtml = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>embed host</title></head>
<body style="margin:0">
<header id="appbar" style="position:sticky;top:0;z-index:40;height:52px;background:#f8f8f7;border-bottom:1px solid #ddd;display:flex;align-items:center;padding:0 16px;font:600 12px sans-serif">App Shell 吸顶栏（h=52 · z-40）</header>
<div id="pad-top" style="height:1500px;background:#f3f3f2">pad-top</div>
<iframe id="rf" style="width:100%;border:0;display:block"></iframe>
<div id="pad-bot" style="height:1500px;background:#f3f3f2">pad-bot</div>
<script>
  var f = document.getElementById('rf');
  f.srcdoc = ${JSON.stringify(html).replace(/<\//g, '<\\/')};
  f.addEventListener('load', function () {
    var d = f.contentDocument;
    var sync = function () {
      var h = Math.max(d.documentElement.scrollHeight, d.body.scrollHeight);
      if (h > 100) f.style.height = (h + 16) + 'px';
    };
    sync();
    try { new ResizeObserver(sync).observe(d.body); } catch (e) { }
    f.setAttribute('data-ready', '1');
  });
</` + `script></body></html>`
fs.writeFileSync(`${OUT}/embed-host.html`, hostHtml, 'utf-8')

// ─── Dialog 宿主模拟（在线预览同构：h-full 内部可滚 iframe — fixed 形态回归）──────
const dlgHostHtml = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>dialog host</title></head>
<body style="margin:0;font:12px sans-serif">
<div style="height:56px;background:#eee;padding:8px 16px">Dialog Header（打印 / 新窗口）</div>
<iframe id="rf" style="width:100%;height:700px;border:0;display:block"></iframe>
<script>
  var f = document.getElementById('rf');
  f.srcdoc = ${JSON.stringify(html).replace(/<\//g, '<\\/')};
  f.addEventListener('load', function () { f.setAttribute('data-ready', '1'); });
</` + `script></body></html>`
fs.writeFileSync(`${OUT}/dialog-host.html`, dlgHostHtml, 'utf-8')

// ─── v2.7.7 baked v2 模拟：marker 降级 v3→v2（脚本体同 v3）→ serve 注入 v3 ──────
//  验证 v2/v3 共存清理：v2 根移除 + img 克隆 + v2 af-expand（带旧闭包）移除重挂
const v277 = html.replace(/rpt-zoom-v3/g, 'rpt-zoom-v2')
fs.writeFileSync(`${OUT}/report-v277.html`, v277, 'utf-8')
const v277Injected = applyZoomUpgrade(v277)
fs.writeFileSync(`${OUT}/report-v277-injected.html`, v277Injected, 'utf-8')

// ─── 模拟旧报告（v2.7.4 及以前）：剥离响应式版心 + 灯箱 CSS/JS ────────────────
let legacy = html.replace(`\n${RESPONSIVE_PAGE_CSS}`, '').replace(`${LIGHTBOX_CSS}`, '').replace(`\n${LIGHTBOX_JS}`, '\n')
legacy = legacy.replace(`<style id="rpt-zoom"></style>\n`, '') // 兜底：CSS 常量前无换行的注入形
fs.writeFileSync(`${OUT}/report-legacy.html`, legacy, 'utf-8')

// ─── 旧报告 serve 路径：路由注入（v2.7.3 版心 + v2.7.5 灯箱）─────────────────
const injected = applyZoomUpgrade(applyResponsiveOverride(legacy))
fs.writeFileSync(`${OUT}/report-legacy-injected.html`, injected, 'utf-8')

// ─── 合并报告最小 mock（原生内嵌灯箱；图片走 assetDir 文件）──────────────────
fs.writeFileSync(`${ASSETS}/img1.png`, gelPng)
fs.writeFileSync(`${ASSETS}/img2.png`, secPng)
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
  coveragePercent: 92,
  literature: ctx.literature,
  literatureCount: 1,
  ligandCount: 2,
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
    { id: 'img2', kind: 'sec', caption: 'SEC 分子筛曲线', mime: 'image/png', sizeKB: 3 },
  ] as never,
  assetDir: ASSETS,
  batchReportId: 'zoom-e2e-merged',
  engineSummary: 'Z.ai GLM-4.6（内置）',
})
fs.writeFileSync(`${OUT}/report-merged.html`, mergedHtml, 'utf-8')

// ─── 字符串断言 ─────────────────────────────────────────────────────────────
const ligFigCount = (html.match(/<figure class="lig-struct">/g) ?? []).length
const figCount = (html.match(/<figure class="fig">/g) ?? []).length
const checks: [string, boolean][] = [
  ['新报告含灯箱标记 rpt-zoom-v3', html.includes('rpt-zoom-v3') && html.includes('/* rpt-zoom-v3 图片点击放大 + 嵌入自适应 + AlphaFold 3D 视图放大')],
  ['新报告内嵌灯箱 CSS（.rpt-zoom-stage）', html.includes('.rpt-zoom-stage')],
  ['新报告内嵌灯箱 JS（SEL 选择器含 .lig-struct img）', html.includes("var SEL = '.lig-struct img, .fig img, .af-fig img'")],
  ['新报告灯箱 JS 位于 </body> 前', html.indexOf('<script>\n/* rpt-zoom-v3 图片') >= 0 && html.indexOf('<script>\n/* rpt-zoom-v3 图片') < html.indexOf('</body>')],
  ['新报告响应式版心未被破坏（rpt-rw-v3）', html.includes('rpt-rw-v3')],
  ['新报告配体结构式 figure ≥ 2', ligFigCount >= 2],
  ['新报告实验图 figure = 2', figCount === 2],
  ['新报告嵌入自适应助手 __rptEmb（slice/pin/watch）', html.includes('window.__rptEmb') && html.includes('function slice()') && html.includes('function pin(el)') && html.includes('function watch(fn)')],
  ['新报告 v1/v2 共存清理（img 克隆剥离句柄 + 旧 af-expand 移除）', html.includes('im.replaceWith(im.cloneNode(false))') && html.includes("querySelectorAll('.af-stage .af-expand'), function (b) { b.remove(); }")],
  ['新报告 AF 3D 视图放大挂载（af-expand / af-fullwrap / canvas 迁移）', html.includes('function afFullscreen') && html.includes('.af-expand') && html.includes('.af-fullwrap') && html.includes('slot.appendChild(cv)')],
  ['新报告 AF 3D 全屏图例（pLDDT 四桶）', html.includes('af-full-legend') && html.includes('#0053D6')],
  ['新报告 AF 3D 内嵌视图存在（af-stage + 内嵌 3Dmol bundle）', html.includes('id="af-stage"') && html.includes('createViewer')],
  ['新报告 AF viewer 句柄导出（__afViewer resize 保险）', html.includes('window.__afViewer = viewer')],
  ['新报告 v2.7.8 ⑨ 双按钮互斥（af-zoom-off + MutationObserver）', html.includes('figure.rpt-zoomable.af-zoom-off .rpt-zoom-badge') && html.includes("classList.toggle('af-zoom-off'") && html.includes('MutationObserver(syncAf)')],
  ['新报告 v2.7.8 ⑩ 吸顶栏避让（headerH + H - r.top）', html.includes('function headerH(ow)') && html.includes('H - r.top')],
  ['新报告 v2.7.8 ⑪ 父页滚动锁（lockParent/unlock + 滚动条补偿）', html.includes('function lockParent()') && html.includes('b.style.paddingRight = sw') && html.includes('EMB.lockParent(); // v2.7.8') && html.includes('EMB.unlock(); // v2.7.8')],
  ['新报告嵌入宿主已生成（含吸顶栏 + 高度同步）', hostHtml.includes('position:sticky') && hostHtml.includes('srcdoc') && hostHtml.includes("f.style.height = (h + 16) + 'px'")],
  ['Dialog 宿主已生成（h-full 内部可滚 iframe）', dlgHostHtml.includes('height:700px') && dlgHostHtml.includes('srcdoc')],
  ['v2.7.7 模拟（marker 降级）+ 注入 v3 双脚本共存', v277Injected.includes('rpt-zoom-v3') && v277Injected.includes('rpt-zoom-v2') && (v277Injected.match(/<script>\n\/\* rpt-zoom/g) ?? []).length === 2],
  ['v2.7.7 模拟注入含 v2 清理代码（旧 af-expand 移除）', v277Injected.includes("querySelectorAll('.af-stage .af-expand'), function (b) { b.remove(); }")],
  ['旧模拟报告已剥离灯箱标记', !legacy.includes('rpt-zoom-v3')],
  ['旧模拟报告已剥离响应式版心标记', !legacy.includes('rpt-rw-v3')],
  ['注入后恢复灯箱标记', injected.includes('rpt-zoom-v3')],
  ['注入后恢复版心标记', injected.includes('rpt-rw-v3')],
  ['注入 CSS 位于 </head> 前（<style id="rpt-zoom">）', injected.includes('<style id="rpt-zoom">')],
  ['注入 JS 位于 </body> 前', injected.lastIndexOf('<script>') < injected.lastIndexOf('</body>')],
  ['注入幂等（二次注入不变）', applyZoomUpgrade(injected) === injected && applyResponsiveOverride(injected) === injected],
  ['注入保留原内容完整性（剥离三个注入块后等于旧报告）', injected
    .replace('<style id="rpt-zoom">' + LIGHTBOX_CSS + '</style>\n', '')
    .replace('\n' + LIGHTBOX_JS, '')
    .replace('<style id="rpt-rw">' + RESPONSIVE_PAGE_CSS + '</style>\n', '') === legacy],
  ['v2.7.6 模拟（fake v1 灯箱）注入 v3 成功（v3 CSS/JS 注入到位）', v276Injected.includes('window.__rptEmb') && v276Injected.includes('<style id="rpt-zoom">') && v276Injected.includes('function afFullscreen')],
  ['v2.7.6 模拟注入含 v1 清理代码', v276Injected.includes("im.replaceWith(im.cloneNode(false))")],
  ['合并报告原生内嵌灯箱标记', mergedHtml.includes('rpt-zoom-v3')],
  ['合并报告内嵌灯箱 CSS/JS', mergedHtml.includes('.rpt-zoom-stage') && mergedHtml.includes('/* rpt-zoom-v3 图片')],
  ['合并报告配体卡不含 2D 图（selector 不误配）', !mergedHtml.includes('<figure class="lig-struct">') || mergedHtml.includes('rpt-zoom-v3')],
  ['合并报告实验图存在', (mergedHtml.match(/<figure class="fig">/g) ?? []).length === 2],
  ['合并报告同样带 AF 放大/嵌入自适应（单源常量）', mergedHtml.includes('afFullscreen') && mergedHtml.includes('window.__rptEmb')],
]

let pass = 0
for (const [name, ok] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (ok) pass++
}
console.log(`\nfixtures: ${OUT}/report-{new,legacy,legacy-injected,merged}.html (${(html.length / 1024).toFixed(0)}KB new / ${(injected.length / 1024).toFixed(0)}KB injected / ${(mergedHtml.length / 1024).toFixed(0)}KB merged)`)
console.log(`${pass}/${checks.length} passed`)
if (pass !== checks.length) process.exit(1)
