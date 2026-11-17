/**
 * v2.20.2 UI 级诊断/回归：模拟用户完整路径 —
 *  1. 注入用户式 localStorage（minimax@minimaxi.com 旧存态 + 真实 Key + M2.7）
 *  2. 打开首页 → 迁移自动跑（主条目应变 api.minimax.cn/v1）
 *  3. 打开 LLM 配置面板 → 点「获取模型列表」
 *  4. 断言：下拉含 MiniMax-M3.1-Flash / MiniMax-M3；并检测其是否在滚动视口内可见
 * 运行：node scripts/diag-llm-panel.mjs
 */
import { chromium } from 'playwright'
import fs from 'node:fs'

const KEY = process.env.MINIMAX_KEY ?? ''
const URL = 'http://127.0.0.1:3000/'
const SHOTS = '/tmp/llm-panel-shots'
fs.mkdirSync(SHOTS, { recursive: true })

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await ctx.route('**://fonts.googleapis.com/**', r => r.abort())
await ctx.route('**://fonts.gstatic.com/**', r => r.abort())
const page = await ctx.newPage()

// 1. 首访建 localStorage 域，再注入用户式旧存态
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
await page.evaluate(k => {
  window.localStorage.setItem('te_llm_engine_v1', JSON.stringify({
    active: 'minimax',
    providers: {
      minimax: { label: 'MiniMax', baseUrl: 'https://api.minimaxi.com', apiKey: k, model: 'MiniMax-M2.7', savedAt: 1 },
    },
  }))
}, KEY)

// 2. reload → readEngineStore 触发迁移；等 hydration 完成再交互
await page.reload({ waitUntil: 'networkidle', timeout: 60000 }).catch(() => {})
await page.waitForTimeout(2500)
await page.getByRole('button', { name: 'LLM 分析引擎配置' }).waitFor({ state: 'visible', timeout: 20000 })

// 3. 打开 LLM 面板（页眉「LLM 引擎」按钮，aria-label="LLM 分析引擎配置"）
await fetch(URL + 'api/llm/config').catch(() => {}) // 预热 dev 编译
await page.getByRole('button', { name: 'LLM 分析引擎配置' }).click()
await page.waitForTimeout(2000)
// 失败诊断：截图 + 面板文字 dump
await page.screenshot({ path: `${SHOTS}/panel-state.png` })
const dlgText = await page.getByRole('dialog').innerText().catch(() => '(无 dialog)')
console.log('面板文字（前 500 字）：', dlgText.slice(0, 500).replace(/\n/g, ' | '))
try {
  await page.locator('#llm-baseurl').waitFor({ state: 'visible', timeout: 30000 })
} catch {
  console.log('⚠ 表单未出现 — 见 panel-state.png')
  await browser.close()
  process.exit(2)
}
await page.waitForTimeout(600)

// 4. 面板里确认主条目 baseUrl 已迁 .cn
const baseUrlVal = await page.locator('#llm-baseurl').inputValue().catch(() => '(未找到)')
console.log(`主条目 baseUrl = ${baseUrlVal}`)

// 5. 点「获取模型列表」
await page.getByRole('button', { name: /获取模型列表/ }).click()
await page.waitForTimeout(6000) // 真实请求 + 下拉渲染

// 6. 断言下拉内容
const list = page.locator('div.eval-scroll.absolute button')
const items = await list.allTextContents().catch(() => [])
console.log(`下拉共 ${items.length} 条：${items.join(' | ')}`)
const hasM31 = items.some(t => /MiniMax-M3\.1-Flash/.test(t))
const hasM3 = items.some(t => /^MiniMax-M3$/.test(t.trim()))
console.log(`含 MiniMax-M3.1-Flash: ${hasM31}；含 MiniMax-M3: ${hasM3}`)

// 7. 可见性诊断：M3.1-Flash 行是否在滚动容器视口内（不需滚动就能看见？）
const vis = await page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('div.eval-scroll.absolute button'))
  const target = rows.find(r => /MiniMax-M3\.1-Flash/.test(r.textContent ?? ''))
  if (!target) return { found: false }
  const rect = target.getBoundingClientRect()
  const cont = target.closest('div.eval-scroll.absolute')
  const crect = cont?.getBoundingClientRect()
  return {
    found: true,
    rowTop: Math.round(rect.top),
    containerBottom: crect ? Math.round(crect.bottom) : null,
    // 不滚动即可见 = 行顶在容器底之上
    visibleWithoutScroll: crect ? rect.top < crect.bottom : false,
    containerScrollHeight: cont ? cont.scrollHeight : null,
    containerClientHeight: cont ? cont.clientHeight : null,
  }
})
console.log('可见性诊断：', JSON.stringify(vis))
await page.screenshot({ path: `${SHOTS}/panel-models.png`, fullPage: false })
console.log(`截图：${SHOTS}/panel-models.png`)

await browser.close()
