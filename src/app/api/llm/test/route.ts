/**
 * POST /api/llm/test — 测试 LLM 连通性（极小 prompt，≤16 token 输出）。
 * body: { providerKey?, baseUrl?, apiKey?, model?, useActive? }
 */
import { NextResponse } from 'next/server'
import { getActiveLlmConfig, getProviderMeta, unifiedLlmChat } from '@/lib/eval/llm-provider'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface TestBody {
  providerKey?: string
  baseUrl?: string
  apiKey?: string
  model?: string
  useActive?: boolean
}

const TEST_TIMEOUT_MS = 45_000

export async function POST(req: Request) {
  let body: TestBody
  try {
    body = (await req.json()) as TestBody
  } catch {
    return NextResponse.json({ ok: false, error: '请求体不是合法 JSON' }, { status: 400 })
  }

  let override: { providerKey: string; baseUrl: string; apiKey: string; model: string } | undefined
  if (!body.useActive) {
    const providerKey = (body.providerKey ?? '').trim()
    if (!providerKey) {
      return NextResponse.json({ ok: false, error: '缺少 providerKey' }, { status: 400 })
    }
    if (providerKey === 'builtin') {
      // 内置引擎直接测
    } else {
      const meta = getProviderMeta(providerKey)
      if (!meta) return NextResponse.json({ ok: false, error: `未知供应商：${providerKey}` }, { status: 400 })
      const baseUrl = (body.baseUrl ?? '').trim() || meta.baseUrl
      const model = (body.model ?? '').trim() || meta.defaultModel || ''
      if (!baseUrl) return NextResponse.json({ ok: false, error: '请先填写 Base URL' }, { status: 400 })
      if (!model) return NextResponse.json({ ok: false, error: '请先填写模型名' }, { status: 400 })
      override = { providerKey, baseUrl, apiKey: (body.apiKey ?? '').trim(), model }
    }
  } else {
    const cfg = await getActiveLlmConfig()
    if (!cfg) {
      // 内置
    } else {
      override = { providerKey: cfg.providerKey, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model }
    }
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TEST_TIMEOUT_MS)
  try {
    const r = await unifiedLlmChat(
      {
        system: '你是连通性测试助手。只输出指定内容，不要任何多余文字。',
        user: '请原样输出：OK',
        maxTokens: 16,
        temperature: 0,
      },
      ctrl.signal,
      override,
    )
    if (!r.ok) {
      return NextResponse.json({ ok: false, error: r.error ?? '测试失败' })
    }
    return NextResponse.json({
      ok: true,
      latencyMs: r.durationMs,
      reply: r.text.slice(0, 60),
    })
  } finally {
    clearTimeout(timer)
  }
}
