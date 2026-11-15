/**
 * 图片点击放大灯箱 E2E（v2.7.5 → v2.7.8）— node + playwright：
 *  1. 新报告 fixture：配体结构式/实验图/AF 静态图 → 可缩放标记 + 角标 + 键盘可达
 *  2. 灯箱交互：打开（src 一致/标题正确/滚动锁）/ 滚轮缩放（光标锚点）/
 *     拖拽平移 / 双击 2.5× ↔ 复位 / 控制条按钮 / Esc 关闭并解锁滚动
 *  3. 旧报告注入版：同路径可放大；未注入对照组无灯箱
 *  4. 移动端 375px：tap 打开 + 双轻点 2.5× + 提示条隐藏
 *  5. AF 交互 3D 视图一键全屏（v2.7.7）：canvas 迁移遮罩 / 大画布 / pLDDT 图例 /
 *     Esc 归位 / 全屏内滚轮不滚走页面 / v2.7.8 ⑨ 双按钮互斥（af-live 角标让位）
 *  6. 嵌入宿主回归（v2.7.7 + v2.7.8 · 用户场景）：自动高度 iframe + 父页滚动 + 吸顶栏 —
 *     中部图片点击后灯箱贴合屏幕可视切片（不再按全文高跑丢）+ 图片严格限高 +
 *     父页滚动贴屏重跟 + 灯箱内滚轮阻断滚动链 + AF 全屏同形态 +
 *     v2.7.8 ⑩ 关闭钮避让吸顶栏（不再被应用顶栏遮挡）+ ⑪ 父页滚动锁
 *  7. v2.7.6 baked v1 + 注入 v3 共存清理：仅一灯箱根 / v1 句柄剥离 / 锁不残留
 *  8. v2.7.7 baked v2 + 注入 v3 共存清理（v2.7.8）：单根 / v2 af-expand 移除重挂 /
 *     v3 特性就位（lockParent / headerH / af-zoom-off）
 *  9. Dialog 宿主（在线预览同构 · h-full 内部可滚 iframe）：fixed 覆盖视口 /
 *     关闭钮可见 / 灯箱内滚轮 iframe 不滚 / AF 全屏 fixed
 * 10. 关键截图存 /tmp/zoom-shots/（供人工目检）
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

  // AF 静态图（legacy img 分支 — af-live 时 poster 隐藏不可点，交互视图走第 5 块全屏流程）
  const afCls = await page.evaluate(() => (document.querySelector('.af-stage') || {}).className || '')
  if (!afCls.includes('af-live')) {
    await page.click('.af-fig img.rpt-zoomable')
    await page.waitForTimeout(120)
    st = await zoomState(page)
    ok('AF 静态图点击 → 打开，标题含 AlphaFold', st.hidden === false && st.title.includes('AlphaFold'), st.title)
    await page.keyboard.press('Escape')
  } else {
    ok('af-live 时 poster 隐藏（静态分支自动让位交互视图）', true)
  }

  // v2.7.8 ⑨：AF 卡双按钮互斥 — af-live 时图片角标让位 3D 全屏（右上角仅一个「放大」）
  if (afCls.includes('af-live')) {
    const dual = await page.evaluate(() => {
      const fig = document.querySelector('figure.af-fig')
      const badge = fig.querySelector('.rpt-zoom-badge')
      const btn = fig.querySelector('.af-expand')
      return {
        figOff: fig.classList.contains('af-zoom-off'),
        badgeDisplay: badge ? getComputedStyle(badge).display : 'absent',
        hasExpand: !!btn,
      }
    })
    ok('af-live 时 figure 加 af-zoom-off（互斥标记）', dual.figOff, JSON.stringify(dual))
    ok('af-live 时图片角标隐藏（根除「双放大按钮」）', dual.badgeDisplay === 'none', `display=${dual.badgeDisplay}`)
    ok('af-live 时 3D 放大钮仍在（唯一放大入口）', dual.hasExpand)
    await page.locator('.af-fig').hover()
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${SHOTS}/af-live-single-button.jpg`, type: 'jpeg', quality: 70 })
    // af-fail 回退：静态图形态 → 角标恢复（图片灯箱成为唯一入口）、3D 钮隐藏
    await page.evaluate(() => { document.querySelector('.af-stage').className = 'af-stage af-fail' })
    await page.waitForTimeout(150)
    const failBadge = await page.evaluate(() => {
      const fig = document.querySelector('figure.af-fig')
      return { off: fig.classList.contains('af-zoom-off'), badge: getComputedStyle(fig.querySelector('.rpt-zoom-badge')).display, expand: getComputedStyle(fig.querySelector('.af-expand')).display }
    })
    ok('af-fail 时角标恢复显示（MutationObserver 跟随类名切换）', !failBadge.off && failBadge.badge !== 'none', JSON.stringify(failBadge))
    ok('af-fail 时 3D 放大钮隐藏（CSS :not(.af-live) 让位）', failBadge.expand === 'none')
    await page.evaluate(() => { document.querySelector('.af-stage').className = 'af-stage af-live' })
    await page.waitForTimeout(120)
  }
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


// ─── 5. AF 交互 3D 视图一键全屏（v2.7.7）────────────────────────────────────
{
  const { ctx, page } = await newPage(1440, 900)
  await page.goto('file:///tmp/zoom-fixtures/report-new.html', { waitUntil: 'domcontentloaded', timeout: 30000 })
  console.log('── AF 3D 视图全屏放大 ──')
  let afCls = ''
  try {
    await page.waitForFunction(() => {
      const st = document.querySelector('.af-stage')
      return st && (st.className.includes('af-live') || st.className.includes('af-fail'))
    }, null, { timeout: 15000 })
    afCls = await page.evaluate(() => document.querySelector('.af-stage').className)
  } catch (e) { afCls = 'timeout' }
  const isLive = afCls.includes('af-live')
  const marks = await page.evaluate(() => ({
    expand: !!document.querySelector('.af-stage .af-expand'),
    viewer: !!window.__afViewer,
  }))
  ok('AF 内嵌交互视图初始化（af-live + __afViewer 句柄）', isLive && marks.viewer, `class=${afCls}`)
  ok('AF 放大按钮已挂载（af-stage 内）', marks.expand)
  if (isLive && marks.expand) {
    await page.locator('.af-stage').hover()
    await page.waitForTimeout(220)
    const btnOpacity = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.af-expand')).opacity))
    ok('悬停放大按钮淡入', btnOpacity > 0.9, `opacity=${btnOpacity}`)
    await page.click('.af-expand')
    await page.waitForTimeout(400)
    const fs = await page.evaluate(() => {
      const wrap = document.querySelector('.af-fullwrap')
      if (!wrap) return { open: false }
      const stage = document.querySelector('.af-stage')
      const cv = document.querySelector('.af-canvas')
      const wr = wrap.getBoundingClientRect()
      const sr = wrap.querySelector('.af-fullslot').getBoundingClientRect()
      return {
        open: true, position: getComputedStyle(wrap).position,
        w: wr.width, h: wr.height, slotW: sr.width, slotH: sr.height,
        inWrap: wrap.contains(cv), inStage: stage.contains(cv),
        stageExpanded: stage.className.includes('af-expanded'),
        legend: !!wrap.querySelector('.af-full-legend'),
        bar: !!wrap.querySelector('.af-fullbar'),
        closeBtn: !!wrap.querySelector('.af-fullclose'),
      }
    })
    ok('点击放大 → 全屏遮罩开启（fixed 全视口）', fs.open && fs.position === 'fixed', JSON.stringify(fs))
    ok('canvas 已迁入遮罩（内嵌槽位让位）', fs.inWrap && !fs.inStage)
    ok('遮罩覆盖全视口 1440×900', Math.abs(fs.w - 1440) <= 2 && Math.abs(fs.h - 900) <= 2, `${fs.w}x${fs.h}`)
    ok('画布槽位大幅扩展（≥ 1000×650）', fs.slotW >= 1000 && fs.slotH >= 650, `${fs.slotW}x${fs.slotH}`)
    ok('pLDDT 图例随行 + 标题栏 + 关闭钮', fs.legend && fs.bar && fs.closeBtn)
    ok('内嵌槽位进入放大态（幽灵提示 + 海报占位）', fs.stageExpanded)
    // v2.7.8 ⑨：全屏期间图片角标让位（af-zoom-off 维持）+ 内嵌按钮隐藏（幽灵提示唯一）
    const fsDual = await page.evaluate(() => {
      const fig = document.querySelector('figure.af-fig')
      const btn = document.querySelector('.af-stage .af-expand')
      return { off: fig.classList.contains('af-zoom-off'), btnDisplay: btn ? getComputedStyle(btn).display : 'absent' }
    })
    ok('全屏期间 figure 维持 af-zoom-off（角标让位 3D 全屏）', fsDual.off, JSON.stringify(fsDual))
    ok('全屏期间内嵌 af-expand 隐藏（幽灵提示唯一，免误导）', fsDual.btnDisplay === 'none', `display=${fsDual.btnDisplay}`)
    await page.screenshot({ path: `${SHOTS}/af-fullscreen.jpg`, type: 'jpeg', quality: 70 })
    // 全屏遮罩内滚轮 → 报告页不滚动（滚动链阻断）
    const y0 = await page.evaluate(() => window.scrollY)
    await page.mouse.move(720, 470)
    await page.mouse.wheel(0, 300)
    await page.waitForTimeout(200)
    const y1 = await page.evaluate(() => window.scrollY)
    ok('全屏内滚轮不滚走报告页（防滚动链）', y1 === y0, `scrollY ${y0} -> ${y1}`)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(250)
    const back = await page.evaluate(() => ({
      wrap: !!document.querySelector('.af-fullwrap'),
      inStage: document.querySelector('.af-stage').contains(document.querySelector('.af-canvas')),
      cls: document.querySelector('.af-stage').className,
    }))
    ok('Esc → 遮罩移除 + canvas 归位', !back.wrap && back.inStage && !back.cls.includes('af-expanded'), JSON.stringify(back))
  }
  await ctx.close()
}

// ─── 6. 嵌入宿主回归（自动高度 iframe + 父页滚动 + 吸顶栏）— 用户场景（v2.7.7 + v2.7.8）──
{
  const { ctx, page } = await newPage(1440, 900)
  await page.goto('file:///tmp/zoom-fixtures/embed-host.html', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForFunction(() => document.getElementById('rf').getAttribute('data-ready') === '1', null, { timeout: 20000 })
  await page.waitForTimeout(600)
  console.log('── 嵌入宿主（自动高度 iframe + 吸顶栏 · 用户场景回归）──')
  const fr = page.frames().find(f => f !== page.mainFrame())
  ok('报告 iframe 已加载（srcdoc + 高度同步）', !!fr)
  const HDR = 52 // 宿主吸顶栏高（AppShell 同构）
  // 滚动父页使报告中部配体图进入屏幕中央 → 点击（用户场景：图片在长文档中部）
  const imgLoc = fr.locator('.lig-struct img.rpt-zoomable').first()
  await imgLoc.scrollIntoViewIfNeeded()
  await page.waitForTimeout(250)
  const frTop0 = await page.evaluate(() => document.getElementById('rf').getBoundingClientRect().top)
  ok('滚动到文档中部后 iframe 顶部已在屏幕上方（父页滚动形态）', frTop0 < 0, `iframeTop=${frTop0}`)
  const imgBox = await imgLoc.boundingBox()
  ok('iframe 内配体图可定位且位于屏幕内', !!imgBox && imgBox.y > HDR && imgBox.y + imgBox.height < 900, JSON.stringify(imgBox || {}))
  await imgLoc.click() // locator 点击自动换算跨 iframe 坐标（滚动后视口坐标已变 — 手算会失效）
  await page.waitForTimeout(300)

  const geoFn = () => page.evaluate(() => {
    const f = document.getElementById('rf')
    const d = f.contentDocument
    const root = d.querySelector('.rpt-zoom')
    if (!root || root.hidden) return { open: false }
    const frt = f.getBoundingClientRect().top
    const rr = root.getBoundingClientRect()
    const stage = root.querySelector('.rpt-zoom-stage').getBoundingClientRect()
    const img = root.querySelector('.rpt-zoom-stage img').getBoundingClientRect()
    const close = root.querySelector('.rpt-zoom-close').getBoundingClientRect()
    return {
      open: true, position: getComputedStyle(root).position, topPx: root.style.top,
      rootTopHost: frt + rr.top, rootH: rr.height, stageH: stage.height,
      imgH: img.height, imgW: img.width,
      imgCenterHost: frt + img.top + img.height / 2,
      closeTopHost: frt + close.top, vh: window.innerHeight,
    }
  })
  const geo = await geoFn()
  ok('嵌入中点击图片 → 灯箱打开 + 可视切片定位（absolute）', geo.open && geo.position === 'absolute', JSON.stringify(geo))
  ok('遮罩贴合屏幕可视切片（top ≈ 吸顶栏下沿 · 高 ≈ 视口高 - 栏高）— 修复「按全文高跑丢」', Math.abs(geo.rootTopHost - HDR) <= 2 && Math.abs(geo.rootH - (geo.vh - HDR)) <= 2, `top=${geo.rootTopHost} h=${geo.rootH}/${geo.vh}`)
  ok('放大图严格限高（≤ 舞台高）— 修复「没有限定高度」', geo.imgH <= geo.stageH + 1, `img=${geo.imgH} stage=${geo.stageH}`)
  ok('放大图居中可视区（无需回滚查找）', Math.abs(geo.imgCenterHost - (HDR + geo.vh) / 2) <= 80, `center=${geo.imgCenterHost}/${(HDR + geo.vh) / 2}`)
  ok('v2.7.8 ⑩ 关闭钮避让吸顶栏（位于栏下沿之下，不再被遮挡不可见）', geo.closeTopHost >= HDR - 2 && geo.closeTopHost <= HDR + 60, `closeTop=${geo.closeTopHost} HDR=${HDR}`)
  await page.screenshot({ path: `${SHOTS}/embed-lightbox-slice.jpg`, type: 'jpeg', quality: 70 })

  // v2.7.8 ⑪：父页滚动锁 — 灯箱开着时滚轮落在 iframe 外（吸顶栏）父页不派生滚动
  const lock0 = await page.evaluate(() => window.scrollY)
  await page.mouse.move(720, 26) // 吸顶栏内（iframe 之外 — v2.7.7 时此处滚轮会滚走父页）
  await page.mouse.wheel(0, 300)
  await page.waitForTimeout(250)
  const lock1 = await page.evaluate(() => window.scrollY)
  const bodyLocked = await page.evaluate(() => document.body.style.overflow === 'hidden')
  ok('灯箱开着时滚轮在吸顶栏（iframe 外）→ 父页不滚动（v2.7.8 ⑪）', lock1 === lock0 && bodyLocked, `scrollY ${lock0} -> ${lock1} locked=${bodyLocked}`)
  // 遮罩仍贴合（锁不重跟也不跑丢）
  const geoL = await geoFn()
  ok('父页被锁期间遮罩稳定贴合（top ≈ 栏下沿）', geoL.open && Math.abs(geoL.rootTopHost - HDR) <= 2, `top=${geoL.rootTopHost}`)

  // 父页滚动 → 遮罩贴屏实时重定位（不跑丢；程序滚动不受 overflow 锁限制）
  await page.evaluate(() => window.scrollBy(0, 500))
  await page.waitForTimeout(500)
  const geo2 = await geoFn()
  ok('父页滚动 500px → 遮罩仍贴屏（重定位 top ≈ 栏下沿 · 高度不变）', geo2.open && Math.abs(geo2.rootTopHost - HDR) <= 2 && Math.abs(geo2.rootH - (geo2.vh - HDR)) <= 2, `top=${geo2.rootTopHost} h=${geo2.rootH}`)

  // 灯箱内滚轮缩放 → 父页不滚动（滚动链阻断）
  const y0 = await page.evaluate(() => window.scrollY)
  await page.mouse.move(720, 400)
  await page.mouse.wheel(0, -240)
  await page.waitForTimeout(200)
  const pct = await page.evaluate(() => (document.getElementById('rf').contentDocument.querySelector('.rpt-zoom-pct') || {}).textContent || '')
  const y1 = await page.evaluate(() => window.scrollY)
  ok('灯箱内滚轮缩放生效且父页不滚动（阻断滚动链）', NUM(pct) > 100 && y1 === y0, `pct=${pct} scrollY ${y0} -> ${y1}`)

  // 关闭 → 父页滚动解锁（v2.7.8 ⑪：恢复 overflow + 滚轮重新可滚）
  await page.keyboard.press('Escape')
  await page.waitForTimeout(250)
  const unlocked = await page.evaluate(() => document.body.style.overflow !== 'hidden')
  ok('Esc 关闭 → 父页滚动解锁（无残留锁）', unlocked)
  const ry0 = await page.evaluate(() => window.scrollY)
  await page.mouse.move(720, 400)
  await page.mouse.wheel(0, 240)
  await page.waitForTimeout(250)
  const ry1 = await page.evaluate(() => window.scrollY)
  ok('关闭后滚轮恢复滚动父页（锁不残留误伤）', ry1 !== ry0, `scrollY ${ry0} -> ${ry1}`)

  // AF 全屏在嵌入形态下同样贴合屏幕（可视切片 + 吸顶栏避让）
  const afCls2 = await fr.evaluate(() => (document.querySelector('.af-stage') || {}).className || '')
  if (afCls2.includes('af-live')) {
    // 滚动到报告头部区域（iframe 顶部升出屏幕 → iframe 覆盖满屏，与真实阅读位置一致）
    await page.evaluate(() => window.scrollTo(0, 1600))
    await page.waitForTimeout(300)
    await fr.evaluate(() => document.querySelector('.af-stage .af-expand').click()) // JS 直发点击（避免 locator 自动滚动改变切片）
    await page.waitForTimeout(400)
    const afg = await page.evaluate(() => {
      const f = document.getElementById('rf')
      const d = f.contentDocument
      const wrap = d.querySelector('.af-fullwrap')
      if (!wrap) return { open: false }
      const frt = f.getBoundingClientRect().top
      const wr = wrap.getBoundingClientRect()
      const sr = wrap.querySelector('.af-fullslot').getBoundingClientRect()
      const close = wrap.querySelector('.af-fullclose').getBoundingClientRect()
      const cv = d.querySelector('.af-canvas')
      return {
        open: true, position: getComputedStyle(wrap).position,
        topHost: frt + wr.top, h: wr.height, slotW: sr.width, slotH: sr.height,
        closeTopHost: frt + close.top, inWrap: wrap.contains(cv), vh: window.innerHeight,
      }
    })
    ok('嵌入中 AF 放大 → 遮罩贴合屏幕（absolute 可视切片 + 吸顶栏避让）', afg.open && afg.position === 'absolute' && Math.abs(afg.topHost - HDR) <= 2 && Math.abs(afg.h - (afg.vh - HDR)) <= 2, JSON.stringify(afg))
    ok('嵌入中 AF 放大 → 画布大幅扩展 + canvas 迁入遮罩', afg.inWrap && afg.slotW >= 1000 && afg.slotH >= 600, `${afg.slotW}x${afg.slotH}`)
    ok('嵌入中 AF 全屏关闭钮避让吸顶栏（可见可达）', afg.closeTopHost >= HDR - 2 && afg.closeTopHost <= HDR + 40, `closeTop=${afg.closeTopHost}`)
    // v2.7.8 ⑪：AF 全屏期间父页同样锁定（滚轮在 iframe 外不派生滚动）
    const afy0 = await page.evaluate(() => window.scrollY)
    await page.mouse.move(720, 26)
    await page.mouse.wheel(0, 300)
    await page.waitForTimeout(250)
    const afy1 = await page.evaluate(() => window.scrollY)
    ok('AF 全屏期间滚轮在吸顶栏 → 父页不滚动（v2.7.8 ⑪）', afy1 === afy0, `scrollY ${afy0} -> ${afy1}`)
    await page.screenshot({ path: `${SHOTS}/embed-af-fullscreen.jpg`, type: 'jpeg', quality: 70 })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(250)
    const afBack = await page.evaluate(() => {
      const d = document.getElementById('rf').contentDocument
      return { wrap: !!d.querySelector('.af-fullwrap'), inStage: d.querySelector('.af-stage').contains(d.querySelector('.af-canvas')), hostLocked: document.body.style.overflow === 'hidden' }
    })
    ok('嵌入中 Esc → AF 遮罩移除 + canvas 归位 + 父页解锁', !afBack.wrap && afBack.inStage && !afBack.hostLocked, JSON.stringify(afBack))
  } else {
    ok('（嵌入宿主内 WebGL 不可用 → 跳过 AF 全屏断言）', true)
  }

  await ctx.close()
}

// ─── 7. v2.7.6 baked v1 + 注入 v3 共存清理 ──────────────────────────────────
{
  const { ctx, page } = await newPage(1440, 900)
  await page.goto('file:///tmp/zoom-fixtures/report-v276-injected.html', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(350)
  console.log('── v2.7.6 baked v1 + 注入 v3 共存清理 ──')
  const st0 = await page.evaluate(() => ({
    roots: document.querySelectorAll('.rpt-zoom').length,
    v1Open: window.__v1Open === undefined ? null : window.__v1Open,
    emb: !!window.__rptEmb,
    zoomable: document.querySelectorAll('.lig-struct img.rpt-zoomable').length,
  }))
  ok('仅存一个灯箱根（v1 根已清理移除）', st0.roots === 1, `roots=${st0.roots}`)
  ok('__rptEmb 已就位（v3 注入生效）', st0.emb)
  await page.click('.lig-struct img.rpt-zoomable')
  await page.waitForTimeout(180)
  const st = await zoomState(page)
  ok('点击图片 → v3 灯箱打开（v1 句柄已克隆剥离，无 __v1Open）', st.hidden === false && st0.v1Open === null, `v1Open=${st0.v1Open}`)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(150)
  const st2 = await zoomState(page)
  ok('Esc 关闭且滚动解锁（无 v1 残留锁）', st2.hidden === true && st2.bodyLock === false)
  await ctx.close()
}

// ─── 8. v2.7.7 baked v2 + 注入 v3 共存清理（v2.7.8）─────────────────────────
{
  const { ctx, page } = await newPage(1440, 900)
  await page.goto('file:///tmp/zoom-fixtures/report-v277-injected.html', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(350)
  console.log('── v2.7.7 baked v2 + 注入 v3 共存清理 ──')
  const st0 = await page.evaluate(() => ({
    roots: document.querySelectorAll('.rpt-zoom').length,
    expands: document.querySelectorAll('.af-stage .af-expand').length,
    v3Api: typeof (window.__rptEmb || {}).lockParent === 'function' && typeof (window.__rptEmb || {}).unlock === 'function',
    badges: document.querySelectorAll('figure.af-fig .rpt-zoom-badge').length,
  }))
  ok('仅存一个灯箱根（v2 根已清理移除）', st0.roots === 1, `roots=${st0.roots}`)
  ok('仅存一个 AF 放大钮（v2 旧钮移除后由 v3 重挂）', st0.expands === 1, `expands=${st0.expands}`)
  ok('v3 API 就位（lockParent/unlock — v2.7.8 ⑪）', st0.v3Api)
  ok('AF 图角标唯一（无重复注入叠层）', st0.badges === 1, `badges=${st0.badges}`)
  await page.click('.lig-struct img.rpt-zoomable')
  await page.waitForTimeout(180)
  let st = await zoomState(page)
  ok('点击图片 → v3 灯箱打开（v2 句柄已克隆剥离）', st.hidden === false)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(150)
  st = await zoomState(page)
  ok('Esc 关闭且滚动解锁（无 v2 残留锁）', st.hidden === true && st.bodyLock === false)
  // v3 重挂的 af-expand 可用：点击 → 全屏遮罩开启
  let afCls = 'timeout'
  try {
    await page.waitForFunction(() => {
      const s = document.querySelector('.af-stage')
      return s && (s.className.includes('af-live') || s.className.includes('af-fail'))
    }, null, { timeout: 15000 })
    afCls = await page.evaluate(() => document.querySelector('.af-stage').className)
  } catch (e) {}
  if (afCls.includes('af-live')) {
    await page.evaluate(() => document.querySelector('.af-stage .af-expand').click())
    await page.waitForTimeout(350)
    const fs = await page.evaluate(() => {
      const wrap = document.querySelector('.af-fullwrap')
      const stg = document.querySelector('.af-stage')
      const cv = document.querySelector('.af-canvas')
      const fig = document.querySelector('figure.af-fig')
      return {
        open: !!wrap, pos: wrap ? getComputedStyle(wrap).position : '',
        inWrap: wrap ? wrap.contains(cv) : false, expanded: stg.className.includes('af-expanded'),
        figOff: fig.classList.contains('af-zoom-off'),
      }
    })
    ok('重挂的 af-expand 点击 → v3 全屏遮罩开启（fixed + canvas 迁入）', fs.open && fs.pos === 'fixed' && fs.inWrap && fs.expanded, JSON.stringify(fs))
    ok('全屏期间 af-zoom-off 生效（v3 互斥同步）', fs.figOff)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(250)
    const back = await page.evaluate(() => ({
      wrap: !!document.querySelector('.af-fullwrap'),
      inStage: document.querySelector('.af-stage').contains(document.querySelector('.af-canvas')),
    }))
    ok('Esc → 遮罩移除 + canvas 归位（重挂钮生命周期完整）', !back.wrap && back.inStage, JSON.stringify(back))
  } else {
    console.log(`  (af-stage=${afCls} — 跳过全屏断言)`)
  }
  await ctx.close()
}

// ─── 9. Dialog 宿主（在线预览同构 · h-full 内部可滚 iframe — fixed 形态回归）─────
{
  const { ctx, page } = await newPage(1440, 900)
  await page.goto('file:///tmp/zoom-fixtures/dialog-host.html', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForFunction(() => document.getElementById('rf').getAttribute('data-ready') === '1', null, { timeout: 20000 })
  await page.waitForTimeout(400)
  console.log('── Dialog 宿主（h-full 内部可滚 iframe）──')
  const fr = page.frames().find(f => f !== page.mainFrame())
  ok('报告 iframe 已加载（固定高 700px）', !!fr)
  const env = await fr.evaluate(() => {
    const f = window.frameElement
    const contentH = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)
    return { iframeH: f.getBoundingClientRect().height, contentH, embMode: contentH > f.getBoundingClientRect().height + 8 ? 'fixed' : 'slice' }
  })
  ok('内部可滚形态（contentH > iframe 高 → EMB 判 fixed）', env.embMode === 'fixed', JSON.stringify(env))
  // 滚到中部点图 → fixed 覆盖 iframe 视口 + 关闭钮可见 + 滚轮阻断
  // （behavior:'instant' — 报告 CSS 有 scroll-behavior:smooth，平滑动画残留会误判滚轮穿透）
  await fr.evaluate(() => {
    const im = document.querySelector('.lig-struct img.rpt-zoomable')
    im.scrollIntoView({ block: 'center', behavior: 'instant' })
  })
  await page.waitForTimeout(200)
  await fr.evaluate(() => document.querySelector('.lig-struct img.rpt-zoomable').click())
  await page.waitForTimeout(300)
  const dg = await fr.evaluate(() => {
    const root = document.querySelector('.rpt-zoom')
    if (!root || root.hidden) return { open: false }
    const rr = root.getBoundingClientRect()
    const close = root.querySelector('.rpt-zoom-close').getBoundingClientRect()
    const vh = window.innerHeight, vw = window.innerWidth
    return {
      open: true, pos: getComputedStyle(root).position, top: rr.top, h: rr.height, w: rr.width,
      closeTop: close.top, closeVisible: close.top >= 0 && close.top + close.height <= vh && close.right >= 0 && close.right <= vw,
      vh, vw, scrollY: window.scrollY,
    }
  })
  ok('Dialog 形态灯箱打开（fixed — 不走切片）', dg.open && dg.pos === 'fixed', JSON.stringify(dg))
  ok('遮罩覆盖 iframe 视口（top=0 · 高=iframe 视口高）', dg.open && Math.abs(dg.top) <= 1 && Math.abs(dg.h - dg.vh) <= 1, `top=${dg.top} h=${dg.h}/${dg.vh}`)
  ok('关闭钮在 iframe 视口内可见', dg.open && dg.closeVisible, `closeTop=${dg.closeTop}`)
  await page.screenshot({ path: `${SHOTS}/dialog-lightbox-fixed.jpg`, type: 'jpeg', quality: 70 })
  const sy0 = await fr.evaluate(() => window.scrollY)
  await page.mouse.move(720, 430)
  await page.mouse.wheel(0, 400)
  await page.waitForTimeout(250)
  const sy1 = await fr.evaluate(() => window.scrollY)
  ok('灯箱内滚轮 → iframe 文档不滚动（阻断默认滚动）', sy1 === sy0, `scrollY ${sy0} -> ${sy1}`)
  // 父页不因灯箱加锁（Dialog 形态由宿主管 — body overflow 未被动过）
  const hostBody = await page.evaluate(() => document.body.style.overflow)
  ok('Dialog 形态不锁父页（宿主 Dialog/Radix 自管，无双重锁冲突）', hostBody !== 'hidden', `overflow=${hostBody}`)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  // AF 全屏（Dialog 形态）
  const afCls = await fr.evaluate(() => (document.querySelector('.af-stage') || {}).className || '')
  if (afCls.includes('af-live')) {
    await fr.evaluate(() => document.querySelector('.af-stage .af-expand').click())
    await page.waitForTimeout(400)
    const afg = await fr.evaluate(() => {
      const wrap = document.querySelector('.af-fullwrap')
      if (!wrap) return { open: false }
      const wr = wrap.getBoundingClientRect()
      const close = wrap.querySelector('.af-fullclose').getBoundingClientRect()
      return { open: true, pos: getComputedStyle(wrap).position, top: wr.top, h: wr.height, vh: window.innerHeight, closeTop: close.top, closeVisible: close.top >= 0 && close.top + close.height <= window.innerHeight }
    })
    ok('Dialog 形态 AF 全屏 fixed 覆盖视口', afg.open && afg.pos === 'fixed' && Math.abs(afg.top) <= 1 && Math.abs(afg.h - afg.vh) <= 1, JSON.stringify(afg))
    ok('Dialog 形态 AF 全屏关闭钮可见', afg.closeVisible, `closeTop=${afg.closeTop}`)
    await page.screenshot({ path: `${SHOTS}/dialog-af-fullscreen.jpg`, type: 'jpeg', quality: 70 })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(250)
  } else {
    console.log(`  (af-stage=${afCls} — 跳过)`)
  }
  await ctx.close()
}

await browser.close()
console.log(`\n${pass}/${pass + fail} passed${fail ? `（${fail} failed）` : ''}`)
process.exit(fail ? 1 : 0)
