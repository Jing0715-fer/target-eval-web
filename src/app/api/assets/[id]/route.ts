/**
 * GET /api/assets/[id] — 评估表图片流（胶图/SEC/其他）
 * 查找顺序：
 *  1. ReportAsset 数据库行（评估作业登记的精确路径）
 *  2. 上传目录磁盘扫描（db/reports 下各目录的 assets 子目录中按 id 找文件）——
 *     上传后、评估前，图片已落盘但尚无 DB 行（上传面板缩略图即此阶段），保证「上传即可见」
 */
import { NextResponse } from 'next/server'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { db } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ID_RE = /^a_[\w-]{4,64}$/

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

const EXT_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

/** 在 db/reports 各目录的 assets 子目录下扫描 {id}.{ext}（id 为随机串，目录数有界） */
async function findOnDisk(id: string): Promise<{ data: Buffer; mime: string } | null> {
  const root = path.join(process.cwd(), 'db', 'reports')
  let dirs: string[]
  try {
    dirs = (await fs.readdir(root, { withFileTypes: true }))
      .filter(e => e.isDirectory())
      .map(e => e.name)
  } catch {
    return null
  }
  for (const dir of dirs) {
    for (const [ext, mime] of Object.entries(EXT_TO_MIME)) {
      try {
        const p = path.join(root, dir, 'assets', `${id}${ext}`)
        const data = await fs.readFile(p)
        if (data.length > 0) return { data, mime }
      } catch { /* try next */ }
    }
  }
  return null
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!ID_RE.test(id)) {
    return NextResponse.json({ error: '图片 ID 无效' }, { status: 400 })
  }

  // 1) DB 行（评估作业登记）— 附带精确路径与 mime
  const asset = await db.reportAsset.findUnique({ where: { id } }).catch(() => null)
  if (asset) {
    const candidates = [asset.path, asset.path + (MIME_TO_EXT[asset.mime] ?? '')]
    for (const p of candidates) {
      try {
        const data = await fs.readFile(p)
        if (data.length > 0) {
          return imageResponse(data, asset.mime || 'image/png')
        }
      } catch { /* try next */ }
    }
  }

  // 2) 上传目录磁盘扫描（上传面板缩略图阶段）
  const found = await findOnDisk(id)
  if (found) return imageResponse(found.data, found.mime)

  return NextResponse.json({ error: '图片不存在或已过期清理' }, { status: 404 })
}

function imageResponse(data: Buffer, mime: string): NextResponse {
  return new NextResponse(new Uint8Array(data), {
    status: 200,
    headers: {
      'Content-Type': mime || 'application/octet-stream',
      'Content-Length': String(data.length),
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  })
}
