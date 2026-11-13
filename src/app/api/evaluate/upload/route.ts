/**
 * POST /api/evaluate/upload — 直传解析 Word 评估表（.docx，multipart file 字段）。
 *
 * v2.3 双角色：
 *  1. 本地/内网快速联调与 API 兼容（原直传语义，含 VLM 图片识别）。
 *  2. ⚠️ 无状态部署（如函数计算快照部署，服务器数据不跨请求保留）的**自动回退通道**：
 *     分块上传会话在那种环境下会 404（session.json 落在被回收的实例上），前端检测到
 *     「上传会话不存在」后改走本接口 —— 单请求内完成上传 + 解析 + 返回全部结果：
 *      - fullText 随响应返回（后续 LLM 智能解析由前端内联携带，不依赖磁盘）
 *      - 图片以 data URI 内联（总量 ≤3MB 预算；超出预算走 /api/assets/{id}，仅
 *        有状态部署可达）
 *      - ?stateless=1&noVlm=1：跳过 VLM（关键词分类兜底），保证网关短超时下可完成
 *
 * 解析文本（UniProt/序列/基因/目标语句/配体线索）+ 提取归一化图片（胶图/SEC，含
 * EMF/WMF 转换、大图降采样、VLM 类型识别）。解析结果仍尽力持久化到
 * db/reports/{uploadId}/parsed.json（有状态部署供评估阶段复用；无状态部署写盘
 * 无害但不可达）。
 *
 * 公网加固（防 OOM / 防滥用）：
 *  - 每 IP 24h 上传滑动窗口配额（MAX_UPLOADS_PER_DAY）
 *  - 解析在全局并发信号量内执行（PARSE_CONCURRENCY；等待超限 429）
 *  - 上传目录写入 owner.json（IP 哈希），供 insights / evaluate / assets 归属校验
 */
import { NextResponse } from 'next/server'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { DOCX_MAX_BYTES, parseDocx } from '@/lib/eval/docx'
import { getOwner } from '@/lib/eval/request-guard'
import { checkAndCountUpload, quotaResponse, withParseSlot, QuotaError } from '@/lib/eval/gatekeeper'
import { writeOwnerFile } from '@/lib/eval/upload-owner'
import type { ParsedImage } from '@/lib/eval/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 180

/** 上传目录 TTL（24h）：过期目录在后续上传时后台回收 */
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000

/** v2.3：内联图片（data URI）总预算 — 控制响应体大小（网关对大响应可能截断） */
const INLINE_IMAGES_BUDGET = 3 * 1024 * 1024
/** v2.3：单张内联图片上限（超出者仅在有状态部署经 /api/assets 可见） */
const INLINE_IMAGE_MAX = 1 * 1024 * 1024

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

/** v2.3：把已落盘的图片读回并转 data URI（预算内；失败静默回退 asset 路径） */
async function inlineImages(uploadId: string, images: ParsedImage[]): Promise<ParsedImage[]> {
  let budget = INLINE_IMAGES_BUDGET
  const out: ParsedImage[] = []
  for (const img of images) {
    const bytes = img.sizeKB * 1024
    if (bytes > INLINE_IMAGE_MAX || bytes > budget) {
      out.push(img) // 超预算：保留 asset 引用（有状态部署可达）
      continue
    }
    try {
      const ext = img.mime.includes('png') ? 'png' : img.mime.includes('gif') ? 'gif' : img.mime.includes('webp') ? 'webp' : 'jpg'
      const buf = await fs.readFile(path.join(process.cwd(), 'db', 'reports', uploadId, 'assets', `${img.id}.${ext}`))
      const b64 = buf.toString('base64')
      // base64 膨胀 ~4/3：按实际编码后大小扣预算
      budget -= b64.length
      out.push({ ...img, dataUri: `data:${img.mime};base64,${b64}` })
    } catch {
      out.push(img) // 读回失败（极小竞争窗口）：回退 asset 路径
    }
  }
  return out
}

export async function POST(req: Request) {
  const owner = getOwner(req)
  const url = new URL(req.url)
  // v2.3：无状态回退模式标记（前端回传，仅影响响应形态）+ 跳过 VLM
  const stateless = url.searchParams.get('stateless') === '1'
  const noVlm = stateless || url.searchParams.get('noVlm') === '1'

  // v2.5：Content-Length 预检（读体前拒绝超限 —— multipart 边界开销 ~1KB，阈值留 512B 余量；
  // 防止先整体读入超大请求体再 413 的内存放大）
  const declared = Number(req.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > DOCX_MAX_BYTES + 512) {
    return NextResponse.json({ ok: false, error: `文件过大（上限 20MB）` }, { status: 413 })
  }

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
    const { uploadId, parsed } = await withParseSlot(() => parseDocx(buffer, { noVlm }))
    // 持久化解析结果（评估阶段读取 images/goalHints/fullText）。
    // v2.3：持久化失败不再硬报错 —— 无状态部署写盘可能失败，单请求内结果完整可用；
    // 有状态部署写盘失败时 insights 会 404，前端已回退内联文本路径，同样可用。
    try {
      const parsedPath = path.join(process.cwd(), 'db', 'reports', uploadId, 'parsed.json')
      await fs.writeFile(parsedPath, JSON.stringify(parsed), 'utf-8')
    } catch (e1) {
      try {
        await fs.mkdir(path.join(process.cwd(), 'db', 'reports', uploadId), { recursive: true })
        await fs.writeFile(path.join(process.cwd(), 'db', 'reports', uploadId, 'parsed.json'), JSON.stringify(parsed), 'utf-8')
      } catch { /* 无状态部署：写盘失败不阻塞返回（错误原因见下方 stateless 注记） */ void e1 }
    }
    // 归属标记（insights / evaluate / assets 校验用；失败静默）
    await writeOwnerFile(uploadId, owner)

    // v2.3 响应形态：
    //  - stateless=1（回退模式）：图片内联 + fullText 返回（前端后续内联携带）
    //  - 普通直传：保持旧形态（fullText 剥离、图片走 asset 路径）—— 本地/内网联调语义不变
    if (stateless) {
      const images = await inlineImages(uploadId, parsed.images)
      const { fullText, ...parsedLite } = parsed
      const hint = parsed.uniprotIds.length === 0 && parsed.sequences.length === 0
        ? '提示：未在评估表中识别出 UniProt ID 或蛋白序列，请检查文档内容或改用其他输入方式'
        : undefined
      return NextResponse.json({ ok: true, uploadId, parsed: { ...parsedLite, images }, fullText, stateless: true, error: hint })
    }

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
