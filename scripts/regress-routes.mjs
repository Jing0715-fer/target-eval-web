#!/usr/bin/env node
/**
 * regress-routes.mjs — 客户端 API 引用 ↔ 服务端路由存在性守卫（v2.23.2）
 *
 * 背景：历史上有过「误提交删除整组路由文件」的事故（acfeb3f 删除 upload/* 五个路由，
 * 前端 upload/init 直接 404，用户表现为「上传初始化失败 HTTP 404 / 上传后无法开始评估」）。
 * 本脚本静态扫描 src/ 下所有客户端源码中的 /api/ 引用（fetch / img src / 文案内路径），
 * 逐条映射到 src/app/api 的 route.ts，任何引用找不到对应路由即 FAIL；
 * 并对关键上传入口做运行时探活（复用常驻 dev server:3000，与 regress-ht-excel.mjs 同约定）。
 *
 * 运行：node scripts/regress-routes.mjs          （dev server 已在 3000 运行）
 *       HT_REGRESS_PORT=3100 node scripts/regress-routes.mjs（自启临时实例）
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : ` — ${detail}`}`)
  cond ? pass++ : fail++
}

// ── 1. dev server 探活（复用或自启，同 regress-ht-excel.mjs 约定） ──────────
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
  const log = fs.createWriteStream('/tmp/regress-routes-dev.log', { flags: 'w' })
  spawned.stdout.pipe(log); spawned.stderr.pipe(log)
  for (let i = 0; i < 150; i++) {
    if (await probe()) break
    await new Promise(r => setTimeout(r, 1000))
  }
}
ok('dev server 就绪', await probe())

// ── 2. 静态扫描：客户端 /api/ 引用 → route.ts 存在性 ─────────────────────────
const SRC = path.join(ROOT, 'src')
const files = []
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) walk(path.join(dir, e.name))
    else if (/\.(ts|tsx)$/.test(e.name)) files.push(path.join(dir, e.name))
  }
}
walk(path.join(SRC, 'components'))
walk(path.join(SRC, 'app'))

/** 提取 /api/ 路径（ASCII 路径字符白名单；${…} 与未闭合模板归一为 * 段；跳过纯注释行 — 注释中的散文提及不算 API 引用） */
const API_RE = /\/api\/[A-Za-z0-9\-._/{$}]+/g
const isCommentOnly = (l) => {
  const t = l.trim()
  return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('{/*')
}
const endpoints = new Map() // path → [file:line]
for (const f of files) {
  const text = fs.readFileSync(f, 'utf-8')
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    if (isCommentOnly(line)) return
    for (const m of line.matchAll(API_RE)) {
      let p = m[0].split('?')[0] // 截断查询串
        .replace(/\$\{[^}]*\}/g, '*') // 完整模板插值段
        .replace(/\$\{[^}]*$/, '*') // 被分隔符截断的未闭合模板段
      p = p.replace(/\/+$/, '') || p
      if (!endpoints.has(p)) endpoints.set(p, [])
      endpoints.get(p).push(`${path.relative(ROOT, f)}:${i + 1}`)
    }
  })
}

/** /api/a/b/* → src/app/api/a/b/[…]/route.ts 存在性 */
const routeFileFor = (apiPath) => {
  const segs = apiPath.replace(/^\//, '').split('/').filter(Boolean)
  let cur = path.join(SRC, 'app')
  for (let s = 0; s < segs.length; s++) {
    const seg = segs[s]
    const isLast = s === segs.length - 1
    if (seg === '*') {
      const dyn = fs.readdirSync(cur, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name.startsWith('['))
      if (!dyn.length) return null
      cur = path.join(cur, dyn[0].name)
      continue
    }
    const next = path.join(cur, seg)
    if (fs.existsSync(next) && fs.statSync(next).isDirectory()) { cur = next; continue }
    // 非目录：只可能是最后一段的 route.ts（不适用 —— API 路径最后一段是路由名本身）
    return null
  }
  return fs.existsSync(path.join(cur, 'route.ts')) ? path.join(cur, 'route.ts') : null
}

console.log(`\n── A. 静态守卫：${endpoints.size} 个客户端 /api/ 引用 ↔ route.ts ──`)
const missing = []
for (const [p, refs] of [...endpoints.entries()].sort()) {
  const rf = routeFileFor(p)
  if (!rf) missing.push(`${p} ← ${refs.slice(0, 3).join(' ')}`)
}
ok(`全部 ${endpoints.size} 个客户端 API 引用均有对应 route.ts`, missing.length === 0,
  missing.join('\n  '))

// ── 3. 关键路由运行时探活（404 守卫） ────────────────────────────────────────
console.log('\n── B. 运行时探活（复用 dev server）──')
{
  const r = await fetch(`${base}/api/evaluate/upload/init`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'probe.docx', size: 1024 }),
    signal: AbortSignal.timeout(15000),
  })
  ok('POST /api/evaluate/upload/init 非 404（分块上传入口存活）', r.status !== 404, `HTTP ${r.status}`)
  const data = await r.json().catch(() => null)
  ok('init 返回 uploadId', r.ok && typeof data?.uploadId === 'string', JSON.stringify(data))
}
{
  const r = await fetch(`${base}/api/evaluate/upload?stateless=1&noVlm=1`, {
    method: 'POST',
    signal: AbortSignal.timeout(15000),
  })
  // 缺 file 字段 → 400；路由存在（404 才是回归）
  ok('POST /api/evaluate/upload（无状态直传通道）非 404', r.status !== 404, `HTTP ${r.status}`)
  await r.body?.cancel?.()
}
for (const ep of ['/api/llm/config', '/api/jobs']) {
  const r = await fetch(`${base}${ep}`, { signal: AbortSignal.timeout(10000) })
  ok(`GET ${ep} 非 404`, r.status !== 404, `HTTP ${r.status}`)
  await r.body?.cancel?.()
}
// v2.28 统计看板路由探活（缺条目 → 400；路由不存在才是回归）
{
  const r = await fetch(`${base}/api/evaluate/ht-dashboard`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: [] }),
    signal: AbortSignal.timeout(15000),
  })
  ok('POST /api/evaluate/ht-dashboard 非 404（统计看板生成入口存活）', r.status !== 404, `HTTP ${r.status}`)
  await r.body?.cancel?.()
}
{
  const r = await fetch(`${base}/api/evaluate/ht-dashboard`, { signal: AbortSignal.timeout(10000) })
  ok('GET /api/evaluate/ht-dashboard（看板列表入口）非 404', r.status !== 404, `HTTP ${r.status}`)
  await r.body?.cancel?.()
}

// ── 4. 收尾 ─────────────────────────────────────────────────────────────────
if (spawned) {
  try { process.kill(-spawned.pid, 'SIGTERM') } catch { /* 已退出 */ }
}
console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILED'} — ${pass} pass / ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)
