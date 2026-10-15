/**
 * POST /api/evaluate — 创建评估作业（串行队列执行）
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { createJobSnapshot, enqueueJob, getJobSnapshot, makeReporter, setJobRunning, markStatus } from '@/lib/eval/job-manager'
import { runPipeline } from '@/lib/eval/pipeline'
import type { EvaluationOptions, InputMode } from '@/lib/eval/types'

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
  options?: Partial<EvaluationOptions>
}

export async function POST(req: Request) {
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

  const options: EvaluationOptions = {
    skipBlast: body.options?.skipBlast ?? false,
    forceBlast: body.options?.forceBlast ?? false,
    maxPdb: Math.min(300, Math.max(20, body.options?.maxPdb ?? 150)),
  }

  // 创建 DB 记录（pending）
  const job = await db.evaluationJob.create({
    data: {
      status: 'pending',
      mode,
      title: mode === 'uniprot' ? `UniProt ${uniprot}` : mode === 'sequence' ? '序列靶点' : '评估表靶点',
      uniprotId: uniprot?.toUpperCase() ?? null,
      goal: body.goal?.slice(0, 2000) ?? null,
      options: JSON.stringify(options),
    },
  })

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
