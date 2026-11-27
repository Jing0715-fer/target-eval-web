/**
 * v2.95 验证脚本：EBI UniProtKB 全库兜底通道（NCBI nr 失败后的身份识别替补）。
 * 复现用户场景：NCBI 拥堵日 nr 识别超时后，改经 EBI 全库（uniprotkb 含 TrEMBL）
 * 检索定位靶点身份。
 *
 * 用法：bun scripts/test-ebi-nr-fallback.ts
 *  1. 取真实蛋白序列片段 + 点突变（模拟带构建差异的提交序列）
 *  2. submitUniprotSequenceBlast(database='uniprotkb', alignments=50) — 全库提交
 *  3. collectUniprotSequenceBlast(maxWallMs=6min, maxHits=50, label=…) — 兜底口径收集
 *  4. 校验命中形态（accession/identity/queryCoverage/db sp|tr 分类）与耗时
 */
import { submitUniprotSequenceBlast, collectUniprotSequenceBlast } from '../src/lib/eval/uniprot-blast'

async function main() {
  // 炭疽保护性抗原（P12929）— 用户实测靶点 PA_22f1_fab_new 的同源家族
  const res = await fetch('https://rest.uniprot.org/uniprotkb/P12929.fasta')
  if (!res.ok) throw new Error(`fetch P12929 failed: HTTP ${res.status}`)
  const fasta = await res.text()
  const full = fasta.split('\n').filter(l => !l.startsWith('>')).join('').trim()
  // 前 240 aa + 两处点突变（模拟带构建差异的提交序列 — 不构成精确子串）
  const mutated = full.slice(0, 240).slice(0, 10) + 'AAA' + full.slice(13, 100) + 'GGG' + full.slice(103, 240)
  if (mutated.length !== 240) throw new Error(`序列长度异常：${mutated.length}`)
  console.log(`[test] 序列 ${mutated.length} aa（P12929 前 240 aa + 6 处点突变模拟构建差异）`)

  const t0 = Date.now()
  const job = await submitUniprotSequenceBlast(mutated, undefined, { database: 'uniprotkb', alignments: 50 })
  console.log(`[test] 已提交 EBI 全库作业：${job.jobId}（提交耗时 ${Date.now() - t0}ms）`)

  const outcome = await collectUniprotSequenceBlast(job, {
    maxWallMs: 6 * 60_000,
    maxHits: 50,
    label: 'EBI UniProtKB 全库检索',
    onProgress: m => console.log(`[poll] ${m}`),
  })
  if (!('hits' in outcome)) throw new Error('stillRunning（不应发生 — 无段预算场景）')

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`\n[test] 全库检索完成：${outcome.hits.length} 个命中（总耗时 ${elapsed}s）`)
  for (const h of outcome.hits.slice(0, 8)) {
    const db = h.db === 'sp' ? 'SP' : h.db === 'tr' ? 'TR' : '??'
    console.log(`  ${db} ${h.accession.padEnd(10)} ${String(h.identity).padStart(5)}% cov=${String(h.queryCoverage).padStart(3)} e=${h.evalueRaw.padEnd(6)} ${h.description.slice(0, 46)}${h.organism ? ` [${h.organism.slice(0, 22)}]` : ''}`)
  }
  if (!outcome.hits.length) throw new Error('无命中（意外 — P12929 片段必有同源）')
  const spTr = outcome.hits.filter(h => h.db !== 'other').length
  const bestId = Math.max(...outcome.hits.map(h => h.identity))
  console.log(`\n[test] db 归类：sp/tr ${spTr}/${outcome.hits.length}；最佳一致性 ${bestId}%`)
  if (bestId < 95) throw new Error(`最佳一致性 ${bestId}% 异常（点突变构建应 ≥97%）`)
  console.log('[test] PASS — v2.95 EBI UniProtKB 全库兜底通道可用')
}

main().catch(e => { console.error('[test] FAIL:', e); process.exit(1) })
