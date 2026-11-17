/**
 * 真实 App 诊断（v2.7.8 前置）：localhost:3000（dev server · v2.7.7 代码）+
 * DB 真实 job（reportPath 指向 fixture report-new.html — rpt-zoom-v2 baked）。
 * 复现用户反馈（web UI 预览中的三类问题），与夹具差异定位：
 *   1. 结果页内嵌 ReportFrame（自动高度 iframe + 父页滚动 + 上方应用内容）
 *   2. 「在线预览报告」Radix Dialog（h-full 内部可滚 iframe + RemoveScroll）
 *   3. AF 卡右上角双按钮
 */
import { chromium } from 'playwright'

const JOB = 'cmwf1jgy60000qxf7ijh5xa2o'
const BASE = 'http://localhost:3000'
let pass = 0, fail = 0
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ← ${detail}`}`)
  cond ? pass++ : fail++
}
const NUM = (s) => parseFloat(String(s).replace(/[^\d.\-]/g, '')) || 0

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await ctx.route('**://fonts.googleapis.com/**', r => r.abort())
await ctx.route('**://fonts.gstatic.com/**', r => r.abort())
await ctx.route('**://3Dmol.org/**', r => r.abort())
const page = await ctx.newPage()
page.on('console', m => { if (m.type() === 'error') console.log('  [console.error]', m.text().slice(0, 160)) })

await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(800)

// 打开历史 → 点目标作业 → 进入结果页
await page.click('[aria-label="历史评估"]')
await page.waitForTimeout(800)
// 历史抽屉为 Radix Dialog：作用域限定 dialog 内容，防误点主页同名文本
const histItem = page.locator('[data-slot="dialog-content"]').getByText('F-box only protein 21').first()
await histItem.waitFor({ state: 'visible', timeout: 15000 })
await histItem.click()
await page.waitForTimeout(2500)
const reportIframe = page.locator('iframe[title^="评估报告"]').first()
ok('结果页已进入 done 相位（内嵌报告 iframe 存在）', await reportIframe.count() > 0, `count=${await reportIframe.count()}`)

// 等 iframe 加载完 + 高度同步
await page.waitForFunction(() => {
  const f = document.querySelector('iframe[title^="评估报告"]')
  return f && f.getBoundingClientRect().height > 2000
}, null, { timeout: 30000 })
await page.waitForTimeout(800)
const fr = page.frames().find(f => f !== page.mainFrame() && f.url().includes(JOB))
ok('报告 frame 可寻', !!fr, fr?.url())

// ── 1. 真实 App 内嵌形态：图片灯箱 ──────────────────────────────────────────
console.log('\n── 1. 真实内嵌（ReportFrame）：中部图片点击 ──')
const imgLoc = fr.locator('.lig-struct img.rpt-zoomable').first()
await imgLoc.scrollIntoViewIfNeeded()
await page.waitForTimeout(400)
await imgLoc.click()
await page.waitForTimeout(400)

const geo1 = await page.evaluate(() => {
  const f = document.querySelector('iframe[title^="评估报告"]')
  const d = f.contentDocument
  const root = d.querySelector('.rpt-zoom')
  if (!root || root.hidden) return { open: false }
  const frt = f.getBoundingClientRect().top
  const rr = root.getBoundingClientRect()
  const close = root.querySelector('.rpt-zoom-close').getBoundingClientRect()
  const stage = root.querySelector('.rpt-zoom-stage').getBoundingClientRect()
  const img = root.querySelector('.rpt-zoom-stage img').getBoundingClientRect()
  const appHeader = document.querySelector('header')
  const hdrR = appHeader ? appHeader.getBoundingClientRect() : null
  const vw = window.innerWidth, vh = window.innerHeight
  return {
    open: true, position: getComputedStyle(root).position, styleTop: root.style.top,
    rootTopHost: frt + rr.top, rootH: rr.height, rootW: rr.width,
    closeTopHost: frt + close.top, closeVisible: frt + close.top >= 0 && frt + close.top + close.height <= vh,
    imgH: img.height, stageH: stage.height, imgCenterHost: frt + img.top + img.height / 2,
    iframeTop: frt, hdrH: hdrR ? hdrR.height : 0, hdrBottom: hdrR ? hdrR.bottom : 0,
    vh, vw,
  }
})
console.log('  geo1 =', JSON.stringify(geo1))
ok('内嵌灯箱打开', geo1.open)
ok('内嵌灯箱贴合可视切片且避让应用吸顶栏（top ≈ 栏下沿）', Math.abs(geo1.rootTopHost - geo1.hdrBottom) <= 3 && Math.abs(geo1.rootH - (geo1.vh - geo1.hdrBottom)) <= 3, `top=${geo1.rootTopHost} hdrBottom=${geo1.hdrBottom} h=${geo1.rootH}/${geo1.vh}`)
ok('v2.7.8 ⑩ 关闭钮位于吸顶栏之下（不再被应用顶栏遮挡）', geo1.closeTopHost >= geo1.hdrBottom - 2, `closeTopHost=${geo1.closeTopHost} hdrBottom=${geo1.hdrBottom}`)
ok('内嵌灯箱图片严格限高', geo1.imgH <= geo1.stageH + 2, `img=${geo1.imgH} stage=${geo1.stageH}`)
await page.screenshot({ path: '/tmp/zoom-shots/real-embed-lightbox.jpg', type: 'jpeg', quality: 70 })

// 灯箱内滚轮 → 父页（应用页）不滚动
const y0 = await page.evaluate(() => window.scrollY)
await page.mouse.move(720, 400)
await page.mouse.wheel(0, -240)
await page.waitForTimeout(300)
const y1 = await page.evaluate(() => window.scrollY)
const pct = await fr.evaluate(() => (document.querySelector('.rpt-zoom-pct') || {}).textContent || '')
ok('内嵌灯箱内滚轮 → 应用父页不滚动', y1 === y0, `parent scrollY ${y0} -> ${y1}`)
ok('内嵌灯箱滚轮缩放生效', Math.abs(NUM(pct) - 100) > 1, `pct=${pct}`)

// 鼠标移到屏幕上方应用头区（iframe 之外）滚轮 → v2.7.8 ⑪ 父页已锁，不再滚动
await page.mouse.move(720, 20)
await page.mouse.wheel(0, 300)
await page.waitForTimeout(300)
const y2 = await page.evaluate(() => window.scrollY)
const bodyLockedNow = await page.evaluate(() => document.body.style.overflow === 'hidden')
ok('v2.7.8 ⑪ 灯箱开着时滚轮在应用头区（iframe 外）→ 父页不滚动（已锁）', y2 === y1 && bodyLockedNow, `scrollY ${y1} -> ${y2} locked=${bodyLockedNow}`)
const geoAfter = await page.evaluate(() => {
  const f = document.querySelector('iframe[title^="评估报告"]')
  const d = f.contentDocument
  const root = d.querySelector('.rpt-zoom')
  if (!root || root.hidden) return { open: false }
  const frt = f.getBoundingClientRect().top
  const rr = root.getBoundingClientRect()
  const close = root.querySelector('.rpt-zoom-close').getBoundingClientRect()
  const hdrR = document.querySelector('header').getBoundingClientRect()
  return { open: true, rootTopHost: frt + rr.top, rootH: rr.height, closeTopHost: frt + close.top, hdrBottom: hdrR.bottom, vh: window.innerHeight }
})
console.log('  geoAfter =', JSON.stringify(geoAfter))
await page.keyboard.press('Escape')
await page.waitForTimeout(250)
const unlockedNow = await page.evaluate(() => document.body.style.overflow !== 'hidden')
ok('Esc 关闭 → 应用父页滚动解锁', unlockedNow)

// ── 2. AF 卡双按钮（真实内嵌中）────────────────────────────────────────────
console.log('\n── 2. 真实内嵌：AF 卡右上角按钮（v2.7.8 ⑨ 双按钮互斥）──')
const afStage = fr.locator('.af-stage').first()
await afStage.scrollIntoViewIfNeeded()
await page.waitForTimeout(300)
const dual = await fr.evaluate(() => {
  const fig = document.querySelector('figure.af-fig')
  const stage = fig.querySelector('.af-stage')
  const badge = fig.querySelector('.rpt-zoom-badge')
  const btn = fig.querySelector('.af-expand')
  const b1 = badge ? badge.getBoundingClientRect() : null
  const b2 = btn ? btn.getBoundingClientRect() : null
  return {
    stageCls: stage.className, hasBadge: !!badge, hasExpand: !!btn,
    badgeDisplay: badge ? getComputedStyle(badge).display : 'absent',
    figOff: fig.classList.contains('af-zoom-off'),
    badgePos: b1 ? { x: b1.x, y: b1.y } : null, btnPos: b2 ? { x: b2.x, y: b2.y } : null,
    overlap: b1 && b2 ? Math.hypot(b1.x - b2.x, b1.y - b2.y) : null,
  }
})
console.log('  dual =', JSON.stringify(dual))
ok('af-live 时 figure 加 af-zoom-off + 图片角标隐藏（仅剩一个「放大」钮）', dual.figOff && dual.badgeDisplay === 'none' && dual.hasExpand, JSON.stringify(dual))
ok('3D 放大钮可用（唯一入口）', dual.hasExpand)
await afStage.hover()
await page.waitForTimeout(350)
await page.screenshot({ path: '/tmp/zoom-shots/real-af-single-button.jpg', type: 'jpeg', quality: 70 })

// ── 3. 真实 App「在线预览」Dialog ────────────────────────────────────────────
console.log('\n── 3. 真实 Dialog（在线预览报告）：图片灯箱 + 滚轮 + 关闭按钮 ──')
const previewBtn = page.locator('button:has-text("全屏预览")').first()
await previewBtn.scrollIntoViewIfNeeded()
await page.waitForTimeout(200)
await previewBtn.click()
await page.waitForTimeout(1500)
// 关键：两个 iframe 同 URL —— 按 frameElement.title 精确定位 Dialog 的 iframe（frames().find 会命中内嵌 ReportFrame）
let dlgFrame = null
for (const f of page.frames()) {
  if (f === page.mainFrame()) continue
  try {
    const isDlg = await f.evaluate(() => { try { return window.frameElement && window.frameElement.title === '评估报告预览' } catch (e) { return false } })
    if (isDlg) { dlgFrame = f; break }
  } catch (e) { /* ignore */ }
}
ok('Dialog 打开且报告 iframe 就位', !!dlgFrame)

// Dialog 内滚到中部点图（JS 直发点击 — Playwright 跨 iframe 点击动作性检查会误报拦截）
await dlgFrame.evaluate(() => {
  const img = document.querySelector('.lig-struct img.rpt-zoomable')
  img.scrollIntoView({ block: 'center' })
})
await page.waitForTimeout(300)
const dlgImgInfo = await dlgFrame.evaluate(() => {
  const img = document.querySelector('.lig-struct img.rpt-zoomable')
  const r = img.getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height }
})
console.log('  图片在 iframe 视口中的位置 =', JSON.stringify(dlgImgInfo))
await dlgFrame.evaluate(() => document.querySelector('.lig-struct img.rpt-zoomable').click())
await page.waitForTimeout(400)

const dg = await dlgFrame.evaluate(() => {
  const root = document.querySelector('.rpt-zoom')
  if (!root || root.hidden) return { open: false }
  const rr = root.getBoundingClientRect()
  const close = root.querySelector('.rpt-zoom-close').getBoundingClientRect()
  const stage = root.querySelector('.rpt-zoom-stage').getBoundingClientRect()
  const img = root.querySelector('.rpt-zoom-stage img').getBoundingClientRect()
  const vh = window.innerHeight, vw = window.innerWidth
  return {
    open: true, position: getComputedStyle(root).position, top: rr.top, h: rr.height, w: rr.width,
    closeTop: close.top, closeRight: vw - close.right, closeVisible: close.top >= 0 && close.top + close.height <= vh && close.right >= 0 && close.right <= vw,
    imgH: img.height, stageH: stage.height, vh, vw,
    scrollY: window.scrollY,
  }
})
console.log('  dg =', JSON.stringify(dg))
ok('Dialog 灯箱打开（fixed）', dg.open && dg.position === 'fixed')
ok('Dialog 灯箱覆盖 iframe 视口', Math.abs(dg.top) <= 1 && Math.abs(dg.h - dg.vh) <= 1, `top=${dg.top} h=${dg.h}/${dg.vh}`)
ok('Dialog 关闭按钮在视口内可见', dg.closeVisible, `closeTop=${dg.closeTop}`)
await page.screenshot({ path: '/tmp/zoom-shots/real-dialog-lightbox.jpg', type: 'jpeg', quality: 70 })

// Dialog 灯箱内滚轮 → iframe 内部不滚动
const dsy0 = await dlgFrame.evaluate(() => window.scrollY)
await page.mouse.move(720, 430)
await page.mouse.wheel(0, 400)
await page.waitForTimeout(300)
const dsy1 = await dlgFrame.evaluate(() => window.scrollY)
ok('Dialog 灯箱内滚轮 → iframe 文档不滚动', dsy1 === dsy0, `iframe scrollY ${dsy0} -> ${dsy1}`)
await page.keyboard.press('Escape')
await page.waitForTimeout(250)

// Dialog 内 AF 全屏
const afDlg = dlgFrame.locator('.af-stage').first()
await afDlg.scrollIntoViewIfNeeded()
await page.waitForTimeout(300)
const dlgAfCls = await dlgFrame.evaluate(() => (document.querySelector('.af-stage') || {}).className || '')
if (dlgAfCls.includes('af-live')) {
  await dlgFrame.evaluate(() => document.querySelector('.af-stage .af-expand').click())
  await page.waitForTimeout(500)
  const daf = await dlgFrame.evaluate(() => {
    const wrap = document.querySelector('.af-fullwrap')
    if (!wrap) return { open: false }
    const wr = wrap.getBoundingClientRect()
    const close = wrap.querySelector('.af-fullclose').getBoundingClientRect()
    return { open: true, position: getComputedStyle(wrap).position, top: wr.top, h: wr.height, vh: window.innerHeight, closeTop: close.top, closeVisible: close.top >= 0 && close.top + close.height <= window.innerHeight }
  })
  console.log('  daf =', JSON.stringify(daf))
  ok('Dialog AF 全屏 fixed 覆盖视口', daf.open && daf.position === 'fixed' && Math.abs(daf.top) <= 1 && Math.abs(daf.h - daf.vh) <= 1)
  ok('Dialog AF 全屏关闭按钮可见', daf.closeVisible, `closeTop=${daf.closeTop}`)
  const asy0 = await dlgFrame.evaluate(() => window.scrollY)
  await page.mouse.move(720, 470)
  await page.mouse.wheel(0, 400)
  await page.waitForTimeout(300)
  const asy1 = await dlgFrame.evaluate(() => window.scrollY)
  ok('Dialog AF 全屏内滚轮 → iframe 不滚动', asy1 === asy0, `scrollY ${asy0} -> ${asy1}`)
  await page.screenshot({ path: '/tmp/zoom-shots/real-dialog-af.jpg', type: 'jpeg', quality: 70 })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
} else {
  console.log(`  (Dialog 内 af-stage=${dlgAfCls} — 跳过)`)
}

await ctx.close()
await browser.close()
console.log(`\n${pass}/${pass + fail} passed${fail ? `（${fail} FAILED）` : ''}`)
process.exit(0)
