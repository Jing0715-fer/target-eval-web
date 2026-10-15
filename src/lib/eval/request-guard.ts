/**
 * 请求归属与访问控制 — 公网部署的数据隔离层。
 *
 * 设计要点：
 *  - 来源 IP 提取：X-Forwarded-For（首段）→ X-Real-IP → CF-Connecting-IP → 直连兜底
 *  - 归属键（ownerKey）：来源 IP 的 SHA-256（hex，前 24 位）。
 *    DB 不落明文 IP，仅落掩码字符串（如 203.0.113.*）用于排障展示；
 *    隔离判定全部基于 ownerKey 相等比较，哈希不可逆推原始 IP。
 *  - 无代理头直连（本地开发）时所有请求同属 'direct' 组 —— 公网部署务必置于
 *    反向代理之后并传递 X-Forwarded-For（README 部署章节）。
 *  - 兼容策略：ownerKey 为 null 的历史记录（升级前创建）仅能通过列表查看
 *    自己名下记录，详情页因 cuid 不可猜测仍可访问（见各路由）。
 */
import { createHash } from 'node:crypto'
import { db } from '@/lib/db'
import type { EvaluationJob } from '@prisma/client'

/** 直连（无代理头）时的归属组 */
export const DIRECT_GROUP = 'direct'

/** 从请求头解析来源 IP（可信代理链：网关已重写 X-Forwarded-For 为真实远端） */
export function getClientIp(req: Request): string {
  const h = req.headers
  const xff = h.get('x-forwarded-for')
  if (xff) {
    const first = xff.split(',')[0].trim()
    if (first) return normalizeIp(first)
  }
  const real = h.get('x-real-ip')?.trim()
  if (real) return normalizeIp(real)
  const cf = h.get('cf-connecting-ip')?.trim()
  if (cf) return normalizeIp(cf)
  return DIRECT_GROUP
}

function normalizeIp(ip: string): string {
  // IPv6 映射的 IPv4（::ffff:1.2.3.4）→ 1.2.3.4；去端口（1.2.3.4:5678）
  let s = ip.trim().toLowerCase()
  if (s.startsWith('::ffff:') && s.includes('.')) s = s.slice(7)
  const colon = s.indexOf(':')
  const bracket = s.indexOf(']')
  // 方括号 IPv6 [::1]:8080 或裸 IPv6（含多个冒号则视为地址本体，不按端口截断）
  if (bracket >= 0) s = s.slice(1, bracket)
  else if (colon >= 0 && s.indexOf(':', colon + 1) >= 0) {
    if (s === '::1') s = '127.0.0.1'
  } else if (colon >= 0) {
    s = s.slice(0, colon)
  }
  return s || DIRECT_GROUP
}

/** 来源 IP → 归属键（SHA-256 前 24 位 hex） */
export function ownerKeyOfIp(ip: string): string {
  return createHash('sha256').update(`target-eval:v1:${ip}`).digest('hex').slice(0, 24)
}

/** 来源 IP → 掩码展示串（IPv4 保前 3 段；IPv6/其它保前 2 组） */
export function maskIp(ip: string): string {
  if (ip === DIRECT_GROUP) return '本机直连'
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    const parts = ip.split('.')
    return `${parts[0]}.${parts[1]}.${parts[2]}.*`
  }
  const groups = ip.split(':')
  return `${groups.slice(0, 2).join(':')}::…`
}

export interface RequestOwner {
  ip: string
  key: string
  mask: string
}

/** 从请求解析归属（IP + 哈希键 + 掩码） */
export function getOwner(req: Request): RequestOwner {
  const ip = getClientIp(req)
  return { ip, key: ownerKeyOfIp(ip), mask: maskIp(ip) }
}

/** 记录归属是否匹配（null 视为历史遗留：放行详情访问，列表仍按本人过滤） */
export function isOwnedBy(job: Pick<EvaluationJob, 'ownerKey'>, owner: RequestOwner): boolean {
  return !job.ownerKey || job.ownerKey === owner.key
}

/** 404 响应（不暴露资源存在性） */
export function notFound(msg = '作业不存在'): Response {
  return Response.json({ error: msg }, { status: 404 })
}

/** 403 响应（明确拒绝跨 IP 访问，同样不暴露细节） */
export function forbidden(): Response {
  return Response.json({ error: '无权访问该资源（仅创建者可见）' }, { status: 403 })
}
