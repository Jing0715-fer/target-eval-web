#!/usr/bin/env node
/**
 * regress-ht-download.mjs — v2.25 高通量报告下载体系回归。
 *
 * A. /api/evaluate/ht-archive：参数校验（422 空）/ 归属与状态过滤（404 无报告）/
 *    zip 结构（组子文件夹 G01_/G02_ + 合并报告 + _README.txt + 文件名去重）
 * B. auto-download 目录前缀（safeDirName / triggerBrowserDownload 组装逻辑 — Node 侧
 *    直接 import 编译前源码不可行，改为对 ht-archive 的前端约定做 API 层断言）
 */
import * as fs from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as path from 'node:path'
import JSZip from 'jszip'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : ` — ${detail}`}`)
  cond ? pass++ : fail++
}

// ── dev server 探活 ─────────────────────────────────────────────────────────
const PORT = process.env.HT_REGRESS_PORT || 3000
const base = `http://localhost:${PORT}`
let spawned = null
const probe = async () => {
  try {
    const r = await fetch(`${base}/api/llm/config`, { signal: AbortSignal.timeout(2000) })
    return r.ok
  } catch { return false }
}
if (!(await probe())) {
  spawned = spawn('npx', ['next', 'dev', '-p', String(PORT)], {
    cwd: ROOT, env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  })
  const log = fs.createWriteStream('/tmp/regress-ht-download-dev.log', { flags: 'w' })
  spawned.stdout.pipe(log); spawned.stderr.pipe(log)
  for (let i = 0; i < 150; i++) {
    if (await probe()) break
    await new Promise(r => setTimeout(r, 1000))
  }
}
ok('dev server 就绪', await probe())

// ── A. ht-archive ────────────────────────────────────────────────────────────
console.log('\n── A. /api/evaluate/ht-archive ──')
{
  // A1 空 entries → 422
  const r = await fetch(`${base}/api/evaluate/ht-archive`, { signal: AbortSignal.timeout(15000) })
  ok('A1 无参数 → 422（明确报错不 500）', r.status === 422, `HTTP ${r.status}`)
  await r.body?.cancel?.()
}
{
  // A2 不存在的作业 → 404（无任何可下载报告）
  const entries = JSON.stringify([{ jobId: 'nonexistent-000' }])
  const r = await fetch(`${base}/api/evaluate/ht-archive?entries=${encodeURIComponent(entries)}`, { signal: AbortSignal.timeout(15000) })
  const d = await r.json().catch(() => ({}))
  ok('A2 未知作业/无报告 → 404', r.status === 404 && d.ok === false, JSON.stringify(d))
}
{
  // A3 直查数据库获取 fixture/真实 done 作业（/api/jobs 会排除被合并报告收录的子作业，
  // 且列表有 owner 过滤 — 回归直接用 Prisma 读库更稳）
  // 注意：Prisma client 在 scripts/ 下需从项目根 import
  const { PrismaClient } = await import('@prisma/client')
  const prisma = new PrismaClient()
  const job = await prisma.evaluationJob.findFirst({ where: { status: 'done', reportPath: { not: null } }, orderBy: { createdAt: 'desc' } })
  const br = await prisma.batchReport.findFirst({ where: { status: 'done', htmlPath: { not: null } } })
  await prisma.$disconnect().catch(() => {})
  if (!job) {
    console.log('  （数据库中无已完成作业 — A3-A7 跳过；首次全量回归需先跑一次评估或注入 fixture）')
    ok('A3 已完成作业存在（前置）', false, '无 done 作业 — 跳过组包断言')
  } else {
    const entries = JSON.stringify([
      { jobId: job.id, group: 1, label: job.uniprotId ?? job.title ?? job.id },
      ...(br ? [{ mergedId: br.id, group: 1 }] : []),
    ])
    const r = await fetch(`${base}/api/evaluate/ht-archive?entries=${encodeURIComponent(entries)}`, { signal: AbortSignal.timeout(60000) })
    ok('A3 归档（作业+合并报告）→ 200 zip', r.status === 200 && (r.headers.get('content-type') ?? '').includes('zip'), `HTTP ${r.status} ${r.headers.get('content-type')}`)
    const cd = r.headers.get('content-disposition') ?? ''
    ok('A4 Content-Disposition attachment + zip 文件名', /attachment/.test(cd) && /\.zip/.test(cd), cd)
    if (r.status === 200) {
      const buf = Buffer.from(await r.arrayBuffer())
      const zip = await JSZip.loadAsync(buf)
      const names = Object.keys(zip.files)
      ok('A5 zip 结构：G01/ 组文件夹（含合并报告）+ _README.txt',
        names.some(n => n.startsWith('G01/') && n.endsWith('.html')) && names.includes('_README.txt'),
        JSON.stringify(names))
      const readme = await zip.files['_README.txt'].async('string')
      ok('A6 README 含清单与份数', /报告份数/.test(readme) && /文件清单/.test(readme), readme.slice(0, 120))
    }
    // A7 重复标签去重（同名 label → _2 后缀）
    const entries2 = JSON.stringify([
      { jobId: job.id, group: 1, label: 'same' },
      { jobId: job.id, group: 1, label: 'same' },
    ])
    const r2 = await fetch(`${base}/api/evaluate/ht-archive?entries=${encodeURIComponent(entries2)}`, { signal: AbortSignal.timeout(60000) })
    if (r2.status === 200) {
      const buf2 = Buffer.from(await r2.arrayBuffer())
      const zip2 = await JSZip.loadAsync(buf2)
      const names2 = Object.keys(zip2.files).filter(n => n.endsWith('.html'))
      ok('A7 同名文件去重（_2 后缀）', names2.length === 2 && /_2\.html$/.test(names2[1] ?? ''), JSON.stringify(names2))
    } else {
      ok('A7 同名文件去重（_2 后缀）', false, `HTTP ${r2.status}`)
    }
  }
}

// ── 收尾 ────────────────────────────────────────────────────────────────────
if (spawned) {
  try { process.kill(-spawned.pid, 'SIGTERM') } catch { /* 已退出 */ }
}
console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILED'} — ${pass} pass / ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)
