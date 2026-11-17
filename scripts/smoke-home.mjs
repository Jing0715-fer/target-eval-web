/**
 * v2.20.1 页面冒烟：首页真实浏览器加载 — console 零报错 + 关键 UI 元素在位。
 * 运行前置：dev server 已在 127.0.0.1:3000 常驻。node scripts/smoke-home.mjs
 */
import { chromium } from 'playwright'

const errors = []
const pageErrors = []
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
page.on('console', m => {
  if (m.type() === 'error' && !/_next\/hmr|WebSocket/i.test(m.text())) errors.push(m.text().slice(0, 200))
})
page.on('pageerror', e => pageErrors.push(String(e).slice(0, 200)))

await page.goto('http://127.0.0.1:3000/', { waitUntil: 'domcontentloaded', timeout: 30000 })
await page.waitForTimeout(2500)

const bodyText = await page.evaluate(() => document.body.innerText)
const checks = [
  ['首页可见「靶点」相关内容', /靶点/.test(bodyText)],
  ['无 console 错误', errors.length === 0],
  ['无未捕获异常', pageErrors.length === 0],
  ['主内容渲染（非空白页）', bodyText.length > 200],
]

let fail = 0
for (const [name, okk] of checks) {
  console.log(`${okk ? '✓' : '✗'} ${name}`)
  if (!okk) fail++
}
if (errors.length) console.log('  console errors:', JSON.stringify(errors.slice(0, 5)))
if (pageErrors.length) console.log('  page errors:', JSON.stringify(pageErrors.slice(0, 5)))

await browser.close()
console.log(fail === 0 ? '\n冒烟通过（console 零错误）' : `\n冒烟失败（${fail} 项）`)
process.exit(fail === 0 ? 0 : 1)
