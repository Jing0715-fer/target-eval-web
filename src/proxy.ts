/**
 * 全局中间件 — 为每个浏览器会话派发稳定的 ownerCookie。
 *
 * 背景：沙箱内 Caddy 反代到 Next.js 时 X-Forwarded-For 被重写为 ::1，
 * 导致纯 IP-hash 隔离失效（所有公网用户共享同一 ownerKey）。
 * Cookie 隔离不依赖代理头，更可靠地实现"仅自己可见"；
 * 无 cookie 时（curl / iframe 受限）回退 IP-hash（见 request-guard.ts）。
 *
 * v1.17 修复"刷新后历史记录丢失"：
 *  - Z.ai 预览面板以跨站 iframe 嵌入应用，SameSite=Lax 的 cookie 在跨站
 *    iframe 中不会被浏览器发送 → 每次刷新都被当作新访客。
 *  - 现按请求协议自适应：https（公网预览）用 SameSite=None + Secure
 *    （跨站 iframe 可发送），http（本地开发）保持 Lax。
 *
 * 策略：
 *  - 首次访问（无 te_owner cookie）：生成 32 位 hex，写入 httpOnly 长期 cookie（1 年）
 *  - 仅在响应上设置 cookie（不注入请求头）— curl 等非浏览器客户端走
 *    IP-hash 回退，同 IP 的旧记录依然可见（"按 IP 智能显示"）
 *  - 已有 cookie：直接放行
 */
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export const OWNER_COOKIE_NAME = 'te_owner'
const MAX_AGE = 60 * 60 * 24 * 365 // 1 年

export function proxy(req: NextRequest) {
  const existing = req.cookies.get(OWNER_COOKIE_NAME)?.value
  if (existing && existing.length >= 16) {
    return NextResponse.next()
  }

  // 生成新的 owner 标识（crypto.randomUUID 在 Edge Runtime 可用）
  const newOwner = (crypto.randomUUID().replace(/-/g, '') +
    crypto.randomUUID().replace(/-/g, '')).slice(0, 32)

  // 判断协议：优先代理头（网关 https → 内部 http），其次请求 URL
  const proto =
    req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() ||
    req.nextUrl.protocol.replace(':', '')
  const isHttps = proto === 'https'

  const res = NextResponse.next()
  res.cookies.set(OWNER_COOKIE_NAME, newOwner, {
    httpOnly: true,
    // https（公网预览，含跨站 iframe）：SameSite=None + Secure 才能在 iframe 中发送；
    // http（本地开发）：Lax
    sameSite: isHttps ? 'none' : 'lax',
    secure: isHttps,
    maxAge: MAX_AGE,
    path: '/',
  })
  return res
}

export const config = {
  // 仅排除静态资源；API 与页面都经过中间件以确保 cookie 派发
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
