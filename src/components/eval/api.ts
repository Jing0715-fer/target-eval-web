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
import type { ImportedReportStats } from '@/lib/eval/types'
import {
  migrateMinimaxDomesticDefault,
  migrateMinimaxEndpoint,
  type LocalEngineStore,
} from './llm-store-migration'
import { getCachedJobDetail } from './job-cache'
import { APP_VERSION } from '@/lib/version'

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

// ─── v2.19 LLM 引擎配置 — 浏览器本地存储（仅本人可用） ──────────────────────

/**
 * v2.19：引擎配置（含 API Key）保存在浏览器 localStorage，按供应商分条保存 —
 * 切换供应商再切回时自动回填 Key；评估/合并报告请求内联携带（服务端不落盘，
 * 请求结束即弃）。旧版（v2.4~v2.18）曾把 Key 存服务端 SQLite 且全局共享
 * （任一用户保存的 Key 驱动所有人评估），已废弃 — 服务端存量惰性清除。
 */

export interface LlmEngineOverride {
  providerKey: string
  label?: string
  baseUrl?: string
  apiKey?: string
  model: string
}

const LOCAL_ENGINE_KEY = 'te_llm_engine_v1'

function readEngineStore(): LocalEngineStore {
  if (typeof window === 'undefined') return { active: null, providers: {} }
  try {
    const raw = window.localStorage.getItem(LOCAL_ENGINE_KEY)
    if (!raw) return { active: null, providers: {} }
    const parsed = JSON.parse(raw) as LocalEngineStore
    if (!parsed || typeof parsed !== 'object' || typeof parsed.providers !== 'object') return { active: null, providers: {} }
    const s: LocalEngineStore = { active: typeof parsed.active === 'string' ? parsed.active : null, providers: parsed.providers ?? {} }
    // v2.20/v2.20.1：MiniMax 端点迁移（两条均幂等，仅状态匹配时写回；纯函数见 ./llm-store-migration）
    if (migrateMinimaxEndpoint(s) || migrateMinimaxDomesticDefault(s)) writeEngineStore(s)
    return s
  } catch {
    return { active: null, providers: {} }
  }
}

function writeEngineStore(s: LocalEngineStore): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(LOCAL_ENGINE_KEY, JSON.stringify(s))
  } catch { /* 隐私模式/存储满 → 忽略（本次会话仍可用内存态） */ }
}

/** 当前生效引擎（激活供应商的本地配置；无 = 内置）— 评估请求自动内联携带 */
export function getLlmEngineOverride(): LlmEngineOverride | null {
  const s = readEngineStore()
  if (!s.active || s.active === 'builtin') return null
  const e = s.providers[s.active]
  if (!e || !e.model) return null
  return { providerKey: s.active, label: e.label, baseUrl: e.baseUrl, apiKey: e.apiKey, model: e.model }
}

/** 保存并激活引擎（写入 localStorage，按供应商分条；cfg=null 仅恢复内置 —
 *  各供应商已保存的配置保留，切回时自动回填 Key） */
export function setLlmEngineOverride(cfg: LlmEngineOverride | null): void {
  const s = readEngineStore()
  if (!cfg) {
    s.active = null
    writeEngineStore(s)
    return
  }
  s.active = cfg.providerKey
  s.providers[cfg.providerKey] = {
    label: cfg.label,
    baseUrl: (cfg.baseUrl ?? '').trim(),
    apiKey: (cfg.apiKey ?? '').trim(),
    model: cfg.model.trim(),
    savedAt: Date.now(),
  }
  writeEngineStore(s)
}

/** 读取指定供应商的本地保存配置（面板切换供应商时预填/切回自动回填 Key） */
export function getEngineProviderEntry(providerKey: string): { label?: string; baseUrl: string; apiKey: string; model: string } | null {
  const e = readEngineStore().providers[providerKey]
  if (!e) return null
  return { label: e.label, baseUrl: e.baseUrl ?? '', apiKey: e.apiKey ?? '', model: e.model ?? '' }
}

/** 当前引擎摘要（页眉/页脚展示；无本地配置 = 内置） */
export function getLocalEngineSummary(): string {
  const cfg = getLlmEngineOverride()
  if (!cfg) return 'Z.ai GLM-4.6（内置）'
  return `${cfg.label || cfg.providerKey} · ${cfg.model}`
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
 * v2.6.2 三级降级：流式（LLM）→ 流式重试 → quick 快速兜底（跳过 LLM 规则提取），
 * 保证部署网关切断（ALB 502）等异常下智能解析流程永不卡死。
 */
export async function fetchDocxInsights(
  uploadId: string,
  force = false,
  inline?: { text: string; goalHints?: string[] },
  /** v2.24：评估表无 UniProt/序列时，服务端把提取到的靶点名称经 UniProt REST 解析为 accession */
  resolveNames = false,
): Promise<InsightsResponse> {
  // v2.6.2：uploadId 与内联 text 同时携带 — 磁盘路径优先，多实例磁盘不共享时
  // 服务端自动降级为内联全文（纯 text 无 uploadId 时为无状态直传回退通道）
  // v2.19：本地引擎配置随请求内联携带（评估表智能解析 LLM 走用户本人的引擎）
  const llm = getLlmEngineOverride()
  const body: Record<string, unknown> = {
    uploadId,
    force,
    ...(inline ? { text: inline.text, goalHints: inline.goalHints ?? [] } : {}),
    ...(resolveNames ? { resolveNames: true } : {}),
    ...(llm ? { llm } : {}),
  }
  // v2.6 流式：NDJSON 心跳保活（修复部署网关 ~30s 空闲切断导致的 HTTP 502 —
  // 旧版一次性 JSON 在冷启动 + LLM 慢时撞线）。流中断自动重试一次（实例已热）。
  // v2.6.2：第 3 次改走 quick 快速兜底（跳过 LLM 毫秒级返回规则提取）。
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchInsightsStream(attempt >= 2 ? { ...body, quick: true } : body)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (attempt >= 2) throw err // quick 也失败（几乎不可能）— 彻底失败
      if (attempt === 0 && !STREAM_BROKEN_RE.test(msg)) throw err // 语义错误（4xx 等）不重试
      continue // 断流/5xx → 重试：0→1 流式，1→2 quick 兜底
    }
  }
}

/** 断流类错误识别（自动重试 → quick 兜底）；其余错误（4xx 语义错误等）直接抛出。
 * v2.6.3：覆盖浏览器原生英文断流报文 — Chrome 读流被网关切断时抛
 * TypeError「network error」/「Failed to fetch」/「terminated」等，旧版正则只
 * 认中文「网络」导致断流直接透出给用户（用户实测报错「network error」根因）。
 */
const STREAM_BROKEN_RE = /流中断|网络|network|failed to fetch|fetch failed|load failed|terminated|socket|econnreset|etimedout|timeout|超时|stream broken|http 5\d\d/i

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
  throw new Error('智能解析流中断（网络波动/网关超时），正在自动重试…')
}

// ─── 高通量 Excel 导入（v2.23）──────────────────────────────

import type { HtSeqTarget } from './types'

/** POST /api/evaluate/ht-extract 响应 — LLM/规则提取的靶点分组（v2.23.1 增序列兜底组；v2.27 增构建区间；v2.29 增结构域名提示） */
export interface HtExcelExtractResult {
  ok: boolean
  groups: string[][]
  /** v2.27：与 groups 逐组逐位对齐的评估区间（undefined = 不过滤；截短构建感知） */
  groupRanges?: Array<Array<[number, number] | undefined>>
  /** v2.29：与 groups 逐组逐位对齐的结构域名提示（评估表不写区间而写域名时 —
   *  管线内与 UniProt domain 划分匹配推导区间） */
  groupDomainHints?: Array<Array<string | undefined>>
  /** 序列兜底组：行缺 UniProt 但有构建序列 → 按序列评估（每行一组） */
  seqGroups?: HtSeqTarget[][]
  /** v2.36：原始 Excel 行快照（汇总报告「原表内容」列；label + 折叠文本） */
  excelRows?: Array<{ label: string; text: string }>
  invalid: string[]
  source: 'llm' | 'regex'
  note?: string
  meta?: {
    fileName?: string
    sheets?: number
    rows?: number
    truncated?: boolean
    bytes?: number
    seqGroups?: number
    seqTargets?: number
    /** v2.34：行→组口径统计（抗体链忽略 / 同源多聚体合并 / 跳过行数） */
    seqRows?: number
    seqAntibodyChains?: number
    seqHomologMerged?: number
    seqSkippedRows?: number
    /** v2.35：跨行去重并入代表组的行数（所有链 ≥95% 同源的重复交付行） */
    seqCrossRowMerged?: number
    /** v2.35：序列兜底覆盖的数据行总数（组 + 跨行并入 + 跳过行 — 全量核算口径） */
    seqDataRows?: number
    /** v2.27：携带构建区间的靶点数 */
    rangeTargets?: number
    /** v2.29：携带结构域名提示的靶点数（管线内匹配 UniProt domain 推导区间） */
    domainHintTargets?: number
  }
}

/**
 * 上传 Excel/CSV 靶点表 → 服务端 LLM 解析分组（LLM 超时/失败时服务端自动回退
 * 规则提取，通道不卡死）。v2.19：本地引擎配置随请求内联携带（导入解析 LLM
 * 走用户本人的引擎）。quick=true 跳过 LLM 直接规则提取（调试/兜底通道）。
 * v2.26 流式版（三级降级，同 fetchDocxInsights 口径 — 修复公网网关 ~30s 空闲
 * 切断导致的 HTTP 502）：流式（NDJSON 心跳）→ 断流自动重试一次 → quick 兜底。
 */
export async function extractHtTargetsFromExcel(
  file: File,
  opts: { quick?: boolean } = {},
): Promise<HtExcelExtractResult> {
  const llm = getLlmEngineOverride()
  // v2.6.2 同款三级降级：0→1 流式重试，1→2 quick 快速兜底（毫秒级规则提取）
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchHtExtractStream(file, attempt >= 2 ? { quick: true } : opts, llm)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (attempt >= 2) throw err // quick 也失败（几乎不可能）— 彻底失败
      if (attempt === 0 && !STREAM_BROKEN_RE.test(msg)) throw err // 语义错误（4xx 等）不重试
      continue // 断流/5xx/网关 502 → 重试
    }
  }
}

/** v2.26：ht-extract NDJSON 流式读取（心跳保活 — 终态 done 行携带提取结果） */
async function fetchHtExtractStream(
  file: File,
  opts: { quick?: boolean },
  llm: ReturnType<typeof getLlmEngineOverride>,
): Promise<HtExcelExtractResult> {
  const fd = new FormData()
  fd.append('file', file)
  if (opts.quick) fd.append('quick', '1')
  if (llm) fd.append('llm', JSON.stringify(llm))
  const res = await fetch('/api/evaluate/ht-extract', { method: 'POST', body: fd })
  // 校验类错误（400/413/422）仍为普通 JSON 错误响应（流尚未建立）
  if (!res.ok || !res.body) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(err?.error ?? `Excel 解析失败（HTTP ${res.status}）`)
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
        let ev: { type?: string; ok?: boolean; error?: string } & Partial<HtExcelExtractResult> | null = null
        try {
          ev = JSON.parse(line)
        } catch { ev = null /* 半行/坏行丢弃，等下一块补齐 */ }
        if (ev?.type === 'done') {
          if (!ev.ok || !Array.isArray(ev.groups)) {
            throw new Error(ev.error ?? 'Excel 解析失败')
          }
          const { type: _t, ok: _ok, error: _e, ...data } = ev
          return { ok: true, ...data } as HtExcelExtractResult
        }
        // ping 心跳：仅保活
      }
      nl = buffer.indexOf('\n')
    }
  }
  throw new Error('Excel 解析流中断（网络波动/网关超时），正在自动重试…')
}

// ─── 靶点关系判断 + 合并报告（v1.8 批量评估）─────────────────

/** POST /api/evaluate/relation — 批量评估前的靶点关系判断（v1.10：附带序列归属）
 *  v2.19：本地引擎配置随请求内联携带（关系判断 LLM 走用户本人的引擎） */
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
  const llm = getLlmEngineOverride()
  const res = await fetch('/api/evaluate/relation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(llm ? { ...input, llm } : input),
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
 *  此处轮询 GET 直到终态（done / error），期间 UI 保持"生成中"状态。
 *  v2.19：本地引擎配置随请求内联携带（合并报告三段式生成走用户本人的引擎）。 */
export async function generateBatchReport(input: {
  jobIds: string[]
  uploadId?: string
  relation: RelationJudgment
  goal?: string
}): Promise<BatchReportInfo> {
  const llm = getLlmEngineOverride()
  const res = await fetch('/api/evaluate/batch-report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(llm ? { ...input, llm } : input),
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

/** POST /api/evaluate/batch-report { regenerateOf } — 手动重新生成合并报告（需求B）
 *  原地重生成：沿用同一记录 id 与既有作业数据（jobIds / relation / uploadId），
 *  LLM 三段式重跑；成功覆盖 markdown / HTML，失败保留上一版内容。
 *  v2.19 口径同 generateBatchReport：本地引擎配置随请求内联携带。 */
export async function regenerateBatchReport(input: { id: string; goal?: string }): Promise<BatchReportInfo> {
  const llm = getLlmEngineOverride()
  const res = await fetch('/api/evaluate/batch-report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ regenerateOf: input.id, goal: input.goal, ...(llm ? { llm } : {}) }),
  })
  const data = (await res.json().catch(() => null)) as { ok?: boolean; batchReport?: BatchReportInfo; error?: string } | null
  if (!res.ok || !data?.ok || !data.batchReport) {
    throw new Error(data?.error ?? `重新生成请求失败（HTTP ${res.status}）`)
  }
  const started = data.batchReport
  if (started.status !== 'running') return started // 兼容即时完成的响应
  return waitForBatchReport(started.id)
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

// ─── v2.51 单靶点报告 LLM 原地重跑 ───────────────────────────────

/** GET /api/jobs/{id}/regenerate-report 状态（idle = 从未重跑 / 进程重启后遗留终态） */
export interface JobRegenStatus {
  ok?: boolean
  state?: 'idle' | 'running' | 'done' | 'error'
  error?: string
  /** 缺章数（部分失败时 >0 — 可再次重跑补齐） */
  missing?: number
  okChapters?: number
}

/**
 * POST /api/jobs/{id}/regenerate-report — 单靶点报告 LLM 原地重跑（v2.51）。
 * 沿用作业既有数据（结构/同源/文献/评分不重收集）仅重跑 10 个 LLM 章节并重渲染
 * HTML；启动后轮询 GET 至终态（章节逐章生成，分钟级）；全部章节失败时服务端
 * 保留上一版内容并返回 error。引擎口径同评估：本地引擎配置随请求内联携带。
 */
export async function regenerateJobReport(id: string): Promise<{ missing: number }> {
  const llm = getLlmEngineOverride()
  const res = await fetch(`/api/jobs/${encodeURIComponent(id)}/regenerate-report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(llm ? { llm } : {}) }),
  })
  const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null
  if (!res.ok || !data?.ok) {
    throw new Error(data?.error ?? `重新生成请求失败（HTTP ${res.status}）`)
  }
  // 轮询状态（瞬时网络错误继续轮询，15 分钟超时兜底）
  const deadline = Date.now() + 15 * 60 * 1000
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000))
    let st: JobRegenStatus | null = null
    try {
      const r = await fetch(`/api/jobs/${encodeURIComponent(id)}/regenerate-report`, { cache: 'no-store' })
      st = (await r.json().catch(() => null)) as JobRegenStatus | null
    } catch { continue }
    if (st?.state === 'error') {
      throw new Error(st.error || 'LLM 章节生成失败（当前版本内容未受影响）')
    }
    if (st?.state === 'done') return { missing: st.missing ?? 0 }
  }
  throw new Error('重新生成超时（15 分钟）— 生成可能仍在后台进行，请稍后刷新结果页查看')
}

// ─── 高通量批量下载（v2.25）──────────────────────────────────────

/** HT 归档条目（组结构化：组号 + 组内靶点标签 → 服务端按 G01_/G02_… 建文件夹） */
export interface HtArchiveEntry {
  jobId?: string
  mergedId?: string
  /** v2.28：统计看板（根级 00_ 文件 — 评分统计 + AI 整体可行性报告） */
  dashboardId?: string
  /** 1-based 组序号（省略 → zip 根目录平铺） */
  group?: number
  label?: string
  /** v2.38：以下元数据写入 zip 内 _TargetEval_manifest.json — 新建运行导入该
   *  zip 时据此精确匹配靶点（已有报告的直接跳过，不重复评估） */
  uniprot?: string
  range?: [number, number]
  /** 序列靶点：提交序列的 SHA-256 前 16 hex（精确匹配） */
  seqSha?: string
  seqLength?: number
  sequenceHeader?: string
}

// ─── 高通量统计看板（v2.28）──────────────────────────────────────

/** v2.69：上传一份导入的既有报告原文到服务端留存 — 返回留存 id（后续汇总报告
 *  生成时服务端读回，作为「完整报告」弹出页内嵌原文，与下载的单独报告一致）。
 *  失败返回 undefined（不阻塞导入 — 统计快照已本地解析，仅弹出页降级）。
 *  v2.87：网络抖动/服务端 5xx 瞬态重试一次（3s）— 服务重启窗口下导入时上传
 *  不再一次性失败（直传链路是更强兜底，但导入时成功可减少后续重传量）。 */
export async function uploadImportedReport(fileName: string, html: string): Promise<string | undefined> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch('/api/evaluate/ht-imported-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName, html }),
      })
      if (res.status >= 500 && attempt < 1) {
        await new Promise(r => setTimeout(r, 3000))
        continue
      }
      const data = (await res.json().catch(() => null)) as { ok?: boolean; id?: string } | null
      return res.ok && data?.ok && typeof data.id === 'string' ? data.id : undefined
    } catch {
      if (attempt < 1) {
        await new Promise(r => setTimeout(r, 3000))
        continue
      }
      return undefined
    }
  }
}

/** v2.81：批量校验导入报告的服务端留存是否仍可读（记录在 + 归属匹配 + 落盘
 *  文件存在）— 返回缺失的 id 列表。端点不可达/响应异常返回 null（调用方视同
 *  全部存活 — 不盲目触发全量重传，服务端不可用时生成本就无法进行）。 */
export async function verifyImportedReports(ids: string[]): Promise<{ missing: string[] } | null> {
  if (ids.length === 0) return { missing: [] }
  try {
    const res = await fetch(`/api/evaluate/ht-imported-report?ids=${encodeURIComponent(ids.slice(0, 60).join(','))}`, {
      cache: 'no-store',
    })
    if (!res.ok) return null
    const data = (await res.json().catch(() => null)) as { ok?: boolean; missing?: unknown } | null
    if (!data?.ok || !Array.isArray(data.missing)) return null
    return { missing: data.missing.filter((x): x is string => typeof x === 'string') }
  } catch {
    return null
  }
}

/** v2.83：按内容哈希批量校验服务端留存 — 返回「哈希 → 存活留存 id」映射与
 *  仍缺失的哈希清单。同内容已有任何可读留存即命中（重复导入/历史批次同样
 *  采纳，无需重传）。端点不可达/响应异常返回 null（调用方自定降级策略）。 */
export async function verifyImportedSources(shas: string[]): Promise<{ retained: Record<string, string>; missing: string[] } | null> {
  if (shas.length === 0) return { retained: {}, missing: [] }
  try {
    const res = await fetch(`/api/evaluate/ht-imported-report?shas=${encodeURIComponent(shas.slice(0, 60).join(','))}`, {
      cache: 'no-store',
    })
    if (!res.ok) return null
    const data = (await res.json().catch(() => null)) as { ok?: boolean; retained?: unknown; missing?: unknown } | null
    if (!data?.ok || typeof data.retained !== 'object' || data.retained == null || !Array.isArray(data.missing)) return null
    const retained: Record<string, string> = {}
    for (const [k, v] of Object.entries(data.retained as Record<string, unknown>)) {
      if (typeof v === 'string') retained[k] = v
    }
    return { retained, missing: data.missing.filter((x): x is string => typeof x === 'string') }
  } catch {
    return null
  }
}

/** POST /api/evaluate/ht-dashboard 生成的统计看板（评分统计 + AI 整体可行性报告）
 *  v2.71：progress = 生成阶段进度文案（running 期间轮询回传 — 横幅实时展示）
 *  v2.76：progressPct = 全局百分比 0-100（进度条；服务端各阶段权重标定后编码回传） */
export interface HtDashboardInfo {
  id: string
  status: 'running' | 'done' | 'error'
  title?: string
  error?: string | null
  createdAt?: string
  /** v2.71：生成阶段进度（仅 running 期间返回 — 前端「生成中」横幅实时展示） */
  progress?: string
  /** v2.76：全局进度百分比 0-100（仅 running 期间返回 — 前端「生成中」横幅进度条） */
  progressPct?: number
  /** v2.78：可自动重试的失败（服务重启/失联导致的「生成中断」— generateHtDashboard
   *  据此自动重新生成一次，重试仍失败才把错误呈现给用户） */
  retryable?: boolean
  /** v2.60：本次生成从浏览器本地缓存快照恢复的靶点数（服务端作业已过期/实例回收） */
  recoveredCount?: number
  /** v2.60：无数据副本被跳过的靶点数（服务端已过期且本地缓存无快照） */
  droppedCount?: number
  /** v2.60：被跳过靶点的展示标签（最多 10 条 — toast 提示用） */
  droppedLabels?: string[]
  /** v2.87：本次生成直传的导入原文份数（客户端 offered — 完成 toast 呈现） */
  ptOffered?: number
  /** v2.87：服务端实际落库的直传份数（内容寻址去重后 — 含采纳既有留存） */
  ptStored?: number
  /** v2.87：直传落库的首个失败原因（落库失败不阻塞生成 — 呈现给用户定位环境问题） */
  ptError?: string
}

/** v2.60：上传给服务端的作业缓存快照（服务端作业已过期时恢复统计行；与
 *  ArchivedJobSnapshot 同构 — summary 为 DB EvaluationJob.summary JSON 的副本） */
export interface HtArchivedSnapshotInput {
  jobId: string
  uniprotId?: string
  summary: Record<string, unknown>
  pdbCount: number
  blastHitCount: number
  reportMarkdown?: string
}

/** 看板条目（与 zip 归档同构 — 服务端据此计算离线链接命名） */
export interface HtDashboardEntry {
  jobId?: string
  mergedId?: string
  group?: number
  label?: string
}

/** v2.60：单条快照报告正文字符上限（体积控制 — 超长截断，统计与结论不受影响） */
const SNAPSHOT_MD_MAX_CHARS = 300_000
/** v2.60：快照总负载字符预算（超出后丢弃后续快照的报告正文，再超出则不再附带） */
const SNAPSHOT_TOTAL_BUDGET_CHARS = 8_000_000

/** v2.60：从浏览器本地作业缓存提取缺失作业的快照（仅 done 且有评分 summary 的
 *  作业可恢复）。体积控制：单条正文截断 + 总预算（超出后新快照不再附正文，
 *  再超出则停止附带 — 该靶点计入 dropped，生成仍可部分完成）。 */
function buildSnapshotsForMissing(missingJobIds: string[]): HtArchivedSnapshotInput[] {
  const out: HtArchivedSnapshotInput[] = []
  let used = 0
  for (const id of missingJobIds) {
    const d = getCachedJobDetail(id)
    if (!d || d.status !== 'done' || !d.summary) continue
    let md = typeof d.reportMarkdown === 'string' ? d.reportMarkdown : undefined
    if (md && md.length > SNAPSHOT_MD_MAX_CHARS) md = `${md.slice(0, SNAPSHOT_MD_MAX_CHARS)}\n\n（报告正文过长已截断）`
    const snap: HtArchivedSnapshotInput = {
      jobId: id,
      uniprotId: d.uniprotId ?? undefined,
      summary: d.summary as unknown as Record<string, unknown>,
      pdbCount: d.pdbs?.length ?? 0,
      blastHitCount: d.blastHits?.length ?? 0,
      reportMarkdown: md,
    }
    const size = JSON.stringify(snap).length
    if (used + size > SNAPSHOT_TOTAL_BUDGET_CHARS) {
      // 预算耗尽：先试丢正文，再不够则放弃本条（后续靶点计入 dropped）
      const lean: HtArchivedSnapshotInput = { ...snap, reportMarkdown: undefined }
      const leanSize = JSON.stringify(lean).length
      if (used + leanSize > SNAPSHOT_TOTAL_BUDGET_CHARS) continue
      out.push(lean)
      used += leanSize
      continue
    }
    out.push(snap)
    used += size
    if (out.length >= 600) break
  }
  return out
}

/**
 * POST /api/evaluate/ht-dashboard — 高通量运行完成后生成统计看板（服务端异步：
 * POST 立即返回 running，此处轮询 GET 至终态）。LLM 失败不阻塞 — 统计与每靶点
 * 规则结论仍渲染。v2.19：本地引擎配置随请求内联携带。
 * v2.60 两阶段重试：服务端发现部分作业已不在 DB（实例回收/过期）时返 409 +
 * missingJobIds（不创建看板）；此处从浏览器本地缓存提取这些作业的终态快照
 * 重试（allowPartial — 仍缺的靶点计入 dropped 跳过，不再整单失败「作业不存在」）。
 * v2.78 生成中断自动重试：服务端 GET 轮询内置僵死检测（running 且写入停滞
 * >90s = 生成进程已被服务重启/OOM 带走 → 立即落库「生成中断」error），本函数
 * 识别该错误（前缀）或与服务器失联（retryable）时自动重新生成一次 — 用户对
 * 服务重启完全无感（重试仍失败才呈现错误与手动重试入口）。
 */
export interface HtDashboardGenerateInput {
  entries: HtDashboardEntry[]
  goal?: string
  /** v2.36：原始 Excel 行快照（汇总报告「原表内容」列；v2.68 seqs = 行内序列格原文 —
   *  序列标记处一键复制按钮数据源） */
  excelRows?: Array<{ label: string; text: string; seqs?: string[] }>
  /** v2.61：各靶点提交序列（jobId → 全文 — 汇总表「复制序列」按钮 + 单靶点完整报告弹出页展示） */
  sequences?: Array<{ jobId: string; sequence: string }>
  /** v2.68：导入既有报告但无作业标记的靶点（降级「载入」行 — 主表呈现 + 计入完成口径，
   *  无评分参与统计分布；sequence 供该行复制序列按钮用）。
   *  v2.69：stats（导入报告解析的统计快照）存在时构建与本次评估同权的完整统计行；
   *  reportId（原文服务端留存 id）存在时弹出页内嵌报告原文 */
  imported?: Array<{
    label: string
    group?: number
    sequence?: string
    fileName?: string
    reportId?: string
    /** v2.83：原文内容哈希（reportId 死亡/丢失时服务端按内容找回同内容留存） */
    sourceSha?: string
    range?: [number, number]
    stats?: ImportedReportStats
  }>
  /** v2.68：导入报告携带的原作业 id（entries 中对应行标「载入」徽标 — 与本次评估行区分） */
  importedJobIds?: string[]
  /** v2.87：导入报告原文直传（生成请求直接携带 — 留存未确认可用的源文件；
   *  服务端同一请求内落库后内嵌。v2.91 预算改字节口径：≤128 份 · 单份 ≤16MB
   *  字节 · 总量 ≤64MB 字节 — 与请求体传输上限严格对齐） */
  importedSources?: Array<{ sha: string; fileName: string; html: string }>
  /** v2.71：running 期间每次轮询回传阶段进度（生成中横幅实时展示）；
   *  v2.76：第二参数 pct = 全局百分比 0-100（进度条，旧服务端无此字段时 undefined） */
  onProgress?: (msg: string, pct?: number) => void
}

/** v2.78：服务端僵死检测落库的错误文案前缀 — 与服务端 HT_DASHBOARD_STALL_PREFIX
 *  字面量一致（服务端 lib 带 Prisma/fs 依赖不能进客户端包，故两端各持一份；
 *  文案变更需两处同步）。 */
const HT_STALL_ERROR_PREFIX = '生成中断：'

/** v2.79：无进度心跳判定窗口（ms）。v2.77+ 服务端看门狗每 5s 心跳写库 → 活生成
 *  期间进度文本/百分比至多 ~8s（心跳 5s + 轮询 3s）不变；连续 3 分钟（20 倍余量）
 *  无任何变化且轮询持续成功 = 生成进程已死或服务端写入受阻（旧版 v2.77 服务端
 *  无僵死检测 / v2.78+ 标记落库失败两类场景 — 用户实测「10 分钟无进展」仅剩的
 *  两条通路）→ 快速失败并自动重新生成一次，不再盲等 10 分钟黑盒。 */
const PROGRESS_STALL_MS = 180_000

/** v2.79：错误文案自标注部署版本 — 用户回报错误文本即可定位前后端实际运行的
 *  代码版本（服务端版本来自 GET 状态轮询回传的 v 字段；未观测到时仅标前端）。
 *  「统计看板生成超时」在 v2.77 与 v2.78 文案完全相同但行为不同 — 拿不到版本
 *  就无法定位是哪一版的行为（此前页脚版本号更停留在 v2.60.0 从未更新）。 */
const verTag = (serverV?: string): string => `（前端 ${APP_VERSION}${serverV ? ` · 服务端 ${serverV}` : ''}）`

export async function generateHtDashboard(input: HtDashboardGenerateInput): Promise<HtDashboardInfo> {
  for (let attempt = 0; ; attempt++) {
    let result: HtDashboardInfo
    try {
      result = await generateHtDashboardAttempt(input)
    } catch (e) {
      // POST 阶段网络失败（post 内部已重试 3×5s 仍不通 — 服务器重启窗口）：
      // 2s 后自动重新生成一次（服务器恢复即成功，重试仍失败才抛给调用方）
      if (attempt >= 1) throw e
      input.onProgress?.('与服务器连接中断 — 正在自动重新生成…', undefined)
      await new Promise(r => setTimeout(r, 2000))
      continue
    }
    // v2.78：服务端「生成中断」（僵死检测 — 生成进程被服务重启/OOM 带走）或
    //  轮询阶段失联（retryable — v2.79 起含 3 分钟无进度心跳停滞与服务响应异常）
    //  → 自动重新生成一次；其余错误原样返回
    const stalled = result.status === 'error' && typeof result.error === 'string' && result.error.startsWith(HT_STALL_ERROR_PREFIX)
    const lostServer = result.status === 'error' && result.retryable === true
    if (attempt >= 1 || !(stalled || lostServer)) return result
    input.onProgress?.(stalled ? '服务重启导致生成中断 — 正在自动重新生成…' : '生成停滞/与服务器连接中断 — 正在自动重新生成…', undefined)
    await new Promise(r => setTimeout(r, 2000))
  }
}

async function generateHtDashboardAttempt(input: HtDashboardGenerateInput): Promise<HtDashboardInfo> {
  const llm = getLlmEngineOverride()
  // v2.74：POST 瞬态重试 — dev server 重编译 / 网关瞬断窗口内 fetch 直接抛
  //  "Failed to fetch"（v2.73 及之前 POST 一次网络抖动即整体判死，而服务端实际
  //  生成得好好的 — 用户实测报错根因之一）。最多 3 次 × 5s；业务 4xx 不重试。
  //  v2.75：404/405 也纳入瞬态重试 — 本端点的 POST 处理器永不返回 404/405（业务
  //  错误只有 400/409/500），出现即框架层路由未就绪（dev server 重启窗口 /
  //  部署中），重试可自愈（用户实测「统计看板生成失败（HTTP 404）」根因）；
  //  重试耗尽仍 404 时报错文案附指引。
  const postOnce = (extra?: { archived?: HtArchivedSnapshotInput[]; allowPartial?: boolean }) =>
    fetch('/api/evaluate/ht-dashboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, ...(llm ? { llm } : {}), ...extra }),
    })
  const post = async (extra?: { archived?: HtArchivedSnapshotInput[]; allowPartial?: boolean }) => {
    let lastErr: unknown = null
    for (let i = 0; i < 3; i++) {
      try {
        const r = await postOnce(extra)
        if ((r.status >= 500 || r.status === 404 || r.status === 405) && i < 2) { await new Promise(rs => setTimeout(rs, 5000)); continue }
        return r
      } catch (e) {
        lastErr = e
        if (i < 2) await new Promise(rs => setTimeout(rs, 5000))
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('无法连接服务器（网络中断）')
  }
  let res = await post()
  let data = (await res.json().catch(() => null)) as {
    ok?: boolean
    dashboard?: HtDashboardInfo
    error?: string
    missingJobIds?: string[]
  } | null
  // v2.60 阶段二：部分作业不在服务器 → 附带浏览器缓存快照重试（部分完成）
  if (res.status === 409 && Array.isArray(data?.missingJobIds) && data.missingJobIds.length > 0) {
    const archived = buildSnapshotsForMissing(data.missingJobIds)
    res = await post({ archived: archived.length ? archived : undefined, allowPartial: true })
    data = (await res.json().catch(() => null)) as typeof data
  }
  if (!res.ok || !data?.ok || !data.dashboard) {
    // v2.75：404 附明确指引 — 本端点 POST 永不合法返回 404（见上 post 注释），
    //  重试耗尽仍 404 说明服务长时间未就绪（部署中/异常重启），告知用户稍后重试
    //  而非让「HTTP 404」不知所云（用户实测反馈无法理解该错误）。
    const hint = res.status === 404 || res.status === 405
      ? ' — 服务暂不可达，可能正在重启或部署中；运行结果已保留，稍后打开该运行会自动重试，或点击「重新生成汇总报告」'
      : ''
    throw new Error(data?.error ?? `统计看板生成失败（HTTP ${res.status}${hint}）`)
  }
  if (data.dashboard.status !== 'running') return data.dashboard
  // POST 应答携带的恢复/跳过信息（GET 状态不回传 — 轮询终态后合并回结果供调用方提示）
  const recoverInfo = {
    ...(data.dashboard.recoveredCount != null ? { recoveredCount: data.dashboard.recoveredCount } : {}),
    ...(data.dashboard.droppedCount != null ? { droppedCount: data.dashboard.droppedCount } : {}),
    ...(data.dashboard.droppedLabels?.length ? { droppedLabels: data.dashboard.droppedLabels } : {}),
    // v2.87：导入原文直传统计（完成 toast 呈现 — 同为 POST 应答独有字段）
    ...(data.dashboard.ptOffered != null ? { ptOffered: data.dashboard.ptOffered } : {}),
    ...(data.dashboard.ptStored != null ? { ptStored: data.dashboard.ptStored } : {}),
    ...(data.dashboard.ptError ? { ptError: data.dashboard.ptError } : {}),
  }
  // 轮询至终态。v2.74 三重容错（修复用户实测「Failed to fetch」误报与长等待误判超时）：
  //  ① 轮询 fetch 网络异常（dev 重编译 / 网关瞬断 / 服务器短暂重启自愈）→ 不再直接
  //    抛出（v2.73 及之前 `.then()` 不捕获 fetch rejection — 一次网络抖动即把整个
  //    生成判死「Failed to fetch」）；连续 20 次（≈60s）全失败才判定网络中断；
  //  ② 超时改「无进展判定」：进度文本变化即重置 10 分钟窗口（服务端 v2.74 起 LLM
  //    长等待期间每 5s 写心跳进度 — 不再出现「LLM 限流重试期间进度静默被误判超时」）；
  //    硬上限 30 分钟；
  //  ③ running 期间回传服务端阶段进度（v2.71 起 — 生成中横幅实时展示）。
  //  v2.77 补强（配合服务端全局阶段看门狗 — 根除「10 分钟无进展」误报的最后一环）：
  //  ④ 轮询 fetch 挂 30s 超时（服务进程被同步长任务阻塞时，请求悬而不决 → 旧实现
  //    await 永不返回、既不计数也不超时，横幅无限挂在「生成中」；现在快速计入
  //    netFails 走①的容错路径）；
  //  ⑤ 响应不可解析（JSON 解析得 null — 框架层路由未就绪返 HTML 404 / 网关异常页）
  //    独立计数：旧实现静默跳过，10 分钟窗口照常走完才报「无进展超时」；现在约
  //    1 分钟持续不可解析即快速失败并给出准确归因；
  //  ⑥ 进度百分比变化同样重置窗口（文本含已等待秒数通常同步变化，双保险）；
  //  ⑦ 超时文案重写：服务端各阶段每 5s 心跳汇报，出现本提示即说明服务进程已
  //    中断/卡滞（真卡滞由服务端 20 分钟看门狗先一步落库 error — 前端会立刻拿到）；
  //  v2.79 ⑧：无进度窗口 10 分钟 → 3 分钟（PROGRESS_STALL_MS）+ retryable 自动重试
  //    — v2.78 后用户仍复现「10 分钟无进展」：服务端僵死标记落库失败（磁盘满/
  //    库被占用）时 v2.78 静默吞掉继续盲等；服务端代码为 v2.77（未重启/未拉取）
  //    时无僵死检测可依赖。活生成器每 5s 心跳（20 倍余量）不可能 3 分钟静默 —
  //    快速失败重试优于黑盒等待；⑨ 错误文案自标注前后端版本（verTag）。
  const t0 = Date.now()
  let lastProgress = ''
  let lastPct: number | null | undefined = null
  let lastProgressAt = Date.now()
  let netFails = 0
  let badResp = 0
  let serverV: string | undefined // v2.79：最近一次轮询回传的服务端版本（verTag 用）
  for (;;) {
    await new Promise(r => setTimeout(r, 3000))
    let d: { ok?: boolean; v?: string; dashboard?: HtDashboardInfo } | null = null
    try {
      // v2.77 ④：30s 请求级超时（与服务端 3s 间隔轮询节奏匹配 — 正常响应 <100ms）
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 30_000)
      try {
        d = await fetch(`/api/evaluate/ht-dashboard?id=${encodeURIComponent(data.dashboard.id)}`, { cache: 'no-store', signal: ctrl.signal })
          .then(x => x.json().catch(() => null)) as { ok?: boolean; v?: string; dashboard?: HtDashboardInfo } | null
      } finally {
        clearTimeout(timer)
      }
      netFails = 0
    } catch {
      netFails++
      if (netFails >= 20) {
        // v2.78 retryable：失联多为服务重启窗口（生成进程大概率已死 — 记录僵死）
        //  → 外层自动重新生成一次，恢复后无感续上
        return { id: data.dashboard.id, status: 'error' as const, error: `与服务器失去连接（约 1 分钟内请求持续失败 — 服务可能重启中；生成可能仍在后台进行，恢复后可从历史重试或刷新查看）${verTag()}`, retryable: true, ...recoverInfo }
      }
      continue
    }
    if (d === null) {
      // v2.77 ⑤：请求成功但响应体不可解析（框架层 404 HTML / 重编译窗口 / 网关
      //  异常页）— 与网络中断分开归因，持续 ≈1 分钟即快速失败；v2.79：纳入
      //  retryable（dev 重编译窗口结束后自动重新生成可无感恢复 — 与失联同口径）。
      badResp++
      if (badResp >= 20) {
        return { id: data.dashboard.id, status: 'error' as const, error: `服务响应异常（约 1 分钟内状态查询持续返回不可解析内容 — 服务可能正在重启或重编译；生成可能仍在后台进行，稍后可从历史重试或刷新查看）${verTag()}`, retryable: true, ...recoverInfo }
      }
      continue
    }
    badResp = 0
    if (typeof d.v === 'string') serverV = d.v
    if (d?.dashboard && d.dashboard.status !== 'running') return { ...d.dashboard, ...recoverInfo }
    // v2.75：GET 返回 JSON 错误体（无 dashboard 字段 — 处理器 404「看板不存在」等）
    //  → 快速失败，不再空转 10 分钟等超时。看板记录已不在服务器（实例回收/数据
    //  重置/归属变更）时生成永远无法完成，早失败 + 明确文案优于超时；框架层瞬态
    //  404（HTML 体 → d=null）不在此列，继续轮询等自愈。
    if (d && !d.dashboard && !d.ok && typeof (d as { error?: unknown }).error === 'string') {
      // v2.78 retryable：看板记录已不在服务器（实例回收/数据重置）— 重新 POST
      //  即可整体重建（409 时走缓存快照两阶段恢复），外层自动重试一次
      return { id: data.dashboard.id, status: 'error' as const, error: `统计看板生成失败（${(d as { error: string }).error} — 服务端看板数据已不存在；运行结果不受影响，可点击「重新生成汇总报告」重建）${verTag(serverV)}`, retryable: true, ...recoverInfo }
    }
    if (d?.dashboard?.progress) {
      input.onProgress?.(d.dashboard.progress, d.dashboard.progressPct)
      // v2.77 ⑥：文本或百分比任一变化即重置窗口
      const pctNow = d.dashboard.progressPct ?? null
      if (d.dashboard.progress !== lastProgress || pctNow !== lastPct) {
        lastProgress = d.dashboard.progress
        lastPct = pctNow
        lastProgressAt = Date.now()
      }
    }
    const now = Date.now()
    if (now - lastProgressAt > PROGRESS_STALL_MS) {
      // v2.79：无进度心跳 3 分钟 → 快速失败 + retryable（外层自动重新生成一次）。
      //  本文案仅在重试也失败后才会呈现给用户（重试成功时错误被外层拦截）—
      //  故可如实描述「已自动重新生成仍未恢复」。
      return { id: data.dashboard.id, status: 'error' as const, error: `统计看板生成停滞（连续 3 分钟无进度心跳 — 生成进程已中断或服务端状态写入受阻；已自动重新生成一次仍未恢复。运行结果不受影响，可稍后从历史重试或刷新查看）${verTag(serverV)}`, retryable: true, ...recoverInfo }
    }
    if (now - t0 > 1_800_000) {
      return { id: data.dashboard.id, status: 'error' as const, error: `统计看板生成超时（已等待 30 分钟 — 生成可能仍在后台进行，运行结果不受影响；可稍后从历史重试或刷新查看）${verTag(serverV)}`, ...recoverInfo }
    }
  }
}

/** GET/POST /api/evaluate/ht-archive — 一次高通量运行的全部报告打包 zip 下载
 *  （每组一个子文件夹 + 合并报告 + _README.txt 清单）。失败抛错。
 *  v2.80「更稳妥的打包」：① entries 改走 POST JSON body（GET query 600 条目时
 *  可达数百 KB — 部分网关/浏览器 414 或截断；GET 通道保留兼容）；② fetch 挂
 *  300s 超时（服务端 zip 构建有界 — nodebuffer 全量缓冲后一次性响应，挂死多为
 *  服务重启/网关瞬断，旧版无超时会永远转圈）；③ 瞬态重试 3×5s（网络失败/5xx/
 *  404 均可能是重启窗口 — 与 ht-dashboard POST 同口径）。 */
export async function downloadHtReportArchive(entries: HtArchiveEntry[], fallbackName = '报告'): Promise<void> {
  if (!entries.length) throw new Error('没有可下载的报告')
  const postOnce = async (): Promise<Response> => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 300_000)
    try {
      return await fetch('/api/evaluate/ht-archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries }),
        cache: 'no-store',
        signal: ctrl.signal,
      })
    } finally {
      clearTimeout(timer)
    }
  }
  let res: Response | null = null
  let lastErr: unknown = null
  for (let i = 0; i < 3 && !res; i++) {
    try {
      const r = await postOnce()
      if ((r.status >= 500 || r.status === 404 || r.status === 405) && i < 2) {
        await new Promise(rs => setTimeout(rs, 5000))
        continue
      }
      res = r
    } catch (e) {
      lastErr = e
      if (i < 2) await new Promise(rs => setTimeout(rs, 5000))
    }
  }
  if (!res) {
    throw new Error(
      lastErr instanceof Error && lastErr.name === 'AbortError'
        ? '批量下载超时（5 分钟无响应 — 服务可能正在重启或网络不通；运行结果不受影响，稍后可重试）'
        : lastErr instanceof Error && lastErr.message
          ? lastErr.message
          : '无法连接服务器（网络中断 — 稍后可重试；运行结果不受影响）',
    )
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(data?.error ?? `批量下载失败（HTTP ${res.status}）`)
  }
  const blob = await res.blob()
  const cd = res.headers.get('content-disposition') ?? ''
  const m = /filename="?([^";\n]+)/i.exec(cd)
  const filename = m?.[1]?.trim() || `TargetEval_HT_${fallbackName}_${new Date().toISOString().slice(0, 10)}.zip`
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

// ─── 报告 PDF 导出（v2.87）──────────────────────────────────────

/** 报告 PDF 导出：fetch blob → 另存（服务端 Chromium print-to-PDF — 与 HTML 下载
 *  同一份文件、同一套 @media print A4 分页规则：卡片/表格行不腰斩、标题不孤行尾、
 *  页脚页码；合并报告视图全展开 + 每靶点新起一页）。
 *  url：报告接口相对路径（不含 format 参数，本函数追加）；fallbackName：响应缺
 *  Content-Disposition 时的兜底文件名。渲染耗时数秒到数十秒 — 240s 超时；失败抛错。 */
export async function downloadReportPdf(url: string, fallbackName = 'TargetEval_Report'): Promise<void> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 240_000)
  let res: Response
  try {
    res = await fetch(`${url}${url.includes('?') ? '&' : '?'}format=pdf`, { cache: 'no-store', signal: ctrl.signal })
  } catch (e) {
    throw new Error(
      e instanceof Error && e.name === 'AbortError'
        ? 'PDF 导出超时（4 分钟无响应 — 报告可能过大；可下载 HTML 后在浏览器中 Ctrl/Cmd+P 打印为 PDF，版式相同）'
        : '无法连接服务器（网络中断 — 稍后可重试）',
    )
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(data?.error ?? `PDF 导出失败（HTTP ${res.status}）`)
  }
  const blob = await res.blob()
  if (blob.size < 512) {
    throw new Error('PDF 导出失败（返回内容异常）— 可下载 HTML 后在浏览器中 Ctrl/Cmd+P 打印为 PDF，版式相同')
  }
  // filename* 优先（RFC 5987 中文报告题目），回退 filename=，再回退兜底名
  const cd = res.headers.get('content-disposition') ?? ''
  const star = /filename\*=(?:UTF-8'')?([^;\n]+)/i.exec(cd)
  const plain = /filename="?([^";\n]+)/i.exec(cd)
  let filename = star?.[1]?.trim() || plain?.[1]?.trim() || ''
  try { filename = decodeURIComponent(filename) } catch { /* 保留原文 */ }
  if (!filename.toLowerCase().endsWith('.pdf')) filename = `${filename || fallbackName}.pdf`
  const objectUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = objectUrl
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000)
}

// ─── LLM 引擎配置 ──────────────────────────────────────────────

/** GET /api/llm/config — 供应商列表（v2.19：引擎配置在浏览器 localStorage，服务端无激活配置；
 *  GET 顺带触发服务端历史存量配置的一次性清除） */
export async function fetchLlmConfig(): Promise<LlmConfigResponse> {
  const res = await fetch('/api/llm/config', { cache: 'no-store' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = (await res.json().catch(() => null)) as LlmConfigResponse | null
  if (!data || !data.ok) throw new Error('配置读取失败')
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
const SYNC_MAX_SEGMENTS = 120 // ≈120 段 × ~14s ≈ 28 分钟总预算（超过视为异常）
/** v2.6.3：段流中断后携同快照重试同一段的连续上限（收到事件即清零） */
const SYNC_BROKEN_RETRIES = 3

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
  let brokenRetrySeg = 0 // v2.6.3：连续段流中断重试计数（收到事件即清零）

  for (let segment = 0; ; segment++) {
    const payload: SyncEvaluateBody = { ...body }
    if (llm && !payload.llm) payload.llm = llm
    if (checkpoint) (payload as { checkpoint?: unknown }).checkpoint = checkpoint

    // v2.6.3：段流中断（网关切断/抖动 → fetch 或读流抛错）自动携同快照重试同一段 —
    // 段执行幂等（输入重派生 + 相位重入守卫），最多连续 3 次；收到事件即清零计数。
    let streamBroken = false
    let res: Response
    try {
      res = await fetch('/api/evaluate/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: opts.signal,
      })
    } catch (e) {
      if (opts.signal?.aborted) throw e
      streamBroken = true
      res = null as unknown as Response
      void e
    }
    if (streamBroken || !res.ok || !res.body) {
      if (streamBroken && brokenRetrySeg < SYNC_BROKEN_RETRIES && !opts.signal?.aborted) {
        brokenRetrySeg++
        segment-- // 同段重试（segment-- 与 for 自增抵消）
        continue
      }
      if (streamBroken) {
        throw new Error('评估连接建立失败（网络波动，已自动重试）— 请重试；若持续出现请稍后再试')
      }
      const err = (await res.json().catch(() => null)) as { error?: string } | null
      throw new Error(err?.error ?? `同步评估启动失败（HTTP ${res.status}）`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let result: SyncEvaluateResult | null = null
    let streamError: string | null = null
    let nextCheckpoint: unknown | null = null

    // v2.6.3：读流被网关切断/抖动抛 TypeError（network error / terminated 等）—
    // 段幂等可重入，携同快照重试同一段（连续 ≤3 次）
    let readBroken = false
    try {
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
                brokenRetrySeg = 0 // 数据在流动 — 清零断流计数
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
    } catch (e) {
      if (opts.signal?.aborted) throw e
      readBroken = true
      void e
    }

    if (result) return result
    if (streamError) throw new Error(streamError)
    if (readBroken && brokenRetrySeg < SYNC_BROKEN_RETRIES) {
      brokenRetrySeg++
      segment-- // 同段重试（segment-- 与 for 自增抵消）
      continue
    }
    if (nextCheckpoint) {
      checkpoint = nextCheckpoint
      if (segment + 1 >= SYNC_MAX_SEGMENTS) {
        throw new Error('评估续跑段数超限（异常循环）— 请重试；若持续出现请稍后再试')
      }
      continue // 立即再发一段
    }
    // 流中断且无终态（网关切断/超时）
    throw new Error('评估流中断（网络或网关超时）。已完成的部分数据已丢失，请重试；若持续出现，请稍后再试。')
  }
}
