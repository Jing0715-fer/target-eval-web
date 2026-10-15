/**
 * GET    /api/jobs/[id] — 作业详情（运行中：内存快照实时进度；终态：DB 重建）
 * DELETE /api/jobs/[id] — 取消运行中作业 / 删除作业（含磁盘资产与报告）
 */
import { NextResponse } from 'next/server'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { db } from '@/lib/db'
import { doneProgress, getJobSnapshot, markStatus } from '@/lib/eval/job-manager'
import type { BlastHit, InputMode, JobStatus, JobSummary, LiteratureItem, ParsedImage, PdbEntry } from '@/lib/eval/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const job = await db.evaluationJob.findUnique({
    where: { id },
    include: { assets: { orderBy: { order: 'asc' } } },
  })
  if (!job) return NextResponse.json({ error: '作业不存在' }, { status: 404 })

  const snap = getJobSnapshot(id)
  const status = (snap?.status ?? job.status) as JobStatus

  // DB 重启遗留的 running 作业（内存无快照）→ 中断错误
  if ((status === 'running' || status === 'pending') && !snap) {
    return NextResponse.json({
      id,
      status: 'error' as JobStatus,
      mode: job.mode as InputMode,
      uniprotId: job.uniprotId,
      goal: job.goal,
      progress: null,
      logs: ['服务器重启导致作业中断，请重新发起评估'],
      summary: null, pdbs: null, blastHits: null, literature: null, assets: null,
      error: '服务器重启导致作业中断，请重新发起评估',
    })
  }

  let summary: JobSummary | null = null
  let pdbs: PdbEntry[] | null = null
  let blastHits: BlastHit[] | null = null
  let literature: LiteratureItem[] | null = null
  try { summary = job.summary ? JSON.parse(job.summary) : null } catch { /* ignore */ }
  try { pdbs = job.pdbs ? JSON.parse(job.pdbs) : null } catch { /* ignore */ }
  try { blastHits = job.blastHits ? JSON.parse(job.blastHits) : null } catch { /* ignore */ }
  try { literature = job.literature ? JSON.parse(job.literature) : null } catch { /* ignore */ }

  let logs: string[] = snap?.logs ?? []
  if (logs.length === 0 && job.logs) {
    try { logs = JSON.parse(job.logs) } catch { /* ignore */ }
  }

  const assets: ParsedImage[] = job.assets.map(a => ({
    id: a.id,
    kind: a.kind as ParsedImage['kind'],
    caption: a.caption ?? '',
    mime: a.mime,
    sizeKB: Math.round(a.size / 1024),
  }))

  return NextResponse.json({
    id,
    status,
    mode: job.mode as InputMode,
    uniprotId: job.uniprotId,
    goal: job.goal,
    progress: status === 'done' ? doneProgress() : (snap?.progress ?? null),
    logs,
    summary,
    pdbs,
    blastHits,
    literature,
    assets,
    error: job.error,
  })
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const job = await db.evaluationJob.findUnique({ where: { id }, include: { assets: true } })
  if (!job) return NextResponse.json({ ok: true, deleted: true })

  // 运行中 → 中止
  const snap = getJobSnapshot(id)
  if (snap && (snap.status === 'running' || snap.status === 'pending')) {
    snap.abort.abort()
    markStatus(id, 'canceled')
  }

  // 删除磁盘资产（报告 + 图片）与 DB 记录
  try {
    const reportDir = path.join(process.cwd(), 'db', 'reports', id)
    await fs.rm(reportDir, { recursive: true, force: true })
    const uploadIds = new Set<string>()
    for (const a of job.assets) {
      try { await fs.rm(a.path, { force: true }) } catch { /* ignore */ }
      const m = a.path.match(/db[/\\]reports[/\\](u_[^/\\]+)[/\\]/)
      if (m) uploadIds.add(m[1])
    }
    for (const uid of uploadIds) {
      await fs.rm(path.join(process.cwd(), 'db', 'reports', uid), { recursive: true, force: true })
    }
  } catch { /* 磁盘清理失败不阻塞 */ }

  await db.evaluationJob.delete({ where: { id } }).catch(() => undefined)
  return NextResponse.json({ ok: true, deleted: true })
}
