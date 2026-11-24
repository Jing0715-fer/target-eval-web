/**
 * v2.82 服务端验证脚本 — 导入报告原文「原封不动嵌入」（DB 恢复行的弹出页改用上传件）。
 *
 * 用户实测问题：「查看完整报告还是不是重新上传的完整报告」— 载入靶点的原作业仍在
 * 服务器时（importedJobId 命中 DB），弹出页此前内嵌的是**服务器旧作业的报告文件**
 * （或其回收后的重建页），用户重新上传的报告被静默忽略。v2.82 修复后上传件优先。
 *
 * 验证链路（对齐真实使用：导入报告 → 启动运行 → 生成汇总报告 → 查看完整报告）：
 *  1. 造一个 done 作业（DB 行 + 磁盘报告文件，内含标记 JOB-REPORT-ORIGINAL）；
 *  2. 经 POST /api/evaluate/ht-imported-report 上传用户报告（标记
 *     USER-UPLOADED-REPORT-V282）→ 拿到 reportId；
 *  3. POST /api/evaluate/ht-dashboard：entries 含该 jobId（importedJobIds 路径 —
 *     DB 恢复行）+ imported 载荷携带 reportId；
 *  4. 轮询至 done，取回看板 HTML：
 *     ① 载荷内嵌 USER-UPLOADED-REPORT-V282（上传件原封不动嵌入 — 修复生效）；
 *     ② 不含 JOB-REPORT-ORIGINAL（旧作业报告文件不再占用该行弹出页）；
 *     ③ 行内「载入」徽标存在（DB 恢复行口径不变）。
 *
 * 用法：bun scripts/test-imported-verbatim.ts（需 dev server 运行在 3000 端口）
 */
import { PrismaClient } from '@prisma/client'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

const db = new PrismaClient()
const BASE = 'http://localhost:3000'

async function main() {
  const results: Array<[string, boolean, string]> = []
  const stamp = Date.now().toString(36)
  const jobId = `testimpv282${stamp}`.padEnd(25, 'x').slice(0, 25)
  const label = `载入靶点A-${stamp.slice(-4)}`
  const jobReportDir = path.join(process.cwd(), 'db', 'reports', jobId)
  const jobReportPath = path.join(jobReportDir, 'report.html')
  const jobReportHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>服务器旧作业报告</title></head><body><h1>服务器旧作业报告（JOB-REPORT-ORIGINAL）</h1><p>这是原评估在服务器上的报告文件 — v2.82 前载入行弹出页错误地内嵌这一份。</p></body></html>`
  const uploadedHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>用户重新上传的完整报告</title></head><body><h1>用户重新上传的完整报告（USER-UPLOADED-REPORT-V282）</h1><p>这是用户明确上传的报告文件 — 应原封不动嵌入「完整报告」弹出页。</p></body></html>`
  let dashboardId = ''
  let reportId = ''

  try {
    // ── 准备：done 作业 + 磁盘报告文件 ──
    await fs.mkdir(jobReportDir, { recursive: true })
    await fs.writeFile(jobReportPath, jobReportHtml, 'utf-8')
    await db.evaluationJob.create({
      data: {
        id: jobId,
        status: 'done',
        mode: 'uniprot',
        title: '载入靶点A（原评估）',
        uniprotId: 'P0DTD1',
        summary: JSON.stringify({
          uniprot: { uniprotId: 'P0DTD1', proteinName: '载入靶点A蛋白', organism: '测试种', sequenceLength: 300 },
          scores: { xray: { score: 7 }, cryoem: { score: 6 }, nmr: { score: 5 }, overall: { score: 7 } },
          methodStats: { xrayCount: 2, cryoemCount: 1, nmrCount: 0, bestResolution: 2.1 },
          coverage: 82, ligandCount: 1, literatureCount: 3, durationMs: 60_000,
        }),
        pdbs: '[]', blastHits: '[]', literature: '[]',
        reportPath: jobReportPath,
        reportMarkdown: '## 原评估报告正文\n旧作业的 markdown 正文。',
        ownerKey: null,
      },
    })

    // ── 上传用户报告（模拟用户重新上传完整报告）──
    const upRes = await fetch(`${BASE}/api/evaluate/ht-imported-report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileName: `完整报告-${stamp}.html`, html: uploadedHtml }),
    })
    const upData = (await upRes.json()) as { ok?: boolean; id?: string; error?: string }
    results.push(['用户报告上传留存成功', upRes.ok && upData.ok === true && typeof upData.id === 'string', JSON.stringify(upData).slice(0, 120)])
    if (!upData.id) throw new Error(`上传失败：${upData.error ?? upRes.status}`)
    reportId = upData.id

    // ── 生成汇总报告（DB 恢复行 + 上传件并存 — v2.82 修复场景）──
    const genRes = await fetch(`${BASE}/api/evaluate/ht-dashboard`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        entries: [{ jobId, group: 1, label }],
        imported: [{
          label, group: 1,
          reportId,
          fileName: `完整报告-${stamp}.html`,
          stats: {
            overall: 7, xray: 7, cryoem: 6, nmr: 5,
            pdbCount: 2, blastHitCount: 0, literatureCount: 3,
            methodXrayCount: 2, methodCryoemCount: 1, methodNmrCount: 0,
            bestResolution: 2.1, coverage: 82,
            proteinName: '载入靶点A蛋白', organism: '测试种', uniprotId: 'P0DTD1',
          },
        }],
        importedJobIds: [jobId],
        goal: 'v2.82 导入报告原文嵌入验证',
      }),
    })
    const genData = (await genRes.json()) as { ok?: boolean; dashboard?: { id?: string }; error?: string }
    results.push(['汇总报告生成受理', genRes.ok && genData.ok === true && typeof genData.dashboard?.id === 'string', JSON.stringify(genData).slice(0, 160)])
    if (!genData.dashboard?.id) throw new Error(`生成受理失败：${genData.error ?? genRes.status}`)
    dashboardId = genData.dashboard.id

    // ── 轮询至终态（AI 增强 best-effort — 基础版先行落盘，通常 <60s）──
    let final: { status?: string; error?: string } | null = null
    const t0 = Date.now()
    for (let i = 0; i < 90; i++) {
      await new Promise(r => setTimeout(r, 3_000))
      const st = (await (await fetch(`${BASE}/api/evaluate/ht-dashboard?id=${dashboardId}`)).json()) as { dashboard?: { status?: string; error?: string } }
      if (st.dashboard?.status && st.dashboard.status !== 'running') { final = st.dashboard; break }
      if (Date.now() - t0 > 240_000) break
    }
    results.push(['生成到达终态 done', final?.status === 'done', `status=${final?.status ?? '超时'} ${final?.error ? `error=${final.error.slice(0, 80)}` : ''}`])
    if (final?.status !== 'done') throw new Error(`生成未完成：${final?.status} ${final?.error ?? ''}`)

    // ── 取回看板 HTML 验证弹出页载荷 ──
    const htmlRes = await fetch(`${BASE}/api/evaluate/ht-dashboard?id=${dashboardId}&download=1`)
    const html = await htmlRes.text()
    results.push(['看板 HTML 取回（含载荷）', htmlRes.ok && html.length > 10_000, `bytes=${html.length}`])
    results.push([
      '弹出页内嵌用户上传的报告原文（原封不动 — USER-UPLOADED-REPORT-V282 在载荷中）',
      html.includes('USER-UPLOADED-REPORT-V282'),
      html.includes('USER-UPLOADED-REPORT-V282') ? '命中' : '未命中（v2.82 修复未生效 — 上传件被忽略）',
    ])
    results.push([
      '旧作业报告文件不再占用该行弹出页（JOB-REPORT-ORIGINAL 不在载荷中）',
      !html.includes('JOB-REPORT-ORIGINAL'),
      html.includes('JOB-REPORT-ORIGINAL') ? '旧文件仍被内嵌（预算双占 + 弹出页内容错误）' : '未出现（预算让给上传件）',
    ])
    results.push([
      'DB 恢复行「载入」徽标口径不变（imported 行呈现）',
      html.includes('载入'),
      '载入徽标/说明渲染',
    ])
    results.push([
      '主表行含靶点标签与评分',
      html.includes(label.slice(0, 12)) && html.includes('P0DTD1'),
      '标签 + UniProt 列渲染',
    ])
  } finally {
    // ── 清理测试数据 ──
    try {
      if (dashboardId) {
        const rec = await db.htDashboard.findUnique({ where: { id: dashboardId } })
        if (rec?.htmlPath) await fs.rm(path.dirname(rec.htmlPath), { recursive: true, force: true }).catch(() => undefined)
        await db.htDashboard.delete({ where: { id: dashboardId } }).catch(() => undefined)
      }
      if (reportId) {
        const rec = await db.importedReport.findUnique({ where: { id: reportId } })
        if (rec?.htmlPath) await fs.rm(rec.htmlPath, { force: true }).catch(() => undefined)
        await db.importedReport.delete({ where: { id: reportId } }).catch(() => undefined)
      }
      await fs.rm(jobReportDir, { recursive: true, force: true }).catch(() => undefined)
      await db.evaluationJob.delete({ where: { id: jobId } }).catch(() => undefined)
    } catch { /* 清理尽力而为 */ }
  }

  let pass = 0
  console.log('\n── v2.82 导入报告原文嵌入验证 ──')
  for (const [name, ok, note] of results) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? `  · ${note}` : ''}`)
    if (ok) pass++
  }
  console.log(`\n${pass}/${results.length} 通过`)
  if (pass < results.length) process.exitCode = 1
  await db.$disconnect()
}

void main()
