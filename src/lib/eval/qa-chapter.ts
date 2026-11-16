/**
 * 评估表问题回应章节（v2.10 ②）— 纯函数模块，无副作用依赖，便于独立测试。
 *
 * 背景：合并报告的「客户评估表要点」章节此前只列出 AI 提取的目标/问题原文，
 * 客户的问题没有得到回答。v2.10 起 LLM 增加第四段生成「## 客户评估表问题回应」，
 * 对每条目标（G1…Gn）与每条待解决科学问题（Q1…Qn）逐条回应；渲染时把该章节从
 * 合并分析 markdown 中拆出，逐条内嵌到「客户评估表要点」章节对应条目下方。
 *
 * 约定的 LLM 输出格式（段D 指令强制）：
 *   ## 客户评估表问题回应
 *   ### G1：{目标 1 原文}
 *   **回应**：{…}
 *   ### Q1：{问题 1 原文}
 *   **回答**：{…}
 */

/** 该章节的固定标题（与段D 指令一致；拆分与识别均按此标题匹配） */
export const QA_CHAPTER_TITLE = '客户评估表问题回应'

/**
 * 从合并分析 markdown 中拆出「客户评估表问题回应」章节。
 * - 返回 qaMd（该章节正文，含 `## 标题` 行）与 rest（其余 markdown）
 * - 无该章节 → qaMd 为空字符串、rest 为原文本
 * - 幂等：重复调用无副作用
 */
export function splitQaChapter(md: string): { qaMd: string; rest: string } {
  if (!md) return { qaMd: '', rest: md }
  const start = md.search(new RegExp(`^##\\s*${QA_CHAPTER_TITLE}\\s*$`, 'm'))
  if (start < 0) return { qaMd: '', rest: md }
  // 章节末尾 = 下一个 ## 一级章节标题（若有）或文末
  const after = md.slice(start + 1)
  const nextH2 = after.search(/^##\s+/m)
  const end = nextH2 >= 0 ? start + 1 + nextH2 : md.length
  const qaMd = md.slice(start, end).trim()
  const rest = (md.slice(0, start) + md.slice(end)).replace(/\n{3,}/g, '\n\n').trim()
  return { qaMd, rest }
}

/** 解析结果：G/Q 编号（1 起）→ 回应正文（已剥离标签行的纯 markdown） */
export interface InsightQa {
  goals: Record<number, string>
  questions: Record<number, string>
  /** 成功解析出的回应条数（用于失败降级判断） */
  parsedCount: number
}

/**
 * 解析段D 输出为逐条回应。容错策略：
 * - 标题行宽松匹配（### 或 ####，G/Q 大小写不敏感，全半角冒号均可）
 * - 正文先剥离「**问题**：/**目标**：」复述行，再剥离「**回应**：/**回答**：」标签前缀
 * - 任何一条解析不出正文则不计入 parsedCount；整体解析失败由调用方降级为整块渲染
 */
export function parseInsightQa(qaMd: string): InsightQa {
  const goals: Record<number, string> = {}
  const questions: Record<number, string> = {}
  if (!qaMd) return { goals, questions, parsedCount: 0 }
  const headRe = /^#{2,4}\s*([GQgq])(\d+)\s*[：:）)\s]*(.*)$/
  const lines = qaMd.replace(/\r\n/g, '\n').split('\n')
  let kind: 'G' | 'Q' | null = null
  let idx = 0
  let body: string[] = []
  let parsedCount = 0
  const flush = () => {
    if (kind && idx > 0 && body.length) {
      let text = body.join('\n').trim()
      // 剥离正文里可能复述的「**问题**：…/**目标**：…」行（标题已含原文，此行冗余）
      text = text.replace(/^\s*\*\*(?:问题|目标|原文)\*\*\s*[：:][^\n]*\n?/, '')
      // 剥离「**回应**：/**回答**：」标签前缀（保留其余加粗内容）
      text = text.replace(/^\s*\*\*(?:回应|回答|评估回应|评估回答|答)\*\*\s*[：:]\s*/, '')
      text = text.trim()
      if (text) {
        if (kind === 'G') goals[idx] = text
        else questions[idx] = text
        parsedCount += 1
      }
    }
    kind = null
    idx = 0
    body = []
  }
  for (const line of lines) {
    const m = headRe.exec(line)
    if (m) {
      flush()
      kind = m[1].toUpperCase() as 'G' | 'Q'
      idx = parseInt(m[2], 10)
      continue
    }
    if (kind && idx > 0) {
      // 章节级 ## 标题（非条目标题）→ 结束当前条目
      if (/^##\s+/.test(line)) { flush(); continue }
      body.push(line)
    }
  }
  flush()
  return { goals, questions, parsedCount }
}
