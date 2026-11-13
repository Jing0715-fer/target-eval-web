/**
 * NCBI BLAST (URL API) — blastp vs pdbaa，同源 PDB 检索。
 * 内存策略：HITLIST_SIZE 50；每轮响应即解析即释放。
 *
 * v1.8 调度策略（用户反馈「BLAST 轮询 5 分钟后超时」）：
 *  - 提交与收集拆分：submitBlastPdb 尽早触发（pipeline 在等待期做其他数据检索），
 *    collectBlastPdb 在需要命中数据时才回收结果
 *  - 「仍在运行不判失败」：NCBI 侧仍在计算期间持续轮询，
 *    不再因 5 分钟墙钟而超时报错；仅 FAILED / RID 过期 / 网络长期不可达才失败
 *  - 僵尸保险：绝对上限 30 分钟（NCBI 队列极端异常时自愈，日志明确标注）
 *
 * v1.9 RCSB 兜底（用户反馈「提交 30 分钟仍无结果 RID=D3612K1N016」）：
 *  - 实测 2026-10-16：NCBI 队列患病时新任务长期卡 WAITING（排队未计算），
 *    沙箱出口 IP 经 NAT 池轮换也使结果回收不稳定
 *  - collectBlastPdbWithRescue：排队 ~90s / 计算 ~240s / 失败 / 僵尸时自动切换
 *    RCSB 序列搜索（mmseqs2，单请求秒级、无队列），同源结构不再因 NCBI 单点故障丢失
 */
import { searchRcsbHomologs } from './rcsb-search'
import type { BlastHit } from './types'

const BLAST_URL = 'https://blast.ncbi.nlm.nih.gov/blast/Blast.cgi'
/** RUNNING 状态下的绝对僵尸保险上限（仅极端异常时触发，不是常规超时） */
const MAX_POLL_WALL_MS = 30 * 60_000
/** 连续网络失败次数上限（~3 分钟完全不可达才判失败；单次抖动继续重试） */
const MAX_CONSECUTIVE_NET_FAILS = 30

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('aborted', 'AbortError')); return }
    const onAbort = () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')) }
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function parseBlastXml(xml: string): BlastHit[] {
  const hits: BlastHit[] = []
  const hitRe = /<Hit>([\s\S]*?)<\/Hit>/g
  let m: RegExpExecArray | null
  while ((m = hitRe.exec(xml))) {
    const h = m[1]
    const def = h.match(/<Hit_def>([\s\S]*?)<\/Hit_def>/)?.[1]?.trim() ?? ''
    const acc = h.match(/<Hit_accession>([\s\S]*?)<\/Hit_accession>/)?.[1]?.trim() ?? ''
    if (!acc) continue
    // pdbaa 的 Hit_accession 形如 "5HT2B_HUMAN" 或 4 字符 PDB chain id
    const pdbIdMatch = acc.match(/^([0-9][A-Za-z0-9]{3})/)
    const firstHsp = /<Hsp>([\s\S]*?)<\/Hsp>/.exec(h)
    if (!firstHsp) continue
    const hsp = firstHsp[1]
    const identityRaw = parseFloat(hsp.match(/<Hsp_identity>([\s\S]*?)<\/Hsp_identity>/)?.[1] ?? '0')
    const alignLen = parseInt(hsp.match(/<Hsp_align-len>([\s\S]*?)<\/Hsp_align-len>/)?.[1] ?? '0', 10)
    const identity = alignLen > 0 ? Math.round((identityRaw / alignLen) * 1000) / 10 : 0
    const evalueRaw = hsp.match(/<Hsp_evalue>([\s\S]*?)<\/Hsp_evalue>/)?.[1]?.trim() ?? '0'
    const queryFrom = parseInt(hsp.match(/<Hsp_query-from>([\s\S]*?)<\/Hsp_query-from>/)?.[1] ?? '0', 10)
    const queryTo = parseInt(hsp.match(/<Hsp_query-to>([\s\S]*?)<\/Hsp_query-to>/)?.[1] ?? '0', 10)
    const queryCoverage = queryTo > queryFrom ? queryTo - queryFrom + 1 : 0
    hits.push({
      pdbId: pdbIdMatch ? pdbIdMatch[1].toUpperCase() : '',
      description: def.replace(/<[^>]+>/g, '').slice(0, 160),
      identity,
      evalue: parseFloat(evalueRaw) || 0,
      evalueRaw,
      queryCoverage,
      queryFrom: queryFrom > 0 ? queryFrom : undefined,
      queryTo: queryTo > 0 ? queryTo : undefined,
      method: '',
      resolution: null,
    })
    if (hits.length >= 50) break
  }
  // 同 PDB 去重取最高 identity
  const seen = new Map<string, BlastHit>()
  for (const h of hits) {
    const key = h.pdbId || h.description.slice(0, 40)
    const existing = seen.get(key)
    if (!existing || h.identity > existing.identity) seen.set(key, h)
  }
  return [...seen.values()].sort((a, b) => b.identity - a.identity)
}

export interface BlastSubmitResult {
  rid: string
  rtoe: number
}

/**
 * 提交 BLASTp 任务（含 2 次退避重试），立即返回 RID。
 * 提交后 NCBI 侧即开始排队/计算 —— 调用方可在收集结果前先做其他工作。
 */
export async function submitBlastPdb(
  sequence: string,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal,
): Promise<BlastSubmitResult> {
  if (!sequence || sequence.length < 30) throw new Error('序列过短（<30 aa），无法 BLAST')

  onProgress?.('提交 BLASTp 任务到 NCBI (pdbaa)…')
  const submitBody = new URLSearchParams({
    CMD: 'Put',
    PROGRAM: 'blastp',
    DATABASE: 'pdbaa',
    QUERY: sequence,
    HITLIST_SIZE: '50',
    EXPECT: '1e-5',
    FILTER: 'F',
  })
  // 提交重试（2 次退避重试）：网络抖动/NCBI 瞬时 5xx 不应导致整个 BLAST 阶段放弃
  let submitText: string | null = null
  let lastSubmitErr: unknown = null
  for (let attempt = 0; attempt < 3 && submitText === null; attempt++) {
    try {
      const res = await fetch(BLAST_URL, { method: 'POST', body: submitBody, signal: AbortSignal.timeout(30_000) })
      if (!res.ok) throw new Error(`BLAST 提交失败 HTTP ${res.status}`)
      submitText = await res.text()
    } catch (e) {
      if (signal?.aborted && e instanceof DOMException && e.name === 'AbortError') throw e
      lastSubmitErr = e
      if (attempt < 2) {
        onProgress?.(`BLAST 提交失败（第 ${attempt + 1} 次），${2 + attempt * 3}s 后重试…`)
        await sleep(2000 + attempt * 3000, signal)
      }
    }
  }
  if (submitText === null) {
    throw lastSubmitErr instanceof Error ? lastSubmitErr : new Error('BLAST 提交失败（已重试 3 次）')
  }
  const rid = submitText.match(/RID\s*=\s*(\S+)/)?.[1]
  const rtoe = parseInt(submitText.match(/RTOE\s*=\s*(\d+)/)?.[1] ?? '15', 10)
  if (!rid) throw new Error('BLAST 未返回 RID')
  onProgress?.(`BLAST 已提交 (RID=${rid}，预计 ${rtoe}s)`)
  return { rid, rtoe }
}

/** 收集结果的来源通道（前端/报告据此标注数据来源） */
export type BlastProvider = 'ncbi' | 'rcsb'

export interface BlastCollectOutcome {
  hits: BlastHit[]
  provider: BlastProvider
  /** 兜底切换原因（provider='rcsb' 时存在，用于状态注记与日志） */
  rescueNote?: string
}

/** RCSB 兜底触发策略（collectBlastPdbWithRescue 用） */
export interface BlastRescuePolicy {
  /** 持续 WAITING（排队未计算）触发兜底的时长，默认 90s */
  waitingMs?: number
  /** 持续 SEARCHING（计算超长）触发兜底的时长，默认 240s */
  searchingMs?: number
  maxRows?: number
  /** v1.28 硬性墙钟上限（超过即放弃并拋错，用于 last-resort 重试场景）；
   *  缺省时沿用 30 分钟僵尸保险（「仍在运行不判失败」语义） */
  maxWallMs?: number
}

/** v1.28：RCSB 兜底的最大尝试次数（单次失败不再永久标不可用 — 网络抖动/限流常为瞬时） */
const MAX_RESCUE_ATTEMPTS = 3

/**
 * 收集 BLAST 结果（含 RCSB 兜底，v1.9）。
 *
 * 核心策略：
 *  - NCBI 出结果 → 用 NCBI（BLASTp 权威结果，常态 30–90s）
 *  - NCBI 队列拥堵（WAITING 超阈值）/ 计算超长（SEARCHING 超阈值）/ 失败 / 僵尸 →
 *    自动切换 RCSB 序列搜索获得同源结构（mmseqs2，单请求秒级、无队列）
 *  - 兜底也失败（RCSB 不可用）→ 回落 v1.8 语义：NCBI 仍在运行就不判失败，直至僵尸保险
 *  - 调用方 AbortSignal 取消 → 抛 AbortError
 */
export async function collectBlastPdbWithRescue(
  rid: string,
  rtoe: number,
  sequence: string,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal,
  policy: BlastRescuePolicy = {},
): Promise<BlastCollectOutcome> {
  const waitingMs = policy.waitingMs ?? 90_000
  const searchingMs = policy.searchingMs ?? 240_000
  /** v1.28：last-resort 重试场景传入硬性墙钟；常规路径维持 30 分钟僵尸保险 */
  const wallMs = policy.maxWallMs ?? MAX_POLL_WALL_MS
  const startedAt = Date.now()
  let attempts = 0
  let netFails = 0
  /** 状态连续时长跟踪（WAITING↔SEARCHING 转换时重置） */
  let waitingSince = Date.now()
  let searchingSince: number | null = null
  /** v1.28：RCSB 兜底多次重试 — 失败后按退避节奏重试，最多 MAX_RESCUE_ATTEMPTS 次 */
  let rescueFails = 0
  let rescueNextAt = 0

  const rescueExhausted = () => rescueFails >= MAX_RESCUE_ATTEMPTS
  const secSince = (t: number) => Math.round((Date.now() - t) / 1000)

  /** 尝试 RCSB 兜底（v1.28：冷却节拍内直接跳过；连续失败达上限才判不可用）：
   *  成功返回结果；当前不可重试返回 null（调用方继续按 v1.8 语义等 NCBI） */
  const tryRescue = async (reason: string): Promise<BlastCollectOutcome | null> => {
    if (rescueExhausted() || Date.now() < rescueNextAt) return null
    if (!sequence || sequence.length < 20) return null // 无可兜底序列（兼容封装路径）
    onProgress?.(`${reason} — 切换 RCSB 序列搜索获得同源结构…（兜底第 ${rescueFails + 1}/${MAX_RESCUE_ATTEMPTS} 次）`)
    try {
      const hits = await searchRcsbHomologs(sequence, { maxRows: policy.maxRows ?? 60, signal })
      onProgress?.(`RCSB 序列检索完成（${hits.length} 个同源命中 — 与 BLAST 同源结构等效）`)
      return { hits, provider: 'rcsb', rescueNote: reason }
    } catch (e) {
      if (signal?.aborted && e instanceof DOMException && e.name === 'AbortError') throw e
      rescueFails++
      if (rescueExhausted()) {
        onProgress?.(`RCSB 兜底连续 ${rescueFails} 次失败 — 不再重试兜底，继续等待 NCBI…`)
      } else {
        const wait = 15_000 * rescueFails // 15s / 30s 退避
        rescueNextAt = Date.now() + wait
        onProgress?.(`RCSB 兜底失败（第 ${rescueFails}/${MAX_RESCUE_ATTEMPTS} 次，${e instanceof Error ? e.message : String(e)}），${Math.round(wait / 1000)}s 后自动重试…`)
      }
      return null
    }
  }

  while (true) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
    // 首 poll 等待 RTOE（但上限 30s — NCBI 队列拥堵时会返回极端 RTOE 如 24830s，
    // 直译会睡 ~7 小时；RTOE 只是提示值，多等不会更快，30s 后进入常规 6s 轮询）
    await sleep(attempts === 0 ? Math.min(Math.max(3000, rtoe * 1000), 30_000) : 6000, signal)
    attempts++
    const elapsed = Math.round((Date.now() - startedAt) / 1000)
    let pollRes: Response
    try {
      pollRes = await fetch(`${BLAST_URL}?CMD=Get&FORMAT_TYPE=XML&RID=${rid}`, { signal: AbortSignal.timeout(30_000) })
      netFails = 0
    } catch (e) {
      if (signal?.aborted && e instanceof DOMException && e.name === 'AbortError') throw e
      netFails++
      if (netFails >= MAX_CONSECUTIVE_NET_FAILS) {
        const rescued = await tryRescue(`NCBI 持续 ${Math.round(elapsed / 60)} 分钟网络不可达`)
        if (rescued) return rescued
        if (rescueExhausted()) {
          throw new Error(`BLAST 轮询网络不可达（连续 ${netFails} 次失败，已等 ${Math.round(elapsed / 60)} 分钟；RCSB 兜底重试 ${MAX_RESCUE_ATTEMPTS} 次均失败）`)
        }
        onProgress?.(`NCBI 网络不可达，等待 RCSB 兜底重试节拍（${rescueFails}/${MAX_RESCUE_ATTEMPTS}）…`)
        continue
      }
      onProgress?.(`网络抖动，继续轮询（已等 ${elapsed}s）`)
      continue
    }
    if (!pollRes.ok) {
      onProgress?.(`HTTP ${pollRes.status}，继续轮询（已等 ${elapsed}s）`)
      continue
    }
    const xml = await pollRes.text()
    if (xml.includes('<BlastOutput>') || xml.includes('<BlastOutput_iterations>')) {
      onProgress?.(`BLAST 完成（等待 ${Math.round((Date.now() - startedAt) / 1000)}s），解析结果…`)
      return { hits: parseBlastXml(xml), provider: 'ncbi' }
    }
    if (xml.includes('Status=FAILED') || xml.includes('Status=UNKNOWN')) {
      const reason = xml.includes('Status=FAILED') ? 'NCBI 侧执行失败' : `RID ${rid} 已过期`
      const rescued = await tryRescue(reason)
      if (rescued) return rescued
      // v1.28：兜底重试冷却中 → 不立即拋错，按退避节奏再试几次（NCBI 已终态，此处仅为等待兜底重试）
      if (rescueExhausted()) {
        throw new Error(xml.includes('Status=FAILED') ? 'BLAST 任务在 NCBI 侧失败' : `BLAST RID ${rid} 已过期`)
      }
      onProgress?.(`NCBI ${reason}；RCSB 兜底重试中（${rescueFails}/${MAX_RESCUE_ATTEMPTS}）…`)
      continue
    }

    // ── 软兜底：仍在运行不判失败，但持续过久说明 NCBI 队列拥堵 → 主动 RCSB 兜底，
    //    不让用户干等 30 分钟僵尸保险（2026-10-16 实测：队列患病时 WAITING 30+ 分钟）
    const isSearching = xml.includes('Status=SEARCHING')
    if (isSearching) {
      if (searchingSince === null) {
        searchingSince = Date.now()
        waitingSince = Date.now() // 已离开排队态
      }
      if (Date.now() - searchingSince > searchingMs) {
        const rescued = await tryRescue(`NCBI 计算超长（SEARCHING ${secSince(searchingSince)}s）`)
        if (rescued) return rescued
      }
    } else {
      if (searchingSince !== null) {
        // 罕见：SEARCHING 回退 WAITING —— 重置计时
        searchingSince = null
        waitingSince = Date.now()
      }
      if (Date.now() - waitingSince > waitingMs) {
        const rescued = await tryRescue(`NCBI 队列拥堵（排队 ${secSince(waitingSince)}s 未开始计算）`)
        if (rescued) return rescued
      }
    }

    // 僵尸保险 / 硬性墙钟（v1.28：last-resort 场景可收紧上限；兜底不可用且仍无结果才拋错）
    if (Date.now() - startedAt > wallMs) {
      const reason = policy.maxWallMs != null
        ? `本轮限时 ${Math.round(wallMs / 60000)} 分钟已到`
        : `NCBI 队列异常：BLAST 已提交 ${Math.round(wallMs / 60000)} 分钟仍无结果`
      const rescued = await tryRescue(reason)
      if (rescued) return rescued
      if (rescueExhausted() || policy.maxWallMs != null) {
        throw new Error(`${reason}（RID=${rid}；RCSB 兜底${rescueExhausted() ? `重试 ${MAX_RESCUE_ATTEMPTS} 次均失败` : '不可用'}）`)
      }
    }
    onProgress?.(
      isSearching
        ? `NCBI 计算中（第 ${attempts} 次，已 ${elapsed}s — 运行中不判超时）`
        : `NCBI 排队中（第 ${attempts} 次，已 ${elapsed}s）`,
    )
  }
}

/**
 * 收集 BLAST 结果（v1.8 兼容语义，无软兜底）：
 * RUNNING/WAITING 期间不因墙钟失败；仅 FAILED / RID 过期 / 网络长期不可达 / 僵尸保险报错。
 */
export async function collectBlastPdb(
  rid: string,
  rtoe: number,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal,
): Promise<BlastHit[]> {
  // 无序列可兜底（sequence=''）→ 软兜底与硬兜底均直接跳过，行为与 v1.8 完全一致
  const outcome = await collectBlastPdbWithRescue(rid, rtoe, '', onProgress, signal)
  return outcome.hits
}

export interface BlastRunResult {
  hits: BlastHit[]
  rid: string
  durationMs: number
  skipped: boolean
  skipReason?: string
}

/**
 * 运行 BLASTp（pdbaa 数据库）：提交 + 阻塞收集（含 RCSB 兜底，v1.9）。
 */
export async function runBlastPdb(
  sequence: string,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal,
): Promise<BlastHit[]> {
  const { rid, rtoe } = await submitBlastPdb(sequence, onProgress, signal)
  const outcome = await collectBlastPdbWithRescue(rid, rtoe, sequence, onProgress, signal)
  return outcome.hits
}

// ─── v1.28 last-resort 整周期重试 ─────────────────────────────────────────

export interface BlastRetryRunResult {
  hits: BlastHit[]
  provider: BlastProvider
  /** 成功通道说明（哪一轮、哪条通道） */
  note: string
}

export interface BlastRetryOptions {
  /** 完整重试轮数（每轮 = RCSB 直连 + NCBI 提交收集），默认 2 */
  attempts?: number
  /** 每轮 NCBI 通道的硬性墙钟，默认 4 分钟 */
  attemptWallMs?: number
  /** 轮间退避，默认 30s */
  backoffMs?: number
}

/**
 * v1.28 整周期 BLAST 重试（用户反馈「无结构且 BLAST 失败时不要贸然生成报告」）。
 *
 * 触发场景：pipeline 结构证据守门 — 无直接结构且常规 BLAST（含单次兜底）失败时，
 * 作为最后一道检索通道再给结构证据一次机会：
 *  - 每轮先试 RCSB 序列检索（单请求秒级、无队列 — 常规阶段刚失败的场景下往往已恢复）；
 *    ⚠️ 返回空数组 = 「检索成功且确无同源结构」，是有效结论（调用方据此生成报告），
 *    仅抛异常才视为通道失败
 *  - RCSB 异常 → NCBI 完整周期（提交自带 3 次退避重试 + 收集带多次兜底 + 硬性墙钟）
 *  - 全部轮次失败 → 抛错（调用方中止报告生成并提示用户手动重试）
 */
export async function runBlastWithRetry(
  sequence: string,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal,
  opts: BlastRetryOptions = {},
): Promise<BlastRetryRunResult> {
  const attempts = Math.max(1, Math.min(3, opts.attempts ?? 2))
  const attemptWallMs = opts.attemptWallMs ?? 4 * 60_000
  const backoffMs = opts.backoffMs ?? 30_000
  if (!sequence || sequence.length < 20) throw new Error('序列过短（<20 aa），无可用的同源检索通道')

  const errors: string[] = []
  for (let i = 1; i <= attempts; i++) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
    // 通道 A：RCSB 直连（秒级 — 优先尝试，空命中亦是有效结论）
    try {
      onProgress?.(`重试第 ${i}/${attempts} 轮 — 先尝试 RCSB 序列检索（单请求秒级、无队列）…`)
      const hits = await searchRcsbHomologs(sequence, { maxRows: 60, signal })
      onProgress?.(hits.length
        ? `RCSB 序列检索成功（${hits.length} 个同源命中）`
        : 'RCSB 序列检索成功 — 确无显著同源结构（有效结论，非失败）')
      return {
        hits,
        provider: 'rcsb',
        note: `第 ${i}/${attempts} 轮经 RCSB 序列检索成功${hits.length ? `（${hits.length} 个命中）` : '（确无同源命中）'}`,
      }
    } catch (e) {
      if (signal?.aborted && e instanceof DOMException && e.name === 'AbortError') throw e
      errors.push(`第 ${i} 轮 RCSB：${e instanceof Error ? e.message : String(e)}`)
      onProgress?.(`RCSB 序列检索失败（第 ${i}/${attempts} 轮）：${e instanceof Error ? e.message : String(e)}`)
    }
    // 通道 B：NCBI 完整周期（提交 3 次退避重试 + 收集多次兜底 + 本轮硬性墙钟）
    try {
      onProgress?.(`改走 NCBI BLASTp 完整周期（本轮限时 ${Math.round(attemptWallMs / 60000)} 分钟）…`)
      const { rid, rtoe } = await submitBlastPdb(sequence, onProgress, signal)
      const outcome = await collectBlastPdbWithRescue(rid, rtoe, sequence, onProgress, signal, {
        waitingMs: 45_000,
        searchingMs: 90_000,
        maxWallMs: attemptWallMs,
      })
      onProgress?.(outcome.provider === 'rcsb'
        ? `本轮经 RCSB 兜底完成（${outcome.hits.length} 个命中）`
        : `NCBI BLASTp 完成（${outcome.hits.length} 个命中）`)
      return {
        hits: outcome.hits,
        provider: outcome.provider,
        note: `第 ${i}/${attempts} 轮成功（${outcome.provider === 'ncbi' ? 'NCBI BLASTp' : `RCSB 兜底 — ${outcome.rescueNote ?? ''}`.trim()}）`,
      }
    } catch (e) {
      if (signal?.aborted && e instanceof DOMException && e.name === 'AbortError') throw e
      errors.push(`第 ${i} 轮 NCBI：${e instanceof Error ? e.message : String(e)}`)
      onProgress?.(`NCBI 通道失败（第 ${i}/${attempts} 轮）：${e instanceof Error ? e.message : String(e)}`)
    }
    if (i < attempts) {
      onProgress?.(`第 ${i} 轮全部通道失败，${Math.round(backoffMs / 1000)}s 后进行第 ${i + 1} 轮…`)
      await sleep(backoffMs, signal)
    }
  }
  throw new Error(`同源检索 ${attempts} 轮重试均失败 — ${errors.join('；').slice(0, 300)}`)
}

/** 用 RCSB GraphQL 批量接口补齐 BLAST 命中的方法/分辨率/结构标题（每批 25 条）。
 *  注：REST core/entry 不支持逗号分隔多 ID（404）— v1.9 修复 v1.7 起的静默失效：
 *  旧实现的批量 REST 请求从未成功过（BLAST 命中长期缺方法/分辨率），GraphQL 才是正确批量通道。 */
export async function enrichBlastHits(hits: BlastHit[], excludePdbIds: Set<string>): Promise<BlastHit[]> {
  const need = hits.filter(h => h.pdbId && !excludePdbIds.has(h.pdbId))
  const enriched = new Map<string, BlastHit>()
  const query = `query($ids:[String!]!){
    entries(entry_ids:$ids){
      rcsb_id
      struct { title }
      exptl { method }
      rcsb_entry_info { resolution_combined }
    }
  }`
  for (let i = 0; i < need.length; i += 25) {
    const batch = need.slice(i, i + 25)
    try {
      const res = await fetch('https://data.rcsb.org/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { ids: batch.map(h => h.pdbId) } }),
        signal: AbortSignal.timeout(20_000),
      })
      if (!res.ok) continue
      const data = (await res.json()) as {
        data?: {
          entries?: Array<{
            rcsb_id?: string
            struct?: { title?: unknown }
            exptl?: Array<{ method?: unknown }>
            rcsb_entry_info?: { resolution_combined?: unknown }
          }>
        }
      }
      for (const d of data.data?.entries ?? []) {
        const id = String(d?.rcsb_id ?? '').toUpperCase()
        if (!id) continue
        const method = typeof d.exptl?.[0]?.method === 'string' ? d.exptl[0].method : ''
        const resArr = Array.isArray(d.rcsb_entry_info?.resolution_combined) ? d.rcsb_entry_info.resolution_combined : []
        // 结构标题：RCSB 序列检索兜底的命中无 pdbaa 描述（description 为空），
        // 用 PDB entry 标题补齐，保证前端表格与 LLM 摘要可读
        const title = typeof d.struct?.title === 'string' ? d.struct.title.trim() : ''
        enriched.set(id, {
          method,
          resolution: typeof resArr[0] === 'number' ? resArr[0] : null,
          description: title.slice(0, 160),
        } as Partial<BlastHit> as BlastHit)
      }
    } catch { /* 批次失败忽略 */ }
  }
  return need.map(h => {
    const e = enriched.get(h.pdbId)
    return e ? { ...h, method: e.method, resolution: e.resolution, description: h.description || e.description } : h
  })
}
