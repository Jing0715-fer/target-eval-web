/**
 * v2.18.1 回归 E2E — 队列孤儿自愈 + LLM 模型列表（MiniMax / Key 提示 / 留空沿用）
 * 前置：dev server 已在 :3000 运行。
 */
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()
const BASE = 'http://127.0.0.1:3000'

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => null)
  return { status: res.status, data }
}
async function get(path) {
  const res = await fetch(BASE + path)
  return { status: res.status, data: await res.json().catch(() => null) }
}

let pass = 0, fail = 0
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`) }
}

async function main() {
  console.log('== 1. 队列孤儿自愈（60s 宽限期） ==')
  // 1a. 造一条「旧」孤儿 pending（updatedAt 2h 前）
  const oldRow = await p.evaluationJob.create({ data: { status: 'pending', mode: 'uniprot', title: '回归-旧孤儿', ownerKey: 'regression-test', ownerMask: '127.0.0.*', updatedAt: new Date(Date.now() - 2 * 3600_000) } })
  // 1b. 造一条「新」孤儿 pending（updatedAt 10s 前 → 宽限期内不得清）
  const newRow = await p.evaluationJob.create({ data: { status: 'pending', mode: 'uniprot', title: '回归-新孤儿', ownerKey: 'regression-test', ownerMask: '127.0.0.*', updatedAt: new Date(Date.now() - 10_000) } })
  // 1c. GET /api/jobs 触发 reapOrphanJobs
  await get('/api/jobs')
  await new Promise(r => setTimeout(r, 1500))
  const oldAfter = await p.evaluationJob.findUnique({ where: { id: oldRow.id } })
  const newAfter = await p.evaluationJob.findUnique({ where: { id: newRow.id } })
  check('旧孤儿（>60s 且不在内存）被清理为 error', oldAfter?.status === 'error' && /中断/.test(oldAfter?.error ?? ''), `status=${oldAfter?.status} err=${oldAfter?.error}`)
  check('新孤儿（<60s 宽限）保持 pending', newAfter?.status === 'pending', `status=${newAfter?.status}`)
  await p.evaluationJob.deleteMany({ where: { ownerKey: 'regression-test' } })

  console.log('== 2. MiniMax 模型列表支持 ==')
  // 2a. 元数据：modelsPath 已配置
  const cfgRes = await get('/api/llm/config')
  const minimax = cfgRes.data?.providers?.find?.(x => x.key === 'minimax')
  check('minimax supportsModels=true', minimax?.supportsModels === true, JSON.stringify(minimax))
  check('minimax 无「暂不支持」琥珀提示（modelsNote 空）', !minimax?.modelsNote, minimax?.modelsNote ?? '')
  // 2b. 真实端点：假 Key → HTTP 401 且带鉴权提示（证明请求真正到达 MiniMax）
  const mm = await post('/api/llm/models', { providerKey: 'minimax', apiKey: 'regression-invalid-key' })
  check('minimax 假 Key → 401 + 人话提示', mm.status === 502 && /鉴权失败/.test(mm.data?.error ?? ''), `status=${mm.status} err=${String(mm.data?.error).slice(0, 120)}`)

  console.log('== 3. Key 缺失提示 ==')
  // 3a. openai 无 Key 无保存 → 友好提示（先回填 DB 无果 → needsKey 早退，不打裸请求）
  await p.llmConfig.deleteMany({}) // 保证无已存配置
  const oa = await post('/api/llm/models', { providerKey: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: '' })
  check('openai 无 Key → 友好提示「需要 API Key」', oa.status === 502 && /需要 API Key/.test(oa.data?.error ?? ''), `status=${oa.status} err=${String(oa.data?.error).slice(0, 120)}`)

  console.log('== 4. 留空沿用已存 Key（模型列表路由） ==')
  // 4a. 保存一条 minimax 配置（沙箱可达端点，假 Key）
  await p.llmConfig.create({ data: { providerKey: 'minimax', label: 'MiniMax', baseUrl: 'https://api.minimaxi.com', apiKey: 'regression-saved-fake', model: 'MiniMax-M2.7', isActive: true } })
  // 4b. 表单 Key 留空 + 相同 baseUrl → 应回填已存 Key（真请求 401 带「鉴权失败」提示，而非「需要 API Key」早退）
  const reuse = await post('/api/llm/models', { providerKey: 'minimax', baseUrl: 'https://api.minimaxi.com', apiKey: '' })
  check('留空 + 同 baseUrl → 沿用已存 Key（发出真请求得 401 鉴权提示）', reuse.status === 502 && /鉴权失败/.test(reuse.data?.error ?? ''), `status=${reuse.status} err=${String(reuse.data?.error).slice(0, 120)}`)
  // 4c. 留空 + 不同 baseUrl → 不沿用（安全：不得回发到别处）→ 早退「需要 API Key」
  const leak = await post('/api/llm/models', { providerKey: 'minimax', baseUrl: 'https://evil-regression.example.com', apiKey: '' })
  check('留空 + 异 baseUrl → 不沿用已存 Key（防外送）', leak.status === 502 && /需要 API Key/.test(leak.data?.error ?? ''), `status=${leak.status} err=${String(leak.data?.error).slice(0, 120)}`)
  await p.llmConfig.deleteMany({}) // 清理

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exit(1)
}

main().catch(e => { console.error('FATAL', e); process.exit(1) }).finally(() => p.$disconnect())
