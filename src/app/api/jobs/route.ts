/**
 * GET /api/jobs — 最近评估作业列表（≤20 条，仅本人可见）
 * 公网加固：按创建者归属键（IP 哈希）过滤，他人记录不可见；
 * 顺带触发终态作业 TTL 清理（防 DB / 磁盘无限膨胀）。
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { reapOrphanJobs } from '@/lib/eval/job-manager'
import { getOwner } from '@/lib/eval/request-guard'
import { scheduleJobTtlCleanup } from '@/lib/eval/gatekeeper'
import type { JobSummary, JobStatus } from '@/lib/eval/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const owner = getOwner(req)
  await reapOrphanJobs()
  scheduleJobTtlCleanup()
  const rows = await db.evaluationJob.findMany({
    where: { ownerKey: owner.key },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: { id: true, status: true, title: true, uniprotId: true, summary: true, createdAt: true },
  })
  const list = rows.map(r => {
    let summary: JobSummary | null = null
    try { summary = r.summary ? (JSON.parse(r.summary) as JobSummary) : null } catch { /* ignore */ }
    return {
      id: r.id,
      status: r.status as JobStatus,
      title: r.title ?? '未命名评估',
      uniprotId: r.uniprotId,
      proteinName: summary?.uniprot.proteinName ?? r.title ?? null,
      createdAt: r.createdAt.toISOString(),
      coverage: summary?.coverage ?? null,
      pdbCount: summary?.directPdbCount ?? null,
      overallScore: summary?.scores?.overall?.score ?? null,
    }
  })
  return NextResponse.json(list)
}
