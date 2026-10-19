import { collectBlastPdb } from '../src/lib/eval/blast'
const rid = process.argv[2]
const rtoe = parseInt(process.argv[3] ?? '20', 10)
if (!rid) { console.error('usage: bun run scripts/blast-poll.ts <RID> [RTOE]'); process.exit(1) }
const t0 = Date.now()
try {
  const hits = await collectBlastPdb(rid, rtoe, (m) => console.log(`[poll ${(Date.now()-t0)/1000|0}s]`, m))
  console.log(`DONE in ${((Date.now()-t0)/1000).toFixed(1)}s, hits=${hits.length}`)
  console.log('top5:', hits.slice(0,5).map(h => `${h.pdbId}:${h.identity}%`).join(', '))
} catch (e) {
  console.error(`FAILED after ${((Date.now()-t0)/1000).toFixed(1)}s:`, e instanceof Error ? e.message : e)
  process.exit(1)
}
