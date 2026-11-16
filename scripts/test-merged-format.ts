/**
 * v2.8 多靶点合并报告格式回归（renderMergedReportHtml 模板冒烟）：
 *  5 靶点同源家族批次（触发智能折叠 + 全量章节编号）验证：
 *  1. 章节编号 01-11 连续且目录带编号（替代原断续的「一/二/三」硬编码）
 *  2. 目录「靶点速览」含每靶点锚点，结构折叠块 id 与锚点一一对应
 *  3. 对比矩阵扩列（寡聚态/同源结构/文献/总体评级副文本）
 *  4. 刊头靶点卡 mini 仪表盘（PDB/最佳/覆盖/同源/文献数字行）
 *  5. 5 靶点批次 PDB 折叠块默认收起（targets > 3）；3 靶点批次默认展开
 *  6. HTML 结构完整（单根 .page、无未闭合 details）
 */
import { renderMergedReportHtml, type MergedTargetData } from '../src/lib/eval/report-merged'
import type { BlastHit, FormInsights, PdbEntry, RelationJudgment, Scores, SequenceAttribution } from '../src/lib/eval/types'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}`, detail !== undefined ? JSON.stringify(detail) : '') }
}

function mockTarget(n: number, opts: { uniprot: string; name: string; pdbCount: number; blast: number; lit: number; oligo?: 'monomer' | 'homo-oligomer' | 'hetero-complex' }): MergedTargetData {
  const scores: Scores = {
    xray: { score: 6, rating: '中等' },
    cryoem: { score: 5, rating: '中等' },
    nmr: { score: 3, rating: '困难' },
    overall: { score: 6, rating: '中等' },
  }
  const pdbs: PdbEntry[] = Array.from({ length: opts.pdbCount }, (_, i) => ({
    pdbId: `1AB${n}${i}`,
    title: `${opts.name} structure ${i + 1}`,
    method: 'X-RAY DIFFRACTION',
    resolution: 1.8 + i * 0.2,
    releaseDate: '2021-06-01',
    ligands: [],
    isXray: true,
    isCryoem: false,
    isNmr: false,
  }))
  const blast: BlastHit[] = Array.from({ length: opts.blast }, (_, i) => ({
    pdbId: `2CD${n}${i}`,
    description: `homolog hit ${i + 1}`,
    identity: 40 + i,
    resolution: 2.1,
    method: 'X-RAY DIFFRACTION',
  }))
  return {
    jobId: `job_${n}`,
    label: opts.uniprot,
    uniprotId: opts.uniprot,
    proteinName: opts.name,
    geneNames: [opts.name.toUpperCase()],
    organism: 'Homo sapiens',
    sequenceLength: 300 + n * 10,
    scores,
    methodStats: { xrayCount: opts.pdbCount, cryoemCount: 0, nmrCount: 0, bestResolution: opts.pdbCount ? 1.8 : null },
    directPdbs: pdbs,
    blastHits: blast,
    coveragePercent: 55 + n,
    coverageText: '1-120, 200-300',
    literature: Array.from({ length: opts.lit }, (_, i) => ({
      pmid: `3${n}0000${i}`,
      title: `${opts.name} paper ${i + 1}`,
      journal: 'Nature',
      year: '2020',
      doi: '',
    })),
    literatureCount: opts.lit,
    ligandCount: 0,
    durationMs: 60000,
    oligomer: opts.oligo
      ? { category: opts.oligo, stoichiometry: 'homodimer', confidence: 'high', evidence: [], summary: 'mock oligomer analysis' }
      : undefined,
  }
}

const relation: RelationJudgment = {
  related: true,
  relationType: 'homologous',
  confidence: 'high',
  rationale: '系统全长序列比对确认同源家族（一致性 44%）',
  strategy: '家族证据互用',
  homologPairs: [
    { a: 'P69905', b: 'P68871', identity: 44 },
    { a: 'P69905', b: 'P12345', identity: 61 },
  ],
}

const attribution: SequenceAttribution[] = [
  { index: 0, length: 142, uniprotId: 'P69905', identity: 100, kind: 'construct', start: 1, end: 142 },
  { index: 1, length: 120, kind: 'unmatched' },
]

const insights: FormInsights = {
  goals: ['解析家族代表结构', '评估复合物可行性'],
  scientificQuestions: [],
  source: 'llm',
}

async function main() {
  const targets5: MergedTargetData[] = [
    mockTarget(1, { uniprot: 'P69905', name: 'Hemoglobin subunit alpha', pdbCount: 12, blast: 8, lit: 6, oligo: 'hetero-complex' }),
    mockTarget(2, { uniprot: 'P68871', name: 'Hemoglobin subunit beta', pdbCount: 10, blast: 6, lit: 5, oligo: 'hetero-complex' }),
    mockTarget(3, { uniprot: 'P12345', name: 'Myoglobin', pdbCount: 7, blast: 4, lit: 3, oligo: 'monomer' }),
    mockTarget(4, { uniprot: 'P23456', name: 'Neuroglobin', pdbCount: 2, blast: 2, lit: 1 }),
    mockTarget(5, { uniprot: 'P34567', name: 'Cytoglobin', pdbCount: 0, blast: 1, lit: 0 }),
  ]

  const html = await renderMergedReportHtml({
    targets: targets5,
    relation,
    goal: '家族级结构解析可行性评估',
    markdown: '# 血红蛋白家族五成员合并评估\n\n## 执行摘要\n\nmock 摘要。\n\n## 靶点关系分析\n\nmock 关系。\n\n## 各靶点结构可行性综述\n\n### Hemoglobin subunit alpha\n\nmock。\n\n## 整合可行性与实验策略\n\nmock 策略。\n\n## 总结\n\nmock 总结。',
    title: '血红蛋白家族五成员合并结构可行性评估',
    llmOk: true,
    llmErrors: [],
    images: [],
    assetDir: '/tmp/none',
    batchReportId: 'br_test12345678',
    engineSummary: 'mock-engine',
    sequenceAttribution: attribution,
    insights,
  })

  console.log('\n[1] 章节编号连续性（5 靶点批次：无配体/无图/无共有结构 → 存在章节 01-08）')
  const secNos = [...html.matchAll(/<span class="sec-no">(\d+)<\/span>/g)].map(m => m[1])
  console.log('  编号序列：', secNos.join(','))
  check('存在章节编号 01-08 连续', secNos.join(',') === '01,02,03,04,05,06,07,08')
  check('无残留硬编码「一、」章节头', !/一、合并评估分析|二、跨靶点对比矩阵|三、各靶点 PDB 结构|四、同源结构|五、各靶点文献|六、客户实验数据/.test(html))
  check('目录条目带编号', html.includes('01 · 合并评估分析') && html.includes('02 · 客户评估表要点') && html.includes('08 · 各靶点文献'))

  console.log('\n[2] 靶点速览导航 + 锚点')
  const tocTargets = [...html.matchAll(/href="#(struct-[A-Za-z0-9]+)"/g)].map(m => m[1])
  console.log('  目录锚点：', tocTargets.join(','))
  check('靶点速览含 4 个有结构靶点锚点', tocTargets.length === 4)
  const foldIds = [...html.matchAll(/<details class="pdb-fold" id="(struct-[A-Za-z0-9]+)"/g)].map(m => m[1])
  check('目录锚点与折叠块 id 一一对应', foldIds.length === 4 && tocTargets.every(a => foldIds.includes(a)))

  console.log('\n[3] 对比矩阵扩列')
  check('表头含寡聚态/同源结构/文献列', html.includes('<th>寡聚态</th>') && html.includes('<th class="num">同源结构</th>') && html.includes('<th class="num">文献</th>'))
  check('总体分带评级副文本', html.includes('class="mtx-rating"'))
  check('寡聚态徽标入矩阵', html.includes('异源复合物</span>') && html.includes('单体</span>'))

  console.log('\n[4] 靶点卡 mini 仪表盘')
  check('PDB/覆盖/同源/文献数字行存在', html.includes('class="tgt-stats"') && html.includes('PDB <b>12</b>') && html.includes('覆盖 <b>56%</b>') && html.includes('同源 <b>8</b>') && html.includes('文献 <b>6</b>'))

  console.log('\n[5] 大批次智能折叠')
  const openFolds = [...html.matchAll(/<details class="pdb-fold" id="[^"]+" open>/g)].length
  check('5 靶点批次 PDB 折叠默认收起（open=0）', openFolds === 0, { openFolds })

  const targets3 = targets5.slice(0, 3)
  const html3 = await renderMergedReportHtml({
    targets: targets3,
    relation,
    markdown: '# mock\n\n## 执行摘要\n\nmock。',
    title: '三靶点冒烟',
    llmOk: true,
    llmErrors: [],
    images: [],
    assetDir: '/tmp/none',
    batchReportId: 'br_smoke3',
    engineSummary: 'mock-engine',
    sequenceAttribution: attribution,
    insights,
  })
  const openFolds3 = [...html3.matchAll(/<details class="pdb-fold" id="[^"]+" open>/g)].length
  check('3 靶点批次 PDB 折叠默认展开（open=3）', openFolds3 === 3, { openFolds3 })

  console.log('\n[6] HTML 结构完整（剔除 script 块后计数 — 脚本注释含 <details> 字面量）')
  const bodyOnly = html.replace(/<script[\s\S]*?<\/script>/g, '')
  const openDetails = [...bodyOnly.matchAll(/<details\b[^>]*>/g)].length
  const closeDetails = [...bodyOnly.matchAll(/<\/details>/g)].length
  check('details 标签配对', openDetails === closeDetails, { openDetails, closeDetails })
  check('单根 .page 容器', (html.match(/<div class="page"/g) ?? []).length === 1)
  check('v2.8 格式页脚标注', html.includes('v2.8 格式'))

  console.log(`\n结果：${pass} 通过 · ${fail} 失败`)
  if (fail > 0) process.exit(1)
}

main().catch(e => {
  console.error('FATAL', e)
  process.exit(1)
})
