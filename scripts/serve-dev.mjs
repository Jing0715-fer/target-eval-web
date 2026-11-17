/**
 * 常驻 dev server 启动器（detached + unref — 脱离工具调用进程树，跨调用存活）。
 * 幂等：已在 3000 端口监听则直接退出。用法：node scripts/serve-dev.mjs
 */
import { spawn } from 'node:child_process'
import net from 'node:net'

const PORT = 3000
const ROOT = new URL('..', import.meta.url).pathname

const inUse = await new Promise(resolve => {
  const s = net.connect(PORT, '127.0.0.1')
  s.on('connect', () => { s.destroy(); resolve(true) })
  s.on('error', () => resolve(false))
})
if (inUse) {
  console.log(`port ${PORT} 已监听 — dev server 无需重启`)
  process.exit(0)
}

const out = spawn('tee', [`${ROOT}dev.log`], { stdio: ['pipe', 'inherit', 'inherit'] })
const p = spawn('npm', ['run', 'dev'], {
  cwd: ROOT,
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe'],
})
p.stdout.pipe(out.stdin)
p.stderr.pipe(out.stdin)
p.unref()
out.unref()
console.log(`dev server 已守护启动（npm pid ${p.pid}）— 端口 ${PORT}`)
