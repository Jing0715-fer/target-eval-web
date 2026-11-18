// @ts-nocheck
/**
 * scripts/upgrade-merged-qa.ts — v2.10 ② 旧合并报告补答升级
 * 用户反馈「客户评估表要点部分好像问题都没有回答」— 旧记录（如 BTN-TCR cmwisjiqu…）
 * 生成于段D 存在之前。本脚本对既有记录：
 *   generateInsightQa（LLM 生成 ## 客户评估表问题回应 章节）→ 追加到 markdown →
 *   renderMergedReportHtml 重渲染（逐条回答内嵌到客户评估表要点章节）→ 落盘 + 更新 DB。
 * 幂等：markdown 已含该章节时跳过 LLM 直接重渲染。
 * 用法：bun scripts/upgrade-merged-qa.ts [batchReportId]
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { db } from '@/lib/db'
import { loadMergedTargets, renderMergedReportHtml, generateInsightQa } from '@/lib/eval/report-merged'
import { computeSharedStructures } from '@/lib/eval/shared-structures'
import { QA_CHAPTER_TITLE } from '@/lib/eval/qa-chapter'
import type { FormInsights, ParsedImage, RelationJudgment, SequenceAttribution } from '@/lib/eval/types'

async function main() {
  const id = process.argv[2] || 'cmwisjiqu0007p7s4134v5v82'
  const record = await db.batchReport.findUnique({ where: { id } })
  if (!record) throw new Error(`记录不存在: ${id}`)
  console.log(`记录 ${id} · title=${record.title} · status=${record.status}`)

  const jobIds: string[] = JSON.parse(record.jobIds)
  const relation: RelationJudgment = JSON.parse(record.relation)
  const targets = await loadMergedTargets(jobIds)
  console.log(`靶点 ${targets.length} 个`)

  // 上传共享数据（insights + 图片）
  let insights: FormInsights | null = null
  let images: ParsedImage[] = []
  let assetDir = ''
  if (record.uploadId) {
    const uploadDir = path.join(process.cwd(), 'db', 'reports', record.uploadId)
    assetDir = path.join(uploadDir, 'assets')
    try { insights = JSON.parse(await fs.readFile(path.join(uploadDir, 'insights.json'), 'utf-8')) } catch { /* 可选 */ }
    try { images = (JSON.parse(await fs.readFile(path.join(uploadDir, 'parsed.json'), 'utf-8'))).images ?? [] } catch { /* 可选 */ }
  }
  if (!insights?.goals?.length && !insights?.scientificQuestions?.length) {
    console.log('该记录无评估表目标/问题 — 无需补答，退出')
    return
  }

  let sequenceAttribution: SequenceAttribution[] = []
  try { sequenceAttribution = record.sequenceAttribution ? JSON.parse(record.sequenceAttribution) : [] } catch { /* ignore */ }
  const sharedStructures = computeSharedStructures(targets)

  const goal = insights?.goals?.join('；')
  let markdown = record.markdown ?? ''

  // 幂等：已有段D 章节 → 仅重渲染；否则 LLM 生成后追加
  if (new RegExp(`^##\\s*${QA_CHAPTER_TITLE}\\s*$`, 'm').test(markdown)) {
    console.log('markdown 已含段D 章节 — 仅重渲染 HTML')
  } else {
    console.log('LLM 生成段D（客户评估表问题回应）…')
    const qa = await generateInsightQa({ targets, relation, goal, insights, images, sequenceAttribution })
    if (!qa.ok || !qa.markdown.trim()) {
      console.error(`段D 生成失败: ${qa.error ?? '未知'}`)
      process.exit(1)
    }
    // 剥离 LLM 可能附加的首行 # 标题，仅保留 ## 章节
    const qaMd = qa.markdown.replace(/^#\s+.+\r?\n?/, '').trim()
    markdown = `${markdown.trim()}\n\n${qaMd}`
    console.log(`段D 已生成（${qaMd.length} 字符）`)
  }

  console.log('重渲染 HTML…')
  const html = await renderMergedReportHtml({
    targets,
    relation,
    goal,
    markdown,
    title: record.title ?? undefined,
    llmOk: true,
    llmErrors: [],
    images,
    assetDir,
    batchReportId: record.id,
    engineSummary: record.engine ?? '—',
    sequenceAttribution,
    sharedStructures,
    insights,
  })

  // 落盘：HTML 文件 + DB（markdown / updatedAt）
  const dir = path.dirname(record.htmlPath ?? path.join(process.cwd(), 'db', 'reports', record.id))
  const htmlPath = record.htmlPath ?? path.join(dir, 'report.html')
  await fs.mkdir(path.dirname(htmlPath), { recursive: true })
  await fs.writeFile(htmlPath, html, 'utf-8')
  await db.batchReport.update({ where: { id: record.id }, data: { markdown, htmlPath, updatedAt: new Date() } })

  // 验证
  const qaCount = (html.match(/class="qa-ans"/g) ?? []).length
  console.log(`完成: ${htmlPath} · ${(html.length / 1024).toFixed(0)}KB · qa-ans 回应卡 ${qaCount} 个（期望 ${(insights?.goals?.length ?? 0) + (insights?.scientificQuestions?.length ?? 0)}）`)
  await db.$disconnect()
  process.exit(qaCount > 0 ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })
