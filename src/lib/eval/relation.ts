/**
 * 靶点关系判断（v1.8 批量评估前置）：
 * 同一评估表中解析出的多个靶点可能相互关联 — 提交批量评估前先由 LLM 判断：
 *  - 关联（复合物亚基 / 抗体-抗原配对 / 融合构建 / 客户目标要求合并分析）
 *    → 各靶点数据收集后合并生成一份含「靶点关系分析」章节的报告
 *  - 非关联（独立项目 / 仅同通路功能相关）
 *    → 各靶点独立报告，报告中注明批次定位（独立项目 vs 复合物相关）
 * 判断失败时降级为 independent（保持 v1.7 逐靶点报告行为），错误信息透出给前端。
 */
import { llmChat } from './llm'
import { elideSequenceRuns } from './seq-elide'
import type { FormInsights, HomologPair, RelationJudgment, TargetRelationType } from './types'

/** 判断输入中的单个靶点简介 */
export interface RelationTargetBrief {
  /** 展示标签（UniProt ID 或 序列靶点） */
  label: string
  uniprotId?: string
  proteinName?: string
  geneNames?: string[]
  organism?: string
  /** UniProt 功能注释片段 */
  functionText?: string
  /** 评估表序列头（构建信息） */
  sequenceHeader?: string
  sequenceLength?: number
  /** 序列角色（antibody = 检测为抗体；antigen = 靶点/构建序列） */
  role?: 'antibody' | 'antigen' | 'target'
}

export interface RelationJudgeInput {
  /** 选中的评估靶点（≥2 个 UniProt，关系判断的主体） */
  targets: RelationTargetBrief[]
  /** 评估表中的序列（背景证据，非独立靶点 — 如伴随抗体构建/对照序列） */
  sequences?: Array<{ header?: string; length: number; role: 'antibody' | 'antigen' }>
  /** 客户显式目标 */
  goal?: string
  /** 评估表 LLM 解析要点 */
  insights?: FormInsights | null
  /** 系统序列一致性比对证据（v1.10 — 靶点两两一致性，确定性数字） */
  homologEvidence?: HomologPair[]
}

const SYSTEM = `你是资深结构生物学项目负责人（CRO 评估视角）。客户提交的同一份评估表中包含多个待评估靶点，你需要判断这些靶点之间是否存在需要合并分析的关联关系。

判断标准（从严把握）：
- related=true 仅限以下情形：
  1. complex — 复合物亚基：这些蛋白构成已知物理复合物，结构解析需共表达/共纯化/组装后一起分析
  2. antibody-antigen — 抗体-抗原配对：批次中同时存在抗体序列与其靶抗原，目标是用抗体辅助抗原结晶（Fab 复合物）或 Cryo-EM 配对
  3. fusion — 融合构建：多个结构域/蛋白在同一多肽构建中串联（如靶蛋白-Fc 融合、双特异性抗体的两臂）
  4. homologous — 同源蛋白家族：直系同源（不同物种的同一基因，如人/小鼠的同一蛋白）、近缘旁系同源（同一基因家族的近缘成员，如受体激酶家族中同一亚家族的成员）、或同一蛋白的变体/突变体/剪接异构体。任一家族成员的已有结构可直接指导其他成员的构建边界设计与结晶条件借鉴（折叠与核心结构域高度保守），应作为同一项目合并为家族级评估报告
  5. other（related）— 客户目标文本明确要求把多个靶点作为一个项目合并分析
- related=false 的情形：
  1. independent — 相互独立的项目：各靶点分别表达纯化、分别解析结构，互不依赖
  2. pathway — 同通路/同疾病功能相关但物理上独立解析：生物学上有关联，结构解析层面仍是独立项目
- 「同源家族」与「仅同一通路」的界限：EGFR 与 HER2（同亚家族受体激酶，序列一致性 40%+）是 homologous；但两个毫不相关的激酶（如 CDK 与 EGFR，仅同属激酶超家族、一致性 <25%）只是 pathway/independent — 判读时优先参考系统提供的「序列一致性比对」确定性证据（≥40% 为家族级同源）与蛋白名/基因名的家族关系
- 仅凭「都是激酶」「都在同一通路」这类泛泛关联不构成 related=true — 需要物理复合/配对/融合/同源家族或客户明确要求合并
- 判断存疑时倾向 related=false（分别报告更稳妥，且报告中会注明功能关联）

输出严格 JSON（不要 markdown 代码块包裹）：
{"related": true|false, "relationType": "complex"|"antibody-antigen"|"fusion"|"homologous"|"pathway"|"independent"|"other", "confidence": "high"|"medium"|"low", "rationale": "判断依据（引用靶点名/序列头/客户目标/序列一致性数字中的具体证据，≤300 字）", "strategy": "对结构解析策略的影响：related 时给出合并分析策略要点（同源家族：优先解析哪个成员/家族证据互用/构建边界借鉴），无关时说明各靶点独立推进的注意点（≤200 字）"}`

function extractJson(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```json/gi, '```').replace(/```/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return null
  }
}

const VALID_TYPES: TargetRelationType[] = ['complex', 'antibody-antigen', 'fusion', 'homologous', 'pathway', 'independent', 'other']

function sanitizeType(v: unknown): TargetRelationType {
  return typeof v === 'string' && (VALID_TYPES as string[]).includes(v) ? (v as TargetRelationType) : 'other'
}

function sanitizeText(v: unknown, maxLen: number): string {
  if (typeof v !== 'string') return ''
  return elideSequenceRuns(v.trim().replace(/\s+/g, ' ').slice(0, maxLen))
}

/** 关系判断失败时的降级（独立报告，v1.7 行为） */
export function fallbackJudgment(reason: string): RelationJudgment {
  return {
    related: false,
    relationType: 'independent',
    confidence: 'low',
    rationale: `关系判断未能完成（${reason}），已按相互独立项目分别生成报告`,
    strategy: '各靶点独立推进结构解析评估',
    error: reason,
  }
}

/** 将判断结果转为注入单靶点报告的批次说明（非关联批量时使用） */
export function batchNoteFromJudgment(j: RelationJudgment, total: number): string {
  const typeText = j.relationType === 'pathway'
    ? `同通路/功能相关但结构解析相互独立`
    : j.relationType === 'independent'
      ? `相互独立的项目`
      : j.relationType
  return `本批次共评估 ${total} 个靶点，经分析为${typeText}${j.rationale ? `（${j.rationale.slice(0, 160)}）` : ''}，各靶点分别出具报告`
}

/**
 * LLM 判断多靶点关系。targets 至少 2 个；失败时返回 fallback（不抛错）。
 */
export async function judgeTargetRelation(input: RelationJudgeInput, signal?: AbortSignal): Promise<RelationJudgment> {
  const targets = input.targets.filter(Boolean)
  if (targets.length < 2) {
    return fallbackJudgment('靶点数量不足 2 个，无需关系判断')
  }

  const targetLines = targets.map((t, i) => {
    const parts: string[] = [`${i + 1}. ${t.label}`]
    if (t.uniprotId && t.uniprotId !== t.label) parts.push(`UniProt ${t.uniprotId}`)
    if (t.proteinName) parts.push(t.proteinName)
    if (t.geneNames?.length) parts.push(`基因 ${t.geneNames.slice(0, 4).join('/')}`)
    if (t.organism) parts.push(t.organism)
    if (t.sequenceLength) parts.push(`${t.sequenceLength} aa`)
    if (t.role === 'antibody') parts.push('【检测为抗体序列】')
    if (t.sequenceHeader) parts.push(`序列头: ${t.sequenceHeader.slice(0, 80)}`)
    if (t.functionText) parts.push(`功能: ${t.functionText.slice(0, 200)}`)
    return parts.join(' — ')
  })

  const ins = input.insights
  const ctxLines: string[] = []
  ctxLines.push('【待评估靶点列表（关系判断的主体 — 判断它们之间是否需要合并分析）】')
  ctxLines.push(targetLines.join('\n'))
  if (input.homologEvidence?.length) {
    ctxLines.push('')
    ctxLines.push('【系统序列一致性比对（确定性证据 — 全长序列两两比对，≥40% 判定为家族级同源）】')
    ctxLines.push(input.homologEvidence.map(p => `${p.a} ↔ ${p.b}: ${p.identity}%${p.identity >= 40 ? '（家族级同源）' : p.identity >= 30 ? '（弱同源信号）' : ''}`).join('\n'))
  }
  if (input.sequences?.length) {
    ctxLines.push('')
    ctxLines.push('【评估表中的序列（背景证据，非独立评估靶点 — 仅用于理解项目上下文）】')
    ctxLines.push(input.sequences.slice(0, 4).map((s, i) =>
      `${i + 1}. ${s.role === 'antibody' ? '抗体序列' : '靶点/构建序列'} ${s.length} aa${s.header ? `（${s.header.slice(0, 60)}）` : ''}`,
    ).join('\n'))
  }
  ctxLines.push('')
  ctxLines.push('【客户目标（评估表/输入框）】')
  ctxLines.push(input.goal?.trim() || ins?.goals?.slice(0, 3).map(elideSequenceRuns).join('；') || '（未提供明确目标）')
  if (ins?.scientificQuestions?.length) {
    ctxLines.push('')
    ctxLines.push('【待解决的科学问题（评估表提取）】')
    ctxLines.push(ins.scientificQuestions.slice(0, 6).map((q, i) => `${i + 1}. ${elideSequenceRuns(q)}`).join('\n'))
  }
  if (ins?.sequenceNotes) {
    ctxLines.push('')
    ctxLines.push(`【构建/序列说明（评估表提取）】${elideSequenceRuns(ins.sequenceNotes)}`)
  }
  if (ins?.homologs) {
    ctxLines.push('')
    ctxLines.push(`【同源/参考信息（评估表提取）】${elideSequenceRuns(ins.homologs)}`)
  }

  const r = await llmChat(`${ctxLines.join('\n')}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n基于以上信息判断这些靶点之间的关系，按系统指令输出 JSON。`, SYSTEM, signal)
  if (!r.ok) return fallbackJudgment(r.error ?? 'LLM 调用失败')

  const obj = extractJson(r.text)
  if (!obj) return fallbackJudgment('LLM 返回内容无法解析为 JSON')

  const related = obj.related === true
  let relationType = sanitizeType(obj.relationType)
  // 一致性校验：related=true 时类型不应是 independent/pathway，反之亦然
  if (related && (relationType === 'independent' || relationType === 'pathway')) relationType = 'other'
  if (!related && ['complex', 'antibody-antigen', 'fusion', 'homologous'].includes(relationType)) {
    // LLM 判了关联类型但 related=false → 信任 related=false，类型归为独立/通路二选一
    relationType = 'independent'
  }
  // homologous 语义上必然 related（同源家族应合并评估）
  const finalRelated = related || relationType === 'homologous'
  const confidence = obj.confidence === 'high' || obj.confidence === 'medium' ? obj.confidence : 'low'
  const rationale = sanitizeText(obj.rationale, 300)
  const strategy = sanitizeText(obj.strategy, 200)
  if (!rationale) return fallbackJudgment('LLM 返回缺少判断依据')

  return { related: finalRelated, relationType, confidence, rationale, strategy, homologPairs: input.homologEvidence }
}
