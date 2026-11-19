/**
 * RCSB 序列搜索（mmseqs2 全库检索）— NCBI BLAST 队列拥堵时的同源结构兜底通道。
 *
 * 背景（2026-10 实测）：NCBI BLAST URL API 队列会出现长时间 WAITING（30+ 分钟不开始
 * 计算），且公网部署出口 IP 经 NAT 池轮换时结果回收不可靠。RCSB 官方序列搜索接口：
 *  - 单次 HTTP 请求、无队列、无轮询（1–3s 返回）
 *  - 直接检索 PDB 全部聚合物实体（正是「同源结构」的语义本体）
 *  - verbose 模式返回 sequence_identity / evalue / 覆盖区间 —— 与 BLAST 命中同构
 *
 * v2.41 全局节流 + 重试（用户反馈「兜底第 3/3 次」— NCBI 队列拥堵时多个作业
 * 同时触发 RCSB 兜底，并发冲击下 RCSB 侧瞬时 429/5xx 导致兜底尝试被白白耗尽）：
 *  - 全局串行链节流：相邻两次检索间隔 ≥ RCSB_MIN_INTERVAL_MS，排队错峰；
 *  - 429/5xx/网络错误自动重试（退避 4s/10s，最多 2 次重试）— 单次失败不再
 *    直接计入「兜底失败」计数，瞬时抖动不再耗尽 MAX_RESCUE_ATTEMPTS。
 *
 * 结果映射为 BlastHit[]（pdbId / identity% / evalue / queryCoverage），
 * 方法与分辨率由 enrichBlastHits 经 RCSB data API 补齐（含结构标题作为描述）。
 */
import type { BlastHit } from './types'

const SEARCH_URL = 'https://search.rcsb.org/rcsbsearch/v2/query'

/** v2.41 相邻两次检索的最小间隔（全局串行链 — 多作业同时兜底时排队错峰） */
const RCSB_MIN_INTERVAL_MS = 2_000
/** v2.41 瞬时失败重试退避（429/5xx/网络错误；最多重试 2 次） */
const RCSB_RETRY_DELAYS_MS = [4_000, 10_000]
/** v2.41 单次请求超时：45s（实测序列服务退化时 ~31s 才返回 500 —
 *  30s 超时会把「明确的 500」变成「超时」，重试节奏反而更慢） */
const RCSB_REQUEST_TIMEOUT_MS = 45_000

function rcsbSleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** 全局节流链（globalThis 挂载，HMR / 多次导入间共享） */
const rg = globalThis as unknown as { __rcsbSearchChain?: Promise<void>; __rcsbLastReqAt?: number }

/** 获取检索节流槽：与上次实际请求间隔不足 RCSB_MIN_INTERVAL_MS 时等待 */
async function rcsbGate(): Promise<void> {
  const turn = (rg.__rcsbSearchChain ?? Promise.resolve()).then(() => undefined, () => undefined)
  rg.__rcsbSearchChain = (async () => {
    await turn
    const since = Date.now() - (rg.__rcsbLastReqAt ?? 0)
    if (since < RCSB_MIN_INTERVAL_MS) await rcsbSleep(RCSB_MIN_INTERVAL_MS - since)
    rg.__rcsbLastReqAt = Date.now()
  })()
  await rg.__rcsbSearchChain
}

export interface RcsbSearchOptions {
  /** 最多保留的命中条目数（v2.32 起按显著性 e-value 升序保留前 N） */
  maxRows?: number
  /** 序列一致性阈值（0–1，mmseqs2 预过滤） */
  identityCutoff?: number
  /** E-value 阈值 */
  evalueCutoff?: number
  signal?: AbortSignal
}

interface RcsbMatchContext {
  sequence_identity?: number
  evalue?: number
  bitscore?: number
  alignment_length?: number
  query_beg?: number
  query_end?: number
}

interface RcsbSearchHit {
  identifier?: string
  services?: Array<{
    nodes?: Array<{
      match_context?: RcsbMatchContext[]
    }>
  }>
}

/**
 * RCSB 序列同源检索 → BlastHit[]。
 * 序列过短（<20 aa）或搜索服务异常时返回空数组（调用方决定后续策略）；
 * 网络失败抛出异常（与"搜索完成但 0 命中"区分）。
 */
export async function searchRcsbHomologs(
  sequence: string,
  opts: RcsbSearchOptions = {},
): Promise<BlastHit[]> {
  const { maxRows = 60, identityCutoff = 0.25, evalueCutoff = 0.01, signal } = opts
  const clean = sequence.replace(/\s+/g, '').toUpperCase()
  if (clean.length < 20) return [] // mmseqs2 对极短序列不可靠，直接放弃

  const body = {
    query: {
      type: 'terminal',
      service: 'sequence',
      parameters: {
        evalue_cutoff: evalueCutoff,
        identity_cutoff: identityCutoff,
        sequence_type: 'protein',
        value: clean,
      },
    },
    request_options: {
      scoring_strategy: 'sequence',
      results_verbosity: 'verbose',
      paginate: { start: 0, rows: Math.min(200, Math.max(10, maxRows * 3)) },
    },
    return_type: 'polymer_entity',
  }

  // v2.41：全局节流 + 瞬时失败重试 — 429/5xx/网络抖动退避后重试，
  // 避免多作业同时兜底时把 MAX_RESCUE_ATTEMPTS 白白耗尽
  let res: Response
  for (let attempt = 0; ; attempt++) {
    await rcsbGate()
    try {
      res = await fetch(SEARCH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(RCSB_REQUEST_TIMEOUT_MS),
      })
    } catch (e) {
      if (signal?.aborted && e instanceof DOMException && e.name === 'AbortError') throw e
      if (attempt < RCSB_RETRY_DELAYS_MS.length) {
        await rcsbSleep(RCSB_RETRY_DELAYS_MS[attempt])
        continue
      }
      throw e
    }
    // 204 = 无命中（RCSB 搜索服务的空结果约定）— 直接返回
    if (res.status === 204) return []
    if (res.ok) break
    const retriable = res.status === 429 || res.status >= 500
    if (!retriable || attempt >= RCSB_RETRY_DELAYS_MS.length) {
      throw new Error(`RCSB 序列检索失败 HTTP ${res.status}`)
    }
    await rcsbSleep(RCSB_RETRY_DELAYS_MS[attempt])
  }

  const data = (await res.json()) as { result_set?: RcsbSearchHit[]; total_count?: number }
  const rows = data.result_set ?? []

  // polymer_entity 标识形如 "3QWQ_1"（条目_id 实体序号）→ 取 PDB 条目号 + 实体序号
  //（v2.16：实体序号保留在 entityId — 复合物结构按命中实体归属 UniProt，避免取错链）；
  // 同一 PDB 多实体取最高 identity（连同 entityId 一并保留胜者）
  const seen = new Map<string, BlastHit>()
  for (const row of rows) {
    const ident = (row.identifier ?? '').trim()
    const pdbId = ident.split('_')[0]?.toUpperCase() ?? ''
    if (!/^[0-9][A-Z0-9]{3}$/.test(pdbId)) continue
    const entityIdRaw = ident.split('_')[1]
    const entityId = /^\d+$/.test(entityIdRaw ?? '') ? parseInt(entityIdRaw as string, 10) : undefined
    const ctx = row.services?.[0]?.nodes?.[0]?.match_context?.[0]
    if (!ctx || typeof ctx.sequence_identity !== 'number') continue
    const hit: BlastHit = {
      pdbId,
      entityId,
      description: '', // 由 enrichBlastHits 经 RCSB data API 补结构标题
      identity: Math.round(ctx.sequence_identity * 1000) / 10,
      evalue: typeof ctx.evalue === 'number' ? ctx.evalue : 0,
      evalueRaw: String(ctx.evalue ?? 0),
      queryCoverage:
        typeof ctx.query_beg === 'number' && typeof ctx.query_end === 'number' && ctx.query_end >= ctx.query_beg
          ? ctx.query_end - ctx.query_beg + 1
          : 0,
      queryFrom: typeof ctx.query_beg === 'number' && ctx.query_beg > 0 ? ctx.query_beg : undefined,
      queryTo: typeof ctx.query_end === 'number' && ctx.query_end > 0 ? ctx.query_end : undefined,
      method: '',
      resolution: null,
    }
    const existing = seen.get(pdbId)
    if (
      !existing
      || hit.evalue < existing.evalue
      || (hit.evalue === existing.evalue
        && (hit.identity > existing.identity
          || (hit.identity === existing.identity && hit.queryCoverage > existing.queryCoverage)))
    ) seen.set(pdbId, hit)
    if (seen.size >= maxRows * 2) break // 实体级条目上限保护（内存策略：命中集恒小）
  }

  // v2.32 排序改为显著性口径（e-value 升序，identity/覆盖率打破平局）— 旧 identity
  // 降序排序会把短片段 100% 巧合命中浮到首位（用户实测：526 aa ADSL 截短构建的
  // 24EW 命中仅覆盖查询 20-40 位 21 aa，却因 100% 一致性排第一，导致靶点被错绑
  // 到 SARS-CoV-2 P0DTD1）。mmseqs2 E-value 与 BLAST 同口径，长比对高覆盖命中
  // （如 487 aa / 99.3%）天然显著于短片段全同命中。
  return [...seen.values()]
    .sort(
      (a, b) => a.evalue - b.evalue || b.identity - a.identity || b.queryCoverage - a.queryCoverage,
    )
    .slice(0, maxRows)
}

/**
 * 查询某 PDB 条目指定实体的 UniProt accession（序列模式回填元数据用）。
 * v2.16：entityNum 由 RCSB 序列检索命中的实体序号传入（复合物按命中链归属 —
 * 不再近似取主实体；NCBI pdbaa 命中无实体信息时仍缺省 entity 1）。
 */
export async function fetchUniprotForEntryEntity(entryId: string, entityNum = 1): Promise<string | null> {
  try {
    const res = await fetch(
      `https://data.rcsb.org/rest/v1/core/polymer_entity/${entryId}/${entityNum}`,
      { signal: AbortSignal.timeout(15_000) },
    )
    if (!res.ok) return null
    const j = (await res.json()) as { rcsb_polymer_entity_container_identifiers?: { uniprot_ids?: string[] } }
    const acc = j?.rcsb_polymer_entity_container_identifiers?.uniprot_ids?.[0]
    return typeof acc === 'string' && acc.trim() ? acc.trim() : null
  } catch {
    return null
  }
}
