/**
 * gateway-sim.mjs — 部署网关行为模拟代理（实测数据复刻）：
 *  - 流式响应（ndjson）：响应头延迟 ~5s 转发（实测 insights/sync 头 5-6s 到达）
 *  - 字节转发窗口：请求开始后 ~24s 起静默丢弃（实测 24-28s，与内容/节奏无关）
 *  - EOF 不达：窗口外上游 end 也不下传（实测服务端 close 的 EOF 不达客户端）
 *  - socket ~91s 强杀（实测 UND_ERR_SOCKET terminated @~91s）
 *  - 普通短 JSON 响应：正常即时转发（实测上传 0.6-2s / status 秒回）
 * 用法：node scripts/gateway-sim.mjs [端口=3100] [上游=http://localhost:3000]
 */
import http from 'node:http'

const PORT = Number(process.argv[2] ?? 3100)
const UP = process.argv[3] ?? 'http://localhost:3000'
const HEADER_DELAY_MS = 5_000      // 流式响应头保持 ~5s（模拟中间层缓冲）
const FORWARD_WINDOW_MS = 24_000   // 字节转发窗口
const SOCKET_KILL_MS = 91_000      // socket 强杀时刻

const server = http.createServer((req, res) => {
  const t0 = Date.now()
  const up = http.request(UP + req.url, {
    method: req.method,
    headers: { ...req.headers, host: new URL(UP).host },
  }, (upRes) => {
    const ct = String(upRes.headers['content-type'] ?? '')
    const isStream = ct.includes('ndjson')
    const killTimer = isStream
      ? setTimeout(() => { try { res.destroy() } catch { /* already dead */ } }, SOCKET_KILL_MS)
      : null
    const deliver = () => {
      res.writeHead(upRes.statusCode, upRes.headers)
      upRes.on('data', (chunk) => {
        if (Date.now() - t0 < FORWARD_WINDOW_MS) {
          res.write(chunk)
        }
        // 窗口外：静默丢弃（实测行为 — 连 EOF 都不达）
      })
      upRes.on('end', () => {
        if (Date.now() - t0 < FORWARD_WINDOW_MS) {
          res.end()
        }
        // 窗口外：不 end — 客户端将挂到 91s 被杀（实测 terminated）
      })
      upRes.on('error', () => { try { res.destroy() } catch { /* noop */ } })
    }
    if (isStream) setTimeout(deliver, HEADER_DELAY_MS)
    else deliver()
    res.on('close', () => { if (killTimer) clearTimeout(killTimer); upRes.destroy?.() })
  })
  up.on('error', () => { try { res.writeHead(502); res.end('{"ok":false,"error":"gateway sim: upstream error"}') } catch { /* noop */ } })
  req.pipe(up)
})

server.listen(PORT, () => console.log(`[gateway-sim] :${PORT} → ${UP} · 头延迟 ${HEADER_DELAY_MS}ms · 转发窗 ${FORWARD_WINDOW_MS}ms · socket 强杀 ${SOCKET_KILL_MS}ms`))
