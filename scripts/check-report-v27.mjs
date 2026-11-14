#!/usr/bin/env node
/**
 * v2.7 报告视觉/几何校验（playwright DOM 量测 + 截图存档）：
 *  1. 头部双栏：头图与标题齐平（af-fig top ≈ eyebrow top，且 < meta-grid top）
 *  2. 蛋白信息下方无大片空白（左栏高度 ≈ 头图高度，差 < 160px）
 *  3. 配体卡：2D 结构图 150px 展示、性质网格存在
 *  4. 无横向滚动（scrollWidth ≈ clientWidth）
 *  5. 抽取内嵌 AF 图/配体图像素统计（非空白/覆盖色）
 */
import { chromium } from 'playwright'
import * as fs from 'node:fs/promises'

const REPORT = process.argv[2]

async function main() {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] })
  const page = await browser.newPage({ viewport: { width: 1280, height: 1200 } })
  await page.goto('file://' + REPORT, { waitUntil: 'load', timeout: 30_000 })
  await page.waitForTimeout(1800)

  const geo = await page.evaluate(() => {
    const r = (sel) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const b = el.getBoundingClientRect()
      return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), w: Math.round(b.width), h: Math.round(b.height), scrollY: Math.round(window.scrollY) }
    }
    const imgNatural = (sel) => {
      const el = document.querySelector(sel)
      return el ? { natural: el.naturalWidth + 'x' + el.naturalHeight, shown: Math.round(el.getBoundingClientRect().width) + 'x' + Math.round(el.getBoundingClientRect().height) } : null
    }
    return {
      eyebrow: r('.rpt-eyebrow'),
      title: r('.rpt-title'),
      meta: r('.meta-grid'),
      afimg: r('.af-fig img'),
      affig: r('.af-fig'),
      head: r('.rpt-head'),
      badges: r('.rpt-badges'),
      toc: r('.toc'),
      ligStruct: r('.lig-struct'),
      ligProps: r('.lig-props'),
      docScrollX: document.documentElement.scrollWidth,
      docClientX: document.documentElement.clientWidth,
      afNatural: imgNatural('.af-fig img'),
      ligNatural: imgNatural('.lig-struct img'),
      ligCards: document.querySelectorAll('.lig-card').length,
      ligFolds: document.querySelectorAll('.lig-fold').length,
      h3Llm: document.querySelectorAll('#llm h3').length,
      llmText: (document.querySelector('#llm')?.textContent ?? '').length,
    }
  })
  console.log(JSON.stringify(geo, null, 1))

  // 断言
  const a = []
  a.push(['头图与标题齐平（af-fig 顶 ≤ eyebrow 顶 + 40）', geo.afimg.top - geo.eyebrow.top <= 40])
  a.push(['头图与标题同栏顶部（af-fig top < meta top + 40）', geo.afimg.top <= geo.meta.top + 40])
  a.push(['蛋白信息下方无大片空白（左栏高 − 头图高 ≤ 160px）', (geo.badges.bottom - geo.eyebrow.top) - (geo.afimg.bottom - geo.eyebrow.top) <= 160])
  a.push(['头部总高收紧（≤ 头图高 + 60）', geo.head.bottom - geo.head.top <= (geo.afimg.bottom - geo.afimg.top) + 60])
  a.push(['无横向滚动', geo.docScrollX <= geo.docClientX + 2])
  a.push(['LLM 10 章', geo.h3Llm === 10])
  a.push(['LLM 正文 ≥ 3000 字', geo.llmText >= 3000])
  a.push(['配体结构图存在', Boolean(geo.ligStruct)])
  a.push(['配体性质网格存在', Boolean(geo.ligProps)])
  let pass = 0
  for (const [name, ok] of a) { console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name); if (ok) pass++ }
  console.log(`\n${pass}/${a.length} assertions passed`)

  // 截图（整页过长 — 分区截：头部 / 配体区）
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.waitForTimeout(300)
  await page.screenshot({ path: 'scripts/out/report-top.png', clip: { x: 0, y: 0, width: 1280, height: 900 } })
  const lig = await page.$('#ligands')
  if (lig) {
    const b = await lig.boundingBox()
    if (b) {
      await page.evaluate(y => window.scrollTo(0, y), Math.max(0, b.y - 120))
      await page.waitForTimeout(300)
      await page.screenshot({ path: 'scripts/out/report-ligands.png', clip: { x: 0, y: Math.max(0, b.y - 120), width: 1280, height: Math.min(900, b.height + 160) } })
    }
  }
  await browser.close()

  // 抽取内嵌图片做像素统计
  const sharp = (await import('sharp')).default
  const html = await fs.readFile(REPORT, 'utf-8')
  const imgs = [...html.matchAll(/<img src="data:image\/png;base64,([A-Za-z0-9+/=]+)"/g)].map(m => Buffer.from(m[1], 'base64'))
  for (let i = 0; i < imgs.length; i++) {
    const { data, info } = await sharp(imgs[i]).raw().toBuffer({ resolveWithObject: true })
    let nonWhite = 0
    for (let p = 0; p < data.length; p += info.channels) if (data[p] < 250 || data[p + 1] < 250 || data[p + 2] < 250) nonWhite++
    console.log(`img[${i}] ${info.width}x${info.height} 非白像素 ${(nonWhite / (info.width * info.height) * 100).toFixed(1)}% (${imgs[i].length}B)`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
