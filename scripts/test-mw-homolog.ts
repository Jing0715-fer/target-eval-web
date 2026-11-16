/**
 * v1.27 冒烟测试：同源复合物扩展检索（fetchHomologComplexInfo + buildMwAugmentAnalysis 集成）
 *
 * 场景：
 *  1. 链霉亲和素（streptavidin）同源四聚体 — 1STP（159 aa 亚基，homotetramer ~66 kDa）
 *     靶点单体 150 aa（~16.5 kDa）→ 换算估计 ≈ 4 × 16.5 = 66 kDa（homolog-complex 路径接管）
 *  2. 血红蛋白异源四聚体 — 1A3N（2α2β，~64 kDa）：同源实体按长度识别（α globin 141 aa）
 *  3. parseHomoCopies 单元断言
 */
import { fetchHomologComplexInfo, buildMwAugmentAnalysis, parseHomoCopies } from '../src/lib/eval/mw-augment'
import type { BlastHit } from '../src/lib/eval/types'

function hit(pdbId: string, identity: number, description: string): BlastHit {
  return { pdbId, description, identity, evalue: 1e-20, queryCoverage: 90, method: 'X-RAY DIFFRACTION', resolution: 1.8, evalueRaw: '1e-20' }
}

async function main() {
  // ── 1. parseHomoCopies 断言 ──
  const cases: Array<[string | null, number | null]> = [
    ['homotetrameric', 4],
    ['homodimeric', 2],
    ['homo 7-mer', 7],
    ['homomeric', null],
    ['heterotetrameric', null],
    ['monomeric', null],
    [null, null],
  ]
  let pass = 0
  for (const [input, expected] of cases) {
    const got = parseHomoCopies(input)
    const ok = got === expected
    if (ok) pass++
    console.log(`  parseHomoCopies(${JSON.stringify(input)}) = ${got} ${ok ? '✓' : `✗ (expect ${expected})`}`)
  }
  console.log(`parseHomoCopies: ${pass}/${cases.length} 通过\n`)

  // ── 2. 链霉亲和素场景（同源四聚体）──
  console.log('场景 A：streptavidin 同源四聚体（1STP）— 靶点 150 aa')
  const rA = await fetchHomologComplexInfo(
    [hit('1STP', 41, 'STREPTAVIDIN'), hit('1RST', 12, 'streptavidin mutant')],
    new Set(),
    150,
  )
  console.log(`  检索 ${rA.searched} 个，命中大复合物 ${rA.complexes.length} 个`)
  for (const c of rA.complexes) {
    console.log(`  - ${c.pdbId} identity ${Math.round(c.identity)}% | 同源装配 ~${c.totalKda} kDa → 靶点换算 ~${c.estimatedKda} kDa | homo=${c.isHomoOligomer} | ${c.componentSummary}`)
  }
  if (!rA.complexes.length) throw new Error('场景 A 失败：1STP 应被识别为 ≥50 kDa 同源四聚体')
  if (!rA.complexes[0].isHomoOligomer) throw new Error('场景 A 失败：1STP 应为同源寡聚')
  if (rA.complexes[0].estimatedKda < 50) throw new Error('场景 A 失败：换算装配应 ≥50 kDa')

  // ── 3. buildMwAugmentAnalysis 集成（homolog-complex 路径接管）──
  const analysis = buildMwAugmentAnalysis({
    sequenceLength: 150,
    oligomer: { summary: '未知', category: 'unknown', stoichiometry: '', confidence: 'low', evidence: [], notes: [] },
    directPdbs: [],
    partners: [],
    complexes: new Map(),
    goal: '解析该蛋白与配体结合的复合物结构',
    blastHits: [hit('1STP', 41, 'STREPTAVIDIN')],
    homologSearch: rA,
  })
  console.log(`\n  集成分析：applicable=${analysis.applicable}，单体 ~${analysis.monomerKda} kDa → 装配 ~${analysis.assemblyKda} kDa（路径 ${analysis.assemblyPath}）`)
  console.log(`  检索说明：${analysis.homologSearchNote}`)
  console.log(`  冲突分析 ${analysis.conflicts.length} 条：${analysis.conflicts.map(c => `[${c.level}] ${c.text.slice(0, 50)}…`).join(' | ')}`)
  if (analysis.assemblyPath !== 'homolog-complex') throw new Error('集成失败：应为 homolog-complex 路径')
  if (analysis.assemblyKda == null || analysis.assemblyKda < 50) throw new Error('集成失败：装配分子量应 ≥50 kDa')

  // ── 4. 血红蛋白场景（异源四聚体，同源实体按长度识别）──
  console.log('\n场景 B：血红蛋白异源四聚体（1A3N）— 靶点 140 aa（α globin 尺寸）')
  const rB = await fetchHomologComplexInfo(
    [hit('1A3N', 45, 'HUMAN HAEMOGLOBIN'), hit('2DN1', 30, 'human hemoglobin')],
    new Set(),
    140,
  )
  console.log(`  检索 ${rB.searched} 个，命中大复合物 ${rB.complexes.length} 个`)
  for (const c of rB.complexes) {
    console.log(`  - ${c.pdbId} identity ${Math.round(c.identity)}% | 同源装配 ~${c.totalKda} kDa → 靶点换算 ~${c.estimatedKda} kDa | homo=${c.isHomoOligomer}`)
    console.log(`    组分：${c.componentSummary.slice(0, 120)}`)
    console.log(`    说明：${c.note.slice(0, 100)}`)
  }

  // ── 5. 不触发场景：直接路径装配 ≥50 kDa 时不接管 ──
  console.log('\n场景 C：直接寡聚装配已达标（dimer × 30 kDa = 60 kDa）→ homolog 不接管')
  const analysisC = buildMwAugmentAnalysis({
    sequenceLength: 270,
    oligomer: {
      summary: '同源二聚体', category: 'homo-oligomer', stoichiometry: '2 × 相同亚基', confidence: 'medium',
      evidence: [{ source: 'pdb-stoichiometry', ref: '1ABC', text: 'homodimer', state: { category: 'homo-oligomer', copies: 2, term: 'homodimer' } }],
      notes: [],
    },
    directPdbs: [],
    partners: [],
    complexes: new Map(),
    homologSearch: { searched: 3, complexes: rA.complexes }, // 即使有同源复合物，直接路径 60 kDa ≥ 50 优先
  })
  console.log(`  路径 = ${analysisC.assemblyPath}，装配 ~${analysisC.assemblyKda} kDa，说明：${analysisC.homologSearchNote?.slice(0, 60)}`)
  if (analysisC.assemblyPath !== 'oligomer') throw new Error('场景 C 失败：直接路径 ≥50 kDa 时不应被同源路径接管')

  console.log('\n全部场景通过 ✓')
}

main().catch(e => { console.error('测试失败：', e); process.exit(1) })
