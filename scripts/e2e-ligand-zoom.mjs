/**
 * 图片点击放大灯箱 E2E（v2.7.5）— node + playwright：
 *  1. 新报告 fixture：配体结构式/实验图/AF 静态图 → 可缩放标记 + 角标 + 键盘可达
 *  2. 灯箱交互：打开（src 一致/标题正确/滚动锁）/ 滚轮缩放（光标锚点）/
 *     拖拽平移 / 双击 2.5× ↔ 复位 / 控制条按钮 / Esc 关闭并解锁滚动
 *  3. 旧报告注入版：同路径可放大；未注入对照组无灯箱
 *  4. 移动端 375px：tap 打开 + 双轻点 2.5× + 提示条隐藏
 *  5. 关键截图存 /tmp/zoom-shots/（供人工目检）
 * 前置：bun scripts/render-zoom-fixtures.ts 已生成 /tmp/zoom-fixtures/
 */
import { chromium } from 'playwright'
import fs from 'node:fs'

const SHOTS = '/tmp/zoom-shots'
fs.mkdirSync(SHOTS, { recursive: true })

let pass = 0, fail = 0
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ← ${detail}`}`)
  cond ? pass++ : fail++
}
const NUM = (s) => parseFloat(String(s).replace(/[^\d.\-]/g, '')) || 0

const browser = await chromium.launch()

async function newPage(w, h, touch = false) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch, isMobile: touch })
  await ctx.route('**://fonts.googleapis.com/**', r => r.abort())
  await ctx.route('**://fonts.gstatic.com/**', r => r.abort())
  await ctx.route('**://3Dmol.org/**', r => r.abort())
  return { ctx, page: await ctx.newPage() }
}

/** 灯箱状态快照 */
async function zoomState(page) {
  return page.evaluate(() => {
    const root = document.querySelector('.rpt-zoom')
    if (!root) return { exists: false }
    const img = root.querySelector('.rpt-zoom-stage img')
    return {
      exists: true,
      hidden: root.hidden,
      src: img ? img.src : '',
      title: (root.querySelector('.rpt-zoom-title') || {}).textContent || '',
      pct: (root.querySelector('.rpt-zoom-pct') || {}).textContent || '',
      transform: img ? img.style.transform : '',
      bodyLock: document.body.style.overflow === 'hidden',
    }
  })
}

// ─── 1+2. 新报告：可缩放标记 + 完整交互 ─────────────────────────────────────
{
  const { ctx, page } = await newPage(1440, 900)
  await page.goto('file:///tmp/zoom-fixtures/report-new.html', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(300)

  console.log('── 新报告：可缩放标记 ──')
  const marks = await page.evaluate(() => ({
    lig: document.querySelectorAll('.lig-struct img.rpt-zoomable').length,
    ligTotal: document.querySelectorAll('.lig-struct img').length,
    fig: document.querySelectorAll('.fig img.rpt-zoomable').length,
    figTotal: document.querySelectorAll('.fig img').length,
    af: document.querySelectorAll('.af-fig img.rpt-zoomable').length,
    badges: document.querySelectorAll('.rpt-zoom-badge').length,
    tab: document.querySelectorAll('img.rpt-zoomable[tabindex="0"]').length,
    title: (document.querySelector('.lig-struct img') || {}).title,
    overlay: !!document.querySelector('.rpt-zoom'),
    overlayHidden: (document.querySelector('.rpt-zoom') || {}).hidden,
  }))
  ok('配体结构式缩略图全部标记可缩放', marks.lig === 2 && marks.lig === marks.ligTotal, JSON.stringify(marks))
  ok('实验图缩略图全部标记可缩放', marks.fig === 2 && marks.fig === marks.figTotal)
  ok('AF 静态图标记可缩放（legacy img 分支）', marks.af === 1)
  ok('每图均有放大角标', marks.badges === 5, `badges=${marks.badges}`)
  ok('全部键盘可达（tabindex=0）', marks.tab === 5, `tab=${marks.tab}`)
  ok('缩略图 title 提示', marks.title === '点击放大查看')
  ok('灯箱 DOM 预建且初始隐藏', marks.overlay && marks.overlayHidden === true)

  // 悬停角标显隐
  const ligImg = page.locator('.lig-struct img.rpt-zoomable').first()
  await ligImg.hover()
  await page.waitForTimeout(300)
  const badgeOpacity = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.lig-struct.rpt-zoomable .rpt-zoom-badge')).opacity))
  ok('悬停后角标淡入（opacity → 1）', badgeOpacity > 0.9, `opacity=${badgeOpacity}`)
  await page.screenshot({ path: `${SHOTS}/ligand-hover-badge.jpg`, type: 'jpeg', quality: 70 })

  console.log('── 新报告：灯箱交互 ──')
  // 点击打开
  await ligImg.click()
  await page.waitForTimeout(150)
  let st = await zoomState(page)
  const thumbSrc = await ligImg.evaluate(el => el.src)
  ok('点击配体图 → 灯箱打开', st.exists && st.hidden === false)
  ok('灯箱展示同一张图（src 一致）', st.src === thumbSrc)
  ok('灯箱标题取自 figcaption（含 2D 结构式 · CID）', st.title.includes('2D 结构式') && st.title.includes('CID 176870'), st.title)
  ok('打开时滚动锁定', st.bodyLock === true)
  ok('初始 100%', st.pct === '100%', st.pct)

  // 滚轮缩放（光标锚定）
  await page.mouse.move(720, 380)
  await page.mouse.wheel(0, -240)
  await page.waitForTimeout(80)
  st = await zoomState(page)
  ok('滚轮上 → 放大（> 100%）', NUM(st.pct) > 100 && st.transform.includes('scale'), `pct=${st.pct} t=${st.transform}`)
  await page.mouse.wheel(0, 480)
  await page.waitForTimeout(80)
  st = await zoomState(page)
  ok('滚轮下 → 回落（≤ 100%）', NUM(st.pct) <= 100, `pct=${st.pct}`)

  // 拖拽平移
  await page.mouse.move(720, 400)
  await page.mouse.down()
  await page.mouse.move(840, 320, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(80)
  st = await zoomState(page)
  const m = st.transform.match(/translate\(([\d.\-]+)px,\s*([\d.\-]+)px\)/)
  ok('拖拽 → 平移（translate 非 0）', !!m && (Math.abs(NUM(m[1])) > 40 || Math.abs(NUM(m[2])) > 20), st.transform)

  // 双击 2.5× ↔ 复位
  await page.mouse.dblclick(720, 400)
  await page.waitForTimeout(80)
  st = await zoomState(page)
  ok('双击 → 2.5×', Math.abs(NUM(st.pct) - 250) <= 1, `pct=${st.pct}`)
  await page.screenshot({ path: `${SHOTS}/lightbox-zoom250.jpg`, type: 'jpeg', quality: 70 })
  await page.mouse.dblclick(760, 420)
  await page.waitForTimeout(80)
  st = await zoomState(page)
  ok('再双击 → 复位 100%', Math.abs(NUM(st.pct) - 100) <= 1, `pct=${st.pct}`)

  // 控制条按钮
  await page.click('.rpt-zoom-ctl button[data-z="in"]')
  await page.waitForTimeout(60)
  st = await zoomState(page)
  ok('控制条 ＋ → 150%', Math.abs(NUM(st.pct) - 150) <= 1, `pct=${st.pct}`)
  await page.click('.rpt-zoom-ctl button[data-z="out"]')
  await page.click('.rpt-zoom-ctl button[data-z="fit"]')
  await page.waitForTimeout(60)
  st = await zoomState(page)
  ok('控制条 1:1 → 复位', Math.abs(NUM(st.pct) - 100) <= 1, `pct=${st.pct}`)

  // Esc 关闭 + 滚动解锁
  await page.keyboard.press('Escape')
  await page.waitForTimeout(100)
  st = await zoomState(page)
  ok('Esc → 关闭', st.hidden === true)
  ok('关闭后滚动解锁', st.bodyLock === false)

  // 键盘可达（Tab 聚焦缩略图 → Enter 打开）
  await ligImg.focus()
  await page.keyboard.press('Enter')
  await page.waitForTimeout(100)
  st = await zoomState(page)
  ok('键盘 Enter → 打开', st.hidden === false)
  await page.keyboard.press('Escape')

  // 实验图（gel）放大 + 标题
  await page.click('.fig img.rpt-zoomable >> nth=0')
  await page.waitForTimeout(120)
  st = await zoomState(page)
  ok('实验图点击 → 打开，标题含 SDS-PAGE', st.hidden === false && st.title.includes('SDS-PAGE'), st.title)
  await page.screenshot({ path: `${SHOTS}/lightbox-fig-gel.jpg`, type: 'jpeg', quality: 70 })
  await page.keyboard.press('Escape')

  // AF 静态图
  await page.click('.af-fig img.rpt-zoomable')
  await page.waitForTimeout(120)
  st = await zoomState(page)
  ok('AF 静态图点击 → 打开，标题含 AlphaFold', st.hidden === false && st.title.includes('AlphaFold'), st.title)
  await page.keyboard.press('Escape')
  await ctx.close()
}

// ─── 3. 旧报告（serve 时注入）与未注入对照 ───────────────────────────────────
{
  const { ctx, page } = await newPage(1440, 900)
  await page.goto('file:///tmp/zoom-fixtures/report-legacy-injected.html', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(250)
  console.log('── 旧报告（注入版）──')
  const ligImg = page.locator('.lig-struct img.rpt-zoomable').first()
  ok('注入版：配体图可缩放标记存在', await ligImg.count() === 1)
  await ligImg.click()
  await page.waitForTimeout(120)
  let st = await zoomState(page)
  ok('注入版：点击打开灯箱', st.hidden === false)
  await page.mouse.move(700, 400)
  await page.mouse.wheel(0, -200)
  await page.waitForTimeout(80)
  st = await zoomState(page)
  ok('注入版：滚轮缩放生效', NUM(st.pct) > 100, `pct=${st.pct}`)
  await page.screenshot({ path: `${SHOTS}/lightbox-legacy-injected.jpg`, type: 'jpeg', quality: 70 })
  await page.keyboard.press('Escape')
  await ctx.close()
}
{
  const { ctx, page } = await newPage(1440, 900)
  await page.goto('file:///tmp/zoom-fixtures/report-legacy.html', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(200)
  console.log('── 旧报告（未注入对照）──')
  const st = await page.evaluate(() => ({
    zoom: !!document.querySelector('.rpt-zoom'),
    zoomable: document.querySelectorAll('.rpt-zoomable').length,
    badge: document.querySelectorAll('.rpt-zoom-badge').length,
  }))
  ok('对照组：无灯箱 DOM / 无可缩放标记 / 无角标', st.zoom === false && st.zoomable === 0 && st.badge === 0, JSON.stringify(st))
  await ctx.close()
}

// ─── 4. 移动端 375px（触屏）────────────────────────────────────────────────
{
  const { ctx, page } = await newPage(375, 720, true)
  await page.goto('file:///tmp/zoom-fixtures/report-new.html', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(300)
  console.log('── 移动端（375 触屏）──')
  const ligImg = page.locator('.lig-struct img.rpt-zoomable').first()
  await ligImg.scrollIntoViewIfNeeded()
  await page.waitForTimeout(250)
  const box = await ligImg.boundingBox()
  ok('配体缩略图可见可点', !!box)
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2
  // 触屏角标常显（hover:none）
  const badgeOpacity = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.lig-struct.rpt-zoomable .rpt-zoom-badge')).opacity))
  ok('触屏角标常显（opacity 高）', badgeOpacity > 0.8, `opacity=${badgeOpacity}`)
  // 轻点打开
  await page.touchscreen.tap(cx, cy)
  await page.waitForTimeout(200)
  let st = await zoomState(page)
  ok('轻点缩略图 → 灯箱打开', st.hidden === false)
  const hintVisible = await page.evaluate(() => {
    const el = document.querySelector('.rpt-zoom-cap .rpt-zoom-hint')
    return el ? getComputedStyle(el).display !== 'none' : null
  })
  ok('小屏提示条隐藏（省空间）', hintVisible === false)
  await page.screenshot({ path: `${SHOTS}/lightbox-mobile-open.jpg`, type: 'jpeg', quality: 70 })
  // 双轻点 → 2.5×（图内同点两次，间隔 < 320ms）
  const stg = await page.evaluate(() => {
    const r = document.querySelector('.rpt-zoom-stage').getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  await page.touchscreen.tap(stg.x, stg.y)
  await page.waitForTimeout(60)
  await page.touchscreen.tap(stg.x, stg.y)
  await page.waitForTimeout(150)
  st = await zoomState(page)
  ok('双轻点 → 2.5×', Math.abs(NUM(st.pct) - 250) <= 1, `pct=${st.pct}`)
  await page.screenshot({ path: `${SHOTS}/lightbox-mobile-zoom.jpg`, type: 'jpeg', quality: 70 })
  // × 关闭
  await page.tap('.rpt-zoom-close')
  await page.waitForTimeout(100)
  st = await zoomState(page)
  ok('× → 关闭', st.hidden === true)
  await ctx.close()
}

await browser.close()
console.log(`\n${pass}/${pass + fail} passed${fail ? `（${fail} failed）` : ''}`)
process.exit(fail ? 1 : 0)
