/**
 * POST /api/evaluate/insights — 对已上传的评估表执行 LLM 智能解析。
 * body: { uploadId } → 读取 parsed.json 的 fullText，提取目标/科学问题/实验要点，
 * 持久化到 insights.json 并返回（重复调用返回缓存）。
 * 公网加固：仅上传者本人可对其上传执行解析（owner.json 归属校验）。
 *
 * 超时对策：平台 ALB 对单请求 ~30s 硬超时。LLM 调用本身超时上限 120s，
 * 慢响应会 502 —— 这里用 25s 墙钟兜底：超时返回规则兜底结果且不写缓存，
 * 前端提示后可重试（成功才落盘 insights.json）。
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

  const uploadId = (body.uploadId ?? '').trim()
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

  // 墙钟预算：超时返回规则兜底（不写缓存，重试可获真实 LLM 结果）
  let timedOut = false
  let insights: FormInsights
  try {
    insights = await Promise.race([
      extractFormInsights(text, parsed.goalHints ?? []),
      new Promise<FormInsights>((resolve) => {
        setTimeout(() => {
          timedOut = true
          resolve(fallbackInsights(parsed.goalHints ?? []))
        }, INSIGHTS_BUDGET_MS)
      }),
    ])
  } catch {
    insights = fallbackInsights(parsed.goalHints ?? [])
  }
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
