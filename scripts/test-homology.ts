/**
 * v1.10 同源算法单元验证：真实 UniProt 全长序列。
 * 用法: bun run scripts/test-homology.ts
 * 覆盖: 直系同源（人/小鼠 EGFR ≈97%）/ 近缘旁系（EGFR/HER2 ≈75%）/
 *  无关对照（EGFR×p53 → 0，种子数下限拒绝）/ 自身比对 / 家族聚类 / 序列归属
 * （构建→construct 精确区间 / 抗体 Fc→antibody / GFP→unmatched）。
 * 算法参数调整（K/阈值/种子下限）后应重跑本脚本。
 */
import { estimateHomology, clusterHomologs, attributeSequences } from '../src/lib/eval/homology'

async function fetchSeq(acc: string): Promise<string> {
  const res = await fetch(`https://rest.uniprot.org/uniprotkb/${acc}.json?fields=sequence`, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error(`fetch ${acc} HTTP ${res.status}`)
  const j = await res.json() as { sequence?: { value?: string } }
  return (j.sequence?.value ?? '').toUpperCase()
}

const [egfrHuman, egfrMouse, her2, p53] = await Promise.all([
  fetchSeq('P00533'), // 人 EGFR 1210aa
  fetchSeq('Q01279'), // 小鼠 Egfr（直系同源）
  fetchSeq('P04626'), // 人 ERBB2/HER2（近缘旁系同源）
  fetchSeq('P04637'), // 人 p53（无关对照）
])
console.log(`_lengths: EGFR=${egfrHuman.length} mouseEgfr=${egfrMouse.length} HER2=${her2.length} p53=${p53.length}`)

const t0 = Date.now()
const cases: Array<[string, string, string, number | null, boolean]> = [
  ['人EGFR × 小鼠Egfr（直系同源）', egfrHuman, egfrMouse, 70, true],
  ['人EGFR × 人HER2（旁系同源）', egfrHuman, her2, 35, true],
  ['人EGFR × 人p53（无关对照）', egfrHuman, p53, null, false],
  ['人EGFR × 自身', egfrHuman, egfrHuman, 99, true],
]
let pass = 0
for (const [name, a, b, minId, expectHomolog] of cases) {
  const r = estimateHomology(a, b)
  const ok = r.isHomolog === expectHomolog && (minId == null || r.identity >= minId)
  console.log(`${ok ? '✓' : '✗'} ${name}: identity=${r.identity}% support=${(r.support * 100).toFixed(1)}% isHomolog=${r.isHomolog} method=${r.method}`)
  if (ok) pass++
}

// 聚类
const clustered = clusterHomologs([
  { uniprotId: 'P00533', sequence: egfrHuman },
  { uniprotId: 'Q01279', sequence: egfrMouse },
  { uniprotId: 'P04626', sequence: her2 },
  { uniprotId: 'P04637', sequence: p53 },
])
const familyIds = clustered.clusters.map(c => c.map(i => ['P00533', 'Q01279', 'P04626', 'P04637'][i]).join('+'))
console.log(`clusters(≥40%): [${familyIds.join(' | ')}] pairs:`, clustered.pairs.map(p => `${p.a}↔${p.b}=${p.identity}%`).join(' '))
const clusterOk = clustered.clusters.length === 1 && familyIds[0]?.includes('P04637') === false
console.log(clusterOk ? '✓ 聚类正确（EGFR+小鼠Egfr+HER2 一族，p53 独立）' : '✗ 聚类异常')
if (clusterOk) pass++

// 归属：EGFR 激酶域构建 / 抗体 Fc / 无关序列（GFP）
const gfp = 'MSKGEELFTGVVPILVELDGDVNGHKFSVSGEGEGDATYGKLTLKFICTTGKLPVPWPTLVTTFSYGVQCFSRYPDHMKQFFKSAMPEGYVQERTISFKDDGTYKTRAEVKFEGDTLVNRIELKGIDFKEDGNILGHKLEYNYNSHNVYIMADKQKNGIKVNFKIRHNIEDGSVQLADHYQQNTPIGDGPVLLPDNHYLSTQSALSKDPNEKRDHMVLLEFVTAAGITHGMDELYK'
const kinaseDomain = egfrHuman.slice(712, 979) // 激酶域片段
const fcSeq = 'GGGSPPCPPCPAPELLGGPSVFLFPPKPKDTLMISRTPEVTCVVVDVSQEDPEVQFNWYVDGVEVHNAKTKPREEQYNSTYRVVSVLTVLHQDWLNGKEYKCKVSNKALPAPIEKTISKAKGQPREPQVYTLPPSRDELTKNQVSLTCLVKGFYPSDIAVEWESNGQPENNYKTTPPVLDSDGSFFLYSKLTVDKSRWQQGNVFSCSVMHEALHNHYTQKSLSLSPGK'
const attrs = attributeSequences(
  [
    { header: 'EGFR 激酶域构建（aa713-979）', seq: kinaseDomain, length: kinaseDomain.length },
    { header: '1C9-Fc 抗体', seq: fcSeq, length: fcSeq.length },
    { header: 'GFP 无关蛋白', seq: gfp, length: gfp.length },
  ],
  [
    { uniprotId: 'P00533', sequence: egfrHuman },
    { uniprotId: 'P04637', sequence: p53 },
  ],
)
for (const a of attrs) console.log(`  归属: [${a.kind}] ${a.header} → ${a.uniprotId ?? '—'} ${a.identity ?? '-'}% ${a.start != null && a.end != null ? `区间${a.start}-${a.end}` : ''}`)
const attrOk = attrs[0].kind === 'construct' && attrs[0].uniprotId === 'P00533' && attrs[1].kind === 'antibody' && attrs[2].kind !== 'construct'
console.log(attrOk ? '✓ 归属正确（激酶域→construct EGFR；Fc→antibody；无关→非 construct）' : '✗ 归属异常')
if (attrOk) pass++

console.log(`\n耗时 ${Date.now() - t0}ms（含网络）；PASS ${pass}/6`)
if (pass < 6) process.exit(1)
console.log('HOMOLOGY TEST PASSED')
