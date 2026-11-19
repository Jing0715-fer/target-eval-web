/**
 * v2.13 视觉验证截图：合并报告（升级后）vs 单靶点报告 格式对比
 * 产物（/tmp/render/）：
 *  - merged-home-top.png     合并报告首页刊头（应为单靶点同款 eyebrow/大标题/meta-grid/badges）
 *  - merged-target-top.png   靶点单独评估页刊头（应与单靶点报告一模一样）
 *  - merged-target-pdb.png   靶点单独评估页 PDB 结构区（应全量展开无折叠）
 *  - single-top.png          单靶点报告（EGFR）刊头 — 对比基准
 *  - single-pdb.png          单靶点报告 PDB 区
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'fs'

const BASE = 'http://localhost:3000'
const OUT = '/tmp/render'
const OWNER = 'te_owner=9043a4cce0f74e379c7972549e500b81' // 血红蛋白批次+EGFR（127.0.0.* 归属）
const MERGED_OWNER = 'te_owner=af74a0c83a684442940af04a85764981' // BTN-TCR 批次归属
const MERGED_ID = 'cmwivvirm000fp7cjh7mf7ebl'
const SINGLE_JOB = 'cmwin52wn0007p7too04q7jw7'

const run = async () => {
  mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const log = (...a) => console.log('[shot]', ...a)

  // ── 1. 合并报告（BTN-TCR · 已触发 v2.13 升级）────────────────────
  const p1 = await ctx.newPage()
  await p1.context().addCookies([{ name: 'te_owner', value: MERGED_OWNER.replace('te_owner=', ''), url: BASE }])
  log('打开合并报告…')
  await p1.goto(`${BASE}/api/evaluate/batch-report?id=${MERGED_ID}&inline=1`, { waitUntil: 'load', timeout: 240_000 })
  await p1.waitForTimeout(3000)
  await p1.screenshot({ path: `${OUT}/merged-home-top.png` })
  log('merged-home-top.png 完成')

  // 点击第一张靶点卡片 → 单独评估页
  log('点击靶点卡片进入单独评估页…')
  await p1.click('.tgt-card')
  await p1.waitForTimeout(1800)
  await p1.screenshot({ path: `${OUT}/merged-target-top.png` })
  log('merged-target-top.png 完成')

  // 滚到 PDB 结构清单
  const pdbH = p1.locator('h2', { hasText: 'PDB' }).first()
  if (await pdbH.count()) {
    await pdbH.scrollIntoViewIfNeeded()
    await p1.waitForTimeout(600)
    await p1.screenshot({ path: `${OUT}/merged-target-pdb.png` })
    log('merged-target-pdb.png 完成')
  }
  // 文献区
  const litH = p1.locator('h2', { hasText: '文献' }).first()
  if (await litH.count()) {
    await litH.scrollIntoViewIfNeeded()
    await p1.waitForTimeout(600)
    await p1.screenshot({ path: `${OUT}/merged-target-lit.png` })
    log('merged-target-lit.png 完成')
  }

  // ── 2. 单靶点报告（EGFR）— 对比基准 ──────────────────────────────
  const p2 = await ctx.newPage()
  await p2.context().addCookies([{ name: 'te_owner', value: OWNER.replace('te_owner=', ''), url: BASE }])
  log('打开单靶点报告（EGFR）…')
  await p2.goto(`${BASE}/api/jobs/${SINGLE_JOB}/report`, { waitUntil: 'load', timeout: 120_000 })
  await p2.waitForTimeout(2500)
  await p2.screenshot({ path: `${OUT}/single-top.png` })
  log('single-top.png 完成')
  const pdbH2 = p2.locator('h2', { hasText: 'PDB' }).first()
  if (await pdbH2.count()) {
    await pdbH2.scrollIntoViewIfNeeded()
    await p2.waitForTimeout(600)
    await p2.screenshot({ path: `${OUT}/single-pdb.png` })
    log('single-pdb.png 完成')
  }

  await browser.close()
  log('全部完成')
}

run().catch(e => { console.error('FATAL', e); process.exit(1) })
