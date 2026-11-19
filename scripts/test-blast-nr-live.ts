/**
 * v2.16 BLAST nr 识别 — 真实网络集成验证：
 * 取人 p53（P04637）N 端 100 aa 引入 5 处点突（peptide 精确检索必失败、
 * 但 nr 应以 ~95% 一致性定位回 P04637），验证 submitBlastNr + collectBlastNr +
 * parseBlastNrXml 全链路。
 */
import { submitBlastNr, collectBlastNr } from '../src/lib/eval/blast'
import { uniprotFromSequenceHeader } from '../src/lib/eval/pipeline'

// 人 p53 (P04637) 残基 1-100 原序列
const WT = 'MEEPQSDPSVEPPLSQETFSDLWKLLPENNVLSPLPSQAMDDLMLSPDDIEQWFTEDPGPDEAPRMPEAAPPVAPAPAAPTPAAPAPAPSWPLSSSVM'

// 引入 5 处点突（均匀分布，含前 25 aa 内 → UniProt peptide search 必失败）
const MUTS: Array<[number, string]> = [[6, 'A'], [30, 'G'], [52, 'V'], [73, 'L'], [95, 'T']]
const seq = WT.split('').map((c, i) => (MUTS.some(([p]) => p - 1 === i) ? MUTS.find(([p]) => p - 1 === i)![1] : c)).join('')
console.log(`序列 ${seq.length} aa，${MUTS.length} 处点突（${MUTS.map(([p, r]) => `${WT[p - 1]}${p}${r}`).join(' / ')}）`)

async function main(): Promise<void> {
  console.log('\n—— uniprotFromSequenceHeader 防回归 ——')
  console.log('  sp|P04637|P53_HUMAN →', uniprotFromSequenceHeader('sp|P04637|P53_HUMAN'))
  console.log('  tr|A0A8G0KJC2|A0A8G0KJC2_HUMAN →', uniprotFromSequenceHeader('tr|A0A8G0KJC2|A0A8G0KJC2_HUMAN'), '（10 位 accession 不截断）')

  console.log('\n—— BLAST nr 真实提交 ——')
  const t0 = Date.now()
  const { rid, rtoe } = await submitBlastNr(seq, m => console.log('  ' + m))
  console.log(`  RID=${rid} RTOE=${rtoe}s`)
  const outcome = await collectBlastNr(rid, rtoe, m => console.log('  ' + m), undefined)
  if (!('hits' in outcome)) {
    console.error('  仍在运行（无 deadline 不应发生）')
    process.exit(1)
  }
  console.log(`  完成（${Math.round((Date.now() - t0) / 1000)}s），${outcome.hits.length} 个命中`)

  console.log('\n—— 前 5 命中 ——')
  for (const h of outcome.hits.slice(0, 5)) {
    console.log(`  [${h.db}] ${h.accession}${h.entryName ? ` (${h.entryName})` : ''} | ${h.description.slice(0, 60)} | id ${h.identity}% | e ${h.evalueRaw} | cov ${h.queryCoverage}`)
  }

  const best = outcome.hits.find(h => h.db !== 'other') ?? outcome.hits[0]
  console.log('\n—— 识别结论 ——')
  console.log(`  最佳 UniProt 形态命中: ${best.accession}（${best.description.slice(0, 50)}），identity ${best.identity}%，物种 ${best.organism ?? '—'}，基因 ${best.geneName ?? '—'}`)
  const identified = best.db !== 'other' && best.identity >= 85 && best.accession === 'P04637'
  console.log(`  ${identified ? '✓ 正确定位回 P04637（≥85% 将触发管线全量回填）' : best.db !== 'other' && best.identity >= 85 ? '✓ 识别到 ' + best.accession + '（点突变下非 P04637 亦为合理同源）' : '✗ 未达回填阈值'}`)
}

main().catch(e => { console.error('失败：', e); process.exit(1) })
