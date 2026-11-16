/**
 * scripts/shot-merged-embed.mjs — v2.10 ③ 冒烟测试
 * 真实浏览器（Playwright）走 历史记录 → 合并报告 → BTN-TCR 条目 → 合并报告视图：
 * 断言 web 内嵌完整 HTML 报告 iframe（与下载同一份文件），旧 React 数据区块降级隐藏。
 */
import { chromium } from 'playwright'

const OWNER = 'af74a0c83a684442940af04a85764981'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
await ctx.addCookies([{ name: 'te_owner', value: OWNER, url: 'http://localhost:3000' }])
const page = await ctx.newPage()

await page.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1200)

// 1. 打开历史对话框（底部「查看全部历史评估」按钮）
await page.getByRole('button', { name: /查看全部历史评估/ }).first().click()
await page.waitForTimeout(1500)

// 2/3. 直接点击对话框内的 BTN-TCR 合并报告行（div[role=button]）
const dlg = page.locator('[data-slot="dialog-content"]')
await dlg.waitFor({ state: 'visible', timeout: 15_000 })
const row = dlg.locator('div[role="button"]', { hasText: 'BTN-TCR' }).first()
await row.waitFor({ state: 'visible', timeout: 15_000 })
await row.click()
await page.waitForTimeout(3000)

// 4. 断言：合并报告视图刊头 + 内嵌 iframe
const headOk = await page.getByRole('heading', { name: /BTN-TCR 复合物结构解析可行性评估/ }).count()
const frame = page.locator('iframe[title="合并评估报告（与下载 HTML 一致）"]')
const frameCount = await frame.count()
console.log('刊头标题:', headOk > 0 ? 'OK' : 'FAIL')
console.log('内嵌报告 iframe:', frameCount > 0 ? 'OK' : 'FAIL')

// 5. 等 iframe 载入完成并检查内容 + 高度自适应
let frameInfo = null
if (frameCount > 0) {
  const frameEl = frame.first()
  await frameEl.waitFor({ state: 'attached', timeout: 60_000 })
  // iframe 加载 + React 高度同步需要时间（2.7MB HTML）
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(2000)
    try {
      const h = await frameEl.evaluate ? null : null
    } catch { /* ignore */ }
    const box = await frameEl.boundingBox()
    if (box && box.height > 3000) break
  }
  const box = await frameEl.boundingBox()
  frameInfo = { w: Math.round(box?.width ?? 0), h: Math.round(box?.height ?? 0) }
  console.log('iframe 几何:', JSON.stringify(frameInfo))
  // 内容抽查：iframe 文档内有 .rpt-head（报告刊头）与靶点速览
  const content = await page.evaluate(url => {
    // 无法直接跨 frame 访问（同源但 Playwright locator 更合适）— 用 frames API
    return null
  }, null)
  const f = page.frames().find(x => x.url().includes('inline=1'))
  if (f) {
    const hasHead = await f.locator('.rpt-head').count()
    const hasInsights = await f.locator('#insights').count()
    console.log('iframe 内 .rpt-head:', hasHead > 0 ? 'OK' : 'FAIL', '| #insights 章节:', hasInsights > 0 ? 'OK' : 'FAIL')
  } else {
    console.log('FAIL: 未找到 inline frame（可能尚未加载完成）')
  }
}

// 6. 旧 React 数据区块应降级隐藏（内嵌正常时不出现在页面）
const fallbackEyebrow = await page.getByText(/Merged Analysis · 合并分析/).count()
console.log('旧版 React 数据区块已隐藏:', fallbackEyebrow === 0 ? 'OK' : 'FAIL（仍渲染）')

// 7. 截图存档
await page.screenshot({ path: '/tmp/render/merged-embed-top.png' })
await page.evaluate(() => window.scrollTo(0, 2600))
await page.waitForTimeout(800)
await page.screenshot({ path: '/tmp/render/merged-embed-mid.png' })

await browser.close()
console.log('done')
