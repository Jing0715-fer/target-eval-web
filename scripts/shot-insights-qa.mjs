import { chromium } from 'playwright'
import { readFileSync, writeFileSync, existsSync } from 'fs'

// 自包含前置：从 test-qa-render.ts 的产物 /tmp/render-qa.html 抽取 insights 章节（含原 CSS 头）
if (!existsSync('/tmp/insights-only.html') && existsSync('/tmp/render-qa.html')) {
  const html = readFileSync('/tmp/render-qa.html', 'utf-8')
  const i = html.indexOf('<section class="sec" id="insights"')
  const j = html.indexOf('</section>', i) + '</section>'.length
  const head = html.slice(0, html.indexOf('</style>') + 8)
  writeFileSync('/tmp/insights-only.html',
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>insights</title>' + head
    + '</head><body><div class="page" style="max-width:920px;margin:0 auto">' + html.slice(i, j) + '</div></body></html>')
}
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 980, height: 900 } })
await page.goto('file:///tmp/insights-only.html')
await page.waitForTimeout(500)
const report = await page.evaluate(() => {
  const out = []
  document.querySelectorAll('#insights .qa-ans').forEach((el, i) => {
    const r = el.getBoundingClientRect()
    const li = el.closest('li')
    const cs = getComputedStyle(el)
    const text = el.textContent.replace(/\s+/g, ' ').slice(0, 28)
    out.push({
      i: i + 1,
      w: Math.round(r.width), h: Math.round(r.height),
      inLi: !!li, liParentText: li ? li.textContent.replace(/\s+/g, ' ').slice(0, 12) : '',
      bg: cs.backgroundColor, borderLeft: cs.borderLeftWidth + ' ' + cs.borderLeftColor,
      overflowX: el.scrollWidth > el.clientWidth,
      fontSize: cs.fontSize, text,
    })
  })
  // 页面无横向溢出
  const doc = document.documentElement
  return { qa: out, pageOverflowX: doc.scrollWidth > doc.clientWidth, pageW: doc.scrollWidth }
})
console.log(JSON.stringify(report, null, 1))
await browser.close()
