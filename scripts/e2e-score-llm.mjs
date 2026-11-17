/**
 * v2.18 LLM 智能调分 — Playwright E2E（DOM 结构 + 响应式 + 视觉截图）：
 *  1. 微调版报告（report-llmadj.html）：
 *     - AI 复核条 DOM 结构（badge/title/chips/confidence/notes/engine）
 *     - delta 徽章数量与正负类（X-ray +1 紫色 / NMR −2 红色；Cryo-EM ±0、总体 0 无徽章）
 *     - glance 速览 AI 标签、评分说明段两层流程文案
 *     - 评分卡区域截图（人工目检：/tmp/score-llm-shots/）
 *  2. 移动端 375px：AI 复核条不溢出视口（横滚宽度检查）+ 截图
 *  3. 维持版（report-llmkeep.html）：无正/负徽章、维持文案
 *  4. 历史作业（report-nollm.html）：AI 复核元素全部缺位（回归保护）
 * 前置：bun scripts/render-score-llm-fixtures.ts 已生成 /tmp/score-lll-fixtures（见 OUT 目录）
 */
import { chromium } from 'playwright'
import fs from 'node:fs'

const FIX = '/tmp/score-llm-fixtures'
const SHOTS = '/tmp/score-llm-shots'
fs.mkdirSync(SHOTS, { recursive: true })

let pass = 0, fail = 0
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ← ${detail}`}`)
  cond ? pass++ : fail++
}

const browser = await chromium.launch()

async function newPage(w, h) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } })
  await ctx.route('**://fonts.googleapis.com/**', r => r.abort())
  await ctx.route('**://fonts.gstatic.com/**', r => r.abort())
  await ctx.route('**://3Dmol.org/**', r => r.abort())
  return { ctx, page: await ctx.newPage() }
}

// ─── 1. 微调版：DOM 结构断言 + 评分卡截图 ───────────────────────────────
{
  const { ctx, page } = await newPage(1440, 900)
  await page.goto(`file://${FIX}/report-llmadj.html`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(400)

  console.log('── 微调版：AI 复核条 DOM ──')
  const strip = await page.evaluate(() => {
    const s = document.querySelector('.llm-adj-strip')
    if (!s) return null
    return {
      exists: true,
      badge: s.querySelector('.llm-adj-badge')?.textContent?.trim() ?? '',
      title: s.querySelector('.llm-adj-title')?.textContent ?? '',
      chips: Array.from(s.querySelectorAll('.adj-chip')).map(c => c.textContent.trim()),
      conf: s.querySelector('.llm-conf')?.textContent ?? '',
      notesCount: s.querySelectorAll('.llm-notes li').length,
      notesBold: Array.from(s.querySelectorAll('.llm-notes li b')).map(b => b.textContent),
      engine: s.querySelector('.llm-engine')?.textContent ?? '',
      visible: s.getBoundingClientRect().height > 20,
    }
  })
  ok('AI 复核条存在且可见', strip != null && strip.visible)
  ok('徽章文案「AI 复核」', strip?.badge === 'AI 复核')
  ok('微调标题（含总体维持说明）', strip?.title.includes('已微调系统评分') === true)
  ok('三方法调整 chips', JSON.stringify(strip?.chips) === JSON.stringify(['X-ray +1', 'Cryo-EM ±0', 'NMR −2']))
  ok('置信度呈现', strip?.conf.includes('高') === true)
  ok('逐方法意见 4 条（X-ray/Cryo-EM/NMR/总体）', strip?.notesCount === 4)
  ok('意见加粗前缀', JSON.stringify(strip?.notesBold) === JSON.stringify(['X-ray', 'Cryo-EM', 'NMR', '总体']))
  ok('引擎元数据（引擎 + 耗时 + 钳制说明）', strip?.engine.includes('GLM-4.6') === true && strip?.engine.includes('4.2s') === true && strip?.engine.includes('±2') === true)

  console.log('── 微调版：delta 徽章与 glance ──')
  const deltas = await page.evaluate(() => Array.from(document.querySelectorAll('.score-delta')).map(d => ({
    cls: d.className, text: d.textContent.trim(),
  })))
  ok('delta 徽章 2 个（X-ray +1 / NMR −2；±0 与总体 0 无徽章）', deltas.length === 2, JSON.stringify(deltas))
  ok('X-ray +1 为紫色正调整', deltas[0]?.cls.includes('sd-pos') === true && deltas[0]?.text === 'AI +1')
  ok('NMR −2 为红色负调整', deltas[1]?.cls.includes('sd-neg') === true && deltas[1]?.text === 'AI −2')

  const glance = await page.evaluate(() => {
    const tag = document.querySelector('.glance-ai-tag')
    const hero = document.querySelector('.glance-hero')
    const score = document.querySelector('.glance-score')?.textContent ?? ''
    return { tag: tag?.textContent.trim() ?? '', inHero: hero?.querySelector('.glance-ai-tag') != null, score }
  })
  ok('glance 速览 AI 标签（hero 区内）', glance.tag === 'AI 复核' && glance.inHero)
  ok('glance 综合分 = 调整后 10', glance.score.startsWith('10'))

  const noteText = await page.evaluate(() => document.querySelector('#s-\u53ef\u884c\u6027\u8bc4\u5206, section .note')?.textContent ?? document.body.textContent)
  ok('评分说明段两层流程文案', noteText.includes('评分流程分两层') && noteText.includes('±2 以内'))

  // v2.18 可读性：评分依据分行（「；」拆分为独立小行 + 双列网格）
  const rationale = await page.evaluate(() => {
    const box = document.querySelector('.score-rationale')
    if (!box) return { exists: false }
    return {
      exists: true,
      cols: getComputedStyle(box).gridTemplateColumns.split(' ').length,
      items: box.querySelectorAll('.sr-item').length,
      labels: Array.from(box.querySelectorAll('.sr-label')).map(b => b.textContent),
      segs: box.querySelectorAll('.sr-seg').length,
      firstSeg: box.querySelector('.sr-seg')?.textContent ?? '',
      aiSeg: Array.from(box.querySelectorAll('.sr-seg')).some(s => s.textContent.includes('AI 复核上调 1')),
    }
  })
  ok('评分依据：双列网格（桌面）', rationale.exists && rationale.cols === 2)
  ok('评分依据：四方法条目（X-ray/Cryo-EM/NMR/综合）', JSON.stringify(rationale.labels) === JSON.stringify(['X-ray', 'Cryo-EM', 'NMR', '综合']))
  ok(`评分依据：长句已拆分为 ${rationale.segs} 个小行（>4 = 拆分生效）`, rationale.segs > 4)
  ok('评分依据：AI 复核短语随拆分呈现', rationale.aiSeg)

  // v2.18 可读性：目录滚动高亮（scroll-spy）
  const spy = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('.toc a[href^="#"]'))
    return { total: links.length, hrefs: links.map(a => a.getAttribute('href')) }
  })
  ok(`目录链接存在（${spy.total} 条 — scroll-spy 可测）`, spy.total >= 4)
  const scoresHref = spy.hrefs.find(h => h.includes('scores')) ?? spy.hrefs[0]
  await page.evaluate(id => { document.querySelector(id)?.scrollIntoView() }, scoresHref)
  await page.waitForTimeout(300)
  const cur = await page.evaluate(id => {
    const a = document.querySelector(`.toc a[href="${id}"]`)
    return a ? { marked: a.classList.contains('cur'), curCount: document.querySelectorAll('.toc a.cur').length } : null
  }, scoresHref)
  ok('目录滚动高亮：滚动到评分章节后对应目录项高亮', cur != null && cur.marked && cur.curCount === 1)

  // v2.18 可读性：表格行悬停反馈（hover 背景变化）
  const row = page.locator('.tbl-data tbody tr').first()
  if (await row.count()) {
    const before = await row.evaluate(el => getComputedStyle(el).backgroundColor)
    await row.hover()
    await page.waitForTimeout(250)
    const after = await row.evaluate(el => getComputedStyle(el).backgroundColor)
    ok('表格行悬停反馈（背景变化）', before !== after, `before=${before} after=${after}`)
  } else {
    console.log('  ○ 表格行悬停：fixture 无数据表（跳过）')
  }

  // 评分卡区域截图（视觉目检）
  const scoreCard = page.locator('.score-card').first()
  await scoreCard.scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)
  await scoreCard.screenshot({ path: `${SHOTS}/score-card-adj-desktop.png` })
  const glanceEl = page.locator('.glance').first()
  await glanceEl.scrollIntoViewIfNeeded()
  await glanceEl.screenshot({ path: `${SHOTS}/glance-adj-desktop.png` })
  await ctx.close()
}

// ─── 2. 移动端 375px：不溢出视口 ─────────────────────────────────────────
{
  const { ctx, page } = await newPage(375, 812)
  await page.goto(`file://${FIX}/report-llmadj.html`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(400)
  const overflow = await page.evaluate(() => {
    const strip = document.querySelector('.llm-adj-strip')
    if (!strip) return { exists: false, overflow: true }
    const r = strip.getBoundingClientRect()
    return { exists: true, overflow: r.right > window.innerWidth + 2 || r.left < -2 }
  })
  ok('移动端 AI 复核条不横向溢出', overflow.exists && !overflow.overflow)
  const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  ok('移动端页面无整体横向溢出（≤2px 容差）', pageOverflow <= 2, `scrollWidth 超出 ${pageOverflow}px`)
  const strip = page.locator('.llm-adj-strip').first()
  await strip.scrollIntoViewIfNeeded()
  await strip.screenshot({ path: `${SHOTS}/llm-strip-mobile.png` })
  await ctx.close()
}

// ─── 3. 维持版：无徽章 + 维持文案 ─────────────────────────────────────────
{
  const { ctx, page } = await newPage(1440, 900)
  await page.goto(`file://${FIX}/report-llmkeep.html`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(300)
  const keep = await page.evaluate(() => ({
    strip: document.querySelector('.llm-adj-strip') != null,
    title: document.querySelector('.llm-adj-title')?.textContent ?? '',
    deltas: document.querySelectorAll('.score-delta').length,
    glance: document.querySelector('.glance-ai-tag')?.textContent.trim() ?? '',
  }))
  ok('维持版复核条存在', keep.strip)
  ok('维持文案', keep.title.includes('复核确认维持系统评分'))
  ok('无正/负 delta 徽章', keep.deltas === 0)
  ok('glance 标签为维持态（AI 复核 · 维持）', keep.glance === 'AI 复核 · 维持')
  await ctx.close()
}

// ─── 4. 历史作业回归：AI 元素全部缺位 ────────────────────────────────────
{
  const { ctx, page } = await newPage(1440, 900)
  await page.goto(`file://${FIX}/report-nollm.html`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(300)
  const legacy = await page.evaluate(() => ({
    strip: document.querySelector('.llm-adj-strip') != null,
    deltas: document.querySelectorAll('.score-delta').length,
    glance: document.querySelector('.glance-ai-tag') != null,
    score: document.querySelector('.glance-score')?.textContent ?? '',
  }))
  ok('历史作业：无 AI 复核条', !legacy.strip)
  ok('历史作业：无 delta 徽章', legacy.deltas === 0)
  ok('历史作业：无 glance AI 标签', !legacy.glance)
  ok('历史作业：评分分值原样（9）', legacy.score.startsWith('9'))
  await ctx.close()
}

await browser.close()
console.log(`\n${pass} passed · ${fail} failed${fail ? '  ← 有失败项' : ''}`)
process.exit(fail ? 1 : 0)
