/** v2.12 同源 HTTP 内嵌（模拟 app 自动高度 iframe）：深滚动切换联动宿主滚动 */
import { chromium } from 'playwright'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
await page.goto('http://localhost:8899/host.html', { waitUntil: 'load', timeout: 60000 })
await page.waitForTimeout(1000)
const setup = await page.evaluate(() => {
  const f = document.getElementById('rpt')
  return { iframeH: f.offsetHeight, hostMax: document.documentElement.scrollHeight - innerHeight }
})
console.log('iframe 高度 =', setup.iframeH, '· 宿主可滚动 =', setup.hostMax)
await page.evaluate(() => window.scrollTo(0, 3000))
await page.waitForTimeout(300)
const before = await page.evaluate(() => window.scrollY)
const frame = page.frames().find(f => f.url().includes('render-v2.12'))
await frame.locator('.tgt-card[data-goto="target-B7Z8K6"]').click()
await page.waitForTimeout(600)
const after = await page.evaluate(() => window.scrollY)
const vis = await frame.locator('#view-target-B7Z8K6').isVisible()
console.log('深滚动切换：前', Math.round(before), '→ 后', Math.round(after), '· 靶点视图可见 =', vis)
// 视口内 iframe 顶部位置
const top = await page.evaluate(() => document.getElementById('rpt').getBoundingClientRect().top)
console.log('切换后 iframe 顶部距视口顶 =', Math.round(top), 'px（应在 0~120 附近）')
await page.screenshot({ path: '/tmp/render/v12-13-embed-http.png' })
console.log('DONE')
await browser.close()
