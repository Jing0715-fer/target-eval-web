/**
 * v2.12 合并报告结构分层回归（真实数据重渲染冒烟）：
 *  用 DB 中的真实批次报告（cmwiu7dgj… BTN/TCR 7 靶点复合物批次）按
 *  upgradeLegacyHtml 同样的数据路径重渲染，验证：
 *  1. 首页（view-home）不含「各靶点结构可行性综述」h3 小节（拆分成功）
 *  2. 每个靶点有独立视图 view-target-<ID>，含综述/单独报告/PDB/文献区块
 *  3. 靶点卡片 data-goto + 目录靶点单独报告 chips 指向视图
 *  4. 视图切换脚本 + 打印准备脚本就位；idm 矩阵居中样式存在
 *  5. 首页文献 = 共有结构文献（去重）；各靶点文献折叠块在靶点页内
 *  6. marker mrg-fmt-v2.12 存在
 * 输出新 HTML 到 /tmp/render-v2.12.html 供 Playwright 截图核验。
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { db } from '../src/lib/db'
import { loadMergedTargets, renderMergedReportHtml } from '../src/lib/eval/report-merged'
import { computeSharedStructures } from '../src/lib/eval/shared-structures'
import type { FormInsights, ParsedImage, RelationJudgment, SequenceAttribution, SharedStructure } from '../src/lib/eval/types'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}`, detail !== undefined ? String(detail) : '') }
}

async function main() {
  const record = await db.batchReport.findFirst({ where: { id: { startsWith: 'cmwiu7dgj' } }, orderBy: { createdAt: 'desc' } })
  if (!record) { console.error('未找到 cmwiu7dgj 批次报告记录'); process.exit(1) }
  console.log(`记录：${record.id} · title=${record.title ?? '—'} · status=${record.status}`)
  const jobIds: string[] = JSON.parse(record.jobIds)
  const relation: RelationJudgment = JSON.parse(record.relation)
  const targets = await loadMergedTargets(jobIds)
  console.log(`targets 加载：${targets.length} 个（${targets.map(t => t.uniprotId).join(', ')}）`)

  let insights: FormInsights | null = null
  let images: ParsedImage[] = []
  let assetDir = ''
  const uploadId = record.uploadId ?? ''
  if (uploadId) {
    const uploadDir = path.join(process.cwd(), 'db', 'reports', uploadId)
    assetDir = path.join(uploadDir, 'assets')
    try { images = (JSON.parse(await fs.readFile(path.join(uploadDir, 'parsed.json'), 'utf-8')) as { images?: ParsedImage[] }).images ?? [] } catch { /* ignore */ }
    try {
      const data = JSON.parse(await fs.readFile(path.join(uploadDir, 'insights.json'), 'utf-8')) as FormInsights
      if (Array.isArray(data.goals)) insights = data
    } catch { /* ignore */ }
  }
  let sequenceAttribution: SequenceAttribution[] | undefined
  try { sequenceAttribution = record.sequenceAttribution ? JSON.parse(record.sequenceAttribution) : undefined } catch { /* ignore */ }
  let sharedStructures: SharedStructure[] | undefined
  try { sharedStructures = record.sharedStructures ? JSON.parse(record.sharedStructures) : undefined } catch { /* ignore */ }
  if (!sharedStructures) sharedStructures = computeSharedStructures(targets)

  const html = await renderMergedReportHtml({
    targets, relation,
    markdown: record.markdown ?? '',
    title: record.title ?? undefined,
    llmOk: !record.error,
    llmErrors: record.error ? [record.error] : [],
    images, assetDir,
    batchReportId: record.id,
    engineSummary: record.engine ?? '—',
    sequenceAttribution, sharedStructures, insights,
  })
  await fs.writeFile('/tmp/render-v2.12.html', html, 'utf-8')
  console.log(`HTML ${(html.length / 1024).toFixed(0)}KB → /tmp/render-v2.12.html\n`)

  // ── 结构断言 ──
  check('mrg-fmt-v2.12 marker', html.includes('mrg-fmt-v2.12'))
  check('首页视图容器 view-home', html.includes('id="view-home"'))
  const viewCount = (html.match(/class="rpt-view"/g) ?? []).length + (html.match(/rpt-view rpt-view-on/g) ?? []).length
  check(`靶点视图页数量 = ${targets.length}（总视图 ${viewCount}）`, viewCount === targets.length + 1, viewCount)
  for (const t of targets) {
    const key = (t.uniprotId ?? t.label).replace(/[^A-Za-z0-9]/g, '')
    const viewExists = html.includes(`id="view-target-${key}"`)
    const hasBack = html.includes('data-goto="home"')
    check(`视图 view-target-${key}`, viewExists)
    check(`  · 靶点卡 data-goto="target-${key}"`, html.includes(`data-goto="target-${key}"`))
    const seg = html.split(`id="view-target-${key}"`)[1]?.split('class="rpt-view"')[0] ?? ''
    check('  · 含结构可行性综述章节', seg.includes('结构可行性综述'))
    check('  · 含单独报告（基本信息 + 预测结构）', seg.includes('单独报告（基本信息 + 预测结构）'))
    check('  · 含返回报告首页按钮', hasBack)
  }
  const homeSeg = html.split('id="view-home"')[1]?.split('<div class="rpt-view"')[0] ?? ''
  check('首页不含「各靶点结构可行性综述」小节', !homeSeg.includes('各靶点结构可行性综述'))
  check('首页含合并评估分析', homeSeg.includes('合并评估分析'))
  check('首页含共有结构章节', homeSeg.includes('id="shared-pdbs"'))
  check('首页含共有结构文献（PMID 去重）', homeSeg.includes('共有结构文献'))
  check('首页不含各靶点 PDB 结构独立章节', !homeSeg.includes('id="pdbs"'))
  check('首页不含各靶点文献独立章节', !homeSeg.includes('id="literature"'))
  check('目录靶点单独报告 chips', html.includes('靶点单独报告 · '))
  check('视图切换脚本 __rptShowView', html.includes('__rptShowView'))
  check('打印准备脚本 rpt-print-all', html.includes('rpt-print-all'))
  check('3D 懒初始化 __rptInitPendingStages', html.includes('__rptInitPendingStages'))
  check('矩阵 idm 居中表', html.includes('<table class="idm"'))
  check('矩阵角格提示', html.includes('idm-corner'))
  check('glance 阅读路径提及单独报告页', html.includes('靶点单独报告页'))

  console.log(`\n结果：${pass} 通过 · ${fail} 失败`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
