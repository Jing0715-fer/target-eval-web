/**
 * 验证脚本：缺失 UniProt ID 的 28 靶点能否经 EBI UniProtKB 回补。
 *
 * 数据来源：上传的汇总报告（TargetEval_HT_2026-11-25 · 117 靶点 (4).html）
 *  - 缺失 28 个，其中 26 个在报告 data-seq 留存原表完整序列（按 CHAIN 拆链）
 *  - 取与提交长度最接近的链作为查询（评估身份识别的对象就是该链）
 *
 * 通道（与管线 v2.95 身份级联同口径）：
 *  T1  UniProt Peptide Search（全库精确子串，peptidesearch.uniprot.org）
 *  T2  EBI BLAST uniprotkb_swissprot（已审校 ~57.6 万条，快通道）
 *  T3  EBI BLAST uniprotkb（全库含 TrEMBL — v2.95 NCBI nr 失败后的兜底通道）
 *
 * 判定阈值（pipeline.ts TARGET_IDENTIFY_MIN_COV 同口径）：
 *  T1 命中即精确归属；T2/T3 = identity≥85% 且 覆盖≥40% 且 db∈{sp,tr}
 *
 * 断点续跑：结果增量写入 /tmp/ebi-verify-results.json（--sp / --full 指定库；
 * 未达标靶点用 --retry-chain=N 换下一条候选链重试）
 */
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { submitUniprotSequenceBlast, collectUniprotSequenceBlast } from '@/lib/eval/uniprot-blast'
import type { BlastNrHit } from '@/lib/eval/blast'
import { submitPeptideSearch, collectPeptideSearch } from '@/lib/eval/peptide-search'

const TASKS = '/tmp/verify_tasks.json'
const RES = '/tmp/ebi-verify-results.json'
const CONCURRENCY = 3
const MIN_ID = 85
const MIN_COV = 0.4

interface Query {
  job: string
  label: string
  sublen: number
  seq: string
  chainIdx: number
}

interface PhaseSp {
  acc: string
  id: number
  cov: number
  db: string
  desc: string
  os?: string
  pass: boolean
  top5?: Array<{ acc: string; id: number; cov: number; db: string }>
}

interface Rec {
  job: string
  label: string
  sublen: number
  chainIdx: number
  chainLen: number
  peptide?: string[]
  peptideErr?: string
  sp?: PhaseSp | null
  spErr?: string
  at: number
}

function loadTasks(): Query[] {
  const tasks = JSON.parse(readFileSync(TASKS, 'utf-8')) as Array<{
    job: string; label: string; sublen: number
    test_chains: Array<{ len: number; seq: string }>
    uniq: string[]
  }>
  const chainIdx = parseInt(process.argv.find(a => a.startsWith('--retry-chain='))?.split('=')[1] ?? '0', 10)
  const uniqIdx = process.argv.find(a => a.startsWith('--uniq-chain='))?.split('=')[1]
  const only = process.argv.find(a => a.startsWith('--only='))?.split('=')[1]?.split(',').filter(Boolean) ?? null
  const out: Query[] = []
  for (const t of tasks) {
    if (only && !only.includes(t.job)) continue
    if (uniqIdx != null) {
      // 取第 N 条唯一链（探索拆链顺序与 PDB 链号不一致的情况）
      const seqs = (t.uniq ?? t.test_chains.map(c => c.seq)).filter(s => s.length >= 60)
      const i = Math.min(parseInt(uniqIdx, 10), seqs.length - 1)
      if (i < 0) continue
      out.push({ job: t.job, label: t.label, sublen: t.sublen, seq: seqs[i], chainIdx: 100 + i })
      continue
    }
    if (!t.test_chains.length) continue
    const idx = Math.min(chainIdx, t.test_chains.length - 1)
    out.push({ job: t.job, label: t.label, sublen: t.sublen, seq: t.test_chains[idx].seq, chainIdx: idx })
  }
  return out
}

/** 覆盖度加权最佳命中（pipeline.ts bestCoverageHit 同口径） */
function bestCov(hits: BlastNrHit[], qlen: number) {
  let best: { hit: BlastNrHit; covFrac: number; score: number } | null = null
  for (const hit of hits) {
    const covFrac = hit.queryCoverage > 0 ? Math.min(1, hit.queryCoverage / Math.max(1, qlen)) : 0
    const score = (hit.identity / 100) * covFrac
    if (!best || score > best.score || (score === best.score && hit.identity > best.hit.identity)) {
      best = { hit, covFrac, score }
    }
  }
  return best
}

function judge(hits: BlastNrHit[], qlen: number): PhaseSp | null {
  const best = bestCov(hits, qlen)
  if (!best) return null
  return {
    acc: best.hit.accession,
    id: best.hit.identity,
    cov: Math.round(best.covFrac * 1000) / 10,
    db: best.hit.db,
    desc: (best.hit.description ?? '').slice(0, 70),
    os: best.hit.organism,
    pass: best.hit.identity >= MIN_ID && best.hit.db !== 'other' && best.covFrac >= MIN_COV,
    top5: hits.slice(0, 5).map(h => ({
      acc: h.accession, id: h.identity,
      cov: Math.round((Math.min(1, (h.queryCoverage || 0) / Math.max(1, qlen))) * 1000) / 10,
      db: h.db,
    })),
  }
}

async function runOne(q: Query, db: 'uniprotkb_swissprot' | 'uniprotkb'): Promise<Rec> {
  const rec: Rec = {
    job: q.job, label: q.label, sublen: q.sublen, chainIdx: q.chainIdx,
    chainLen: q.seq.length, at: Date.now(),
  }
  // T1：Peptide Search（全库精确子串）— 仅首轮链做一次
  if (q.chainIdx === 0) {
    try {
      const job = await submitPeptideSearch(q.seq)
      const r = await collectPeptideSearch(job)
      if ('accessions' in r) rec.peptide = r.accessions.slice(0, 8)
    } catch (e) {
      rec.peptideErr = e instanceof Error ? e.message : String(e)
    }
  }
  // T2/T3：EBI BLAST
  const label = db === 'uniprotkb' ? 'EBI 全库' : 'EBI Swiss-Prot'
  try {
    const job = await submitUniprotSequenceBlast(q.seq, undefined, {
      database: db, alignments: db === 'uniprotkb' ? 50 : 20,
    })
    const r = await collectUniprotSequenceBlast(job, {
      label,
      maxWallMs: db === 'uniprotkb' ? 6 * 60_000 : 4 * 60_000,
      maxHits: db === 'uniprotkb' ? 50 : 20,
    })
    if ('hits' in r) rec.sp = judge(r.hits, q.seq.length)
    else throw new Error('段预算耗尽（stillRunning）')
  } catch (e) {
    rec.spErr = e instanceof Error ? e.message : String(e)
  }
  return rec
}

async function main() {
  const db: 'uniprotkb_swissprot' | 'uniprotkb' = process.argv.includes('--full') ? 'uniprotkb' : 'uniprotkb_swissprot'
  const batch = process.argv.includes('--batch')
  const queries = loadTasks()
  const results: Record<string, Rec> = existsSync(RES) ? JSON.parse(readFileSync(RES, 'utf-8')) : {}
  const key = (q: Query) => `${q.job}#${q.chainIdx}${db === 'uniprotkb' ? '#full' : ''}`
  // 超时/失败的条目允许重跑（--retry-failed）
  if (process.argv.includes('--retry-failed')) {
    for (const q of queries) {
      const r = results[key(q)]
      if (r && (r.spErr || (!r.sp && !r.peptide?.length))) delete results[key(q)]
    }
  }
  const pending = queries.filter(q => !results[key(q)])
  console.log(`通道=${db}${batch ? ' batch' : ''} | 查询 ${queries.length} 条 | 已完成 ${queries.length - pending.length} | 待跑 ${pending.length}`)

  if (!batch) {
    let done = 0
    const pool = [...pending]
    async function worker(wid: number) {
      while (pool.length) {
        const q = pool.shift()
        if (!q) break
        console.log(`[w${wid}] 提交 ${q.job}（链${q.chainIdx}，${q.seq.length}aa）…`)
        const rec = await runOne(q, db)
        results[key(q)] = rec
        writeFileSync(RES, JSON.stringify(results, null, 1))
        done++
        console.log(`[w${wid}] 完成 ${q.job} → ${report(rec, db)}（${done}/${pending.length}）`)
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1)))
  } else {
    // 批量模式：全部提交（EBI 允许并行作业）→ 轮流收结果（作业墙钟独立计时）
    const JOBS = '/tmp/ebi-verify-jobs.json'
    const jobMap: Record<string, { jobId: string; startedAt: number }> = existsSync(JOBS)
      ? JSON.parse(readFileSync(JOBS, 'utf-8'))
      : {}
    for (const q of pending) {
      const k = key(q)
      if (jobMap[k]?.jobId) continue
      try {
        const job = await submitUniprotSequenceBlast(q.seq, undefined, {
          database: db, alignments: db === 'uniprotkb' ? 50 : 20,
        })
        jobMap[k] = { jobId: job.jobId, startedAt: Date.now() }
        writeFileSync(JOBS, JSON.stringify(jobMap, null, 1))
        console.log(`提交 ${k} → ${job.jobId}（${q.seq.length}aa）`)
      } catch (e) {
        console.log(`提交失败 ${k}: ${e instanceof Error ? e.message : e}`)
      }
    }
    let done = 0
    const pool = pending.filter(q => jobMap[key(q)])
    // biome-ignore lint: 日志口径
    const totalPool = pool.length
    async function worker(wid: number) {
      while (pool.length) {
        const q = pool.shift()
        if (!q) break
        const k = key(q)
        const j = jobMap[k]
        try {
          const r = await collectUniprotSequenceBlast(
            { jobId: j.jobId, startedAt: j.startedAt, attempts: 0 },
            { label: 'EBI 全库', maxWallMs: 15 * 60_000, maxHits: 50 },
          )
          if ('hits' in r) {
            const rec: Rec = {
              job: q.job, label: q.label, sublen: q.sublen, chainIdx: q.chainIdx,
              chainLen: q.seq.length, at: Date.now(), sp: judge(r.hits, q.seq.length),
            }
            results[k] = rec
          } else {
            console.log(`[w${wid}] ${k} 仍在跑（续跑中）`)
          }
        } catch (e) {
          const rec: Rec = {
            job: q.job, label: q.label, sublen: q.sublen, chainIdx: q.chainIdx,
            chainLen: q.seq.length, at: Date.now(),
            spErr: e instanceof Error ? e.message : String(e),
          }
          results[k] = rec
          delete jobMap[k]
          writeFileSync(JOBS, JSON.stringify(jobMap, null, 1))
        }
        writeFileSync(RES, JSON.stringify(results, null, 1))
        done++
        console.log(`[w${wid}] 收集 ${k} → ${report(results[k]!, db)}（${done}/${totalPool}）`)
      }
    }
    await Promise.all(Array.from({ length: 2 }, (_, i) => worker(i + 1)))
  }
  console.log('本轮结束。结果：', RES)
}

function report(rec: Rec, db: string): string {
  const sp = rec.sp
  if (rec.peptide?.length) return `T1 精确命中 ${rec.peptide.slice(0, 3).join(',')}（共${rec.peptide.length}）`
  if (sp?.pass) return `${db === 'uniprotkb' ? 'T3' : 'T2'} 回补 ${sp.acc} ${sp.id}%/${sp.cov}% ${sp.desc.slice(0, 40)}`
  if (sp) return `最佳 ${sp.acc} ${sp.id}%/${sp.cov}%（未达标）`
  return `无命中/失败：${rec.spErr ?? rec.peptideErr ?? '-'}`
}

main().catch(e => { console.error(e); process.exit(1) })
