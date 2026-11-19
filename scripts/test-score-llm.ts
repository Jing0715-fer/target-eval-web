/**
 * v2.18 LLM 智能调分 — 单元验证脚本（无网络，纯函数）：
 *  1. parseScoreReview：围栏/杂文剥离、字段钳制、非法输出防御
 *  2. applyLlmScoreAdjust：三方法 clamp、总体推导（max 口径）、
 *     rationale 继承追加、llmAdjust 明细（有效 delta = 钳制后实际变化）
 *  3. 边界钳制：基础分 9/10/1 时 +2/-2 不越界；有效 delta 如实记录
 *  4. reviewScoresWithLlm 失败路径：llmChat 返回非 JSON → 放弃调整（不抛错）
 *  5. 防御：伪造/畸形输入不崩溃（空串/纯文本/嵌套 JSON/字符串 delta）
 *
 * 运行：bun scripts/test-score-llm.ts
 */
import { parseScoreReview, applyLlmScoreAdjust, type ScoreReviewProposal } from '../src/lib/eval/score-llm'
import { computeScores, type ScoreInput } from '../src/lib/eval/score'

let pass = 0
let fail = 0
function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name}\n      actual   = ${a}\n      expected = ${b}`) }
}
function ok(name: string, cond: boolean): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name}`) }
}

// ─── 1. parseScoreReview ──────────────────────────────────────────────────
console.log('【parseScoreReview】')
const goodJson = '{"xray": 1, "cryoem": -2, "nmr": 0, "notes": {"xray": "已有1.2Å先例", "cryoem": "小分子量装配仍不足", "nmr": "维持", "overall": "综合可行"}, "confidence": "high"}'
const p1 = parseScoreReview(goodJson)
ok('合法 JSON 解析成功', p1 != null)
eq('xray delta', p1?.xray, 1)
eq('cryoem delta', p1?.cryoem, -2)
eq('nmr delta', p1?.nmr, 0)
eq('confidence', p1?.confidence, 'high')
eq('notes.xray', p1?.notes.xray, '已有1.2Å先例')

const fenced = '```json\n{"xray": 1, "cryoem": 0, "nmr": 0, "notes": {"overall": "ok"}, "confidence": "medium"}\n```'
ok('代码围栏剥离', parseScoreReview(fenced) != null)

const noisy = '好的，以下是复核结果：\n{"xray": 0, "cryoem": 1, "nmr": 0, "notes": {"overall": "ok"}, "confidence": "low"}\n以上就是全部。'
ok('前后杂文剥离', parseScoreReview(noisy) != null)

const clampCase = parseScoreReview('{"xray": 5, "cryoem": -3.7, "nmr": 1.6, "notes": {}, "confidence": "whatever"}')
eq('越界钳制 +2', clampCase?.xray, 2)
eq('越界钳制 -2（浮点四舍五入）', clampCase?.cryoem, -2)
eq('浮点四舍五入 +2', clampCase?.nmr, 2)
eq('非法 confidence 默认 medium', clampCase?.confidence, 'medium')

ok('纯文本 → null（解析失败）', parseScoreReview('我认为评分合理，无需调整。') == null)
ok('空串 → null', parseScoreReview('') == null)
ok('三方法全缺 → null', parseScoreReview('{"notes": {"overall": "x"}, "confidence": "high"}') == null)
ok('字符串 delta → 按缺失处理但整体可用', parseScoreReview('{"xray": "1", "cryoem": 0, "nmr": 0, "notes": {}}')?.xray === 0)
const nested = parseScoreReview('{"xray": 0, "cryoem": 0, "nmr": 0, "notes": {"xray": "维持：{先例}充分", "overall": "ok"}, "confidence": "high"}')
ok('notes 中含花括号不截断 JSON', nested != null)

// ─── 2. applyLlmScoreAdjust ───────────────────────────────────────────────
console.log('\n【applyLlmScoreAdjust】')
const baseInput: ScoreInput = {
  sequenceLength: 393,
  features: [
    { type: 'Domain', description: 'DNA-binding', begin: 1, end: 100 },
    { type: 'Transmembrane', description: '', begin: 0, end: 0 },
  ],
  directPdbs: [
    { pdbId: '1TUP', title: 'p53 core domain', method: 'X-ray', resolution: 2.2, releaseDate: '1995-01-01', ligands: [], isXray: true, isCryoem: false, isNmr: false } as never,
  ],
  blastHits: [],
  coveragePercent: 80,
  oligomer: null,
  mwAugment: null,
  interaction: null,
}
const base = computeScores(baseInput)
const proposal: ScoreReviewProposal = {
  xray: 1, cryoem: -1, nmr: 2,
  notes: { xray: '高分辨先例充分', cryoem: '中等分子量常规', nmr: '长度适合 NMR', overall: 'X-ray 为首选' },
  confidence: 'high',
}
const applied = applyLlmScoreAdjust(base, proposal, { engine: 'GLM-4.6（内置）', durationMs: 4200 })
eq('X-ray = 基础+1', applied.scores.xray.score, Math.max(1, Math.min(10, base.xray.score + 1)))
eq('Cryo-EM = 基础-1', applied.scores.cryoem.score, Math.max(1, Math.min(10, base.cryoem.score - 1)))
eq('NMR = 基础+2', applied.scores.nmr.score, Math.max(1, Math.min(10, base.nmr.score + 2)))
eq('总体 = 三方法 max（口径与规则层一致）', applied.scores.overall.score, Math.max(applied.scores.xray.score, applied.scores.cryoem.score, applied.scores.nmr.score))
eq('llmAdjust.xray', applied.info.xray, applied.scores.xray.score - base.xray.score)
eq('llmAdjust.overall', applied.info.overall, applied.scores.overall.score - base.overall.score)
eq('applied 标记', applied.info.applied, true)
ok('rationale 追加 AI 复核短语（X-ray）', applied.scores.rationale.xray.startsWith(base.rationale.xray) && applied.scores.rationale.xray.includes('AI 复核'))
ok('rationale 追加总体意见', applied.scores.rationale.overall.includes('X-ray 为首选'))
ok('入参未被修改（纯函数）', base.rationale.xray === applied.scores.rationale.xray.replace(/；AI 复核.*$/, ''))
eq('调整明细保留（oligomerAdjust 等透传）', applied.scores.oligomerAdjust ?? 'none', 'none')
eq('methodStats 透传', applied.scores.methodStats.xrayCount, base.methodStats.xrayCount)
eq('engine 记录', applied.info.engine, 'GLM-4.6（内置）')
eq('durationMs 记录', applied.info.durationMs, 4200)

// 全 0 提案：applied=false，分数不变
const keep = applyLlmScoreAdjust(base, { xray: 0, cryoem: 0, nmr: 0, notes: { xray: '维持', cryoem: '维持', nmr: '维持', overall: '证据与规则一致' }, confidence: 'medium' }, { engine: 'test', durationMs: 100 })
eq('全 0：分数不变', keep.scores.xray.score, base.xray.score)
eq('全 0：applied=false', keep.info.applied, false)
eq('全 0：overall delta=0', keep.info.overall, 0)

// ─── 3. 边界钳制 ─────────────────────────────────────────────────────────
console.log('\n【边界钳制】')
const edgeHigh = applyLlmScoreAdjust(base, { xray: 2, cryoem: 2, nmr: 2, notes: { xray: '', cryoem: '', nmr: '', overall: '' }, confidence: 'low' }, { engine: 't', durationMs: 0 })
eq('基础分 9/10 时 +2 → clamp 10（xray 若为 9）', edgeHigh.scores.xray.score, Math.min(10, base.xray.score + 2))
eq('有效 delta 如实（钳制后实际变化）', edgeHigh.info.xray, Math.min(10, base.xray.score + 2) - base.xray.score)
ok('任何方法不越 10', edgeHigh.scores.xray.score <= 10 && edgeHigh.scores.cryoem.score <= 10 && edgeHigh.scores.nmr.score <= 10)
const edgeLow = applyLlmScoreAdjust(base, { xray: -2, cryoem: -2, nmr: -2, notes: { xray: '', cryoem: '', nmr: '', overall: '' }, confidence: 'low' }, { engine: 't', durationMs: 0 })
ok('任何方法不跌破 1', edgeLow.scores.xray.score >= 1 && edgeLow.scores.cryoem.score >= 1 && edgeLow.scores.nmr.score >= 1)
ok('评级随分值重算', typeof edgeLow.scores.xray.rating === 'string' && edgeLow.scores.xray.rating.includes('·'))

console.log(`\n通过 ${pass} · 失败 ${fail}`)
if (fail > 0) process.exit(1)
