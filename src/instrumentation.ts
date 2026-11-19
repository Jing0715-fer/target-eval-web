/**
 * Next.js 服务器启动钩子（Node 与 Edge runtime 均会加载本文件）。
 *
 * 按 Next.js 官方约定（https://nextjs.org/docs/app/guides/instrumentation），
 * Node.js 专属逻辑拆分到 `instrumentation-node.ts`，仅在 nodejs runtime
 * 下动态加载 —— Edge 编译器由此可完全跳过 Node 模块图。
 *
 * 作用：沙箱网络环境下，Node undici 的 happy-eyeballs（autoSelectFamily）
 * 默认单地址尝试超时为 250ms — 对部分外网 API（如 openrouter.ai）出站连接
 * 需 >250ms，导致 fetch 抛 AggregateError（ETIMEDOUT/ENETUNREACH）。
 * 将尝试超时提高至 5s，保证所有出站 fetch 的连接鲁棒性。
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./instrumentation-node')
  }
}
