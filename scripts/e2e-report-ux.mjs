/**
 * 报告六项优化 E2E（v2.7.6）— node + playwright：
 *  1. 新报告 fixture：覆盖率 SVG 轨道可见（rects + 刻度）；复制按钮自动挂载 + 点击复制成功
 *     （clipboard stub 捕获写入值）；表格横滚指示（375px 可滚动亮右缘 → 滚到头熄灭/左缘亮起）；
 *     打印仿真（table auto 布局 / wrap overflow visible / 复制按钮隐藏）
 *  2. 旧报告注入版：复制按钮同路径挂载 + 横滚指示同工作（applyUxUpgrade 注入 JS 生效）
 *  3. 合并报告：配体 2D 结构式可进灯箱放大（SVG 矢量）+ 复制按钮挂载
 *  4. 关键截图存 /tmp/ux-shots/（供人工目检）
 * 前置：bun scripts/render-ux-fixtures.ts 已生成 /tmp/ux-fixtures/
 */
import { chromium } from 'playwright'
import fs from 'node:fs'

const SHOTS = '/tmp/ux-shots'
fs.mkdirSync(SHOTS, { recursive: true })

let pass = 0, fail = 0
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ← ${detail}`}`)
  cond ? pass++ : fail++
}

const browser = await chromium.launch()

async function newPage(w, h, touch = false) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch, isMobile: touch })
  await ctx.route('**://fonts.googleapis.com/**', r => r.abort())
  await ctx.route('**://fonts.gstatic.com/**', r => r.abort())
  await ctx.route('**://3Dmol.org/**', r => r.abort())
  await ctx.addInitScript(() => {
    // clipboard stub：捕获写入值（file:// 无真实剪贴板权限）
    const written = []
    try {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: (t) => { written.push(String(t)); return Promise.resolve(); }, readText: () => Promise.resolve('') },
        configurable: true,
      })
    } catch (e) {}
    window.__copied = written
  })
  return { ctx, page: await ctx.newPage() }
}

// ─── 1. 新报告：覆盖率 SVG + 复制按钮 + 点击复制 ─────────────────────────────
{
  const { ctx, page } = await newPage(1440, 900)
  await page.goto('file:///tmp/ux-fixtures/report-new.html', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(300)

  console.log('── 新报告：覆盖率区段图 ──')
  const cov = await page.evaluate(() => {
    const fig = document.querySelector('.cov-fig')
    const svg = fig ? fig.querySelector('svg') : null
    const rects = svg ? Array.from(svg.querySelectorAll('rect')) : []
    const texts = svg ? Array.from(svg.querySelectorAll('text')) : []
    const r = svg ? svg.getBoundingClientRect() : null
    return {
      exists: !!fig,
      rectCount: rects.length,
      green: rects.filter(x => x.getAttribute('fill') === '#059669').length,
      amber: rects.filter(x => x.getAttribute('fill') === '#d97706').length,
      titles: rects.filter(x => x.querySelector('title')).map(x => x.querySelector('title').textContent),
      tickLabels: texts.map(t => t.textContent).filter(t => t !== 'COVERAGE MAP · 1210 aa'),
      caption: (fig.querySelector('figcaption') || {}).textContent || '',
      w: r ? Math.round(r.width) : 0,
      h: r ? Math.round(r.height) : 0,
      inPdbsSection: !!document.querySelector('#pdbs .cov-fig'),
    }
  })
  ok('覆盖率 figure 存在于 PDB 结构清单章节', cov.exists && cov.inPdbsSection)
  ok('SVG 轨道矩形：1 底 + 1 绿覆盖段 + 2 琥珀未覆盖段', cov.green === 1 && cov.amber === 2, JSON.stringify(cov))
  ok('段悬停 title 明细（713-979 已覆盖 / 1-712 未覆盖）', cov.titles.includes('713-979 · 267 aa 已覆盖') && cov.titles.includes('1-712 · 712 aa 未覆盖'))
  ok('残基刻度 1/303/605/908/1210', cov.tickLabels.join(',') === '1,303,605,908,1210', cov.tickLabels.join(','))
  ok('SVG 满宽自适应（~1272px @1440 视口）', cov.w > 700, `w=${cov.w}`)
  await page.locator('.cov-fig').scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${SHOTS}/01-coverage-map.png`, clip: (await page.locator('.cov-fig').boundingBox()) })

  console.log('── 新报告：InChIKey/SMILES 一键复制 ──')
  const copyBtns = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('.lig-ident .copy-btn'))
    return btns.map(b => ({ label: b.getAttribute('aria-label'), val: (b.getAttribute('data-copy') || '').slice(0, 40), text: b.textContent }))
  })
  ok('复制按钮自动挂载 4 个（2 配体 × InChIKey/SMILES）', copyBtns.length === 4, JSON.stringify(copyBtns))
  ok('InChIKey 按钮带正确 data-copy 值', copyBtns.some(b => b.label === '复制InChIKey' && b.val.startsWith('AAKJLRGG')))
  const firstInchi = page.locator('.lig-ident .copy-btn').first()
  // 标识符在折叠 details 内 — 先展开再点击
  await firstInchi.evaluate(btn => { const d = btn.closest('details'); if (d) d.open = true })
  await firstInchi.scrollIntoViewIfNeeded()
  await firstInchi.click()
  await page.waitForTimeout(200)
  const after = await page.evaluate(() => ({
    copied: (document.querySelector('.lig-ident .copy-btn') || {}).textContent,
    cls: (document.querySelector('.lig-ident .copy-btn') || {}).className,
    wrote: window.__copied,
  }))
  ok('点击复制 → 按钮变「已复制✓」+ clipboard 写入 InChIKey', after.copied === '已复制✓' && after.cls.includes('copied') && after.wrote[0] === 'AAKJLRGGTJKAMG-UHFFFAOYSA-N', JSON.stringify(after))
  await page.waitForTimeout(1700)
  const reverted = await page.evaluate(() => (document.querySelector('.lig-ident .copy-btn') || {}).textContent)
  ok('1.6s 后按钮恢复「复制」', reverted === '复制')
  await page.screenshot({ path: `${SHOTS}/02-copy-btn.png`, clip: (await page.locator('.lig-fold').first().boundingBox()) })

  console.log('── 新报告：SVG 矢量结构式灯箱 ──')
  const svgImg = await page.evaluate(() => {
    const img = document.querySelector('.lig-struct img')
    const r = img.getBoundingClientRect()
    return { src: img.src.slice(0, 30), w: Math.round(r.width), h: Math.round(r.height), zoomable: img.classList.contains('rpt-zoomable') }
  })
  ok('SVG 结构式缩略图 150×150 且可点击放大', svgImg.w === 150 && svgImg.h === 150 && svgImg.zoomable && svgImg.src.startsWith('data:image/svg+xml'), JSON.stringify(svgImg))
  await ctx.close()
}

// ─── 2. 新报告：移动端表格横滚指示 ────────────────────────────────────────────
{
  const { ctx, page } = await newPage(375, 812, true)
  await page.goto('file:///tmp/ux-fixtures/report-new.html', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(300)

  console.log('── 移动端 375px：表格横滚指示 ──')
  const wrap = page.locator('.tbl-wrap').first()
  await wrap.scrollIntoViewIfNeeded()
  await page.waitForTimeout(120)
  const before = await page.evaluate(() => {
    const w = document.querySelector('.tbl-wrap')
    const cs = getComputedStyle(w, '::after')
    return { right: w.classList.contains('rw-right'), left: w.classList.contains('rw-left'), scrollable: w.scrollWidth > w.clientWidth, afterOpacity: cs.opacity }
  })
  ok('856px min-width 表在 375px 视口可横滚', before.scrollable)
  ok('未滚动：右缘指示亮（rw-right + ::after opacity 1）', before.right && before.afterOpacity === '1', JSON.stringify(before))
  await page.evaluate(() => { const w = document.querySelector('.tbl-wrap'); w.scrollLeft = w.scrollWidth; w.dispatchEvent(new Event('scroll')) })
  await page.waitForTimeout(250)
  const afterScroll = await page.evaluate(() => {
    const w = document.querySelector('.tbl-wrap')
    return { right: w.classList.contains('rw-right'), left: w.classList.contains('rw-left') }
  })
  ok('滚到最右：右缘熄灭、左缘亮起（rw-left）', !afterScroll.right && afterScroll.left, JSON.stringify(afterScroll))
  await page.screenshot({ path: `${SHOTS}/03-table-scroll-indicator.png`, clip: (await wrap.boundingBox()) })
  await ctx.close()
}

// ─── 3. 新报告：打印仿真（emulateMedia print）────────────────────────────────
{
  const { ctx, page } = await newPage(1440, 900)
  await page.goto('file:///tmp/ux-fixtures/report-new.html', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(300)
  await page.emulateMedia({ media: 'print' })
  await page.waitForTimeout(150)
  const pr = await page.evaluate(() => {
    const w = document.querySelector('.tbl-wrap')
    const t = document.querySelector('table.tbl-data')
    const btn = document.querySelector('.lig-ident .copy-btn')
    const cov = document.querySelector('.cov-fig svg')
    return {
      wrapOverflow: getComputedStyle(w).overflow,
      tableLayout: getComputedStyle(t).tableLayout,
      tableMinW: getComputedStyle(t).minWidth,
      btnDisplay: btn ? getComputedStyle(btn).display : 'none-found',
      covDisplay: getComputedStyle(cov).display,
    }
  })
  ok('打印：数据表自动布局 + min-width 解除', pr.tableLayout === 'auto' && pr.tableMinW === '0px', JSON.stringify(pr))
  ok('打印：表格容器 overflow 可见（不裁切列）', pr.wrapOverflow === 'visible')
  ok('打印：复制按钮隐藏', pr.btnDisplay === 'none')
  ok('打印：覆盖率 SVG 保留', pr.covDisplay === 'block')
  await page.emulateMedia({ media: 'screen' })
  await ctx.close()
}

// ─── 4. 旧报告注入版：复制按钮 + 横滚指示同工作 ───────────────────────────────
{
  const { ctx, page } = await newPage(1440, 900)
  await page.goto('file:///tmp/ux-fixtures/report-legacy-injected.html', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(300)
  console.log('── 旧报告注入版：UX 注入生效 ──')
  const inj = await page.evaluate(() => ({
    btns: document.querySelectorAll('.lig-ident .copy-btn').length,
    injectedStyle: !!document.querySelector('style#rpt-ux'),
    injectedScript: document.body.innerHTML.includes('rpt-ux-v1 InChIKey/SMILES'),
    covFig: !!document.querySelector('.cov-fig'), // 旧报告无服务端覆盖率图 — 注入版也不应凭空出现
  }))
  ok('注入版复制按钮挂载 4 个（无服务端改 HTML）', inj.btns === 4, JSON.stringify(inj))
  ok('注入版 style#rpt-ux + UX JS 就位', inj.injectedStyle && inj.injectedScript)
  ok('注入版无覆盖率图（数据不在 HTML — 仅新报告渲染）', !inj.covFig)
  const btn = page.locator('.lig-ident .copy-btn').nth(1)
  await btn.evaluate(b => { const d = b.closest('details'); if (d) d.open = true })
  await btn.scrollIntoViewIfNeeded()
  await btn.click()
  await page.waitForTimeout(200)
  const copied = await page.evaluate(() => ({
    text: (document.querySelectorAll('.lig-ident .copy-btn')[1] || {}).textContent,
    wrote: window.__copied,
  }))
  ok('注入版点击复制生效（SMILES 写入剪贴板）', copied.text === '已复制✓' && (copied.wrote[0] || '').startsWith('COCCOC'), JSON.stringify(copied))
  await ctx.close()
}

// ─── 5. 合并报告：配体 2D 结构式 + 灯箱 + 复制 ────────────────────────────────
{
  const { ctx, page } = await newPage(1440, 900)
  await page.goto('file:///tmp/ux-fixtures/report-merged.html', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(300)
  console.log('── 合并报告：配体卡 2D 图 ──')
  const m = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('.lig-struct img'))
    return {
      figs: imgs.length,
      svg: imgs.filter(i => i.src.startsWith('data:image/svg+xml')).length,
      png: imgs.filter(i => i.src.startsWith('data:image/png')).length,
      zoomable: imgs.filter(i => i.classList.contains('rpt-zoomable')).length,
      copyBtns: document.querySelectorAll('.lig-ident .copy-btn').length,
      props: document.querySelectorAll('.lig-props').length,
    }
  })
  ok('合并报告配体 2D 图：2 张全 SVG（磁盘缓存回补）且全部可灯箱放大', m.figs === 2 && m.svg === 2 && m.zoomable === 2, JSON.stringify(m))
  ok('合并报告复制按钮挂载 4 个 + 性质 chips', m.copyBtns === 4 && m.props === 2, JSON.stringify(m))
  await page.locator('.lig-struct img').first().scrollIntoViewIfNeeded()
  await page.locator('.lig-struct img').first().click()
  await page.waitForTimeout(350)
  const zoom = await page.evaluate(() => {
    const root = document.querySelector('.rpt-zoom')
    const img = root.querySelector('.rpt-zoom-stage img')
    return { open: root && !root.hidden, src: (img.src || '').slice(0, 30), title: (root.querySelector('.rpt-zoom-title') || {}).textContent }
  })
  ok('合并报告 SVG 结构图点击进灯箱（矢量源）', zoom.open && zoom.src.startsWith('data:image/svg+xml'), JSON.stringify(zoom))
  await page.screenshot({ path: `${SHOTS}/04-merged-ligand-lightbox.png` })
  await ctx.close()
}

await browser.close()
console.log(`\n${pass} passed, ${fail} failed · shots: ${SHOTS}/`)
if (fail > 0) process.exit(1)
