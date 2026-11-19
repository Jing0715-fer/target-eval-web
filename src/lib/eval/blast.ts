/**
 * NCBI BLAST (URL API) — blastp vs pdbaa，同源 PDB 检索。
 * 内存策略：HITLIST_SIZE 50；每轮响应即解析即释放。
 *
 * v1.8 调度策略（用户反馈「BLAST 轮询 5 分钟后超时」）：
 *  - 提交与收集拆分：submitBlastPdb 尽早触发（pipeline 在等待期做其他数据检索），
 *    collectBlastPdb 在需要命中数据时才回收结果
 *  - 「仍在运行不判失败」：NCBI 侧仍在计算期间持续轮询，
 *    不再因 5 分钟墙钟而超时报错；仅 FAILED / RID 过期 / 网络长期不可达才失败
 *
 * v1.9 RCSB 兜底（用户反馈「提交 30 分钟仍无结果 RID=D3612K1N016」）：
 *  - 实测 2026-10-16：NCBI 队列患病时新任务长期卡 WAITING（排队未计算），
 *    沙箱出口 IP 经 NAT 池轮换也使结果回收不稳定
 *  - collectBlastPdbWithRescue：排队 ~90s / 计算 ~240s / 失败 / 僵尸时自动切换
 *    RCSB 序列搜索（mmseqs2，单请求秒级、无队列），同源结构不再因 NCBI 单点故障丢失
 *
 * v2.39 僵尸保险语义重设计（用户诉求「不必 30 分钟一刀切：所有任务都完成后，
 * 再轮询 30 分钟再超时」）：
 *  - 常规路径不再从提交时刻起 30 分钟硬超时 — 只要全场（服务端作业注册表）
 *    还有其他评估作业在跑，本 BLAST 就继续轮询不判超时（BLAST 慢是常态，
 *    其他作业照常推进，杀掉只会浪费已等待的时间）
 *  - 当本作业已是全场最后一个未收尾作业时，再给 30 分钟终局等待窗口，
 *    仍无结果才走 RCSB 兜底 / 报错
 *  - last-resort 紧预算场景（policy.maxWallMs 显式传入）保留硬性墙钟不变
 *
 * v2.39 BLAST 预提交注册表（用户诉求「先把 BLAST 都提交起来，加快进度」）：
 *  - 高通量启动时 /api/evaluate/blast-warmup 把全部待评估序列按全局节拍（~15s/发）
 *    提前提交 NCBI — 作业还在队列排队时 NCBI 已在计算
 *  - 管线 blast-submit 阶段按「规范化序列哈希」命中预提交 RID，命中即跳过提交
 *    直接收集（慢队列下总时长大幅缩短）；排队过深的条目放弃，改由管线当场提交
 */
import { createHash } from 'node:crypto'
import { searchRcsbHomologs } from './rcsb-search'
import type { BlastHit } from './types'

const BLAST_URL = 'https://blast.ncbi.nlm.nih.gov/blast/Blast.cgi'
/** v2.39 终局等待窗口：全场其他作业都收尾后，本 BLAST 再等这么久仍无结果才判失败 */
const MAX_ALONE_WALL_MS = 30 * 60_000
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
  // v2.32 同 PDB 去重与排序改为显著性口径（e-value 升序，一致性/覆盖率打破平局）—
  // 旧 identity 降序排序会把「短片段 100% 巧合命中」（如信号肽样 21 aa 片段恰好
  // 完全匹配大蛋白局部）浮到首位，下游靶点回填/命名被误导（用户实测：ADSL 截短
  // 构建被错绑到 SARS-CoV-2 P0DTD1）。E-value 才是比对显著性的正统度量，
  // 与 NCBI BLAST 原生输出顺序一致。
  const seen = new Map<string, BlastHit>()
  for (const h of hits) {
    const key = h.pdbId || h.description.slice(0, 40)
    const existing = seen.get(key)
    if (!existing || h.evalue < existing.evalue
      || (h.evalue === existing.evalue && (h.identity > existing.identity
        || (h.identity === existing.identity && h.queryCoverage > existing.queryCoverage)))) {
      seen.set(key, h)
    }
  }
  return [...seen.values()].sort(
    (a, b) => a.evalue - b.evalue || b.identity - a.identity || b.queryCoverage - a.queryCoverage,
  )
}

export interface BlastSubmitResult {
  rid: string
  rtoe: number
}

/**
 * 提交 BLASTp 任务（含重试），立即返回 RID。
 * 提交后 NCBI 侧即开始排队/计算 —— 调用方可在收集结果前先做其他工作。
 * v2.36：「HTTP 200 但无 RID」（NCBI 限流页 — resource temporarily unavailable /
 *  traffic limit）同样可重试 — 之前只重试网络/5xx 错误，限流页直接放弃。
 */
const BLAST_RETRY_DELAYS_MS = [3000, 8000, 15000]

async function submitBlastPut(
  opts: {
    database: string
    hitlist: number
    sequence: string
    label: string
    onProgress?: (msg: string) => void
    signal?: AbortSignal
  },
): Promise<BlastSubmitResult> {
  const { database, hitlist, sequence, label, onProgress, signal } = opts
  const submitBody = new URLSearchParams({
    CMD: 'Put',
    PROGRAM: 'blastp',
    DATABASE: database,
    QUERY: sequence,
    HITLIST_SIZE: String(hitlist),
    EXPECT: '1e-5',
    FILTER: 'F',
  })
  const attempts = BLAST_RETRY_DELAYS_MS.length + 1
  let lastErr: unknown = null
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(BLAST_URL, { method: 'POST', body: submitBody, signal: signal ?? AbortSignal.timeout(30_000) })
      if (!res.ok) throw new Error(`${label} 提交失败 HTTP ${res.status}`)
      const text = await res.text()
      const rid = text.match(/RID\s*=\s*(\S+)/)?.[1]
      if (rid) {
        const rtoe = parseInt(text.match(/RTOE\s*=\s*(\d+)/)?.[1] ?? '15', 10)
        onProgress?.(`${label} 已提交 (RID=${rid}，预计 ${rtoe}s)${attempt > 0 ? `（第 ${attempt + 1} 次尝试成功）` : ''}`)
        return { rid, rtoe }
      }
      // HTTP 200 但无 RID — NCBI 匿名提交限流（高峰期常见），退避后重试
      throw new Error(`${label} 未返回 RID（NCBI 限流/资源暂时不可用）`)
    } catch (e) {
      if (signal?.aborted && e instanceof DOMException && e.name === 'AbortError') throw e
      lastErr = e
      if (attempt < attempts - 1) {
        const delay = BLAST_RETRY_DELAYS_MS[attempt] ?? 15000
        onProgress?.(`${label} 提交失败（第 ${attempt + 1} 次：${e instanceof Error ? e.message : '未知错误'}），${Math.round(delay / 1000)}s 后重试…`)
        await sleep(delay, signal)
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`${label} 提交失败（已重试 ${attempts} 次）`)
}

export async function submitBlastPdb(
  sequence: string,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal,
): Promise<BlastSubmitResult> {
  if (!sequence || sequence.length < 30) throw new Error('序列过短（<30 aa），无法 BLAST')
  onProgress?.('提交 BLASTp 任务到 NCBI (pdbaa)…')
  return submitBlastPut({ database: 'pdbaa', hitlist: 50, sequence, label: 'BLAST', onProgress, signal })
}

/** 收集结果的来源通道（前端/报告据此标注数据来源） */
export type BlastProvider = 'ncbi' | 'rcsb'

export interface BlastCollectOutcome {
  hits: BlastHit[]
  provider: BlastProvider
  /** 兜底切换原因（provider='rcsb' 时存在，用于状态注记与日志） */
  rescueNote?: string
}

/** v2.6 轮询续跑状态（跨段保存：RID 在 NCBI 侧存活，轮询本身是无状态 HTTP GET） */
export interface BlastPollState {
  rid: string
  rtoe: number
  /** 提交时刻（跨段保留，用于墙钟/软兜底计时） */
  startedAt: number
  waitingSince: number
  searchingSince: number | null
  attempts: number
  netFails: number
  rescueFails: number
  rescueNextAt: number
  /** v2.39 终局窗口计时锚点：首次观测到「全场只剩本作业」的时刻（null = 尚未孤立） */
  aloneSince?: number | null
}

export interface BlastCollectOpts {
  /** 分段预算（epoch ms）：到点且仍在轮询 → 返回 stillRunning 而非拋错 */
  deadline?: number
  /** 上段保存的轮询状态（续跑） */
  resume?: BlastPollState
  /** v2.16：nr 识别的墙钟覆写（短预算尝试；缺省用 MAX_NR_WALL_MS） */
  maxWallMs?: number
  /** v2.39 全场还有其他评估作业（pending/running）时返回 true — 僵尸保险不判超时
   *  （等全场收尾；由管线传入，基于服务端作业注册表判定） */
  othersActive?: () => boolean
}

/** 收集返回：终态 outcome 或「仍在运行（预算到点）」的续跑状态 */
export type BlastCollectResult = BlastCollectOutcome | { stillRunning: true; pollState: BlastPollState }
/** RCSB 兜底触发策略（collectBlastPdbWithRescue 用） */
export interface BlastRescuePolicy {
  /** 持续 WAITING（排队未计算）触发兜底的时长，默认 90s */
  waitingMs?: number
  /** 持续 SEARCHING（计算超长）触发兜底的时长，默认 240s */
  searchingMs?: number
  maxRows?: number
  /** v1.28 硬性墙钟上限（超过即放弃并拋错，用于 last-resort 重试场景）；
   *  缺省（v2.39）走「全场收尾 + 30 分钟终局窗口」的软僵尸保险 */
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
  opts: BlastCollectOpts = {},
): Promise<BlastCollectResult> {
  const waitingMs = policy.waitingMs ?? 90_000
  const searchingMs = policy.searchingMs ?? 240_000
  /** v1.28：last-resort 重试场景传入硬性墙钟（缺省 null = v2.39 软僵尸保险） */
  const hardWallMs = policy.maxWallMs ?? null
  const startedAt = opts.resume?.startedAt ?? Date.now()
  let attempts = opts.resume?.attempts ?? 0
  let netFails = opts.resume?.netFails ?? 0
  /** 状态连续时长跟踪（WAITING↔SEARCHING 转换时重置） */
  let waitingSince = opts.resume?.waitingSince ?? Date.now()
  let searchingSince = opts.resume?.searchingSince ?? null
  /** v1.28：RCSB 兜底多次重试 — 失败后按退避节奏重试，最多 MAX_RESCUE_ATTEMPTS 次 */
  let rescueFails = opts.resume?.rescueFails ?? 0
  let rescueNextAt = opts.resume?.rescueNextAt ?? 0
  /** v2.39 终局窗口锚点（全场只剩本作业的首个观测时刻；其他作业出现即重置） */
  let aloneSince = opts.resume?.aloneSince ?? null

  const rescueExhausted = () => rescueFails >= MAX_RESCUE_ATTEMPTS
  const secSince = (t: number) => Math.round((Date.now() - t) / 1000)
  /** v2.6：轮询状态快照（预算到点时随 stillRunning 返回，跨段续跑） */
  const snapshot = (): BlastPollState => ({ rid, rtoe, startedAt, waitingSince, searchingSince, attempts, netFails, rescueFails, rescueNextAt, aloneSince })
  /** v2.6：剩余预算不足一轮完整轮询（首等最多 30s / 常规 6s + GET）→ 不开启新轮询，交还续跑 */
  const budgetLeft = () => (opts.deadline != null && opts.deadline > 0 ? opts.deadline - Date.now() : Infinity)

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
    // v2.6.3 分段预算自适应：原固定闸门（首等 35s / 常规 12s）按 55s 段设计 —
    // 部署 14s 段下首轮轮询永远开不了（每段空转交还，100 段死循环实测）。
    // 现改：剩余 ≥6s 即开轮（等待时长已钳到预算内，见下方 clampedSleep），
    // 到点交还续跑（RID 在 NCBI 侧存活，pollState 随 checkpoint 往返）。
    if (budgetLeft() < 6_000) {
      return { stillRunning: true, pollState: snapshot() }
    }
    // 首 poll 等待 RTOE（但上限 30s — NCBI 队列拥堵时会返回极端 RTOE 如 24830s，
    // 直译会睡 ~7 小时；RTOE 只是提示值，多等不会更快，30s 后进入常规 6s 轮询）；
    // v2.6.3：等待时长钳制到段预算内（留 4s GET 余量 — 小段下截短等待，
    // 不越过段边界使 checkpoint 迟到）
    const clampedSleep = (ms: number): number => {
      const bl = budgetLeft()
      return bl === Infinity ? ms : Math.max(2_000, Math.min(ms, bl - 4_000))
    }
    await sleep(clampedSleep(attempts === 0 ? Math.min(Math.max(3000, rtoe * 1000), 30_000) : 6000), signal)
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

    // ── 僵尸保险（v2.39 语义重设计）：硬性墙钟仅保留给 last-resort 紧预算场景；
    //    常规路径 =「全场收尾 + 终局窗口」—
    //    · 全场还有其他评估作业在跑（othersActive）→ 不判超时，继续轮询
    //    · 本作业已是全场最后一个 → 再等 30 分钟终局窗口，仍无结果才兜底/报错
    if (hardWallMs != null) {
      if (Date.now() - startedAt > hardWallMs) {
        const reason = `本轮限时 ${Math.round(hardWallMs / 60000)} 分钟已到`
        const rescued = await tryRescue(reason)
        if (rescued) return rescued
        throw new Error(`${reason}（RID=${rid}；RCSB 兜底不可用或已耗尽）`)
      }
    } else if (opts.othersActive?.() === true) {
      if (aloneSince !== null) {
        aloneSince = null
        onProgress?.(`其他评估作业已恢复进行 — 本 BLAST 继续等待不判超时（已等 ${Math.round(elapsed / 60)} 分钟）`)
      }
    } else {
      aloneSince ??= startedAt
      if (Date.now() - aloneSince > MAX_ALONE_WALL_MS) {
        const reason = `全场作业均已收尾后等待 ${Math.round(MAX_ALONE_WALL_MS / 60000)} 分钟仍无结果（NCBI 队列异常）`
        const rescued = await tryRescue(reason)
        if (rescued) return rescued
        if (rescueExhausted()) {
          throw new Error(`${reason}（RID=${rid}；RCSB 兜底重试 ${MAX_RESCUE_ATTEMPTS} 次均失败）`)
        }
        // 兜底重试冷却中 — 继续轮询等兜底节拍（与 FAILED 态同策略）
      }
    }
    onProgress?.(
      isSearching
        ? `NCBI 计算中（第 ${attempts} 次，已 ${elapsed}s — 运行中不判超时）`
        : `NCBI 排队中（第 ${attempts} 次，已 ${elapsed}s）`,
    )
    // v2.6：每轮末检查 — 到点且仍在运行 → 交还续跑（下一段继续轮询同一 RID）
    if (budgetLeft() <= 0) {
      return { stillRunning: true, pollState: snapshot() }
    }
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
  if ('hits' in outcome) return outcome.hits
  // 无 deadline 时不会返回 stillRunning；防御性处理
  throw new Error('BLAST 轮询被中断（未预期）')
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
  if ('hits' in outcome) return outcome.hits
  throw new Error('BLAST 轮询被中断（未预期）')
}

// ─── v2.39 BLAST 预提交注册表（「先把 BLAST 都提交起来」）──────────────────────

/** 全局提交节拍（对 NCBI 保持 ~4 发/分钟的礼貌速率，防批量限流/封禁） */
const PRESUBMIT_PACE_MS = 15_000
/** 注册表容量（终态条目超 1h 淘汰 — 内存有界） */
const PRESUBMIT_REGISTRY_MAX = 300
const PRESUBMIT_TTL_MS = 60 * 60_000

interface PresubmitEntry {
  phase: 'queued' | 'submitting' | 'done' | 'failed' | 'bypassed'
  startedAt: number
  rid?: string
  rtoe?: number
  error?: string
  task: Promise<{ rid: string; rtoe: number }>
}

const pg = globalThis as unknown as {
  __blastPresubmitMap?: Map<string, PresubmitEntry>
  __blastPresubmitChain?: Promise<void>
}
const presubmitMap: Map<string, PresubmitEntry> = (pg.__blastPresubmitMap ??= new Map())
let presubmitChain: Promise<void> = (pg.__blastPresubmitChain ??= Promise.resolve())

function presubmitPrune(): void {
  if (presubmitMap.size <= PRESUBMIT_REGISTRY_MAX) return
  const now = Date.now()
  for (const [k, e] of presubmitMap) {
    if (e.phase !== 'queued' && e.phase !== 'submitting' && now - e.startedAt > PRESUBMIT_TTL_MS) {
      presubmitMap.delete(k)
    }
  }
}

/** 注册表规模（warmup 路由回显用） */
export function presubmitRegistrySize(): number {
  return presubmitMap.size
}

/** 注册表键：规范化序列的 sha256 前 24 位（管线侧与 warmup 侧同口径） */
function presubmitKey(sequence: string): string {
  return createHash('sha256').update(sequence).digest('hex').slice(0, 24)
}

/**
 * 排队一条 BLAST 预提交（幂等：同序列只排一次；fire-and-forget，失败静默 —
 * 管线未命中时回退常规提交，行为不变）。返回是否新入队。
 */
export function presubmitBlastSequence(sequence: string): boolean {
  if (!sequence || sequence.length < 30) return false
  const key = presubmitKey(sequence)
  if (presubmitMap.has(key)) return false
  presubmitPrune()
  if (presubmitMap.size >= PRESUBMIT_REGISTRY_MAX) return false
  const entry = { phase: 'queued', startedAt: Date.now() } as PresubmitEntry
  entry.task = (async () => {
    // 全局节拍：串行链上排队（每发间隔 PRESUBMIT_PACE_MS — 链上每个条目依次轮到）
    const turn = presubmitChain.then(() => undefined, () => undefined)
    presubmitChain = turn.then(() => new Promise<void>((r) => setTimeout(r, PRESUBMIT_PACE_MS)))
    await turn
    if (entry.phase === 'bypassed') throw new Error('已被管线直接提交取代')
    entry.phase = 'submitting'
    const submitted = await submitBlastPdb(sequence)
    entry.phase = 'done'
    entry.rid = submitted.rid
    entry.rtoe = submitted.rtoe
    return { rid: submitted.rid, rtoe: submitted.rtoe }
  })().catch((e: unknown) => {
    if (entry.phase !== 'bypassed' && entry.phase !== 'done') entry.phase = 'failed'
    entry.error = e instanceof Error ? e.message : String(e)
    throw e
  })
  // 兜底吞掉 unhandled rejection（消费侧 take 用 race+catch 处理拒绝）
  entry.task.catch(() => undefined)
  presubmitMap.set(key, entry)
  return true
}

/**
 * 管线 blast-submit 阶段消费预提交（按规范化序列哈希命中）：
 *  - done → 立即返回 RID（NCBI 已在计算 — 预提交的意义所在；同序列多作业可复用）
 *  - submitting / queued → 最多等 graceMs（正在提交/即将轮到时秒级可得；
 *    排队太深则放弃并标记 bypassed，管线当场提交防重复）
 *  - failed / bypassed / 无预提交 → null（管线走常规提交）
 */
export async function takePresubmittedBlast(
  sequence: string,
  graceMs = 20_000,
  signal?: AbortSignal,
): Promise<{ rid: string; rtoe: number } | null> {
  if (!sequence) return null
  const entry = presubmitMap.get(presubmitKey(sequence))
  if (!entry) return null
  if (entry.phase === 'done' && entry.rid) return { rid: entry.rid, rtoe: entry.rtoe ?? 15 }
  if (entry.phase === 'failed' || entry.phase === 'bypassed') return null
  const timed = new Promise<null>((resolve) => {
    const t = setTimeout(() => resolve(null), graceMs)
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(null) }, { once: true })
  })
  const out = await Promise.race([entry.task.catch(() => null), timed])
  if (out) return out
  // 排队中的条目让位（提交在途的不动 — 完成后存为可复用条目）
  if (entry.phase === 'queued') entry.phase = 'bypassed'
  return null
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
      const outcomeRaw = await collectBlastPdbWithRescue(rid, rtoe, sequence, onProgress, signal, {
        waitingMs: 45_000,
        searchingMs: 90_000,
        maxWallMs: attemptWallMs,
      })
      if ('stillRunning' in outcomeRaw) {
        // v2.6：last-resort 路径无分段预算，不会走到这里；防御性兜底处理
        throw new Error('BLAST 轮询被中断（未预期）')
      }
      const outcome = outcomeRaw
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

// ─── v2.16 BLAST nr 靶点身份识别（纯序列输入无 UniProt 归属时的兜底）──────────────

export interface BlastNrHit {
  /** UniProt accession（sp/tr 形态命中时）；其他来源为原始 accession */
  accession: string
  /** UniProt 条目名（如 P53_HUMAN — sp|ACC|ENTRY 的第三段） */
  entryName?: string
  /** 蛋白描述（OS=/GN= 等字段前的主体描述文本） */
  description: string
  organism?: string
  geneName?: string
  /** 0-100 一致性（identity / align-len，与 parseBlastXml 同口径） */
  identity: number
  evalue: number
  evalueRaw: string
  queryCoverage: number
  /** v2.30：首个 HSP 的查询（提交序列）1-based 起止位（提交序列在命中主体上的覆盖范
   *  围证据 — 用于推导提交序列在 UniProt 条目内的残基区间，非全长按截短口径对待） */
  queryFrom?: number
  queryTo?: number
  /** v2.30：首个 HSP 的命中主体（nr 条目 = UniProt 序列）1-based 起止位 */
  hitFrom?: number
  hitTo?: number
  /** sp = SwissProt（已审校条目，UniProt 归属可信度高）；tr = TrEMBL；其他（gb/ref/pdb/无前缀） */
  db: 'sp' | 'tr' | 'other'
}

/** nr defline 的 UniProt 前缀形态：sp|P04637|P53_HUMAN / tr|A0A8G0KJC2|...
 *  注：10 位 accession（A0A8G0KJC2）的 4 位扩展段必须在捕获组内（否则只捕到前 6 位） */
const NR_UNIPROT_DEF_RE = /^(?:sp|tr)\|((?:[A-NR-Z][0-9][A-Z][A-Z0-9]{2}[0-9]|[OPQ][0-9][A-Z0-9]{3}[0-9])(?:[A-Z0-9]{3}[0-9])?)\|([^|()\s]+)\s*(.*)$/
/** defline 中的 OS= 物种与 GN= 基因字段 */
const OS_FIELD_RE = /\bOS=([^=]+?)(?=\s+(?:OX|GN|PE|SV|LH|LS)=|$)/
const GN_FIELD_RE = /\bGN=([^\s=]+)/

/** 从 nr Hit_def 描述提取 UniProt 形态字段（无 sp/tr 前缀时 db='other'，仍提取 OS/GN） */
export function parseNrDefline(def: string): { accession: string; entryName?: string; description: string; organism?: string; geneName?: string; db: 'sp' | 'tr' | 'other' } {
  const raw = def.replace(/<[^>]+>/g, '').trim()
  const uni = raw.match(NR_UNIPROT_DEF_RE)
  const body = uni ? uni[3].trim() : raw
  const os = body.match(OS_FIELD_RE)?.[1]?.trim()
  const gn = body.match(GN_FIELD_RE)?.[1]?.trim()
  // 主体描述 = 去掉 OS=/GN= 等元数据字段后的正文
  const desc = body
    .replace(/\b(?:OS|OX|GN|PE|SV|LH|LS)=[^=]*(?=\s+(?:OS|OX|GN|PE|SV|LH|LS)=|$)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (uni) {
    return {
      accession: uni[1],
      entryName: uni[2],
      description: desc.slice(0, 160),
      organism: os?.slice(0, 60),
      geneName: gn,
      db: raw.startsWith('sp|') ? 'sp' : 'tr',
    }
  }
  // 非 UniProt 形态（gb|/ref|/pdb|/裸描述）：accession 取 Hit_accession 由调用方补
  return { accession: '', description: raw.slice(0, 160), organism: os?.slice(0, 60), geneName: gn, db: 'other' }
}

/** 解析 BLAST nr XML → 命中列表（按 XML 显著性顺序保留；同 accession 去重取最高 identity） */
export function parseBlastNrXml(xml: string): BlastNrHit[] {
  const hits: BlastNrHit[] = []
  const hitRe = /<Hit>([\s\S]*?)<\/Hit>/g
  let m: RegExpExecArray | null
  while ((m = hitRe.exec(xml))) {
    const h = m[1]
    const def = h.match(/<Hit_def>([\s\S]*?)<\/Hit_def>/)?.[1]?.trim() ?? ''
    const acc = h.match(/<Hit_accession>([\s\S]*?)<\/Hit_accession>/)?.[1]?.trim() ?? ''
    if (!def && !acc) continue
    const firstHsp = /<Hsp>([\s\S]*?)<\/Hsp>/.exec(h)
    if (!firstHsp) continue
    const hsp = firstHsp[1]
    const identityRaw = parseFloat(hsp.match(/<Hsp_identity>([\s\S]*?)<\/Hsp_identity>/)?.[1] ?? '0')
    const alignLen = parseInt(hsp.match(/<Hsp_align-len>([\s\S]*?)<\/Hsp_align-len>/)?.[1] ?? '0', 10)
    const identity = alignLen > 0 ? Math.round((identityRaw / alignLen) * 1000) / 10 : 0
    const evalueRaw = hsp.match(/<Hsp_evalue>([\s\S]*?)<\/Hsp_evalue>/)?.[1]?.trim() ?? '0'
    const queryFrom = parseInt(hsp.match(/<Hsp_query-from>([\s\S]*?)<\/Hsp_query-from>/)?.[1] ?? '0', 10)
    const queryTo = parseInt(hsp.match(/<Hsp_query-to>([\s\S]*?)<\/Hsp_query-to>/)?.[1] ?? '0', 10)
    const hitFrom = parseInt(hsp.match(/<Hsp_hit-from>([\s\S]*?)<\/Hsp_hit-from>/)?.[1] ?? '0', 10)
    const hitTo = parseInt(hsp.match(/<Hsp_hit-to>([\s\S]*?)<\/Hsp_hit-to>/)?.[1] ?? '0', 10)
    const queryCoverage = queryTo > queryFrom ? queryTo - queryFrom + 1 : 0
    const parsed = parseNrDefline(def)
    const accession = parsed.accession || acc
    if (!accession) continue
    hits.push({
      accession,
      entryName: parsed.entryName,
      description: parsed.description || parsed.entryName || accession,
      organism: parsed.organism,
      geneName: parsed.geneName,
      identity,
      evalue: parseFloat(evalueRaw) || 0,
      evalueRaw,
      queryCoverage,
      queryFrom: queryFrom > 0 ? queryFrom : undefined,
      queryTo: queryTo > 0 ? queryTo : undefined,
      hitFrom: hitFrom > 0 ? hitFrom : undefined,
      hitTo: hitTo > 0 ? hitTo : undefined,
      db: parsed.db,
    })
    if (hits.length >= 20) break
  }
  // 同 accession 去重取最高 identity（isoform/重复条目）
  const seen = new Map<string, BlastNrHit>()
  for (const h of hits) {
    const existing = seen.get(h.accession)
    if (!existing || h.identity > existing.identity) seen.set(h.accession, h)
  }
  return [...seen.values()]
}

/** 提交 BLASTp 任务到 nr 库（v2.16 靶点身份识别；HITLIST 20 — 只需最佳命中定位身份） */
export async function submitBlastNr(
  sequence: string,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal,
): Promise<BlastSubmitResult> {
  if (!sequence || sequence.length < 30) throw new Error('序列过短（<30 aa），无法 BLAST nr')
  onProgress?.('提交 BLASTp 任务到 NCBI (nr)…')
  return submitBlastPut({ database: 'nr', hitlist: 20, sequence, label: 'BLAST nr', onProgress, signal })
}

/** nr 识别的墙钟上限（best-effort 通道：超时优雅放弃，不阻塞评估）。
 *  10 分钟 — NCBI 队列患病日常态（实测 WAITING 30+ 分钟），识别是增强能力，
 *  等待过长会拖垮批量队列；超时记 warn 后继续（pdbaa 主通道仍走 30 分钟僵尸保险 + RCSB 兜底） */
const MAX_NR_WALL_MS = 10 * 60_000

export type BlastNrCollectResult = { hits: BlastNrHit[] } | { stillRunning: true; pollState: BlastPollState }

/**
 * 收集 BLAST nr 结果（v2.16）：
 *  - 与 pdbaa 轮询同构（RTOE 首等 + 6s 常规轮询 + 段预算续跑），但**无 RCSB 兜底**
 *   （RCSB 序列搜索返回的是 PDB 同源，对「这是哪个蛋白」的身份识别无增量价值）
 *  - FAILED / RID 过期 / 长期不可达 / 5 分钟墙钟 → 抛错（调用方记 warn 后继续评估，
 *    身份识别是 best-effort 增强，失败不影响主流程）
 */
export async function collectBlastNr(
  rid: string,
  rtoe: number,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal,
  opts: BlastCollectOpts = {},
): Promise<BlastNrCollectResult> {
  const wallMs = opts.maxWallMs ?? MAX_NR_WALL_MS
  const startedAt = opts.resume?.startedAt ?? Date.now()
  let attempts = opts.resume?.attempts ?? 0
  let netFails = opts.resume?.netFails ?? 0
  const snapshot = (): BlastPollState => ({ rid, rtoe, startedAt, waitingSince: startedAt, searchingSince: null, attempts, netFails, rescueFails: 0, rescueNextAt: 0 })
  const budgetLeft = () => (opts.deadline != null && opts.deadline > 0 ? opts.deadline - Date.now() : Infinity)

  while (true) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
    if (budgetLeft() < 6_000) return { stillRunning: true, pollState: snapshot() }
    const clampedSleep = (ms: number): number => {
      const bl = budgetLeft()
      return bl === Infinity ? ms : Math.max(2_000, Math.min(ms, bl - 4_000))
    }
    await sleep(clampedSleep(attempts === 0 ? Math.min(Math.max(3000, rtoe * 1000), 30_000) : 6000), signal)
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
        throw new Error(`BLAST nr 轮询网络不可达（连续 ${netFails} 次失败，已等 ${Math.round(elapsed / 60)} 分钟）`)
      }
      onProgress?.(`网络抖动，继续轮询 nr（已等 ${elapsed}s）`)
      continue
    }
    if (!pollRes.ok) {
      onProgress?.(`HTTP ${pollRes.status}，继续轮询 nr（已等 ${elapsed}s）`)
      continue
    }
    const xml = await pollRes.text()
    if (xml.includes('<BlastOutput>') || xml.includes('<BlastOutput_iterations>')) {
      onProgress?.(`BLAST nr 完成（等待 ${Math.round((Date.now() - startedAt) / 1000)}s）`)
      return { hits: parseBlastNrXml(xml) }
    }
    if (xml.includes('Status=FAILED') || xml.includes('Status=UNKNOWN')) {
      throw new Error(xml.includes('Status=FAILED') ? 'BLAST nr 任务在 NCBI 侧失败' : `BLAST nr RID ${rid} 已过期`)
    }
    if (Date.now() - startedAt > wallMs) {
      throw new Error(`BLAST nr 已提交 ${Math.round(wallMs / 60000)} 分钟仍无结果（NCBI 队列异常）`)
    }
    onProgress?.(xml.includes('Status=SEARCHING')
      ? `NCBI nr 计算中（第 ${attempts} 次，已 ${elapsed}s）`
      : `NCBI nr 排队中（第 ${attempts} 次，已 ${elapsed}s）`)
    if (budgetLeft() <= 0) {
      return { stillRunning: true, pollState: snapshot() }
    }
  }
}

/**
 * 同步运行 BLAST nr 识别（提交 + 收集，无分段预算路径使用）。
 * 抛错 = 识别失败（调用方降级继续）；空命中 = 「确无同源」（有效结论）。
 */
export async function runBlastNr(
  sequence: string,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal,
): Promise<BlastNrHit[]> {
  const { rid, rtoe } = await submitBlastNr(sequence, onProgress, signal)
  const outcome = await collectBlastNr(rid, rtoe, onProgress, signal)
  if ('hits' in outcome) return outcome.hits
  throw new Error('BLAST nr 轮询被中断（未预期）')
}

/** 用 RCSB GraphQL 批量接口补齐 BLAST 命中的方法/分辨率/结构标题/主引文（每批 25 条）。
 *  注：REST core/entry 不支持逗号分隔多 ID（404）— v1.9 修复 v1.7 起的静默失效：
 *  旧实现的批量 REST 请求从未成功过（BLAST 命中长期缺方法/分辨率），GraphQL 才是正确批量通道。
 *  v1.31：补齐主引文 PubMed ID — 报告 BLAST 表新增「文献」列可直跳 PubMed。 */
export async function enrichBlastHits(hits: BlastHit[], excludePdbIds: Set<string>): Promise<BlastHit[]> {
  const need = hits.filter(h => h.pdbId && !excludePdbIds.has(h.pdbId))
  const enriched = new Map<string, BlastHit>()
  const query = `query($ids:[String!]!){
    entries(entry_ids:$ids){
      rcsb_id
      struct { title }
      exptl { method }
      rcsb_entry_info { resolution_combined }
      citation { id rcsb_is_primary pdbx_database_id_PubMed }
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
            citation?: Array<{ id?: unknown; rcsb_is_primary?: unknown; pdbx_database_id_PubMed?: unknown }>
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
        const primary = (d.citation ?? []).find(c => c.rcsb_is_primary === 'Y' || c.id === 'primary') ?? (d.citation ?? [])[0]
        const pmidRaw = primary?.pdbx_database_id_PubMed
        const pubmedId = pmidRaw != null && pmidRaw !== '' ? String(pmidRaw) : ''
        enriched.set(id, {
          method,
          resolution: typeof resArr[0] === 'number' ? resArr[0] : null,
          description: title.slice(0, 160),
          pubmedId,
        } as Partial<BlastHit> as BlastHit)
      }
    } catch { /* 批次失败忽略 */ }
  }
  return need.map(h => {
    const e = enriched.get(h.pdbId)
    return e ? { ...h, method: e.method, resolution: e.resolution, description: h.description || e.description, pubmedId: e.pubmedId || h.pubmedId } : h
  })
}
