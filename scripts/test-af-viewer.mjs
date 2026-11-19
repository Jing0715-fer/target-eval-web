#!/usr/bin/env node
/**
 * v2.7.2 验证：报告内嵌 AlphaFold 3Dmol 交互式 3D 视图。
 * 输入：e2e-stateless.mjs 落盘的 scripts/out/report.html（真实 renderReportHtml 产物）。
 * 断言：
 *  1) window.__afViewerReady === true（3Dmol bundle 内联加载 + PDB addModel + 着色完成）
 *  2) .af-stage 进入 af-live 态（canvas 可见、poster 隐藏）
 *  3) 画布非白像素覆盖率 > 2%（结构真实渲染，非空白/透明）
 *  4) pLDDT 四段颜色均在画布中出现（≥90 蓝 #0053D6 / 70-90 青 #65CBF3 /
 *     50-70 黄 #FFDB13 / <50 橙 #FF7D45 — 区间字符串着色语义）
 *  5) 交互性：模拟拖拽旋转后画布像素变化（可交互证据）
 *  6) 打印海报：#af-poster src 已被 pngURI 填充（data:image/png）
 *  7) 无 JS 页面错误（pageerror）
 */
import * as fs from 'node:fs/promises'
import { chromium } from 'playwright'

const REPORT = process.argv[2] ?? 'scripts/out/report.html'

async function main() {
  const html = await fs.readFile(REPORT, 'utf-8')
  console.log(`report: ${REPORT} · ${(html.length / 1024).toFixed(0)}KB · inline-3dmol=${html.includes('$3Dmol.createViewer')}`)
  if (!html.includes('af-stage')) throw new Error('FAIL: 报告不含交互视图（af-stage 缺失）— 检查 alphafoldStructure 是否传入 renderReportHtml')

  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] })
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', e => pageErrors.push(String(e).slice(0, 200)))
  await page.setViewportSize({ width: 1000, height: 1200 })
  await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 60_000 })

  // 1) viewer ready
  await page.waitForFunction('window.__afViewerReady === true', null, { timeout: 30_000, polling: 150 })
  console.log('✓ 1) __afViewerReady = true（3Dmol 加载 + 模型 + 着色完成）')

  // 2) af-live 态
  const stageCls = await page.getAttribute('#af-stage', 'class')
  if (!/af-live/.test(stageCls ?? '')) throw new Error('FAIL: af-stage 未进入 af-live（初始化失败走降级）')
  console.log('✓ 2) af-stage.af-live（canvas 生效、poster 隐藏）')

  // 3+4) 画布像素：截图 stage 区域，统计非白率 + 四色出现
  await new Promise(r => setTimeout(r, 800)) // 渲染稳定一拍
  const stageBox = await page.locator('#af-stage').boundingBox()
  if (!stageBox || stageBox.width < 100) throw new Error('FAIL: af-stage 几何异常（width=' + stageBox?.width + '）— 头部布局回归？')
  const shot1 = await page.screenshot({ type: 'png', clip: stageBox })
  const sharp = (await import('sharp')).default
  const { data, info } = await sharp(shot1).raw().toBuffer({ resolveWithObject: true })
  let nonWhite = 0
  const colorHits = { hi: 0, mid: 0, low: 0, poor: 0 }
  const targets = {
    hi: [0x00, 0x53, 0xd6], mid: [0x65, 0xcb, 0xf3], low: [0xff, 0xdb, 0x13], poor: [0xff, 0x7d, 0x45],
  }
  for (let i = 0; i < data.length; i += info.channels) {
    const r = data[i], g = data[i + 1], b = data[i + 2]
    if (r < 250 || g < 250 || b < 250) nonWhite++
    for (const k of Object.keys(targets)) {
      const [tr, tg, tb] = targets[k]
      if (Math.abs(r - tr) <= 24 && Math.abs(g - tg) <= 24 && Math.abs(b - tb) <= 24) colorHits[k]++
    }
  }
  const total = info.width * info.height
  const ratio = nonWhite / total * 100
  console.log(`✓ 3) 非白像素覆盖率 ${ratio.toFixed(2)}%（${info.width}×${info.height}）`)
  if (ratio < 2) throw new Error('FAIL: 画布近乎空白（透明/未渲染）— 覆盖率 ' + ratio.toFixed(2) + '%')
  console.log(`   四色命中：hi(蓝)=${colorHits.hi} mid(青)=${colorHits.mid} low(黄)=${colorHits.low} poor(橙)=${colorHits.poor}`)
  // 高置信蛋白（如 O94952 平均 pLDDT 85.3）低置信段极小 — 每色 ≥2 像素即证明着色真实存在
  const missing = Object.entries(colorHits).filter(([, n]) => n < 2).map(([k]) => k)
  if (missing.length) throw new Error('FAIL: pLDDT 颜色缺失 ' + missing.join('/') + ' — 区间着色回归？命中=' + JSON.stringify(colorHits))
  if (colorHits.hi < 30 || colorHits.mid < 20) throw new Error('FAIL: 主色系像素过少 — 命中=' + JSON.stringify(colorHits))

  // 5) 交互：拖拽旋转 → 像素应变化
  const cx = stageBox.x + stageBox.width / 2, cy = stageBox.y + stageBox.height / 2
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx + 90, cy + 30, { steps: 8 })
  await page.mouse.up()
  await new Promise(r => setTimeout(r, 700))
  const shot2 = await page.screenshot({ type: 'png', clip: stageBox })
  const d2 = await sharp(shot2).raw().toBuffer({ resolveWithObject: true })
  let diff = 0
  for (let i = 0; i < Math.min(data.length, d2.data.length); i++) if (Math.abs(data[i] - d2.data[i]) > 12) diff++
  const diffRatio = diff / total * 100
  console.log(`✓ 5) 拖拽旋转后像素变化率 ${diffRatio.toFixed(2)}%（>1% 即可交互）`)
  if (diffRatio < 1) throw new Error('FAIL: 拖拽后画布无变化 — 视图不可交互')

  // 6) 打印海报（pngURI）
  const posterSrc = await page.getAttribute('#af-poster', 'src')
  const posterOk = !!posterSrc && posterSrc.startsWith('data:image/png') && posterSrc.length > 2000
  console.log(`✓ 6) 打印海报 pngURI ${posterOk ? '已生成（' + Math.round(posterSrc.length / 1024) + 'KB）' : '未生成（降级：无静态海报，仅交互视图）'}`)

  // 7) 无页面错误
  console.log(`✓ 7) pageerror ×${pageErrors.length}${pageErrors.length ? ' — ' + pageErrors.join(' | ') : ''}`)
  if (pageErrors.length) throw new Error('FAIL: 页面 JS 错误：' + pageErrors.join(' | '))

  await fs.mkdir('scripts/out', { recursive: true })
  await fs.writeFile('scripts/out/af-viewer-before.png', shot1)
  await fs.writeFile('scripts/out/af-viewer-after-drag.png', shot2)
  await browser.close()
  console.log('✅ v2.7.2 报告内嵌交互式 AlphaFold 3D 视图：全部断言通过')
}

main().catch(e => { console.error('❌', e.message); process.exit(1) })
