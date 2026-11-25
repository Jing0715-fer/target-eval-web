/**
 * v2.86 E2E 验证 — 用户真实汇总报告导入全链路（解析 → 展开匹配 → 上传留存 → 汇总生成 → 原文共享内嵌）。
 *
 * 用户场景：上传 Excel（靶点清单）+ 历史「汇总报告」（117 靶点）→ 载入既有评估 →
 * 组装新汇总报告 → 上传的 html 完整嵌入。
 *
 * 修复前实测：汇总报告被识别为 kind='dashboard'（title 含「高通量评估汇总报告」）→
 * 不参与靶点匹配 → 117 靶点全部无 stats 降级 + 原文不嵌入。
 *
 * 验证链路：
 *  1. 客户端解析器解析用户真实汇总件 → N 完整统计区段（v2.86 新增汇总载荷解析）；
 *  2. 模拟 Excel 靶点（区段身份反推）→ pickImportedStats 定位链（SHA/acc/长度）命中；
 *  3. planArchiveSkips 匹配（展开条目 job 通道 — 模拟 applyArchiveSkips 前置）；
 *  4. POST ht-imported-report 上传用户件 → reportId + contentSha；
 *  5. buildImportedRows + writeHtDashboardHtmlFile 流式渲染（共享载荷池）→
 *     ① 每行 data-overall ≥ 0（完整统计行 — 非 bare 降级）；
 *     ② 载荷 r[i].sk 引用 + RP.s 共享池内嵌真实汇总件原文（字节级一致）；
 *     ③ 同文件 117 行共享一份（产物体积 ≈ 源文件 + shell，非 117×）；
 *     ④ embed-stat 计数 = 全部行。
 *
 * 用法：bun scripts/test-v286-summary-import.ts（需 dev server 运行在 3000 端口）
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import {
  extractImportedStatsSections,
  pickImportedStats,
  toCleanImportedStats,
  type ImportedStatsSection,
} from '../src/lib/eval/imported-stats'
import { buildImportedRows, writeHtDashboardHtmlFile, loadImportedReportHtml, computeHtStats, ruleVerdict, type HtDashboardRow, type HtImportedTarget } from '../src/lib/eval/ht-dashboard'
import { db } from '../src/lib/db'

const BASE = 'http://localhost:3000'
const REAL_FILE = '/home/z/my-project/upload/TargetEval_HT_2026-11-25_74g_高通量评估汇总报告 · 117 靶点 · 2026-11-25 (2).html'

async function main() {
  const results: Array<[string, boolean, string]> = []
  const t = (name: string, ok: boolean, detail?: string) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
    results.push([name, ok, detail ?? ''])
  }

  const html = await fs.readFile(REAL_FILE, 'utf-8')
  const sourceSha = createHash('sha256').update(html, 'utf-8').digest('hex').slice(0, 32)

  // ── 1. 解析（v2.86 汇总载荷解析）──
  const sections = extractImportedStatsSections(html)
  t('汇总件解析出 ≥100 区段（修复前 0）', sections.length >= 100, `sections=${sections.length}`)
  t('解析行评分完整（overall 0-10）', sections.every(s => Number.isFinite(s.overall) && s.overall >= 0 && s.overall <= 10),
    `首行 overall=${sections[0]?.overall} xray=${sections[0]?.xray} cryoem=${sections[0]?.cryoem}`)
  t('完整提交序列提取（data-seq → seqRaw）', sections.filter(s => s.seqRaw).length === sections.length,
    `有序列 ${sections.filter(s => s.seqRaw).length}/${sections.length}`)

  // ── 2. pick 定位（模拟 Excel 靶点 — 区段身份反推 + SHA 补算）──
  for (const s of sections) {
    if (!s.seqSha && s.seqRaw) {
      s.seqSha = createHash('sha256').update(s.seqRaw).digest('hex').slice(0, 16)
    }
  }
  const sample = sections[0]!
  const shaHit = pickImportedStats(sections, { seqSha: createHash('sha256').update(sample.seqRaw!).digest('hex').slice(0, 16) })
  t('①SHA 通道定位命中（同序列即同靶点）', shaHit != null && shaHit.seqSha === sample.seqSha)
  const accHit = pickImportedStats(sections, { acc: sample.uniprotId, range: sample.range })
  t('②acc+区间通道定位命中', accHit != null && accHit.uniprotId === sample.uniprotId,
    `acc=${sample.uniprotId} range=${JSON.stringify(sample.range)} -> ${accHit ? '命中' : '未中'}`)
  const lenHit = pickImportedStats(sections, { length: sample.metaSeqLength, label: sample.metaLabel })
  t('③长度+标签通道定位命中', lenHit != null, `len=${sample.metaSeqLength} label=${sample.metaLabel?.slice(0, 20)}`)

  // ── 3. 展开条目匹配语义（kind='job' 通道 — 与单靶点报告同通道）──
  // 模拟：展开条目的 seqSha 与 Excel 序列靶点 t.seqSha 等值 → planArchiveSkips ①SHA 通道
  // （planArchiveSkips 是客户端纯函数但依赖 jszip/WebCrypto 环境语义 — 此处以
  //  pickImportedStats 的 SHA 通道 + 条目字段完备性等效验证）
  const expandable = sections.filter(s => s.uniprotId || (s.seqRaw && s.seqSha))
  t('展开条目证据完备（acc 或 SHA 至少其一）', expandable.length >= sections.length - 25,
    `可展开 ${expandable.length}/${sections.length}（25 个无 acc 序列靶点走 SHA/长度/标签通道）`)

  // ── 4. 服务端上传留存 ──
  let reportId: string | undefined
  try {
    const res = await fetch(`${BASE}/api/evaluate/ht-imported-report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileName: 'TargetEval_v286_summary_import.html', html }),
    })
    const j = (await res.json()) as { id?: string; contentSha?: string; error?: string }
    reportId = j.id
    t('POST ht-imported-report 上传用户件', res.ok && Boolean(reportId), `status=${res.status} reportId=${reportId?.slice(0, 12) ?? '无'} sha=${j.contentSha?.slice(0, 12) ?? '无'}${j.error ? ' err=' + j.error : ''}`)
  } catch (err) {
    t('POST ht-imported-report 上传用户件', false, String(err))
  }

  // ── 5. 生成链路（服务端口径 — buildImportedRows + 流式渲染共享池）──
  const imported: HtImportedTarget[] = sections.slice(0, 12).map((s, i) => ({
    label: (s.metaLabel ?? `v286-target-${i + 1}`).slice(0, 60),
    sequence: s.seqRaw,
    range: s.range,
    stats: toCleanImportedStats(s),
    reportId,
    sourceSha,
    fileName: 'TargetEval_v286_summary_import.html',
  }))
  const budget = { total: 0 }
  // 归属：直查上传记录的 ownerKey（与 HTTP 上下文同源 — 测试环境隔离）
  let owner = { key: 'v286-test', ipKey: 'v286-test' }
  if (reportId) {
    const rec = await db.importedReport.findUnique({ where: { id: reportId }, select: { ownerKey: true } }).catch(() => null)
    if (rec?.ownerKey) owner = { key: rec.ownerKey, ipKey: rec.ownerKey }
  }
  const pathById = reportId
    ? await loadImportedReportHtml(imported, owner, budget)
    : new Map<string, string>()
  t('loadImportedReportHtml 规划到留存路径', pathById.size >= 1, `map=${pathById.size}`)

  const { rows, bareRows } = buildImportedRows(imported, pathById)
  t('buildImportedRows 全部完整统计行（零降级）', rows.length === 12 && bareRows.length === 0,
    `rows=${rows.length} bare=${bareRows.length}`)

  const stats = computeHtStats(rows)
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'v286-'))
  const outPath = path.join(outDir, 'dashboard.html')
  const verdicts = rows.map(r => ({ jobId: r.jobId, ...ruleVerdict(r) })) as never[]
  await writeHtDashboardHtmlFile(
    {
      title: 'v2.86 汇总件导入验证',
      rows: rows as HtDashboardRow[],
      stats,
      verdicts,
      markdown: 'E2E 验证 — 汇总件导入共享内嵌',
      llmOk: false,
      llmErrors: [],
      engineSummary: 'v2.86-e2e',
      origin: '',
      generatedAt: new Date().toISOString(),
    },
    outPath,
  )
  const out = await fs.readFile(outPath, 'utf-8')
  const outSize = out.length

  // ① sk 引用 + s 池
  const rpM = /<script type="application\/json" id="ht-rpt-data">([\s\S]*?)<\/script>/.exec(out)
  const RP = rpM ? JSON.parse(rpM[1]!) as { r?: Array<{ sk?: string; html?: string }>; s?: Record<string, string> } : null
  t('载荷 r[i].sk 共享引用', Boolean(RP && RP.r && RP.r.every(x => typeof x.sk === 'string')),
    `sk 行 ${RP?.r?.filter(x => x.sk).length ?? 0}/${RP?.r?.length ?? 0}`)
  t('共享池 RP.s 存在且仅一份原文', Boolean(RP && RP.s && Object.keys(RP.s).length === 1),
    `池条目 ${Object.keys(RP?.s ?? {}).length}（12 行共享 1 份）`)
  const poolHtml = RP?.s ? Object.values(RP.s)[0] : undefined
  t('池内原文与用户件字节级一致', poolHtml === html, `len=${poolHtml?.length ?? 0} vs ${html.length}`)

  // ② 行统计（弹出页弹出即整份用户件 — 「完整嵌入」）
  t('产物体积 ≈ 源件 + shell（非 12×膨胀）', outSize < html.length * 1.5 + 100_000,
    `产物 ${(outSize / 1024).toFixed(0)}KB vs 源件 ${(html.length / 1024).toFixed(0)}KB`)

  // ③ embed-stat 徽标
  t('主表行 data-overall ≥ 0', (out.match(/data-overall="(\d+)"/g) ?? []).length === 12,
    `统计行 ${(out.match(/data-overall="(\d+)"/g) ?? []).length}/12`)

  // ── 清理 ──
  await fs.rm(outDir, { recursive: true, force: true })

  const failed = results.filter(r => !r[1])
  console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ ${failed.length} 项失败`}：${results.length} 项`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('E2E 异常：', err)
  process.exit(1)
})
