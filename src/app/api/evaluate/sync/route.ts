/**
 * POST /api/evaluate/sync — 无状态部署的同步流式评估（v2.4）。
 *
 * 背景：函数计算等无状态部署中，服务器磁盘与 SQLite 均不跨请求保留 ——
 * 「POST /api/evaluate 创建作业 + GET /api/jobs/[id] 轮询」的异步作业架构
 * 完全不可用（作业所在实例不可达、轮询 404、作业永不完成）。
 *
 * 方案：单个请求内同步跑完评估管线，以 NDJSON 流持续推送进度（防网关空闲
 * 超时），最终事件携带与 GET /api/jobs/[id] 同构的完整结果 + 内联 HTML 报告：
 *  - 请求体：与 /api/evaluate 同构 + evalTable（评估表全文/图片/要点内联）+ llm（引擎配置覆写）
 *  - 事件流：{"type":"job", job} 进度快照（~1.2s 节流）→ {"type":"ping"} 心跳（10s 空闲）
 *           → {"type":"done", job, reportHtml} 终态 / {"type":"error", error, job}
 *  - DB 写入尽力而为（写失败不阻塞；结果全部随响应返回）
 *
 * 有状态部署（本地/容器）不经此路由 —— 前端仅在检测到无状态环境时启用。
 */
import { NextResponse } from 'next/server'
import * as fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { db } from '@/lib/db'
import { createJobSnapshot, getJobSnapshot, makeReporter, markStatus } from '@/lib/eval/job-manager'
import { runPipeline, type InlineEvalTable, type PipelineResult } from '@/lib/eval/pipeline'
import { getOwner } from '@/lib/eval/request-guard'
import { setLlmConfigOverride } from '@/lib/eval/llm-provider'
import { isUploadId, uploadOwnedBy } from '@/lib/eval/upload-owner'
import type { EvaluationOptions, InputMode } from '@/lib/eval/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 600

/** 同步评估并发上限（单实例；防 FC 实例 OOM） */
const SYNC_CONCURRENCY = 2

const syncG = globalThis as unknown as { __syncEvalActive?: number }
syncG.__syncEvalActive ??= 0

interface SyncBody {
  mode?: InputMode
  uniprot?: string
  sequence?: string
  uploadId?: string
  docxJobId?: string
  uniprotFromDocx?: string
  sequenceFromDocx?: string
  goal?: string
  batchNote?: string
  evalTable?: InlineEvalTable
  ligands?: Array<{ raw: string; source?: 'text' | 'file' | 'eval-table'; fileName?: string }>
  options?: Partial<EvaluationOptions>
  /** v2.4：引擎配置覆写（无状态部署 DB 不保留，前端内联携带） */
  llm?: { providerKey?: string; baseUrl?: string; apiKey?: string; model?: string }
}

/** 流事件（NDJSON 行） */
type StreamEvent =
  | { type: 'job'; job: Record<string, unknown> }
  | { type: 'ping' }
  | { type: 'done'; job: Record<string, unknown>; reportHtml: string | null }
  | { type: 'error'; error: string; job: Record<string, unknown> | null }

export async function POST(req: Request) {
  const owner = getOwner(req)

  let body: SyncBody
  try {
    body = (await req.json()) as SyncBody
  } catch {
    return NextResponse.json({ ok: false, error: '请求体不是合法 JSON' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
  }

  const mode = body.mode
  if (mode !== 'uniprot' && mode !== 'sequence' && mode !== 'docx') {
    return NextResponse.json({ ok: false, error: 'mode 必须是 uniprot / sequence / docx 之一' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
  }

  const uploadId = body.docxJobId || body.uploadId || undefined
  const sequence = body.sequence || body.sequenceFromDocx || undefined
  const uniprot = body.uniprot || body.uniprotFromDocx || undefined

  if (mode === 'uniprot' && !uniprot) {
    return NextResponse.json({ ok: false, error: 'mode=uniprot 需要 uniprot 字段' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
  }
  if (mode === 'sequence' && !sequence) {
    return NextResponse.json({ ok: false, error: 'mode=sequence 需要 sequence 字段' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
  }
  if (mode === 'docx' && !uniprot && !sequence) {
    return NextResponse.json({ ok: false, error: 'mode=docx 需要评估表中解析出的 uniprot 或 sequence' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
  }

  // 上传归属校验（无状态部署磁盘无 owner.json → uploadOwnedBy 放行；有状态下严格校验）
  if (uploadId) {
    if (!isUploadId(uploadId)) {
      return NextResponse.json({ ok: false, error: 'uploadId 无效' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
    }
    const owned = await uploadOwnedBy(uploadId, owner)
    if (!owned) {
      return NextResponse.json({ ok: false, error: '无权使用该上传（仅上传者本人可用）' }, { status: 403, headers: { 'Cache-Control': 'no-store' } })
    }
  }

  // 单实例并发护栏（无状态部署配额 DB 无意义，用进程内计数防叠爆）
  if ((syncG.__syncEvalActive ?? 0) >= SYNC_CONCURRENCY) {
    return NextResponse.json(
      { ok: false, error: '当前实例并发评估已达上限，请稍候几秒后重试' },
      { status: 429, headers: { 'Cache-Control': 'no-store' } },
    )
  }
  syncG.__syncEvalActive = (syncG.__syncEvalActive ?? 0) + 1

  // 评估范围（与 /api/evaluate 同规则）
  const rawRange = body.options?.range
  let range: [number, number] | undefined
  if (Array.isArray(rawRange) && rawRange.length === 2) {
    const s = Number(rawRange[0]), e = Number(rawRange[1])
    if (Number.isFinite(s) && Number.isFinite(e) && s >= 1 && e >= s && e <= 100000) {
      range = [Math.round(s), Math.round(e)]
    }
  }
  const options: EvaluationOptions = {
    skipBlast: body.options?.skipBlast ?? false,
    forceBlast: body.options?.forceBlast ?? false,
    maxPdb: Math.min(300, Math.max(20, body.options?.maxPdb ?? 150)),
    reportMode: 'single', // 无状态批次不支持合并报告 → 恒为独立报告
    range,
  }

  const rawLigands = Array.isArray(body.ligands) ? body.ligands : []
  const ligands = rawLigands
    .map(l => ({
      raw: String(l?.raw ?? '').trim().slice(0, 160),
      source: l?.source === 'file' ? 'file' as const : l?.source === 'eval-table' ? 'eval-table' as const : 'text' as const,
      fileName: typeof l?.fileName === 'string' ? l.fileName.slice(0, 80) : undefined,
    }))
    .filter(l => l.raw.length > 0)
    .slice(0, 8)

  // 评估表内联数据消毒（全文 ≤14KB 与直传路由同口径；图片 ≤8 张带 dataUri）
  const evalTable: InlineEvalTable | undefined = body.evalTable
    ? {
        fullText: typeof body.evalTable.fullText === 'string' ? body.evalTable.fullText.slice(0, 14 * 1024) : undefined,
        goalHints: Array.isArray(body.evalTable.goalHints)
          ? body.evalTable.goalHints.filter(x => typeof x === 'string').slice(0, 12).map(x => x.slice(0, 200))
          : undefined,
        images: Array.isArray(body.evalTable.images)
          ? body.evalTable.images
              .filter(x => x && typeof x.id === 'string')
              .slice(0, 8)
              .map(x => ({ ...x, dataUri: typeof x.dataUri === 'string' && x.dataUri.startsWith('data:') ? x.dataUri : undefined }))
          : undefined,
        insights: body.evalTable.insights && Array.isArray(body.evalTable.insights.goals) ? body.evalTable.insights : undefined,
      }
    : undefined

  // DB 建行（尽力而为：失败不阻塞，用随机 id 跑管线）
  let jobId = ''
  try {
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
    jobId = job.id
  } catch {
    jobId = `s_${randomUUID().slice(0, 12)}`
  }

  // v2.4 引擎配置覆写（请求期间生效）
  if (body.llm && typeof body.llm.providerKey === 'string' && typeof body.llm.model === 'string' && body.llm.model.trim()) {
    setLlmConfigOverride({
      providerKey: body.llm.providerKey,
      baseUrl: typeof body.llm.baseUrl === 'string' ? body.llm.baseUrl : undefined,
      apiKey: typeof body.llm.apiKey === 'string' ? body.llm.apiKey : undefined,
      model: body.llm.model.trim(),
    })
  }

  const encoder = new TextEncoder()
  const snapshot = createJobSnapshot(jobId)
  markStatus(jobId, 'running')

  /** 静态 JobDetail 字段（进度事件复用） */
  const baseJob: Record<string, unknown> = {
    id: jobId,
    status: 'running',
    mode,
    uniprotId: uniprot?.toUpperCase() ?? null,
    goal: body.goal?.slice(0, 2000) ?? null,
    stateless: true,
  }
  const buildProgressJob = (): Record<string, unknown> => {
    const snap = getJobSnapshot(jobId)
    return {
      ...baseJob,
      status: snap?.status ?? 'running',
      progress: snap?.progress ?? null,
      logs: snap?.logs ?? [],
      queuePosition: 0,
      summary: null, pdbs: null, blastHits: null, literature: null, assets: null,
      reportMarkdown: null,
      reportAvailable: false,
      error: null,
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      const send = (ev: StreamEvent) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(JSON.stringify(ev) + '\n'))
        } catch { closed = true }
      }
      const sendError = (msg: string) => {
        markStatus(jobId, 'error')
        send({ type: 'error', error: msg, job: { ...buildProgressJob(), status: 'error', error: msg } })
      }

      // 进度节流推送（1.2s）+ 空闲心跳（≥10s 无事件时 5s 周期探测）
      const flushTimer = setInterval(() => {
        if (closed) return
        send({ type: 'job', job: buildProgressJob() })
      }, 1200)
      const heartbeatTimer = setInterval(() => {
        if (closed) return
        send({ type: 'ping' })
      }, 8000)

      const cleanup = () => {
        clearInterval(flushTimer)
        clearInterval(heartbeatTimer)
      }

      // 客户端断开（abort fetch）→ 中止管线
      const onCallerAbort = () => snapshot.abort.abort()
      req.signal.addEventListener('abort', onCallerAbort, { once: true })

      void (async () => {
        try {
          // 完成数据持有者（闭包赋值绕过 TS 控制流收窄）
          const holder: { r: PipelineResult | null } = { r: null }
          await runPipeline(
            {
              jobId,
              mode,
              uniprot: uniprot?.toUpperCase(),
              sequence,
              uploadId,
              evalTable,
              goal: body.goal,
              batchNote: body.batchNote?.trim().slice(0, 500) || undefined,
              ligands,
              options,
            },
            {
              signal: snapshot.abort.signal,
              // makeReporter：进度/日志写入内存快照（flush 循环统一推送）
              ...makeReporter(jobId),
              onComplete: r => { holder.r = r },
            },
          )
          const result = holder.r
          markStatus(jobId, 'done')
          // 最终事件：完整 JobDetail（与 GET /api/jobs/[id] 同构）+ 内联 HTML 报告
          const finalJob: Record<string, unknown> = {
            ...baseJob,
            status: 'done',
            progress: { stage: 'done', percent: 100, message: '评估完成', stages: [] },
            logs: snapshot.logs,
            queuePosition: 0,
            summary: result?.summary ?? null,
            pdbs: result?.directPdbs ?? null,
            blastHits: result?.blastHits ?? null,
            literature: result?.literature ?? null,
            assets: evalTable?.images ?? [],
            reportMarkdown: result?.reportMarkdown ?? null,
            reportAvailable: true,
            error: null,
          }
          let reportHtml: string | null = null
          if (result?.reportPath) {
            try {
              reportHtml = await fs.readFile(result.reportPath, 'utf-8')
            } catch { reportHtml = null }
          }
          send({ type: 'done', job: finalJob, reportHtml })
          // DB 终态（尽力而为）
          void db.evaluationJob.update({
            where: { id: jobId },
            data: { status: 'done', updatedAt: new Date() },
          }).catch(() => undefined)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          const aborted = snapshot.abort.signal.aborted || /abort/i.test(msg)
          if (aborted) {
            markStatus(jobId, 'canceled')
            sendError('已取消')
          } else {
            sendError(`评估失败：${msg.slice(0, 300)}`)
            void db.evaluationJob.update({
              where: { id: jobId },
              data: { status: 'error', error: msg.slice(0, 500), updatedAt: new Date() },
            }).catch(() => undefined)
          }
        } finally {
          cleanup()
          req.signal.removeEventListener('abort', onCallerAbort)
          setLlmConfigOverride(null) // 清理请求级引擎覆写
          syncG.__syncEvalActive = Math.max(0, (syncG.__syncEvalActive ?? 1) - 1)
          try { controller.close() } catch { /* already closed */ }
        }
      })()
    },
    cancel() {
      // 客户端断开连接 → 中止管线（start 内的 finally 统一负责资源清理与计数递减）
      snapshot.abort.abort()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no', // 透传代理不缓冲（保持流式）
    },
  })
}
