/**
 * 全局中间件 — 为每个浏览器会话派发稳定的 ownerCookie。
 *
 * 背景：沙箱内 Caddy 反代到 Next.js 时 X-Forwarded-For 被重写为 ::1，
 * 导致 IP-hash 隔离失效（所有公网用户共享同一 ownerKey）。
 * Cookie 隔离不依赖代理头，更可靠地实现"仅自己可见"。
 *
 * 策略：
 *  - 首次访问（无 te_owner cookie）：生成 32 位 hex，写入 httpOnly 长期 cookie
 *  - 同时注入到转发给路由的请求头，确保同一次请求的 API 也能读到
 *  - 已有 cookie：直接放行
 *  - 静态资源 / 资产下载 / iframe 预览：不经过此中间件
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

  // 仅在响应上设置 cookie（不注入请求头）— 保证 curl 等非浏览器客户端
  // 走 IP-hash 回退，能看到旧记录；浏览器首次访问也走 IP-hash，
  // 后续请求带 cookie 后切换到 cookie 隔离
  const res = NextResponse.next()
  res.cookies.set(OWNER_COOKIE_NAME, newOwner, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: MAX_AGE,
    path: '/',
  })
  return res
}

export const config = {
  // 仅排除静态资源；API 与页面都经过中间件以确保 cookie 派发
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
