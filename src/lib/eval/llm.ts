/**
 * z-ai-web-dev-sdk LLM 封装（仅后端使用）。
 * - 单例 ZAI 客户端
 * - 瞬态错误（429/5xx）指数退避重试 2 次
 * - 90s 硬超时（race），防单次调用挂死阻塞作业
 */
import type zai from 'z-ai-web-dev-sdk'

type ZaiClient = Awaited<ReturnType<typeof zai.create>>

const g = globalThis as unknown as { __evalZai?: ZaiClient }

async function getClient(): Promise<ZaiClient> {
  if (g.__evalZai) return g.__evalZai
  const ZAI = (await import('z-ai-web-dev-sdk')).default
  const client = await ZAI.create()
  g.__evalZai = client
  return client
}

const CALL_TIMEOUT_MS = 120_000

export interface LlmResult {
  ok: boolean
  text: string
  error?: string
  durationMs: number
}

/**
 * 单次对话补全。prompt 为 user 消息，system 为系统提示。
 */
export async function llmChat(prompt: string, system: string, signal?: AbortSignal): Promise<LlmResult> {
  const t0 = Date.now()
  const MAX_RETRIES = 3
  const BASE_DELAY = 4_000
  let lastErr = ''

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (signal?.aborted) return { ok: false, text: '', error: 'aborted', durationMs: 0 }
    try {
      const zai = await getClient()
      const timeoutCtrl = new AbortController()
      const timer = setTimeout(() => timeoutCtrl.abort(), CALL_TIMEOUT_MS)
      const onCallerAbort = () => timeoutCtrl.abort()
      signal?.addEventListener('abort', onCallerAbort, { once: true })
      try {
        const resp = await Promise.race([
          zai.chat.completions.create({
            model: 'glm-4.6',
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: prompt },
            ],
            thinking: { type: 'disabled' },
          }),
          new Promise<never>((_, reject) =>
            timeoutCtrl.signal.addEventListener('abort', () => reject(new Error('LLM 调用超时')), { once: true })),
        ])
        const text = resp.choices?.[0]?.message?.content ?? ''
        if (!text.trim()) throw new Error('LLM 返回空内容')
        return { ok: true, text: stripReasoning(text), durationMs: Date.now() - t0 }
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onCallerAbort)
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      lastErr = msg
      const transient = /\b429\b|too many requests|rate ?limit|overloaded|temporarily|status 5\d\d|timeout|超时/i.test(msg)
      if (!transient || attempt === MAX_RETRIES - 1) break
      await new Promise(r => setTimeout(r, BASE_DELAY * Math.pow(2, attempt)))
    }
  }
  return { ok: false, text: '', error: lastErr || 'LLM 调用失败', durationMs: Date.now() - t0 }
}

/** 剥离推理模型内联思维块 */
export function stripReasoning(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .trim()
}
