/**
 * renderReportHtml 冒烟测试（bun 直接跑 TS）：
 * 验证新版报告标记 —— 数据表 colgroup / tbl-data 类 / 配体截断 / 斑马纹 CSS。
 */
import { renderReportHtml } from '../src/lib/eval/report-html'
import type { ReportContext } from '../src/lib/eval/report'

const longLigand = 'A1B6E (N-[4-(3-chloro-4-fluoroanilino)-7-{[(3S)-tetrahydrofuran-3-yl]oxy}quinaz)'

const ctx = {
  uniprot: {
    uniprotId: 'P00533',
    entryName: 'EGFR_HUMAN',
    proteinName: 'Epidermal growth factor receptor',
    geneNames: ['EGFR', 'ERBB1'],
    organism: 'Homo sapiens',
    sequenceLength: 1210,
    sequence: 'M'.repeat(100),
    features: [],
  },
  sequence: 'M'.repeat(100),
  goal: '客户希望获得 EGFR 激酶区与新型抑制剂的复合物结构',
  goalHints: [],
  directPdbs: [
    {
      pdbId: 'A1B6E', method: 'X-RAY DIFFRACTION', resolution: 1.85, title: 'EGFR kinase domain in complex with a strain-release covalent inhibitor',
      releaseDate: '2026-01-01', ligands: [longLigand, 'ANP (phosphoaminophosphonic acid-adenylate ester)', 'XYZ'], journal: 'J. Biol. Chem.',
      doi: '10.0000/x', pubmedId: '39000000', organisms: ['Homo sapiens'], isXray: true, isCryoem: false, isNmr: false,
    },
    {
      pdbId: '8XYZW', method: 'ELECTRON MICROSCOPY', resolution: 3.1, title: 'Cryo-EM structure of full-length EGFR',
      releaseDate: '2025-06-01', ligands: [], journal: 'Nature', doi: '', pubmedId: '', organisms: ['Homo sapiens'],
      isXray: false, isCryoem: true, isNmr: false,
    },
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
  images: [],
  scores: {
    xray: { score: 9, maxScore: 10, rating: '优' },
    cryoem: { score: 8, maxScore: 10, rating: '良' },
    nmr: { score: 3, maxScore: 10, rating: '差' },
    overall: { score: 8, maxScore: 10, rating: '良' },
    rationale: { xray: '大量高分辨率结构', cryoem: '有全长结构先例', nmr: '蛋白过大', overall: '综合优' },
  },
} as unknown as ReportContext

const html = await renderReportHtml({
  ctx,
  methodStats: { xrayCount: 1, cryoemCount: 1, nmrCount: 0, bestResolution: 1.85 } as never,
  llmMarkdown: '## 测试章节\n\n这是一段 **测试** 内容。',
  llmOk: true,
  llmErrors: [],
  jobId: 'test-job',
  durationMs: 12345,
  totalPdbFound: 2,
  engineSummary: 'Z.ai GLM-4.6（内置）',
  resolveImagePath: () => '',
})

const checks: [string, boolean][] = [
  ['数据表 tbl-data 类', html.includes('table class="tbl-data"')],
  ['PDB colgroup 列宽', html.includes('<colgroup>') && html.includes('width:146px')],
  ['配体截断（≤22字符名）', !html.includes('tetrahydrofuran-3-yl]oxy}quinaz)') || html.includes('title="A1B6E')],
  ['配体悬停全名 title', html.includes('title="A1B6E (N-[4-(3-chloro-4-fluoroanilino)')],
  ['配体溢出计“等N”', html.includes('等3') || html.includes('>等')],
  ['配体列不再 nowrap', !/\.t-lig\s*\{[^}]*white-space:nowrap/.test(html)],
  ['td overflow-wrap 防溢出', html.includes('td { overflow-wrap:anywhere; }')],
  ['斑马纹', html.includes('tr:nth-child(even)')],
  ['评分行窄屏媒体查询', html.includes('@media (max-width:560px)')],
  ['数字表头右对齐', html.includes('th.num { text-align:right; }')],
  ['BLAST tbl-blast 类', html.includes('tbl-blast')],
]

let pass = 0
for (const [name, ok] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (ok) pass++
}
console.log(`\n${pass}/${checks.length} passed`)
if (pass !== checks.length) process.exit(1)
