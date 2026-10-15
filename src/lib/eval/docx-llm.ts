/**
 * 评估表 LLM 智能解析 — 从 Word 评估表全文中提取结构化要点：
 * 客户目标、待解决科学问题、实验数据要点（无胶图/SEC 图时的文本证据）、
 * 构建/序列说明、同源信息、风险关注点。
 *
 * 设计：
 *  - LLM 失败时回退到规则提取（goalHints → goals），不阻塞主流程
 *  - 输出严格 JSON（提示词约束 + 解析容错），字段逐项清洗与截断
 *  - 输入 ≤ 14KB 文本、输出 ≤ 4KB，内存有界
 */
import { llmChat } from './llm'
import { elideSequenceRuns } from './seq-elide'
import type { FormInsights } from './types'

const SYSTEM = `你是一位结构生物学 CRO 项目的评估分析师。用户给你一份蛋白靶点评估表（Word 文档提取的文本），请从中提取结构化信息。
严格输出一个 JSON 对象，不要输出任何其他文字、注释或 Markdown 代码块标记。字段要求：
{
  "proteinName": "靶点蛋白名称（未提及则省略）",
  "geneNames": ["基因名数组，未提及则省略"],
  "organism": "物种（未提及则省略）",
  "goals": ["客户目标/项目诉求/交付期望，逐条提取（最多 6 条，每条 ≤120 字，忠实原文不要扩写）"],
  "scientificQuestions": ["待解决的科学问题（最多 6 条，每条 ≤120 字；文档没有明确的科学问题则返回空数组）"],
  "experimentalSummary": "实验数据与样品状态要点：表达系统/纯度/得率/稳定性/已有的胶图或SEC结果文字描述等，综合成 ≤300 字摘要（无相关内容则省略）",
  "sequenceNotes": "构建/序列说明：截短边界、突变位点、标签、linker 等（无则省略，≤200 字）",
  "homologs": "文档中提及的同源蛋白/参考蛋白/已有结构信息（无则省略，≤200 字）",
  "keyConcerns": ["风险与关注点：样品量不足、蛋白不稳定、翻译后修饰等（最多 5 条，无则省略）"]
}
注意：goals 和 scientificQuestions 是两个不同维度——goals 是客户想要达成什么（如"解析 apo 与复合物结构"），scientificQuestions 是科学上待回答的问题（如"抑制活性氧还依赖的二聚化界面是否保守"）。只提取文档中真实存在的信息，禁止推测编造。
任何字段都不要原样复述完整氨基酸/核苷酸序列（≥40 个连续字母的片段会被系统自动省略为占位标记）：序列相关内容只写边界（如 33-308）、截短、突变位点、标签、linker 与长度等要点。`

/** 解析容错：抽取首个 JSON 对象（容忍 ```json 包裹与前后杂讯） */
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

function sanitizeStrArray(v: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return []
  return v
    .filter((x): x is string => typeof x === 'string')
    .map(x => elideSequenceRuns(x.trim().replace(/\s+/g, ' ').slice(0, maxLen)))
    .filter(Boolean)
    .slice(0, maxItems)
}

function sanitizeStr(v: unknown, maxLen: number): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = elideSequenceRuns(v.trim().replace(/\s+/g, ' ').slice(0, maxLen))
  return s || undefined
}

/** 规则兜底（LLM 不可用时）：goalHints → goals（同样省略长序列片段） */
export function fallbackInsights(goalHints: string[]): FormInsights {
  return { goals: goalHints.slice(0, 4).map(elideSequenceRuns), scientificQuestions: [], source: 'regex' }
}

/**
 * LLM 提取评估表要点。text 为文档全文（≤14KB）。
 * 失败时返回 fallback（source='regex'），不抛错。
 */
export async function extractFormInsights(
  text: string,
  goalHints: string[],
  signal?: AbortSignal,
): Promise<FormInsights> {
  const trimmed = text.trim()
  if (trimmed.length < 20) return fallbackInsights(goalHints)

  const prompt = `评估表全文如下（Word 提取文本，可能含 OCR 噪音）：

━━━━━━━━━━ 评估表内容 ━━━━━━━━━━
${trimmed.slice(0, 14000)}
━━━━━━━━━━ 内容结束 ━━━━━━━━━━

请按系统指令输出 JSON。`

  const r = await llmChat(prompt, SYSTEM, signal)
  if (!r.ok) return fallbackInsights(goalHints)

  const obj = extractJson(r.text)
  if (!obj) return fallbackInsights(goalHints)

  const goals = sanitizeStrArray(obj.goals, 6, 160)
  const questions = sanitizeStrArray(obj.scientificQuestions, 6, 160)
  const insights: FormInsights = {
    goals,
    scientificQuestions: questions,
    source: 'llm',
  }
  const proteinName = sanitizeStr(obj.proteinName, 100)
  if (proteinName) insights.proteinName = proteinName
  const genes = sanitizeStrArray(obj.geneNames, 5, 20)
  if (genes.length) insights.geneNames = genes
  const organism = sanitizeStr(obj.organism, 60)
  if (organism) insights.organism = organism
  const exp = sanitizeStr(obj.experimentalSummary, 400)
  if (exp) insights.experimentalSummary = exp
  const seqNotes = sanitizeStr(obj.sequenceNotes, 300)
  if (seqNotes) insights.sequenceNotes = seqNotes
  const homologs = sanitizeStr(obj.homologs, 300)
  if (homologs) insights.homologs = homologs
  const concerns = sanitizeStrArray(obj.keyConcerns, 5, 120)
  if (concerns.length) insights.keyConcerns = concerns

  // LLM 提取为空时回退规则结果，保证 goals 至少有 goalHints
  if (!insights.goals.length && goalHints.length) {
    insights.goals = goalHints.slice(0, 4).map(elideSequenceRuns)
  }
  return insights
}
