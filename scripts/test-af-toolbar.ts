/**
 * v2.46 预测结构视图工具条（下载 PDB + 着色切换 pLDDT/彩虹/UniProt 域）实测：
 *  A. extractAfDomains 单元逻辑（DOMAIN 过滤/干扰类型排除/排序/上限）
 *  B. 单靶点报告（AFDB 模型 + DOMAIN 注释）— 静态断言：工具条脚本注入、mount 调用
 *     携带 fileName + domains、CSS 样式、figcaption 新文案；落盘 HTML 供浏览器 E2E
 *  C. ESMFold 报告 — 静态断言：mount 不带 domains（选项禁用口径）
 */
import * as fs from 'node:fs/promises'
import { renderReportHtml } from '../src/lib/eval/report-html'
import { extractAfDomains } from '../src/lib/eval/alphafold'
import type { ReportContext, Scores, UniprotFeature } from '../src/lib/eval/types'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}`, detail !== undefined ? String(detail).slice(0, 300) : '') }
}

const scores: Scores & { rationale: { xray: string; cryoem: string; nmr: string; overall: string } } = {
  xray: { score: 7, rating: '优先推荐' },
  cryoem: { score: 4, rating: '中等' },
  nmr: { score: 5, rating: '可行' },
  overall: { score: 6, rating: '中等' },
  rationale: { xray: 'mock', cryoem: 'mock', nmr: 'mock', overall: 'mock' },
}

/** p53 (P04637) 域注释（真实 UniProt 区间 + 干扰项） */
const p53Features: UniprotFeature[] = [
  { type: 'REGION', description: 'Transactivation domain 1', begin: 1, end: 40 },
  { type: 'DOMAIN', description: 'p53 DNA-binding domain', begin: 94, end: 292 },
  { type: 'REGION', description: 'Nuclear localization signal', begin: 316, end: 325 },
  { type: 'DOMAIN', description: 'p53 tetramerization domain', begin: 323, end: 356 },
  { type: 'REGION', description: 'Basic (regulatory) domain', begin: 363, end: 386 },
  { type: 'DOMAIN', description: 'Invalid negative range', begin: 500, end: 400 },
]

/** 30 残基 mini PDB（ESM 视图渲染用 — 只需 ATOM 记录可被 3Dmol 解析） */
function miniPdb(): string {
  const lines = ['HEADER    MINI TEST MODEL', 'TITLE     ESMFOLD PREDICTION (TEST)']
  const n = 30
  let serial = 1
  for (let resi = 1; resi <= n; resi++) {
    for (let a = 0; a < 3; a++) {
      const atomName = ['CA', 'C', 'N'][a]
      const x = (resi * 1.5 - 20).toFixed(3)
      const y = (Math.sin(resi / 3) * 10).toFixed(3)
      const z = (Math.cos(resi / 4) * 8).toFixed(3)
      const bfac = resi < 10 ? 30 : resi < 20 ? 60 : resi < 26 ? 78 : 95
      lines.push(
        `ATOM  ${String(serial).padStart(5)}  ${atomName.padEnd(3)} GLY A${String(resi).padStart(4)}    ${x}${y}${z}  1.00${String(bfac).padStart(6)}           C  `
      )
      serial++
    }
  }
  lines.push('TER', 'END')
  return lines.join('\n')
}

async function main() {
  console.log('[A] extractAfDomains 单元逻辑')
  const doms = extractAfDomains(p53Features, 397)
  check('DOMAIN 数量 = 2（排除 REGION/负区间）', doms?.length === 2, doms)
  check('按 begin 升序（DNA-binding 94 在前）', doms?.[0]?.start === 94 && doms?.[0]?.name.includes('DNA-binding'), doms?.[0])
  check('tetramerization 323-356 在后', doms?.[1]?.start === 323 && doms?.[1]?.end === 356, doms?.[1])
  check('无 DOMAIN → undefined', extractAfDomains([{ type: 'REGION', description: 'x', begin: 1, end: 10 }], 100) === undefined)
  check('空 features → undefined', extractAfDomains([], 100) === undefined)
  const manyDoms = extractAfDomains(
    Array.from({ length: 40 }, (_, i) => ({ type: 'DOMAIN', description: `D${i}`, begin: i * 10 + 1, end: i * 10 + 8 })),
    1000,
  )
  check('超上限截断 24 条', manyDoms?.length === 24, manyDoms?.length)

  // ── B. 单靶点报告（AFDB 模型 + 域注释）──
  console.log('\n[B] 单靶点报告 — AF 工具条（domain 全功能）')
  const pdbText = await fs.readFile('db/cache/alphafold/pdb/P04637.pdb', 'utf-8')
  const uniprot = {
    uniprotId: 'P04637',
    entryName: 'P53_HUMAN',
    proteinName: 'Cellular tumor antigen p53',
    geneNames: ['TP53'],
    organism: 'Homo sapiens',
    sequenceLength: 397,
    sequence: 'X'.repeat(397),
    features: p53Features,
  }
  const ctx: ReportContext = {
    uniprot,
    sequence: uniprot.sequence,
    goal: '验证工具条',
    goalHints: [],
    directPdbs: [],
    blastHits: [],
    coverage: null,
    coverageText: '',
    gapText: '',
    literature: [],
    images: [],
    scores,
    alphafold: { available: true, modelId: 'AF-P04637-F1', globalPlddt: 44.7, version: 4 },
  }
  const html = await renderReportHtml({
    ctx,
    methodStats: { xrayCount: 0, cryoemCount: 0, nmrCount: 0, bestResolution: null },
    llmMarkdown: '## 执行摘要\n\nmock 章节。',
    llmOk: true,
    llmErrors: [],
    jobId: 'job_af_toolbar_test',
    durationMs: 12345,
    totalPdbFound: 0,
    engineSummary: 'mock-engine',
    alphafoldStructure: {
      pdbText,
      uniprotId: 'P04637',
      modelId: 'AF-P04637-F1',
      globalPlddt: 44.7,
      version: 4,
      fracVeryHigh: 0.22,
    },
    afDomains: doms,
    resolveImagePath: () => '/tmp/none',
  })
  check('工具条公共脚本注入（__afTb）', html.includes('window.__afTb'))
  check('pLDDT 核心复用（__afPlddtApply）', html.includes('window.__afPlddtApply'))
  check('CSS 工具条样式（.af-tb）', html.includes('.af-tb {'))
  check('CSS 彩虹渐变条样式（.af-lgd-rb-bar）', html.includes('.af-lgd-rb-bar'))
  check('CSS 打印隐藏工具条', html.includes('.af-stage .af-canvas, .af-stage .af-tb { display:none; }'))
  check('mount 调用携带下载文件名', html.includes(`fileName: ${JSON.stringify('AF-P04637-F1-model_v4.pdb')}`), 'AF-P04637-F1-model_v4.pdb')
  check('mount 调用携带 domains JSON', html.includes('domains: [{"name":"p53 DNA-binding domain","start":94,"end":292}') || /domains: \[\{"name":"p53 DNA-binding domain","start":94,"end":292/.test(html))
  check('figcaption 新文案（可切换彩虹 / UniProt 域着色）', html.includes('可切换彩虹 / UniProt 域着色，PDB 模型可下载'))
  check('工具条失败不影响视图（try 包裹）', html.includes('/* 工具条失败不影响视图 */'))
  const outDir = '/tmp/af-toolbar-test'
  await fs.mkdir(outDir, { recursive: true })
  await fs.writeFile(`${outDir}/report.html`, html, 'utf-8')
  console.log(`  → 落盘 ${outDir}/report.html（${Math.round(html.length / 1024)}KB）供浏览器 E2E`)

  // ── C. ESMFold 报告（无 domains → 选项禁用口径）──
  console.log('\n[C] ESMFold 报告 — 工具条（无域数据）')
  const efHtml = await renderReportHtml({
    ctx: { ...ctx, uniprot: null, sequence: 'MKTAYIAKQRQISFVKSHFSRQLEERLI' + 'X'.repeat(3), targetIdentity: undefined },
    methodStats: { xrayCount: 0, cryoemCount: 0, nmrCount: 0, bestResolution: null },
    llmMarkdown: '## 执行摘要\n\nmock。',
    llmOk: true,
    llmErrors: [],
    jobId: 'job_ef_toolbar_test',
    durationMs: 999,
    totalPdbFound: 0,
    engineSummary: 'mock-engine',
    esmfoldStructure: { pdbText: miniPdb(), modelId: 'ESMFold v1', globalPlddt: 55.5, fracVeryHigh: 0.3, sequenceLength: 30 },
    resolveImagePath: () => '/tmp/none',
  })
  check('ESM mount 调用（fileName 无 domains）', efHtml.includes(`window.__afTb.mount(stage, viewer, pdb, { fileName: 'ESMFold_prediction.pdb' })`))
  check('ESM figcaption 文案（可切换彩虹着色）', efHtml.includes('可切换彩虹着色，PDB 模型可下载'))
  await fs.writeFile(`${outDir}/report-esm.html`, efHtml, 'utf-8')

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
