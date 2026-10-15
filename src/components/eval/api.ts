/**
 * 前端 API 访问层（相对路径 fetch）
 * 所有函数对失败抛出 Error，由调用方决定降级方式。
 */
import type {
  InsightsResponse,
  JobListItem,
  LlmConfigResponse,
  LlmModelsResponse,
  LlmTestResponse,
  UploadResponse,
} from './types'

/** GET /api/jobs — 最近作业列表 */
export async function fetchJobList(): Promise<JobListItem[]> {
  const res = await fetch('/api/jobs', { cache: 'no-store' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json().catch(() => null)
  if (!Array.isArray(data)) throw new Error('响应格式错误')
  return data as JobListItem[]
}

/** DELETE /api/jobs/[id] — 取消/删除作业 */
export async function deleteJobById(id: string): Promise<void> {
  const res = await fetch(`/api/jobs/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

/** POST /api/evaluate/upload — 上传 Word 评估表（multipart: file） */
export async function uploadEvaluateDocx(file: File): Promise<UploadResponse> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch('/api/evaluate/upload', { method: 'POST', body: form })
  let data: (UploadResponse & { error?: string }) | null = null
  try {
    data = (await res.json()) as UploadResponse & { error?: string }
  } catch {
    data = null
  }
  if (!res.ok || !data || !data.ok || !data.parsed) {
    throw new Error(data?.error ?? `上传解析失败（HTTP ${res.status}）`)
  }
  return data
}

/** POST /api/evaluate/insights — 对已上传评估表执行 LLM 智能解析 */
export async function fetchDocxInsights(uploadId: string, force = false): Promise<InsightsResponse> {
  const res = await fetch('/api/evaluate/insights', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId, force }),
  })
  let data: InsightsResponse | null = null
  try {
    data = (await res.json()) as InsightsResponse
  } catch {
    data = null
  }
  if (!res.ok || !data || !data.ok || !data.insights) {
    throw new Error(data?.error ?? `智能解析失败（HTTP ${res.status}）`)
  }
  return data
}

// ─── LLM 引擎配置 ──────────────────────────────────────────────

/** GET /api/llm/config — 当前引擎配置 + 供应商列表 */
export async function fetchLlmConfig(): Promise<LlmConfigResponse> {
  const res = await fetch('/api/llm/config', { cache: 'no-store' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = (await res.json().catch(() => null)) as LlmConfigResponse | null
  if (!data || !data.ok) throw new Error('配置读取失败')
  return data
}

export interface SaveLlmConfigInput {
  providerKey: string
  baseUrl: string
  apiKey: string
  model: string
  /** apiKey 为空时沿用已保存的相同供应商 Key */
  keepKey?: boolean
}

/** POST /api/llm/config — 保存并启用引擎配置 */
export async function saveLlmConfig(input: SaveLlmConfigInput): Promise<LlmConfigResponse> {
  const res = await fetch('/api/llm/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const data = (await res.json().catch(() => null)) as (LlmConfigResponse & { error?: string }) | null
  if (!res.ok || !data || !data.ok) {
    throw new Error(data?.error ?? `保存失败（HTTP ${res.status}）`)
  }
  return data
}

/** DELETE /api/llm/config — 恢复内置引擎 */
export async function resetLlmConfig(): Promise<LlmConfigResponse> {
  const res = await fetch('/api/llm/config', { method: 'DELETE' })
  const data = (await res.json().catch(() => null)) as (LlmConfigResponse & { error?: string }) | null
  if (!res.ok || !data || !data.ok) {
    throw new Error(data?.error ?? `恢复默认失败（HTTP ${res.status}）`)
  }
  return data
}

/** POST /api/llm/models — 拉取供应商模型列表 */
export async function fetchLlmModels(input: {
  providerKey: string
  baseUrl: string
  apiKey: string
}): Promise<LlmModelsResponse> {
  const res = await fetch('/api/llm/models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const data = (await res.json().catch(() => null)) as LlmModelsResponse | null
  if (!res.ok || !data || !data.ok || !data.models) {
    throw new Error(data?.error ?? `获取模型列表失败（HTTP ${res.status}）`)
  }
  return data
}

/** POST /api/llm/test — 测试引擎连通性 */
export async function testLlmConnection(input: {
  providerKey: string
  baseUrl: string
  apiKey: string
  model: string
}): Promise<LlmTestResponse> {
  const res = await fetch('/api/llm/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const data = (await res.json().catch(() => null)) as LlmTestResponse | null
  if (!data) throw new Error(`测试请求失败（HTTP ${res.status}）`)
  if (!data.ok) throw new Error(data.error ?? '测试失败')
  return data
}
