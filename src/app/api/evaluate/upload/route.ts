/**
 * POST /api/evaluate/upload — 上传 Word 评估表（.docx）
 * 解析文本（UniProt/序列/基因/目标语句）+ 提取归一化图片（胶图/SEC，含 EMF/WMF
 * 转换、大图降采样、VLM 类型识别）到磁盘。
 * 解析结果持久化到 db/reports/{uploadId}/parsed.json 供评估阶段复用。
 *
 * 公网加固（防 OOM / 防滥用）：
 *  - 每 IP 24h 上传滑动窗口配额（MAX_UPLOADS_PER_DAY）
 *  - 解析在全局并发信号量内执行（PARSE_CONCURRENCY；等待超限 429）
 *    — mammoth 20MB 缓冲 + sharp + VLM 是内存峰值主源，必须有界
 *  - 上传目录写入 owner.json（IP 哈希），供 insights / evaluate / assets 归属校验
 */
import { NextResponse } from 'next/server'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { DOCX_MAX_BYTES, parseDocx } from '@/lib/eval/docx'
import { getOwner } from '@/lib/eval/request-guard'
import { checkAndCountUpload, quotaResponse, withParseSlot, QuotaError } from '@/lib/eval/gatekeeper'
import { writeOwnerFile } from '@/lib/eval/upload-owner'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 180

/** 上传目录 TTL（24h）：过期目录在后续上传时后台回收 */
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000

/**
 * 后台清理过期上传目录（db/reports/u_*，按目录 mtime > 24h）。
 * fire-and-forget：失败静默；单次最多回收 40 个（防长尾）。
 */
function cleanupExpiredUploads(): void {
  void (async () => {
    try {
      const root = path.join(process.cwd(), 'db', 'reports')
      const entries = await fs.readdir(root, { withFileTypes: true })
      const now = Date.now()
      let removed = 0
      for (const e of entries) {
        if (removed >= 40) break
        if (!e.isDirectory() || !e.name.startsWith('u_')) continue
        const dir = path.join(root, e.name)
        try {
          const st = await fs.stat(dir)
          if (now - st.mtimeMs > UPLOAD_TTL_MS) {
            await fs.rm(dir, { recursive: true, force: true })
            removed++
          }
        } catch { /* 单目录失败忽略 */ }
      }
    } catch { /* readdir 失败忽略 */ }
  })()
}

export async function POST(req: Request) {
  const owner = getOwner(req)

  let file: File | null = null
  try {
    const form = await req.formData()
    file = form.get('file') as File | null
  } catch {
    return NextResponse.json({ ok: false, error: '请求必须是 multipart/form-data（file 字段）' }, { status: 400 })
  }
  if (!file || typeof file === 'string') {
    return NextResponse.json({ ok: false, error: '缺少 file 字段' }, { status: 400 })
  }
  const name = file.name || 'upload.docx'
  if (!/\.docx$/i.test(name)) {
    return NextResponse.json({ ok: false, error: '仅支持 .docx 格式（旧版 .doc 请先另存为 .docx）' }, { status: 400 })
  }
  if (file.size > DOCX_MAX_BYTES) {
    return NextResponse.json({ ok: false, error: `文件过大（${(file.size / 1024 / 1024).toFixed(1)}MB），上限 20MB` }, { status: 413 })
  }

  // 每 IP 上传日配额（滑动窗口）
  try {
    checkAndCountUpload(owner.key)
  } catch (e) {
    if (e instanceof QuotaError) return quotaResponse(e)
    throw e
  }

  cleanupExpiredUploads()

  try {
    const buffer = Buffer.from(await file.arrayBuffer())
    // 解析纳入全局并发信号量（内存峰值有界；繁忙时 429）
    const { uploadId, parsed } = await withParseSlot(() => parseDocx(buffer))
    // 持久化解析结果（评估阶段读取 images/goalHints/fullText）。
    // 持久化失败必须报错（而非静默）：否则后续 insights 404、评估丢图。
    const parsedPath = path.join(process.cwd(), 'db', 'reports', uploadId, 'parsed.json')
    try {
      await fs.writeFile(parsedPath, JSON.stringify(parsed), 'utf-8')
    } catch (e1) {
      // 重试一次（目录竞争等瞬态错误）
      try {
        await fs.mkdir(path.dirname(parsedPath), { recursive: true })
        await fs.writeFile(parsedPath, JSON.stringify(parsed), 'utf-8')
      } catch (e2) {
        throw new Error(`解析结果持久化失败：${e2 instanceof Error ? e2.message : String(e2)}（e1: ${e1 instanceof Error ? e1.message : String(e1)}）`)
      }
    }
    // 归属标记（insights / evaluate / assets 校验用）
    await writeOwnerFile(uploadId, owner)

    // 响应剥离 fullText（≤14KB，仅后端 LLM 解析用），保持响应轻量
    const { fullText: _ft, ...parsedLite } = parsed
    void _ft

    if (parsed.uniprotIds.length === 0 && parsed.sequences.length === 0) {
      // 未识别出可用靶点信息也返回（用户可补填），但提示
      return NextResponse.json({
        ok: true,
        uploadId,
        parsed: parsedLite,
        error: '提示：未在评估表中识别出 UniProt ID 或蛋白序列，请检查文档内容或改用其他输入方式',
      })
    }
    return NextResponse.json({ ok: true, uploadId, parsed: parsedLite })
  } catch (e) {
    if (e instanceof QuotaError) return quotaResponse(e)
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ ok: false, error: `文档解析失败：${msg}` }, { status: 500 })
  }
}
