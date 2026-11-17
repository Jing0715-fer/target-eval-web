/**
 * v2.14 回归测试：小分子量靶点已有 Cryo-EM 复合物结构时的评分与装配识别
 *
 * 场景（用户反馈实例）：TRGV9（Q99603）单体 ~13.4 kDa，已有 8 个结构全部为
 * Cryo-EM（γδ TCR-CD3 / Fab-TCR 复合物，3.08-4.12Å）。
 * 修复前：标题正则漏检复合物 → 装配仅 27 kDa（寡聚）→ Cryo-EM -1 → 最终
 * X-ray 6 / Cryo-EM 3 / NMR 8（与科学事实相悖）。
 * 修复后应满足：
 *  1. fetchComplexAssemblyInfo 识别出 ≥1 个复合物（含 9JXZ 等 TCR-CD3 条目）
 *  2. buildMwAugmentAnalysis 的装配路径为 complex 且 ≥100 kDa
 *  3. computeScores 的 Cryo-EM 分 ≥7（先例条件化小分子量惩罚 + boost 下限 + 复合物 +1）
 *  4. rationale 不再出现「改用其他方法」，且含「全部已有结构均为 Cryo-EM」
 *  5. 对照组：无 Cryo-EM 先例的小靶点（模拟）行为不变（-2 惩罚 + boost -1 生效）
 */
import { PrismaClient } from '../src/generated/prisma/client'
import { fetchComplexAssemblyInfo, buildMwAugmentAnalysis } from '../src/lib/eval/mw-augment'
import { computeScores } from '../src/lib/eval/score'
import type { OligomerAnalysis, PdbEntry, UniprotInfo, MwAugmentAnalysis } from '../src/lib/eval/types'

const db = new PrismaClient()

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`✗ FAIL: ${msg}`)
    process.exitCode = 1
  } else {
    console.log(`✓ ${msg}`)
  }
}

async function main() {
  const job = await db.$queryRawUnsafe(
    "SELECT uniprotId, title, pdbs, summary FROM EvaluationJob WHERE id = 'cmwiye9t7000lp7cjf5o8xcyz'",
  ) as any[]
  if (!job.length) { console.error('测试数据缺失（Q99603 作业）'); process.exit(1); }
  const pdbs: PdbEntry[] = JSON.parse(job[0].pdbs)
  const summary = JSON.parse(job[0].summary)
  const oligomer: OligomerAnalysis = summary.oligomer
  const uniprot: UniprotInfo = {
    ...summary.uniprot,
    uniprotId: 'Q99603',
    proteinName: 'T cell receptor gamma variable 9',
  }
  console.log(`靶点: ${job[0].uniprotId} ${job[0].title} · 直接结构 ${pdbs.length} 个（Cryo-EM ${pdbs.filter(p => p.isCryoem).length}）`)
  console.log(`修复前评分: X-ray 6 / Cryo-EM 3 / NMR 8（历史作业记录）`)

  // ── 1. 复合物装配识别（RCSB GraphQL 真实网络调用）──
  const complexes = await fetchComplexAssemblyInfo(pdbs)
  console.log(`\n[1] fetchComplexAssemblyInfo: 候选 ${complexes.size} 个条目`)
  for (const [id, c] of complexes) {
    console.log(`    ${id} · ${c.entities.length} 实体 · 装配 ${c.assemblyWeightKda ?? '—'} kDa · ${String(c.title).slice(0, 50)}`)
  }
  assert(complexes.size > 0, '复合物识别非空（修复前为 0）')
  assert(complexes.has('9JXZ') || complexes.has('8JC0') || complexes.has('9JY1'), '包含 TCR-CD3 复合物条目')

  // ── 2. 装配路径判定 ──
  const analysis: MwAugmentAnalysis = buildMwAugmentAnalysis({
    uniprot,
    sequenceLength: 122,
    oligomer,
    directPdbs: pdbs,
    partners: [],
    complexes,
    goal: '',
    goalHints: [],
  })
  console.log(`\n[2] buildMwAugmentAnalysis: 装配路径 ${analysis.assemblyPath} · ${analysis.monomerKda} → ${analysis.assemblyKda} kDa · 复合物 ${analysis.complexes.length} 个`)
  assert(analysis.applicable, '小分子量维度适用')
  assert(analysis.assemblyPath === 'complex', '装配路径为 complex（已有复合物结构）')
  assert((analysis.assemblyKda ?? 0) >= 100, '装配分子量 ≥100 kDa（Cryo-EM 常规区间）')
  const best = analysis.complexes[0]
  assert(best.components.some(c => c.isTarget), `复合物组分含靶点标记（${best.pdbId}，isTarget 回退生效）`)
  assert(best.components.some(c => !c.isTarget && c.kda >= 10), '复合物组分含 ≥10 kDa 伙伴')

  // ── 3/4. 评分与 rationale ──
  const scores = computeScores({
    sequenceLength: 122,
    features: [],
    directPdbs: pdbs,
    blastHits: [],
    coveragePercent: summary.coverage ?? 80,
    oligomer,
    mwAugment: analysis,
    interaction: null,
  })
  console.log(`\n[3] computeScores: X-ray ${scores.xray.score} / Cryo-EM ${scores.cryoem.score} / NMR ${scores.nmr.score} / 总体 ${scores.overall.score}`)
  console.log(`    mwAdj: cryoem ${scores.mwAugmentAdjust?.cryoem} — ${scores.mwAugmentAdjust?.note?.slice(0, 80)}`)
  assert(scores.cryoem.score >= 7, `Cryo-EM 分 ≥7（实际 ${scores.cryoem.score}，修复前 3）`)
  assert(scores.cryoem.score >= scores.nmr.score - 1, 'Cryo-EM 与 NMR 差距 ≤1 分（不再一面倒推荐 NMR）')
  console.log(`\n[4] rationale.cryoem: ${scores.rationale.cryoem}`)
  assert(!scores.rationale.cryoem.includes('改用其他方法'), 'rationale 不再含「改用其他方法」')
  assert(scores.rationale.cryoem.includes('Cryo-EM 结构先例'), 'rationale 引用 Cryo-EM 先例')
  assert(scores.rationale.cryoem.includes('全部已有结构均为 Cryo-EM'), 'rationale 标明全部已有结构均为 Cryo-EM')
  assert((scores.rationale.nmr ?? '').includes('无 NMR 结构先例'), 'NMR rationale 标明无 NMR 先例')

  // ── 5. 对照组：无 Cryo-EM 先例的小靶点行为不变 ──
  const noEmPdbs: PdbEntry[] = pdbs.map(p => ({
    ...p,
    isXray: true,
    isCryoem: false,
    isNmr: false,
    method: 'X-RAY DIFFRACTION',
  }))
  const analysis2 = buildMwAugmentAnalysis({
    uniprot,
    sequenceLength: 122,
    oligomer,
    directPdbs: noEmPdbs,
    partners: [],
    complexes: new Map(),
    goal: '',
    goalHints: [],
  })
  const scores2 = computeScores({
    sequenceLength: 122,
    features: [],
    directPdbs: noEmPdbs,
    blastHits: [],
    coveragePercent: 80,
    oligomer,
    mwAugment: analysis2,
    interaction: null,
  })
  console.log(`\n[5] 对照组（无 Cryo-EM 先例）: X-ray ${scores2.xray.score} / Cryo-EM ${scores2.cryoem.score} / NMR ${scores2.nmr.score}`)
  assert(scores2.cryoem.score <= 4, `对照组小分子量惩罚仍生效（Cryo-EM ≤4，实际 ${scores2.cryoem.score}）`)
  assert(scores2.rationale.cryoem.includes('改用其他方法'), '对照组 rationale 维持原表述')

  console.log(process.exitCode ? '\n=== 存在失败项 ===' : '\n=== 全部通过 ===')
}

main().catch(e => { console.error('ERR', e); process.exit(1) }).finally(() => db.$disconnect())
