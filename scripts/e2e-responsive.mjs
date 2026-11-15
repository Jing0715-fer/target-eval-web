/**
 * 响应式版心 E2E（v2.7.3）— node + playwright：
 *  1. 报告 fixture（新报告 / 旧报告注入版）× 9 档视口：
 *     - 页面无横向溢出（scrollWidth ≤ innerWidth+1）
 *     - .page 宽度命中版心分级（920→1088→1224→1360→1480→1600）
 *     - body 字号随档位微升（15→15.5→16→17→17.5px）
 *     - ≥1280 版心内数据表（min-width 856px）免横向滚动
 *     - 375px 下 lig-grid 不撑爆
 *  2. 应用首页（生产服务器）× 375/1920：无横向溢出 + 页脚 v2.7.3
 *  3. 关键视口截图存 /tmp/resp-shots/（供人工目检）
 * 用法：node scripts/e2e-responsive.mjs [baseUrl]  （默认 http://127.0.0.1:3000）
 */
import { chromium } from 'playwright'
import fs from 'node:fs'

const BASE = process.argv[2] || 'http://127.0.0.1:3000'
const SHOTS = '/tmp/resp-shots'
fs.mkdirSync(SHOTS, { recursive: true })

/** 版心分级期望（宽度 → [.page 期望宽度, body 期望字号]） */
function expectTier(w) {
  if (w >= 2200) return [1600, '17.5px']
  if (w >= 1920) return [1480, '17px']
  if (w >= 1600) return [1360, '16px']
  if (w >= 1440) return [1224, '15.5px']
  if (w >= 1280) return [1088, '15px']
  return [Math.min(w, 920), '15px'] // 窄于 1280：满宽（≤920 时受 max-width 限制）
}

const VIEWPORTS = [375, 640, 768, 1024, 1280, 1440, 1600, 1920, 2560]

let pass = 0, fail = 0
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ← ${detail}`}`)
  cond ? pass++ : fail++
}

const browser = await chromium.launch()

/** 屏蔽外网字体请求（离线确定性 + 提速） */
async function newPage(w, h = 900) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } })
  await ctx.route('**://fonts.googleapis.com/**', r => r.abort())
  await ctx.route('**://fonts.gstatic.com/**', r => r.abort())
  return { ctx, page: await ctx.newPage() }
}

/** 报告页面测量 */
async function measureReport(page, w) {
  return page.evaluate(() => {
    const doc = document.documentElement
    const pageEl = document.querySelector('.page')
    const body = getComputedStyle(document.body)
    const tblWrap = document.querySelector('.tbl-wrap')
    const ligGrid = document.querySelector('.lig-grid')
    return {
      scrollW: doc.scrollWidth,
      clientW: doc.clientWidth,
      pageW: pageEl ? pageEl.getBoundingClientRect().width : 0,
      font: body.fontSize,
      tblOverflow: tblWrap ? tblWrap.scrollWidth - tblWrap.clientWidth : 0,
      ligOverflow: ligGrid ? ligGrid.scrollWidth - ligGrid.clientWidth : 0,
      hasPage: !!pageEl,
    }
  })
}

// ─── 1. 新报告（内嵌响应式版心）──────────────────────────────────────────────
console.log('── 新报告（v2.7.3 内嵌版心）──')
for (const w of VIEWPORTS) {
  const { ctx, page } = await newPage(w)
  await page.goto('file:///tmp/resp-fixtures/report-new.html', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(120)
  const m = await measureReport(page, w)
  const [expW, expFont] = expectTier(w)
  ok(`[${w}px] 无横向溢出`, m.scrollW <= m.clientW + 1, `scrollW=${m.scrollW} clientW=${m.clientW}`)
  ok(`[${w}px] 版心宽度 ${Math.round(m.pageW)} = ${expW}`, Math.abs(m.pageW - expW) <= 1, `actual=${m.pageW}`)
  ok(`[${w}px] 字号 ${m.font}`, m.font === expFont, `actual=${m.font}`)
  if (w >= 1280) ok(`[${w}px] 数据表免横滚`, m.tblOverflow <= 1, `overflow=${m.tblOverflow}px`)
  if (w <= 640) ok(`[${w}px] 配体卡网格不撑爆`, m.ligOverflow <= 1, `overflow=${m.ligOverflow}px`)
  await ctx.close()
}

// ─── 2. 旧报告（serve 时注入覆盖 CSS）───────────────────────────────────────
console.log('── 旧报告（路由注入版心，模拟 v2.7.2 历史 report.html）──')
for (const w of [375, 768, 1440, 1920]) {
  const { ctx, page } = await newPage(w)
  await page.goto('file:///tmp/resp-fixtures/report-legacy-injected.html', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(120)
  const m = await measureReport(page, w)
  const [expW] = expectTier(w)
  ok(`[${w}px] 注入版无横向溢出`, m.scrollW <= m.clientW + 1, `scrollW=${m.scrollW} clientW=${m.clientW}`)
  ok(`[${w}px] 注入版版心 ${Math.round(m.pageW)} = ${expW}`, Math.abs(m.pageW - expW) <= 1, `actual=${m.pageW}`)
  await ctx.close()
}

// ─── 3. 未注入的旧报告应维持 920 版心（对照组，验证剥离干净）────────────────
{
  const { ctx, page } = await newPage(1920)
  await page.goto('file:///tmp/resp-fixtures/report-legacy.html', { waitUntil: 'domcontentloaded', timeout: 30000 })
  const m = await measureReport(page, 1920)
  ok('[1920px] 对照：未注入旧报告仍 920 版心', Math.abs(m.pageW - 920) <= 1, `actual=${m.pageW}`)
  await ctx.close()
}

// ─── 4. 截图（人工目检）──────────────────────────────────────────────────────
console.log('── 截图 ──')
for (const w of [375, 768, 1440, 1920, 2560]) {
  const { ctx, page } = await newPage(w, w >= 1280 ? 1000 : 844)
  await page.goto('file:///tmp/resp-fixtures/report-new.html', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(200)
  await page.screenshot({ path: `${SHOTS}/report-${w}-top.jpg`, type: 'jpeg', quality: 60 })
  // 表格区（PDB 清单）
  const sec = page.locator('#pdbs')
  if (await sec.count()) await sec.screenshot({ path: `${SHOTS}/report-${w}-table.jpg`, type: 'jpeg', quality: 60 })
  await ctx.close()
  console.log(`  report-${w}-top.jpg / report-${w}-table.jpg`)
}

// ─── 5. 应用首页（生产服务器）───────────────────────────────────────────────
console.log('── 应用首页 ──')
for (const w of [375, 1920]) {
  const { ctx, page } = await newPage(w, w === 375 ? 812 : 1000)
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForTimeout(1500)
    const m = await page.evaluate(() => {
      const doc = document.documentElement
      return {
        scrollW: doc.scrollWidth,
        clientW: doc.clientWidth,
        footer: document.body.innerText.match(/v\d+\.\d+\.\d+/)?.[0] ?? '',
      }
    })
    ok(`首页[${w}px] 无横向溢出`, m.scrollW <= m.clientW + 1, `scrollW=${m.scrollW} clientW=${m.clientW}`)
    if (w === 1920) ok(`首页页脚版本 v2.7.3`, m.footer === 'v2.7.3', `actual=${m.footer}`)
    await page.screenshot({ path: `${SHOTS}/app-${w}.jpg`, type: 'jpeg', quality: 60 })
  } catch (e) {
    ok(`首页[${w}px] 可访问`, false, String(e).slice(0, 120))
  }
  await ctx.close()
}

await browser.close()
console.log(`\n${pass}/${pass + fail} passed${fail ? `（${fail} failed）` : ''}`)
process.exit(fail ? 1 : 0)
