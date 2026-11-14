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
 * v2.6.2 心跳形态复刻 sync（用户反馈「重新部署后依然 502」根因修复）：
 *  v2.6.1 的 16B 小 ping 在部署链路上全程未穿透（客户端 0 字节直到 50s 应用
 *  兜底时刻被 ALB 502），而 /api/evaluate/sync 的流式在同网关下稳定透传 —
 *  差异在报文形态：sync 首事件为 1.2s 后的 ~1.5KB 大块。故本版将 insights
 *  心跳完全复刻 sync 形态：异步首个 beat（1.2s）+ ~1.4KB pad + 3s 周期，
 *  同时删除 start() 内的同步 enqueue（规避疑似首块吞噬）；LLM 预算收紧到
 *  40s（远离 ALB ~50s 接收超时，close 时刻也落在安全窗）；另增 quick 快速
 *  兜底模式（前端三级降级的最后一級，跳过 LLM 毫秒级返回规则提取，永不卡死）。
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
 * LLM 智能解析墙钟预算：40s —— 远离部署 ALB ~50s 接收超时（流正常 close
 * 也落在安全窗内）。EVAL_INSIGHTS_BUDGET_MS 可调（>10s 生效）。
 */
const INSIGHTS_BUDGET_MS = Number(process.env.EVAL_INSIGHTS_BUDGET_MS) > 10_000 ? Number(process.env.EVAL_INSIGHTS_BUDGET_MS) : 40_000
/** 心跳间隔（复刻 sync 已验证穿透的事件节奏；≤sync 的 8s ping 空闲间隔） */
const HEARTBEAT_MS = 3_000
/** 心跳 pad 体积：对齐 sync 首个进度事件 ~1.5KB —— 防小帧被中间层缓冲吞没 */
const BEAT_PAD = 'p'.repeat(1400)

interface InsightsBody {
  uploadId?: string
  /** force=true 忽略缓存重新解析 */
  force?: boolean
  /** v2.3 无状态模式：全文内联（直传回退时前端携带；与 uploadId 互斥使用） */
  text?: string
  /** v2.3 无状态模式：目标提示（规则提取结果，辅助 LLM） */
  goalHints?: string[]
  /** v2.6.2 快速兜底模式：跳过 LLM 直接规则提取（前端流式两次失败后的第三级降级） */
  quick?: boolean
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

  // ── v2.6.2 流式执行：心跳形态复刻 sync + LLM 40s 预算 ──
  const encoder = new TextEncoder()
  const t0 = Date.now()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      const send = (obj: Record<string, unknown>) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'))
        } catch { closed = true }
      }
      // 心跳 beat：异步首发送（1.2s 后，与 sync 首个进度事件同节奏 — 不同步 enqueue，
      // 规避疑似首块吞噬）+ ~1.4KB pad（对齐 sync 事件体积，防小帧被中间层缓冲
      // 扣至流结束才冲刷）。elapsedMs/budgetMs 供前端诊断展示。
      const sendBeat = () => send({
        type: 'ping',
        elapsedMs: Date.now() - t0,
        budgetMs: INSIGHTS_BUDGET_MS,
        pad: BEAT_PAD,
      })
      const firstBeat = setTimeout(sendBeat, 1_200)
      const ping = setInterval(sendBeat, HEARTBEAT_MS)
      const cleanup = () => { clearTimeout(firstBeat); clearInterval(ping) }

      void (async () => {
        try {
          // ── v2.3 无状态模式：全文内联 ──
          if (!uploadId) {
            const text = inlineText.slice(0, 14000)
            const goalHints = Array.isArray(body.goalHints) ? body.goalHints.slice(0, 24) : []
            if (body.quick) {
              // v2.6.2 快速兜底：跳过 LLM，毫秒级返回规则提取（流程永不卡死）
              send({ type: 'done', ok: true, insights: fallbackInsights(text, goalHints), cached: false, note: '已返回规则提取结果（快速兜底模式；可稍后点击「重新解析」获取 AI 提取）' })
              return
            }
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
            // v2.6.2：多实例磁盘不共享时自动降级为前端内联全文（text 随请求携带的场合）
            if (inlineText.length >= 8) {
              const inlineGoalHints = Array.isArray(body.goalHints) ? body.goalHints.slice(0, 24) : []
              if (body.quick) {
                send({ type: 'done', ok: true, insights: fallbackInsights(inlineText.slice(0, 14000), inlineGoalHints), cached: false, note: '已返回规则提取结果（快速兜底模式；可稍后点击「重新解析」获取 AI 提取）' })
                return
              }
              const { insights, timedOut } = await runExtraction(inlineText.slice(0, 14000), inlineGoalHints, req.signal)
              send(timedOut
                ? { type: 'done', ok: true, insights, cached: false, note: '智能解析响应较慢，已返回规则提取结果；可点击“重新解析”重试' }
                : { type: 'done', ok: true, insights, cached: false })
              return
            }
            send({ type: 'done', ok: false, error: '未找到该上传的解析结果，请重新上传评估表' })
            return
          }
          const text = parsed.fullText ?? ''
          if (!text.trim()) {
            send({ type: 'done', ok: false, error: '评估表文本内容为空，无法智能解析' })
            return
          }

          // v2.6.2 快速兜底（uploadId 模式）：跳过 LLM 直接规则提取，不写缓存
          if (body.quick) {
            send({ type: 'done', ok: true, insights: fallbackInsights(text, parsed.goalHints ?? []), cached: false, note: '已返回规则提取结果（快速兜底模式；可稍后点击「重新解析」获取 AI 提取）' })
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
 * v2.6.2：预算收紧至 ~40s（远离 ALB ~50s 接收超时）；超时同时向 LLM 传
 * AbortSignal（底层重试不再拖住后台资源），客户端断开（callerSignal）同样中止。
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
