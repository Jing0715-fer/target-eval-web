/**
 * README 截图脚本 C —— 血红蛋白 α/β 批次（P69905 + P68871）→ 合并报告视图
 * 产物：merged-view.png（1440×1000 裁切） / merged.png（整页长图）
 * 以 detached 进程运行（nohup … &），bash 侧轮询 /tmp/shotC.log 观察进度。
 * 合并报告由前端在批次完成后触发（POST /api/evaluate/batch-report），故浏览器须全程在线。
 */
import { chromium } from 'playwright'
import { writeFileSync, appendFileSync } from 'fs'

const BASE = 'http://localhost:3000'
const OUT = 'docs/screenshots'
const OWNER = '9043a4cce0f74e379c7972549e500b81'
const log = (...a) => { console.log('[shotC]', ...a); appendFileSync('/tmp/shotC.progress', a.join(' ') + '\n') }
const T0 = Date.now()
const el = () => Math.round((Date.now() - T0) / 1000) + 's'

const run = async () => {
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5, acceptDownloads: true })
  await ctx.addCookies([{ name: 'te_owner', value: OWNER, url: BASE }])
  const page = await ctx.newPage()
  page.setDefaultTimeout(180_000)

  const jobIds = []
  page.on('response', async (res) => {
    if (res.url().endsWith('/api/evaluate') && res.request().method() === 'POST') {
      try { const j = await res.json(); if (j?.jobId) { jobIds.push(j.jobId); log(el(), 'jobId =', j.jobId) } } catch {}
    }
  })

  log(el(), '打开首页…')
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('textarea[aria-label="UniProt ID 输入"]', { state: 'visible' })
  await page.fill('textarea[aria-label="UniProt ID 输入"]', 'P69905, P68871')
  await page.waitForTimeout(600)
  await page.getByRole('button', { name: /开始评估/ }).click()
  log(el(), '已开始批次（P69905 + P68871）')

  // ── 等合并视图（最多 40 分钟）──
  const MARK = 'Merged Evaluation Report'
  let ok = false
  for (let i = 0; i < 530; i++) {
    await page.waitForTimeout(4500)
    try {
      const body = await page.textContent('body')
      if (body && body.includes(MARK)) { ok = true; break }
      if (body && /合并报告（LLM 部分失败）|合并报告生成失败/.test(body)) { log(el(), '!! 合并报告失败'); break }
    } catch {}
    if (i % 13 === 0) {
      const tip = await page.textContent('body').then(t => (t || '').replace(/\s+/g, ' ').slice(60, 200)).catch(() => '')
      log(el(), '…等待中 |', jobIds.length, '个job |', tip.slice(0, 90))
    }
  }
  if (!ok) { log(el(), '!! 未等到合并视图，退出'); writeFileSync('/tmp/heme-jobs.txt', jobIds.join('\n')); await browser.close(); process.exit(2) }
  log(el(), '合并视图已出现')

  // 稳定：等字体/图片与动效
  await page.waitForTimeout(6000)
  await page.screenshot({ path: OUT + '/merged-view.png', clip: { x: 0, y: 0, width: 1440, height: 1000 } })
  log(el(), 'merged-view.png 完成')
  await page.waitForTimeout(1000)
  await page.screenshot({ path: OUT + '/merged.png', fullPage: true })
  log(el(), 'merged.png 完成（fullPage）')

  writeFileSync('/tmp/heme-jobs.txt', jobIds.join('\n') + '\n')
  await browser.close()
  log(el(), 'DONE')
}

run().catch((e) => { log(el(), 'ERROR ' + (e && e.message)); process.exit(1) })
