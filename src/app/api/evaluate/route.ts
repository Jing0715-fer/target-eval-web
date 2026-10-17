/**
 * POST /api/evaluate — 创建评估作业（串行队列执行）
 * 公网加固：记录创建者归属（IP 哈希）、创建前配额检查（全局排队上限 /
 * 每 IP 活跃与日配额）、上传目录归属校验、触发终态作业 TTL 清理。
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { createJobSnapshot, enqueueJob, getJobSnapshot, makeReporter, setJobRunning, markStatus } from '@/lib/eval/job-manager'
import { runPipeline } from '@/lib/eval/pipeline'
import { getOwner } from '@/lib/eval/request-guard'
import { checkJobQuota, quotaResponse, scheduleJobTtlCleanup, QuotaError } from '@/lib/eval/gatekeeper'
import { isUploadId, uploadOwnedBy } from '@/lib/eval/upload-owner'
import type { BlastGroup, EvaluationOptions, InputMode } from '@/lib/eval/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 600

interface EvaluateBody {
  mode?: InputMode
  uniprot?: string
  sequence?: string
  docxJobId?: string
  uploadId?: string
  uniprotFromDocx?: string
  sequenceFromDocx?: string
  goal?: string
  /** 批次关系说明（非关联批量：注入报告说明独立/复合物定位，≤500 字） */
  batchNote?: string
  /** ≥90% 高一致同源组委托（v1.11）：组内首个到达 BLAST 阶段的作业为代表，其余共享结果不重复检索 */
  homologBlast?: Partial<BlastGroup>
  options?: Partial<EvaluationOptions>
}

export async function POST(req: Request) {
  const owner = getOwner(req)

  let body: EvaluateBody
  try {
    body = (await req.json()) as EvaluateBody
  } catch {
    return NextResponse.json({ ok: false, error: '请求体不是合法 JSON' }, { status: 400 })
  }

  const mode = body.mode
  if (mode !== 'uniprot' && mode !== 'sequence' && mode !== 'docx') {
    return NextResponse.json({ ok: false, error: 'mode 必须是 uniprot / sequence / docx 之一' }, { status: 400 })
  }

  const uploadId = body.docxJobId || body.uploadId || undefined
  const sequence = body.sequence || body.sequenceFromDocx || undefined
  const uniprot = body.uniprot || body.uniprotFromDocx || undefined

  if (mode === 'uniprot' && !uniprot) {
    return NextResponse.json({ ok: false, error: 'mode=uniprot 需要 uniprot 字段' }, { status: 400 })
  }
  if (mode === 'sequence' && !sequence) {
    return NextResponse.json({ ok: false, error: 'mode=sequence 需要 sequence 字段' }, { status: 400 })
  }
  if (mode === 'docx' && !uniprot && !sequence) {
    return NextResponse.json({ ok: false, error: 'mode=docx 需要评估表中解析出的 uniprot 或 sequence（请先上传并选择）' }, { status: 400 })
  }

  // 上传目录归属校验（防跨用户引用他人上传的评估表/图片）
  if (uploadId) {
    if (!isUploadId(uploadId)) {
      return NextResponse.json({ ok: false, error: 'uploadId 无效' }, { status: 400 })
    }
    const owned = await uploadOwnedBy(uploadId, owner)
    if (!owned) {
      return NextResponse.json({ ok: false, error: '无权使用该上传（仅上传者本人可用）' }, { status: 403 })
    }
  }

  // 并发/配额守卫（全局排队上限 + 每 IP 活跃上限 + 日配额）
  try {
    const quota = await checkJobQuota(owner.key)
    if (!quota.ok && quota.error) throw quota.error
  } catch (e) {
    if (e instanceof QuotaError) return quotaResponse(e)
    return NextResponse.json({ ok: false, error: '配额检查失败，请稍后重试' }, { status: 500 })
  }

  const options: EvaluationOptions = {
    skipBlast: body.options?.skipBlast ?? false,
    forceBlast: body.options?.forceBlast ?? false,
    maxPdb: Math.min(300, Math.max(20, body.options?.maxPdb ?? 150)),
    reportMode: body.options?.reportMode === 'deferred' ? 'deferred' : 'single',
  }
  const batchNote = body.batchNote?.trim().slice(0, 500) || undefined

  // v1.11 同源家族 BLAST 委托（宽松校验：字段形态不对则忽略，不影响常规评估）
  const hb = body.homologBlast
  const homologBlast = hb
    && typeof hb.groupKey === 'string' && /^hg[\w-]{1,48}$/.test(hb.groupKey)
    && Array.isArray(hb.members) && hb.members.length >= 2 && hb.members.length <= 6
    && hb.members.every(m => typeof m === 'string' && /^[A-Z0-9-]{6,16}$/.test(m))
    && typeof hb.minIdentity === 'number' && hb.minIdentity >= 40 && hb.minIdentity <= 100
    ? { groupKey: hb.groupKey, members: hb.members, minIdentity: hb.minIdentity }
    : undefined

  // 创建 DB 记录（pending）— 记录归属（哈希键 + 掩码）
  const job = await db.evaluationJob.create({
    data: {
      status: 'pending',
      mode,
      title: mode === 'uniprot' ? `UniProt ${uniprot}` : mode === 'sequence' ? '序列靶点' : '评估表靶点',
      uniprotId: uniprot?.toUpperCase() ?? null,
      goal: body.goal?.slice(0, 2000) ?? null,
      options: JSON.stringify(options),
      ownerKey: owner.key,
      ownerMask: owner.mask,
    },
  })

  // 惰性触发终态作业 TTL 清理（fire-and-forget）
  scheduleJobTtlCleanup()

  // 内存快照 + 串行队列
  createJobSnapshot(job.id)
  const { report, log } = makeReporter(job.id)

  enqueueJob(async () => {
    // 复用已有快照（保留排队期间的取消标记），不存在才补建
    const snap = getJobSnapshot(job.id) ?? createJobSnapshot(job.id)
    if (snap.status === 'canceled') return
    setJobRunning(job.id)
    await db.evaluationJob.update({ where: { id: job.id }, data: { status: 'running', updatedAt: new Date() } }).catch(() => undefined)
    report('input', '开始评估…', 0)
    log(`作业开始：mode=${mode}${uniprot ? ` uniprot=${uniprot}` : ''}${sequence ? ` seqLen=${sequence.length}` : ''}${uploadId ? ` uploadId=${uploadId}` : ''}`)
    try {
      await runPipeline(
        {
          jobId: job.id,
          mode,
          uniprot: uniprot?.toUpperCase(),
          sequence,
          uploadId,
          goal: body.goal,
          batchNote,
          homologBlast,
          options,
        },
        { signal: snap.abort.signal, report, log },
      )
      markStatus(job.id, 'done')
      await db.evaluationJob.update({
        where: { id: job.id },
        data: { logs: JSON.stringify(snap.logs), updatedAt: new Date() },
      }).catch(() => undefined)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const aborted = snap.abort.signal.aborted || /abort/i.test(msg)
      const status = aborted ? 'canceled' : 'error'
      markStatus(job.id, status)
      log(`作业${status === 'canceled' ? '已取消' : `失败：${msg}`}`, 'error')
      await db.evaluationJob.update({
        where: { id: job.id },
        data: {
          status,
          error: status === 'canceled' ? '用户取消' : msg.slice(0, 500),
          logs: JSON.stringify(snap.logs),
          updatedAt: new Date(),
        },
      }).catch(() => undefined)
    }
  })

  return NextResponse.json({ ok: true, jobId: job.id })
}
