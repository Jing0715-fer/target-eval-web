/**
 * POST /api/evaluate/upload/complete — 完成分块上传并触发后台解析。
 * 毫秒级返回（不做解析）：校验完整性后把解析任务放入后台队列，
 * 前端轮询 GET /api/evaluate/upload/status 获取解析结果。
 *
 * 归属：会话 ownerKey 校验；解析并发受全局信号量约束（与直传路由共享）。
 *
 * v1.18：响应显式设置 Cache-Control: no-store（公网 ALB 会缓存 POST 响应）。
 */
import { NextResponse } from 'next/server'
import { getOwner } from '@/lib/eval/request-guard'
import { completeUploadSession } from '@/lib/eval/upload-session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

interface CompleteBody {
  uploadId?: string
}

export async function POST(req: Request) {
  const owner = getOwner(req)
  let body: CompleteBody
  try {
    body = (await req.json()) as CompleteBody
  } catch {
    return NextResponse.json({ ok: false, error: '请求体不是合法 JSON' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
  }
  const uploadId = (body.uploadId ?? '').trim()
  if (!uploadId) {
    return NextResponse.json({ ok: false, error: '缺少 uploadId 字段' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
  }
  const r = await completeUploadSession(owner, uploadId)
  if (!r.ok) {
    return NextResponse.json({ ok: false, error: r.error }, { status: r.status, headers: { 'Cache-Control': 'no-store' } })
  }
  return NextResponse.json({ ok: true, uploadId }, { headers: { 'Cache-Control': 'no-store' } })
}
