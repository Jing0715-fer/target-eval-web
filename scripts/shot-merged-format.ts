/**
 * v2.8 合并报告格式视觉验证：渲染 mock 报告 → 截图（刊头/目录/矩阵/结构折叠区）
 */
import { chromium } from 'playwright'
import { renderMergedReportHtml, type MergedTargetData } from '../src/lib/eval/report-merged'
import type { BlastHit, PdbEntry, RelationJudgment, Scores, SequenceAttribution, FormInsights } from '../src/lib/eval/types'

function mockTarget(n: number, opts: { uniprot: string; name: string; pdbCount: number; blast: number; lit: number; oligo?: 'monomer' | 'homo-oligomer' | 'hetero-complex' }): MergedTargetData {
  const scores: Scores = { xray: { score: 6, rating: '中等' }, cryoem: { score: 5, rating: '中等' }, nmr: { score: 3, rating: '困难' }, overall: { score: 6, rating: '中等' } }
  const pdbs: PdbEntry[] = Array.from({ length: opts.pdbCount }, (_, i) => ({ pdbId: `1AB${n}${i}`, title: `${opts.name} structure ${i + 1}`, method: 'X-RAY DIFFRACTION', resolution: 1.8 + i * 0.2, releaseDate: '2021-06-01', ligands: [], isXray: true, isCryoem: false, isNmr: false }))
  const blast: BlastHit[] = Array.from({ length: opts.blast }, (_, i) => ({ pdbId: `2CD${n}${i}`, description: `homolog hit ${i + 1}`, identity: 40 + i, resolution: 2.1, method: 'X-RAY DIFFRACTION' }))
  return { jobId: `job_${n}`, label: opts.uniprot, uniprotId: opts.uniprot, proteinName: opts.name, geneNames: [opts.name.toUpperCase()], organism: 'Homo sapiens', sequenceLength: 300 + n * 10, scores, methodStats: { xrayCount: opts.pdbCount, cryoemCount: 0, nmrCount: 0, bestResolution: opts.pdbCount ? 1.8 : null }, directPdbs: pdbs, blastHits: blast, coveragePercent: 55 + n, coverageText: '1-120, 200-300', literature: Array.from({ length: opts.lit }, (_, i) => ({ pmid: `3${n}0000${i}`, title: `${opts.name} paper ${i + 1}`, journal: 'Nature', year: '2020', doi: '' })), literatureCount: opts.lit, ligandCount: 0, durationMs: 60000, oligomer: opts.oligo ? { category: opts.oligo, stoichiometry: opts.oligo === 'monomer' ? 'monomer' : 'homodimer', confidence: 'high', evidence: [{ source: 'pdb-title', ref: '1AB10', text: 'biological assembly dimer' }], summary: 'mock oligomer analysis for layout verification' } : undefined }
}

const relation: RelationJudgment = { related: true, relationType: 'homologous', confidence: 'high', rationale: '系统全长序列比对确认同源家族（P69905 与 P68871 一致性 44%，P69905 与 P12345 一致性 61%）', strategy: '同源家族合并评估：任一成员的已有结构与构建经验可直接指导其他成员', homologPairs: [{ a: 'P69905', b: 'P68871', identity: 44 }, { a: 'P69905', b: 'P12345', identity: 61 }] }
const attribution: SequenceAttribution[] = [
  { index: 0, length: 142, uniprotId: 'P69905', identity: 100, kind: 'construct', start: 1, end: 142 },
  { index: 1, length: 120, uniprotId: 'P68871', identity: 38, kind: 'homolog' },
  { index: 2, length: 125, kind: 'antibody' },
  { index: 3, length: 100, kind: 'unmatched' },
]
const insights: FormInsights = { goals: ['解析家族代表结构', '评估复合物可行性', '覆盖可变区构象状态'], scientificQuestions: ['可变区构象是否保守'], experimentalSummary: 'mock 实验摘要。', sequenceNotes: 'mock 构建说明。', homologs: 'mock 同源信息。', keyConcerns: ['样品量不足'], source: 'llm' }

const targets = [
  mockTarget(1, { uniprot: 'P69905', name: 'Hemoglobin subunit alpha', pdbCount: 12, blast: 8, lit: 6, oligo: 'hetero-complex' }),
  mockTarget(2, { uniprot: 'P68871', name: 'Hemoglobin subunit beta', pdbCount: 10, blast: 6, lit: 5, oligo: 'hetero-complex' }),
  mockTarget(3, { uniprot: 'P12345', name: 'Myoglobin', pdbCount: 7, blast: 4, lit: 3, oligo: 'monomer' }),
  mockTarget(4, { uniprot: 'P23456', name: 'Neuroglobin', pdbCount: 2, blast: 2, lit: 1 }),
  mockTarget(5, { uniprot: 'P34567', name: 'Cytoglobin', pdbCount: 0, blast: 1, lit: 0 }),
]

const md = `# 血红蛋白家族五成员合并结构可行性评估

## 执行摘要

本批次五个球状蛋白家族成员整体结构解析可行性为**中等偏上**。家族代表 Hemoglobin subunit alpha 已有 12 个直接结构（最佳 1.80Å），家族证据可直接指导其余成员。

### 可行性结论（家族级）

- **结论分级**：中高
- **关键依据**：P69905 直接结构 12 个；P68871 覆盖率 57%

## 靶点关系分析

### 关系判定与证据

系统全长序列两两比对确认同源家族。

## 各靶点结构可行性综述

### Hemoglobin subunit alpha

一句话结论：可行性高，推荐 X-ray。

## 整合可行性与实验策略

### 跨靶点对比矩阵

| 靶点 | PDB | 总体 |
|---|---|---|
| P69905 | 12 | 6 |

## 总结

家族级 go。`

const html = await renderMergedReportHtml({ targets, relation, goal: '家族级结构解析可行性评估', markdown: md, title: '血红蛋白家族五成员合并结构可行性评估', llmOk: true, llmErrors: [], images: [], assetDir: '/tmp/none', batchReportId: 'br_shot12345678', engineSummary: 'mock-engine', sequenceAttribution: attribution, insights })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1000, height: 1400 } })
await page.setContent(html, { waitUntil: 'networkidle' }).catch(() => {})

// 顶部：刊头（靶点卡 mini 仪表盘）+ 目录（编号 + 靶点速览）
await page.screenshot({ path: '/tmp/render/merged-v28-top.png' })
// 目录 + 编号章节
await page.locator('#matrix').scrollIntoViewIfNeeded()
await page.screenshot({ path: '/tmp/render/merged-v28-matrix.png' })
// 结构折叠区（5 靶点默认收起 + 锚点目标）
await page.locator('#pdbs').scrollIntoViewIfNeeded()
await page.screenshot({ path: '/tmp/render/merged-v28-pdbs.png' })

await browser.close()
console.log('done')
