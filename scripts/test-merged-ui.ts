/**
 * v2.9 前端冒烟：真实应用内加载历史合并报告 → MergedReportView 渲染
 * 「各靶点单独报告」新章节（基本信息 + 预测结构卡）— DOM 断言 + 截图留档。
 */
import { chromium } from '/home/z/my-project/node_modules/playwright/index.mjs'

const BASE = 'http://localhost:3000'
const COOKIE = 'te_owner=9043a4cce0f74e379c7972549e500b81'

let pass = 0, fail = 0
const check = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}`, detail !== undefined ? JSON.stringify(detail) : '') }
}

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-gpu'] })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
await ctx.addCookies([{ name: 'te_owner', value: COOKIE.split('=')[1], url: BASE }])
const page = await ctx.newPage()
const errors: string[] = []
page.on('pageerror', (e: Error) => errors.push(String(e).slice(0, 200)))
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
// dev 服务器首次编译 + HMR 全量重载 — 等 DOM 稳定（3 秒内无重载）再操作
async function waitSettled() {
  for (let i = 0; i < 20; i++) {
    const stamp = await page.evaluate('document.documentElement.outerHTML.length')
    await new Promise(r => setTimeout(r, 1500))
    const stamp2 = await page.evaluate('document.documentElement.outerHTML.length')
    const hasBtn = await page.evaluate('!!document.querySelector(\'button[aria-label="历史评估"]\')')
    if (hasBtn && Math.abs(stamp2 - stamp) < 50) return true
  }
  return false
}
const settled = await waitSettled()
console.log(`[0] DOM 稳定：${settled}`)

// 打开历史对话框（JS 直接派发点击 — 避开 HMR 重载期的 actionability 重试风暴）
await page.evaluate(`document.querySelector('button[aria-label="历史评估"]').click()`)
await page.waitForSelector('[role="dialog"]', { timeout: 25_000 })
console.log('[1] 历史对话框已打开')

// 等待合并报告列表加载（GET /api/evaluate/batch-report 列表）
await page.waitForFunction(
  `document.body.textContent.includes('合并报告')`,
  null, { timeout: 20_000, polling: 300 },
)
// 点击第一条合并报告行（合并报告分组下的第一个可点击条目）
const clicked = await page.evaluate(`(() => {
  const dlg = document.querySelector('[role="dialog"]')
  const rows = [...(dlg || document).querySelectorAll('button, [role="button"], a, li, div[class*="cursor"]')]
  // 合并报告分组标题之后的行 — 找包含「合并」附近批次的可点击元素：直接找含批次标题的行
  const all = [...(dlg || document).querySelectorAll('*')].filter(el => el.children.length <= 3 && /合并报告|Hemoglobin|血红蛋白/.test(el.textContent || '') && el.textContent.length < 120)
  return all.length
})()`)
console.log('  合并相关元素数：', clicked)

// 点击第一条合并报告行（DIV 行 — 标题 + N 个靶点 + 日期）
const clickResult = await page.evaluate(`(() => {
  const dlg = document.querySelector('[role="dialog"]')
  if (!dlg) return 'no-dialog'
  // 合并报告分组标题后的批次行：找含「个靶点」的行（批次行特征文本）
  const rows = [...dlg.querySelectorAll('div, button, a')].filter(el =>
    /个靶点/.test(el.textContent || '') && (el.textContent || '').length < 120)
  if (!rows.length) return 'no-row'
  // 取最小（最内层）行 — 点击最深元素冒泡到 onClick 容器
  const inner = rows.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)[0]
  inner.click()
  return 'clicked:' + (inner.textContent || '').replace(/\\s+/g, ' ').slice(0, 50)
})()`)
console.log('  批次行点击：', clickResult)

// 等待 MergedReportView 出现（各靶点单独报告章节）
await page.waitForFunction(
  `document.querySelector('#sec-merged-mini') !== null`,
  null, { timeout: 40_000, polling: 300 },
).then(() => console.log('[2] MergedReportView · 各靶点单独报告章节已渲染')).catch(() => console.log('[2] 超时：#sec-merged-mini 未出现'))

const info = await page.evaluate(`(() => {
  const secEl = document.querySelector('#sec-merged-mini')
  const sec = secEl ? secEl.closest('section') : null
  if (!sec) return { found: false }
  const cards = [...sec.querySelectorAll('.overflow-hidden.rounded-xl.border')]
  const dlRows = sec.querySelectorAll('dl > div').length
  const afOk = sec.textContent.includes('平均 pLDDT')
  const link = sec.querySelector('a[href*="alphafold.ebi.ac.uk"]')
  const basic = ['方法评分', '总体可行性', '实验结构', '序列覆盖', '同源结构', '文献 / 配体'].every(k => sec.textContent.includes(k))
  return { found: true, cards: cards.length, dlRows, afOk, hasAfLink: !!link, basic, sample: cards[0] ? cards[0].textContent.slice(0, 160) : '' }
})()`)
console.log('[3] 章节数据：', JSON.stringify(info, null, 2))

check('章节存在', info.found === true)
if (info.found) {
  check('简报卡 2 张（血红蛋白 α/β）', info.cards === 2, { cards: info.cards })
  check('基本信息行齐备', info.basic === true)
  check('AlphaFold 元数据展示（平均 pLDDT）', info.afOk === true)
  check('AFDB 外链存在', info.hasAfLink === true)
}
check('无页面脚本错误', errors.length === 0, errors)

// 截图留档（滚到章节）
await page.evaluate(`document.querySelector('#sec-merged-mini')?.scrollIntoView({ block: 'start' })`)
await new Promise(r => setTimeout(r, 900))
await page.screenshot({ path: '/tmp/merged-ui-mini.png', type: 'png', fullPage: false })
console.log('截图：/tmp/merged-ui-mini.png')

await browser.close()
console.log(`\n结果：${pass} 通过 · ${fail} 失败`)
if (fail > 0) process.exit(1)
