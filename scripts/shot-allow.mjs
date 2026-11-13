import { chromium } from 'playwright'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } })
const page = await ctx.newPage()
await page.goto('http://127.0.0.1:3000/', { waitUntil: 'networkidle', timeout: 60000 })
await page.waitForTimeout(2500)
await page.screenshot({ path: '/tmp/ui-check/allow-shot.png', animations: 'allow' })
await browser.close()
console.log('done')
