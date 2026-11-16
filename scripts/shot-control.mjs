import { chromium } from 'playwright'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
// 对照 1：数据 URL 简单页面
await page.setContent('<html><body style="background:#304050"><h1 style="color:white">CONTROL TEST</h1></body></html>')
await page.screenshot({ path: '/tmp/ui-check/control-dataurl.png' })
// 对照 2：本站页面
await page.goto('http://127.0.0.1:3000/', { waitUntil: 'networkidle', timeout: 60000 })
await page.waitForTimeout(2000)
await page.screenshot({ path: '/tmp/ui-check/control-app.png' })
await browser.close()
console.log('done')
