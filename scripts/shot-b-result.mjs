/**
 * README 截图脚本 B（v2）—— EGFR 结果视图（内嵌报告 iframe 形态）
 * 产物：result-top.png（1440×1000 裁切） / result.png（整页长图）
 * 要点：历史行为 Radix Dialog（遮罩拦截真实点击）→ dispatchEvent 派发；
 *       结果视图主体为同源 iframe（title=评估报告…），自动高度由 ResizeObserver 同步，
 *       等待 iframe 内 .page 元素与高度稳定后再截图。
 */
import { chromium } from 'playwright'
import { readFileSync } from 'fs'

const BASE = 'http://localhost:3000'
const OUT = 'docs/screenshots'
const OWNER = '9043a4cce0f74e379c7972549e500b81'
const log = (...a) => console.log('[shotB]', ...a)

const run = async () => {
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 })
  await ctx.addCookies([{ name: 'te_owner', value: OWNER, url: BASE }])
  const page = await ctx.newPage()
  page.setDefaultTimeout(180_000)

  log('打开首页…')
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('textarea[aria-label="UniProt ID 输入"]', { state: 'visible' })

  await page.getByRole('button', { name: '历史评估', exact: true }).click()
  await page.waitForTimeout(1500)
  const row = page.locator('[role="button"][tabindex="0"]', { hasText: 'P00533' }).first()
  await row.waitFor({ state: 'visible', timeout: 30_000 })
  await row.evaluate((el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
  log('已派发历史行点击')

  // ── 等待内嵌报告 iframe ──
  const iframe = page.frameLocator('iframe[title="评估报告（与下载 HTML 一致）"]')
  await page.waitForSelector('iframe[title="评估报告（与下载 HTML 一致）"]', { state: 'visible', timeout: 120_000 })
  await iframe.locator('.page').first().waitFor({ state: 'visible', timeout: 120_000 })
  log('报告 iframe 已渲染')

  // ── 关闭历史弹窗（dispatchEvent 不会触发 Radix 关闭链）──
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1500)
  for (let i = 0; i < 6; i++) {
    const open = await page.locator('[data-state="open"]').count()
    if (open === 0) break
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1200)
  }
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.waitForTimeout(800)
  log('历史弹窗已关闭')

  // ── 等高度稳定（ResizeObserver 同步 + 字体/图片就绪）──
  let lastH = -1, stable = 0
  for (let i = 0; i < 40 && stable < 3; i++) {
    await page.waitForTimeout(1500)
    const h = await page.evaluate(() => {
      const f = document.querySelector('iframe[title="评估报告（与下载 HTML 一致）"]')
      return f ? f.getBoundingClientRect().height : -1
    })
    if (Math.abs(h - lastH) < 5) stable++; else stable = 0
    lastH = h
  }
  log('iframe 高度稳定于', Math.round(lastH), 'px')

  await page.screenshot({ path: OUT + '/result-top.png', clip: { x: 0, y: 0, width: 1440, height: 1000 } })
  log('result-top.png 完成')
  await page.waitForTimeout(800)
  await page.screenshot({ path: OUT + '/result.png', fullPage: true })
  log('result.png 完成（fullPage）')

  await browser.close()
}

run().catch((e) => { console.error(e); process.exit(1) })
