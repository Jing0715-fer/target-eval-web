/**
 * v2.11 合并报告新格式目检截图：
 *  - 顶部：批次速览 glance + 目录（共有结构条目突出）
 *  - 共有结构章节（绿色面板 + 表）
 *  - 各靶点单独报告（简报卡）
 *  - 折叠状态：各靶点 PDB 明细默认收起 + 展开后 ◈ 徽标
 */
import { chromium } from 'playwright'

const BASE = 'http://localhost:3000'
const OWNER = '9043a4cce0f74e379c7972549e500b81'
const RID = 'cmwimxghb0005p7toxq7ktn9a'

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await ctx.addCookies([{ name: 'te_owner', value: OWNER, url: BASE }])
const page = await ctx.newPage()
await page.goto(`${BASE}/api/evaluate/batch-report?id=${RID}&inline=1`, { waitUntil: 'load', timeout: 60000 })
await page.waitForTimeout(1200)

// 1) 顶部（刊头 + 速览 + 目录）
await page.screenshot({ path: '/tmp/render/m1-top.png' })

// 2) 共有结构章节（滚动到位）
await page.locator('#shared-pdbs').scrollIntoViewIfNeeded()
await page.waitForTimeout(400)
await page.screenshot({ path: '/tmp/render/m2-shared.png' })

// 3) 各靶点单独报告章节
await page.locator('#mini-reports').scrollIntoViewIfNeeded()
await page.waitForTimeout(400)
await page.screenshot({ path: '/tmp/render/m3-mini.png' })

// 4) 各靶点 PDB 结构章节（默认折叠态）+ 展开第一个折叠块（◈ 徽标互证）
await page.locator('#pdbs').scrollIntoViewIfNeeded()
await page.waitForTimeout(400)
await page.screenshot({ path: '/tmp/render/m4-fold-closed.png' })
const firstFold = page.locator('details.pdb-fold').first()
await firstFold.locator('summary').click()
await page.waitForTimeout(400)
await firstFold.scrollIntoViewIfNeeded()
await page.screenshot({ path: '/tmp/render/m5-fold-open.png' })

await browser.close()
console.log('done: /tmp/render/m1..m5')
