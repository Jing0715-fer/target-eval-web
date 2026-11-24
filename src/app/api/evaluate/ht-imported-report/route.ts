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
import { ensureImportedReportTable } from '@/lib/eval/imported-report-table'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** 单份导入报告体积上限（字符 — 与 ht-dashboard 的 REPORT_HTML_MAX_BYTES 同口径） */
const MAX_HTML_CHARS = 32_000_000

/** GET 校验单批 id 数上限（URL 长度护栏 — cuid 25 字符 × 60） */
const VERIFY_IDS_MAX = 60

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

  // v2.70：表自愈（本地部署未 db:push 时自动补建 — 此前直接 P2021 → 500，
  //  上传全失败 → 汇总弹出页全部降级为重建页）
  try {
    await ensureImportedReportTable()
  } catch (err) {
    console.error('[ht-imported-report] 表自愈失败：', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ ok: false, error: '报告留存表初始化失败（不影响导入 — 汇总弹出页将降级）' }, { status: 500 })
  }

  let record: { id: string }
  try {
    record = await db.importedReport.create({
      data: {
        fileName,
        ownerKey: owner.key,
        ownerMask: owner.mask,
        // 先建行拿 id，再落盘（路径以 id 命名 — 无用户可控路径成分）
        htmlPath: '',
        size: Buffer.byteLength(html, 'utf-8'),
      },
    })
  } catch (err) {
    console.error('[ht-imported-report] 留存记录创建失败：', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ ok: false, error: '报告留存记录创建失败（不影响导入 — 汇总弹出页将降级）' }, { status: 500 })
  }
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

/**
 * GET /api/evaluate/ht-imported-report?ids=a,b,c — v2.81：批量校验导入报告的
 * 服务端留存是否仍可读（记录在 + 归属匹配 + 落盘文件存在）。
 *
 * 汇总报告生成前前端调用（ensureImportedRetention）：missing 的 id 由前端凭
 * 本地留存（内容哈希键）重新上传自愈 — 弹出页原文内嵌不再取决于导入那一
 * 瞬间的上传成败，也不再受 DB 重置/实例回收影响。
 */
export async function GET(req: Request) {
  const owner = getOwner(req)
  const url = new URL(req.url)
  const idsParam = url.searchParams.get('ids')?.trim()
  if (!idsParam) {
    return NextResponse.json({ ok: false, error: '缺少 ids 参数' }, { status: 400 })
  }
  const ids = [...new Set(idsParam.split(',').map(s => s.trim()).filter(Boolean))].slice(0, VERIFY_IDS_MAX)
  if (ids.length === 0) {
    return NextResponse.json({ ok: false, error: 'ids 参数为空' }, { status: 400 })
  }
  try {
    await ensureImportedReportTable()
  } catch (err) {
    console.error('[ht-imported-report] 表自愈失败（校验）:', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ ok: false, error: '报告留存表初始化失败' }, { status: 500 })
  }
  let recs: Array<{ id: string; ownerKey: string | null; htmlPath: string }> = []
  try {
    recs = await db.importedReport.findMany({
      where: { id: { in: ids } },
      select: { id: true, ownerKey: true, htmlPath: true },
    })
  } catch (err) {
    console.error('[ht-imported-report] 留存校验读取失败：', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ ok: false, error: '留存记录读取失败' }, { status: 500 })
  }
  const recById = new Map(recs.map(r => [r.id, r]))
  const missing: string[] = []
  await Promise.all(ids.map(async id => {
    const rec = recById.get(id)
    // 缺判定：无记录 / 他人留存 / 无路径 / 文件不在（DB 有行但磁盘丢失 — v2.80
    // 前的老留存常见；统一交前端自愈重传）
    if (!rec || !rec.htmlPath) { missing.push(id); return }
    if (rec.ownerKey && rec.ownerKey !== owner.key && rec.ownerKey !== owner.ipKey) { missing.push(id); return }
    try {
      await fs.access(rec.htmlPath)
    } catch {
      missing.push(id)
    }
  }))
  return NextResponse.json({ ok: true, missing })
}
