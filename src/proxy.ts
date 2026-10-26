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
 *  - 原方案按请求协议自适应：https（公网预览）用 SameSite=None + Secure，
 *    http（本地开发）保持 Lax。
 *
 * v1.18 修复"分块上传失败（signal is aborted / 已重试 3 次）"：
 *  - 实测公网预览 https://*.space-z.ai 上 cookie 仍为 SameSite=Lax：
 *    Z.ai 边缘网关 ALB → Caddy(81) → localhost:3000 链路里，ALB 到 Caddy
 *    走 HTTP，Caddy 用 {scheme}=http 重写 X-Forwarded-Proto，使应用把
 *    公网 https 请求识别成 http，落入 lax 分支。结果：浏览器在跨站 iframe
 *    里不回送 cookie → init 创建会话 ownerKey=A，chunk 请求拿到的是
 *    IP-hash ownerKey=B → appendChunk 校验 s.ownerKey !== owner.key 返回
 *    403「无权访问该上传会话」；若浏览器先卡在第三方 cookie 阻断阶段，
 *    则表现为前端 28s AbortController 超时（"signal is aborted without reason"）。
 *  - 新策略：只要处于反代之后（存在任一代理头 X-Forwarded-Proto /
 *    X-Forwarded-For / X-Real-IP），一律 SameSite=None + Secure —— 这是
 *    唯一能在跨站 iframe 中可靠发送的配置；Caddy→3000 内部链路虽是
 *    http，但最终面向用户的是 https，Secure 标志正确。
 *  - 本机直连（无任何代理头）：保持 Lax，方便 curl / 本地浏览器调试。
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

  // 是否处于反向代理之后（公网预览 / 网关场景）。
  // Z.ai 边缘网关 ALB → Caddy(81) → localhost:3000 链路里，请求至少会带
  // X-Forwarded-For 或 X-Real-IP（Caddy 已配置 header_up）。
  const behindProxy =
    !!req.headers.get('x-forwarded-proto') ||
    !!req.headers.get('x-forwarded-for') ||
    !!req.headers.get('x-real-ip')
  // 公网（含跨站 iframe）：SameSite=None + Secure 才能在 iframe 中可靠发送；
  // 本机直连（curl / 本地浏览器）：保持 Lax。
  const isPublic = behindProxy

  const res = NextResponse.next()
  res.cookies.set(OWNER_COOKIE_NAME, newOwner, {
    httpOnly: true,
    sameSite: isPublic ? 'none' : 'lax',
    secure: isPublic,
    maxAge: MAX_AGE,
    path: '/',
  })
  return res
}

export const config = {
  // 仅排除静态资源；API 与页面都经过中间件以确保 cookie 派发
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
