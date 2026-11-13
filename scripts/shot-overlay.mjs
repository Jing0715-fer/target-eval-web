import { chromium } from 'playwright'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } })
const page = await ctx.newPage()
await page.goto('http://127.0.0.1:3000/', { waitUntil: 'networkidle', timeout: 60000 })
await page.waitForTimeout(2500)
const stack = await page.evaluate(() => {
  const els = document.elementsFromPoint(960, 500)
  return els.slice(0, 12).map((el, i) => {
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    return {
      i, tag: el.tagName, cls: String(el.className).slice(0, 60),
      bg: cs.backgroundColor, bgImg: cs.backgroundImage.slice(0, 60),
      opacity: cs.opacity, z: cs.zIndex, pos: cs.position,
      w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.y),
    }
  })
})
console.log(JSON.stringify(stack, null, 1))
await browser.close()
