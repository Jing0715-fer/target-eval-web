/**
 * v2.18 LLM 智能调分 — 真实链路冒烟（内置 z-ai 引擎实际调用）：
 *  1. 用 FBXO21（O94952）真实场景构造评分复核输入（无直接结构/curated 复合物证据）
 *  2. reviewScoresWithLlm 实际调用 LLM，验证：输出可解析为提案、超时/失败不抛错
 *  3. applyLlmScoreAdjust 应用后：分数钳制在 1-10、总体 = 三方法 max、llmAdjust 记录
 *  4. 时延观察：复核调用应落在 30s 预算内（实际部署超时钳制 10-30s）
 *
 * 运行：bun scripts/smoke-score-llm-live.ts
 */
import { reviewScoresWithLlm, applyLlmScoreAdjust } from '../src/lib/eval/score-llm'
import { computeScores, type ScoreInput } from '../src/lib/eval/score'
import { getEngineSummary } from '../src/lib/eval/llm-provider'

const t0 = Date.now()

// FBXO21 真实场景（v2.7 时长实测同款靶点 — 无直接结构 + curated 复合物装配 ~184 kDa）
const input: ScoreInput = {
  sequenceLength: 628,
  features: [
    { type: 'Domain', description: 'F-box', begin: 40, end: 90 },
    { type: 'Domain', description: 'WD repeat', begin: 200, end: 560 },
    { type: 'Region', description: 'Disordered', begin: 1, end: 35 },
  ],
  directPdbs: [],
  blastHits: [],
  coveragePercent: 0,
  oligomer: {
    category: 'hetero-complex',
    label: 'SCF 复合物组分（推断）',
    stoichiometry: 'CUL1:FBXO21:RBX1:SKP1',
    confidence: 'medium',
    evidence: [{ source: 'uniprot-subunit', ref: 'O94952', text: 'SCF（Skp1-Cul1-F-box）复合物底物识别亚基', state: { category: 'hetero-complex', copies: null, term: '' } }],
    summary: 'SCF E3 泛素连接酶复合物组分（hetero-complex）— curated 复合物 CPX-7930',
    notes: ['共表达组装需验证'],
  } as never,
  mwAugment: null,
  interaction: null,
}
const base = computeScores(input)
console.log(`规则分：X-ray ${base.xray.score} / Cryo-EM ${base.cryoem.score} / NMR ${base.nmr.score} / 总体 ${base.overall.score}`)
console.log(`引擎：${await getEngineSummary()}`)

const out = await reviewScoresWithLlm({
  ...input,
  targetName: 'F-box only protein 21',
  uniprotId: 'O94952',
  goal: '解析FBXO21蛋白的整体三维结构，明确关键结构域及构象特征',
  ligandCount: 1,
  literatureCount: 0,
}, base, AbortSignal.timeout(60_000))

console.log(`\n复核调用：ok=${out.ok} · ${(out.durationMs / 1000).toFixed(1)}s · 总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
if (!out.ok) {
  console.error(`失败：${out.error}`)
  console.error(`原始输出：${out.raw?.slice(0, 300) ?? '（无）'}`)
  process.exit(1)
}
const p = out.proposal!
console.log(`提案：X-ray ${p.xray >= 0 ? '+' : ''}${p.xray} · Cryo-EM ${p.cryoem >= 0 ? '+' : ''}${p.cryoem} · NMR ${p.nmr >= 0 ? '+' : ''}${p.nmr}（置信度 ${p.confidence}）`)
console.log(`意见：X-ray ${p.notes.xray}\n      Cryo-EM ${p.notes.cryoem}\n      NMR ${p.notes.nmr}\n      总体 ${p.notes.overall}`)

const applied = applyLlmScoreAdjust(base, p, { engine: await getEngineSummary(), durationMs: out.durationMs })
console.log(`\n调整后：X-ray ${applied.scores.xray.score} / Cryo-EM ${applied.scores.cryoem.score} / NMR ${applied.scores.nmr.score} / 总体 ${applied.scores.overall.score}（applied=${applied.info.applied}）`)

let pass = 0, fail = 0
const ok = (name: string, cond: boolean) => { cond ? pass++ : fail++; console.log(`  ${cond ? '✓' : '✗'} ${name}`) }
ok('输出成功解析为提案', out.ok && p != null)
ok('三方法 delta 在 ±2 内', Math.abs(p.xray) <= 2 && Math.abs(p.cryoem) <= 2 && Math.abs(p.nmr) <= 2)
ok('notes 逐方法意见非空', p.notes.xray.length > 0 && p.notes.cryoem.length > 0 && p.notes.nmr.length > 0)
ok('应用后分数在 1-10', [applied.scores.xray.score, applied.scores.cryoem.score, applied.scores.nmr.score, applied.scores.overall.score].every(n => n >= 1 && n <= 10))
ok('总体 = 三方法最大值', applied.scores.overall.score === Math.max(applied.scores.xray.score, applied.scores.cryoem.score, applied.scores.nmr.score))
ok('llmAdjust 有效 delta 记录', applied.info.xray === applied.scores.xray.score - base.xray.score)
ok('复核时长 < 30s（段预算内）', out.durationMs < 30_000)
console.log(`\n通过 ${pass} · 失败 ${fail}`)
if (fail > 0) process.exit(1)
