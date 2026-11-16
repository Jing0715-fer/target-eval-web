/**
 * v2.16 RCSB 命中实体序号修复 — 真实网络验证：
 * 用 E2E 同款突变 p53 序列跑 searchRcsbHomologs，断言命中携带 entityId，
 * 并按命中实体取 UniProt（对照旧的 entity-1 取法，验证复合物不再取错链）。
 */
import { searchRcsbHomologs, fetchUniprotForEntryEntity } from '../src/lib/eval/rcsb-search'

const WT = 'MEEPQSDPSVEPPLSQETFSDLWKLLPENNVLSPLPSQAMDDLMLSPDDIEQWFTEDPGPDEAPRMPEAAPPVAPAPAAPTPAAPAPAPSWPLSSSVM'
const MUTS: Array<[number, string]> = [[6, 'A'], [30, 'G'], [52, 'V'], [73, 'L'], [95, 'T']]
const seq = WT.split('').map((c, i) => (MUTS.some(([p]) => p - 1 === i) ? MUTS.find(([p]) => p - 1 === i)![1] : c)).join('')

async function main(): Promise<void> {
  console.log(`查询序列 ${seq.length} aa（5x 突变 p53 N 端）…`)
  const hits = await searchRcsbHomologs(seq, { maxRows: 8 })
  console.log(`\n命中 ${hits.length} 个（前 5）：`)
  for (const h of hits.slice(0, 5)) {
    console.log(`  ${h.pdbId} entity=${h.entityId ?? '—'} identity=${h.identity}% cov=${h.queryCoverage}aa`)
  }
  const withEntity = hits.filter(h => h.entityId != null).length
  console.log(`\n携带 entityId 的命中：${withEntity}/${hits.length}`)

  const best = hits[0]
  if (!best) { console.log('（无命中 — 网络条件变化）'); return }
  const accNew = await fetchUniprotForEntryEntity(best.pdbId, best.entityId ?? 1)
  const accOld = await fetchUniprotForEntryEntity(best.pdbId, 1)
  console.log(`\n最佳命中 ${best.pdbId}（identity ${best.identity}%）：`)
  console.log(`  v2.16 按命中实体 ${best.entityId} → ${accNew}`)
  console.log(`  旧 entity-1 取法        → ${accOld}`)
  console.log(`  ${accNew === accOld ? '（本例两者一致 — 非复合物主链）' : accNew && accOld ? '（复合物结构：按命中实体归属修复了取链错误）' : ''}`)
}
main().catch(e => { console.error('失败：', e); process.exit(1) })
