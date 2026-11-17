// @ts-nocheck
/**
 * scripts/test-qa-render.ts — v2.10 ② 端到端渲染验证
 * 真实 BTN-TCR 合并报告记录（cmwisjiqu…）+ 注入合成段D「客户评估表问题回应」→
 * renderMergedReportHtml 全链路渲染，断言：
 *  1) 每条客户目标/待解决科学问题下方内嵌逐条回应（.qa-ans）
 *  2) QA 章节从「合并评估分析」章节移除（不双份渲染）
 *  3) 目录条目更新为「客户评估表要点与回应」
 * 用法：bun scripts/test-qa-render.ts [batchReportId]
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { db } from '@/lib/db'
import { loadMergedTargets, renderMergedReportHtml } from '@/lib/eval/report-merged'
import { computeSharedStructures } from '@/lib/eval/shared-structures'
import type { FormInsights, RelationJudgment } from '@/lib/eval/types'

async function main() {
  const id = process.argv[2] || 'cmwisjiqu0007p7s4134v5v82'
  const record = await db.batchReport.findUnique({ where: { id } })
  if (!record) throw new Error(`记录不存在: ${id}`)
  const jobIds: string[] = JSON.parse(record.jobIds)
  const relation: RelationJudgment = JSON.parse(record.relation)
  const targets = await loadMergedTargets(jobIds)
  console.log(`靶点 ${targets.length} 个 · title=${record.title}`)

  // insights（上传共享数据）
  let insights: FormInsights | null = null
  const uploadId = record.uploadId
  if (uploadId) {
    try {
      insights = JSON.parse(await fs.readFile(path.join(process.cwd(), 'db', 'reports', uploadId, 'insights.json'), 'utf-8'))
    } catch { /* 可选 */ }
  }
  if (!insights?.goals?.length) throw new Error('该记录无 insights goals — 请换一条有评估表的记录')

  // 合成段D（按段D 指令的严格格式，使用真实 goals/questions 原文）
  const goals = insights.goals.slice(0, 6)
  const questions = insights.scientificQuestions.slice(0, 6)
  const qaChapter = [
    '## 客户评估表问题回应',
    ...goals.map((g, i) => `### G${i + 1}：${g}\n**回应**：测试回应 G${i + 1} — 该目标依据 BTN 家族 ${33 + i} 个结构可达成，建议沿共表达路线推进。`),
    ...questions.map((q, i) => `### Q${i + 1}：${q}\n**回答**：测试回答 Q${i + 1} — 取决于界面重叠情况，共有结构 8ZHR 提供直接参考，建议竞争结合实验验证。`),
  ].join('\n\n')
  const markdown = `${record.markdown ?? ''}\n\n${qaChapter}`

  const sharedStructures = computeSharedStructures(targets)
  const html = await renderMergedReportHtml({
    targets,
    relation,
    goal: '测试目标',
    markdown,
    title: record.title ?? undefined,
    llmOk: true,
    llmErrors: [],
    images: [],
    assetDir: path.join(process.cwd(), 'db', 'reports', uploadId ?? 'x', 'assets'),
    batchReportId: record.id,
    engineSummary: 'test-engine',
    sequenceAttribution: [],
    sharedStructures,
    insights,
  })

  // ── 断言 ──
  const checks: Array<[string, boolean]> = [
    ['每条目标回应内嵌（3 个 .qa-ans 评估回应）', (html.match(/class="qa-ans"/g) ?? []).length === goals.length + questions.length],
    ['目标条目与回应同 <li>（G1 文本后紧跟回应）', /<li>[^<]*解析抗体识别界面[\s\S]{0,400}?class="qa-ans"/.test(html)],
    ['问题条目与回应同 <li>（Q1 原文后紧跟回应）', /<li>目标抗体能否与 TCR 同时占据复合物？[\s\S]{0,400}?class="qa-ans"/.test(html)],
    ['回应正文含段D 内容（8ZHR 证据）', html.includes('共有结构 8ZHR 提供直接参考')],
    ['QA 章节从合并分析章节移除（无 <h2>客户评估表问题回应）', !/<h2[^>]*>\s*客户评估表问题回应/.test(html)],
    ['原分析章节保留（执行摘要仍在）', html.includes('执行摘要')],
    ['目录条目更新（要点与回应）', html.includes('客户评估表要点与回应')],
    ['目录编号连续（03 · 客户评估表要点与回应）', /href="#insights"[^>]*>0\d · 客户评估表要点与回应/.test(html)],
    ['标题 h2 更新', /sec-title">客户评估表要点与回应</.test(html)],
    ['段D 编号错位防护（G2/Q2 各自独立）', html.includes('测试回应 G2') && html.includes('测试回答 Q2')],
  ]
  let fail = 0
  for (const [name, ok] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
    if (!ok) fail++
  }
  const out = path.join('/tmp', 'render-qa.html')
  await fs.writeFile(out, html, 'utf-8')
  console.log(`\n输出 ${out} · ${(html.length / 1024).toFixed(0)}KB · qa-ans 总数 ${(html.match(/class="qa-ans"/g) ?? []).length}`)
  await db.$disconnect()
  process.exit(fail ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
