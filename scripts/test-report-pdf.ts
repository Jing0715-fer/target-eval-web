/** 临时验证：报告 HTML → PDF（Chromium print-to-PDF）参数探测 */
import { chromium } from 'playwright'
import * as fs from 'node:fs'

async function main() {
  const src = process.argv[2] ?? 'db/reports/cmwvijisi003xk6yoely35vm2/report.html'
  const out = process.argv[3] ?? '/tmp/report-poc.pdf'
  const html = fs.readFileSync(src, 'utf-8')
  console.log(`src=${src} size=${(html.length / 1024 / 1024).toFixed(2)}MB`)
  const t0 = Date.now()
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] })
  const page = await browser.newPage()
  await page.setContent(html, { waitUntil: 'load', timeout: 60_000 })
  console.log(`setContent: ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  // 等全部图片解码完成（data URI 为主）
  await page.waitForFunction(
    `Array.from(document.images).every(i => i.complete && i.naturalWidth > 0)`,
    null,
    { timeout: 30_000, polling: 200 },
  ).catch(() => console.log('image wait timeout (best-effort continue)'))
  console.log(`images ready: ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  await page.evaluate(() => (document as unknown as { fonts?: { ready: Promise<unknown> } }).fonts?.ready).catch(() => undefined)
  const buf = await page.pdf({
    format: 'A4',
    printBackground: true,
    preferCSSPageSize: true,
    displayHeaderFooter: true,
    headerTemplate: '<span></span>',
    footerTemplate: `<div style="width:100%;text-align:center;font-size:8px;color:#8b8b8b;font-family:'Noto Sans SC',sans-serif;">
      <span class="pageNumber"></span> / <span class="totalPages"></span>
    </div>`,
    margin: { top: '12mm', bottom: '14mm', left: '10mm', right: '10mm' },
  })
  fs.writeFileSync(out, buf)
  console.log(`pdf written: ${out} size=${(buf.length / 1024 / 1024).toFixed(2)}MB elapsed=${((Date.now() - t0) / 1000).toFixed(1)}s`)
  await browser.close()
}

main().catch(e => { console.error(e); process.exit(1) })
