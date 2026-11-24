/**
 * test-content-retention.ts — v2.83 内容寻址留存服务端验证。
 *
 * 覆盖（全部走真实 HTTP 端点 + 真实 DB/磁盘）：
 *  1. POST 上传 → contentSha 落库 + 文件落盘
 *  2. POST 同内容再传 → 去重回既有 id（deduped）
 *  3. GET ?shas= → retained 映射 + missing 清单
 *  4. GET ?ids=（v2.81 兼容形态不回归）
 *  5. 汇总生成 sha 兜底：imported 项带「死亡 reportId + 有效 sourceSha」→
 *     弹出页原封内嵌原文（多键解析 + 路径去重预算）
 *
 * 运行：bunx bun scripts/test-content-retention.ts（dev server :3000 需就绪）
 */
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { PrismaClient } from '@prisma/client'

const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:3000'
const db = new PrismaClient()

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf-8').digest('hex').slice(0, 32)

// 伪造报告（真实结构最小版 — 含统计证据 h1 + 序列长度行，供补解析路径）
const mkReport = (acc: string, marker: string) => `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>靶点结构解析可行性评估报告 — TEST ${acc}</title>
<meta name="targeteval:target" content="{&quot;uniprot&quot;:&quot;${acc}&quot;,&quot;range&quot;:[10,200],&quot;seqLength&quot;:191,&quot;seqSha&quot;:&quot;${sha256(acc).slice(0, 16)}&quot;}">
</head><body><div class="page">
<h1 class="rpt-title">test protein（${acc} · 残基 10-200）</h1>
<!-- CONTENT-MARKER-${marker} -->
<div class="glance"><span>总分 6</span><span>X-ray 2 · Cryo-EM 1 · NMR 0</span><span>直接结构 3</span><span>覆盖 82%</span></div>
</div></body></html>`

async function main() {
  const cookie = 'te_owner=testcontentretention' + Math.random().toString(36).slice(2, 10)
  const H = { 'Content-Type': 'application/json', cookie }
  const cleanup: string[] = []

  try {
    // ── 1. 上传 → contentSha 落库 ──
    const htmlA = mkReport('P99001', 'AAA')
    const shaA = sha256(htmlA)
    const up1 = await fetch(`${BASE}/api/evaluate/ht-imported-report`, {
      method: 'POST', headers: H, body: JSON.stringify({ fileName: '测试报告A.html', html: htmlA }),
    }).then(r => r.json() as Promise<{ ok: boolean; id?: string; deduped?: boolean }>)
    ok('① 上传成功返回 id', up1.ok === true && typeof up1.id === 'string' && up1.deduped !== true, JSON.stringify(up1))
    const idA = up1.id!
    cleanup.push(idA)

    const rec = await db.importedReport.findUnique({ where: { id: idA } })
    ok('① contentSha 落库（= 客户端可计算的 sha256 前 32 hex）', rec?.contentSha === shaA, `${rec?.contentSha} vs ${shaA}`)
    ok('① 文件落盘', rec?.htmlPath != null && rec.htmlPath.length > 0 && await fs.access(rec.htmlPath!).then(() => true, () => false))

    // ── 2. 同内容再传 → 去重 ──
    const up2 = await fetch(`${BASE}/api/evaluate/ht-imported-report`, {
      method: 'POST', headers: H, body: JSON.stringify({ fileName: '重复报告.html', html: htmlA }),
    }).then(r => r.json() as Promise<{ ok: boolean; id?: string; deduped?: boolean }>)
    ok('② 同内容去重回既有 id（deduped）', up2.ok === true && up2.id === idA && up2.deduped === true, JSON.stringify(up2))
    const cntSame = await db.importedReport.count({ where: { contentSha: shaA } })
    ok('② 无重复记录（同内容仅 1 条）', cntSame === 1, `count=${cntSame}`)

    // ── 3. GET ?shas= 批量校验 ──
    const htmlB = mkReport('P99002', 'BBB')
    const shaB = sha256(htmlB)
    const fakeSha = sha256('not-uploaded-content')
    const ver = await fetch(`${BASE}/api/evaluate/ht-imported-report?shas=${[shaA, shaB, fakeSha].join(',')}`, {
      headers: { cookie },
    }).then(r => r.json() as Promise<{ ok: boolean; retained?: Record<string, string>; missing?: string[] }>)
    ok('③ shas 校验：已留存命中（retained[shaA]=idA）', ver.ok === true && ver.retained?.[shaA] === idA, JSON.stringify(ver).slice(0, 160))
    ok('③ shas 校验：未上传的进 missing', Array.isArray(ver.missing) && ver.missing.includes(shaB) && ver.missing.includes(fakeSha))

    // ── 3b. 他人内容不串（换 cookie 校验 — owner 隔离） ──
    const otherCookie = 'te_owner=otheruser' + Math.random().toString(36).slice(2, 10)
    const verOther = await fetch(`${BASE}/api/evaluate/ht-imported-report?shas=${shaA}`, {
      headers: { cookie: otherCookie },
    }).then(r => r.json() as Promise<{ ok: boolean; retained?: Record<string, string>; missing?: string[] }>)
    ok('③ 他人 sha 校验不串档（owner 隔离）', verOther.ok === true && verOther.retained?.[shaA] === undefined && verOther.missing?.includes(shaA) === true)

    // ── 4. GET ?ids= 兼容形态 ──
    const verIds = await fetch(`${BASE}/api/evaluate/ht-imported-report?ids=${idA}`, {
      headers: { cookie },
    }).then(r => r.json() as Promise<{ ok: boolean; missing?: string[] }>)
    ok('④ ids 校验兼容（存活 id 不在 missing）', verIds.ok === true && !(verIds.missing ?? []).includes(idA))

    // ── 5. 汇总生成 sha 兜底：上传 B 后，用「死亡 reportId + 有效 sourceSha」生成 ──
    const upB = await fetch(`${BASE}/api/evaluate/ht-imported-report`, {
      method: 'POST', headers: H, body: JSON.stringify({ fileName: '测试报告B.html', html: htmlB }),
    }).then(r => r.json() as Promise<{ ok: boolean; id?: string }>)
    cleanup.push(upB.id ?? '')
    const deadReportId = 'cmdeadreportid0000000000' // 20 字符伪 id — DB 无此记录
    const dashPost = await fetch(`${BASE}/api/evaluate/ht-dashboard`, {
      method: 'POST', headers: H,
      body: JSON.stringify({
        goal: 'v2.83 内容寻址留存验证',
        imported: [
          // A：reportId 死亡 + sha 有效 → 兜底内嵌
          { label: 'P99001 · 残基 10-200', reportId: deadReportId, sourceSha: shaA, fileName: '测试报告A.html' },
          // B：reportId 死亡 + sha 有效 → 兜底内嵌
          { label: 'P99002 · 残基 10-200', reportId: deadReportId, sourceSha: shaB, fileName: '测试报告B.html' },
        ],
        llm: { providerKey: 'zai' },
      }),
    }).then(r => r.json() as Promise<{ ok: boolean; dashboard?: { id?: string; status?: string }; error?: string }>)
    ok('⑤ 看板生成受理（纯导入运行）', dashPost.ok === true && typeof dashPost.dashboard?.id === 'string', JSON.stringify(dashPost).slice(0, 160))
    if (dashPost.dashboard?.id) {
      const dashId = dashPost.dashboard.id
      cleanup.push(dashId)
      let status = ''
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 2000))
        const st = await fetch(`${BASE}/api/evaluate/ht-dashboard?id=${dashId}`, { headers: { cookie } })
          .then(r => r.json() as Promise<{ dashboard?: { status?: string }; status?: string }>)
        status = st.dashboard?.status ?? st.status ?? ''
        if (status !== 'running') break
      }
      ok('⑤ 看板生成完成', status === 'done', `status=${status}`)
      const html = await fetch(`${BASE}/api/evaluate/ht-dashboard?id=${dashId}&download=1`, { headers: { cookie } }).then(r => r.text())
      ok('⑤ 弹出页原封内嵌 A（CONTENT-MARKER-AAA 在载荷中）', html.includes('CONTENT-MARKER-AAA'))
      ok('⑤ 弹出页原封内嵌 B（CONTENT-MARKER-BBB 在载荷中）', html.includes('CONTENT-MARKER-BBB'))
      ok('⑤ 无「原文未能内嵌」降级说明', !html.includes('原文未能内嵌'))
      const loadNote = html.match(/载入说明：[^<]{0,220}/)?.[0] ?? ''
      ok('⑤ 载人说明指向内嵌弹出页（完整统计行或降级行口径）', loadNote.includes('内嵌导入的报告原文') || loadNote.includes('「完整报告」弹出页'), loadNote.slice(0, 160))
    }
  } finally {
    // 清理：删除本次测试的留存记录/文件/看板
    for (const id of cleanup) {
      if (!id) continue
      const rec = await db.importedReport.findUnique({ where: { id } }).catch(() => null)
      if (rec?.htmlPath) await fs.unlink(rec.htmlPath).catch(() => undefined)
      await db.importedReport.deleteMany({ where: { id } }).catch(() => undefined)
      await db.htDashboard.deleteMany({ where: { id } }).catch(() => undefined)
    }
    await db.$disconnect()
  }
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail > 0 ? 1 : 0)
}

void main()
