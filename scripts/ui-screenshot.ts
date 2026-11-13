/**
 * v2.5 UI 视觉验证（Playwright 本地 headless）：
 *  宽屏 1920 / 笔记本 1366 / 平板 768 / 移动 390 四档截图，idle 首屏。
 *  用法：bun scripts/ui-screenshot.ts [outDir]
 */
import { chromium } from 'playwright'

const OUT = process.argv[2] ?? '/tmp/render'
const BASE = process.env.BASE ?? 'http://127.0.0.1:3000'

const VIEWPORTS: Array<{ name: string; width: number; height: number; mobile?: boolean }> = [
  { name: 'wide-1920', width: 1920, height: 1080 },
  { name: 'laptop-1366', width: 1366, height: 860 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'mobile-390', width: 390, height: 844, mobile: true },
]

async function main() {
  const browser = await chromium.launch()
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1,
      isMobile: Boolean(vp.mobile),
      hasTouch: Boolean(vp.mobile),
    })
    const page = await ctx.newPage()
    await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60_000 })
    await page.waitForTimeout(2500)
    await page.screenshot({ path: `${OUT}/${vp.name}-home.png` })
    // 满页截图（看「下方是否空」）
    await page.screenshot({ path: `${OUT}/${vp.name}-home-full.png`, fullPage: true })
    // 宽屏利用率检查：主列实际宽度 vs 视口宽度
    const metrics = await page.evaluate(() => {
      const main = document.querySelector('main')
      const rect = main?.getBoundingClientRect()
      const horizScroll = document.documentElement.scrollWidth > window.innerWidth
      return {
        viewport: window.innerWidth,
        mainWidth: rect ? Math.round(rect.width) : 0,
        mainLeft: rect ? Math.round(rect.left) : 0,
        horizScroll,
      }
    })
    console.log(`[${vp.name}] viewport=${metrics.viewport} mainWidth=${metrics.mainWidth} left=${metrics.mainLeft} horizScroll=${metrics.horizScroll}`)
    await ctx.close()
  }
  await browser.close()
  console.log('DONE →', OUT)
}

main().catch(e => {
  console.error('FATAL', e)
  process.exit(1)
})
