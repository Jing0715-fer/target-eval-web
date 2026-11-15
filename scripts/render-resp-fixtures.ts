/**
 * 响应式版心 E2E fixture 渲染（bun 直接跑 TS，v2.7.3）：
 *  1. 富上下文 mock → renderReportHtml → /tmp/resp-fixtures/report-new.html（新报告，内嵌响应式版心）
 *  2. 剥离 RESPONSIVE_PAGE_CSS 块 → report-legacy.html（模拟 v2.7.2 旧报告）
 *  3. applyResponsiveOverride(legacy) → report-legacy-injected.html（旧报告 serve 时注入路径）
 *  4. 字符串断言：marker / 版心分级 / min() 防溢出 / 注入幂等
 */
import * as fs from 'node:fs'
import { renderReportHtml, applyResponsiveOverride, RESPONSIVE_PAGE_CSS } from '../src/lib/eval/report-html'
import type { ReportContext } from '../src/lib/eval/report'

const OUT = '/tmp/resp-fixtures'
fs.mkdirSync(OUT, { recursive: true })

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** 极小 AlphaFold 模型 PDB 文本（3Dmol 交互视图初始化即可；90 残基螺旋 × 主链 N/CA/C/O，
 *  B 因子铺满四段 pLDDT 色带 — 与真实 AF 模型的 cartoon 渲染口径一致） */
const afPdb = (() => {
  const lines: string[] = []
  /** 连续区段 pLDDT（模拟真实 AF 置信度曲线：N 端高 → C 端低，四段色带各成连续区段） */
  const bOf = (i: number) => (i < 30 ? 94.2 + (i % 5) * 0.3 : i < 50 ? 82.5 + (i % 7) * 0.4 : i < 80 ? 58.3 + (i % 6) * 0.5 : 41.6 + (i % 9) * 0.4)
  let serial = 0
  /** 标准 PDB 定宽行（坐标 %8.3f ×3 / 占位 %6.2f / B 因子 %6.2f — 与 plddtStyleApplyJs 的 slice 解析对齐） */
  const atomLine = (serial: number, atom: string, resi: number, x: number, y: number, z: number, b: number) => {
    const name = atom.length === 1 ? ` ${atom}  ` : ` ${atom} ` // 1 字符元素 → 第 14 列起
    return (
      'ATOM  ' + String(serial).padStart(5) + ' ' + name + ' ALA A' + String(resi).padStart(4) + '    '
      + x.toFixed(3).padStart(8) + y.toFixed(3).padStart(8) + z.toFixed(3).padStart(8)
      + '  1.00' + b.toFixed(2).padStart(6) + '          C'
    )
  }
  for (let i = 0; i < 90; i++) {
    const t = (i / 89) * Math.PI * 6
    const cx = 14 + 6 * Math.cos(t)
    const cy = 24 - i * 0.35
    const cz = 30 + 6 * Math.sin(t)
    const b = bOf(i)
    for (const [atom, dx, dy, dz] of [['N', -1.3, 0.2, 0], ['CA', 0, 0, 0], ['C', 1.3, -0.2, 0], ['O', 1.9, -1.1, 0.4]] as const) {
      serial++
      lines.push(atomLine(serial, atom, i + 1, cx + (dx as number), cy + (dy as number), cz + (dz as number), b))
    }
  }
  lines.push('TER')
  return lines.join('\n')
})()

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
      { pdbId: '4G5J', title: 'EGFR kinase domain', method: 'X-RAY DIFFRACTION', resolution: 2.9, releaseDate: '2013-03-06', alsoTarget: false },
    ],
    pubchem: { cid: 176870, iupacName: 'N-(3-ethynylphenyl)-6,7-bis(2-methoxyethoxy)quinazolin-4-amine' },
    detail: { cid: 176870, iupacName: 'N-(3-ethynylphenyl)-6,7-bis(2-methoxyethoxy)quinazolin-4-amine', xlogp: 3.0, tpsa: 74.7, hBondDonor: 1, hBondAcceptor: 6, rotatableBonds: 8, heavyAtoms: 29, exactMass: 393.17, inchiKey: 'AAKJVRGGFVUMBDA-UHFFFAOYSA-N', canonicalSmiles: 'COCCOCCOC1=C2C=CC(=NC2=NC=C1NC3=CC=CC(=C3)C#C)N', structure2d: TINY_PNG },
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
      { pdbId: '2ITZ', title: 'EGFR T790M with gefitinib', method: 'X-RAY DIFFRACTION', resolution: 3.1, releaseDate: '2007-02-12', alsoTarget: true },
    ],
    pubchem: { cid: 123631, iupacName: '4-(3-chloro-4-fluoroanilino)-7-methoxy-6-(3-morpholinopropoxy)quinazoline' },
    detail: { cid: 123631, iupacName: '4-(3-chloro-4-fluoroanilino)-7-methoxy-6-(3-morpholinopropoxy)quinazoline', xlogp: 3.2, tpsa: 68.7, hBondDonor: 1, hBondAcceptor: 8, rotatableBonds: 8, heavyAtoms: 31, exactMass: 446.15, inchiKey: 'FBBKSGBWKVRONA-UHFFFAOYSA-N', canonicalSmiles: 'COc1cc2ncnc(Nc3ccc(F)c(Cl)c3)c2cc1OCCCN1CCOCC1', structure2d: TINY_PNG },
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
  insights: {
    goals: ['获得 EGFR T790M 耐药突变体与新型不可逆抑制剂的共晶结构', '分辨率目标 2.5 Å 以内'],
    scientificQuestions: ['C797 位点共价结合的构象变化如何影响整体激酶域折叠'],
    experimentalSummary: '已尝试 3 轮结晶筛选，获得微晶但衍射不佳（~8 Å）。',
    sequenceNotes: '构建体为 696-1022 激酶域，N 端 His6 标签可切除。',
    keyConcerns: ['去糖基化不彻底可能影响均一性'],
  },
  directPdbs: [
    { pdbId: 'A1B6E', method: 'X-RAY DIFFRACTION', resolution: 1.85, title: 'EGFR kinase domain in complex with a strain-release covalent inhibitor', releaseDate: '2026-01-01', ligands: ['Erlotinib (N-(3-ethynylphenyl) quinazolin-4-amine derivative)', 'ANP (phosphoaminophosphonic acid-adenylate ester)'], journal: 'J. Biol. Chem.', doi: '10.0000/x', pubmedId: '39000000', organisms: ['Homo sapiens'], isXray: true, isCryoem: false, isNmr: false },
    { pdbId: '8XYZW', method: 'ELECTRON MICROSCOPY', resolution: 3.1, title: 'Cryo-EM structure of full-length EGFR in asymmetric dimer conformation', releaseDate: '2025-06-01', ligands: [], journal: 'Nature', doi: '', pubmedId: '', organisms: ['Homo sapiens'], isXray: false, isCryoem: true, isNmr: false },
    { pdbId: '2ITY1', method: 'X-RAY DIFFRACTION', resolution: 2.8, title: 'EGFR kinase domain with gefitinib', releaseDate: '2024-06-01', ligands: ['Gefitinib'], journal: 'Biochemistry', doi: '', pubmedId: '38000001', organisms: ['Homo sapiens'], isXray: true, isCryoem: false, isNmr: false },
  ],
  blastHits: [
    { pdbId: '7XYZ1', description: 'EGFR homolog from Mus musculus, kinase domain with inhibitor', identity: 92.5, evalueRaw: '2e-180', evalue: 2e-180, queryCoverage: 267, method: 'X-RAY DIFFRACTION', resolution: 2.0 },
    { pdbId: '7XYZ2', description: 'EGFR family member ERBB2 kinase domain', identity: 88.1, evalueRaw: '1e-160', evalue: 1e-160, queryCoverage: 250, method: 'X-RAY DIFFRACTION', resolution: 2.2 },
  ],
  coverage: { coveragePercent: 92, mappedResidues: 1113, totalResidues: 1210, segments: [] } as never,
  coverageText: '92%',
  gapText: '胞外区 1-712 位',
  literature: [
    { pmid: '39000000', title: 'Structure of EGFR kinase domain with covalent inhibitor', journal: 'J. Biol. Chem.', year: '2026', doi: '10.0000/x', fromPdb: true },
    { pmid: '38000001', title: 'EGFR T790M resistance mechanisms', journal: 'Cancer Res.', year: '2024', doi: '', fromPdb: false },
  ],
  images: [
    { id: 'img1', kind: 'gel', name: 'SEC 结果.png', mime: 'image/png', header: 'Superose 6 Increase', caption: '分子筛单峰，表观分子量 ~ 42 kDa' } as never,
    { id: 'img2', kind: 'sec', name: 'SDS-PAGE.png', mime: 'image/png', header: 'SDS-PAGE', caption: '还原 SDS-PAGE 显示 > 95% 纯度' } as never,
  ],
  scores: {
    xray: { score: 9, maxScore: 10, rating: '优' },
    cryoem: { score: 8, maxScore: 10, rating: '良' },
    nmr: { score: 3, maxScore: 10, rating: '差' },
    overall: { score: 8, maxScore: 10, rating: '良' },
    rationale: { xray: '大量高分辨率结构', cryoem: '有全长结构先例', nmr: '蛋白过大', overall: '综合优' },
    oligomerAdjust: { label: '同源二聚体（homodimer）', stoichiometry: '2 × 相同亚基', confidence: 'high', xray: 0, cryoem: 1, nmr: 0, note: '同源二聚组装使有效分子量倍增，Cryo-EM 更有利' } as never,
  },
  oligomer: {
    label: '同源二聚体（homodimer）',
    summary: '同源二聚体（homodimer）— 高置信（2 条独立证据一致）',
    category: 'homo-oligomer',
    stoichiometry: '2 × 相同亚基',
    confidence: 'high',
    evidence: [
      { source: 'pdb-title', ref: '8XYZW', text: 'Cryo-EM structure of full-length EGFR in asymmetric dimer conformation', state: 'homodimer' },
      { source: 'uniprot-subunit', ref: 'P00533', text: 'Interacts with itself; homodimerization', state: 'homodimer' },
    ],
    notes: ['二聚体组装使有效分子量倍增，Cryo-EM 更有利'],
  } as never,
  ligands: ligands as never,
  alphafold: { available: true, modelId: 'AF-P00533F1', globalPlddt: 87.4, fracVeryHigh: 0.62, latestVersion: 4 } as never,
} as unknown as ReportContext

const llmMarkdown = [
  '## 执行摘要',
  '**EGFR 激酶区结构解析可行性高**，X-ray 已有 1.85 Å 共晶先例，配体结合位点保守，可直接复用现有结晶条件。',
  '综合评分为 **8/10（良）**；激酶域构建体（696-1022）在去糖基化前提下预期 2-4 周内可复现共晶。',
  '## 目标可行性分析',
  '- 直接结构先例：3 个（1.85-3.1 Å）\n- 同源覆盖：identity 92.5%（7XYZ1）\n- AlphaFold 模型 pLDDT 87.4，激酶域可信',
  '## 研究全景',
  '| 证据类型 | 数量 | 关键代表 |\n| --- | --- | --- |\n| X-ray | 2 | A1B6E (1.85 Å) |\n| Cryo-EM | 1 | 8XYZW (3.1 Å) |',
  '> 客户已有微晶但衍射不佳（~8 Å），建议改为激酶域截短体并复筛沉淀剂。',
  '## 实验策略建议',
  '1. 采用 696-1022 构建体，TEV 切除标签后 SEC 单体峰收集',
  '2. 与 Erlotinib/Gefitinib 预复合后共结晶（已有 4HJO/2ITY 条件可参考）',
].join('\n\n')

const input = {
  ctx,
  methodStats: { xrayCount: 2, cryoemCount: 1, nmrCount: 0, bestResolution: 1.85 } as never,
  llmMarkdown,
  llmOk: true,
  llmErrors: [],
  jobId: 'resp-e2e-fixture',
  durationMs: 12345,
  totalPdbFound: 3,
  engineSummary: 'Z.ai GLM-4.6（内置）',
  alphafoldFigure: { dataUri: TINY_PNG, modelId: 'AF-P00533F1', globalPlddt: 87.4, version: 4, fracVeryHigh: 0.62 },
  alphafoldStructure: { pdbText: afPdb, uniprotId: 'P00533', modelId: 'AF-P00533F1', globalPlddt: 87.4, version: 4, fracVeryHigh: 0.62 },
  resolveImagePath: () => '',
}

const html = await renderReportHtml(input)
fs.writeFileSync(`${OUT}/report-new.html`, html, 'utf-8')

// 模拟旧报告（v2.7.2 及以前）：剥掉内嵌响应式版心块
const markerIdx = html.indexOf('/* rpt-rw-v3')
const legacyHtml = markerIdx >= 0 ? html.slice(0, html.lastIndexOf('<style', markerIdx) >= 0 ? html.lastIndexOf('  /* rpt-rw-v3') : markerIdx) + '' : html
const stripFrom = html.indexOf(`\n${RESPONSIVE_PAGE_CSS}`)
const legacy = stripFrom >= 0 ? html.replace(`\n${RESPONSIVE_PAGE_CSS}`, '\n') : html
fs.writeFileSync(`${OUT}/report-legacy.html`, legacy, 'utf-8')

// 旧报告经报告路由 serve 时的注入路径
const injected = applyResponsiveOverride(legacy)
fs.writeFileSync(`${OUT}/report-legacy-injected.html`, injected, 'utf-8')

const checks: [string, boolean][] = [
  ['新报告含版心标记 rpt-rw-v3', html.includes('rpt-rw-v3')],
  ['新报告版心分级 ≥1280→1088', html.includes('@media (min-width:1280px){ .page{max-width:1088px} }')],
  ['新报告版心分级 ≥1600→1360', html.includes('@media (min-width:1600px){')],
  ['新报告 lig-grid min() 防溢出', html.includes('minmax(min(400px,100%),1fr)')],
  ['新报告 fig-grid min() 防溢出', html.includes('minmax(min(300px,100%),1fr)')],
  ['新报告 3D 视图存在（af-stage）', html.includes('class="af-stage"')],
  ['旧模拟报告已剥离版心标记', !legacy.includes('rpt-rw-v3')],
  ['注入后恢复版心标记', injected.includes('rpt-rw-v3')],
  ['注入位置在 </head> 前', injected.includes('<style id="rpt-rw">')],
  ['注入幂等（二次注入不变）', applyResponsiveOverride(injected) === injected],
  ['注入保留原内容完整性', injected.replace('<style id="rpt-rw">' + RESPONSIVE_PAGE_CSS + '</style>\n', '') === legacy],
]

let pass = 0
for (const [name, ok] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (ok) pass++
}
console.log(`\n${pass}/${checks.length} passed`)
if (pass !== checks.length) process.exit(1)
