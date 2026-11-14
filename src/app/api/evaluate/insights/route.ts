/**
 * POST /api/evaluate/insights — 评估表 LLM 智能解析（v2.6 流式版）。
 * body: { uploadId } → 读取 parsed.json 的 fullText，提取目标/科学问题/实验要点，
 * 持久化到 insights.json 并返回（重复调用返回缓存）。
 * 公网加固：仅上传者本人可对其上传执行解析（owner.json 归属校验）。
 *
 * v2.3 无状态模式：body: { text, goalHints } → 全文由前端内联携带（直传回退通道的
 * 后续解析），完全不读盘、不写缓存 —— 适配函数计算等「服务器数据不跨请求保留」的
 * 部署。text 优先级低于 uploadId 磁盘路径（两者并存时按磁盘缓存路径走）。
 *
 * v2.6 流式心跳（用户反馈「智能解析失败（HTTP 502）」根因修复）：
 *  部署网关 ALB 对无字节下发的请求 ~30s 空闲切断 — 旧版一次性 JSON 响应在
 *  冷启动（~5s 实例预热）+ 25s LLM 预算下恰好撞线 502；且部署节点 LLM 常态
 *  >25s，规则兜底被误当常态。现改为 NDJSON 流：首字节立即下发 + 7s 心跳
 *  （与 /api/evaluate/sync 同款、实测可存活 ~91s 的模式），LLM 预算放宽到
 *  ~50s（真实 LLM 提取成为常态），到点/失败仍按规则提取兜底返回。
 */
import { NextResponse } from 'next/server'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { extractFormInsights, fallbackInsights } from '@/lib/eval/docx-llm'
import { getOwner } from '@/lib/eval/request-guard'
import { isUploadId, uploadDir, uploadOwnedBy } from '@/lib/eval/upload-owner'
import type { FormInsights } from '@/lib/eval/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 70

/**
 * LLM 智能解析墙钟预算：流式心跳保活下可用满（远小于网关 ~91s 流切断）。
 * EVAL_INSIGHTS_BUDGET_MS 可调（>10s 生效）；默认 50s。
 */
const INSIGHTS_BUDGET_MS = Number(process.env.EVAL_INSIGHTS_BUDGET_MS) > 10_000 ? Number(process.env.EVAL_INSIGHTS_BUDGET_MS) : 50_000
/** 心跳间隔（ALB ~30s 空闲切断 — 7s 心跳留足余量） */
const HEARTBEAT_MS = 7_000

interface InsightsBody {
  uploadId?: string
  /** force=true 忽略缓存重新解析 */
  force?: boolean
  /** v2.3 无状态模式：全文内联（直传回退时前端携带；与 uploadId 互斥使用） */
  text?: string
  /** v2.3 无状态模式：目标提示（规则提取结果，辅助 LLM） */
  goalHints?: string[]
}

interface StoredParsed {
  fullText?: string
  goalHints?: string[]
}

export async function POST(req: Request) {
  const owner = getOwner(req)

  let body: InsightsBody
  try {
    body = (await req.json()) as InsightsBody
  } catch {
    return NextResponse.json({ ok: false, error: '请求体不是合法 JSON' }, { status: 400 })
  }

  // ── 参数预检（快速失败仍为 JSON — 不进流） ──
  const inlineText = (body.text ?? '').trim()
  const uploadId = (body.uploadId ?? '').trim()
  if (!uploadId && inlineText) {
    if (inlineText.length < 8) {
      return NextResponse.json({ ok: false, error: '评估表文本内容为空，无法智能解析' }, { status: 422 })
    }
  } else if (!isUploadId(uploadId)) {
    return NextResponse.json({ ok: false, error: 'uploadId 无效' }, { status: 400 })
  }

  // ── v2.6 流式执行：心跳保活 + LLM 大预算 ──
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      const send = (obj: Record<string, unknown>) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'))
        } catch { closed = true }
      }
      // 首字节立即下发（激活 ALB 流路径 — 冷启动期间也有字节流动）+ 周期心跳
      send({ type: 'ping' })
      const ping = setInterval(() => send({ type: 'ping' }), HEARTBEAT_MS)
      const cleanup = () => { clearInterval(ping) }

      void (async () => {
        try {
          // ── v2.3 无状态模式：全文内联 ──
          if (!uploadId) {
            const text = inlineText.slice(0, 14000)
            const goalHints = Array.isArray(body.goalHints) ? body.goalHints.slice(0, 24) : []
            const { insights, timedOut } = await runExtraction(text, goalHints, req.signal)
            send(timedOut
              ? { type: 'done', ok: true, insights, cached: false, note: '智能解析响应较慢，已返回规则提取结果；可点击“重新解析”重试' }
              : { type: 'done', ok: true, insights, cached: false })
            return
          }

          // ── uploadId 磁盘模式（有状态部署） ──
          if (!(await uploadOwnedBy(uploadId, owner))) {
            send({ type: 'done', ok: false, error: '无权解析该上传（仅上传者本人可用）' })
            return
          }
          const dir = uploadDir(uploadId)
          const insightsPath = path.join(dir, 'insights.json')

          // 缓存命中直接返回
          if (!body.force) {
            try {
              const raw = await fs.readFile(insightsPath, 'utf-8')
              const cached = JSON.parse(raw) as FormInsights
              if (Array.isArray(cached.goals)) {
                send({ type: 'done', ok: true, insights: cached, cached: true })
                return
              }
            } catch { /* 无缓存 */ }
          }

          let parsed: StoredParsed
          try {
            const raw = await fs.readFile(path.join(dir, 'parsed.json'), 'utf-8')
            parsed = JSON.parse(raw) as StoredParsed
          } catch {
            send({ type: 'done', ok: false, error: '未找到该上传的解析结果，请重新上传评估表' })
            return
          }
          const text = parsed.fullText ?? ''
          if (!text.trim()) {
            send({ type: 'done', ok: false, error: '评估表文本内容为空，无法智能解析' })
            return
          }

          const { insights, timedOut } = await runExtraction(text, parsed.goalHints ?? [], req.signal)
          // 持久化（失败不阻塞返回；超时兜底结果不写缓存 — 重试可获真实 LLM 结果）
          if (!timedOut) {
            try {
              await fs.writeFile(insightsPath, JSON.stringify(insights), 'utf-8')
            } catch { /* 磁盘失败时仅本次返回 */ }
          }
          send(timedOut
            ? { type: 'done', ok: true, insights, cached: false, note: '智能解析响应较慢，已返回规则提取结果；可点击“重新解析”重试' }
            : { type: 'done', ok: true, insights, cached: false })
        } catch (err) {
          send({ type: 'done', ok: false, error: err instanceof Error ? err.message : '智能解析异常' })
        } finally {
          cleanup()
          try { controller.close() } catch { /* already closed */ }
        }
      })()
    },
    cancel() {
      // 客户端断开 — runExtraction 经 req.signal 中止 LLM（不再后台空转）
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

/**
 * 墙钟预算内的 LLM 提取；超时/失败返回规则兜底（v2.5 兜底为全文结构化提取）。
 * v2.6：预算放宽至 ~50s（流式心跳保活）；超时同时向 LLM 传 AbortSignal（底层
 * 重试不再拖住后台资源），客户端断开（callerSignal）同样中止。
 */
async function runExtraction(
  text: string,
  goalHints: string[],
  callerSignal?: AbortSignal,
): Promise<{ insights: FormInsights; timedOut: boolean }> {
  let timedOut = false
  const ctrl = new AbortController()
  const onCallerAbort = () => ctrl.abort()
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
  let resolveNow: (v: FormInsights) => void = () => {}
  const timer = setTimeout(() => {
    timedOut = true
    ctrl.abort()
    resolveNow(fallbackInsights(text, goalHints))
  }, INSIGHTS_BUDGET_MS)
  try {
    const insights = await Promise.race([
      extractFormInsights(text, goalHints, ctrl.signal),
      new Promise<FormInsights>((resolve) => {
        resolveNow = resolve
      }),
    ])
    return { insights, timedOut }
  } catch {
    return { insights: fallbackInsights(text, goalHints), timedOut: false }
  } finally {
    clearTimeout(timer)
    callerSignal?.removeEventListener('abort', onCallerAbort)
  }
}
