/**
 * v2.79 服务端僵死检测端到端验证脚本。
 *
 * 验证目标（对应用户实测「10 分钟无进展」的两条残留通路）：
 *  1. 僵死 running 记录（updatedAt 停滞 >90s）→ GET 单查应立即返回 error 终态
 *     「生成中断：…」+ v 版本字段，且落库（第二次 GET 仍为 error — 证明非内存态）；
 *  2. 正常 fresh running 记录 → GET 返回 running（不误报）；
 *  3. GET 响应携带 v: APP_VERSION（服务端版本自标注 — 前端错误文案 verTag 数据源）。
 *
 * 用法：bun scripts/test-ht-stall-detect.ts（需 dev server 运行在 3000 端口）
 */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()
const BASE = 'http://localhost:3000'

async function main() {
  const results: Array<[string, boolean, string]> = []

  // ── 场景 1：僵死 running 记录（updatedAt = 3 分钟前）──
  const staleId = `stalltest${Date.now().toString(36)}aaaaaaaaaaaaa`.slice(0, 25)
  const threeMinAgo = new Date(Date.now() - 3 * 60_000)
  await db.$executeRawUnsafe(
    `INSERT INTO "HtDashboard" ("id", "jobIds", "status", "ownerKey", "createdAt", "updatedAt")
     VALUES ($1, '[]', 'running', NULL, $2, $2)`,
    staleId, threeMinAgo,
  )

  const r1 = await fetch(`${BASE}/api/evaluate/ht-dashboard?id=${staleId}`)
  const d1 = (await r1.json()) as { ok?: boolean; v?: string; dashboard?: { status?: string; error?: string } }
  results.push([
    '僵死记录 GET #1 → error 终态「生成中断」',
    d1.dashboard?.status === 'error' && (d1.dashboard.error ?? '').startsWith('生成中断：'),
    JSON.stringify(d1).slice(0, 200),
  ])
  results.push([
    'GET #1 响应携带 v 版本字段',
    typeof d1.v === 'string' && d1.v.length > 0,
    `v=${d1.v ?? '(缺失)'}`,
  ])

  // 落库验证：第二次 GET 仍为 error（且 DB 行状态确为 error — 非内存态）
  const row = await db.htDashboard.findUnique({ where: { id: staleId } })
  results.push([
    '僵死标记已落库（DB 行 status=error）',
    row?.status === 'error' && (row.error ?? '').startsWith('生成中断：'),
    `db status=${row?.status}`,
  ])
  const r2 = await fetch(`${BASE}/api/evaluate/ht-dashboard?id=${staleId}`)
  const d2 = (await r2.json()) as { dashboard?: { status?: string } }
  results.push(['僵死记录 GET #2 → 仍为 error（落库持久）', d2.dashboard?.status === 'error', `status=${d2.dashboard?.status}`])

  // ── 场景 2：fresh running 记录（updatedAt = 现在）→ 不误报 ──
  const freshId = `stalltest${Date.now().toString(36)}bbbbbbbbbbbbb`.slice(0, 25)
  await db.$executeRawUnsafe(
    `INSERT INTO "HtDashboard" ("id", "jobIds", "status", "ownerKey", "createdAt", "updatedAt")
     VALUES ($1, '[]', 'running', NULL, $2, $2)`,
    freshId, new Date(),
  )
  const r3 = await fetch(`${BASE}/api/evaluate/ht-dashboard?id=${freshId}`)
  const d3 = (await r3.json()) as { dashboard?: { status?: string; progress?: string } }
  results.push([
    'fresh running 记录 GET → running（不误报僵死）',
    d3.dashboard?.status === 'running',
    `status=${d3.dashboard?.status}`,
  ])

  // ── 清理测试数据 ──
  await db.htDashboard.deleteMany({ where: { id: { in: [staleId, freshId] } } })

  // ── 汇总 ──
  let pass = 0
  for (const [name, ok, detail] of results) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  【${detail}】`}`)
    if (ok) pass++
  }
  console.log(`\n${pass}/${results.length} 项通过`)
  if (pass < results.length) process.exit(1)
  await db.$disconnect()
}

main().catch(async err => {
  console.error('测试脚本异常：', err)
  await db.$disconnect()
  process.exit(1)
})
