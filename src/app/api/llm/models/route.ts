/**
 * POST /api/llm/models — 拉取供应商模型列表（服务端执行，API Key 不经过前端持久化）。
 * body: { providerKey, baseUrl?, apiKey? } — apiKey 为用户当前在表单中输入的值（可选）。
 */
import { NextResponse } from 'next/server'
import { getActiveLlmConfig, fetchProviderModels } from '@/lib/eval/llm-provider'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface ModelsBody {
  providerKey?: string
  baseUrl?: string
  apiKey?: string
  /** useActive=true：用已保存的激活配置拉取（含已存 Key） */
  useActive?: boolean
}

export async function POST(req: Request) {
  let body: ModelsBody
  try {
    body = (await req.json()) as ModelsBody
  } catch {
    return NextResponse.json({ ok: false, error: '请求体不是合法 JSON' }, { status: 400 })
  }

  let providerKey = (body.providerKey ?? '').trim()
  let baseUrl = body.baseUrl?.trim()
  let apiKey = body.apiKey?.trim()

  if (body.useActive) {
    const cfg = await getActiveLlmConfig()
    if (!cfg) {
      return NextResponse.json({ ok: false, error: '当前为内置引擎，无需获取模型列表' })
    }
    providerKey = cfg.providerKey
    // v2.18.1 安全加固：显式指定了与保存配置不同的 baseUrl 时不得携带已存 Key
    // （防 Key 定向外送，与配置保存路由 v2.5 同规则）
    apiKey = baseUrl && baseUrl !== cfg.baseUrl ? apiKey : (apiKey || cfg.apiKey)
    baseUrl = baseUrl || cfg.baseUrl
  }

  if (!providerKey) {
    return NextResponse.json({ ok: false, error: '缺少 providerKey' }, { status: 400 })
  }

  const r = await fetchProviderModels(providerKey, baseUrl, apiKey)
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 502 })
  return NextResponse.json({ ok: true, models: r.models })
}
