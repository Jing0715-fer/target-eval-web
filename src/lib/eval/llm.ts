/**
 * LLM 调用封装（仅后端使用）。
 * v2：路由至 llm-provider 供应商层 — 内置 z-ai 或用户配置的
 * OpenAI 兼容 / Anthropic / Gemini 引擎，重试与超时统一在供应商层处理。
 */
import { unifiedLlmChat } from './llm-provider'

export interface LlmResult {
  ok: boolean
  text: string
  error?: string
  durationMs: number
}

/** 剥离推理模型内联思维块 */
export function stripReasoning(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .trim()
}

/**
 * 单次对话补全。prompt 为 user 消息，system 为系统提示。
 */
export async function llmChat(prompt: string, system: string, signal?: AbortSignal): Promise<LlmResult> {
  const r = await unifiedLlmChat({ system, user: prompt }, signal)
  return {
    ok: r.ok,
    text: r.ok ? stripReasoning(r.text) : '',
    error: r.error,
    durationMs: r.durationMs,
  }
}
