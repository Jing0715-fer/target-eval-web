/**
 * POST /api/evaluate/ht-imported-report — v2.69：导入的既有报告原文上传留存。
 *
 * 用户在高通量运行里「导入报告」时，客户端把匹配到的报告 HTML 原文上传一份到
 * 服务端留存（同一源文件只传一次 — 合并报告整组共享）。汇总报告生成时服务端
 * 按 id 读回：
 *  - 统计行整合：旧版报告（无 targeteval:job 标记 / 原作业已超出 DB 保留期）
 *    的评分/结构/结论由客户端解析的统计快照构建（随 ht-dashboard 载荷传递），
 *    原文本身不参与统计 — 但留存后「完整报告」弹出页可内嵌报告原文（与下载
 *    的单独报告一致），不再降级为载入说明页；
 *  - 归属校验：读取时校验 ownerKey（仅上传者可用）。
 *
 * 体积护栏：单份 ≤32MB 字符（与 REPORT_HTML_MAX_BYTES 同口径）；文件落盘
 * db/reports/imports/{id}.html（与作业报告同目录族，随磁盘数据一同回收）。
 */
import { NextResponse } from 'next/server'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { db } from '@/lib/db'
import { getOwner } from '@/lib/eval/request-guard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** 单份导入报告体积上限（字符 — 与 ht-dashboard 的 REPORT_HTML_MAX_BYTES 同口径） */
const MAX_HTML_CHARS = 32_000_000

interface UploadBody {
  fileName?: unknown
  html?: unknown
}

export async function POST(req: Request) {
  const owner = getOwner(req)
  let body: UploadBody
  try {
    body = (await req.json()) as UploadBody
  } catch {
    return NextResponse.json({ ok: false, error: '请求体不是合法 JSON' }, { status: 400 })
  }
  const html = typeof body.html === 'string' ? body.html : ''
  if (!html.trim()) return NextResponse.json({ ok: false, error: '报告内容为空' }, { status: 400 })
  if (html.length > MAX_HTML_CHARS) {
    return NextResponse.json({ ok: false, error: '报告内容超出体积上限（32MB）— 该报告将以载入降级行呈现' }, { status: 413 })
  }
  const fileName = (typeof body.fileName === 'string' ? body.fileName : '')
    .replace(/[\x00-\x1f\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || '导入报告.html'

  const record = await db.importedReport.create({
    data: {
      fileName,
      ownerKey: owner.key,
      ownerMask: owner.mask,
      // 先建行拿 id，再落盘（路径以 id 命名 — 无用户可控路径成分）
      htmlPath: '',
      size: Buffer.byteLength(html, 'utf-8'),
    },
  })
  try {
    const dir = path.join(process.cwd(), 'db', 'reports', 'imports')
    await fs.mkdir(dir, { recursive: true })
    const htmlPath = path.join(dir, `${record.id}.html`)
    await fs.writeFile(htmlPath, html, 'utf-8')
    await db.importedReport.update({ where: { id: record.id }, data: { htmlPath } })
    return NextResponse.json({ ok: true, id: record.id })
  } catch (err) {
    // 落盘失败 → 清掉空行（不留死记录）
    await db.importedReport.delete({ where: { id: record.id } }).catch(() => undefined)
    console.error('[ht-imported-report] 留存失败：', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ ok: false, error: '报告原文留存失败（不影响导入 — 汇总弹出页将降级）' }, { status: 500 })
  }
}
