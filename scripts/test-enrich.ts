import { searchRcsbHomologs } from '../src/lib/eval/rcsb-search'
import { enrichBlastHits } from '../src/lib/eval/blast'
import { readFileSync } from 'node:fs'
const fasta = readFileSync('/tmp/p00533.fasta', 'utf-8')
const seq = fasta.split('\n').filter(l => !l.startsWith('>')).join('').trim()
const hits = await searchRcsbHomologs(seq, { maxRows: 25 })
console.log('raw hits:', hits.length, '| first description:', JSON.stringify(hits[0]?.description))
const enriched = await enrichBlastHits(hits, new Set())
console.log('enriched:', enriched.length)
for (const h of enriched.slice(0, 5)) {
  console.log(` ${h.pdbId} ${h.identity}% E=${h.evalueRaw} ${h.method.slice(0, 24)} ${h.resolution ?? '—'}Å ${JSON.stringify(h.description.slice(0, 50))}`)
}
