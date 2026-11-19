import { chromium } from 'playwright'
const variants = [
  { name: 'swiftshader', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
  { name: 'nogpu', args: ['--disable-gpu', '--disable-gpu-compositing'] },
]
for (const v of variants) {
  const browser = await chromium.launch({ args: v.args })
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
  await page.goto('http://127.0.0.1:3000/', { waitUntil: 'networkidle', timeout: 60000 })
  await page.waitForTimeout(2000)
  await page.screenshot({ path: `/tmp/ui-check/gpu-${v.name}.png` })
  await browser.close()
  console.log(v.name, 'done')
}
