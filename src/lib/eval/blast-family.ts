/**
 * v1.11 同源家族 BLAST 委托 — 结果传播（合并报告生成前调用）。
 *
 * 管线阶段（pipeline.ts）已让 ≥90% 高一致组内仅家族代表执行一次检索，
 * 其余成员 skipped-homolog 不重复检索（用户反馈：同源性超过 90% 不必每个都搜）。
 * 批次全部完成后由本模块把代表的结果补齐到各成员：
 *  - 代表有命中 → 排除成员自身直接结构/已有命中后写入成员作业（DB + 内存态），
 *    状态标注「共享自家族代表 X（一致性 ≥Y%）」
 *  - 代表检索失败/无命中且成员自身结构证据不足（直接结构 <5 或覆盖率 <50%）→
 *    成员各自走 RCSB 序列检索兜底（秒级 mmseqs2，不占 NCBI 队列）
 *  - 其余保持 skipped-homolog（结果页有空态说明，不虚构数据）
 *
 * 传播发生在 generateMergedReport 之前 → LLM digest / HTML / 前端响应
 * 全部使用传播后的完整数据；即使 LLM 失败，传播结果也已持久化。
 */
import { db } from '@/lib/db'
import { fetchUniprotInfo } from './uniprot'
import { searchRcsbHomologs } from './rcsb-search'
import { enrichBlastHits } from './blast'
import type { BlastHit, BlastStatusInfo, RelationJudgment } from './types'
import type { MergedTargetData } from './report-merged'

export interface PropagationResult {
  /** 从家族代表共享到成员的数量 */
  shared: number
  /** 代表无结果、成员自行 RCSB 兜底的数量 */
  rescued: number
  /** 过程记录（日志/调试用） */
  notes: string[]
}

/** 将传播结果写回 DB（blastHits + summary.blast / blastHitCount），并同步内存态 */
async function persistTargetBlast(t: MergedTargetData, hits: BlastHit[], blast: BlastStatusInfo): Promise<void> {
  const job = await db.evaluationJob.findUnique({ where: { id: t.jobId } }).catch(() => null)
  if (job) {
    let summary: Record<string, unknown> = {}
    try { summary = job.summary ? JSON.parse(job.summary) : {} } catch { /* 容错 */ }
    summary.blast = blast
    summary.blastHitCount = hits.length
    await db.evaluationJob.update({
      where: { id: t.jobId },
      data: { blastHits: JSON.stringify(hits), summary: JSON.stringify(summary), updatedAt: new Date() },
    }).catch(() => undefined)
  }
  // 同步内存态（后续 LLM digest / HTML 渲染 / 前端响应均读取该对象）
  t.blastHits = hits
  t.blastStatus = blast
}

/**
 * 对 ≥90% 高一致组执行结果传播（targets 原地更新）。
 * 幂等：成员已有非 skipped-homolog 状态时不覆盖（重试/重放安全）。
 */
export async function propagateFamilyBlast(
  targets: MergedTargetData[],
  relation: RelationJudgment,
): Promise<PropagationResult> {
  const result: PropagationResult = { shared: 0, rescued: 0, notes: [] }
  const groups = relation.blastGroups ?? []
  if (!groups.length || targets.length < 2) return result

  for (const g of groups) {
    const members = new Set(g.members)
    const inGroup = targets.filter(t => t.uniprotId && members.has(t.uniprotId))
    if (inGroup.length < 2) continue

    // 家族代表 = 组内实际执行了检索且有结果的作业（skipped-homolog 为等待共享的成员）
    const runner = inGroup
      .filter(t => (t.blastStatus?.status === 'ok' || t.blastStatus?.status === 'no-hits') && t.blastHits.length > 0)
      .sort((a, b) => b.blastHits.length - a.blastHits.length)[0]
    const waiters = inGroup.filter(t => t.blastStatus?.status === 'skipped-homolog')

    for (const w of waiters) {
      if (runner) {
        const own = new Set([...w.directPdbs.map(p => p.pdbId), ...w.blastHits.map(h => h.pdbId)])
        const inherited = runner.blastHits.filter(h => h.pdbId && !own.has(h.pdbId))
        await persistTargetBlast(w, inherited, {
          status: inherited.length > 0 ? 'ok' : 'no-hits',
          note: `同源结构共享自家族代表 ${runner.uniprotId}（序列一致性 ≥${g.minIdentity}%，未单独检索）`,
          provider: runner.blastStatus?.provider,
        })
        result.shared++
        result.notes.push(`${w.uniprotId} ← 共享 ${runner.uniprotId} 的 ${inherited.length} 个同源结构（组内一致性 ≥${g.minIdentity}%）`)
      } else if (w.directPdbs.length < 5 || w.coveragePercent < 50) {
        // 代表无可用结果且该成员自身结构证据不足 → RCSB 序列检索兜底（秒级）
        try {
          const info = w.uniprotId ? await fetchUniprotInfo(w.uniprotId) : null
          if (info?.sequence && info.sequence.length >= 30) {
            const raw = await searchRcsbHomologs(info.sequence)
            const directSet = new Set(w.directPdbs.map(p => p.pdbId))
            const own = new Set([...directSet, ...w.blastHits.map(h => h.pdbId)])
            const hits = (await enrichBlastHits(raw.filter(h => h.pdbId && !directSet.has(h.pdbId)), directSet))
              .filter(h => h.pdbId && !own.has(h.pdbId))
            await persistTargetBlast(w, hits, {
              status: hits.length > 0 ? 'ok' : 'no-hits',
              note: '家族代表检索未获可用结果，本靶点已自行完成 RCSB 序列检索兜底',
              provider: 'rcsb',
            })
            result.rescued++
            result.notes.push(`${w.uniprotId} → 家族代表无结果，自行 RCSB 兜底获 ${hits.length} 个同源结构`)
          }
        } catch {
          // 兜底失败保持 skipped-homolog（结果页有空态说明，不虚构数据）
          result.notes.push(`${w.uniprotId} → 兜底检索失败，保持委托状态`)
        }
      } else {
        result.notes.push(`${w.uniprotId} → 家族代表无结果；本靶点结构证据充分（${w.directPdbs.length} 个直接结构，覆盖率 ${w.coveragePercent}%），无需补检`)
      }
    }
  }
  return result
}
