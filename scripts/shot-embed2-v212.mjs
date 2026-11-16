/** v2.12 内嵌深滚动场景：宿主滚动到报告深处 → 点击卡片 → 报告顶部应带回视口 */
import { chromium } from 'playwright'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
await ctx.route('**://*', route => route.request().url().startsWith('file://') ? route.continue() : route.abort())
await page.goto('file:///tmp/render/host.html', { waitUntil: 'load', timeout: 60000 })
await page.waitForTimeout(800)
await page.evaluate(() => window.scrollTo(0, 2600)) // 宿主滚动到报告深处（iframe 顶部已移出视口）
await page.waitForTimeout(300)
const before = await page.evaluate(() => window.scrollY)
const frame = page.frames().find(f => f.url().includes('render-v2.12'))
await frame.locator('.tgt-card[data-goto="target-B7Z8K6"]').click()
await page.waitForTimeout(600)
const after = await page.evaluate(() => window.scrollY)
console.log('深滚动切换：前', Math.round(before), '→ 后', Math.round(after), '（应显著上移，iframe 顶回到视口）')
await page.screenshot({ path: '/tmp/render/v12-12-embed-deep.png' })
console.log('DONE')
await browser.close()
