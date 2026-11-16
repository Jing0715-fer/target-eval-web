/**
 * v2.12 合并报告结构分层目检截图（本地文件 — 无需 dev server）：
 *  1. 首页：刊头可点靶点卡 + glance 阅读路径 + 目录靶点单独报告 chips
 *  2. 序列一致性矩阵（对齐修复 — 居中 + 行标正文化）
 *  3. 共有结构 + 共有结构文献（复合物评估文献只列共有）
 *  4. 点击靶点卡 → 靶点单独报告页（综述 + 单独报告 + 单独结构）+ 返回首页
 *  5. hash 深链直达
 */
import { chromium } from 'playwright'

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 } })
const page = await ctx.newPage()
// 屏蔽外网（字体/3Dmol CDN）— 加速且确定性（3D 视图降级不影响版式核验）
await ctx.route('**://*', route => route.request().url().startsWith('file://') ? route.continue() : route.abort())
await page.goto('file:///tmp/render-v2.12.html', { waitUntil: 'load', timeout: 60000 })
await page.waitForTimeout(600)

// 1) 首页顶部（刊头靶点卡 + glance + 目录）
await page.screenshot({ path: '/tmp/render/v12-01-home-top.png', fullPage: false })

// 2) 序列一致性矩阵 — 对齐核验
await page.locator('#homolog').scrollIntoViewIfNeeded()
await page.waitForTimeout(300)
await page.locator('#homorph-null').count() // noop
await page.screenshot({ path: '/tmp/render/v12-02-matrix.png' })

// 3) 共有结构 + 共有文献
await page.locator('#shared-pdbs').scrollIntoViewIfNeeded()
await page.waitForTimeout(300)
await page.screenshot({ path: '/tmp/render/v12-03-shared-lit.png' })

// 4) 点击 O00481 靶点卡 → 单独报告页
await page.locator('.tgt-card[data-goto="target-O00481"]').click()
await page.waitForTimeout(500)
const hash = await page.evaluate(() => location.hash)
console.log('点击靶点卡后 hash =', hash)
await page.screenshot({ path: '/tmp/render/v12-04-target-head.png' })

// 5) 靶点页 — 综述章节
await page.locator('#view-target-O00481 .sec').first().scrollIntoViewIfNeeded()
await page.waitForTimeout(300)
await page.screenshot({ path: '/tmp/render/v12-05-target-review.png' })

// 6) 靶点页 — 单独报告卡（基本信息 + 预测结构）+ PDB 折叠块
await page.locator('#mtr-O00481').scrollIntoViewIfNeeded()
await page.waitForTimeout(300)
await page.screenshot({ path: '/tmp/render/v12-06-target-report.png' })
await page.locator('#struct-O00481').scrollIntoViewIfNeeded()
await page.waitForTimeout(200)
await page.screenshot({ path: '/tmp/render/v12-07-target-pdb-fold.png' })

// 7) 返回报告首页
await page.locator('#view-target-O00481 .tgt-back').first().click()
await page.waitForTimeout(400)
const backHash = await page.evaluate(() => location.hash)
console.log('点击返回后 hash =', backHash)
const homeVisible = await page.locator('#view-home').isVisible()
const targetHidden = await page.locator('#view-target-O00481').isHidden()
console.log('home 可见 =', homeVisible, '· target 隐藏 =', targetHidden)
await page.screenshot({ path: '/tmp/render/v12-08-back-home.png' })

// 8) hash 深链直达靶点页 + 上一/下一导航
await page.evaluate(() => { location.hash = '#view-target-Q99603' })
await page.waitForTimeout(400)
const deepVisible = await page.locator('#view-target-Q99603').isVisible()
console.log('hash 深链 Q99603 可见 =', deepVisible)
await page.locator('#view-target-Q99603 .tgt-nav-chip').last().click()
await page.waitForTimeout(300)
const nextVisible = await page.locator('#view-target-P0CF51').isVisible()
console.log('下一靶点导航 P0CF51 可见 =', nextVisible)
await page.screenshot({ path: '/tmp/render/v12-09-target-nav.png' })

// 9) 打印仿真（全部视图依序 + 折叠展开）
await page.emulateMedia({ media: 'print' })
await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')))
await page.waitForTimeout(300)
await page.screenshot({ path: '/tmp/render/v12-10-print-all.png' })
await page.evaluate(() => window.dispatchEvent(new Event('afterprint')))
await page.emulateMedia({ media: 'screen' })

console.log('DONE')
await browser.close()
