/**
 * PUT /api/evaluate/upload/chunk?uploadId=…&offset=N — 追加一个分块。
 * 请求体为原始二进制（application/octet-stream，无 multipart 开销）。
 * 单块 2MB（客户端切片，服务端上限 8MB 防御），秒级完成，规避 ALB 超时；
 * 客户端可对失败分块逐块重试（offset 不连续会 409 提示）。
 *
 * 归属：会话 ownerKey 校验（init 时绑定创建者，cookie/ipKey 两层回退）。
 * v2.5：读体前先校验 Content-Length（防先整体读入超大请求体再 413 的 OOM 放大）。
 *
 * v1.18：响应显式设置 Cache-Control: no-store（公网 ALB 会缓存 POST/PUT 响应）。
 */
import { NextResponse } from 'next/server'
import { getOwner } from '@/lib/eval/request-guard'
import { appendChunk, CHUNK_MAX_BYTES } from '@/lib/eval/upload-session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function PUT(req: Request) {
  const owner = getOwner(req)
  const url = new URL(req.url)
  const uploadId = url.searchParams.get('uploadId') ?? ''
  const offset = Number(url.searchParams.get('offset'))
  if (!uploadId) {
    return NextResponse.json({ ok: false, error: '缺少 uploadId 参数' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
  }
  if (!Number.isFinite(offset)) {
    return NextResponse.json({ ok: false, error: '缺少 offset 参数' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
  }
  // v2.5：Content-Length 预检（读体前拒绝超限，避免恶意大请求体先打满内存再收 413）
  const declared = Number(req.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > CHUNK_MAX_BYTES) {
    return NextResponse.json({ ok: false, error: `分块过大（上限 8MB）` }, { status: 413, headers: { 'Cache-Control': 'no-store' } })
  }
  let chunk: ArrayBuffer
  try {
    chunk = await req.arrayBuffer()
  } catch {
    return NextResponse.json({ ok: false, error: '分块读取失败（请求体损坏或过大）' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
  }
  const r = await appendChunk(owner, uploadId, offset, chunk)
  if (!r.ok) {
    return NextResponse.json({ ok: false, error: r.error }, { status: r.status, headers: { 'Cache-Control': 'no-store' } })
  }
  return NextResponse.json(r, { headers: { 'Cache-Control': 'no-store' } })
}
