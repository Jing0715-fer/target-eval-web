/**
 * v2.87：导入报告原文留存写入（共享模块 — 内容寻址）。
 *
 * 抽自 ht-imported-report 上传路由（v2.83 内容寻址逻辑），供两处共用：
 *  - POST /api/evaluate/ht-imported-report：导入时客户端上传（原有链路）；
 *  - POST /api/evaluate/ht-dashboard：**生成时原文直传**（v2.87 新链路 — 客户端
 *    在汇总生成请求里直接携带导入报告原文，服务端在同一请求上下文落库后随
 *    即由生成器读取内嵌）。
 *
 * v2.87 动机（用户实测「上传的报告还是没有嵌入到汇总报告中」跨 v2.69–v2.86
 * 多版复现）：导入时上传链路环节多（导入窗口网络抖动 / 留存表异常 / 归属键在
 * 导入与生成之间漂移 / 服务重启 / DB 重置），任一环节失败都让弹出页静默降级，
 * 且用户侧无感知、无法自愈。直传把「写入」与「读取」收敛到**同一个请求**：
 * 同端点、同 owner、同时刻 — 上述环节全部失效也不影响内嵌（只要汇总生成本身
 * 可达）。客户端仍会优先走导入时上传 + 生成前校验自愈（直传只补缺口 — 内容
 * 寻址去重下重复写入零成本）。
 *
 * 返回 contentSha（服务端口径 sha256 前 32 hex）供调用方做 sha 键校正 —
 * http 环境浏览器 crypto.subtle 不可用时前端用 FNV 兜底哈希，与服务端口径
 * 不一致，校正后 sha 兜底通道在该环境同样可用。
 */
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { db } from '@/lib/db'
import { ensureImportedReportTable } from './imported-report-table'
import { upgradeReportHtml } from './report-upgrade'

export interface ImportOwner {
  key: string
  ipKey: string
  mask: string
}

/** 内容哈希（sha256 UTF-8 前 32 hex — 与前端 ht-import-cache sourceSha 同口径） */
export function contentShaOf(html: string): string {
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

/** fileName 消毒（与上传路由同口径 — 控制字符/路径分隔符折叠为空格，≤120 字符） */
export function sanitizeImportedFileName(raw: string): string {
  return (typeof raw === 'string' ? raw : '')
    .replace(/[\x00-\x1f\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || '导入报告.html'
}

export type StoreImportedReportResult =
  | { ok: true; id: string; contentSha: string; deduped: boolean; upgraded?: boolean }
  | { ok: false; error: string }

/** 留存体积上限（与上传路由同口径 — 升级产物超限时回退存原文，升级是增强不阻塞） */
const MAX_HTML_CHARS = 32_000_000

/** v2.99：旧版留存就地治愈 — 去重命中的既有记录若由旧版生成（缺升级标记），
 *  读盘 → 全量升级（补丁链 + 比对面板回填）→ 原子重写同路径文件（tmp+rename，
 *  并发读取不受半写影响；升级确定性 → 并发写同内容，后写覆盖无副作用）。
 *  size 列同步为落盘实际字节数（best-effort）。任何异常静默降级（文件保持原样）。 */
async function healLegacyRetention(rec: { id: string; htmlPath: string }): Promise<boolean> {
  try {
    const raw = await fs.readFile(rec.htmlPath, 'utf-8')
    const up = await upgradeReportHtml(raw)
    if (!up.changed || up.html.length > MAX_HTML_CHARS) return false
    const tmp = `${rec.htmlPath}.upg`
    await fs.writeFile(tmp, up.html, 'utf-8')
    await fs.rename(tmp, rec.htmlPath)
    await db.importedReport.update({
      where: { id: rec.id },
      data: { size: Buffer.byteLength(up.html, 'utf-8') },
    }).catch(() => undefined)
    console.log(`[imported-report-store] 旧版留存已升级至最新版（${rec.id}${up.panelBackfilled ? ' — 含比对面板回填' : ''}）`)
    return true
  } catch (err) {
    console.error('[imported-report-store] 旧版留存就地治愈失败（降级保留原文件）：', err instanceof Error ? err.message : String(err))
    return false
  }
}

/**
 * 留存一份导入报告原文（内容寻址去重 — 同归属人同内容已有可读留存直接回
 * 既有 id，不重复落盘）。html 为空 / 超限时返回 { ok:false, error }（调用方
 * 降级不阻塞主流程）。
 */
export async function storeImportedReportHtml(
  owner: ImportOwner,
  fileName: string,
  html: string,
): Promise<StoreImportedReportResult> {
  if (typeof html !== 'string' || !html.trim()) return { ok: false, error: '报告内容为空' }
  if (html.length > MAX_HTML_CHARS) return { ok: false, error: `报告内容超出体积上限（32MB — 当前 ${(html.length / 1_000_000).toFixed(1)}MB）` }
  const safeName = sanitizeImportedFileName(fileName)
  try {
    await ensureImportedReportTable()
  } catch (err) {
    return { ok: false, error: `留存表初始化失败：${err instanceof Error ? err.message : String(err)}` }
  }
  const contentSha = contentShaOf(html)
  // 内容寻址去重：同归属人同内容已有可读留存 → 直接回既有 id（幂等 — 直传与
  // 导入时上传/自愈重传重复到达时零成本）。
  // v2.99：命中旧版留存的就地治愈 — 同原文（同 contentSha）重新到达时把落盘
  // 文件升级到最新版（补丁链 + 比对面板回填）；contentSha 锚定原文口径不变，
  // 客户端 sourceSha / sha 自愈通道零感知。
  try {
    const dup = await db.importedReport.findMany({
      where: { contentSha },
      select: { id: true, ownerKey: true, htmlPath: true },
      take: 8,
    })
    for (const rec of dup) {
      if (await recordAlive(rec, owner.key, owner.ipKey)) {
        const upgraded = await healLegacyRetention(rec)
        return { ok: true, id: rec.id, contentSha, deduped: true, ...(upgraded ? { upgraded: true } : {}) }
      }
    }
  } catch (err) {
    console.error('[imported-report-store] 内容去重查询失败（继续走新建）：', err instanceof Error ? err.message : String(err))
  }
  // v2.99：新留存写入前全量升级（旧版报告 → 最新版：补丁链 + 比对面板回填）。
  // 升级异常/产物超限 → 回退存原文（升级是增强，绝不阻塞留存）；升级确定性
  // → 同原文重复到达产物一致，与去重/就地治愈兼容。contentSha 始终锚定原文
  // 口径（客户端 sourceSha / sha 自愈通道零感知）。
  let storeHtml = html
  let upgraded = false
  try {
    const up = await upgradeReportHtml(html)
    if (up.changed && up.html.length <= MAX_HTML_CHARS) {
      storeHtml = up.html
      upgraded = true
    }
  } catch { /* 升级失败存原文 */ }
  let record: { id: string }
  try {
    record = await db.importedReport.create({
      data: {
        fileName: safeName,
        ownerKey: owner.key,
        ownerMask: owner.mask,
        // 先建行拿 id，再落盘（路径以 id 命名 — 无用户可控路径成分）
        htmlPath: '',
        contentSha,
        size: Buffer.byteLength(storeHtml, 'utf-8'),
      },
    })
  } catch (err) {
    return { ok: false, error: `留存记录创建失败：${err instanceof Error ? err.message : String(err)}` }
  }
  try {
    const dir = path.join(process.cwd(), 'db', 'reports', 'imports')
    await fs.mkdir(dir, { recursive: true })
    const htmlPath = path.join(dir, `${record.id}.html`)
    await fs.writeFile(htmlPath, storeHtml, 'utf-8')
    await db.importedReport.update({ where: { id: record.id }, data: { htmlPath } })
    return { ok: true, id: record.id, contentSha, deduped: false, ...(upgraded ? { upgraded: true } : {}) }
  } catch (err) {
    // 落盘失败 → 清掉空行（不留死记录）
    await db.importedReport.delete({ where: { id: record.id } }).catch(() => undefined)
    return { ok: false, error: `报告原文落盘失败：${err instanceof Error ? err.message : String(err)}` }
  }
}
