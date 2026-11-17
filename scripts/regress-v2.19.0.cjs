/**
 * v2.19.0 回归 E2E — 引擎配置用户本地化（Key 不落服务端、不跨用户共享）
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
  return { status: res.status, data: await res.json().catch(() => null) }
}
async function get(path) {
  const res = await fetch(BASE + path, { cache: 'no-store' })
  return { status: res.status, data: await res.json().catch(() => null) }
}

let pass = 0, fail = 0
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`) }
}

async function main() {
  console.log('== 1. 孤儿作业清理仍工作（v2.18.1 保持项） ==')
  const oldRow = await p.evaluationJob.create({ data: { status: 'pending', mode: 'uniprot', title: '回归-旧孤儿', ownerKey: 'regression-test', ownerMask: '127.0.0.*', updatedAt: new Date(Date.now() - 2 * 3600_000) } })
  await get('/api/jobs')
  await new Promise(r => setTimeout(r, 1500))
  const oldAfter = await p.evaluationJob.findUnique({ where: { id: oldRow.id } })
  check('旧孤儿被清理为 error', oldAfter?.status === 'error' && /中断/.test(oldAfter?.error ?? ''), `status=${oldAfter?.status}`)
  await p.evaluationJob.deleteMany({ where: { ownerKey: 'regression-test' } })

  console.log('== 2. 服务端不再存/读 Key（核心：不跨用户共享） ==')
  // 2a. 模拟旧版存量行（openai + 假 Key）
  await p.llmConfig.deleteMany({})
  await p.llmConfig.create({ data: { providerKey: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-legacy-shared-key', model: 'gpt-4o', isActive: true } })
  // 2b. 留空 Key + 相同 baseUrl 的模型列表请求 → 不得回填服务端存量 Key（防跨用户使用）
  const leak = await post('/api/llm/models', { providerKey: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: '' })
  check('存量行存在时留空 Key → 早退「需要 API Key」（不复用服务端 Key）', leak.status === 502 && /需要 API Key/.test(leak.data?.error ?? ''), `status=${leak.status} err=${String(leak.data?.error).slice(0, 100)}`)
  // 2c. GET /api/llm/config → 触发存量一次性清除 + active 恒 null
  const cfg = await get('/api/llm/config')
  const countAfter = await p.llmConfig.count()
  check('GET /api/llm/config 触发存量清除（DB 行归零）', countAfter === 0, `count=${countAfter}`)
  check('GET 返回 active=null（服务端无激活配置）', cfg.data?.active === null, JSON.stringify(cfg.data?.active))
  check('GET 返回供应商列表（面板渲染）', Array.isArray(cfg.data?.providers) && (cfg.data?.providers?.length ?? 0) >= 13, `providers=${cfg.data?.providers?.length}`)
  // 2d. POST /api/llm/config（旧客户端兼容）→ 不写库
  const shim = await post('/api/llm/config', { providerKey: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-should-not-persist', model: 'gpt-4o' })
  const countAfterPost = await p.llmConfig.count()
  check('POST 兼容空操作（不再写库）', shim.status === 200 && shim.data?.ok === true && countAfterPost === 0, `status=${shim.status} count=${countAfterPost}`)

  console.log('== 3. 请求级引擎覆写真通（评估走用户引擎） ==')
  // 3a. 显式覆写 MiniMax（真端点）→ 请求发出并命中其 base_resp 鉴权错误（证明走覆写端点而非内置）
  const mm = await post('/api/llm/test', { providerKey: 'minimax', baseUrl: 'https://api.minimaxi.com', apiKey: 'regression-fake-key', model: 'MiniMax-M2.7' })
  check('覆写 MiniMax → 真请求 + base_resp 错误浮出（非内置）', mm.data?.ok === false && /供应商错误|login fail|1004/i.test(mm.data?.error ?? ''), `err=${String(mm.data?.error).slice(0, 120)}`)
  // 3b. 内置引擎健康（z-ai SDK 可用）
  const bi = await post('/api/llm/test', { providerKey: 'builtin' })
  check('内置引擎连通（z-ai SDK）', bi.data?.ok === true && typeof bi.data?.latencyMs === 'number', `ok=${bi.data?.ok} err=${String(bi.data?.error).slice(0, 80)}`)

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  if (fail > 0) process.exit(1)
}

main().catch(e => { console.error('FATAL', e); process.exit(1) }).finally(() => p.$disconnect())
