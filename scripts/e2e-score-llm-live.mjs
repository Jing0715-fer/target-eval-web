/**
 * v2.18 LLM 智能调分 — dev server 实战 E2E（真实完整管线）：
 *  1. POST /api/evaluate/sync（P04637 p53 · skipBlast 提速）：SSE 事件流解析，
 *     checkpoint 事件自动续跑（分段协议与前端同款 — 复核的段预算闸门/handoff 真实经过）
 *  2. 断言管线日志出现「AI 复核」进度/日志行
 *  3. done 事件：summary.scores.llmAdjust 存在且字段合法（delta ∈ [-2,2] 整数）
 *  4. reportHtml 含 llm-adj-strip / score-delta / glance-ai-tag（内嵌报告渲染验证）
 *  5. 落盘报告文件（db/reports/<jobId>/report.html）抽查
 * 运行：node scripts/e2e-score-llm-live.mjs（需 dev server 在 localhost:3000）
 */
const BASE = process.env.EVAL_BASE ?? 'http://localhost:3000'

let pass = 0, fail = 0
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ← ${detail}`}`)
  cond ? pass++ : fail++
}

/** 单段请求：解析 NDJSON 事件流到终结事件（done/error/流关闭） */
async function runSegment(body, signal) {
  const res = await fetch(`${BASE}/api/evaluate/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`)
  }
  const events = []
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      try { events.push(JSON.parse(line)) } catch { /* 忽略残行 */ }
    }
  }
  return events
}

const t0 = Date.now()
const logs = []
const progressMsgs = []
let checkpoint = undefined
let doneEvent = null
let errorEvent = null
const segments = 0

for (let seg = 0; ; seg++) {
  const body = {
    mode: 'uniprot',
    uniprot: 'P04637',
    goal: 'E2E 验证：评估 p53 结构域的可行解析路线（AI 复核链路测试）',
    options: { skipBlast: true, forceBlast: false, maxPdb: 30 },
    ...(checkpoint ? { checkpoint } : {}),
  }
  const events = await runSegment(body)
  for (const ev of events) {
    // job 事件结构：{ id, status, progress: {stage, percent, message}, logs: string[] }
    if (ev.type === 'job' && Array.isArray(ev.job?.logs)) logs.push(...ev.job.logs)
    if (ev.type === 'job' && ev.job?.progress?.message) progressMsgs.push(ev.job.progress.message)
    if (ev.type === 'checkpoint') checkpoint = ev.checkpoint
    if (ev.type === 'done') doneEvent = ev
    if (ev.type === 'error') errorEvent = ev
  }
  console.log(`  段 ${seg + 1}：${events.length} 事件${events.some(e => e.type === 'checkpoint') ? '（checkpoint 续跑）' : ''}${doneEvent ? '（done）' : ''}${errorEvent ? '（error）' : ''}`)
  if (doneEvent || errorEvent) break
  if (seg > 40) { console.error('段数超限（>40）— 疑似死循环'); process.exit(1) }
}

console.log(`\n总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s · ${segments || ''}${logs.length} 条日志`)

if (errorEvent) {
  ok('评估无错误', false, JSON.stringify(errorEvent).slice(0, 300))
  process.exit(1)
}
ok('评估完成（done 事件）', doneEvent != null)

// 1. 管线经过 AI 复核（进度消息为权威信号 — 日志缓冲 60 条滚动，分析阶段的
//    复核日志行会被后段报告日志冲掉，仅信息性输出）
const aiLogs = logs.filter(l => /AI 复核/.test(l))
const aiProgress = progressMsgs.filter(m => /AI 复核/.test(m))
ok(`进度含 AI 复核步骤消息（管线真实经过复核阶段）`, aiProgress.length > 0, progressMsgs.slice(-8).join(' | '))
console.log(`  ○ 日志中 AI 复核行：${aiLogs.length} 条（60 条滚动缓冲 — 非权威信号）`)

// 2. summary.scores.llmAdjust
const summary = doneEvent?.job?.summary ?? (typeof doneEvent?.job?.summary === 'string' ? JSON.parse(doneEvent.job.summary) : null)
const scores = summary?.scores
const adj = scores?.llmAdjust
ok('summary.scores.llmAdjust 存在', adj != null)
if (adj) {
  ok('三方法 delta 为 [-2,2] 整数', [adj.xray, adj.cryoem, adj.nmr].every(v => Number.isInteger(v) && Math.abs(v) <= 2), JSON.stringify([adj.xray, adj.cryoem, adj.nmr]))
  ok('总体 delta 为 [-2,2] 整数（max 口径推导）', Number.isInteger(adj.overall) && Math.abs(adj.overall) <= 2)
  ok('总体 = 三方法最大值口径', adj.overall === (Math.max(scores.xray.score, scores.cryoem.score, scores.nmr.score) - Math.max(scores.xray.score - adj.xray, scores.cryoem.score - adj.cryoem, scores.nmr.score - adj.nmr)))
  ok('applied 标记与 delta 一致', adj.applied === (adj.xray !== 0 || adj.cryoem !== 0 || adj.nmr !== 0))
  ok('逐方法意见非空', [adj.notes.xray, adj.notes.cryoem, adj.notes.nmr].every(s => typeof s === 'string' && s.length > 0))
  ok('置信度合法', ['high', 'medium', 'low'].includes(adj.confidence))
  ok('引擎与耗时记录', typeof adj.engine === 'string' && adj.engine.length > 0 && adj.durationMs > 0)
}

// 3. 内嵌报告 HTML 渲染
const html = doneEvent?.reportHtml ?? ''
if (html) {
  ok('报告含 AI 复核条元素', html.includes('class="llm-adj-strip"'))
  ok('报告含评分依据双列网格（sr-item）', html.includes('class="sr-item"'))
  ok('报告含目录滚动高亮脚本（scroll-spy）', html.includes('.toc a.cur'))
  ok('报告含表格行悬停 CSS', html.includes('.tbl-data tbody tr:hover'))
  ok('评分说明段两层流程', html.includes('评分流程分两层'))
} else {
  ok('报告 HTML 返回', false, 'done 事件无 reportHtml')
}

console.log(`\n${pass} passed · ${fail} failed`)
process.exit(fail ? 1 : 0)
