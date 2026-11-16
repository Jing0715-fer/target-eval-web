/**
 * 手动驱动合并报告（脚本 C 浏览器被回收后补救）：
 *   ① POST /api/evaluate/relation（P69905+P68871）→ judgment
 *   ② POST /api/evaluate/batch-report（jobIds + relation）→ running
 *   ③ GET 轮询至 done → 写 /tmp/heme-merged.txt
 */
const BASE = 'http://localhost:3000'
const COOKIE = 'te_owner=9043a4cce0f74e379c7972549e500b81'
const jobIds = ['cmwimirm60002p7toomqei4i6', 'cmwimirm70003p7todxm9ap2h']
const log = (...a) => console.log('[merge]', ...a)

const post = async (path, body) => {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: COOKIE }, body: JSON.stringify(body) })
  const j = await r.json().catch(() => null)
  return { status: r.status, json: j }
}
const get = async (path) => {
  const r = await fetch(BASE + path, { headers: { cookie: COOKIE } })
  return { status: r.status, json: await r.json().catch(() => null) }
}

// ① 关系判定
log('① 关系判定…')
const rel = await post('/api/evaluate/relation', { uniprots: ['P69905', 'P68871'] })
if (rel.status !== 200 || !rel.json?.judgment) { console.error('relation 失败', rel.status, JSON.stringify(rel.json).slice(0, 200)); process.exit(1) }
const judgment = rel.json.judgment
log('判定:', judgment.relationType, '| merge:', judgment.mergeRecommended, '| 同源对:', (judgment.homologPairs || []).map(p => `${p.a}/${p.b}:${p.identity}%`).join(' ') || '无')

// ② 触发合并报告
log('② 触发合并报告…')
const br = await post('/api/evaluate/batch-report', { jobIds, relation: judgment })
if (br.status !== 200 || !br.json?.ok) { console.error('batch-report 失败', br.status, JSON.stringify(br.json).slice(0, 200)); process.exit(1) }
const id = br.json.batchReport.id
log('BatchReport id =', id)

// ③ 轮询至终态
const t0 = Date.now()
while (Date.now() - t0 < 560_000) {
  await new Promise((r) => setTimeout(r, 5000))
  const q = await get(`/api/evaluate/batch-report?id=${id}`)
  const st = q.json?.batchReport?.status
  const md = q.json?.batchReport?.markdown
  log(`[${Math.round((Date.now() - t0) / 1000)}s] status=${st} markdown=${md ? md.length + '字' : '-'}`)
  if (st === 'done') {
    const { writeFileSync } = await import('fs')
    writeFileSync('/tmp/heme-merged.txt', id)
    log('DONE', id)
    process.exit(0)
  }
  if (st === 'error') { console.error('生成失败:', q.json?.batchReport?.error); process.exit(2) }
}
console.error('超时'); process.exit(1)
