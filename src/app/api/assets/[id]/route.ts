/**
 * GET /api/assets/[id] — 评估表图片流（胶图/SEC）
 */
import { NextResponse } from 'next/server'
import * as fs from 'node:fs/promises'
import { db } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MIME_TO_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/tiff': '.tiff',
  'image/bmp': '.bmp',
  'image/x-emf': '.emf',
  'image/x-wmf': '.wmf',
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const asset = await db.reportAsset.findUnique({ where: { id } })
  if (!asset) return NextResponse.json({ error: '图片不存在' }, { status: 404 })
  let data: Buffer | null = null
  const candidates = [asset.path, asset.path + (MIME_TO_EXT[asset.mime] ?? '')]
  for (const p of candidates) {
    try {
      data = await fs.readFile(p)
      if (data.length > 0) break
    } catch { /* try next */ }
  }
  if (!data || data.length === 0) return NextResponse.json({ error: '图片文件已丢失' }, { status: 404 })
  return new NextResponse(new Uint8Array(data), {
    status: 200,
    headers: {
      'Content-Type': asset.mime || 'application/octet-stream',
      'Content-Length': String(data.length),
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  })
}
