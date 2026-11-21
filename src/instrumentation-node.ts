/**
 * Node.js runtime 专属的服务器初始化（由 instrumentation.ts 守卫加载，
 * Edge runtime 永远不会执行本模块）。
 *
 * 详见 instrumentation.ts 顶部的背景说明。
 */
import net from 'node:net'

if (typeof net.setDefaultAutoSelectFamilyAttemptTimeout === 'function') {
  net.setDefaultAutoSelectFamilyAttemptTimeout(5000)
}

export {}
