import { chromium } from 'playwright'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } })
const page = await ctx.newPage()
await page.goto('http://127.0.0.1:3000/', { waitUntil: 'networkidle', timeout: 60000 })
await page.waitForTimeout(2500)
// CDP 原生截图（绕过 Playwright 的动画处理）
const cdp = await ctx.newCDPSession(page)
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
import fs from 'node:fs'
fs.writeFileSync('/tmp/ui-check/cdp-shot.png', Buffer.from(shot.data, 'base64'))
// 同时检查 h1 当时的实际样式
const st = await page.evaluate(() => {
  const h1 = document.querySelector('h1')
  const cs = getComputedStyle(h1)
  const r = h1.getBoundingClientRect()
  return { opacity: cs.opacity, transform: cs.transform, color: cs.color, y: r.y, h: r.height, fonts: document.fonts.status }
})
console.log('h1 状态:', JSON.stringify(st))
await browser.close()
