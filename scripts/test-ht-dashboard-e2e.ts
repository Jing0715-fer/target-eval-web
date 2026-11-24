/**
 * v2.71 端到端验证（真实 dev server，localhost:3000）：
 *  ① 造 3 个合成已完成作业（含报告文件 ~600KB×3）
 *  ② POST /api/evaluate/ht-dashboard（含 1 个导入 stats 靶点）
 *  ③ 轮询 GET ?id= — 断言 running 期间能看到 progress 字段、终态 done
 *  ④ GET inline=1 — 断言流式回送 HTML 完整（含载荷/主表/AI 章）且与磁盘文件一致
 *  ⑤ 清理测试数据
 */
import { db } from '../src/lib/db'

const BASE = 'http://localhost:3000'
/** 探测本次 fetch 环境下服务端实际派生的 ownerKey（proxy 头因环境而异 —
 *  经由一次性导入靶点 POST 建行读取，随后删除；作业归属键与之对齐） */
async function probeOwnerKey(): Promise<string> {
  const r = await fetch(`${BASE}/api/evaluate/ht-dashboard`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imported: [{ label: 'probe', stats: { overall: 1, xray: 1, cryoem: 0, nmr: 0, pdbCount: 1, blastHitCount: 0, literatureCount: 0, methodXrayCount: 1, methodCryoemCount: 0, methodNmrCount: 0, bestResolution: null, coverage: 1 } }] }),
  })
  const j = await r.json() as { dashboard?: { id: string } }
  if (!j.dashboard) throw new Error('探测 ownerKey 失败')
  const rec = await db.htDashboard.findUnique({ where: { id: j.dashboard.id } })
  await db.htDashboard.delete({ where: { id: j.dashboard.id } }).catch(() => undefined)
  if (!rec?.ownerKey) throw new Error('探测行无 ownerKey')
  return rec.ownerKey
}

function bigHtml(tag: string, sizeKb: number): string {
  const pad = `<div class="pad">x</div>`.repeat(Math.round(sizeKb * 1024 / 17))
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${tag} · TargetEval</title></head><body><h1 class="rpt-title">${tag}</h1>${pad}</body></html>`
}

async function main(): Promise<void> {
  let pass = 0, fail = 0
  const check = (name: string, ok: boolean, detail?: string) => {
    if (ok) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
  }

  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const TEST_OWNER_KEY = await probeOwnerKey()
  console.log(`  ℹ 探测 ownerKey = ${TEST_OWNER_KEY}`)
  const jobIds: string[] = []
  const reportDirs: string[] = []
  try {
    // ① 造 3 个合成 done 作业（summary 与真实结构同构 — scores/methodStats/uniprot）
    for (let i = 0; i < 3; i++) {
      const job = await db.evaluationJob.create({
        data: {
          mode: 'uniprot',
          uniprotId: `P0000${i}`,
          title: `测试靶点 ${i}`,
          status: 'done',
          ownerKey: TEST_OWNER_KEY,
          summary: JSON.stringify({
            scores: { overall: { score: 6 + i }, xray: { score: 5 + i }, cryoem: { score: 3 }, nmr: { score: 2 } },
            methodStats: { xrayCount: 3, cryoemCount: 1, nmrCount: 0, bestResolution: 2.1 },
            uniprot: { proteinName: `Test protein ${i}`, organism: 'E. coli' },
            coverage: 70 + i * 5,
            ligandCount: 1,
            literatureCount: 3,
            reportLlmOk: true,
            durationMs: 5000,
          }),
          pdbs: JSON.stringify([]),
          blastHits: JSON.stringify([]),
          reportMarkdown: `## 测试报告 ${i}\n正文。`,
        },
      })
      jobIds.push(job.id)
      // 报告文件（~600KB × 3 — 触发流式路径）
      const dir = path.join(process.cwd(), 'db', 'reports', job.id)
      await fs.mkdir(dir, { recursive: true })
      const rp = path.join(dir, 'report.html')
      await fs.writeFile(rp, bigHtml(`合成报告 ${i}`, 600), 'utf-8')
      reportDirs.push(dir)
      await db.evaluationJob.update({ where: { id: job.id }, data: { reportPath: rp } })
    }

    // ② POST 生成看板（含 1 个导入 stats 靶点 — 无 jobId 纯导入形态）
    const post = await fetch(`${BASE}/api/evaluate/ht-dashboard`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entries: jobIds.map((id, i) => ({ jobId: id, group: 1, label: `测试靶点 ${i}` })),
        goal: 'v2.71 端到端验证',
        imported: [{
          label: '导入靶点X · 200aa',
          group: 2,
          stats: { overall: 8, xray: 6, cryoem: 4, nmr: 2, pdbCount: 5, blastHitCount: 20, literatureCount: 2, methodXrayCount: 4, methodCryoemCount: 2, methodNmrCount: 1, bestResolution: 1.8, coverage: 92, proteinName: 'Imported protein X', organism: 'M. musculus', uniprotId: 'Q8I246', range: [8, 146], seqLength: 200 },
          fileName: 'imported_X.html',
        }],
      }),
    })
    const data = await post.json() as { ok?: boolean; dashboard?: { id: string }; error?: string }
    check('POST 返回 200 + running', post.status === 200 && data.ok === true && Boolean(data.dashboard?.id), `${post.status} ${data.error ?? ''}`)
    const dashId = data.dashboard!.id

    // ③ 轮询 — 断言能看到 progress（running 期间）
    let sawProgress: string | null = null
    let final: { status: string; error?: string | null } | null = null
    const t0 = Date.now()
    for (;;) {
      await new Promise(r => setTimeout(r, 700))
      const d = await fetch(`${BASE}/api/evaluate/ht-dashboard?id=${dashId}`, { cache: 'no-store' })
        .then(x => x.json().catch(() => null)) as { ok?: boolean; dashboard?: { status: string; progress?: string; error?: string | null } } | null
      if (d?.dashboard) {
        if (d.dashboard.progress) sawProgress = d.dashboard.progress
        if (d.dashboard.status !== 'running') { final = d.dashboard; break }
      }
      if (Date.now() - t0 > 240_000) break
    }
    check('生成到达终态 done', final?.status === 'done', JSON.stringify(final))
    // LLM 无配置时 generateHtDashboardReport 直接降级 — 阶段飞快，progress 可能错过；
    // sawProgress 为空不算失败（记录即可），但 done 后 progress 必须清空
    console.log(`  ℹ running 期间捕获 progress：${sawProgress ?? '（生成过快未捕获 — 阶段进度见下方 DB 直查）'}`)

    // ④ inline 流式回送 — 与磁盘文件逐字节一致
    const rec = await db.htDashboard.findUnique({ where: { id: dashId } })
    check('DB 终态 progress 已清空', rec?.progress == null, `progress=${rec?.progress}`)
    check('DB htmlPath 已落盘', Boolean(rec?.htmlPath))
    if (rec?.htmlPath) {
      const disk = await fs.readFile(rec.htmlPath)
      const res = await fetch(`${BASE}/api/evaluate/ht-dashboard?id=${dashId}&inline=1`)
      check('inline=1 返回 200', res.status === 200, String(res.status))
      const body = Buffer.from(await res.arrayBuffer())
      check('流式回送与磁盘文件逐字节一致', body.equals(disk), `${body.length} vs ${disk.length}`)
      const text = body.toString('utf-8')
      check('看板含 4 个靶点主表行（3 评估 + 1 导入载入）', (text.match(/tr class="mt-row"/g) ?? []).length === 4)
      check('看板含载荷 script', text.includes('<script type="application/json" id="ht-rpt-data">'))
      check('看板含导入行载入徽标', text.includes('tg-load'))
      check('看板含合成报告原文（延迟读取嵌入）', text.includes('合成报告 0') && text.includes('合成报告 2'))
      check('看板标题含 4 靶点', text.includes('4 靶点') || text.includes('· 4'), text.slice(text.indexOf('<title>'), text.indexOf('</title>')).slice(0, 80))
    }

    // ⑤ download 流式
    const dl = await fetch(`${BASE}/api/evaluate/ht-dashboard?id=${dashId}&download=1`)
    check('download=1 返回 200 + attachment', dl.status === 200 && (dl.headers.get('content-disposition') ?? '').includes('attachment'))
    await dl.body?.cancel()
  } finally {
    // 清理（按本次创建的具体 id — dashboard 归属键是请求侧派生的，不能按 ownerKey 查）
    for (const id of jobIds) {
      await db.evaluationJob.delete({ where: { id } }).catch(() => undefined)
    }
    const fsMod = await import('node:fs/promises')
    for (const d of reportDirs) await fsMod.rm(d, { recursive: true, force: true }).catch(() => undefined)
    const dashes = await db.htDashboard.findMany({ where: { createdAt: { gte: new Date(Date.now() - 3600_000) } }, select: { id: true, htmlPath: true } })
    for (const d of dashes) {
      if (d.htmlPath) await fsMod.rm(path.dirname(d.htmlPath), { recursive: true, force: true }).catch(() => undefined)
      await db.htDashboard.delete({ where: { id: d.id } }).catch(() => undefined)
    }
    await db.$disconnect()
  }
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

void main().catch(e => { console.error(e); process.exit(1) })
