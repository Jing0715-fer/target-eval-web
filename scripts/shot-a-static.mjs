/**
 * README 截图脚本 A —— 静态视图 + 启动 EGFR 评估 + 进度图
 * 产物：home.png / upload.png / home-dark.png / progress.png（docs/screenshots/）
 * 副产物：/tmp/egfr-job.txt（jobId，供后续轮询与结果页截图）
 */
import { chromium } from 'playwright'
import { writeFileSync } from 'fs'

const BASE = 'http://localhost:3000'
const OUT = 'docs/screenshots'
const log = (...a) => console.log('[shotA]', ...a)

const run = async () => {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 })
  page.setDefaultTimeout(180_000)

  // ── 1. 首页（浅色，整页）──────────────────────────────────────────
  log('打开首页…')
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('textarea[aria-label="UniProt ID 输入"]', { state: 'visible' })
  await page.waitForTimeout(2500) // 等入场动画稳定
  await page.screenshot({ path: OUT + '/home.png', fullPage: true })
  log('home.png 完成')

  // ── 2. 评估表上传页（切 docx 标签，整页）──────────────────────────
  await page.getByRole('tab', { name: '评估表' }).click()
  await page.waitForTimeout(1200)
  await page.screenshot({ path: OUT + '/upload.png', fullPage: true })
  log('upload.png 完成')

  // ── 3. 深色模式（视口）────────────────────────────────────────────
  await page.evaluate(() => localStorage.setItem('theme', 'dark'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('textarea[aria-label="UniProt ID 输入"]', { state: 'visible' })
  await page.waitForTimeout(2200)
  await page.screenshot({ path: OUT + '/home-dark.png' })
  log('home-dark.png 完成')

  // ── 4. 启动 EGFR 评估（浅色 + P00533）──────────────────────────────
  await page.evaluate(() => localStorage.setItem('theme', 'light'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('textarea[aria-label="UniProt ID 输入"]', { state: 'visible' })
  await page.fill('textarea[aria-label="UniProt ID 输入"]', 'P00533')
  await page.waitForTimeout(800)

  let jobId = ''
  page.on('response', async (res) => {
    if (res.url().endsWith('/api/evaluate') && res.request().method() === 'POST') {
      try { const j = await res.json(); if (j?.jobId) { jobId = j.jobId; log('jobId =', jobId) } } catch {}
    }
  })
  await page.getByRole('button', { name: /开始评估/ }).click()
  log('已点击开始评估…')

  // ── 5. 进度视图（等待阶段列表 + 若干日志行）────────────────────────
  await page.waitForSelector('text=评估阶段', { state: 'visible', timeout: 120_000 })
  for (let i = 0; i < 24; i++) {
    await page.waitForTimeout(2500)
    const logs = await page.locator('code, .font-mono').count().catch(() => 0)
    const stageTxt = await page.textContent('body').catch(() => '')
    const hasLogs = /UniProt|BLAST|元数据|结构|文献/.test(stageTxt || '')
    if (hasLogs && i >= 4) break // 至少 10s，保证阶段列表已展开
  }
  await page.waitForTimeout(1500)
  await page.screenshot({ path: OUT + '/progress.png' })
  log('progress.png 完成')

  if (!jobId) throw new Error('未捕获 jobId')
  writeFileSync('/tmp/egfr-job.txt', jobId)
  log('jobId 已写入 /tmp/egfr-job.txt =', jobId)

  await browser.close()
}

run().catch((e) => { console.error(e); process.exit(1) })
