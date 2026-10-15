/**
 * POST /api/evaluate/upload — 上传 Word 评估表（.docx）
 * 解析文本（UniProt/序列/基因/目标语句）+ 提取图片（胶图/SEC）到磁盘。
 * 解析结果持久化到 db/reports/{uploadId}/parsed.json 供评估阶段复用。
 */
import { NextResponse } from 'next/server'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { DOCX_MAX_BYTES, parseDocx } from '@/lib/eval/docx'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function POST(req: Request) {
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

  try {
    const buffer = Buffer.from(await file.arrayBuffer())
    const { uploadId, parsed } = await parseDocx(buffer)
    // 持久化解析结果（评估阶段读取 images/goalHints/fullText）
    try {
      await fs.writeFile(
        path.join(process.cwd(), 'db', 'reports', uploadId, 'parsed.json'),
        JSON.stringify(parsed),
        'utf-8',
      )
    } catch { /* 持久化失败不阻塞返回 */ }

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
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ ok: false, error: `文档解析失败：${msg}` }, { status: 500 })
  }
}
