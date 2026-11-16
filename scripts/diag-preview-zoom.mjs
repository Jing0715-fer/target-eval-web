/**
 * 诊断（v2.7.8 前置调查）：复现用户三项反馈 —
 *  A. Dialog 预览形态（h-full 内部可滚 iframe — 「报告在线预览」大窗口同构）
 *  B. AF 卡双按钮（rpt-zoom-badge 与 af-expand 同居右上角）
 *  C. 嵌入形态回归（自动高度 iframe — v2.7.7 已覆盖，防回归）
 * 产出各场景几何/行为快照，定位真实根因。
 */
import { chromium } from 'playwright'
import fs from 'node:fs'

let pass = 0, fail = 0
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ← ${detail}`}`)
  cond ? pass++ : fail++
}
const NUM = (s) => parseFloat(String(s).replace(/[^\d.\-]/g, '')) || 0

// ── Dialog 宿主（在线预览同构）：固定高 iframe（内部可滚）──────────────────────
const dlgHost = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>dialog host</title></head>
<body style="margin:0;font:12px sans-serif">
<div style="height:60px;background:#eee;padding:8px 16px">Dialog Header（打印 / 新窗口）</div>
<iframe id="rf" style="width:100%;height:700px;border:0;display:block"></iframe>
<script>
  var f = document.getElementById('rf');
  f.srcdoc = ${JSON.stringify(fs.readFileSync('/tmp/zoom-fixtures/report-new.html', 'utf-8')).replace(/<\//g, '<\\/')};
  f.addEventListener('load', function () { f.setAttribute('data-ready', '1'); });
</` + `script></body></html>`
fs.writeFileSync('/tmp/zoom-fixtures/dialog-host.html', dlgHost, 'utf-8')

const browser = await chromium.launch()

// ── A. Dialog 形态 ──────────────────────────────────────────────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await ctx.route('**://fonts.googleapis.com/**', r => r.abort())
  await ctx.route('**://fonts.gstatic.com/**', r => r.abort())
  await ctx.route('**://3Dmol.org/**', r => r.abort())
  const page = await ctx.newPage()
  await page.goto('file:///tmp/zoom-fixtures/dialog-host.html', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.getElementById('rf').getAttribute('data-ready') === '1', null, { timeout: 20000 })
  await page.waitForTimeout(500)
  const fr = page.frames().find(f => f !== page.mainFrame())

  console.log('\n── A1. Dialog 形态：环境判定 ──')
  const env = await fr.evaluate(() => {
    const f = window.frameElement
    const doc = document.documentElement
    const contentH = Math.max(doc.scrollHeight, document.body.scrollHeight)
    const r = f.getBoundingClientRect()
    return { iframeH: r.height, contentH, internalScroll: contentH > r.height + 8 }
  })
  ok('iframe 700px 固定高 · 内容远高于 iframe → 内部可滚（fixed 形态）', env.internalScroll, JSON.stringify(env))

  // 滚动 iframe 到中部再点图（用户场景：报告中部图片）
  await fr.evaluate(() => { window.scrollTo(0, 99999) })
  await page.waitForTimeout(200)
  const iframeScrollY0 = await fr.evaluate(() => window.scrollY)
  const imgLoc = fr.locator('.lig-struct img.rpt-zoomable').first()
  await imgLoc.scrollIntoViewIfNeeded()
  await page.waitForTimeout(200)
  await imgLoc.click()
  await page.waitForTimeout(300)

  console.log('\n── A2. Dialog 形态：图片灯箱几何 ──')
  const geo = await fr.evaluate(() => {
    const root = document.querySelector('.rpt-zoom')
    if (!root || root.hidden) return { open: false }
    const rr = root.getBoundingClientRect()
    const close = root.querySelector('.rpt-zoom-close').getBoundingClientRect()
    const vw = window.innerWidth, vh = window.innerHeight
    const img = root.querySelector('.rpt-zoom-stage img').getBoundingClientRect()
    return {
      open: true, position: getComputedStyle(root).position,
      rootTop: rr.top, rootH: rr.height, rootW: rr.width,
      closeTop: close.top, closeRight: vw - close.right, closeVisible: close.top >= 0 && close.top + close.height <= vh && close.right <= vw && close.right >= 0,
      imgH: img.height, stageH: root.querySelector('.rpt-zoom-stage').getBoundingClientRect().height,
      vh, vw,
    }
  })
  console.log('  geo =', JSON.stringify(geo))
  ok('灯箱打开且 fixed 定位', geo.open && geo.position === 'fixed')
  ok('灯箱覆盖 iframe 视口（top=0 · 高=视口高）', Math.abs(geo.rootTop) <= 1 && Math.abs(geo.rootH - geo.vh) <= 1, `top=${geo.rootTop} h=${geo.rootH}/${geo.vh}`)
  ok('关闭按钮在视口内可见', geo.closeVisible, `closeTop=${geo.closeTop} closeRightGap=${geo.closeRight}`)
  await page.screenshot({ path: '/tmp/zoom-shots/diag-dialog-lightbox.jpg', type: 'jpeg', quality: 70 })

  console.log('\n── A3. Dialog 形态：滚轮阻断 ──')
  const sy0 = await fr.evaluate(() => window.scrollY)
  await page.mouse.move(720, 400)
  await page.mouse.wheel(0, 400)
  await page.waitForTimeout(250)
  const sy1 = await fr.evaluate(() => window.scrollY)
  ok('灯箱内滚轮 → iframe 文档不滚动', sy1 === sy0, `iframe scrollY ${sy0} -> ${sy1}`)
  const pct = await fr.evaluate(() => (document.querySelector('.rpt-zoom-pct') || {}).textContent || '')
  ok('滚轮同时缩放图片', NUM(pct) < 100 || NUM(pct) > 100, `pct=${pct}`)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)

  // AF 全屏（Dialog 形态）
  console.log('\n── A4. Dialog 形态：AF 3D 全屏 ──')
  const afCls = await fr.evaluate(() => (document.querySelector('.af-stage') || {}).className || '')
  if (afCls.includes('af-live')) {
    await fr.evaluate(() => document.querySelector('.af-stage .af-expand').click())
    await page.waitForTimeout(400)
    const afg = await fr.evaluate(() => {
      const wrap = document.querySelector('.af-fullwrap')
      if (!wrap) return { open: false }
      const wr = wrap.getBoundingClientRect()
      const close = wrap.querySelector('.af-fullclose').getBoundingClientRect()
      return { open: true, position: getComputedStyle(wrap).position, top: wr.top, h: wr.height, vh: window.innerHeight, closeTop: close.top, closeVisible: close.top >= 0 && close.top + close.height <= window.innerHeight }
    })
    console.log('  afg =', JSON.stringify(afg))
    ok('AF 全屏遮罩 fixed 且覆盖视口', afg.open && afg.position === 'fixed' && Math.abs(afg.top) <= 1 && Math.abs(afg.h - afg.vh) <= 1)
    ok('AF 全屏关闭按钮可见', afg.closeVisible, `closeTop=${afg.closeTop}`)
    const asy0 = await fr.evaluate(() => window.scrollY)
    await page.mouse.move(720, 470)
    await page.mouse.wheel(0, 400)
    await page.waitForTimeout(250)
    const asy1 = await fr.evaluate(() => window.scrollY)
    ok('AF 全屏内滚轮 → iframe 文档不滚动', asy1 === asy0, `scrollY ${asy0} -> ${asy1}`)
    await page.screenshot({ path: '/tmp/zoom-shots/diag-dialog-af.jpg', type: 'jpeg', quality: 70 })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(250)
  } else {
    console.log(`  (af-stage class=${afCls} — WebGL headless 下可能 af-fail，跳过)`)
  }
  await ctx.close()
}

// ── B. AF 卡双按钮 ──────────────────────────────────────────────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await ctx.route('**://fonts.googleapis.com/**', r => r.abort())
  await ctx.route('**://fonts.gstatic.com/**', r => r.abort())
  await ctx.route('**://3Dmol.org/**', r => r.abort())
  const page = await ctx.newPage()
  await page.goto('file:///tmp/zoom-fixtures/report-new.html', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(400)
  console.log('\n── B. AF 卡右上角按钮清点（悬停后可见元素）──')
  const afCls = await page.evaluate(() => (document.querySelector('.af-stage') || {}).className || '')
  await page.locator('.af-fig').scrollIntoViewIfNeeded()
  await page.waitForTimeout(200)
  const st = await page.evaluate(() => {
    const fig = document.querySelector('figure.af-fig')
    const stage = fig.querySelector('.af-stage')
    const badge = fig.querySelector('.rpt-zoom-badge')
    const btn = fig.querySelector('.af-expand')
    const r = stage.getBoundingClientRect()
    // 视觉重叠判定：两元素中心距 < 30px 即视为「叠在一起的两个按钮」
    let overlap = null
    if (badge && btn) {
      const b1 = badge.getBoundingClientRect(), b2 = btn.getBoundingClientRect()
      overlap = Math.hypot(b1.left - b2.left, b1.top - b2.top)
    }
    return {
      stageCls: stage.className,
      hasBadge: !!badge, hasExpand: !!btn, overlap,
      badgeText: badge ? badge.textContent.trim() : '', btnText: btn ? btn.textContent.trim() : '',
      badgeVisibleLive: badge ? getComputedStyle(badge).display : '',
    }
  })
  console.log('  st =', JSON.stringify(st), 'afCls =', afCls)
  ok('AF 卡同时存在图片角标与 3D 放大按钮（复现「两个放大按钮」）', st.hasBadge && st.hasExpand && st.overlap !== null && st.overlap < 30, `overlap=${st.overlap}`)
  await page.locator('.af-stage').hover()
  await page.waitForTimeout(300)
  await page.screenshot({ path: '/tmp/zoom-shots/diag-af-dual-buttons.jpg', type: 'jpeg', quality: 70 })
  await ctx.close()
}

// ── C. 嵌入形态回归（v2.7.7 逻辑）──────────────────────────────────────────
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await ctx.route('**://fonts.googleapis.com/**', r => r.abort())
  await ctx.route('**://fonts.gstatic.com/**', r => r.abort())
  await ctx.route('**://3Dmol.org/**', r => r.abort())
  const page = await ctx.newPage()
  await page.goto('file:///tmp/zoom-fixtures/embed-host.html', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForFunction(() => document.getElementById('rf').getAttribute('data-ready') === '1', null, { timeout: 20000 })
  await page.waitForTimeout(500)
  const fr = page.frames().find(f => f !== page.mainFrame())
  const imgLoc = fr.locator('.lig-struct img.rpt-zoomable').first()
  await imgLoc.scrollIntoViewIfNeeded()
  await page.waitForTimeout(250)
  await imgLoc.click()
  await page.waitForTimeout(300)
  console.log('\n── C. 嵌入形态：灯箱几何 + 滚轮 ──')
  const geo = await page.evaluate(() => {
    const f = document.getElementById('rf')
    const d = f.contentDocument
    const root = d.querySelector('.rpt-zoom')
    if (!root || root.hidden) return { open: false }
    const frt = f.getBoundingClientRect().top
    const rr = root.getBoundingClientRect()
    const close = root.querySelector('.rpt-zoom-close').getBoundingClientRect()
    return { open: true, position: getComputedStyle(root).position, topHost: frt + rr.top, h: rr.height, closeTopHost: frt + close.top, vh: window.innerHeight }
  })
  console.log('  geo =', JSON.stringify(geo))
  ok('嵌入灯箱贴合屏幕切片', geo.open && geo.position === 'absolute' && Math.abs(geo.topHost) <= 2 && Math.abs(geo.h - geo.vh) <= 2)
  ok('嵌入关闭按钮在屏幕顶部可达', geo.closeTopHost >= -2 && geo.closeTopHost <= 60, `closeTopHost=${geo.closeTopHost}`)
  const y0 = await page.evaluate(() => window.scrollY)
  await page.mouse.move(720, 400)
  await page.mouse.wheel(0, -240)
  await page.waitForTimeout(250)
  const y1 = await page.evaluate(() => window.scrollY)
  ok('嵌入灯箱内滚轮 → 父页不滚动', y1 === y0, `parent scrollY ${y0} -> ${y1}`)
  await page.keyboard.press('Escape')
  await ctx.close()
}

await browser.close()
console.log(`\n${pass}/${pass + fail} passed${fail ? `（${fail} FAILED — 复现了用户问题）` : ''}`)
process.exit(fail ? 1 : 0)
