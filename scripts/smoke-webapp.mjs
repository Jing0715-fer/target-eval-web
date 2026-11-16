/** Web 应用侧端到端冒烟：历史对话框 → 打开合并报告 → iframe 加载 v2.13 HTML */
import { chromium } from 'playwright'

const BASE = 'http://localhost:3000'
const MERGED_OWNER = 'af74a0c83a684442940af04a85764981'

const run = async () => {
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  await page.context().addCookies([{ name: 'te_owner', value: MERGED_OWNER, url: BASE }])

  console.log('[ui] 打开应用首页…')
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(4000) // 等入场动画

  // 打开历史对话框
  const histBtn = page.getByRole('button', { name: /历史|记录/ }).first()
  if (await histBtn.count()) {
    await histBtn.click()
    await page.waitForTimeout(1200)
    console.log('[ui] 历史对话框已打开')
    // 切到合并报告 tab
    const tab = page.getByRole('tab', { name: /合并报告/ }).first()
    if (await tab.count()) {
      await tab.click()
      await page.waitForTimeout(800)
    }
    // 点击第一条合并报告（BTN-TCR 最新）— JS 点击绕过遮罩拦截
    const rowSel = '[data-batch-id]'
    const clicked = await page.evaluate((sel) => {
      const el = document.querySelector(sel)
      if (el) { el.click(); return true }
      const all = [...document.querySelectorAll('div,button,li,tr')]
      const t = all.find(e => /BTN-TCR 复合物结构解析可行性评估/.test(e.textContent || '') && e.children.length < 12)
      if (t) { t.click(); return true }
      return false
    }, rowSel)
    console.log('[ui] 合并报告行点击:', clicked)
    await page.waitForTimeout(6000)
    console.log('[ui] 已点击合并报告记录，等待视图切换…')
  } else {
    console.log('[ui] 未找到历史按钮（选择器不匹配）')
  }

  // 断言：页面出现 iframe（内嵌完整报告）且加载了 v2.13 HTML
  const frame = page.locator('iframe[title*="合并评估报告"]').first()
  let fc = 0
  try {
    await frame.waitFor({ state: 'attached', timeout: 90_000 })
    fc = 1
  } catch { fc = 0 }
  console.log('[ui] 报告 iframe:', fc)
  if (fc) {
    // 等 iframe 内 v2.13 标记出现（HTML 拉取 + 可能的升级渲染）
    let marker = null
    for (let i = 0; i < 24; i++) {
      await page.waitForTimeout(5000)
      marker = await frame.contentFrame().then(doc => doc.evaluate(() => document.documentElement.outerHTML.includes('mrg-fmt-v2.13')).catch(() => null)).catch(() => null)
      if (marker) break
    }
    const head = await frame.contentFrame().then(doc => doc.evaluate(() => {
      const t = document.querySelector('h1.rpt-title')
      return t ? (t.textContent || '').slice(0, 40) : null
    }).catch(() => null)).catch(() => null)
    console.log('[ui] iframe 内 v2.13 标记:', marker, '| 首页标题:', head)
    await page.screenshot({ path: '/tmp/render/webapp-merged.png' })
    console.log('[ui] webapp-merged.png 完成')
  }

  await browser.close()
}

run().catch(e => { console.error('FATAL', e); process.exit(1) })
