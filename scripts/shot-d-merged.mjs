/**
 * README 截图脚本 D —— 合并报告视图（P69905 + P68871 血红蛋白 α/β 家族）
 * 产物：merged-view.png（1440×1000 裁切） / merged.png（整页长图）
 * 入口：历史面板的合并报告区（BatchReport 行）→ dispatchEvent 派发点击 → Esc 关闭弹窗。
 */
import { chromium } from 'playwright'
import { readFileSync } from 'fs'

const BASE = 'http://localhost:3000'
const OUT = 'docs/screenshots'
const OWNER = '9043a4cce0f74e379c7972549e500b81'
const MERGED_ID = readFileSync('/tmp/heme-merged.txt', 'utf8').trim()
const log = (...a) => console.log('[shotD]', ...a)

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
  // 合并报告区：行内含报告 id 前缀或标题文字
  const row = page.locator('[role="button"][tabindex="0"]', { hasText: /血红蛋白|合并/ }).first()
  await row.waitFor({ state: 'visible', timeout: 30_000 })
  log('找到合并报告行，派发点击…')
  await row.evaluate((el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))

  // ── 等合并视图 ──（v2.10 ③：web 端内嵌完整 HTML 报告 iframe — 与下载同一份文件）
  await page.waitForSelector('text=Merged Evaluation Report', { timeout: 120_000 })
  log('合并视图已出现')
  const frameLoc = page.locator('iframe[title="合并评估报告（与下载 HTML 一致）"]')
  await frameLoc.waitFor({ state: 'attached', timeout: 120_000 })
  const frame = page.frames().find(f => f.url().includes('inline=1'))
  if (frame) {
    await frame.waitForSelector('.rpt-head', { timeout: 120_000 })
    log('内嵌报告 .rpt-head 已就绪')
  }
  // 自动高度同步（ResizeObserver + rAF）稳定
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(1000)
    const box = await frameLoc.first().boundingBox().catch(() => null)
    if (box && box.height > 2500) break
  }

  // 关闭历史弹窗
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1500)
  for (let i = 0; i < 6; i++) {
    if ((await page.locator('[data-state="open"]').count()) === 0) break
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1200)
  }
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.waitForTimeout(800)
  log('弹窗已关闭')

  await page.screenshot({ path: OUT + '/merged-view.png', clip: { x: 0, y: 0, width: 1440, height: 1000 } })
  log('merged-view.png 完成')
  await page.waitForTimeout(800)
  await page.screenshot({ path: OUT + '/merged.png', fullPage: true })
  log('merged.png 完成（fullPage）')

  await browser.close()
}

run().catch((e) => { console.error(e); process.exit(1) })
