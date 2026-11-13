/** 报告头部视觉核验：截取 report.html 头部区域（AF 图 + 基本信息 + 配体卡） */
import { chromium } from 'playwright'
import * as fs from 'node:fs/promises'

async function main() {
  const html = await fs.readFile('/tmp/report.html', 'utf-8')
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-gpu'] })
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
  await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForTimeout(500)
  await page.screenshot({ path: '/tmp/report-head.png', clip: { x: 0, y: 0, width: 1100, height: 900 } })
  // 配体区（元素级截图，不受滚动影响）
  const lig = page.locator('#ligands')
  try {
    await lig.scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)
    await lig.screenshot({ path: '/tmp/report-ligands.png' })
  } catch {
    console.error('ligands section screenshot failed')
  }
  // AF 图元素级截图（像素级核验白边）
  try {
    await page.locator('.rpt-head').screenshot({ path: '/tmp/report-rpt-head.png' })
  } catch {
    console.error('rpt-head screenshot failed')
  }
  // 窄视口（模拟 iframe 窄容器 < 720px：竖排布局，AF 图在基本信息下方）
  const page2 = await browser.newPage({ viewport: { width: 560, height: 900 } })
  await page2.setContent(html, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page2.waitForTimeout(400)
  await page2.screenshot({ path: '/tmp/report-head-narrow.png', clip: { x: 0, y: 0, width: 560, height: 760 } })
  await browser.close()
  console.log('saved: /tmp/report-head.png /tmp/report-ligands.png /tmp/report-head-narrow.png')
}

main().catch(e => { console.error('FATAL', e); process.exit(1) })
