/**
 * v2.44 UniProt 序列匹配（用户诉求「报告没回填 UniProt ID 时直接通过 UniProt
 * 网站用序列匹配，取同源度最高的，并显示同源度」）。
 *
 * 背景：靶点身份识别级联（评估表名 → PDB 同源回填 → BLAST nr）在 NCBI 全停 /
 * 队列长期患病时集体失灵 — 序列靶点报告退回「序列标签」命名（如 J53_pdb_01）。
 * UniProt 官网 BLAST 的旧 REST 端点（rest.uniprot.org/blast/run）已下线（404，
 * 实测 2026-11）；本模块改走 EBI 公共 BLAST 服务（www.ebi.ac.uk/Tools/services/
 * rest/ncbiblast）直查 **UniProtKB 数据库** — 这正是 UniProt 网站序列检索的
 * 官方基础设施，返回命中即为 UniProt 条目：
 *  - 库：uniprotkb_swissprot（Swiss-Prot 已审校 ~57.6 万条 — 实测秒级完成，
 *    命中名与归属质量最高；全库 uniprotkb 含 TrEMBL 但实测 >90s 不等，批队列
 *    下不可接受，不采用）
 *  - 提交 POST /run（email + program=blastp + database + sequence）→ jobId
 *  - 轮询 GET /status/{jobId}（QUEUED/RUNNING/FINISHED/ERROR/FAILURE/NOT_FOUND；
 *    EBI 要求轮询间隔 ≥5s）
 *  - 结果 GET /result/{jobId}/json（hit_acc/hit_desc/hsp_identity/hsp 坐标齐全）
 *
 * 产出复用 BlastNrHit 形态（identity/queryCoverage/hitFrom/hitTo/db sp|tr）—
 * 管线侧身份处理与 nr 级联同口径（bestCoverageHit 覆盖度加权 + 85%/40% 阈值）。
 * best-effort：失败抛错由调用方记 warn，不影响主流程。
 */
import type { BlastNrHit } from './blast'

/** EBI 服务联系邮箱（可经 EVAL_EBI_EMAIL 覆写 — EBI 要求有效格式，.dev 顶级域会被拒） */
const EBI_EMAIL = process.env.EVAL_EBI_EMAIL || 'targeteval.service@gmail.com'
const EBI_BASE = 'https://www.ebi.ac.uk/Tools/services/rest/ncbiblast'
/** 轮询间隔（EBI 公平使用要求 ≥5s） */
const POLL_INTERVAL_MS = 5_000
/** 墙钟上限：Swiss-Prot 常态 5-20s；超 4 分钟视为服务异常，优雅放弃 */
const MAX_WALL_MS = 4 * 60_000
/** 连续网络失败上限（~90s 完全不可达才判失败） */
const MAX_NET_FAILS = 18
/** 收集命中上限（身份识别只需头部命中） */
const MAX_HITS = 20

/** 提交状态（跨段续跑 — 随 checkpoint 持久化） */
export interface UniprotBlastJob {
  jobId: string
  startedAt: number
  attempts: number
}

export interface UniprotBlastOpts {
  /** 段预算截止（毫秒时间戳）— 到点返回 stillRunning 由调用方交还续跑 */
  deadline?: number
  /** 上段续跑状态 */
  resume?: { attempts?: number; startedAt?: number }
  signal?: AbortSignal
  onProgress?: (msg: string) => void
}

export type UniprotBlastResult =
  | { hits: BlastNrHit[] }
  | { stillRunning: true; job: UniprotBlastJob }

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('aborted', 'AbortError')); return }
    const onAbort = () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')) }
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 提交序列到 UniProtKB（Swiss-Prot）BLASTp — 返回 jobId（失败抛错） */
export async function submitUniprotSequenceBlast(
  sequence: string,
  signal?: AbortSignal,
): Promise<UniprotBlastJob> {
  const seq = sequence.replace(/[^A-Za-z]/g, '').toUpperCase()
  if (seq.length < 30) throw new Error('序列过短（<30 aa），无法序列匹配')
  const body = new URLSearchParams({
    email: EBI_EMAIL,
    program: 'blastp',
    stype: 'protein',
    database: 'uniprotkb_swissprot',
    matrix: 'BLOSUM62',
    alignments: '20',
    scores: '20',
    exp: '10',
    gapalign: 'true',
    sequence: seq,
  })
  const res = await fetch(`${EBI_BASE}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/plain' },
    body: body.toString(),
    signal: AbortSignal.any?.([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]) ?? AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`EBI BLAST 提交失败（HTTP ${res.status}）`)
  const text = (await res.text()).trim()
  if (/^ncbiblast-/.test(text)) return { jobId: text, startedAt: Date.now(), attempts: 0 }
  throw new Error(text.includes('<error>') ? 'EBI BLAST 提交被拒（检查联系邮箱格式）' : `EBI BLAST 提交返回异常：${text.slice(0, 60)}`)
}

/** EBI JSON 结果 → BlastNrHit[]（复用 nr 命中形态 — 管线身份处理零改造） */
interface EbiBlastJson {
  hits?: Array<{
    hit_acc?: string
    hit_id?: string
    hit_desc?: string
    hit_os?: string
    hit_db?: string
    hit_hsps?: Array<{
      hsp_identity?: number
      hsp_expect?: number
      hsp_query_from?: number
      hsp_query_to?: number
      hsp_hit_from?: number
      hsp_hit_to?: number
    }>
  }>
}

export function parseUniprotBlastJson(data: EbiBlastJson): BlastNrHit[] {
  const hits: BlastNrHit[] = []
  for (const h of data.hits ?? []) {
    const accession = (h.hit_acc ?? '').trim()
    if (!accession) continue
    const hsp = h.hit_hsps?.[0]
    if (!hsp) continue
    const identity = typeof hsp.hsp_identity === 'number' ? Math.round(hsp.hsp_identity * 10) / 10 : 0
    const qFrom = hsp.hsp_query_from ?? 0
    const qTo = hsp.hsp_query_to ?? 0
    const queryCoverage = qTo > qFrom ? qTo - qFrom + 1 : 0
    const evalue = typeof hsp.hsp_expect === 'number' ? hsp.hsp_expect : 0
    const desc = (h.hit_desc ?? '').trim()
    const db = (h.hit_db ?? '').toUpperCase() === 'SP' ? 'sp' : (h.hit_db ?? '').toUpperCase() === 'TR' ? 'tr' : 'other'
    hits.push({
      accession,
      entryName: h.hit_id,
      description: (desc.split(/\s+OS=/)[0] || h.hit_id || accession).slice(0, 160),
      organism: h.hit_os?.slice(0, 60),
      geneName: /\bGN=(\S+)/.exec(desc)?.[1],
      identity,
      evalue,
      evalueRaw: String(hsp.hsp_expect ?? 0),
      queryCoverage,
      queryFrom: qFrom > 0 ? qFrom : undefined,
      queryTo: qTo > 0 ? qTo : undefined,
      hitFrom: (hsp.hsp_hit_from ?? 0) > 0 ? hsp.hsp_hit_from : undefined,
      hitTo: (hsp.hsp_hit_to ?? 0) > 0 ? hsp.hsp_hit_to : undefined,
      db,
    })
    if (hits.length >= MAX_HITS) break
  }
  return hits
}

/**
 * 收集 UniProt 序列匹配结果（轮询 FINISHED → 取 JSON）。
 * 段预算到点返回 stillRunning（job 随 checkpoint 续跑）；墙钟 4 分钟 /
 * 终态错误 / 长期网络不可达 → 抛错（调用方记 warn 后继续评估）。
 */
export async function collectUniprotSequenceBlast(
  job: UniprotBlastJob,
  opts: UniprotBlastOpts = {},
): Promise<UniprotBlastResult> {
  const { signal, onProgress } = opts
  const startedAt = opts.resume?.startedAt ?? job.startedAt
  let attempts = opts.resume?.attempts ?? job.attempts
  let netFails = 0
  const budgetLeft = () => (opts.deadline != null && opts.deadline > 0 ? opts.deadline - Date.now() : Infinity)
  const snapshot = (): UniprotBlastJob => ({ ...job, startedAt, attempts })

  while (true) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
    if (Date.now() - startedAt > MAX_WALL_MS) {
      throw new Error(`UniProt 序列匹配超时（已等 ${Math.round((Date.now() - startedAt) / 1000)}s）`)
    }
    if (budgetLeft() < 6_000) return { stillRunning: true, job: snapshot() }
    const wait = budgetLeft() === Infinity ? POLL_INTERVAL_MS : Math.max(2_000, Math.min(POLL_INTERVAL_MS, budgetLeft() - 4_000))
    await sleep(wait, signal)
    attempts++
    const elapsed = Math.round((Date.now() - startedAt) / 1000)
    let status: string
    try {
      const res = await fetch(`${EBI_BASE}/status/${encodeURIComponent(job.jobId)}`, {
        signal: AbortSignal.any?.([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]) ?? AbortSignal.timeout(15_000),
      })
      if (!res.ok) {
        netFails++
        if (netFails >= MAX_NET_FAILS) throw new Error(`UniProt 序列匹配轮询不可达（HTTP ${res.status}，已等 ${elapsed}s）`)
        onProgress?.(`HTTP ${res.status}，继续轮询（已等 ${elapsed}s）`)
        continue
      }
      status = (await res.text()).trim()
      netFails = 0
    } catch (e) {
      if (signal?.aborted && e instanceof DOMException && e.name === 'AbortError') throw e
      netFails++
      if (netFails >= MAX_NET_FAILS) throw new Error(`UniProt 序列匹配轮询网络不可达（连续 ${netFails} 次失败，已等 ${elapsed}s）`)
      onProgress?.(`网络抖动，继续轮询（已等 ${elapsed}s）`)
      continue
    }
    if (status === 'RUNNING' || status === 'QUEUED') {
      onProgress?.(`UniProt 库序列匹配中（已等 ${elapsed}s）`)
      continue
    }
    if (status === 'FINISHED') {
      const resultRes = await fetch(`${EBI_BASE}/result/${encodeURIComponent(job.jobId)}/json`, {
        signal: AbortSignal.any?.([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]) ?? AbortSignal.timeout(20_000),
      })
      if (!resultRes.ok) throw new Error(`UniProt 序列匹配结果获取失败（HTTP ${resultRes.status}）`)
      const data = (await resultRes.json()) as EbiBlastJson
      return { hits: parseUniprotBlastJson(data) }
    }
    if (status === 'NOT_FOUND') throw new Error('UniProt 序列匹配作业已过期（NOT_FOUND）')
    throw new Error(`UniProt 序列匹配失败（${status}）`)
  }
}
