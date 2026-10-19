/**
 * 前端 API 访问层（相对路径 fetch）
 * 所有函数对失败抛出 Error，由调用方决定降级方式。
 */
import type {
  BatchReportInfo,
  DocxParsed,
  InsightsResponse,
  JobListItem,
  LlmConfigResponse,
  LlmModelsResponse,
  LlmTestResponse,
  RelationJudgment,
  SequenceAttribution,
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

/** 上传进度（分块上传 + 后台解析两阶段） */
export interface UploadProgress {
  /** uploading=分块传输中（0-100）；parsing=服务器解析中（不定进度） */
  phase: 'uploading' | 'parsing'
  /** 已上传字节 / 总字节（phase=parsing 时无意义） */
  loaded: number
  total: number
}

/** 分块大小（与服务端约定） */
const CHUNK_SIZE = 2 * 1024 * 1024
/** 单分块上传超时（网关 ALB ~30s 硬超时，留足余量） */
const CHUNK_TIMEOUT_MS = 28_000
/** 单分块最大重试次数 */
const CHUNK_RETRIES = 3
/** 解析轮询间隔 / 总预算 */
const POLL_INTERVAL_MS = 1500
const POLL_BUDGET_MS = 8 * 60_000

/** 解析状态响应（GET /api/evaluate/upload/status） */
interface SessionStatusResponse {
  ok: boolean
  uploadId: string
  phase: 'uploading' | 'queued' | 'parsing' | 'done' | 'error'
  parsed?: DocxParsed
  error?: string
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * 上传 Word 评估表 —— 分块 + 后台解析（公网网关 ~30s 超时对策）：
 *  1. init 创建会话（毫秒级）
 *  2. 2MB 分块 PUT（每块独立短请求，失败逐块重试）
 *  3. complete 触发后台解析（毫秒级返回）
 *  4. 轮询 status 直至 done/error
 * 返回与旧直传接口同构的结果，调用方渲染逻辑不变。
 */
export async function uploadEvaluateDocx(
  file: File,
  onProgress?: (p: UploadProgress) => void,
): Promise<UploadResponse> {
  // ── 1. init ──
  let uploadId = ''
  let chunkSize = CHUNK_SIZE
  {
    const res = await fetch('/api/evaluate/upload/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: file.name, size: file.size }),
    })
    const data = (await res.json().catch(() => null)) as { ok?: boolean; uploadId?: string; chunkSize?: number; error?: string } | null
    if (!res.ok || !data?.ok || !data.uploadId) {
      throw new Error(data?.error ?? `上传初始化失败（HTTP ${res.status}）`)
    }
    uploadId = data.uploadId
    chunkSize = data.chunkSize && data.chunkSize > 0 ? data.chunkSize : CHUNK_SIZE
  }

  // ── 2. chunks（严格顺序，失败重试） ──
  for (let offset = 0; offset < file.size; offset += chunkSize) {
    const blob = file.slice(offset, Math.min(offset + chunkSize, file.size))
    let lastErr: Error | null = null
    for (let attempt = 1; attempt <= CHUNK_RETRIES; attempt++) {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), CHUNK_TIMEOUT_MS)
      try {
        const res = await fetch(
          `/api/evaluate/upload/chunk?uploadId=${encodeURIComponent(uploadId)}&offset=${offset}`,
          { method: 'PUT', body: blob, signal: ctrl.signal },
        )
        const data = (await res.json().catch(() => null)) as { ok?: boolean; received?: number; error?: string } | null
        if (!res.ok || !data?.ok) {
          throw new Error(data?.error ?? `分块上传失败（HTTP ${res.status}）`)
        }
        lastErr = null
        break
      } catch (e) {
        lastErr = e instanceof Error ? e : new Error(String(e))
        if (attempt < CHUNK_RETRIES) await sleep(800 * attempt)
      } finally {
        clearTimeout(timer)
      }
    }
    if (lastErr) {
      throw new Error(`分块上传失败（已重试 ${CHUNK_RETRIES} 次）：${lastErr.message}。请检查网络后重试`)
    }
    onProgress?.({ phase: 'uploading', loaded: Math.min(offset + chunkSize, file.size), total: file.size })
  }

  // ── 3. complete（触发后台解析） ──
  {
    const res = await fetch('/api/evaluate/upload/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId }),
    })
    const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null
    if (!res.ok || !data?.ok) {
      throw new Error(data?.error ?? `完成上传失败（HTTP ${res.status}）`)
    }
  }
  onProgress?.({ phase: 'parsing', loaded: file.size, total: file.size })

  // ── 4. poll status ──
  const deadline = Date.now() + POLL_BUDGET_MS
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error('解析超时（超过 8 分钟），请稍后在历史中查看或重新上传')
    }
    await sleep(POLL_INTERVAL_MS)
    let st: SessionStatusResponse | null = null
    try {
      const res = await fetch(`/api/evaluate/upload/status?uploadId=${encodeURIComponent(uploadId)}`, { cache: 'no-store' })
      st = (await res.json()) as SessionStatusResponse
      if (!res.ok || !st?.ok) {
        throw new Error((st as { error?: string } | null)?.error ?? `状态查询失败（HTTP ${res.status}）`)
      }
    } catch (e) {
      // 单次轮询失败（网络抖动）不致命，继续
      void e
      continue
    }
    if (st.phase === 'done' && st.parsed) {
      return { ok: true, uploadId: st.uploadId, parsed: st.parsed, error: st.error }
    }
    if (st.phase === 'error') {
      throw new Error(st.error ?? '文档解析失败')
    }
    // uploading/queued/parsing → 继续轮询
  }
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

// ─── 靶点关系判断 + 合并报告（v1.8 批量评估）─────────────────

/** POST /api/evaluate/relation — 批量评估前的靶点关系判断（v1.10：附带序列归属） */
export interface RelationJudgeResponse {
  judgment: RelationJudgment
  sequenceAttribution?: SequenceAttribution[]
}

export async function judgeTargetRelation(input: {
  uploadId: string
  uniprots: string[]
  goal?: string
}): Promise<RelationJudgeResponse> {
  const res = await fetch('/api/evaluate/relation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const data = (await res.json().catch(() => null)) as {
    ok?: boolean
    judgment?: RelationJudgment
    sequenceAttribution?: SequenceAttribution[]
    error?: string
  } | null
  if (!res.ok || !data?.ok || !data.judgment) {
    throw new Error(data?.error ?? `关系判断失败（HTTP ${res.status}）`)
  }
  return { judgment: data.judgment, sequenceAttribution: data.sequenceAttribution }
}

/** POST /api/evaluate/batch-report — 关联靶点全部完成后生成合并评估报告
 *  v1.12：后端异步生成（LLM 三段式分钟级），POST 立即返回 running，
 *  此处轮询 GET 直到终态（done / error），期间 UI 保持"生成中"状态。 */
export async function generateBatchReport(input: {
  jobIds: string[]
  uploadId?: string
  relation: RelationJudgment
  goal?: string
}): Promise<BatchReportInfo> {
  const res = await fetch('/api/evaluate/batch-report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const data = (await res.json().catch(() => null)) as { ok?: boolean; batchReport?: BatchReportInfo; error?: string } | null
  if (!res.ok || !data?.ok || !data.batchReport) {
    throw new Error(data?.error ?? `合并报告生成失败（HTTP ${res.status}）`)
  }
  const started = data.batchReport
  if (started.status !== 'running') return started // 兼容即时完成的响应
  return waitForBatchReport(started.id)
}

/** 轮询合并报告直到终态（done 返回完整数据；error 抛错；超时 15 分钟）
 *  单次网络抖动不中断轮询（连续失败由超时兜底） */
export async function waitForBatchReport(id: string): Promise<BatchReportInfo> {
  const deadline = Date.now() + 15 * 60 * 1000
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 3000))
    let r: BatchReportInfo
    try {
      r = await fetchBatchReport(id)
    } catch {
      continue // 瞬时网络错误 → 继续轮询（超时兜底）
    }
    if (r.status === 'error') {
      throw new Error(r.error || '合并报告生成失败')
    }
    if (r.status === 'done') {
      // LLM 全失败时 markdown 为空但 status=done — 返回降级结果（视图展示错误提示）
      return r
    }
    // running → 继续轮询
  }
  throw new Error('合并报告生成超时（15 分钟）— 生成可能仍在后台进行，请稍后通过历史记录查看')
}

/** GET /api/evaluate/batch-report?id= — 查询合并报告（历史/刷新恢复） */
export async function fetchBatchReport(id: string): Promise<BatchReportInfo> {
  const res = await fetch(`/api/evaluate/batch-report?id=${encodeURIComponent(id)}`, { cache: 'no-store' })
  const data = (await res.json().catch(() => null)) as { ok?: boolean; batchReport?: BatchReportInfo; error?: string } | null
  if (!res.ok || !data?.ok || !data.batchReport) {
    throw new Error(data?.error ?? `合并报告读取失败（HTTP ${res.status}）`)
  }
  return data.batchReport
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
