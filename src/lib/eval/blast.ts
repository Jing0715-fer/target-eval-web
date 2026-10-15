/**
 * NCBI BLAST (URL API) — blastp vs pdbaa，同源 PDB 检索。
 * 内存策略：HITLIST_SIZE 50；轮询墙钟上限 5 分钟；每轮响应即解析即释放。
 */
import type { BlastHit } from './types'

const BLAST_URL = 'https://blast.ncbi.nlm.nih.gov/blast/Blast.cgi'
const MAX_POLL_WALL_MS = 5 * 60_000

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

export interface BlastRunResult {
  hits: BlastHit[]
  rid: string
  durationMs: number
  skipped: boolean
  skipReason?: string
}

/**
 * 运行 BLASTp（pdbaa 数据库）。轮询直到完成 / 失败 / 超墙钟 / 中止。
 * onProgress 每轮轮询回调一次。
 */
export async function runBlastPdb(
  sequence: string,
  onProgress?: (msg: string) => void,
  signal?: AbortSignal,
): Promise<BlastHit[]> {
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
  const submitRes = await fetch(BLAST_URL, { method: 'POST', body: submitBody, signal: AbortSignal.timeout(30_000) })
  if (!submitRes.ok) throw new Error(`BLAST 提交失败 HTTP ${submitRes.status}`)
  const submitText = await submitRes.text()
  const rid = submitText.match(/RID\s*=\s*(\S+)/)?.[1]
  const rtoe = parseInt(submitText.match(/RTOE\s*=\s*(\d+)/)?.[1] ?? '15', 10)
  if (!rid) throw new Error('BLAST 未返回 RID')

  onProgress?.(`BLAST 已提交 (RID=${rid}，预计 ${rtoe}s)`)

  const startedAt = Date.now()
  let attempts = 0
  while (true) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
    if (Date.now() - startedAt > MAX_POLL_WALL_MS) {
      throw new Error(`BLAST 轮询超过 ${Math.round(MAX_POLL_WALL_MS / 60000)} 分钟上限`)
    }
    await sleep(attempts === 0 ? Math.max(3000, rtoe * 1000) : 6000, signal)
    attempts++
    const elapsed = Math.round((Date.now() - startedAt) / 1000)
    let pollRes: Response
    try {
      pollRes = await fetch(`${BLAST_URL}?CMD=Get&FORMAT_TYPE=XML&RID=${rid}`, { signal: AbortSignal.timeout(30_000) })
    } catch {
      onProgress?.(`网络抖动，继续轮询（已等 ${elapsed}s）`)
      continue
    }
    if (!pollRes.ok) {
      onProgress?.(`HTTP ${pollRes.status}，继续轮询（已等 ${elapsed}s）`)
      continue
    }
    const xml = await pollRes.text()
    if (xml.includes('<BlastOutput>') || xml.includes('<BlastOutput_iterations>')) {
      onProgress?.(`BLAST 完成（${Math.round((Date.now() - startedAt) / 1000)}s），解析结果…`)
      return parseBlastXml(xml)
    }
    if (xml.includes('Status=FAILED')) throw new Error('BLAST 任务在 NCBI 侧失败')
    if (xml.includes('Status=UNKNOWN')) throw new Error(`BLAST RID ${rid} 已过期`)
    onProgress?.(`等待 NCBI 队列（第 ${attempts} 次，已 ${elapsed}s）`)
  }
}

/** 用 RCSB 批量接口补齐 BLAST 命中的方法/分辨率（每批 20 条）。 */
export async function enrichBlastHits(hits: BlastHit[], excludePdbIds: Set<string>): Promise<BlastHit[]> {
  const need = hits.filter(h => h.pdbId && !excludePdbIds.has(h.pdbId))
  const enriched = new Map<string, BlastHit>()
  for (let i = 0; i < need.length; i += 20) {
    const batch = need.slice(i, i + 20)
    const ids = batch.map(h => h.pdbId)
    try {
      const res = await fetch(`https://data.rcsb.org/rest/v1/core/entry/${ids.join(',')}`, {
        signal: AbortSignal.timeout(20_000),
      })
      if (!res.ok) continue
      const j = await res.json()
      const list = Array.isArray(j) ? j : [j]
      for (const d of list) {
        const id = (d?.rcsb_entry_container_identifiers?.entry_id ?? '').toUpperCase()
        if (!id) continue
        const method = d.exptl?.[0]?.method ?? ''
        const resArr = d.rcsb_entry_info?.resolution_combined ?? []
        enriched.set(id, {
          method,
          resolution: typeof resArr[0] === 'number' ? resArr[0] : null,
        } as Partial<BlastHit> as BlastHit)
      }
    } catch { /* 批次失败忽略 */ }
  }
  return need.map(h => {
    const e = enriched.get(h.pdbId)
    return e ? { ...h, method: e.method, resolution: e.resolution } : h
  })
}
