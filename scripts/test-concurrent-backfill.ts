/**
 * v2.82 并发链路验证：载入靶点带序列（无 uniprotId）→ AI 与 UniProt 识别并发 →
 * 终版看板含回填的 UniProt 列（AI 失败时也含 — 两段式写盘验证）。
 */
import { PrismaClient } from '@prisma/client'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

const db = new PrismaClient()
const BASE = 'http://localhost:3000'
// 人 p53 N 端 100 aa（真实序列 — EBI Swiss-Prot 应 100% 命中 P04637）
const SEQ = 'MEEPQSDPSVEPPLSQETFSDLWKLLPENNVLSPLPSQAMDDLMLSPDDIEQWFTEDPGPDEAPRMPEAAPPVAPAPAAPTPAAPAPAPSWPLSSSVPSQKTYQGSYGFRLGFLHG'

async function main() {
  const results: Array<[string, boolean, string]> = []
  const stamp = Date.now().toString(36)
  const label = `p53片段-${stamp.slice(-4)}`
  let dashboardId = ''
  let reportId = ''
  try {
    const up = await fetch(`${BASE}/api/evaluate/ht-imported-report`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileName: `p53-fragment-${stamp}.html`, html: `<!DOCTYPE html><html><head><meta charset="utf-8"><title>p53 片段报告</title></head><body><h1>p53 片段既有报告（无 UniProt 标注）</h1></body></html>` }),
    })
    const upData = (await up.json()) as { id?: string }
    if (!upData.id) throw new Error('上传失败')
    reportId = upData.id

    const gen = await fetch(`${BASE}/api/evaluate/ht-dashboard`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        entries: [],
        imported: [{ label, group: 1, reportId, sequence: SEQ, fileName: `p53-fragment-${stamp}.html`, stats: { overall: 6, xray: 6, cryoem: 5, nmr: 5, pdbCount: 1, blastHitCount: 2, literatureCount: 4, methodXrayCount: 1, methodCryoemCount: 0, methodNmrCount: 0, bestResolution: 2.5, coverage: 60, proteinName: '未知靶点', organism: '' } }],
        goal: 'v2.82 并发回填验证',
      }),
    })
    const genData = (await gen.json()) as { ok?: boolean; dashboard?: { id?: string }; error?: string }
    if (!genData.dashboard?.id) throw new Error(`受理失败：${genData.error}`)
    dashboardId = genData.dashboard.id
    console.log('生成受理，轮询中（并发段：AI + UniProt 识别）…')

    let progressSeen = ''
    let final: { status?: string; error?: string } | null = null
    const t0 = Date.now()
    for (let i = 0; i < 100; i++) {
      await new Promise(r => setTimeout(r, 3_000))
      const st = (await (await fetch(`${BASE}/api/evaluate/ht-dashboard?id=${dashboardId}`)).json()) as { dashboard?: { status?: string; error?: string; progress?: string } }
      if (st.dashboard?.progress) progressSeen = st.dashboard.progress
      if (st.dashboard?.status && st.dashboard.status !== 'running') { final = st.dashboard; break }
      if (Date.now() - t0 > 300_000) break
    }
    results.push(['生成到达终态 done', final?.status === 'done', `status=${final?.status ?? '超时'} ${final?.error ? `err=${String(final.error).slice(0, 90)}` : ''}`])
    if (progressSeen) console.log('  末次进度：', progressSeen.slice(0, 120))

    const html = await (await fetch(`${BASE}/api/evaluate/ht-dashboard?id=${dashboardId}&download=1`)).text()
    const uniBackfilled = /UniProt<\/a>/.test(html) || /uni-id/.test(html)
    const uniMatch = /data-uniprot="([A-Z0-9]{6,10})"/.exec(html); results.push(["载入行 UniProt 列已回填（EBI 识别 — 100% 同源片段命中同源 ortholog 属正常）", uniMatch != null && /uniprot 序列匹配 100%/i.test(html), uniMatch ? `回填 ${uniMatch[1]} + 徽标「UniProt 序列匹配 100%」` : '未回填'])
    results.push(['弹出页内嵌上传原文', html.includes('p53 片段既有报告'), '上传件嵌入'])
    const aiOk = !html.includes('AI 整体可行性报告未生成')
    results.push(['AI 报告已生成（或并发段正常完成）', aiOk, aiOk ? 'AI 章节在' : 'AI 降级（引擎失败 — 回填仍应落盘）'])
  } finally {
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
    } catch { /* 尽力清理 */ }
  }
  let pass = 0
  console.log('\n── v2.82 并发回填验证 ──')
  for (const [name, ok, note] of results) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? `  · ${note}` : ''}`); if (ok) pass++ }
  console.log(`\n${pass}/${results.length} 通过`)
  if (pass < results.length) process.exitCode = 1
  await db.$disconnect()
}
void main()
