/**
 * v2.29 浏览器 E2E 实测：结果页（内嵌 HTML 报告 iframe 为主视图）的
 * 评估区间横幅 + 范围外结构折叠区交互与视觉（灰色行 + 范围外 chip）。
 *
 * 打开首页 → 历史评估 → 点击 P00533（域名匹配/手动区间）作业行 →
 *  ① iframe 内报告含区间横幅（「评估区间 X-Y」+ 来源说明）
 *  ② iframe 内 PDB 章节含 fold-outside 折叠区（summary「范围外结构 N 条」）
 *  ③ 点击 summary 展开 → tr.tr-outside 灰色行 + 范围外 chip 可见
 *  ④ 截图留档（横幅区 + 折叠区展开态）
 * 产物：/tmp/render/v29-*.png
 */
import { chromium } from 'playwright'

const BASE = 'http://localhost:3000'
const OUT = '/tmp/render'
const log = (...a) => console.log('[v29]', ...a)
let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const run = async () => {
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
  const page = await ctx.newPage()
  page.setDefaultTimeout(90_000)

  log('打开首页…')
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('textarea[aria-label="UniProt ID 输入"]', { state: 'visible' })

  await page.getByRole('button', { name: '历史评估', exact: true }).click()
  await page.waitForTimeout(2000)
  const row = page.locator('[role="button"][tabindex="0"]', { hasText: 'P00533' }).first()
  await row.waitFor({ state: 'visible', timeout: 30_000 })
  await row.evaluate((el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
  log('已点击 P00533 历史行')

  // 等待内嵌报告 iframe 渲染
  await page.waitForSelector('iframe[title="评估报告（与下载 HTML 一致）"]', { state: 'visible', timeout: 90_000 })
  const frame = page.frameLocator('iframe[title="评估报告（与下载 HTML 一致）"]')
  await frame.locator('.page').first().waitFor({ state: 'visible', timeout: 60_000 })
  await page.waitForTimeout(1500)
  log('报告 iframe 已渲染')

  // 关闭历史弹窗（dispatchEvent 点击不触发 Radix 关闭链 — 同 shot-b-result 惯例）
  await page.keyboard.press('Escape')
  await page.waitForTimeout(1200)
  for (let i = 0; i < 6; i++) {
    const open = await page.locator('[data-state="open"]').count()
    if (open === 0) break
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1000)
  }
  log('历史弹窗已关闭')

  // ① 区间横幅（.rng-banner — 含「评估区间 X-Y」与来源）
  const banner = frame.locator('.rng-banner').first()
  const bannerText = await banner.textContent().catch(() => '')
  ok('① 报告含评估区间横幅（rng-banner）', bannerText.includes('评估区间'), bannerText.slice(0, 90))

  // ② 范围外折叠区（details.fold-outside）
  const fold = frame.locator('details.fold-outside').first()
  const foldCount = await frame.locator('details.fold-outside').count()
  const summaryText = await fold.locator('summary').textContent().catch(() => '')
  ok('② 报告含范围外结构折叠区（fold-outside）', foldCount >= 1, `fold 区数 ${foldCount} · ${summaryText.slice(0, 60)}`)

  // ③ 展开折叠区 → 灰色行 + chip
  if (foldCount >= 1) {
    await fold.locator('summary').click()
    await page.waitForTimeout(600)
    const rowOut = frame.locator('tr.tr-outside').first()
    ok('③ 展开后灰色行（tr.tr-outside）出现', await rowOut.isVisible().catch(() => false))
    const chip = frame.locator('.rng-outside-chip').first()
    ok('③ 范围外 chip 出现', await chip.isVisible().catch(() => false))

    // ④ 截图：滚动到 PDB 章节横幅 + 折叠区展开态
    await banner.scrollIntoViewIfNeeded().catch(() => {})
    await page.waitForTimeout(500)
    await page.screenshot({ path: `${OUT}/v29-banner.png`, fullPage: false })
    await fold.scrollIntoViewIfNeeded().catch(() => {})
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${OUT}/v29-fold-open.png`, fullPage: false })
    log(`截图：${OUT}/v29-banner.png / v29-fold-open.png`)
  }

  // ⑤ BLAST 章节范围外折叠区（若同源命中有折叠条目）
  const blastFoldCount = await frame.locator('section .fold-outside').count()
  ok('⑤ 范围外折叠区均挂于报告章节（≥1 处）', blastFoldCount >= 1, `${blastFoldCount} 处`)

  await browser.close()
  console.log(`\n${pass} 通过 · ${fail} 失败`)
  process.exit(fail > 0 ? 1 : 0)
}

run().catch((e) => {
  console.error('[v29] 失败:', e)
  process.exit(1)
})
