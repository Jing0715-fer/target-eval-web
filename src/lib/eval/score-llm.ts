/**
 * LLM 智能调分（v2.18）— 系统规则评分（score.ts）之上的 AI 复核层。
 *
 * 设计原则（用户需求：打分目前由代码计算，在其基础上增加 LLM 智能调整）：
 *  1. 系统规则分为「基础层」：确定性证据（长度/跨膜/先例/同源/聚集/分子量/互作）
 *     驱动的可解释规则 — 永远先算出，作为复核基线与兜底（LLM 失败/超时即终分）；
 *  2. LLM 复核为「修正层」：把评分所依据的全部原始证据（与规则相同的输入 +
 *     规则未消费的信号，如配体态覆盖/文献量/客户目标）交给 LLM 做专家复核，
 *     允许对三方法各给出 ±2 以内的整数微调 + 逐方法一句话理由；
 *  3. 输出强约束 JSON 协议：解析失败/字段非法/超时 → 直接放弃调整（保留规则分），
 *     调整值再经服务端钳制（[-2,2] → clamp 后 1-10）— LLM 永远无法越界改分；
 *  4. 幂等可测：parse/apply 为纯函数（scripts/test-score-llm.ts 单测），
 *     reviewScoresWithLlm 仅依赖 llmChat（可注入信号中止）。
 *
 * 调整语义：
 *  - 三方法独立调整；总体分沿用系统语义（= 三方法最大值）推导，
 *    不允许 LLM 直接改总体（保持与规则层口径一致，避免「方法 7 分总体 3 分」矛盾）
 *  - rationale（评分依据）追加「AI 复核」短语 — 报告 digest / 评分卡自动继承
 */
import type { BlastHit, LlmScoreAdjustInfo, PdbEntry } from './types'
import type { FullScoreResult, ScoreInput } from './score'
import { ratingLabel } from './score'
import { llmChat } from './llm'

/** 调整幅度上限（三方法各自；服务端钳制的硬边界） */
export const LLM_ADJUST_MAX = 2

export interface ScoreReviewInput extends ScoreInput {
  /** 靶点展示名（报告口径 — 复核语境） */
  targetName?: string
  /** UniProt accession（有归属时） */
  uniprotId?: string
  /** 客户目标（仅作复核语境 — 指令明确不得为迎合目标调分） */
  goal?: string
  /** 未覆盖区间文本（规则层只用覆盖率百分数；复核可参考空白语境） */
  gapText?: string
  /** 配体种类数（规则未消费 — 组合证据信号） */
  ligandCount?: number
  /** 文献量（规则未消费） */
  literatureCount?: number
  /** v2.33：binary 互作伙伴可信度分级摘要（如 "3 个：SKP1（同源复合物支持 2 个）…"；规则层已在评分中 gating，复核层作语境） */
  interactionBinarySummary?: string
}

export interface ScoreReviewProposal {
  xray: number
  cryoem: number
  nmr: number
  notes: { xray: string; cryoem: string; nmr: string; overall: string }
  confidence: 'high' | 'medium' | 'low'
}

export interface ScoreReviewOutcome {
  ok: boolean
  proposal: ScoreReviewProposal | null
  error?: string
  durationMs: number
  /** 原始返回（诊断/测试用；截断） */
  raw?: string
}

const SYSTEM = `你是一位资深结构生物学专家（CRO 评审视角），任务是复核（review）一套由规则引擎计算的蛋白靶点结构解析可行性评分。规则引擎的评分依据会以结构化摘要提供给你。你的职责是发现规则难以覆盖的证据组合问题，并对评分做小幅修正。必须遵守：
- 只基于给定证据判断，禁止引用证据之外的数据（PDB ID/分辨率/文献等一律不得编造）
- 证据不足以支持调整时，delta 用 0（0 是合法且常见的取值 — 规则层已较完备，不要为了「有所作为」而硬调分）
- 不得为迎合客户目标而调分；客户目标只影响建议措辞，不直接改变分数
- 每个方法的调整限于整数 -2 到 +2
- notes 为一句话复核意见（delta=0 时说明维持理由；delta≠0 时引用具体证据说明）
- 只输出一个 JSON 对象，不要输出任何其他文本、解释或 markdown 代码块`

// ─── 证据摘要构造（喂给复核 LLM 的紧凑上下文）──────────────────────────────

function buildReviewDigest(input: ScoreReviewInput, scores: FullScoreResult): string {
  const pdbs: PdbEntry[] = input.directPdbs
  const xrayCount = pdbs.filter(p => p.isXray).length
  const cryoemCount = pdbs.filter(p => p.isCryoem).length
  const nmrCount = pdbs.filter(p => p.isNmr).length
  const highResXray = pdbs.filter(p => p.isXray && p.resolution != null && p.resolution <= 2.5).length
  const highResCryoem = pdbs.filter(p => p.isCryoem && p.resolution != null && p.resolution <= 3.5).length
  const bestRes = pdbs.reduce<number | null>((b, p) => (p.resolution != null && (b == null || p.resolution < b) ? p.resolution : b), null)
  const tmCount = input.features.filter(f => f.type === 'Transmembrane').length
  const hasSignal = input.features.some(f => f.type === 'Signal')
  const domainCount = input.features.filter(f => f.type === 'Domain' || f.type === 'Repeat').length
  const hasDisordered = input.features.some(f => f.type === 'Region' && /disorder|low complexity/i.test(f.description))
  const bestIdentity = input.blastHits.length > 0 ? Math.max(...input.blastHits.map((b: BlastHit) => b.identity)) : 0
  const oligo = scores.oligomerAdjust
  const mwAdj = scores.mwAugmentAdjust
  const intAdj = scores.interactionAdjust

  const lines: string[] = []
  lines.push('【靶点】')
  lines.push(`${input.targetName || '未命名靶点'}${input.uniprotId ? `（UniProt ${input.uniprotId}）` : '（序列输入，无 UniProt 归属）'}；序列长度 ${input.sequenceLength} aa`)
  if (input.goal) lines.push(`客户目标：${input.goal.slice(0, 200)}`)

  lines.push('')
  lines.push('【系统规则评分（1-10，待你复核）】')
  lines.push(`- X-ray: ${scores.xray.score}/10（${scores.xray.rating}）— ${scores.rationale.xray}`)
  lines.push(`- Cryo-EM: ${scores.cryoem.score}/10（${scores.cryoem.rating}）— ${scores.rationale.cryoem}`)
  lines.push(`- NMR: ${scores.nmr.score}/10（${scores.nmr.rating}）— ${scores.rationale.nmr}`)
  lines.push(`- 总体: ${scores.overall.score}/10（= 三方法最大值）— ${scores.rationale.overall}`)

  lines.push('')
  lines.push('【评分所依据的原始证据】')
  lines.push(`- 已有结构 ${pdbs.length} 个（X-ray ${xrayCount} / Cryo-EM ${cryoemCount} / NMR ${nmrCount}）${bestRes != null ? `，最佳分辨率 ${bestRes}Å` : ''}；≤2.5Å X-ray ${highResXray} 个；≤3.5Å Cryo-EM ${highResCryoem} 个`)
  lines.push(`- 序列特征：跨膜区 ${tmCount} 个；信号肽 ${hasSignal ? '有' : '无'}；结构域/重复 ${domainCount} 个；显著无序区 ${hasDisordered ? '有' : '无'}`)
  lines.push(`- 序列覆盖率 ${Math.round(input.coveragePercent)}%（PDBe 映射）${input.gapText ? `；未覆盖区间 ${input.gapText.slice(0, 160)}` : ''}`)
  lines.push(`- BLAST 同源命中 ${input.blastHits.length} 个，最高 identity ${bestIdentity}%`)
  if (oligo) lines.push(`- 聚集形式：${oligo.label}${oligo.stoichiometry ? `（${oligo.stoichiometry}）` : ''}，置信度 ${oligo.confidence} — 规则调整 X-ray ${oligo.xray >= 0 ? '+' : ''}${oligo.xray} / Cryo-EM ${oligo.cryoem >= 0 ? '+' : ''}${oligo.cryoem} / NMR ${oligo.nmr >= 0 ? '+' : ''}${oligo.nmr}：${oligo.note}`)
  if (mwAdj) lines.push(`- 分子量增重：单体 ~${mwAdj.monomerKda} kDa${mwAdj.assemblyKda != null ? ` → 装配 ~${mwAdj.assemblyKda} kDa（${mwAdj.assemblyPath}）` : ''} — Cryo-EM 调整 ${mwAdj.cryoem >= 0 ? '+' : ''}${mwAdj.cryoem}：${mwAdj.note}`)
  if (intAdj) lines.push(`- 互作复合物证据（${intAdj.level}）：X-ray ${intAdj.xray >= 0 ? '+' : ''}${intAdj.xray} / Cryo-EM ${intAdj.cryoem >= 0 ? '+' : ''}${intAdj.cryoem} / NMR ${intAdj.nmr >= 0 ? '+' : ''}${intAdj.nmr}：${intAdj.note}`)
  if (input.interactionBinarySummary) lines.push(`- binary 互作可信度分级（v2.33）：${input.interactionBinarySummary}`)
  const extra: string[] = []
  if (input.ligandCount) extra.push(`配体种类 ${input.ligandCount} 种`)
  if (input.literatureCount != null) extra.push(`文献 ${input.literatureCount} 篇`)
  if (extra.length) lines.push(`- 其他研究信号：${extra.join('；')}（规则层未计入评分 — 供你判断研究成熟度）`)

  lines.push('')
  lines.push('规则层未覆盖、请你重点关注的盲区（证据支持时才调整）:')
  lines.push('- 已有结构的构象/配体态单一性（如全部为同一配体态 → 未覆盖状态仍是风险，但已解析状态是强先例）')
  lines.push('- 结构域组合与柔性 linker 对结晶/成像的实际影响（超出规则中长度/结构域数的粗粒度判断）')
  lines.push('- 方法学先例分布与靶点真实状态的匹配度（如先例全部为复合物形式时单体路线的现实性）')
  lines.push('- binary 互作蛋白可信度：仅复合物结构（靶点与伙伴共 PDB）或同源复合物结构支持的互作才可完全信任；仅实验互作证据（IntAct）的伙伴不得作为「可用增大分子量做 Cryo-EM」的可信依据 — 不得据此上调 Cryo-EM 分数')
  return lines.join('\n')
}

function buildReviewPrompt(input: ScoreReviewInput, scores: FullScoreResult): string {
  const digest = buildReviewDigest(input, scores)
  return `${digest}

━━━━━━━━━━━━━━━━━━━━━━━━━━
基于以上证据复核系统规则评分。输出（严格 JSON，无其他文本，无代码块围栏）：
{"xray": -2到2的整数, "cryoem": -2到2的整数, "nmr": -2到2的整数, "notes": {"xray": "一句话理由", "cryoem": "一句话理由", "nmr": "一句话理由", "overall": "总体复核意见一句话"}, "confidence": "high或medium或low"}
注意：notes 里 delta=0 的方法写维持理由（引用证据），delta≠0 的方法写调整依据；overall 意见不改变分数，仅用于报告展示。`
}

// ─── 解析（纯函数，供单测）──────────────────────────────────────────────────

/** 剥离可能的代码围栏与前后杂文，取第一个平衡的 JSON 对象 */
function extractJsonObject(text: string): string | null {
  const t = text.replace(/\r\n/g, '\n').trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(t)
  const body = fenced ? fenced[1].trim() : t
  const start = body.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < body.length; i++) {
    const ch = body[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return body.slice(start, i + 1)
    }
  }
  return null
}

function clampDelta(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return Math.max(-LLM_ADJUST_MAX, Math.min(LLM_ADJUST_MAX, Math.round(v)))
}

function noteOf(v: unknown): string {
  return typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, 160) : ''
}

/**
 * 解析复核输出为提案。容错：
 *  - 围栏/前后杂文剥离（extractJsonObject）
 *  - 字段缺失或非法 → 该字段按 0/空串处理；三方法 delta 全部缺失 → 视为解析失败
 *  - delta 非整数 → 四舍五入；越界 → 钳到 [-2,2]（服务端硬边界）
 */
export function parseScoreReview(text: string): ScoreReviewProposal | null {
  const json = extractJsonObject(text)
  if (!json) return null
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(json) as Record<string, unknown>
  } catch {
    return null
  }
  const raw = obj as { xray?: unknown; cryoem?: unknown; nmr?: unknown; notes?: Record<string, unknown>; confidence?: unknown }
  const dx = clampDelta(raw.xray)
  const dc = clampDelta(raw.cryoem)
  const dn = clampDelta(raw.nmr)
  // 三方法全部缺失/非法 → 没有任何可用调整信号，按解析失败处理（维持规则分）
  if (dx == null && dc == null && dn == null) return null
  const notesRaw = (typeof raw.notes === 'object' && raw.notes != null ? raw.notes : {}) as Record<string, unknown>
  const confidence = raw.confidence === 'high' || raw.confidence === 'medium' || raw.confidence === 'low'
    ? raw.confidence
    : 'medium'
  return {
    xray: dx ?? 0,
    cryoem: dc ?? 0,
    nmr: dn ?? 0,
    notes: {
      xray: noteOf(notesRaw.xray),
      cryoem: noteOf(notesRaw.cryoem),
      nmr: noteOf(notesRaw.nmr),
      overall: noteOf(notesRaw.overall),
    },
    confidence,
  }
}

// ─── LLM 复核调用 ───────────────────────────────────────────────────────────

export async function reviewScoresWithLlm(input: ScoreReviewInput, scores: FullScoreResult, signal?: AbortSignal): Promise<ScoreReviewOutcome> {
  const r = await llmChat(buildReviewPrompt(input, scores), SYSTEM, signal)
  if (!r.ok) return { ok: false, proposal: null, error: r.error, durationMs: r.durationMs }
  const proposal = parseScoreReview(r.text)
  if (!proposal) {
    return { ok: false, proposal: null, error: '复核输出不是合法 JSON（已放弃调整，保留规则分）', durationMs: r.durationMs, raw: r.text.slice(0, 400) }
  }
  return { ok: true, proposal, durationMs: r.durationMs }
}

// ─── 应用（纯函数，供单测）──────────────────────────────────────────────────

function applyItem(base: { score: number; maxScore: number; rating: string }, delta: number, note: string) {
  const score = Math.max(1, Math.min(10, base.score + delta))
  const effective = score - base.score
  const verb = effective > 0 ? `AI 复核上调 ${effective}` : effective < 0 ? `AI 复核下调 ${-effective}` : 'AI 复核维持'
  // 空 note 兜底（P3：避免 rationale 尾部悬冒号）
  const safeNote = note || '未给出补充理由'
  return { score, rating: ratingLabel(score), rationaleSuffix: `；${verb}：${safeNote}` }
}

/**
 * 把复核提案应用在规则分上，产出新 ScoreResult（不修改入参）。
 * - 三方法各自 clamp(1,10)；总体 = 三方法最大值（与规则层口径一致）
 * - rationale 追加 AI 复核短语（报告 digest / 评分卡自动继承）
 * - llmAdjust 记录有效调整量（钳制后实际变化 — UI 徽章按此展示）
 */
export function applyLlmScoreAdjust(
  scores: FullScoreResult,
  proposal: ScoreReviewProposal,
  meta: { engine: string; durationMs: number },
): { scores: FullScoreResult; info: LlmScoreAdjustInfo } {
  const x = applyItem(scores.xray, proposal.xray, proposal.notes.xray)
  const c = applyItem(scores.cryoem, proposal.cryoem, proposal.notes.cryoem)
  const n = applyItem(scores.nmr, proposal.nmr, proposal.notes.nmr)
  const overallScore = Math.max(x.score, c.score, n.score)
  const overallDelta = overallScore - scores.overall.score
  const overallVerb = overallDelta > 0 ? `AI 复核上调 ${overallDelta}` : overallDelta < 0 ? `AI 复核下调 ${-overallDelta}` : 'AI 复核维持'
  const out: FullScoreResult = {
    xray: { score: x.score, maxScore: 10, rating: x.rating },
    cryoem: { score: c.score, maxScore: 10, rating: c.rating },
    nmr: { score: n.score, maxScore: 10, rating: n.rating },
    overall: { score: overallScore, maxScore: 10, rating: ratingLabel(overallScore) },
    rationale: {
      xray: scores.rationale.xray + x.rationaleSuffix,
      cryoem: scores.rationale.cryoem + c.rationaleSuffix,
      nmr: scores.rationale.nmr + n.rationaleSuffix,
      overall: scores.rationale.overall + `；${overallVerb}：${proposal.notes.overall || '三方法复核意见综合'}`,
    },
    oligomerAdjust: scores.oligomerAdjust,
    mwAugmentAdjust: scores.mwAugmentAdjust,
    interactionAdjust: scores.interactionAdjust,
    methodStats: scores.methodStats,
    llmAdjust: {
      applied: (x.score - scores.xray.score) !== 0 || (c.score - scores.cryoem.score) !== 0 || (n.score - scores.nmr.score) !== 0,
      xray: x.score - scores.xray.score,
      cryoem: c.score - scores.cryoem.score,
      nmr: n.score - scores.nmr.score,
      overall: overallDelta,
      confidence: proposal.confidence,
      notes: proposal.notes,
      engine: meta.engine,
      durationMs: meta.durationMs,
    },
  }
  return { scores: out, info: out.llmAdjust! }
}
