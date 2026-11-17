/**
 * v2.16 报告渲染 — 序列靶点身份的标题/刊头验证（无网络）：
 *  renderReportHtml（单靶点）：ctx.uniprot=null + targetIdentity（评估表 / nr / 同源）
 *  → 断言 <title> 与刊头使用识别名（不再「序列靶点评估」笼统命名），
 *    meta-grid 含「靶点身份」行、近似 UniProt 外链。
 */
import { renderReportHtml } from '../src/lib/eval/report-html'
import type { ReportContext } from '../src/lib/eval/report'
import type { BlastHit, PdbEntry, Scores, TargetIdentityInfo } from '../src/lib/eval/types'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}`, detail !== undefined ? JSON.stringify(detail) : '') }
}

const scores: Scores & { rationale: { xray: string; cryoem: string; nmr: string; overall: string } } = {
  xray: { score: 6, maxScore: 10, rating: '优先推荐' },
  cryoem: { score: 4, maxScore: 10, rating: '中等' },
  nmr: { score: 5, maxScore: 10, rating: '可行' },
  overall: { score: 5, maxScore: 10, rating: '中等' },
  rationale: { xray: 'mock', cryoem: 'mock', nmr: 'mock', overall: 'mock' },
}
const methodStats = { xrayCount: 0, cryoemCount: 0, nmrCount: 0, bestResolution: null as number | null }
const blast: BlastHit[] = [{
  pdbId: '1A1A', description: 'Chain A, Tumor suppressor p53', identity: 44.2, evalue: 1e-20, evalueRaw: '1e-20', queryCoverage: 90, method: '', resolution: null,
}]
const SEQ = 'MEEPQSDPSVEPPLSQETFSDLWKLLPENNVLSPLPSQAMDDLMLSPDDIEQWFTEDPGPDEAPR'

function ctxOf(ti?: TargetIdentityInfo): ReportContext {
  return {
    uniprot: null,
    sequence: SEQ,
    sequenceHeader: ti?.source === 'eval-table' ? 'p53 N端域构建' : '',
    goal: '验证身份渲染',
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
}

async function renderOf(ti?: TargetIdentityInfo): Promise<string> {
  return await renderReportHtml({
    ctx: ctxOf(ti),
    methodStats,
    llmMarkdown: '## 执行摘要\n**测试摘要。**',
    llmOk: true,
    llmErrors: [],
    jobId: 'test_v216_identity',
    durationMs: 1000,
    totalPdbFound: 0,
    engineSummary: 'mock-engine',
    resolveImagePath: () => '',
  })
}

async function main() {
  // ── A. 评估表来源（无后缀）──
  console.log('A. 评估表蛋白名来源')
  const htmlA = await renderOf({ name: 'p53 N端域构建（5x 点突变）', source: 'eval-table', sourceLabel: '评估表', note: '来自客户评估表' })
  check('<title> 使用评估表名', htmlA.includes('<title>靶点结构解析可行性评估报告 — p53 N端域构建（5x 点突变）（序列靶点）</title>'), htmlA.match(/<title>[^<]+<\/title>/))
  check('h1 题目', htmlA.includes('<h1 class="rpt-title">p53 N端域构建（5x 点突变）（序列靶点）</h1>'))
  check('meta-grid 靶点身份行（评估表 · 无一致性）', htmlA.includes('<b>靶点身份</b>'), undefined)
  check('meta-grid 蛋白名称 = 识别名', htmlA.includes('<b>蛋白名称</b> p53 N端域构建（5x 点突变）'))
  check('UniProt 行仍标注序列直接输入', htmlA.includes('—（序列直接输入）'))
  check('不再出现「未知靶点（序列输入）」', !htmlA.includes('未知靶点（序列输入）'))
  check('不再笼统「序列靶点评估」题目', !htmlA.includes('序列靶点评估'))

  // ── B. nr 识别来源（含近似 UniProt 条目）──
  console.log('\nB. BLAST nr 识别来源（一致性 + 近似条目外链）')
  const htmlB = await renderOf({
    name: 'Tumor suppressor p53', source: 'blast-nr', sourceLabel: 'BLAST nr 识别', identity: 97.6,
    uniprotId: 'P04637', uniprotEntry: 'P53_HUMAN', organism: 'Homo sapiens', geneName: 'TP53',
    note: 'BLAST nr 最佳命中（UniProt P04637），一致性 97.6%',
  })
  check('<title> nr 识别名 + 一致性', htmlB.includes('<title>靶点结构解析可行性评估报告 — Tumor suppressor p53（序列靶点 · nr 识别 98%）</title>'), htmlB.match(/<title>[^<]+<\/title>/))
  check('h1 题目', htmlB.includes('<h1 class="rpt-title">Tumor suppressor p53（序列靶点 · nr 识别 98%）</h1>'))
  check('UniProt 行含近似条目外链', htmlB.includes('nr 最近条目 <a href="https://www.uniprot.org/uniprotkb/P04637"'), htmlB.match(/nr 最近条目[^<]*<a[^>]*>/)?.[0])
  check('靶点身份行含一致性', /<b>靶点身份<\/b>.*?BLAST nr 识别 · 一致性 98%/.test(htmlB.replace(/\n/g, ' ')))
  check('基因行取身份基因名', htmlB.includes('<b>基因</b> TP53'))
  check('物种行取身份物种', htmlB.includes('<b>物种</b> Homo sapiens'))

  // ── C. 同源推断来源 ──
  console.log('\nC. PDB 同源推断来源')
  const htmlC = await renderOf({ name: 'Tumor suppressor p53', source: 'blast-homolog', sourceLabel: 'PDB 同源推断', identity: 44.2, note: 'PDB 同源结构 1A1A（一致性 44.2%）描述推断 — 未达 UniProt 回填阈值（85%）' })
  check('<title> 同源推断名', htmlC.includes('<title>靶点结构解析可行性评估报告 — Tumor suppressor p53（序列靶点 · 同源 44%）</title>'), htmlC.match(/<title>[^<]+<\/title>/))

  // ── D. 无身份回退（不回归）──
  console.log('\nD. 无身份 — 保持原兜底语义')
  const htmlD = await renderOf(undefined)
  check('<title> 回退「序列靶点评估」', htmlD.includes('<title>靶点结构解析可行性评估报告 — 序列靶点评估</title>'), htmlD.match(/<title>[^<]+<\/title>/))
  check('无靶点身份行', !htmlD.includes('<b>靶点身份</b>'))
  check('BLAST 表仍正常渲染（同源命中在）', htmlD.includes('1A1A'))

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
