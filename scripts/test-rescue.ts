/** 兜底机制单测：复用真实卡死 RID（D3CHE5EZ016 = NCBI 队列拥堵中的任务），
 *  waitingMs 调小加速验证：应在 ~15s 内触发 RCSB 兜底并返回同源命中 */
import { collectBlastPdbWithRescue } from '../src/lib/eval/blast'
import { readFileSync } from 'node:fs'
const fasta = readFileSync('/tmp/p00533.fasta', 'utf-8')
const seq = fasta.split('\n').filter(l => !l.startsWith('>')).join('').trim()
const t0 = Date.now()
const outcome = await collectBlastPdbWithRescue(
  'D3CHE5EZ014', 5, seq,
  (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, m),
  undefined,
  { waitingMs: 12_000, searchingMs: 30_000, maxRows: 40 },
)
console.log('provider =', outcome.provider)
console.log('rescueNote =', outcome.rescueNote)
console.log('hits =', outcome.hits.length)
console.log('top5:', outcome.hits.slice(0, 5).map(h => `${h.pdbId} ${h.identity}% E=${h.evalueRaw} cov=${h.queryCoverage}`).join(' | '))
if (outcome.provider !== 'rcsb') { console.error('EXPECTED rcsb provider!'); process.exit(1) }
if (outcome.hits.length === 0) { console.error('EXPECTED hits!'); process.exit(1) }
console.log('RESCUE TEST PASSED')
