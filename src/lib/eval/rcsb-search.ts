/**
 * RCSB 序列搜索（mmseqs2 全库检索）— NCBI BLAST 队列拥堵时的同源结构兜底通道。
 *
 * 背景（2026-10 实测）：NCBI BLAST URL API 队列会出现长时间 WAITING（30+ 分钟不开始
 * 计算），且公网部署出口 IP 经 NAT 池轮换时结果回收不可靠。RCSB 官方序列搜索接口：
 *  - 单次 HTTP 请求、无队列、无轮询（1–3s 返回）
 *  - 直接检索 PDB 全部聚合物实体（正是「同源结构」的语义本体）
 *  - verbose 模式返回 sequence_identity / evalue / 覆盖区间 —— 与 BLAST 命中同构
 *
 * 结果映射为 BlastHit[]（pdbId / identity% / evalue / queryCoverage），
 * 方法与分辨率由 enrichBlastHits 经 RCSB data API 补齐（含结构标题作为描述）。
 */
import type { BlastHit } from './types'

const SEARCH_URL = 'https://search.rcsb.org/rcsbsearch/v2/query'

export interface RcsbSearchOptions {
  /** 最多保留的命中条目数（按 identity 降序） */
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

  const res = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(30_000),
  })
  // 204 = 无命中（RCSB 搜索服务的空结果约定）
  if (res.status === 204) return []
  if (!res.ok) throw new Error(`RCSB 序列检索失败 HTTP ${res.status}`)

  const data = (await res.json()) as { result_set?: RcsbSearchHit[]; total_count?: number }
  const rows = data.result_set ?? []

  // polymer_entity 标识形如 "3QWQ_1"（条目_id 实体序号）→ 取 PDB 条目号；同一 PDB 多实体取最高 identity
  const seen = new Map<string, BlastHit>()
  for (const row of rows) {
    const ident = (row.identifier ?? '').trim()
    const pdbId = ident.split('_')[0]?.toUpperCase() ?? ''
    if (!/^[0-9][A-Z0-9]{3}$/.test(pdbId)) continue
    const ctx = row.services?.[0]?.nodes?.[0]?.match_context?.[0]
    if (!ctx || typeof ctx.sequence_identity !== 'number') continue
    const hit: BlastHit = {
      pdbId,
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
    if (!existing || hit.identity > existing.identity) seen.set(pdbId, hit)
    if (seen.size >= maxRows * 2) break // 实体级条目上限保护（内存策略：命中集恒小）
  }

  return [...seen.values()]
    .sort((a, b) => b.identity - a.identity || a.evalue - b.evalue)
    .slice(0, maxRows)
}

/**
 * 查询某 PDB 条目指定实体的 UniProt accession（序列模式回填元数据用）。
 * 近似取主实体（entity 1）— 仅在 identity ≥85% 的近同源回填场景调用，可接受。
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
