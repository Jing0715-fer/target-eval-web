/**
 * v2.84 E2E 验证 — 用户真实文件全链路（导入解析 → 服务端留存 → 汇总生成 → 原文内嵌）。
 *
 * 用用户实际导入过的 G02 报告（Q8I246 · pfPheRS 链2 — v2.83 回归的 24 个靶点之一）
 * 走完整链路：
 *  1. 客户端解析器解析真实报告 → stats（v2.83 回归复现点：次链丢 stats）；
 *  2. 上传原文到服务端留存（POST ht-imported-report）→ reportId + contentSha；
 *  3. POST ht-dashboard（imported 载荷：stats + reportId + sourceSha）→ 轮询 done；
 *  4. 取回看板 HTML 验证：
 *     ① 该行 data-overall ≥ 0（完整统计行 — 非 bare 降级）；
 *     ② data-uniprot="Q8I246"（身份保留）；
 *     ③ 弹出页内嵌真实报告原文（h1 标记「phenylalanine--tRNA ligase」在场）；
 *     ④ 载入说明无「原文未能内嵌」对该行的降级。
 *
 * 用法：bun scripts/test-v284-real-file-e2e.ts（需 dev server 运行在 3000 端口）
 */
import * as fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { extractImportedStatsSections, toCleanImportedStats } from '../src/lib/eval/imported-stats'

const BASE = 'http://localhost:3000'
const REAL_FILE = '/home/z/my-project/upload/TargetEval_HT_2026-11-22_74g G02_TargetEval_Q8I246_2026-11-22.html'

async function main() {
  const results: Array<[string, boolean, string]> = []
  const t = (name: string, ok: boolean, detail?: string) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
    results.push([name, ok, detail ?? ''])
  }

  const html = await fs.readFile(REAL_FILE, 'utf-8')
  const sourceSha = createHash('sha256').update(html, 'utf-8').digest('hex').slice(0, 32)

  // ── 1. 客户端解析真实报告 ──
  const sections = extractImportedStatsSections(html)
  t('真实 G02 报告解析出 1 个区段', sections.length === 1, `sections=${sections.length}`)
  const stats = sections[0] ? toCleanImportedStats(sections[0]) : undefined
  t('解析出完整统计（overall=8 · Q8I246）', stats != null && stats.overall === 8 && stats.uniprotId === 'Q8I246',
    `overall=${stats?.overall ?? '无'} uniprot=${stats?.uniprotId ?? '无'}`)

  // ── 2. 上传原文留存（幂等 — 已存在则拿既有 id）──
  const upRes = await fetch(`${BASE}/api/evaluate/ht-imported-report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName: 'TargetEval_HT_2026-11-22_74g G02_TargetEval_Q8I246_2026-11-22.html', html }),
  })
  const up = (await upRes.json().catch(() => null)) as { ok?: boolean; id?: string } | null
  t('原文上传服务端留存成功', upRes.ok && up?.ok === true && typeof up?.id === 'string', `id=${up?.id?.slice(0, 12) ?? '无'}…`)
  const reportId = up?.id ?? ''

  // 幂等去重（同内容再传 → 同 id）
  const up2Res = await fetch(`${BASE}/api/evaluate/ht-imported-report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName: 'same.html', html }),
  })
  const up2 = (await up2Res.json().catch(() => null)) as { ok?: boolean; id?: string; deduped?: boolean } | null
  t('同内容二次上传幂等去重（同 id）', up2Res.ok && up2?.id === reportId, `deduped=${up2?.deduped} id=${up2?.id?.slice(0, 12)}`)

  // ── 3. 生成汇总报告（imported 载荷 — 对齐 finalizeHtDashboard 真实口径）──
  const label = 'pfPheRS_last_coot10_ph…ix12·链2 · 253aa'
  const createRes = await fetch(`${BASE}/api/evaluate/ht-dashboard`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      imported: [{
        label,
        group: 2,
        sequence: 'GIVEQCCTSICSLYQLENYCNFVNQHLCGSHLVEALYLVCGERGFFYTPKT'.repeat(5), // 245aa 占位（真实提交序列用户侧）
        fileName: 'TargetEval_HT_2026-11-22_74g G02_TargetEval_Q8I246_2026-11-22.html',
        reportId,
        sourceSha,
        range: [294, 451],
        stats,
      }],
    }),
  })
  const created = (await createRes.json().catch(() => null)) as { ok?: boolean; dashboard?: { id?: string } } | null
  t('看板创建成功', createRes.ok && created?.ok === true && typeof created?.dashboard?.id === 'string', `id=${created?.dashboard?.id?.slice(0, 12) ?? '无'}`)
  const dashId = created?.dashboard?.id ?? ''

  // 轮询至终态（≤120s — 真实生成含 AI 撰写，可能较慢；纯导入行通常秒级）
  let finalStatus = ''
  let dashHtml = ''
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 2000))
    const stRes = await fetch(`${BASE}/api/evaluate/ht-dashboard?id=${encodeURIComponent(dashId)}`)
    const st = (await stRes.json().catch(() => null)) as { dashboard?: { status?: string; error?: string; progress?: string } } | null
    finalStatus = st?.dashboard?.status ?? ''
    if (finalStatus === 'done' || finalStatus === 'error') {
      if (finalStatus === 'error') t('看板生成完成', false, `error=${st?.dashboard?.error ?? '?'}`)
      break
    }
    if (i % 5 === 4) console.log(`  …轮询中 status=${finalStatus} progress=${st?.dashboard?.progress?.slice(0, 40) ?? ''}`)
  }
  t('看板生成完成（done）', finalStatus === 'done', `status=${finalStatus}`)

  if (finalStatus === 'done') {
    const htmlRes = await fetch(`${BASE}/api/evaluate/ht-dashboard?id=${encodeURIComponent(dashId)}&download=1`)
    dashHtml = await htmlRes.text()

    // ── 4. 验证看板内容 ──
    const rowMatch = new RegExp(`<tr class="mt-row"[^>]*data-job="imp-1"[^>]*>`, 'g')
    const rows = [...dashHtml.matchAll(rowMatch)]
    const row = rows[0]?.[0] ?? ''
    t('主表行存在（imp-1 载入行）', rows.length >= 1, `rows=${rows.length}`)
    t('行内完整统计（data-overall ≥ 0 — 非 bare 降级）', /data-overall="(\d+)"/.test(row) && !/data-overall="-1"/.test(row),
      `overall=${/data-overall="(-?\d+)"/.exec(row)?.[1] ?? '?'}`)
    t('行内 UniProt 身份保留（data-uniprot="Q8I246"）', /data-uniprot="Q8I246"/.test(row))
    t('弹出页内嵌真实报告原文（h1「phenylalanine--tRNA ligase」在场）',
      dashHtml.includes('phenylalanine--tRNA ligase'),
      `嵌入 ${dashHtml.includes('phenylalanine--tRNA ligase') ? '✓' : '✗'}（看板 ${(dashHtml.length / 1024).toFixed(0)}KB）`)
    t('该行无「原文未能内嵌」降级（按钮 title 不含降级说明）',
      !row.includes('未能内嵌') && !dashHtml.includes('117 个的原文未能内嵌'),
      row.includes('未能内嵌') ? '行内仍降级' : '无降级')
    t('载入徽标在场（tg-load）', dashHtml.includes('tg-load'))
  }

  // ── 清理测试数据 ──
  try {
    const { PrismaClient } = await import('@prisma/client')
    const db = new PrismaClient()
    await db.htDashboard.deleteMany({ where: { id: dashId } })
    const recs = await db.importedReport.findMany({ where: { contentSha: sourceSha }, select: { htmlPath: true } })
    await db.importedReport.deleteMany({ where: { contentSha: sourceSha } })
    for (const r of recs) await fs.rm(r.htmlPath, { force: true }).catch(() => undefined)
    // 看板落盘文件
    for (const r of await db.htDashboard.findMany({ where: {}, select: { id: true, htmlPath: true } })) {
      if (r.htmlPath?.includes(dashId)) await fs.rm(r.htmlPath, { force: true }).catch(() => undefined)
    }
    await db.$disconnect()
    console.log('（测试数据已清理）')
  } catch (e) {
    console.log('（清理跳过：', e instanceof Error ? e.message : String(e), '）')
  }

  const fail = results.filter(([, ok]) => !ok).length
  console.log(`\n结果：${results.length - fail} PASS / ${fail} FAIL`)
  if (fail > 0) process.exit(1)
}

main().catch(err => {
  console.error('脚本异常：', err)
  process.exit(1)
})
