/**
 * v2.20.0 回归 — MiniMax 端点换代（模型列表不全根因修复）
 *  A 部分（纯 node，无需服务端）：本地引擎存储迁移单测 — 直接 import 真实
 *    src/components/eval/api.ts（Node ≥22.6 类型剥离，仅 import type 可擦除）
 *  B 部分（dev server :3000）：注册表/模型列表路由/真端点 401 实测
 * 前置：B 部分需 dev server 已在 :3000 运行（或先 npm run dev）。
 */
const BASE = 'http://127.0.0.1:3000'

let pass = 0, fail = 0
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`) }
}

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

// ─── A. 本地存储迁移单测（真实模块） ────────────────────────────────────────

function fakeStorage(initial = {}) {
  const m = new Map(Object.entries(initial))
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  }
}

async function partA() {
  console.log('== A. MiniMax 本地条目迁移（真实 api.ts 模块） ==')
  const { pathToFileURL } = await import('node:url')
  const api = await import(pathToFileURL(require.resolve('../src/components/eval/api.ts')).href)

  // A1. 旧端点条目 → 拆分升级
  globalThis.window = { localStorage: fakeStorage() }
  api.setLlmEngineOverride({ providerKey: 'minimax', label: 'MiniMax', baseUrl: 'https://api.minimaxi.com', apiKey: 'mm-key-keep', model: 'MiniMax-M2.7' })
  const cur = api.getLlmEngineOverride()
  check('A1a 旧 minimax 条目读取时升级：新端点 + M3.1-Flash + Key 沿用 + active 保持',
    cur?.providerKey === 'minimax' && cur?.baseUrl === 'https://api.minimax.io/v1'
    && cur?.model === 'MiniMax-M3.1-Flash' && cur?.apiKey === 'mm-key-keep',
    JSON.stringify(cur))
  const legacy = api.getEngineProviderEntry('minimax-legacy')
  check('A1b minimax-legacy 保留：旧端点 + M2.7 + 同一 Key（一键回滚不丢配置）',
    legacy?.baseUrl === 'https://api.minimaxi.com' && legacy?.model === 'MiniMax-M2.7' && legacy?.apiKey === 'mm-key-keep',
    JSON.stringify(legacy))

  // A2. 幂等：二次读取不再改写
  const raw1 = globalThis.window.localStorage.getItem('te_llm_engine_v1')
  api.getLlmEngineOverride()
  const raw2 = globalThis.window.localStorage.getItem('te_llm_engine_v1')
  check('A2 迁移幂等（二次读取存储不再变化）', raw1 === raw2 && raw1 !== null)

  // A3. 自定义 baseUrl（反代/中转）不迁移
  globalThis.window = { localStorage: fakeStorage() }
  api.setLlmEngineOverride({ providerKey: 'minimax', baseUrl: 'https://my-proxy.example/v1', apiKey: 'k', model: 'MiniMax-M2.7' })
  const cur3 = api.getLlmEngineOverride()
  check('A3 自定义 baseUrl 不迁移（尊重用户自设端点）',
    cur3?.baseUrl === 'https://my-proxy.example/v1' && cur3?.model === 'MiniMax-M2.7'
    && api.getEngineProviderEntry('minimax-legacy') === null,
    JSON.stringify(cur3))

  // A4. 非 minimax 条目不受影响
  globalThis.window = { localStorage: fakeStorage() }
  api.setLlmEngineOverride({ providerKey: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-4o' })
  const cur4 = api.getLlmEngineOverride()
  check('A4 非 minimax 条目不受影响（无 legacy 生成）',
    cur4?.providerKey === 'openai' && cur4?.model === 'gpt-4o' && api.getEngineProviderEntry('minimax-legacy') === null,
    JSON.stringify(cur4))

  delete globalThis.window
}

// ─── B. dev server E2E ──────────────────────────────────────────────────────

async function partB() {
  console.log('== B. 注册表 / 模型列表路由 / 真端点（dev server） ==')

  // B1. 供应商注册表
  const cfg = await get('/api/llm/config')
  const providers = cfg.data?.providers ?? []
  const mm = providers.find(p => p.key === 'minimax')
  const mml = providers.find(p => p.key === 'minimax-legacy')
  check('B1a minimax 条目指向新端点 api.minimax.io/v1 + 默认 M3.1-Flash',
    mm?.baseUrl === 'https://api.minimax.io/v1' && mm?.defaultModel === 'MiniMax-M3.1-Flash' && mm?.supportsModels === true,
    JSON.stringify(mm))
  check('B1b minimax-legacy 条目保留旧端点 + 默认 M2.7',
    mml?.baseUrl === 'https://api.minimaxi.com' && mml?.defaultModel === 'MiniMax-M2.7' && mml?.supportsModels === true,
    JSON.stringify(mml))
  check('B1c 供应商表完整（≥15 家）', providers.length >= 15, `count=${providers.length}`)

  // B2. 缺 Key 早退提示
  const noKey = await post('/api/llm/models', { providerKey: 'minimax' })
  check('B2 minimax 无 Key → 人话早退提示',
    noKey.status === 502 && /需要 API Key/.test(noKey.data?.error ?? ''),
    `status=${noKey.status} err=${String(noKey.data?.error).slice(0, 100)}`)

  // B3. 假 Key 真打新端点 → 401（live 证明请求确实到达 api.minimax.io）
  const fakeNew = await post('/api/llm/models', { providerKey: 'minimax', apiKey: 'regression-fake-key' })
  check('B3 minimax 假 Key → 新端点真回 401 + 鉴权提示',
    fakeNew.status === 502 && /HTTP 401/.test(fakeNew.data?.error ?? '') && /鉴权失败/.test(fakeNew.data?.error ?? ''),
    `status=${fakeNew.status} err=${String(fakeNew.data?.error).slice(0, 140)}`)

  // B4. 旧版条目同样可达（401 端点存在）
  const fakeLegacy = await post('/api/llm/models', { providerKey: 'minimax-legacy', apiKey: 'regression-fake-key' })
  check('B4 minimax-legacy 假 Key → 旧端点真回 401',
    fakeLegacy.status === 502 && /HTTP 401/.test(fakeLegacy.data?.error ?? ''),
    `status=${fakeLegacy.status} err=${String(fakeLegacy.data?.error).slice(0, 140)}`)

  // B5. M3.1-Flash 聊天路径（含 reasoning_effort 适配）真实执行 → 401 浮出
  const chat = await post('/api/llm/test', { providerKey: 'minimax', baseUrl: 'https://api.minimax.io/v1', apiKey: 'regression-fake-key', model: 'MiniMax-M3.1-Flash' })
  check('B5 M3.1-Flash 测试连接 → 真请求 401 浮出（非内置、参数可发）',
    chat.data?.ok === false && /401/.test(chat.data?.error ?? ''),
    `err=${String(chat.data?.error).slice(0, 140)}`)

  // B6. v2.19 保持项：服务端无激活配置
  check('B6 服务端仍无激活配置（v2.19 保持）', cfg.data?.active === null, JSON.stringify(cfg.data?.active))
}

async function main() {
  await partA()
  try {
    await partB()
  } catch (e) {
    console.log(`\nB 部分跳过/失败：${e instanceof Error ? e.message : String(e)}（dev server 未在 :3000 运行？先 npm run dev）`)
    fail++
  }
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail === 0 ? 0 : 1)
}

main()
