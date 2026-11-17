#!/usr/bin/env node
/**
 * regress-ht-excel.mjs — v2.23 高通量评估「Excel 导入」回归。
 *
 * A. 规则提取（quick=1，确定性）：
 *    A1 纵向组号列（同值行合并一组）  A2 横向复合物表（同行多靶点 = 一组）
 *    A3 无表头单列（逐行成组）        A4 CSV 单元格多 ID（P04637/P00533）
 *    A5 跨组去重（重复 accession 剔除）A6 .xls（BIFF8 旧格式）读通
 *    A7 meta 元数据（文件名/sheet/行数）
 * B. 入口防线：缺 file 字段（400）/ 非法扩展 .txt（422）/ 空表（422）/ 乱码内容（不 5xx）
 * C. LLM 失败回退：假 DeepSeek Key（HTTP 401）→ llmChat 判失败 → 规则兜底出正确分组
 *
 * 运行：node scripts/regress-ht-excel.mjs（优先复用常驻 dev server :3000；
 * Next 16 同目录锁禁止第二实例，仅在 :3000 不可用时按 HT_REGRESS_PORT 自启，退出即回收）
 */
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const XLSX = require_('xlsx')

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// ─── dev server：优先复用常驻 :3000（Next 16 同目录锁禁止第二实例）；不可用才自启 ────
const PORT = Number(process.env.HT_REGRESS_PORT ?? 3000)
const ROOT = new URL('..', import.meta.url).pathname
const LOG = '/tmp/regress-ht-excel-dev.log'
const base = `http://127.0.0.1:${PORT}`

let proc = null
const killServer = () => {
  if (!proc) return
  try { process.kill(-proc.pid, 'SIGTERM') } catch { /* already gone */ }
  try { proc.kill('SIGTERM') } catch { /* already gone */ }
  try { spawn('pkill', ['-f', `next dev -p ${PORT}`]) } catch { /* best-effort */ }
}
process.on('exit', killServer)

const probe = async () => {
  try {
    const r = await fetch(`${base}/api/llm/config`, { signal: AbortSignal.timeout(3000) })
    return r.ok
  } catch { return false }
}

let ready = false
if (await probe()) {
  ready = true
  console.log(`  复用常驻 dev server（:${PORT}）`)
} else {
  proc = spawn('npx', ['next', 'dev', '-p', String(PORT)], {
    cwd: ROOT,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  const logStream = fs.createWriteStream(LOG, { flags: 'w' })
  proc.stdout.pipe(logStream)
  proc.stderr.pipe(logStream)
  for (let i = 0; i < 150; i++) {
    if (await probe()) { ready = true; break }
    await new Promise(r => setTimeout(r, 1000))
  }
  if (!ready) {
    console.log(`✗ dev server 未就绪（150s）— 日志：${LOG}`)
    killServer()
    process.exit(1)
  }
  console.log(`  dev server 就绪（:${PORT}）`)
}

// ─── 工具 ──────────────────────────────────────────────────────────────────
const buildXlsx = (rows, name = '靶点表', bookType = 'xlsx') => {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name)
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType }))
}

const postExcel = async (buf, fileName, extra = {}) => {
  const fd = new FormData()
  if (buf != null) fd.append('file', new File([buf], fileName, { type: 'application/octet-stream' }))
  for (const [k, v] of Object.entries(extra)) fd.append(k, v)
  const res = await fetch(`${base}/api/evaluate/ht-extract`, {
    method: 'POST',
    body: fd,
    signal: AbortSignal.timeout(90_000),
  })
  return { status: res.status, data: await res.json().catch(() => ({})) }
}

const sameGroups = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ─── A. 规则提取（quick=1 确定性路径）──────────────────────────────────────
console.log('── A. 规则提取（quick=1）──')

const verticalRows = [
  ['组号', 'UniProt ID', '蛋白名称'],
  ['1', 'P04637', 'TP53'],
  ['1', 'P00533', 'EGFR'],
  ['2', 'O14746', 'PDPK1'],
]
{
  const r = await postExcel(buildXlsx(verticalRows), 'vertical.xlsx', { quick: '1' })
  ok('A1 纵向组号列：同值行合并一组',
    r.status === 200 && r.data.ok === true && sameGroups(r.data.groups, [['P04637', 'P00533'], ['O14746']]) && r.data.source === 'regex',
    JSON.stringify(r.data))
}

{
  const rows = [
    ['复合物', '靶点1', '靶点2'],
    ['CX1', 'P04637', 'P00533'],
    ['CX2', 'Q14296', ''],
  ]
  const r = await postExcel(buildXlsx(rows), 'complex.xlsx', { quick: '1' })
  ok('A2 横向复合物表：同行多靶点 = 一组',
    r.status === 200 && sameGroups(r.data.groups, [['P04637', 'P00533'], ['Q14296']]),
    JSON.stringify(r.data))
}

{
  const r = await postExcel(buildXlsx([['P04637'], ['P00533'], ['O14746']]), 'noheader.xlsx', { quick: '1' })
  ok('A3 无表头单列：逐行成组（各单靶点独立评估）',
    r.status === 200 && sameGroups(r.data.groups, [['P04637'], ['P00533'], ['O14746']]),
    JSON.stringify(r.data))
}

{
  const csv = Buffer.from('UniProt ID\nP04637/P00533\nO14746\nA0A8G0KJC2\n', 'utf-8')
  const r = await postExcel(csv, 'targets.csv', { quick: '1' })
  ok('A4 CSV 单元格多 ID：P04637/P00533 拆为同组（含 10 位 accession）',
    r.status === 200 && sameGroups(r.data.groups, [['P04637', 'P00533'], ['O14746'], ['A0A8G0KJC2']]),
    JSON.stringify(r.data))
}

{
  const rows = [
    ['组号', 'UniProt ID'],
    ['1', 'P04637'],
    ['2', 'P04637'],
    ['2', 'O14746'],
  ]
  const r = await postExcel(buildXlsx(rows), 'dup.xlsx', { quick: '1' })
  ok('A5 跨组去重：重复 accession 仅保留首次出现',
    r.status === 200 && sameGroups(r.data.groups, [['P04637'], ['O14746']]),
    JSON.stringify(r.data))
}

{
  const r = await postExcel(buildXlsx(verticalRows, '靶点表', 'biff8'), 'legacy.xls', { quick: '1' })
  ok('A6 .xls（BIFF8 旧格式）读通',
    r.status === 200 && sameGroups(r.data.groups, [['P04637', 'P00533'], ['O14746']]),
    JSON.stringify(r.data))
}

{
  const r = await postExcel(buildXlsx(verticalRows), 'meta.xlsx', { quick: '1' })
  ok('A7 meta 元数据（文件名/sheet 数/行数）',
    r.status === 200 && r.data.meta?.fileName === 'meta.xlsx' && r.data.meta?.sheets === 1 && r.data.meta?.rows === 4,
    JSON.stringify(r.data.meta))
}

// ─── B. 入口防线 ────────────────────────────────────────────────────────────
console.log('── B. 入口防线 ──')

{
  const fd = new FormData()
  const res = await fetch(`${base}/api/evaluate/ht-extract`, { method: 'POST', body: fd })
  const data = await res.json().catch(() => ({}))
  ok('B1 缺 file 字段 → 400',
    res.status === 400 && /缺少 Excel 文件/.test(data.error ?? ''), JSON.stringify(data))
}

{
  const r = await postExcel(Buffer.from('hello', 'utf-8'), 'readme.txt', { quick: '1' })
  ok('B2 非法扩展 .txt → 422',
    r.status === 422 && /\.xlsx/.test(r.data.error ?? ''), JSON.stringify(r.data))
}

{
  const r = await postExcel(buildXlsx([[''], [''], ['']], '空表'), 'empty.xlsx', { quick: '1' })
  ok('B3 空表（无非空行）→ 422',
    r.status === 422 && /表格内容为空/.test(r.data.error ?? ''), JSON.stringify(r.data))
}

{
  const garbage = Buffer.from([...Array(2048)].map(() => Math.floor(Math.random() * 256)))
  const r = await postExcel(garbage, 'corrupted.xlsx', { quick: '1' })
  ok('B4 乱码内容 → 不 5xx（422 或空分组均可，绝不 Internal Server Error）',
    r.status < 500 && (r.status === 422 || (r.data.ok === true && (r.data.groups ?? []).length === 0)),
    `status=${r.status}`)
}

// ─── C. LLM 失败回退（假 Key → 401 → 规则兜底）──────────────────────────────
console.log('── C. LLM 失败回退 ──')

{
  const llm = JSON.stringify({ providerKey: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-dummy-regress-not-a-real-key', model: 'deepseek-chat' })
  const r = await postExcel(buildXlsx(verticalRows), 'llm-fallback.xlsx', { llm })
  ok('C1 假 DeepSeek Key（401）→ 静默回退规则提取，分组正确',
    r.status === 200 && r.data.ok === true && r.data.source === 'regex' && sameGroups(r.data.groups, [['P04637', 'P00533'], ['O14746']]),
    JSON.stringify(r.data).slice(0, 300))
}

// ─── 收尾 ────────────────────────────────────────────────────────────────────
console.log(`\n${pass} 通过 · ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
