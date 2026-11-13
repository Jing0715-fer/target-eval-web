/**
 * POST /api/evaluate/insights — 对已上传的评估表执行 LLM 智能解析。
 * body: { uploadId } → 读取 parsed.json 的 fullText，提取目标/科学问题/实验要点，
 * 持久化到 insights.json 并返回（重复调用返回缓存）。
 * 公网加固：仅上传者本人可对其上传执行解析（owner.json 归属校验）。
 *
 * v2.3 无状态模式：body: { text, goalHints } → 全文由前端内联携带（直传回退通道的
 * 后续解析），完全不读盘、不写缓存 —— 适配函数计算等「服务器数据不跨请求保留」的
 * 部署。text 优先级低于 uploadId 磁盘路径（两者并存时按磁盘缓存路径走）。
 *
 * 超时对策：timeout fallback 仍按规则提取返回。
 */
import { NextResponse } from 'next/server'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { extractFormInsights, fallbackInsights } from '@/lib/eval/docx-llm'
import { getOwner, forbidden } from '@/lib/eval/request-guard'
import { isUploadId, uploadDir, uploadOwnedBy } from '@/lib/eval/upload-owner'
import type { FormInsights } from '@/lib/eval/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** LLM 智能解析墙钟预算（留 5s 余量给 ALB 30s 超时） */
const INSIGHTS_BUDGET_MS = 25_000

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

  // ── v2.3 无状态模式：全文内联（无 uploadId / 磁盘不可达时前端携带） ──
  const inlineText = (body.text ?? '').trim()
  const uploadId = (body.uploadId ?? '').trim()
  if (!uploadId && inlineText) {
    if (inlineText.length < 8) {
      return NextResponse.json({ ok: false, error: '评估表文本内容为空，无法智能解析' }, { status: 422 })
    }
    const text = inlineText.slice(0, 14000)
    const goalHints = Array.isArray(body.goalHints) ? body.goalHints.slice(0, 24) : []
    const { insights, timedOut } = await runExtraction(text, goalHints)
    if (timedOut) {
      return NextResponse.json({
        ok: true,
        insights,
        cached: false,
        note: '智能解析响应较慢，已返回规则提取结果；可点击“重新解析”重试',
      })
    }
    return NextResponse.json({ ok: true, insights, cached: false })
  }

  if (!isUploadId(uploadId)) {
    return NextResponse.json({ ok: false, error: 'uploadId 无效' }, { status: 400 })
  }
  if (!(await uploadOwnedBy(uploadId, owner))) {
    return forbidden()
  }

  const dir = uploadDir(uploadId)
  const insightsPath = path.join(dir, 'insights.json')

  // 缓存命中直接返回
  if (!body.force) {
    try {
      const raw = await fs.readFile(insightsPath, 'utf-8')
      const cached = JSON.parse(raw) as FormInsights
      if (Array.isArray(cached.goals)) {
        return NextResponse.json({ ok: true, insights: cached, cached: true })
      }
    } catch { /* 无缓存 */ }
  }

  let parsed: StoredParsed
  try {
    const raw = await fs.readFile(path.join(dir, 'parsed.json'), 'utf-8')
    parsed = JSON.parse(raw) as StoredParsed
  } catch {
    return NextResponse.json({ ok: false, error: '未找到该上传的解析结果，请重新上传评估表' }, { status: 404 })
  }

  const text = parsed.fullText ?? ''
  if (!text.trim()) {
    return NextResponse.json({ ok: false, error: '评估表文本内容为空，无法智能解析' }, { status: 422 })
  }

  const { insights, timedOut } = await runExtraction(text, parsed.goalHints ?? [])

  if (timedOut) {
    return NextResponse.json({
      ok: true,
      insights,
      cached: false,
      note: '智能解析响应较慢，已返回规则提取结果；可点击“重新解析”重试',
    })
  }
  // 持久化（失败不阻塞返回）
  try {
    await fs.writeFile(insightsPath, JSON.stringify(insights), 'utf-8')
  } catch { /* 磁盘失败时仅本次返回 */ }

  return NextResponse.json({ ok: true, insights, cached: false })
}

/** 墙钟预算内的 LLM 提取；超时/失败返回规则兜底（不写缓存，重试可获真实结果） */
async function runExtraction(text: string, goalHints: string[]): Promise<{ insights: FormInsights; timedOut: boolean }> {
  let timedOut = false
  try {
    const insights = await Promise.race([
      extractFormInsights(text, goalHints),
      new Promise<FormInsights>((resolve) => {
        setTimeout(() => {
          timedOut = true
          resolve(fallbackInsights(goalHints))
        }, INSIGHTS_BUDGET_MS)
      }),
    ])
    return { insights, timedOut }
  } catch {
    return { insights: fallbackInsights(goalHints), timedOut: false }
  }
}
