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
 *
 * v2.83（用户实测「117 份导入报告原文全部未能内嵌弹出页」根因之一 — 重复留存
 * 与链接脆断）：**内容寻址留存** — POST 计算 html 内容哈希（contentSha，sha256
 * UTF-8 前 32 hex，与前端 ht-import-cache 的 sourceSha 同口径）；同一归属人同
 * 内容已有可读留存时直接回既有 id（不再重复落盘 — 重新导入/自愈重传秒回）。
 * 生成侧（ht-dashboard）在 reportId 死亡/丢失时按 contentSha 兜底找回同内容
 * 留存 → 弹出页原文内嵌不再依赖「导入那一瞬间拿到的 reportId 恰好还活着」。
 */
import { NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { db } from '@/lib/db'
import { getOwner } from '@/lib/eval/request-guard'
import { ensureImportedReportTable } from '@/lib/eval/imported-report-table'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** 单份导入报告体积上限（字符 — 与 ht-dashboard 的 REPORT_HTML_MAX_BYTES 同口径） */
const MAX_HTML_CHARS = 32_000_000

/** GET 校验单批 id/sha 数上限（URL 长度护栏 — cuid 25 字符 / sha 32 hex × 60） */
const VERIFY_KEYS_MAX = 60

interface UploadBody {
  fileName?: unknown
  html?: unknown
}

/** 内容哈希（sha256 UTF-8 前 32 hex — 与前端 ht-import-cache sourceSha 同口径） */
function contentShaOf(html: string): string {
  return createHash('sha256').update(html, 'utf-8').digest('hex').slice(0, 32)
}

/** 记录是否本人可读（归属匹配 + 落盘文件存在 — 供去重/校验共用） */
async function recordAlive(rec: { ownerKey: string | null; htmlPath: string }, ownerKey: string, ipKey: string): Promise<boolean> {
  if (rec.ownerKey && rec.ownerKey !== ownerKey && rec.ownerKey !== ipKey) return false
  if (!rec.htmlPath) return false
  try {
    await fs.access(rec.htmlPath)
    return true
  } catch {
    return false
  }
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

  // v2.83：内容寻址去重 — 同归属人同内容已有可读留存 → 直接回既有 id
  // （重新导入 117 份不再重复上传落盘 128MB；自愈重传同理秒回）
  const contentSha = contentShaOf(html)
  try {
    const dup = await db.importedReport.findMany({
      where: { contentSha },
      select: { id: true, ownerKey: true, htmlPath: true },
      take: 8,
    })
    for (const rec of dup) {
      if (await recordAlive(rec, owner.key, owner.ipKey)) {
        return NextResponse.json({ ok: true, id: rec.id, deduped: true })
      }
    }
  } catch (err) {
    console.error('[ht-imported-report] 内容去重查询失败（继续走新建）：', err instanceof Error ? err.message : String(err))
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
        contentSha,
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
 * GET /api/evaluate/ht-imported-report — 批量校验导入报告的服务端留存。
 *
 * 两种形态（v2.81 ids= / v2.83 shas=）：
 *  - ?ids=a,b,c：逐 id 校验（记录在 + 归属匹配 + 落盘文件存在）→ { missing }
 *  - ?shas=a,b,c：逐内容哈希校验 → { retained: {sha: id}, missing } — 同内容
 *    已有任何可读留存即回 id（客户端可直接采纳，无需重传）。
 *
 * 汇总报告生成前前端调用（ensureImportedRetention）：missing 的项由前端凭
 * 本地留存（内容哈希键）重新上传自愈 — 弹出页原文内嵌不再取决于导入那一
 * 瞬间的上传成败，也不再受 DB 重置/实例回收影响。
 */
export async function GET(req: Request) {
  const owner = getOwner(req)
  const url = new URL(req.url)
  const idsParam = url.searchParams.get('ids')?.trim()
  const shasParam = url.searchParams.get('shas')?.trim()
  if (!idsParam && !shasParam) {
    return NextResponse.json({ ok: false, error: '缺少 ids/shas 参数' }, { status: 400 })
  }
  try {
    await ensureImportedReportTable()
  } catch (err) {
    console.error('[ht-imported-report] 表自愈失败（校验）:', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ ok: false, error: '报告留存表初始化失败' }, { status: 500 })
  }

  // ── shas= 形态：内容寻址校验（v2.83）──
  if (shasParam) {
    const shas = [...new Set(shasParam.split(',').map(s => s.trim()).filter(s => /^[a-z0-9]{6,64}$/i.test(s)))].slice(0, VERIFY_KEYS_MAX)
    if (shas.length === 0) {
      return NextResponse.json({ ok: false, error: 'shas 参数为空' }, { status: 400 })
    }
    let recs: Array<{ id: string; ownerKey: string | null; htmlPath: string; contentSha: string | null }> = []
    try {
      recs = await db.importedReport.findMany({
        where: { contentSha: { in: shas } },
        select: { id: true, ownerKey: true, htmlPath: true, contentSha: true },
      })
    } catch (err) {
      console.error('[ht-imported-report] 留存校验读取失败（shas）:', err instanceof Error ? err.message : String(err))
      return NextResponse.json({ ok: false, error: '留存记录读取失败' }, { status: 500 })
    }
    const retained: Record<string, string> = {}
    const aliveIds = new Set<string>()
    for (const rec of recs) {
      if (!rec.contentSha) continue
      if (aliveIds.has(rec.id)) continue
      if (await recordAlive(rec, owner.key, owner.ipKey)) {
        // 同 sha 多条（历史重复上传）取最新一条即可 — 遍历序不保证，后者覆盖前者
        retained[rec.contentSha] = rec.id
        aliveIds.add(rec.id)
      }
    }
    const missing = shas.filter(s => !retained[s])
    return NextResponse.json({ ok: true, retained, missing })
  }

  // ── ids= 形态（v2.81 原行为）──
  const ids = [...new Set(idsParam!.split(',').map(s => s.trim()).filter(Boolean))].slice(0, VERIFY_KEYS_MAX)
  if (ids.length === 0) {
    return NextResponse.json({ ok: false, error: 'ids 参数为空' }, { status: 400 })
  }
  let recs: Array<{ id: string; ownerKey: string | null; htmlPath: string }> = []
  try {
    recs = await db.importedReport.findMany({
      where: { id: { in: ids } },
      select: { id: true, ownerKey: true, htmlPath: true },
    })
  } catch (err) {
    console.error('[ht-imported-report] 留存校验读取失败（ids）:', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ ok: false, error: '留存记录读取失败' }, { status: 500 })
  }
  const recById = new Map(recs.map(r => [r.id, r]))
  const missing: string[] = []
  await Promise.all(ids.map(async id => {
    const rec = recById.get(id)
    // 缺判定：无记录 / 他人留存 / 无路径 / 文件不在（DB 有行但磁盘丢失 — v2.80
    // 前的老留存常见；统一交前端自愈重传）
    if (!rec) { missing.push(id); return }
    if (!(await recordAlive(rec, owner.key, owner.ipKey))) { missing.push(id); return }
  }))
  return NextResponse.json({ ok: true, missing })
}
