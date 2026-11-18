#!/usr/bin/env node
/**
 * regress-name-resolve.mjs — v2.24 非标准评估表兼容回归（靶点名称 → UniProt 解析）。
 *
 * 场景：评估表只有靶点名称（如 TL1A）而没有 UniProt ID / 序列 —— 旧版无法开始评估；
 * 现在 insights 智能解析提取 targetNames（LLM / 规则兜底）→ UniProt REST 解析为
 * accession → 前端注入 chips 并自动选中。
 *
 * 运行：node scripts/regress-name-resolve.mjs（复用 :3000 dev server，与 regress-ht-excel 同约定）
 */
import * as fs from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : ` — ${detail}`}`)
  cond ? pass++ : fail++
}

// ── dev server 探活（复用或自启） ──────────────────────────────────────────
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
  const log = fs.createWriteStream('/tmp/regress-name-resolve-dev.log', { flags: 'w' })
  spawned.stdout.pipe(log); spawned.stderr.pipe(log)
  for (let i = 0; i < 150; i++) {
    if (await probe()) break
    await new Promise(r => setTimeout(r, 1000))
  }
}
ok('dev server 就绪', await probe())

// ── 工具：insights NDJSON 流读取 ──────────────────────────────────────────
const postInsights = async (body, timeoutMs = 90_000) => {
  const res = await fetch(`${base}/api/evaluate/insights`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) return { http: res.status, data: null }
  // NDJSON 行流：读到 done 事件即返回（ping 心跳行忽略）
  const text = await res.text()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const obj = JSON.parse(line)
      if (obj.type === 'done') return { http: 200, data: obj }
    } catch { /* 忽略残行 */ }
  }
  return { http: 200, data: null }
}

const TL1A_TEXT = [
  '靶点结构解析可行性评估表（非标准表）',
  '一、评估靶点',
  '靶点名称：TL1A',
  '二、客户目标',
  '评估 TL1A 蛋白的可溶性表达与结构解析可行性，希望获得结晶与 Cryo-EM 方法对比建议。',
  '三、实验数据',
  '大肠杆菌表达系统，Ni 柱纯化后纯度约 85%，SDS-PAGE 主带位置正确，SEC 有聚集峰。',
].join('\n')

// ── A. 规则兜底路径（quick=1：无 LLM，规则提取名称 + UniProt REST 解析） ──────
console.log('\n── A. 规则路径（quick=1）──')
{
  const r = await postInsights({ text: TL1A_TEXT, goalHints: [], resolveNames: true, quick: true })
  const ins = r.data?.insights
  ok('A1 返回 insights（规则）', ins != null && ins.source === 'regex', JSON.stringify(r.data)?.slice(0, 300))
  ok('A2 规则提取 targetNames 含 TL1A', Array.isArray(ins?.targetNames) && ins.targetNames.includes('TL1A'),
    JSON.stringify(ins?.targetNames))
  const hit = ins?.resolvedUniprots?.find(x => x.name.toUpperCase() === 'TL1A')
  ok('A3 TL1A → O95150（TNFSF15 · 人源 · Swiss-Prot）',
    hit != null && hit.accession === 'O95150' && hit.reviewed === true && /Homo sapiens/i.test(hit.organism ?? ''),
    JSON.stringify(hit))
  ok('A4 命中依据 = 基因符号/别名（geneNames 含 TL1A）',
    hit != null && hit.matchedOn === 'gene' && (hit.geneNames ?? []).some(g => g === 'TL1A'),
    JSON.stringify(hit?.matchedOn))
}
{
  // 噪音词不入解析（试剂 / 方法 / 表单字段）
  const noisy = ['靶点结构评估表', '缓冲液：PBS，pH 7.5', 'SDS-PAGE', 'HPLC', '备注：无', '靶点名称：TL1A'].join('\n')
  const r = await postInsights({ text: noisy, goalHints: [], resolveNames: true, quick: true })
  const names = r.data?.insights?.targetNames ?? []
  ok('A5 停用词过滤：PBS / SDS-PAGE / HPLC 不入 targetNames',
    !names.includes('PBS') && !names.includes('SDS-PAGE') && !names.includes('HPLC') && names.includes('TL1A'),
    JSON.stringify(names))
}

// ── B. LLM 路径（内置引擎；失败自动回退规则 — 两种 source 均要求解析命中） ──
console.log('\n── B. LLM 路径 ──')
{
  const r = await postInsights({ text: TL1A_TEXT, goalHints: [], resolveNames: true })
  const ins = r.data?.insights
  ok('B1 LLM/回退提取 targetNames 含 TL1A', Array.isArray(ins?.targetNames) && ins.targetNames.some(n => /TL1A/i.test(n)),
    `source=${ins?.source} names=${JSON.stringify(ins?.targetNames)}`)
  const hit = ins?.resolvedUniprots?.find(x => /TL1A/i.test(x.name))
  ok('B2 LLM 路径 TL1A 解析 → O95150', hit != null && hit.accession === 'O95150', JSON.stringify(hit))
}

// ── C. 多名称解析（TL1A + PD-L1） ──────────────────────────────────────────
console.log('\n── C. 多名称 ──')
{
  const text = TL1A_TEXT.replace('靶点名称：TL1A', '靶点名称：TL1A、PD-L1')
  const r = await postInsights({ text, goalHints: [], resolveNames: true, quick: true })
  const ins = r.data?.insights
  const names = ins?.targetNames ?? []
  ok('C1 同行多靶点拆分（TL1A + PD-L1 都提取）', names.includes('TL1A') && names.includes('PD-L1'), JSON.stringify(names))
  const pdl1 = ins?.resolvedUniprots?.find(x => x.name === 'PD-L1')
  ok('C2 PD-L1 → Q9NZQ7（CD274 · 人源）', pdl1 != null && pdl1.accession === 'Q9NZQ7', JSON.stringify(pdl1))
}

// ── D. 端到端：非标准 docx 上传（直传通道）→ 名称解析 ───────────────────────
console.log('\n── D. docx 端到端（无状态直传）──')
{
  const { execSync } = await import('node:child_process')
  execSync('node scripts/make-name-only-docx.mjs /tmp/tl1a-only.docx TL1A', { cwd: ROOT })
  const buf = fs.readFileSync('/tmp/tl1a-only.docx')
  const fd = new FormData()
  fd.append('file', new File([buf], 'tl1a-only.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }))
  const up = await fetch(`${base}/api/evaluate/upload?stateless=1&noVlm=1`, { method: 'POST', body: fd })
  const upJson = await up.json()
  ok('D1 直传上传成功且 parsed 无 UniProt/序列（非标准表场景）',
    up.ok && upJson.ok && Array.isArray(upJson.parsed?.uniprotIds) && upJson.parsed.uniprotIds.length === 0 && upJson.parsed.sequences.length === 0,
    JSON.stringify(upJson).slice(0, 200))
  ok('D2 空解析提示已更新（提及按名称检索）', /按靶点名称/.test(upJson.error ?? ''), JSON.stringify(upJson.error))
  ok('D3 直传响应带 fullText（内联解析用）', typeof upJson.fullText === 'string' && upJson.fullText.includes('TL1A'))
  // 客户端行为模拟：resolveNames = parsed 为空
  const r = await postInsights({
    text: upJson.fullText, goalHints: upJson.parsed.goalHints ?? [], resolveNames: true, quick: true,
  })
  const hit = r.data?.insights?.resolvedUniprots?.find(x => x.name.toUpperCase() === 'TL1A')
  ok('D4 上传→解析链路：TL1A 解析 → O95150（chips 注入与按钮激活的数据源）',
    hit != null && hit.accession === 'O95150', JSON.stringify(hit))
}

// ── 收尾 ────────────────────────────────────────────────────────────────────
if (spawned) {
  try { process.kill(-spawned.pid, 'SIGTERM') } catch { /* 已退出 */ }
}
console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILED'} — ${pass} pass / ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)
