/**
 * LLM 分析引擎供应商层 — 多供应商统一调用 + 配置持久化 + 模型列表获取。
 *
 * 协议支持：
 *  - zai        内置 z-ai-web-dev-sdk（默认，无需配置）
 *  - openai     OpenAI 兼容 chat/completions（OpenAI/DeepSeek/Qwen/GLM/Kimi/豆包/xAI/OpenRouter/Ollama/MiniMax/自定义）
 *  - anthropic  Anthropic Messages API（x-api-key + anthropic-version）
 *  - google     Google Gemini generateContent（x-goog-api-key）
 *
 * 内存策略：激活配置全局单例缓存（TTL 30s + 主动失效），API key 仅后端持有；
 * 模型列表响应截断 ≤300 条，防超大响应。
 */
import { db } from '@/lib/db'

// ─── 供应商注册表 ─────────────────────────────────────────────────────────────

export type ProviderProtocol = 'zai' | 'openai' | 'anthropic' | 'google'

export type ProviderKey =
  | 'builtin' | 'openai' | 'anthropic' | 'google' | 'deepseek' | 'qwen'
  | 'zhipu' | 'moonshot' | 'minimax' | 'doubao' | 'xai' | 'openrouter'
  | 'ollama' | 'custom'

export interface ProviderMeta {
  key: ProviderKey
  label: string
  /** 中文名/说明 */
  hint: string
  protocol: ProviderProtocol
  baseUrl: string
  /** chat 端点相对路径（openai 协议） */
  chatPath: string
  /** 模型列表端点相对路径；空串 = 不支持自动获取 */
  modelsPath: string
  needsKey: boolean
  defaultModel?: string
  modelsNote?: string
}

export const PROVIDERS: ProviderMeta[] = [
  { key: 'builtin', label: 'Z.ai GLM（内置）', hint: '默认引擎，开箱即用，无需 API Key', protocol: 'zai', baseUrl: '', chatPath: '', modelsPath: '', needsKey: false, defaultModel: 'glm-4.6' },
  { key: 'openai', label: 'OpenAI', hint: 'GPT-4o / GPT-4.1 / o3 等', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', chatPath: '/chat/completions', modelsPath: '/models', needsKey: true, defaultModel: 'gpt-4o' },
  { key: 'anthropic', label: 'Anthropic', hint: 'Claude Opus / Sonnet / Haiku', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', chatPath: '/v1/messages', modelsPath: '/v1/models', needsKey: true, defaultModel: 'claude-sonnet-4-20250514' },
  { key: 'google', label: 'Google Gemini', hint: 'Gemini 2.5 Pro / Flash', protocol: 'google', baseUrl: 'https://generativelanguage.googleapis.com', chatPath: '/v1beta/models', modelsPath: '/v1beta/models', needsKey: true, defaultModel: 'gemini-2.5-flash' },
  { key: 'deepseek', label: 'DeepSeek', hint: 'DeepSeek-V3 / R1（深度求索）', protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', chatPath: '/chat/completions', modelsPath: '/models', needsKey: true, defaultModel: 'deepseek-chat' },
  { key: 'qwen', label: '通义千问', hint: '阿里云百炼 DashScope 兼容模式', protocol: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', chatPath: '/chat/completions', modelsPath: '/models', needsKey: true, defaultModel: 'qwen-plus' },
  { key: 'zhipu', label: '智谱 GLM', hint: 'GLM-4.5 / GLM-4-Plus（BigModel）', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', chatPath: '/chat/completions', modelsPath: '/models', needsKey: true, defaultModel: 'glm-4-plus' },
  { key: 'moonshot', label: '月之暗面 Kimi', hint: 'Kimi k2 / moonshot-v1 系列', protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1', chatPath: '/chat/completions', modelsPath: '/models', needsKey: true, defaultModel: 'kimi-k2-0711-preview' },
  { key: 'minimax', label: 'MiniMax', hint: 'MiniMax-M1 / abab 系列', protocol: 'openai', baseUrl: 'https://api.minimaxi.com', chatPath: '/v1/text/chatcompletion_v2', modelsPath: '', needsKey: true, defaultModel: 'MiniMax-M1', modelsNote: '该供应商暂不支持自动获取模型列表，请参考其文档手动填写' },
  { key: 'doubao', label: '火山方舟 豆包', hint: 'Doubao / Ark endpoint 模型', protocol: 'openai', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', chatPath: '/chat/completions', modelsPath: '/models', needsKey: true, defaultModel: 'doubao-seed-1-6-250615' },
  { key: 'xai', label: 'xAI Grok', hint: 'Grok 4 / Grok 3', protocol: 'openai', baseUrl: 'https://api.x.ai/v1', chatPath: '/chat/completions', modelsPath: '/models', needsKey: true, defaultModel: 'grok-3' },
  { key: 'openrouter', label: 'OpenRouter', hint: '聚合 400+ 模型（含免费档）', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1', chatPath: '/chat/completions', modelsPath: '/models', needsKey: false, defaultModel: 'openai/gpt-4o-mini' },
  { key: 'ollama', label: 'Ollama 本地', hint: '本地部署模型（无需 Key）', protocol: 'openai', baseUrl: 'http://localhost:11434/v1', chatPath: '/chat/completions', modelsPath: '/models', needsKey: false, defaultModel: 'qwen3:8b' },
  { key: 'custom', label: '自定义', hint: '任意 OpenAI 兼容端点（vLLM/LM Studio/网关…）', protocol: 'openai', baseUrl: '', chatPath: '/chat/completions', modelsPath: '/models', needsKey: false },
]

export function getProviderMeta(key: string): ProviderMeta | null {
  return PROVIDERS.find(p => p.key === key) ?? null
}

// ─── 激活配置（内存单例缓存）──────────────────────────────────────────────────

export interface ActiveLlmConfig {
  providerKey: ProviderKey
  label: string
  baseUrl: string
  apiKey: string
  model: string
}

const CACHE_TTL_MS = 30_000
const g = globalThis as unknown as {
  __llmCfg?: { config: ActiveLlmConfig | null; loadedAt: number }
}

/** 读取激活配置（无 = 内置 z-ai）。DB 故障时静默回退内置。 */
export async function getActiveLlmConfig(): Promise<ActiveLlmConfig | null> {
  const c = g.__llmCfg
  if (c && Date.now() - c.loadedAt < CACHE_TTL_MS) return c.config
  let config: ActiveLlmConfig | null = null
  try {
    const row = await db.llmConfig.findFirst({ where: { isActive: true } })
    if (row) {
      const meta = getProviderMeta(row.providerKey)
      config = {
        providerKey: (meta?.key ?? 'custom') as ProviderKey,
        label: row.label || meta?.label || row.providerKey,
        baseUrl: row.baseUrl || meta?.baseUrl || '',
        apiKey: row.apiKey ?? '',
        model: row.model,
      }
    }
  } catch { /* DB 不可用 → 内置引擎兜底 */ }
  g.__llmCfg = { config, loadedAt: Date.now() }
  return config
}

/** 配置变更后立即失效缓存 */
export function invalidateLlmConfigCache(): void {
  g.__llmCfg = undefined
}

/** 当前引擎摘要（报告元数据/页脚展示用） */
export async function getEngineSummary(): Promise<string> {
  const cfg = await getActiveLlmConfig()
  if (!cfg) return 'Z.ai GLM-4.6（内置）'
  return `${cfg.label} · ${cfg.model}`
}

export function maskApiKey(key: string): string {
  if (!key) return ''
  if (key.length <= 8) return '••••'
  return `${key.slice(0, 3)}••••${key.slice(-4)}`
}

// ─── 统一 Chat 调用 ───────────────────────────────────────────────────────────

export interface UnifiedLlmResult {
  ok: boolean
  text: string
  error?: string
  durationMs: number
}

const CALL_TIMEOUT_MS = 180_000
const MAX_RETRIES = 6
const BASE_DELAY_MS = 4_000
/** 429 限流专用退避（秒）— 限流恢复需要更长等待 */
const RATE_LIMIT_DELAYS_MS = [20_000, 40_000, 60_000, 90_000, 120_000]

export interface ChatMessages {
  system: string
  user: string
  maxTokens?: number
  temperature?: number
}

/** 端点最小信息（ActiveLlmConfig 与临时 override 均满足） */
interface LlmEndpoint {
  baseUrl: string
  apiKey: string
  model: string
}

/**
 * 统一对话补全：按激活配置路由到对应协议。
 * 瞬态错误（429/5xx/超时）指数退避重试；400 参数不兼容做即时降级重试。
 */
export async function unifiedLlmChat(
  msgs: ChatMessages,
  signal?: AbortSignal,
  override?: { providerKey: string; baseUrl: string; apiKey: string; model: string },
): Promise<UnifiedLlmResult> {
  const t0 = Date.now()
  const cfg = (override ?? (await getActiveLlmConfig())) as (LlmEndpoint & { providerKey?: string }) | null
  const meta = getProviderMeta(cfg?.providerKey ?? 'builtin')
  const protocol: ProviderProtocol = cfg ? (meta?.protocol ?? 'openai') : 'zai'

  let lastErr = ''
  let rateLimitIdx = 0
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (signal?.aborted) return { ok: false, text: '', error: 'aborted', durationMs: 0 }
    try {
      const text = await callOnce(protocol, cfg, meta, msgs, signal)
      if (!text.trim()) throw new Error('LLM 返回空内容')
      return { ok: true, text: text.trim(), durationMs: Date.now() - t0 }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      lastErr = msg
      const isRateLimit = /\b429\b|too many requests|rate ?limit/i.test(msg)
      const transient = isRateLimit || /\boverloaded|temporarily|status 5\d\d|timeout|超时|ECONNRESET|ETIMEDOUT|fetch failed|content[_\s-]?filter|content policy|safety|moderation/i.test(msg)
      if (!transient || attempt === MAX_RETRIES - 1) break
      // 429 限流用专用长退避（20s/40s/60s/90s/120s），其他瞬态用指数退避（4s/8s/16s...）
      const delay = isRateLimit
        ? RATE_LIMIT_DELAYS_MS[Math.min(rateLimitIdx, RATE_LIMIT_DELAYS_MS.length - 1)]
        : BASE_DELAY_MS * Math.pow(2, attempt)
      rateLimitIdx++
      console.log(`[llm] 第 ${attempt + 1} 次重试（${isRateLimit ? '限流' : '瞬态'}，等 ${Math.round(delay / 1000)}s）：${msg.slice(0, 120)}`)
      await new Promise(r => setTimeout(r, delay))
    }
  }
  return { ok: false, text: '', error: lastErr || 'LLM 调用失败', durationMs: Date.now() - t0 }
}

/** 单次调用（无重试）。抛错带信息。 */
async function callOnce(
  protocol: ProviderProtocol,
  cfg: LlmEndpoint | null,
  meta: ProviderMeta | null,
  msgs: ChatMessages,
  signal?: AbortSignal,
): Promise<string> {
  const timeoutCtrl = new AbortController()
  const timer = setTimeout(() => timeoutCtrl.abort(), CALL_TIMEOUT_MS)
  const onCallerAbort = () => timeoutCtrl.abort()
  signal?.addEventListener('abort', onCallerAbort, { once: true })
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutCtrl.signal.addEventListener('abort', () => reject(new Error('LLM 调用超时')), { once: true })
  })
  try {
    if (protocol === 'zai') {
      // z-ai SDK 不支持 AbortSignal → 与超时 promise 竞态
      const text = await Promise.race([callZai(msgs), timeoutPromise])
      return text
    }
    if (!cfg) throw new Error('未配置外部 LLM 引擎')
    if (protocol === 'anthropic') return await callAnthropic(cfg, msgs, timeoutCtrl.signal)
    if (protocol === 'google') return await callGoogle(cfg, meta, msgs, timeoutCtrl.signal)
    return await callOpenaiCompat(cfg, meta, msgs, timeoutCtrl.signal)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onCallerAbort)
  }
}

// ─── 内置 z-ai SDK ────────────────────────────────────────────────────────────

type ZaiClient = Awaited<ReturnType<typeof import('z-ai-web-dev-sdk').default.create>>
const gz = globalThis as unknown as { __evalZai?: ZaiClient }

async function getZaiClient(): Promise<ZaiClient> {
  if (gz.__evalZai) return gz.__evalZai
  const ZAI = (await import('z-ai-web-dev-sdk')).default
  const client = await ZAI.create()
  gz.__evalZai = client
  return client
}

async function callZai(msgs: ChatMessages): Promise<string> {
  const zai = await getZaiClient()
  const resp = await zai.chat.completions.create({
    model: 'glm-4.6',
    messages: [
      { role: 'system', content: msgs.system },
      { role: 'user', content: msgs.user },
    ],
    thinking: { type: 'disabled' },
  })
  return resp.choices?.[0]?.message?.content ?? ''
}

// ─── OpenAI 兼容 ──────────────────────────────────────────────────────────────

function contentToString(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((c: { text?: string }) => (typeof c === 'string' ? c : String(c?.text ?? ''))).join('')
  }
  return ''
}

async function callOpenaiCompat(
  cfg: LlmEndpoint,
  meta: ProviderMeta | null,
  msgs: ChatMessages,
  abortSignal: AbortSignal,
): Promise<string> {
  const url = joinUrl(cfg.baseUrl, meta?.chatPath || '/chat/completions')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`

  const mkBody = (variant: 0 | 1 | 2) => {
    const body: Record<string, unknown> = {
      model: cfg.model,
      messages: [
        { role: 'system', content: msgs.system },
        { role: 'user', content: msgs.user },
      ],
    }
    if (variant !== 2) body.temperature = msgs.temperature ?? 0.4
    if (variant === 0) body.max_tokens = msgs.maxTokens ?? 8192
    if (variant === 1) body.max_completion_tokens = msgs.maxTokens ?? 8192
    return JSON.stringify(body)
  }

  // variant 0 常规；400 且提示参数不兼容 → 1（max_completion_tokens）/ 2（去掉采样参数）
  for (const variant of [0, 1, 2] as const) {
    const res = await fetch(url, { method: 'POST', headers, body: mkBody(variant), signal: abortSignal })
    if (res.ok) {
      const data = (await res.json().catch(() => null)) as {
        choices?: Array<{ message?: { content?: unknown } }>
      } | null
      const text = contentToString(data?.choices?.[0]?.message?.content)
      if (!text) throw new Error('LLM 返回空内容')
      return text
    }
    const errText = (await res.text().catch(() => '')).slice(0, 400)
    if (res.status === 400 && variant < 2) {
      if (/max_completion_tokens/i.test(errText) && variant === 0) continue
      if (/max_tokens/i.test(errText) || /temperature/i.test(errText) || /unsupported|unknown parameter|not supported/i.test(errText)) continue
    }
    throw new Error(`HTTP ${res.status} ${errText || res.statusText}`)
  }
  throw new Error('LLM 请求参数不被支持（已尝试降级重试）')
}

// ─── Anthropic Messages ───────────────────────────────────────────────────────

async function callAnthropic(
  cfg: LlmEndpoint,
  msgs: ChatMessages,
  abortSignal: AbortSignal,
): Promise<string> {
  const url = joinUrl(cfg.baseUrl, '/v1/messages')
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: msgs.maxTokens ?? 8192,
      temperature: msgs.temperature ?? 0.4,
      system: msgs.system,
      messages: [{ role: 'user', content: msgs.user }],
    }),
    signal: abortSignal,
  })
  if (!res.ok) {
    const errText = (await res.text().catch(() => '')).slice(0, 400)
    throw new Error(`HTTP ${res.status} ${errText || res.statusText}`)
  }
  const data = (await res.json().catch(() => null)) as {
    content?: Array<{ type?: string; text?: string }>
  } | null
  const text = (data?.content ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join('')
  if (!text) throw new Error('LLM 返回空内容')
  return text
}

// ─── Google Gemini ────────────────────────────────────────────────────────────

async function callGoogle(
  cfg: LlmEndpoint,
  meta: ProviderMeta | null,
  msgs: ChatMessages,
  abortSignal: AbortSignal,
): Promise<string> {
  const model = cfg.model.startsWith('models/') ? cfg.model.slice(7) : cfg.model
  const base = cfg.baseUrl || meta?.baseUrl || 'https://generativelanguage.googleapis.com'
  const url = `${base.replace(/\/$/, '')}/v1beta/models/${encodeURIComponent(model)}:generateContent`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': cfg.apiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: msgs.system }] },
      contents: [{ role: 'user', parts: [{ text: msgs.user }] }],
      generationConfig: {
        maxOutputTokens: msgs.maxTokens ?? 8192,
        temperature: msgs.temperature ?? 0.4,
      },
    }),
    signal: abortSignal,
  })
  if (!res.ok) {
    const errText = (await res.text().catch(() => '')).slice(0, 400)
    throw new Error(`HTTP ${res.status} ${errText || res.statusText}`)
  }
  const data = (await res.json().catch(() => null)) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
  } | null
  const text = (data?.candidates?.[0]?.content?.parts ?? []).map(p => p.text ?? '').join('')
  if (!text) throw new Error('LLM 返回空内容')
  return text
}

// ─── 模型列表 ─────────────────────────────────────────────────────────────────

export interface ModelInfo { id: string; label?: string }

const MAX_MODELS = 300
const MODELS_TIMEOUT_MS = 15_000

/** 拉取供应商模型列表（服务端执行，key 不经过前端）。 */
export async function fetchProviderModels(
  providerKey: string,
  baseUrlOverride?: string,
  apiKeyOverride?: string,
): Promise<{ ok: boolean; models: ModelInfo[]; error?: string }> {
  const meta = getProviderMeta(providerKey)
  if (!meta) return { ok: false, models: [], error: `未知供应商：${providerKey}` }
  if (providerKey === 'builtin') {
    return { ok: true, models: [{ id: 'glm-4.6', label: 'GLM-4.6（内置）' }] }
  }
  if (!meta.modelsPath) {
    return { ok: false, models: [], error: meta.modelsNote ?? '该供应商不支持自动获取模型列表，请手动填写模型名' }
  }
  const baseUrl = (baseUrlOverride?.trim() || meta.baseUrl).replace(/\/$/, '')
  if (!baseUrl) return { ok: false, models: [], error: '请先填写 API Base URL' }
  const key = apiKeyOverride ?? ''
  const url = joinUrl(baseUrl, meta.modelsPath)
  const headers: Record<string, string> = {}
  if (meta.protocol === 'anthropic') {
    headers['x-api-key'] = key
    headers['anthropic-version'] = '2023-06-01'
  } else if (meta.protocol === 'google') {
    headers['x-goog-api-key'] = key
  } else if (key) {
    headers.Authorization = `Bearer ${key}`
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), MODELS_TIMEOUT_MS)
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal })
    if (!res.ok) {
      const errText = (await res.text().catch(() => '')).slice(0, 240)
      return { ok: false, models: [], error: `HTTP ${res.status} ${errText || res.statusText}` }
    }
    const raw = (await res.text().catch(() => ''))
    if (raw.length > 2_000_000) return { ok: false, models: [], error: '模型列表响应过大' }
    const data = JSON.parse(raw) as {
      data?: Array<{ id?: string }>
      models?: Array<{ name?: string; displayName?: string; supportedGenerationMethods?: string[] }>
    } | null
    let models: ModelInfo[] = []
    if (Array.isArray(data?.data)) {
      // OpenAI 兼容 /models
      models = (data?.data ?? [])
        .map(m => ({ id: String(m.id ?? '') }))
        .filter(m => m.id)
    } else if (Array.isArray(data?.models)) {
      // Gemini /v1beta/models
      models = (data?.models ?? [])
        .filter(m => (m.supportedGenerationMethods ?? ['generateContent']).includes('generateContent'))
        .map(m => ({
          id: String(m.name ?? '').replace(/^models\//, ''),
          label: m.displayName,
        }))
        .filter(m => m.id)
    }
    if (!models.length) return { ok: false, models: [], error: '响应中未解析到模型列表' }
    // 体积防护 + 排序
    models = models.slice(0, MAX_MODELS)
    models.sort((a, b) => a.id.localeCompare(b.id))
    return { ok: true, models }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, models: [], error: /aborted|timeout/i.test(msg) ? '获取模型列表超时（15s）' : msg }
  } finally {
    clearTimeout(timer)
  }
}

// ─── 工具 ─────────────────────────────────────────────────────────────────────

function joinUrl(base: string, path: string): string {
  const b = (base || '').trim().replace(/\/+$/, '')
  const p = path.startsWith('/') ? path : `/${path}`
  if (/\/v1$|\/v3$|\/v4$/.test(b) && /^\/v\d/.test(p)) {
    // base 已带版本号而 path 也带版本号（如 anthropic 自定义 base）→ 仅保留一份
    return b + p.replace(/^\/v\d+(beta)?(?=\/)/, '')
  }
  return b + p
}
