/**
 * v2.58 UniProt 全库精确序列匹配（Peptide Search）— 靶点身份识别的最后兜底。
 *
 * 背景：身份级联（PDB 同源回填 → BLAST nr → EBI Swiss-Prot 直查）仍有两类漏网：
 *  ① 靶点只有 TrEMBL 条目（冷门物种/未审校蛋白）— EBI 直查仅扫 Swiss-Prot
 *    （~57.6 万已审校条目；全库 uniprotkb BLAST 实测 >90s，批队列不可接受），
 *    只能找到 40-85% 的近缘 ortholog，未达「85% + 40%」回填阈值；
 *  ② NCBI 患病日（pdbaa 提交失败走 RCSB 兜底 → nr 仅 90s 短预算；或双亡
 *    blastStatus=failed 时 nr 整体跳过）— nr 失效后同样只剩 Swiss-Prot。
 *
 * UniProt Peptide Search（peptidesearch.uniprot.org）是官网「以序列搜库」的
 * 精确子串匹配服务，索引覆盖 UniProtKB 全部条目（含 TrEMBL），秒级完成：
 *  - 提交 POST /asyncrest（peps=序列&lEQi=off&spOnly=off）→ 202 + Location 头
 *  - 轮询 GET Location → 303（运行中）/ 200（完成，text/plain 逗号分隔 accession）
 *  - 实测：33 aa 短肽与 1210 aa 全长序列均可查（全长唯一命中自身条目）
 *
 * 语义安全性：精确子串匹配天然保守 — 带标签/突变/融合构建不构成子串 → 不
 * 匹配（交由 BLAST 路径），不会误绑；命中即提交序列完整出现在该条目中。
 * 多候选（同蛋白跨物种/菌株的 TrEMBL 重复条目、保守片段）由管线侧整形与
 * 复核（见 pipeline.ts v2.58 身份处理块）。
 *
 * best-effort：失败抛错由调用方记 warn，不影响主流程。
 */

/** 提交状态（跨段续跑 — 随 checkpoint 持久化） */
export interface PeptideSearchJob {
  /** 作业结果轮询地址（Location 头） */
  url: string
  startedAt: number
  attempts: number
}

export interface PeptideSearchOpts {
  /** 段预算截止（毫秒时间戳）— 到点返回 stillRunning 由调用方交还续跑 */
  deadline?: number
  /** 上段续跑状态 */
  resume?: { attempts?: number; startedAt?: number }
  signal?: AbortSignal
  onProgress?: (msg: string) => void
}

export type PeptideSearchResult =
  | { accessions: string[] }
  | { stillRunning: true; job: PeptideSearchJob }

const PS_BASE = 'https://peptidesearch.uniprot.org/asyncrest'
/** 轮询间隔（索引查询常态 2-5s 完成） */
const POLL_INTERVAL_MS = 3_000
/** 墙钟上限：秒级服务；超 60s 视为异常，优雅放弃 */
const MAX_WALL_MS = 60_000
/** 连续网络失败上限（~30s 完全不可达才判失败） */
const MAX_NET_FAILS = 6

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('aborted', 'AbortError')); return }
    const onAbort = () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')) }
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 提交序列到 Peptide Search — 返回轮询作业（失败抛错） */
export async function submitPeptideSearch(
  sequence: string,
  signal?: AbortSignal,
): Promise<PeptideSearchJob> {
  const seq = sequence.replace(/[^A-Za-z]/g, '').toUpperCase()
  if (seq.length < 30) throw new Error('序列过短（<30 aa），无法精确匹配')
  const body = new URLSearchParams({ peps: seq, lEQi: 'off', spOnly: 'off' })
  const res = await fetch(PS_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/plain' },
    body: body.toString(),
    signal: AbortSignal.any?.([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]) ?? AbortSignal.timeout(30_000),
    redirect: 'manual',
  })
  if (res.status !== 202) throw new Error(`Peptide Search 提交失败（HTTP ${res.status}）`)
  const url = res.headers.get('location')
  if (!url) throw new Error('Peptide Search 提交未返回作业地址（Location 头缺失）')
  return { url, startedAt: Date.now(), attempts: 0 }
}

/** 解析 200 正文（逗号分隔 accession 列表 → 去空格/去重保序） */
export function parsePeptideSearchBody(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split(/[,\s]+/)) {
    const acc = raw.trim()
    if (acc && !out.includes(acc)) out.push(acc)
  }
  return out
}

/** 轮询作业直至完成 — 返回命中 accession 列表（空 = 无包含提交序列的条目） */
export async function collectPeptideSearch(
  job: PeptideSearchJob,
  opts: PeptideSearchOpts = {},
): Promise<PeptideSearchResult> {
  const startedAt = opts.resume?.startedAt ?? job.startedAt
  let attempts = opts.resume?.attempts ?? job.attempts
  let netFails = 0
  while (true) {
    if (opts.signal?.aborted) throw new DOMException('aborted', 'AbortError')
    if (Date.now() - startedAt > MAX_WALL_MS) {
      throw new Error(`Peptide Search 超过 ${Math.round(MAX_WALL_MS / 1000)}s 未完成（服务异常）`)
    }
    if (opts.deadline != null && opts.deadline > 0 && Date.now() >= opts.deadline - 2_000) {
      return { stillRunning: true, job: { ...job, attempts, startedAt } }
    }
    let res: Response
    try {
      res = await fetch(job.url, {
        cache: 'no-store',
        redirect: 'manual',
        signal: opts.signal ?? undefined,
      })
      netFails = 0
    } catch (e) {
      if (opts.signal?.aborted) throw e
      netFails += 1
      if (netFails >= MAX_NET_FAILS) throw new Error('Peptide Search 轮询连续网络失败')
      await sleep(POLL_INTERVAL_MS, opts.signal)
      continue
    }
    if (res.status === 200) {
      const text = (await res.text()).trim()
      return { accessions: parsePeptideSearchBody(text) }
    }
    // 303（运行中重定向）/ 202 — 继续轮询；其他状态视为异常
    if (res.status !== 303 && res.status !== 202) {
      throw new Error(`Peptide Search 轮询返回异常状态（HTTP ${res.status}）`)
    }
    attempts += 1
    opts.onProgress?.(`UniProt 全库精确匹配检索中（已等待 ${Math.round((Date.now() - startedAt) / 1000)}s）…`)
    await sleep(POLL_INTERVAL_MS, opts.signal)
  }
}
