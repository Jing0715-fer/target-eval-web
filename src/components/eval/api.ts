/**
 * 前端 API 访问层（相对路径 fetch）
 * 所有函数对失败抛出 Error，由调用方决定降级方式。
 */
import type {
  BatchReportInfo,
  BatchReportListItem,
  DocxParsed,
  EvaluateRequest,
  FormInsights,
  InsightsResponse,
  JobDetail,
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

// ─── v2.4 无状态部署检测与记忆 ─────────────────────────────────────────────

/**
 * 无状态（函数计算）部署标记：分块上传会话跨请求不可见时置位并持久化到
 * localStorage（key=te_stateless）。后续上传/评估直接走无状态通道，避免
 * 每次都先撞一次「会话不存在」再回退。仅影响本浏览器；部署环境换回有状态
 * （本地/容器）时不会读到该标记。
 */
const STATELESS_KEY = 'te_stateless'
let statelessCached: boolean | null = null

export function isStatelessEnv(): boolean {
  if (statelessCached != null) return statelessCached
  if (typeof window === 'undefined') return false
  try {
    statelessCached = window.localStorage.getItem(STATELESS_KEY) === '1'
  } catch {
    statelessCached = false
  }
  return statelessCached
}

export function markStatelessEnv(): void {
  statelessCached = true
  try {
    window.localStorage.setItem(STATELESS_KEY, '1')
  } catch { /* 隐私模式等场景静默降级（仅内存记忆） */ }
}

/** （调试/部署切换）清除无状态标记 */
export function clearStatelessEnv(): void {
  statelessCached = false
  try {
    window.localStorage.removeItem(STATELESS_KEY)
  } catch { /* ignore */ }
}

// ─── v2.4 LLM 引擎配置内存暂存（无状态部署用） ────────────────────────────

/**
 * 无状态部署中 SQLite 不跨请求保留，用户保存的引擎配置读不回来。
 * 配置面板保存时把原始配置（含 Key）暂存在内存（不落盘），
 * 同步评估请求内联携带。仅本页面会话内有效。
 */
export interface LlmEngineOverride {
  providerKey: string
  baseUrl?: string
  apiKey?: string
  model: string
}

let llmOverride: LlmEngineOverride | null = null

export function setLlmEngineOverride(cfg: LlmEngineOverride | null): void {
  llmOverride = cfg
}

export function getLlmEngineOverride(): LlmEngineOverride | null {
  return llmOverride
}

/** 会话丢失（无状态部署：分块会话落在了被回收的实例上）→ 触发直传回退 */
function isSessionLost(msg: string): boolean {
  return msg.includes('上传会话不存在') || msg.includes('上传会话已过期') || msg.includes('无权访问该上传会话')
}
/**
 * v2.3 直传回退通道：单请求完成上传 + 解析 + 返回全部结果（fullText 内联）。
 * 用于无状态部署（函数计算快照等，服务器数据不跨请求保留）：分块会话在那种
 * 环境下必然 404 —— 检测到后自动改走此通道，跳过 VLM（关键词分类兜底）以
 * 保证网关短超时内可完成。
 */
async function uploadEvaluateDocxDirect(file: File, onProgress?: (p: UploadProgress) => void): Promise<UploadResponse> {
  onProgress?.({ phase: 'uploading', loaded: 0, total: file.size })
  const form = new FormData()
  form.append('file', file)
  const res = await fetch('/api/evaluate/upload?stateless=1&noVlm=1', {
    method: 'POST',
    body: form,
  })
  const data = (await res.json().catch(() => null)) as (UploadResponse & { error?: string }) | null
  if (!res.ok || !data?.ok || !data.parsed) {
    throw new Error(data?.error ?? `上传解析失败（HTTP ${res.status}）`)
  }
  onProgress?.({ phase: 'parsing', loaded: file.size, total: file.size })
  return data
}

/**
 * 上传 Word 评估表 —— 分块 + 后台解析（公网网关 ~30s 超时对策）：
 *  1. init 创建会话（毫秒级）
 *  2. 2MB 分块 PUT（每块独立短请求，失败逐块重试）
 *  3. complete 触发后台解析（毫秒级返回）
 *  4. 轮询 status 直至 done/error
 * v2.3：会话在任意阶段丢失（无状态部署）→ 立即自动回退单请求直传
 * （不再重试分块 — 该环境下重试必然同样失败，直接换通道最快）。
 * 返回与旧直传接口同构的结果，调用方渲染逻辑不变。
 */
export async function uploadEvaluateDocx(
  file: File,
  onProgress?: (p: UploadProgress) => void,
): Promise<UploadResponse> {
  // v2.4：已确认无状态环境 → 直接走直传（不再先撞分块会话 404）
  if (isStatelessEnv()) {
    return uploadEvaluateDocxDirect(file, onProgress)
  }
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
  // ── 2. chunks（严格顺序；会话丢失 → 直传回退） ──
  for (let offset = 0; offset < file.size; offset += chunkSize) {
    const blob = file.slice(offset, Math.min(offset + chunkSize, file.size))
    let lastErr: Error | null = null
    let sessionLost = false
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
          const msg = data?.error ?? `分块上传失败（HTTP ${res.status}）`
          if (isSessionLost(msg)) {
            sessionLost = true // 环境不保留会话：换通道，重试无意义
            markStatelessEnv() // v2.4：记住无状态环境，后续直接直传
            break
          }
          throw new Error(msg)
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
    if (sessionLost) {
      return uploadEvaluateDocxDirect(file, onProgress)
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
      const msg = data?.error ?? `完成上传失败（HTTP ${res.status}）`
      if (isSessionLost(msg)) {
        markStatelessEnv()
        return uploadEvaluateDocxDirect(file, onProgress)
      }
      throw new Error(msg)
    }
  }
  onProgress?.({ phase: 'parsing', loaded: file.size, total: file.size })

  // ── 4. poll status（会话丢失 → 直传回退） ──
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
        const msg = (st as { error?: string } | null)?.error ?? `状态查询失败（HTTP ${res.status}）`
        if (isSessionLost(msg)) {
          markStatelessEnv()
          return uploadEvaluateDocxDirect(file, onProgress)
        }
        throw new Error(msg)
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

/**
 * POST /api/evaluate/insights — 对已上传评估表执行 LLM 智能解析。
 * v2.3：无状态模式（直传回退产物）由前端内联携带全文（text + goalHints），
 * 不依赖服务器磁盘；有状态部署仍走 uploadId 磁盘缓存路径。
 */
export async function fetchDocxInsights(
  uploadId: string,
  force = false,
  inline?: { text: string; goalHints?: string[] },
): Promise<InsightsResponse> {
  const body: Record<string, unknown> = inline
    ? { text: inline.text, goalHints: inline.goalHints ?? [], force }
    : { uploadId, force }
  // v2.6 流式：NDJSON 心跳保活（修复部署网关 ~30s 空闲切断导致的 HTTP 502 —
  // 旧版一次性 JSON 在冷启动 + LLM 慢时撞线）。流中断自动重试一次（实例已热）。
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchInsightsStream(body)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (attempt === 0 && STREAM_BROKEN_RE.test(msg)) continue // 断流重试（一次）
      throw err
    }
  }
}

/** 断流类错误识别（自动重试一次）；其余错误（4xx 语义错误等）直接抛出 */
const STREAM_BROKEN_RE = /流中断|网络|Stream broken|HTTP 5\d\d/

async function fetchInsightsStream(body: Record<string, unknown>): Promise<InsightsResponse> {
  const res = await fetch('/api/evaluate/insights', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  // 快速失败（参数/权限校验 4xx）仍为普通 JSON 错误响应
  if (!res.ok || !res.body) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(err?.error ?? `智能解析失败（HTTP ${res.status}）`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl = buffer.indexOf('\n')
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (line) {
        let ev: { type?: string; ok?: boolean; insights?: FormInsights; cached?: boolean; note?: string; error?: string } | null = null
        try {
          ev = JSON.parse(line)
        } catch { ev = null /* 半行/坏行丢弃，等下一块补齐 */ }
        if (ev?.type === 'done') {
          if (!ev.ok || !ev.insights) {
            throw new Error(ev.error ?? '智能解析失败')
          }
          return { ok: true, insights: ev.insights, cached: ev.cached, note: ev.note }
        }
        // ping 心跳：仅保活
      }
      nl = buffer.indexOf('\n')
    }
  }
  throw new Error('智能解析流中断（网络波动），正在自动重试…')
}

// ─── 靶点关系判断 + 合并报告（v1.8 批量评估）─────────────────

/** POST /api/evaluate/relation — 批量评估前的靶点关系判断（v1.10：附带序列归属） */
export interface RelationJudgeResponse {
  judgment: RelationJudgment
  sequenceAttribution?: SequenceAttribution[]
}

export async function judgeTargetRelation(input: {
  /** v1.22：UniProt/序列多输入模式无 uploadId — 可选 */
  uploadId?: string
  uniprots: string[]
  goal?: string
  /** v2.4 无状态部署：评估表序列与目标提示内联携带（服务器磁盘读不到时回退） */
  sequences?: Array<{ header: string; seq: string; length: number }>
  goalHints?: string[]
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

/** GET /api/evaluate/batch-report（无 id）— 当前用户的合并报告列表（v1.13 批量评估历史） */
export async function fetchBatchReportList(): Promise<BatchReportListItem[]> {
  const res = await fetch('/api/evaluate/batch-report', { cache: 'no-store' })
  const data = (await res.json().catch(() => null)) as { ok?: boolean; items?: BatchReportListItem[]; error?: string } | null
  if (!res.ok || !data?.ok || !Array.isArray(data.items)) {
    throw new Error(data?.error ?? `合并报告列表读取失败（HTTP ${res.status}）`)
  }
  return data.items
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

// ─── v2.4 无状态同步流式评估 ─────────────────────────────────────────────────

/** 同步评估请求体（EvaluateRequest 的无状态超集） */
export type SyncEvaluateBody = EvaluateRequest & {
  /** 引擎配置覆写（无状态部署 DB 不保留，前端内联携带） */
  llm?: LlmEngineOverride
}

/** 同步评估最终结果（done 事件） */
export interface SyncEvaluateResult {
  job: JobDetail
  reportHtml: string | null
}

/**
 * POST /api/evaluate/sync — 无状态部署的同步流式评估（v2.6 分段续跑）。
 * 每段读取 NDJSON 事件流：job 进度事件回调 onProgress；checkpoint = 本段预算
 * 到点（服务端交还续跑快照）→ 立即携快照再发一段继续，直至 done/error 终态。
 * abort 信号触发时中止请求（服务器同步中止管线）。
 * 段上限防呆（MAX_SEGMENTS）：异常循环时最终以流中断错误终止。
 */
const SYNC_MAX_SEGMENTS = 90 // ≈90 段 × ~55s ≈ 80 分钟总预算（超过视为异常）

export async function evaluateSyncStream(
  body: SyncEvaluateBody,
  opts: {
    onProgress?: (job: JobDetail) => void
    signal?: AbortSignal
  } = {},
): Promise<SyncEvaluateResult> {
  // 引擎配置覆写（内存暂存的原始配置随请求内联携带 — 每段都带）
  const llm = getLlmEngineOverride()
  let checkpoint: unknown | undefined

  for (let segment = 0; ; segment++) {
    const payload: SyncEvaluateBody = { ...body }
    if (llm && !payload.llm) payload.llm = llm
    if (checkpoint) (payload as { checkpoint?: unknown }).checkpoint = checkpoint

    const res = await fetch('/api/evaluate/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: opts.signal,
    })

    if (!res.ok || !res.body) {
      const err = (await res.json().catch(() => null)) as { error?: string } | null
      throw new Error(err?.error ?? `同步评估启动失败（HTTP ${res.status}）`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let result: SyncEvaluateResult | null = null
    let streamError: string | null = null
    let nextCheckpoint: unknown | null = null

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // 按行解析 NDJSON 事件
      let nl = buffer.indexOf('\n')
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (line) {
          try {
            const ev = JSON.parse(line) as {
              type: 'job' | 'ping' | 'done' | 'error' | 'checkpoint'
              job?: JobDetail
              reportHtml?: string | null
              error?: string
              checkpoint?: unknown
            }
            if (ev.type === 'job' && ev.job) {
              opts.onProgress?.(ev.job)
            } else if (ev.type === 'done' && ev.job) {
              result = { job: ev.job, reportHtml: ev.reportHtml ?? null }
            } else if (ev.type === 'error') {
              streamError = ev.error ?? '评估失败'
              if (ev.job) opts.onProgress?.(ev.job)
            } else if (ev.type === 'checkpoint' && ev.checkpoint) {
              // v2.6：本段到点 — 携快照进入下一段（对调用方完全透明）
              nextCheckpoint = ev.checkpoint
              if (ev.job) opts.onProgress?.(ev.job)
            }
            // ping 心跳：仅保活，无需处理
          } catch { /* 半行/坏行丢弃，等下一块补齐 */ }
        }
        nl = buffer.indexOf('\n')
      }
      if (result || streamError || nextCheckpoint) break
    }

    if (result) return result
    if (streamError) throw new Error(streamError)
    if (nextCheckpoint) {
      checkpoint = nextCheckpoint
      if (segment + 1 >= SYNC_MAX_SEGMENTS) {
        throw new Error('评估续跑段数超限（异常循环）— 请重试；若持续出现请稍后再试')
      }
      continue // 立即再发一段
    }
    // 流中断且无终态（网关切断/超时）
    throw new Error('评估流中断（网络或网关超时）。已完成的部分数据已丢失，请重试；若持续出现，请减少并发或稍后再试。')
  }
}
