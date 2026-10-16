import { submitBlastPdb } from '../src/lib/eval/blast'
import { readFileSync } from 'node:fs'
const fasta = readFileSync('/tmp/p00533.fasta', 'utf-8')
const seq = fasta.split('\n').filter(l => !l.startsWith('>')).join('').trim()
console.log('seq length:', seq.length)
const { rid, rtoe } = await submitBlastPdb(seq, (m) => console.log('[submit]', m))
console.log('RID=' + rid, 'RTOE=' + rtoe)
