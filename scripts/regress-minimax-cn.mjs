/**
 * v2.20.1 MiniMax 端点纠偏回归 — 两段：
 *  A. 本地迁移纯函数单测（node 原生 TS 类型擦除，直接 import 真实模块）：
 *     1) v2.18 时代存（minimax@minimaxi.com）→ legacy 保留 + minimax@api.minimax.cn/v1
 *     2) v2.20 时代存（minimax@api.minimax.io/v1，国内 Key 被带过去）→ 主条目回 .cn +
 *        .io 条目原样挪 minimax-intl（Key 不丢）、active 指向不变
 *     3) 自定义反代 baseUrl 不动；重复迁移幂等；minimax-intl 已有 Key 不被覆盖
 *  B. 临时 dev server 真实路由 E2E：
 *     - GET /api/llm/config：三条 MiniMax 条目（cn 主 / io 国际 / minimaxi 旧版）
 *     - POST /api/llm/models（假 Key）：MiniMax 家族 401 追加「两平台 Key 不通用」提示
 *     - POST /api/llm/models（deepseek 假 Key）：通用 401 提示不受影响（回归保护；openai.com 在本沙箱不可达，用可达的国内供应商替代验证同一分支）
 *     - POST /api/llm/models（无 Key）：友好提示，不外发请求
 * 运行：node scripts/regress-minimax-cn.mjs
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import {
  migrateMinimaxDomesticDefault,
  migrateMinimaxEndpoint,
} from '../src/components/eval/llm-store-migration.ts'

let pass = 0, fail = 0
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ← ${detail}`}`)
  cond ? pass++ : fail++
}

const K = 'eyJhbGciOiJSUzI1NiIs-dummy-domestic-key'
const clone = (x) => structuredClone(x)

// ─── A. 迁移纯函数 ──────────────────────────────────────────────────────────
console.log('── A. localStorage 迁移（真实模块）──')

// A1: v2.18 时代 — minimax@minimaxi.com（含激活）
{
  const s = {
    active: 'minimax',
    providers: {
      minimax: { label: 'MiniMax', baseUrl: 'https://api.minimaxi.com', apiKey: K, model: 'MiniMax-M2.7', savedAt: 1 },
    },
  }
  const ran = migrateMinimaxEndpoint(s)
  ok('A1 迁移触发', ran === true)
  ok('A1 minimax → api.minimax.cn/v1', s.providers.minimax.baseUrl === 'https://api.minimax.cn/v1', s.providers.minimax.baseUrl)
  ok('A1 国内 Key 沿用', s.providers.minimax.apiKey === K)
  ok('A1 默认模型 MiniMax-M3.1-Flash', s.providers.minimax.model === 'MiniMax-M3.1-Flash', s.providers.minimax.model)
  ok('A1 legacy 原样保留（旧端点 + M2.7 + Key）',
    s.providers['minimax-legacy']?.baseUrl === 'https://api.minimaxi.com'
    && s.providers['minimax-legacy']?.model === 'MiniMax-M2.7'
    && s.providers['minimax-legacy']?.apiKey === K)
  ok('A1 active 指向不变', s.active === 'minimax')
  ok('A1 幂等（再跑不触发）', migrateMinimaxEndpoint(clone(s)) === false && migrateMinimaxDomesticDefault(clone(s)) === false)
}

// A2: v2.20 时代 — minimax@.io（国内 Key 被带过去，正是用户当前存态）
{
  const s = {
    active: 'minimax',
    providers: {
      'minimax-legacy': { label: 'MiniMax 旧版 API', baseUrl: 'https://api.minimaxi.com', apiKey: K, model: 'MiniMax-M2.7', savedAt: 1 },
      minimax: { label: 'MiniMax', baseUrl: 'https://api.minimax.io/v1', apiKey: K, model: 'MiniMax-M3.1-Flash', savedAt: 2 },
    },
  }
  const ran = migrateMinimaxDomesticDefault(s)
  ok('A2 纠偏迁移触发', ran === true)
  ok('A2 minimax → api.minimax.cn/v1', s.providers.minimax.baseUrl === 'https://api.minimax.cn/v1', s.providers.minimax.baseUrl)
  ok('A2 minimax Key = 国内 Key', s.providers.minimax.apiKey === K)
  ok('A2 minimax 默认模型保留 M3.1-Flash', s.providers.minimax.model === 'MiniMax-M3.1-Flash')
  ok('A2 .io 条目原样挪 minimax-intl（Key 不丢）',
    s.providers['minimax-intl']?.baseUrl === 'https://api.minimax.io/v1'
    && s.providers['minimax-intl']?.apiKey === K)
  ok('A2 legacy 不动', s.providers['minimax-legacy']?.baseUrl === 'https://api.minimaxi.com' && s.providers['minimax-legacy']?.apiKey === K)
  ok('A2 active 仍指向 minimax（现在打 .cn）', s.active === 'minimax')
  ok('A2 幂等', migrateMinimaxDomesticDefault(clone(s)) === false && migrateMinimaxEndpoint(clone(s)) === false)
}

// A3: 自定义反代 baseUrl — 两个迁移都不碰
{
  const s = {
    active: null,
    providers: {
      minimax: { label: 'MiniMax', baseUrl: 'https://my-proxy.example.com/v1', apiKey: K, model: 'MiniMax-M2.7', savedAt: 1 },
    },
  }
  ok('A3 自定义反代 baseUrl 不动', migrateMinimaxEndpoint(clone(s)) === false && migrateMinimaxDomesticDefault(clone(s)) === false)
}

// A4: minimax-intl 已存用户自己的国际 Key — 不被纠偏迁移覆盖
{
  const s = {
    active: 'minimax-intl',
    providers: {
      'minimax-intl': { label: 'MiniMax 国际版', baseUrl: 'https://api.minimax.io/v1', apiKey: 'intl-user-key', model: 'MiniMax-M3', savedAt: 1 },
      minimax: { label: 'MiniMax', baseUrl: 'https://api.minimax.io/v1', apiKey: K, model: 'MiniMax-M3.1-Flash', savedAt: 2 },
    },
  }
  const ran = migrateMinimaxDomesticDefault(s)
  ok('A4 纠偏迁移触发（主条目回 .cn）', ran === true)
  ok('A4 minimax-intl 的用户国际 Key 不被覆盖', s.providers['minimax-intl']?.apiKey === 'intl-user-key')
  ok('A4 minimax → .cn（Key 取 .io 条目里的国内 Key）', s.providers.minimax.baseUrl === 'https://api.minimax.cn/v1' && s.providers.minimax.apiKey === K)
  ok('A4 active 指向不变', s.active === 'minimax-intl')
}

// ─── B. dev server 真实路由 E2E ─────────────────────────────────────────────
console.log('── B. dev server 路由（真实请求）──')

const PORT = 3213
const ROOT = new URL('..', import.meta.url).pathname
const LOG = '/tmp/regress-minimax-dev.log'
const proc = spawn('npx', ['next', 'dev', '-p', String(PORT)], {
  cwd: ROOT,
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
})
const logStream = fs.createWriteStream(LOG, { flags: 'w' })
proc.stdout.pipe(logStream)
proc.stderr.pipe(logStream)

const killServer = () => {
  try { process.kill(-proc.pid, 'SIGTERM') } catch { /* already gone */ }
  try { proc.kill('SIGTERM') } catch { /* already gone */ }
  // npx 中间层偶发漏杀 → 按命令行模式兜底（仅限本测试端口，不误伤他进程）
  try { spawn('pkill', ['-f', `next dev -p ${PORT}`]) } catch { /* best-effort */ }
}
process.on('exit', killServer)

// 等 dev server 就绪（GET /api/llm/config 可用）
const base = `http://127.0.0.1:${PORT}`
let ready = false
for (let i = 0; i < 150; i++) {
  try {
    const r = await fetch(`${base}/api/llm/config`, { signal: AbortSignal.timeout(3000) })
    if (r.ok) { ready = true; break }
  } catch { /* starting */ }
  await new Promise(r => setTimeout(r, 1000))
}
if (!ready) {
  console.log(`✗ dev server 未就绪（150s）— 日志：${LOG}`)
  killServer()
  process.exit(1)
}
console.log(`  dev server 就绪（:${PORT}）`)

// B1: 供应商注册表
{
  const cfg = await (await fetch(`${base}/api/llm/config`)).json()
  const byKey = Object.fromEntries(cfg.providers.map(p => [p.key, p]))
  ok('B1 minimax 主条目 = api.minimax.cn/v1 + M3.1-Flash',
    byKey.minimax?.baseUrl === 'https://api.minimax.cn/v1' && byKey.minimax?.defaultModel === 'MiniMax-M3.1-Flash' && byKey.minimax?.needsKey === true,
    JSON.stringify(byKey.minimax))
  ok('B1 minimax-intl = api.minimax.io/v1 + M3.1-Flash',
    byKey['minimax-intl']?.baseUrl === 'https://api.minimax.io/v1' && byKey['minimax-intl']?.defaultModel === 'MiniMax-M3.1-Flash')
  ok('B1 minimax-legacy = api.minimaxi.com + M2.7',
    byKey['minimax-legacy']?.baseUrl === 'https://api.minimaxi.com' && byKey['minimax-legacy']?.defaultModel === 'MiniMax-M2.7')
  ok('B1 三条 MiniMax 均支持模型列表自动获取',
    byKey.minimax?.supportsModels === true && byKey['minimax-intl']?.supportsModels === true && byKey['minimax-legacy']?.supportsModels === true)
}

// B2: 模型列表路由（假 Key / 无 Key）
{
  const post = (body) =>
    fetch(`${base}/api/llm/models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(async r => ({ status: r.status, data: await r.json().catch(() => ({})) }))

  const r1 = await post({ providerKey: 'minimax', apiKey: 'dummy-invalid-key' })
  ok('B2 minimax 假 Key → HTTP 401 + 两平台 Key 不通用提示',
    r1.status === 502 && /HTTP 401/.test(r1.data.error) && /不通用/.test(r1.data.error) && /api\.minimax\.cn/.test(r1.data.error),
    r1.data.error)

  const r2 = await post({ providerKey: 'minimax-intl', apiKey: 'dummy-invalid-key' })
  ok('B2 minimax-intl 假 Key → HTTP 401 + 同款提示',
    r2.status === 502 && /HTTP 401/.test(r2.data.error) && /不通用/.test(r2.data.error),
    r2.data.error)

  const r3 = await post({ providerKey: 'minimax-legacy', apiKey: 'dummy-invalid-key' })
  ok('B2 minimax-legacy 假 Key → HTTP 401 + 同款提示',
    r3.status === 502 && /HTTP 401/.test(r3.data.error) && /不通用/.test(r3.data.error),
    r3.data.error)

  const r4 = await post({ providerKey: 'deepseek', apiKey: 'dummy-invalid-key' })
  ok('B2 deepseek 假 Key → 通用鉴权提示（回归保护）',
    r4.status === 502 && (/鉴权失败：请检查 API Key 是否填写正确/.test(r4.data.error) || /超时/.test(r4.data.error)),
    r4.data.error)

  const r5 = await post({ providerKey: 'minimax' })
  ok('B2 minimax 无 Key → 友好提示（不外发）',
    r5.status === 502 && /需要 API Key/.test(r5.data.error),
    r5.data.error)
}

killServer()
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
