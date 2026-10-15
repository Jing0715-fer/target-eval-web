/**
 * LLM 引擎配置 — GET 当前配置（含供应商注册表）/ POST 保存并启用 / DELETE 恢复内置。
 * API Key 仅后端持有，返回给前端时脱敏。
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  PROVIDERS, getActiveLlmConfig, getProviderMeta, invalidateLlmConfigCache, maskApiKey,
} from '@/lib/eval/llm-provider'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** GET：激活配置（脱敏）+ 供应商列表（供配置页渲染） */
export async function GET() {
  const cfg = await getActiveLlmConfig()
  return NextResponse.json({
    ok: true,
    active: cfg
      ? {
          providerKey: cfg.providerKey,
          label: cfg.label,
          baseUrl: cfg.baseUrl,
          apiKeyMasked: maskApiKey(cfg.apiKey),
          hasKey: Boolean(cfg.apiKey),
          model: cfg.model,
        }
      : null,
    engineSummary: cfg ? `${cfg.label} · ${cfg.model}` : 'Z.ai GLM-4.6（内置）',
    providers: PROVIDERS.map(p => ({
      key: p.key, label: p.label, hint: p.hint, baseUrl: p.baseUrl,
      needsKey: p.needsKey, defaultModel: p.defaultModel ?? '',
      supportsModels: Boolean(p.modelsPath) || p.key === 'builtin',
      modelsNote: p.modelsNote ?? '',
    })),
  })
}

interface ConfigBody {
  providerKey?: string
  label?: string
  baseUrl?: string
  apiKey?: string
  model?: string
  /** true = apiKey 为空时沿用已保存的相同供应商 Key */
  keepKey?: boolean
}

/** POST：保存并激活（单行制：清空旧配置）。providerKey=builtin 等价 DELETE。 */
export async function POST(req: Request) {
  let body: ConfigBody
  try {
    body = (await req.json()) as ConfigBody
  } catch {
    return NextResponse.json({ ok: false, error: '请求体不是合法 JSON' }, { status: 400 })
  }

  const providerKey = (body.providerKey ?? '').trim()
  if (providerKey === 'builtin' || providerKey === '') {
    await resetToBuiltin()
    return NextResponse.json({ ok: true, active: null, engineSummary: 'Z.ai GLM-4.6（内置）' })
  }
  const meta = getProviderMeta(providerKey)
  if (!meta) {
    return NextResponse.json({ ok: false, error: `未知供应商：${providerKey}` }, { status: 400 })
  }

  const baseUrl = (body.baseUrl ?? '').trim() || meta.baseUrl
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
    return NextResponse.json({ ok: false, error: 'Base URL 必须以 http(s):// 开头' }, { status: 400 })
  }
  const model = (body.model ?? '').trim()
  if (!model) {
    return NextResponse.json({ ok: false, error: '请填写模型名' }, { status: 400 })
  }
  let apiKey = (body.apiKey ?? '').trim()
  // 未重新输入 Key 且此前已保存相同供应商的 Key → 沿用
  if (!apiKey && body.keepKey) {
    try {
      const prev = await db.llmConfig.findFirst({ where: { isActive: true, providerKey } })
      if (prev?.apiKey) apiKey = prev.apiKey
    } catch { /* 忽略 */ }
  }
  if (meta.needsKey && !apiKey && providerKey !== 'custom') {
    return NextResponse.json({ ok: false, error: `${meta.label} 需要 API Key` }, { status: 400 })
  }
  const label = (body.label ?? '').trim() || meta.label

  try {
    await db.llmConfig.deleteMany({})
    await db.llmConfig.create({
      data: { providerKey, label, baseUrl, apiKey: apiKey || null, model, isActive: true },
    })
  } catch (e) {
    return NextResponse.json({ ok: false, error: `配置保存失败：${e instanceof Error ? e.message : e}` }, { status: 500 })
  }
  invalidateLlmConfigCache()
  return NextResponse.json({ ok: true, active: { providerKey, label, model, baseUrl }, engineSummary: `${label} · ${model}` })
}

/** DELETE：恢复内置引擎 */
export async function DELETE() {
  await resetToBuiltin()
  return NextResponse.json({ ok: true, active: null, engineSummary: 'Z.ai GLM-4.6（内置）' })
}

async function resetToBuiltin(): Promise<void> {
  try {
    await db.llmConfig.deleteMany({})
  } catch { /* DB 故障不阻塞（缓存回退内置） */ }
  invalidateLlmConfigCache()
}
