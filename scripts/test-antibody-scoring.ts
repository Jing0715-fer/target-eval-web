/**
 * v2.72 验证：抗原-抗体复合物评分（computeScores complexLengthAa +
 * computeMwAugmentAdjust 抗体路径 + buildMwAugmentAnalysis 装配择优）。
 */
import { buildMwAugmentAnalysis, analyzeMwAugmentation } from '../src/lib/eval/mw-augment'
import { computeMwAugmentAdjust, computeScores } from '../src/lib/eval/score'

const mkInput = (seqLen: number, antibodyAa?: number) => ({
  sequenceLength: seqLen,
  oligomer: { category: 'monomer' as const, evidence: [], summary: '单体', label: '单体', stoichiometry: null, confidence: 'low' as const, notes: [] },
  directPdbs: [],
  partners: [],
  complexes: new Map(),
  ...(antibodyAa ? { antibodyPartner: { chains: Math.max(1, Math.round(antibodyAa / 220)), lengthAa: antibodyAa } } : {}),
})

console.log('═══ 1) mw-augment 抗体装配路径（196 aa 抗原 + 247 aa scFv ≈ 48.7 kDa 复合物）═══')
const a1 = buildMwAugmentAnalysis(mkInput(196, 247))
console.log('applicable:', a1.applicable, '| 装配:', a1.assemblyKda, 'kDa | 路径:', a1.assemblyPath)
console.log('basis:', a1.assemblyBasis.slice(0, 80))
const adj1 = computeMwAugmentAdjust(a1)
console.log('调整：cryoem', adj1?.cryoem, '| note:', adj1?.note?.slice(0, 90))

console.log('\n═══ 2) 196 aa 抗原 + 430 aa Fab（≈ 68.9 kDa — 50-100 区间 → +1）═══')
const a2 = buildMwAugmentAnalysis(mkInput(196, 430))
const adj2 = computeMwAugmentAdjust(a2)
console.log('装配:', a2.assemblyKda, 'kDa | 路径:', a2.assemblyPath, '| cryoem 调整:', adj2?.cryoem)

console.log('\n═══ 3) 196 aa 抗原 + 1300 aa IgG×2（≈ 164 kDa — ≥100 → +1）═══')
const a3 = buildMwAugmentAnalysis(mkInput(196, 1300))
const adj3 = computeMwAugmentAdjust(a3)
console.log('装配:', a3.assemblyKda, 'kDa | 路径:', a3.assemblyPath, '| cryoem 调整:', adj3?.cryoem)

console.log('\n═══ 4) computeScores：Cryo-EM 基础分按复合物尺寸（196+247=443 aa）═══')
const noAb = computeScores({ sequenceLength: 196, features: [], directPdbs: [], blastHits: [], coveragePercent: 0, oligomer: mkInput(196).oligomer })
const withAb = computeScores({
  sequenceLength: 196, features: [], directPdbs: [], blastHits: [], coveragePercent: 0,
  oligomer: mkInput(196).oligomer, complexLengthAa: 443,
  mwAugment: a1,
})
console.log(`无抗体（单体 196 aa）：cryo-EM ${noAb.cryoem.score}/10（小分子量 -2 惩罚适用）`)
console.log(`有抗体（复合物 443 aa）：cryo-EM ${withAb.cryoem.score}/10（惩罚解除 + mw 调整 ${computeMwAugmentAdjust(a1)?.cryoem}）`)
console.log('依据：', withAb.rationale.cryoem.slice(0, 100))

console.log('\n═══ 5) 大抗原（1070 aa）+ 抗体：mwAugment 不适用但基础分按复合物（2823 aa → +3）═══')
const bigNoAb = computeScores({ sequenceLength: 1070, features: [], directPdbs: [], blastHits: [], coveragePercent: 0, oligomer: mkInput(1070).oligomer })
const bigWithAb = computeScores({ sequenceLength: 1070, features: [], directPdbs: [], blastHits: [], coveragePercent: 0, oligomer: mkInput(1070).oligomer, complexLengthAa: 2823 })
console.log(`无抗体：${bigNoAb.cryoem.score}/10 → 有抗体（复合物 2823 aa）：${bigWithAb.cryoem.score}/10`)

console.log('\n═══ 6) analyzeMwAugmentation 快速路径（≥50 kDa 单体）携带抗体备注 ═══')
void analyzeMwAugmentation({ ...mkInput(600, 430), signal: undefined as unknown as AbortSignal }).then(a => {
  console.log('applicable:', a.applicable, '| notes 尾条:', a.notes[a.notes.length - 1]?.slice(0, 90))
})
