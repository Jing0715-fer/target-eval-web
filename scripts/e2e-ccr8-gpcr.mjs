#!/usr/bin/env node
/**
 * e2e-ccr8-gpcr.mjs — v2.26 修复全链路验收（一次性，复刻用户真实流程）：
 *   ① POST /api/evaluate ×3（P51685 CCR8 / P63096 Gαi1 / P62873 Gβ1，
 *      reportMode=deferred（关联批次口径）、skipBlast 加速、maxPdb=60 —
 *      GNAI1/GNB1 的 8KFX（全量排位 346/765）必然落库缺失 → 正是 augment 补齐场景）
 *   ② 轮询 /api/jobs 至 3 作业 done
 *   ③ POST /api/evaluate/relation（3 uniprots）→ related=true (complex)
 *   ④ POST /api/evaluate/batch-report → 轮询 done
 *   ⑤ GET inline=1 断言：
 *      - mrg-fmt-v2.26 标记
 *      - 共有结构表含 8KFX（augment 在线补齐生效 — 作业 directPdbs 无 8KFX）
 *      - GPCR 受体主导首页：Receptor-Centric 刊头 + Receptor × G-Protein Complexes
 *        面板 + 批次级补充折叠 + 受体完整评估主体（renderSingleReportBody 特征）
 *      - G 蛋白伴侣单独视图存在（view-target-P63096 / view-target-P62873）
 *
 * 运行：node scripts/e2e-ccr8-gpcr.mjs（复用常驻 dev server :3000）
 */
const BASE = 'http://127.0.0.1:3000'
const log = (...a) => console.log('[ccr8-e2e]', ...a)

let pass = 0, fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail.slice(0, 300)}` : ''}`) }
}

const post = async (path, body) => {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) })
  return { status: r.status, json: await r.json().catch(() => null) }
}
const get = async (path) => {
  const r = await fetch(BASE + path, { signal: AbortSignal.timeout(60_000) })
  // body 只能读一次：text → JSON.parse（旧实现 text() 与 json() 并行读 body，后者恒 null）
  const text = r.ok ? await r.text() : ''
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { json = null }
  return { status: r.status, text, json }
}

// ── ①② 逐靶点提交（每 IP 并发上限 2 — 串行提交 + 轮询终态；复用已有 done 作业）──
log('① 逐靶点提交评估作业（deferred 关联批次口径 · skipBlast · maxPdb=60）…')
const ACCS = ['P51685', 'P63096', 'P62873']
const jobIds = []
const jobStatus = new Map()
const DEADLINE = Date.now() + 16 * 60_000
/** 复用最近的同靶点 done 作业（沙盒长跑进程会被回收 — 脚本可重复执行续跑） */
const reuseDone = async (acc) => {
  const q = await get('/api/jobs')
  const hit = [...(q.json ?? [])].filter(j => j.uniprotId === acc && j.status === 'done')
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0]
  if (hit) { log(`  ${acc} 复用已完成作业 ${hit.id}`); jobStatus.set(hit.id, 'done'); return hit.id }
  return null
}
const submit = async (acc) => {
  const r = await post('/api/evaluate', {
    mode: 'uniprot',
    uniprot: acc,
    goal: '评估 CCR8 与 Gi 异三聚体复合物的结构解析可行性',
    options: { skipBlast: true, maxPdb: 60, reportMode: 'deferred' },
  })
  if (r.status === 200 && r.json?.jobId) return r.json.jobId
  if (r.status === 429) { // 配额占用 → 等 retryAfter 后重试
    await new Promise(rs => setTimeout(rs, (r.json?.retryAfter ?? 30) * 1000))
    return submit(acc)
  }
  console.error('作业提交失败', acc, r.status, JSON.stringify(r.json).slice(0, 200)); process.exit(1)
}
const awaitJobDone = async (jobId, label) => {
  while (Date.now() < DEADLINE) {
    await new Promise(r => setTimeout(r, 6000))
    const q = await get('/api/jobs')
    for (const j of q.json ?? []) if (j.id === jobId) jobStatus.set(jobId, j.status)
    const st = jobStatus.get(jobId) ?? '?'
    log(`  [${label}] ${Math.round((16 * 60_000 - (DEADLINE - Date.now())) / 1000)}s 状态: ${st}`)
    if (st === 'done' || st === 'error') return st
  }
  return 'timeout'
}
for (const acc of ACCS) {
  const reused = await reuseDone(acc)
  if (reused) { jobIds.push(reused); continue }
  const id = await submit(acc)
  jobIds.push(id)
  log(`  ${acc} → ${id}`)
  const st = await awaitJobDone(id, acc)
  if (st !== 'done') { console.error(`作业未完成（${st}）`, id); process.exit(2) }
  log(`  ${acc} done`)
}

// ── ③ 关系判定 ─────────────────────────────────────────────────────────────
log('③ 关系判定…')
const rel = await post('/api/evaluate/relation', { uniprots: ACCS, goal: '评估 CCR8 与 Gi 异三聚体复合物的结构解析可行性' })
if (rel.status !== 200 || !rel.json?.judgment) {
  console.error('relation 失败', rel.status, JSON.stringify(rel.json).slice(0, 200)); process.exit(3)
}
const judgment = rel.json.judgment
log(`  判定: ${judgment.relationType} related=${judgment.related} 置信度=${judgment.confidence}`)

// ── ④ 合并报告 ─────────────────────────────────────────────────────────────
log('④ 触发合并报告…')
const br = await post('/api/evaluate/batch-report', { jobIds, relation: judgment, goal: '评估 CCR8 与 Gi 异三聚体复合物的结构解析可行性' })
if (br.status !== 200 || !br.json?.ok) {
  console.error('batch-report 失败', br.status, JSON.stringify(br.json).slice(0, 200)); process.exit(4)
}
const id = br.json.batchReport.id
let report = null
const t0 = Date.now()
while (Date.now() - t0 < 9 * 60_000) {
  await new Promise(r => setTimeout(r, 6000))
  const q = await get(`/api/evaluate/batch-report?id=${id}`)
  report = q.json?.batchReport ?? null
  log(`  [${Math.round((Date.now() - t0) / 1000)}s] status=${report?.status} md=${report?.markdown?.length ?? '-'} shared=${report?.sharedStructures?.length ?? '-'}`)
  if (report?.status === 'done') break
  if (report?.status === 'error') { console.error('生成失败:', report?.error); process.exit(5) }
}
if (report?.status !== 'done') { console.error('合并报告超时'); process.exit(5) }

// ── ⑤ inline HTML 断言（status=done 落库先于 HTML 写盘 — 轮询 inline 就绪）─────
log('⑤ 等待 HTML 落盘并断言…')
let html = ''
for (let i = 0; i < 12 && !html; i++) {
  await new Promise(r => setTimeout(r, 4000))
  const inline = await get(`/api/evaluate/batch-report?id=${id}&inline=1`)
  if (inline.status === 200 && inline.text) html = inline.text
}
if (!html) { console.error('HTML 落盘轮询超时'); process.exit(6) }
console.log('── 验收断言 ──')
ok('F1 响应 200 且含 mrg-fmt-v2.26 格式标记（旧报告升级入口识别新格式）',
  html.length > 1000 && html.includes('mrg-fmt-v2.26'))

const has8kfx = /8KFX/.test(html)
ok('F2 共有结构表含 8KFX（augment 全量交集在线补齐生效 — 作业 directPdbs maxPdb=60 必然缺失 8KFX）',
  has8kfx)
ok('F2b 共有结构含 8KFY/8KFZ（CCR8-Gi 系列复合物 ≥3 个）',
  /8KFY/.test(html) && /8KFZ/.test(html))

ok('F3 GPCR 受体主导首页刊头（Receptor-Centric eyebrow + 受体主导复合物批次副标）',
  html.includes('Receptor-Centric Merged Report') && html.includes('受体主导复合物批次'))
ok('F4 受体 × G 蛋白复合物结构面板（Receptor × G-Protein Complexes + Gi 型标注）',
  html.includes('Receptor × G-Protein Complexes') && /Gi\/o 型/.test(html))
ok('F5 批次级补充分析折叠收纳（gpcr-batch-fold — 主页只显示受体评估）',
  html.includes('gpcr-batch-fold') && html.includes('批次级补充分析'))
ok('F6 受体完整评估主体在首页（renderSingleReportBody 特征：Key Findings 速览 + 批次说明）',
  html.includes('Key Findings') && html.includes('本页即该受体（主要评估对象）的完整评估报告'))
ok('F7 G 蛋白伴侣保留单独视图（view-target-P63096 / view-target-P62873）',
  html.includes('view-target-P63096') && html.includes('view-target-P62873'))
ok('F8 受体不出独立视图（view-target-P51685 不存在 — 首页即受体页）',
  !html.includes('view-target-P51685'))
ok('F9 DB sharedStructures 已按补齐口径落库（含 8KFX）',
  (report?.sharedStructures ?? []).some(s => s.pdbId === '8KFX') || /8KFX/.test(JSON.stringify(report?.sharedStructures ?? [])))

console.log(`\n${pass} 通过 · ${fail} 失败`)
if (fail === 0) {
  const { writeFileSync } = await import('fs')
  writeFileSync('/tmp/ccr8-gpcr-report.html', html)
  writeFileSync('/tmp/ccr8-gpcr-id.txt', id)
  log('报告已存 /tmp/ccr8-gpcr-report.html · id 已存 /tmp/ccr8-gpcr-id.txt')
}
process.exit(fail > 0 ? 1 : 0)
