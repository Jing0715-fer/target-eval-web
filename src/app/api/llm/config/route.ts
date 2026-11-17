/**
 * LLM 引擎配置 — GET 当前配置（含供应商注册表）/ POST 保存并启用 / DELETE 恢复内置。
 * v2.19：引擎配置改为用户浏览器本地存储（localStorage），仅随评估请求内联携带 —
 * 服务端不再持久化任何 API Key。GET 顺带一次性清除历史版本存进 SQLite 的全局
 * 共享配置（旧机制下任一用户保存的 Key 会驱动所有用户的评估）；POST/DELETE 保留
 * 为兼容空操作（旧前端调用不报错，但不再写库）。
 */
import { NextResponse } from 'next/server'
import {
  PROVIDERS, wipeServerLlmConfigsOnce,
} from '@/lib/eval/llm-provider'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** GET：供应商列表 +（本地配置由前端 localStorage 自行管理，服务端无激活配置） */
export async function GET() {
  // 惰性清除历史存量服务端配置（每进程一次）
  await wipeServerLlmConfigsOnce().catch(() => undefined)
  return NextResponse.json({
    ok: true,
    active: null,
    engineSummary: 'Z.ai GLM-4.6（内置）',
    providers: PROVIDERS.map(p => ({
      key: p.key, label: p.label, hint: p.hint, baseUrl: p.baseUrl,
      needsKey: p.needsKey, defaultModel: p.defaultModel ?? '',
      supportsModels: Boolean(p.modelsPath) || p.key === 'builtin',
      modelsNote: p.modelsNote ?? '',
    })),
    note: 'v2.19：引擎配置保存在浏览器本地（仅本人可用），服务端不保存 API Key',
  })
}

interface ConfigBody {
  providerKey?: string
  label?: string
  baseUrl?: string
  apiKey?: string
  model?: string
  keepKey?: boolean
}

/** POST：兼容空操作 — 不再写库（新前端保存在 localStorage） */
export async function POST(_req: Request) {
  void _req
  return NextResponse.json({
    ok: true,
    active: null,
    engineSummary: 'Z.ai GLM-4.6（内置）',
    note: 'v2.19 起引擎配置保存在浏览器本地 — 请使用新版配置面板（无需调用本接口）',
  })
}

/** DELETE：兼容空操作 */
export async function DELETE() {
  return NextResponse.json({ ok: true, active: null, engineSummary: 'Z.ai GLM-4.6（内置）' })
}
