/**
 * README 截图脚本 E —— 启动带配体的 EGFR 评估（erlotinib + ATP）
 * 产物：/tmp/egfr-ligand-job.txt（jobId，供轮询与结果页截图复用）
 */
import { chromium } from 'playwright'
import { writeFileSync } from 'fs'

const BASE = 'http://localhost:3000'
const OWNER = '9043a4cce0f74e379c7972549e500b81'
const log = (...a) => console.log('[shotE]', ...a)

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await ctx.addCookies([{ name: 'te_owner', value: OWNER, url: BASE }])
const page = await ctx.newPage()
page.setDefaultTimeout(180_000)

let jobId = ''
page.on('response', async (res) => {
  if (res.url().endsWith('/api/evaluate') && res.request().method() === 'POST') {
    try { const j = await res.json(); if (j?.jobId) { jobId = j.jobId; log('jobId =', jobId) } } catch {}
  }
})

log('打开首页…')
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
await page.waitForSelector('textarea[aria-label="UniProt ID 输入"]', { state: 'visible' })
await page.fill('textarea[aria-label="UniProt ID 输入"]', 'P00533')

// 配体输入（fill 后点「添加」按钮提交芯片）
await page.fill('input[aria-label="配体输入"]', 'erlotinib, ATP')
await page.waitForTimeout(400)
await page.locator('button[title="添加配体"]').click()
await page.waitForTimeout(600)
const bodyHasChips = await page.locator('[aria-label="移除配体"]').count()
log('配体芯片数:', bodyHasChips)
if (bodyHasChips < 2) { console.error('配体未提交为芯片'); process.exit(3) }

await page.getByRole('button', { name: /开始评估/ }).click()
log('已点击开始评估…')
await page.waitForTimeout(6000)
if (!jobId) { console.error('未捕获 jobId'); process.exit(1) }
writeFileSync('/tmp/egfr-ligand-job.txt', jobId)
log('DONE', jobId)
await browser.close()
