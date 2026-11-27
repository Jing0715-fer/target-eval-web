/**
 * 拉取 26 靶点最佳命中的 BLAST 比对数据（qseq/mseq/hseq + 坐标）。
 *
 * 数据源：EBI ncbiblast 作业结果 JSON（作业 ID 存于 /tmp/ebi-verify-jobs.json，
 * 结果保留期内可直接重取 — 含 hsp_qseq/hsp_mseq/hsp_hseq 完整比对串）。
 *
 * 每靶点的比对来源（与验证报告展示的回填命中一致）：
 *  - 主链 PASS：#0#full（T3 全库；无则 #0 = T2）
 *  - 备选链 PASS：#101 / #102（T2）
 *  - 未达阈值（最高同源回填）：#0#full（T3）优先，无则 #0
 * 找不到期望 accession 时按 bestCoverageHit 口径回退取最佳。
 */
import { readFileSync, writeFileSync } from 'fs'

const EBI = 'https://www.ebi.ac.uk/Tools/services/rest/ncbiblast'
const JOBS = '/tmp/ebi-verify-jobs.json'
const RESULTS = '/tmp/ebi-verify-results.json'
const TASKS = '/tmp/verify_tasks.json'
const OUT = '/tmp/alignments.json'

interface Hit {
  hit_acc?: string; hit_desc?: string; hit_os?: string; hit_db?: string; hit_id?: string; hit_len?: number
  hit_hsps?: Array<{
    hsp_identity?: number; hsp_positive?: number; hsp_expect?: number; hsp_gaps?: number
    hsp_query_from?: number; hsp_query_to?: number; hsp_hit_from?: number; hsp_hit_to?: number
    hsp_align_len?: number; hsp_qseq?: string; hsp_mseq?: string; hsp_hseq?: string
  }>
}

function bestCovAcc(hits: Hit[], qlen: number): Hit | null {
  let best: { h: Hit; s: number } | null = null
  for (const h of hits) {
    const hsp = h.hit_hsps?.[0]
    if (!hsp) continue
    const cov = hsp.hsp_query_to && hsp.hsp_query_from ? (hsp.hsp_query_to - hsp.hsp_query_from + 1) / Math.max(1, qlen) : 0
    const id = (hsp.hsp_identity ?? 0) * 100
    const s = (id / 100) * cov
    if (!best || s > best.s) best = { h, s }
  }
  return best?.h ?? null
}

async function main() {
  const jobs: Record<string, { jobId: string }> = JSON.parse(readFileSync(JOBS, 'utf-8'))
  const results: Record<string, { job: string; label: string; sublen: number; chainIdx: number; chainLen: number; sp?: { acc: string; id: number; cov: number; db: string; desc: string; os?: string; pass: boolean } }> = JSON.parse(readFileSync(RESULTS, 'utf-8'))
  const tasks: Array<{ job: string; label: string; sublen: number; uniq: string[] }> = JSON.parse(readFileSync(TASKS, 'utf-8'))

  // 每靶点决定比对来源 jobKey + 期望命中
  interface Src { jobKey: string; acc: string; chainKind: 'main' | 'alt'; channel: 'T2' | 'T3'; chainLen: number }
  const srcs: Record<string, Src> = {}
  for (const t of tasks) {
    const j = t.job
    const full = results[`${j}#0#full`]
    const sp = results[`${j}#0`]
    const a1 = results[`${j}#101`]
    const a2 = results[`${j}#102`]
    const mainChainLen = t.uniq?.length ? t.uniq.reduce((a, b) => (Math.abs(b.length - t.sublen) < Math.abs(a.length - t.sublen) ? b : a)).length : (full?.chainLen ?? sp?.chainLen ?? 0)
    if (full?.sp?.pass) srcs[j] = { jobKey: `${j}#0#full`, acc: full.sp.acc, chainKind: 'main', channel: 'T3', chainLen: full.chainLen }
    else if (sp?.sp?.pass) srcs[j] = { jobKey: `${j}#0`, acc: sp.sp.acc, chainKind: 'main', channel: 'T2', chainLen: sp.chainLen }
    else if (a1?.sp?.pass) srcs[j] = { jobKey: `${j}#101`, acc: a1.sp.acc, chainKind: 'alt', channel: 'T2', chainLen: a1.chainLen }
    else if (a2?.sp?.pass) srcs[j] = { jobKey: `${j}#102`, acc: a2.sp.acc, chainKind: 'alt', channel: 'T2', chainLen: a2.chainLen }
    else if (full?.sp) srcs[j] = { jobKey: `${j}#0#full`, acc: full.sp.acc, chainKind: 'main', channel: 'T3', chainLen: full.chainLen }
    else if (sp?.sp) srcs[j] = { jobKey: `${j}#0`, acc: sp.sp.acc, chainKind: 'main', channel: 'T2', chainLen: sp.chainLen }
  }
  console.log('比对来源靶点数:', Object.keys(srcs).length)

  const out: Record<string, unknown> = {}
  let i = 0
  for (const [j, src] of Object.entries(srcs)) {
    i++
    const jm = jobs[src.jobKey]
    if (!jm) { console.log(`✗ ${j}（${src.jobKey}）无作业 ID — 跳过`); continue }
    try {
      const res = await fetch(`${EBI}/result/${jm.jobId}/json`, { signal: AbortSignal.timeout(30_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { hits?: Hit[] }
      const hits = data.hits ?? []
      let hit = hits.find(h => (h.hit_acc ?? '') === src.acc) ?? bestCovAcc(hits, src.chainLen)
      if (!hit) throw new Error('结果中无命中')
      const hsp = hit.hit_hsps?.[0]
      if (!hsp?.hsp_qseq || !hsp.hsp_mseq || !hsp.hsp_hseq) throw new Error('HSP 缺比对串')
      out[j] = {
        job: j,
        acc: hit.hit_acc, entryName: hit.hit_id, db: hit.hit_db, os: hit.hit_os, hitLen: hit.hit_len,
        desc: (hit.hit_desc ?? '').split(/\s+OS=/)[0].slice(0, 90),
        channel: src.channel, chainKind: src.chainKind, chainLen: src.chainLen,
        qfrom: hsp.hsp_query_from, qto: hsp.hsp_query_to, hfrom: hsp.hsp_hit_from, hto: hsp.hsp_hit_to,
        identity: Math.round((hsp.hsp_identity ?? 0) * 10) / 10,
        positive: Math.round((hsp.hsp_positive ?? 0) * 10) / 10,
        gaps: hsp.hsp_gaps, alignLen: hsp.hsp_align_len, expect: hsp.hsp_expect,
        nhsp: hit.hit_hsps?.length ?? 1,
        qseq: hsp.hsp_qseq, mseq: hsp.hsp_mseq, hseq: hsp.hsp_hseq,
      }
      console.log(`✓ ${i}/${Object.keys(srcs).length} ${j} → ${hit.hit_acc}（${hsp.hsp_qseq.length} 列比对, ${hit.hit_hsps?.length ?? 1} HSP）`)
    } catch (e) {
      console.log(`✗ ${j}: ${e instanceof Error ? e.message : e}`)
    }
    await new Promise(r => setTimeout(r, 250))
  }
  writeFileSync(OUT, JSON.stringify(out))
  console.log(`完成 ${Object.keys(out).length} 条 → ${OUT}`)
}

main().catch(e => { console.error(e); process.exit(1) })
