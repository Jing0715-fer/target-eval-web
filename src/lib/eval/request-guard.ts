/**
 * 请求归属与访问控制 — 公网部署的数据隔离层。
 *
 * 设计要点：
 *  - 归属键（ownerKey）优先读取浏览器 cookie（te_owner，由 middleware 派发），
 *    每个浏览器会话拥有独立 ownerKey，实现可靠的"仅自己可见"隔离。
 *  - 无 cookie 时（如 curl 等非浏览器客户端）回退到来源 IP 的 SHA-256（hex 前 24 位）。
 *  - 来源 IP 提取：X-Forwarded-For（首段）→ X-Real-IP → CF-Connecting-IP → 直连兜底
 *  - DB 不落明文 IP，仅落掩码字符串（如 203.0.113.*）用于排障展示；
 *    隔离判定全部基于 ownerKey 相等比较，哈希不可逆推原始 IP。
 *  - 兼容策略：ownerKey 为 null 的历史记录仅能通过列表查看自己名下记录，
 *    详情页因 cuid 不可猜测仍可访问（见各路由）。
 */
import { createHash } from 'node:crypto'
import { db } from '@/lib/db'
import type { EvaluationJob } from '@prisma/client'

/** 直连（无代理头）时的归属组 */
export const DIRECT_GROUP = 'direct'

/** 浏览器会话 cookie 名（与 middleware.ts 保持一致） */
export const OWNER_COOKIE_NAME = 'te_owner'

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
  /** 生效归属键（cookie 优先，否则 IP-hash）— 用于创建记录 */
  key: string
  /** IP-hash 归属键 — 用于列表查询兼容旧记录 */
  ipKey: string
  mask: string
  /** 归属键来源：cookie（浏览器）或 ip（非浏览器回退） */
  source: 'cookie' | 'ip'
}

/** 从 cookie 头解析指定 cookie 值 */
function readCookie(req: Request, name: string): string | null {
  const cookieHeader = req.headers.get('cookie')
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const k = part.slice(0, eq).trim()
    const v = part.slice(eq + 1).trim()
    if (k === name && v.length >= 16) return v
  }
  return null
}

/**
 * 从请求解析归属：优先读取 owner cookie，无 cookie 时回退到 IP-hash。
 * cookie 由 proxy.ts 在首次访问时派发，确保每个浏览器会话独立隔离。
 * ipKey 始终返回 IP-hash，供列表端点兼容查询旧记录。
 */
export function getOwner(req: Request): RequestOwner {
  const ip = getClientIp(req)
  const mask = maskIp(ip)
  const ipKey = ownerKeyOfIp(ip)

  const cookieValue = readCookie(req, OWNER_COOKIE_NAME)
  if (cookieValue) {
    return { ip, key: cookieValue, ipKey, mask, source: 'cookie' }
  }

  // 回退：非浏览器客户端（curl 等），或首次访问 cookie 尚未派发
  return { ip, key: ipKey, ipKey, mask, source: 'ip' }
}

/**
 * 列表查询的 ownerKey 过滤条件：
 *  同时匹配 ① 当前生效键（cookie / IP-hash）② IP-hash 键（旧记录兼容）。
 *  v1.21 修正：不再用 ownerMask 作为隔离条件——公网部署里 Caddy 重写
 *  X-Forwarded-For 为 127.0.0.1，所有公网用户共享同一 ownerMask，把它
 *  当作隔离条件会让任何人的 cookie 都能匹配任何人的记录（历史记录跨
 *  用户泄漏）。ownerMask 仅用于排障展示。 */
export function ownerListFilter(owner: RequestOwner) {
  const keys = [
    { ownerKey: owner.key },
    { ownerKey: owner.ipKey },
    { ownerKey: null }, // 兼容升级前无 ownerKey 的历史记录
  ]
  return { OR: keys }
}

/** 记录归属是否匹配：
 *  cookie 键 / IP-hash 键任一命中即放行；
 *  ownerKey 为 null 视为历史遗留放行。
 *  v1.21：移除 ownerMask 分支——公网部署所有用户共享 mask（Caddy 重写
 *  X-Forwarded-For 为 127.0.0.1），mask 隔离会让任意 cookie 都能匹配任意记录。 */
export function isOwnedBy(job: Pick<EvaluationJob, 'ownerKey' | 'ownerMask'>, owner: RequestOwner): boolean {
  if (!job.ownerKey) return true
  return job.ownerKey === owner.key || job.ownerKey === owner.ipKey
}

/** 404 响应（不暴露资源存在性） */
export function notFound(msg = '作业不存在'): Response {
  return Response.json({ error: msg }, { status: 404 })
}

/** 403 响应（明确拒绝跨 IP 访问，同样不暴露细节） */
export function forbidden(): Response {
  return Response.json({ error: '无权访问该资源（仅创建者可见）' }, { status: 403 })
}
