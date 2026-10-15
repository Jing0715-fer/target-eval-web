/**
 * Next.js 服务器启动钩子（Node runtime 仅一次）。
 *
 * 沙箱网络环境下，Node undici 的 happy-eyeballs（autoSelectFamily）默认
 * 单地址尝试超时为 250ms — 对部分外网 API（如 openrouter.ai）出站连接
 * 需 >250ms，导致 fetch 抛 AggregateError（ETIMEDOUT/ENETUNREACH）。
 * 将尝试超时提高至 5s，保证所有出站 fetch 的连接鲁棒性。
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const net = await import('node:net')
  if (typeof net.setDefaultAutoSelectFamilyAttemptTimeout === 'function') {
    net.setDefaultAutoSelectFamilyAttemptTimeout(5000)
  }
}
