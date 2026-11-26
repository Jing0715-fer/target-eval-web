/**
 * v2.95 验证脚本：blastNrProvider='ebi' 的报告渲染标注（EBI UniProtKB 全库兜底
 * 来源时，报告 BLAST 面板/切换按钮/章节头/SOURCES 如实标注 — 不再笼统写 NCBI nr）。
 *
 * 用法：bun scripts/test-ebi-provider-render.ts
 * 构造最小 ReportContext（nr 命中 + provider='ebi' + 同源命中）渲染单靶点报告
 * 主体，断言 EBI 标注文本存在且 NCBI 误标不存在。
 */
import { renderSingleReportBody } from '../src/lib/eval/report-html'
import type { ReportContext } from '../src/lib/eval/report'
import type { BlastHit, BlastNrHit, PdbEntry } from '../src/lib/eval/types'

const nrHit = (acc: string, db: 'sp' | 'tr', identity: number, cov: number): BlastNrHit => ({
  accession: acc,
  entryName: `TEST_${acc}`,
  description: `Test protein ${acc}`,
  organism: 'Bacillus testus',
  geneName: 'tstA',
  identity,
  evalue: 1e-180,
  evalueRaw: '1e-180',
  queryCoverage: cov,
  queryFrom: 1,
  queryTo: cov,
  hitFrom: 1,
  hitTo: cov,
  db,
})

const blastHit: BlastHit = {
  pdbId: '1ABC',
  description: 'Test homolog structure',
  identity: 61.4,
  evalue: 1e-60,
  evalueRaw: '1e-60',
  queryCoverage: 240,
  queryFrom: 1,
  queryTo: 240,
  method: 'X-ray',
  resolution: 2.1,
}

const pdb: PdbEntry = {
  pdbId: '1ABC',
  title: 'Test structure',
  method: 'X-ray',
  resolution: 2.1,
  releaseDate: '2020-01-01',
  ligands: [],
  isXray: true,
  isCryoem: false,
  isNmr: false,
  journal: 'Test J',
  doi: '',
  pubmedId: '',
  organisms: [],
}

async function main() {
  const ctx: ReportContext = {
    uniprot: null,
    sequence: 'MKTVL',
    sequenceHeader: 'PA_22f1_fab_new',
    goalHints: [],
    targetIdentity: {
      name: 'Protective antigen',
      source: 'blast-nr',
      sourceLabel: 'BLAST nr 识别',
      identity: 97.5,
      uniprotId: 'P12345',
      note: 'EBI UniProtKB 全库兜底最佳命中（UniProt P12345 PAG_TEST），一致性 97.5%',
    },
    blastNrHits: [nrHit('P12345', 'sp', 97.5, 240), nrHit('A0A7U3VEQ5', 'tr', 96.8, 238)],
    blastNrProvider: 'ebi',
    uniprotBlastHits: [nrHit('P12929', 'sp', 68.8, 151)],
    directPdbs: [pdb],
    blastHits: [blastHit],
    blastStatus: { status: 'ok', provider: 'rcsb' },
    coverage: null,
    coverageText: '',
    gapText: '',
    literature: [],
    images: [],
    scores: {
      xray: { score: 7, maxScore: 10, rating: '中高' },
      cryoem: { score: 8, maxScore: 10, rating: '高' },
      nmr: { score: 7, maxScore: 10, rating: '中高' },
      overall: { score: 8, maxScore: 10, rating: '高' },
      rationale: { xray: 'test', cryoem: 'test', nmr: 'test', overall: 'test' },
    },
    oligomer: undefined,
    mwAugment: undefined,
    interaction: undefined,
  }

  const html = await renderSingleReportBody({
    ctx,
    methodStats: { xrayCount: 1, cryoemCount: 0, nmrCount: 0, bestResolution: 2.1 },
    llmMarkdown: '',
    llmOk: true,
    llmErrors: [],
    jobId: 'test-v295',
    durationMs: 300000,
    totalPdbFound: 1,
    engineSummary: 'test',
  })

  // 无 PDB 同源命中时 nr 面板独立展示（withHead=true — h3 标题/副标出现）
  const htmlNoBlast = await renderSingleReportBody({
    ctx: { ...ctx, blastHits: [] },
    methodStats: { xrayCount: 1, cryoemCount: 0, nmrCount: 0, bestResolution: 2.1 },
    llmMarkdown: '',
    llmOk: true,
    llmErrors: [],
    jobId: 'test-v295',
    durationMs: 300000,
    totalPdbFound: 1,
    engineSummary: 'test',
  })

  const checks: Array<[string, boolean]> = [
    ['EBI 面板标题（UniProtKB 全库检索 — 无同源独立展示路径）', htmlNoBlast.includes('UniProtKB 全库检索')],
    ['EBI 面板副标（NCBI 拥堵日兜底 — 无同源独立展示路径）', htmlNoBlast.includes('NCBI 拥堵日兜底')],
    ['EBI 面板说明（改经 EBI BLAST 检索）', html.includes('改经 EBI BLAST 检索 UniProtKB 全库')],
    ['切换按钮 EBI 标注（UniProtKB 全库 · 2 命中）', html.includes('UniProtKB 全库 · 2 命中')],
    ['章节头 EBI 标注（UniProt 全库 2）', html.includes('UniProt 全库 2')],
    ['SOURCES 标注（EBI BLAST (UniProtKB 全库)）', html.includes('EBI BLAST (UniProtKB 全库)')],
    ['面板不再误标 NCBI（副标无 NCBI nr · 2 hits）', !html.includes('NCBI nr · 2 hits')],
    ['RCSB 同源说明保留', html.includes('RCSB 序列检索（mmseqs2）')],
  ]
  let pass = true
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'} — ${name}`)
    if (!ok) pass = false
  }
  if (!pass) {
    console.error('[test] 存在失败断言')
    process.exit(1)
  }
  console.log('[test] PASS — v2.95 EBI 兜底来源的报告标注渲染正确')
}

main().catch(e => { console.error('[test] FAIL:', e); process.exit(1) })
