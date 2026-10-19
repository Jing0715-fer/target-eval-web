/**
 * GET    /api/jobs/[id] — 作业详情（运行中：内存快照实时进度；终态：DB 重建）
 * DELETE /api/jobs/[id] — 取消运行中作业 / 删除作业（含磁盘资产与报告）
 * 公网加固：仅创建者（ownerKey 匹配）可访问；他人访问返回 404（不暴露存在性）。
 * pending 作业附带 queuePosition（前方排队数）供前端展示等待状态。
 */
import { NextResponse } from 'next/server'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { db } from '@/lib/db'
import { doneProgress, getJobSnapshot, markStatus } from '@/lib/eval/job-manager'
import { getOwner, isOwnedBy, notFound } from '@/lib/eval/request-guard'
import type { BlastHit, InputMode, JobStatus, JobSummary, LiteratureItem, ParsedImage, PdbEntry } from '@/lib/eval/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const owner = getOwner(req)
  const job = await db.evaluationJob.findUnique({
    where: { id },
    include: { assets: { orderBy: { order: 'asc' } } },
  })
  if (!job) return notFound()
  if (!isOwnedBy(job, owner)) return notFound()

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

  // 排队中：计算前方待执行作业数（全局串行队列位置）
  let queuePosition: number | undefined
  if (status === 'pending') {
    try {
      queuePosition = await db.evaluationJob.count({
        where: { status: 'pending', createdAt: { lt: job.createdAt } },
      })
    } catch { /* 计数失败不影响详情 */ }
  }

  const assets: ParsedImage[] = job.assets.map(a => ({
    id: a.id,
    kind: a.kind as ParsedImage['kind'],
    caption: a.caption ?? '',
    mime: a.mime,
    sizeKB: Math.round(a.size / 1024),
    vlmKind: a.vlm,
  }))

  return NextResponse.json({
    id,
    status,
    mode: job.mode as InputMode,
    uniprotId: job.uniprotId,
    goal: job.goal,
    progress: status === 'done' ? doneProgress() : (snap?.progress ?? null),
    logs,
    queuePosition,
    summary,
    pdbs,
    blastHits,
    literature,
    assets,
    /** LLM 评估报告 markdown（v1.7+ 作业；结果页内联展示） */
    reportMarkdown: job.reportMarkdown ?? null,
    error: job.error,
  })
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const owner = getOwner(req)
  const job = await db.evaluationJob.findUnique({ where: { id } })
  if (!job) return NextResponse.json({ ok: true, deleted: true })
  if (!isOwnedBy(job, owner)) return notFound()

  // 运行中 → 中止
  const snap = getJobSnapshot(id)
  if (snap && (snap.status === 'running' || snap.status === 'pending')) {
    snap.abort.abort()
    markStatus(id, 'canceled')
  }

  // 只删除本作业自己的报告目录（db/reports/{jobId}：report.html 等）+ DB 记录（级联删 assets 行）。
  // 注意：不再级联删除上传目录（db/reports/u_*）与其中图片 ——
  //  上传目录是共享资源（同一上传可发起多次评估、上传面板仍持有其状态），
  //  级联删除会导致：上传面板「重新解析」404（未找到该上传的解析结果）、
  //  后续评估丢失胶图/SEC 图片。上传目录生命周期由 TTL 统一回收（upload 路由触发）。
  try {
    const reportDir = path.join(process.cwd(), 'db', 'reports', id)
    await fs.rm(reportDir, { recursive: true, force: true })
  } catch { /* 磁盘清理失败不阻塞 */ }

  await db.evaluationJob.delete({ where: { id } }).catch(() => undefined)
  return NextResponse.json({ ok: true, deleted: true })
}
