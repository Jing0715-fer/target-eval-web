/**
 * POST /api/evaluate/upload/init — 创建分块上传会话。
 * 公网对策：平台 ALB 对单请求有 ~30s 硬超时，大文件直传或多图解析
 * （VLM 预算 90s）必然 502。此接口毫秒级返回，配合 chunk/complete/status
 * 把上传与解析拆成短请求。
 *
 * body: { name: string, size: number } → { ok, uploadId, chunkSize }
 * 配额：每 IP 24h 上传滑动窗口（429）；归属：owner.json 立即写入。
 *
 * v1.18：响应显式设置 Cache-Control: no-store —— Z.ai 公网 ALB 会缓存
 * POST 响应（即使 dynamic=force-dynamic），曾导致上传配额 429 被缓存复用。
 */
import { NextResponse } from 'next/server'
import { getOwner } from '@/lib/eval/request-guard'
import { initUploadSession } from '@/lib/eval/upload-session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

interface InitBody {
  name?: string
  size?: number
}

export async function POST(req: Request) {
  const owner = getOwner(req)
  let body: InitBody
  try {
    body = (await req.json()) as InitBody
  } catch {
    return NextResponse.json({ ok: false, error: '请求体不是合法 JSON' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
  }
  const name = typeof body.name === 'string' ? body.name : ''
  const size = typeof body.size === 'number' ? body.size : -1
  const r = await initUploadSession(owner, name, size)
  if (!r.ok) {
    return NextResponse.json({ ok: false, error: r.error }, { status: r.status, headers: { 'Cache-Control': 'no-store' } })
  }
  return NextResponse.json(r, { headers: { 'Cache-Control': 'no-store' } })
}
