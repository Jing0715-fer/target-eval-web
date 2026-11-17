import { chromium } from 'playwright'
const JOB = 'cmwf1jgy60000qxf7ijh5xa2o'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await ctx.route('**://fonts.googleapis.com/**', r => r.abort())
await ctx.route('**://fonts.gstatic.com/**', r => r.abort())
await ctx.route('**://3Dmol.org/**', r => r.abort())
const page = await ctx.newPage()
await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(800)
await page.click('[aria-label="历史评估"]')
await page.waitForTimeout(800)
const item = page.locator('[data-slot="dialog-content"]').getByText('F-box only protein 21').first()
await item.waitFor({ state: 'visible', timeout: 15000 })
await item.click()
await page.waitForTimeout(2500)
await page.locator('button:has-text("全屏预览")').first().scrollIntoViewIfNeeded()
await page.locator('button:has-text("全屏预览")').first().click()
await page.waitForTimeout(2000)
const probe = await page.evaluate(() => {
  const iframes = Array.from(document.querySelectorAll('iframe'))
  return iframes.map(f => {
    const chain = []
    let el = f.parentElement
    for (let i = 0; i < 4 && el; i++) {
      const cs = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      chain.push({ tag: el.tagName, cls: (el.className || '').toString().slice(0, 80), h: Math.round(r.height), pos: cs.position, overflow: cs.overflow, display: cs.display, minH: cs.minHeight, hCss: cs.height })
      el = el.parentElement
    }
    const fr = f.getBoundingClientRect()
    return { title: f.title, src: f.getAttribute('src'), h: Math.round(fr.height), w: Math.round(fr.width), styleH: f.style.height, cls: f.className, chain }
  })
})
console.log(JSON.stringify(probe, null, 1))
await browser.close()
