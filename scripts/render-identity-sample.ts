/**
 * 渲染序列靶点身份报告样例（nr 识别来源）到 /tmp/render — 供视觉检查刊头布局。
 */
import * as fs from 'node:fs/promises'
import { renderReportHtml } from '../src/lib/eval/report-html'
import type { ReportContext } from '../src/lib/eval/report'
import type { BlastHit, PdbEntry, Scores, TargetIdentityInfo } from '../src/lib/eval/types'

const scores: Scores & { rationale: { xray: string; cryoem: string; nmr: string; overall: string } } = {
  xray: { score: 6, maxScore: 10, rating: '优先推荐' },
  cryoem: { score: 4, maxScore: 10, rating: '中等' },
  nmr: { score: 5, maxScore: 10, rating: '可行' },
  overall: { score: 5, maxScore: 10, rating: '中等' },
  rationale: { xray: 'mock', cryoem: 'mock', nmr: 'mock', overall: 'mock' },
}
const ti: TargetIdentityInfo = {
  name: 'Tumor suppressor p53', source: 'blast-nr', sourceLabel: 'BLAST nr 识别', identity: 97.6,
  uniprotId: 'P04637', uniprotEntry: 'P53_HUMAN', organism: 'Homo sapiens', geneName: 'TP53',
  note: 'BLAST nr 最佳命中（UniProt P04637 P53_HUMAN），一致性 97.6%',
}
const blast: BlastHit[] = [
  { pdbId: '1A1A', description: 'Chain A, Tumor suppressor p53', identity: 44.2, evalue: 1e-20, evalueRaw: '1e-20', queryCoverage: 90, method: 'X-ray', resolution: 1.8 },
  { pdbId: '2A2B', description: 'Chain A, p53 tetramerization domain', identity: 38.5, evalue: 1e-12, evalueRaw: '1e-12', queryCoverage: 60, method: 'NMR', resolution: null },
]
const ctx: ReportContext = {
  uniprot: null,
  sequence: 'MEEPQSDPSVEPPLSQETFSDLWKLLPENNVLSPLPSQAMDDLMLSPDDIEQWFTEDPGPDEAPR',
  sequenceHeader: 'p53 N端域构建（点突变）',
  goal: '验证序列靶点身份渲染',
  goalHints: [],
  targetIdentity: ti,
  directPdbs: [] as PdbEntry[],
  blastHits: blast,
  coverage: null,
  coverageText: '',
  gapText: '',
  literature: [],
  images: [],
  scores,
}

async function main() {
  const html = await renderReportHtml({
    ctx,
    methodStats: { xrayCount: 1, cryoemCount: 0, nmrCount: 1, bestResolution: 1.8 },
    llmMarkdown: '## 执行摘要\n**序列靶点身份识别验证样例。** 本报告题目与刊头展示 BLAST nr 识别的靶点身份（97.6% 一致性）。',
    llmOk: true,
    llmErrors: [],
    jobId: 'sample_identity',
    durationMs: 42000,
    totalPdbFound: 0,
    engineSummary: 'sample-engine',
    resolveImagePath: () => '',
  })
  await fs.mkdir('/tmp/render', { recursive: true })
  await fs.writeFile('/tmp/render/identity-report.html', html, 'utf-8')
  console.log('written /tmp/render/identity-report.html', html.length, 'bytes')
}
main().catch(e => { console.error(e); process.exit(1) })
