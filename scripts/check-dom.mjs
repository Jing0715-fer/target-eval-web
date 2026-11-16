/** DOM 渲染状态检查（hydration/动画空白排查） */
import { chromium } from 'playwright'

const run = async () => {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
  const errors = []
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)) })
  page.on('pageerror', e => errors.push('PAGEERROR: ' + String(e).slice(0, 200)))
  await page.goto('http://127.0.0.1:3000/', { waitUntil: 'networkidle', timeout: 60000 })
  await page.waitForTimeout(2000)
  const info = await page.evaluate(() => {
    const main = document.querySelector('main') ?? document.body
    const divs = [...main.querySelectorAll('div')].slice(0, 60).map(d => ({
      opacity: getComputedStyle(d).opacity,
      vis: getComputedStyle(d).visibility,
      text: (d.textContent || '').replace(/\s+/g, ' ').slice(0, 50),
    })).filter(x => x.text.trim())
    return {
      title: document.title,
      h1: document.querySelector('h1')?.textContent,
      bodyText: document.body.innerText.replace(/\s+/g, ' ').slice(0, 400),
      rects: (() => {
        const pick = (sel) => {
          const el = document.querySelector(sel)
          if (!el) return null
          const r = el.getBoundingClientRect()
          return { sel, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
        }
        return [pick('main'), pick('h1'), pick('[role=main]'), pick('form'), pick('textarea'), pick('input')]
      })(),
      scrollH: document.documentElement.scrollHeight,
      innerH: window.innerHeight,
      firstDivs: divs.slice(0, 10),
    }
  })
  console.log(JSON.stringify(info, null, 1))
  console.log('console errors:', errors.slice(0, 6))
  await page.screenshot({ path: '/tmp/ui-check/dom-check-shot.png' })
  await browser.close()
}

run()
