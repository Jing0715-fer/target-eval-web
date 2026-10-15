/**
 * POST /api/evaluate/insights — 对已上传的评估表执行 LLM 智能解析。
 * body: { uploadId } → 读取 parsed.json 的 fullText，提取目标/科学问题/实验要点，
 * 持久化到 insights.json 并返回（重复调用返回缓存）。
 */
import { NextResponse } from 'next/server'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { extractFormInsights } from '@/lib/eval/docx-llm'
import type { FormInsights } from '@/lib/eval/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 180

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
  let body: InsightsBody
  try {
    body = (await req.json()) as InsightsBody
  } catch {
    return NextResponse.json({ ok: false, error: '请求体不是合法 JSON' }, { status: 400 })
  }

  const uploadId = (body.uploadId ?? '').trim()
  if (!/^[\w-]{4,64}$/.test(uploadId)) {
    return NextResponse.json({ ok: false, error: 'uploadId 无效' }, { status: 400 })
  }

  const dir = path.join(process.cwd(), 'db', 'reports', uploadId)
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

  const insights = await extractFormInsights(text, parsed.goalHints ?? [])
  // 持久化（失败不阻塞返回）
  try {
    await fs.writeFile(insightsPath, JSON.stringify(insights), 'utf-8')
  } catch { /* 磁盘失败时仅本次返回 */ }

  return NextResponse.json({ ok: true, insights, cached: false })
}
