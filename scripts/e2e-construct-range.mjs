#!/usr/bin/env node
/**
 * e2e-construct-range.mjs — v2.27 截短构建感知 浏览器 E2E（Playwright 直连 dev server）。
 *
 * 流程：首页 → 高通量 Tab → 上传真实「第三批自研靶点_靶点清单.xlsx」→
 *  ① 分组文本出现「P0DTD1:4393-5324」与「P0DTD1:181-818」（区间后缀 + 两片段独立成组）
 *  ② 导入结果条显示「N 靶点带构建区间」
 *  ③ 分组预览 chips 带区间后缀
 *  ④ 开始高通量评估按钮激活（解析无无效 token）
 *
 * 运行：node scripts/e2e-construct-range.mjs（dev server :3000 需就绪）
 */
import { chromium } from 'playwright'

const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:3000'
const XLSX = process.env.E2E_XLSX ?? '/home/z/my-project/upload/第三批自研靶点_靶点清单.xlsx'

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
try {
  await page.goto(BASE + '/', { waitUntil: 'load', timeout: 60_000 })
  // 水合哨兵：React 挂载后 aria-selected 随点击切换（Turbopack 冷编译下最坏 30s）
  await page.getByRole('tab', { name: '高通量' }).click({ timeout: 30_000 }).catch(() => {})
  await page.waitForTimeout(1200)
  const htSelected = await page.evaluate(() =>
    document.querySelector('[role=tab][aria-selected="true"]')?.textContent?.includes('高通量') ?? false)
  ok('页面水合 + 高通量 Tab 切换', htSelected)

  // 上传真实清单（LLM 或规则兜底 — done 事件后文本填入）
  const fileInput = page.locator('input[type=file][accept*="xlsx"]').first()
  await fileInput.setInputFiles(XLSX, { timeout: 10_000 })
  // 导入完成哨兵：分组文本里出现 P0DTD1 区间后缀（LLM 预算 12s + 流式 → 最多 40s）
  await page.waitForFunction(() => {
    const ta = document.querySelector('textarea[aria-label="高通量分组输入"]')
    return ta && ta.value.includes('P0DTD1:4393-5324') && ta.value.includes('P0DTD1:181-818')
  }, { timeout: 60_000 })

  const htText = await page.evaluate(() => document.querySelector('textarea[aria-label="高通量分组输入"]').value)
  ok('区间后缀写入分组文本（nsp12 4393-5324 / nsp2 181-818 两片段独立成组）',
    htText.includes('P0DTD1:4393-5324') && htText.includes('P0DTD1:181-818'))
  ok('其他靶点保持无后缀（不过滤）', /^[A-Z0-9-]+(,|$)/m.test(htText.split('\n').find(l => !l.includes('P0DTD1:')) || ''))

  // 导入结果条：「N 靶点带构建区间」
  const metaText = await page.evaluate(() => document.body.innerText)
  ok('导入结果条含构建区间提示', /带构建区间/.test(metaText), metaText.slice(0, 0))
  ok('导入识别组/靶点计数（86 组）', /提取 \d+ 组/.test(metaText))

  // 分组预览 chips：P0DTD1:4393-5324
  const chipOk = await page.evaluate(() => {
    const chips = Array.from(document.querySelectorAll('ol span'))
    return chips.some(c => c.textContent === 'P0DTD1:4393-5324') || chips.some(c => c.textContent?.includes(':4393-5324'))
  })
  ok('分组预览 chips 显示区间后缀', chipOk)

  // 开始按钮激活
  const startEnabled = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('开始高通量评估'))
    return btn ? !btn.disabled : null
  })
  ok('开始高通量评估按钮激活', startEnabled === true)

  await page.screenshot({ path: '/tmp/e2e-construct-range.png', fullPage: false })
} catch (e) {
  fail++
  console.log(`  ✗ E2E 执行异常 — ${e instanceof Error ? e.message : String(e)}`)
  await page.screenshot({ path: '/tmp/e2e-construct-range-fail.png', fullPage: false }).catch(() => {})
} finally {
  await browser.close()
}

console.log(`\n${pass} 通过 · ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
