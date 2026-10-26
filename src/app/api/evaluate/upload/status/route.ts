/**
 * GET /api/evaluate/upload/status?uploadId=… — 轮询分块上传/解析状态。
 * 返回 { phase: uploading|queued|parsing|done|error }；phase=done 时附带
 * 与旧直传响应同构的 parsed 载荷（前端复用同一渲染路径）。
 *
 * 归属：会话期校验 session.json 的 ownerKey；完成后校验 owner.json。
 */
import { NextResponse } from 'next/server'
import { getOwner } from '@/lib/eval/request-guard'
import { getSessionStatus } from '@/lib/eval/upload-session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function GET(req: Request) {
  const owner = getOwner(req)
  const url = new URL(req.url)
  const uploadId = (url.searchParams.get('uploadId') ?? '').trim()
  if (!uploadId) {
    return NextResponse.json({ ok: false, error: '缺少 uploadId 参数' }, { status: 400 })
  }
  const r = await getSessionStatus(owner, uploadId)
  if (!r.ok) {
    return NextResponse.json({ ok: false, error: r.error }, { status: r.status })
  }
  return NextResponse.json(r)
}
