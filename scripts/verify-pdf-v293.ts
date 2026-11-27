/** v2.93 修复验证：真实 renderReportPdf（生产函数）跑重建的 EGFR 报告 HTML */
import * as fs from 'node:fs'
import { renderReportPdf } from '@/lib/eval/report-pdf'

async function main() {
  const html = fs.readFileSync('/tmp/repro-egfr.html', 'utf-8')
  const t0 = Date.now()
  const bytes = await renderReportPdf(html)
  fs.writeFileSync('/tmp/repro-fixed.pdf', bytes)
  console.log(`renderReportPdf OK: ${(bytes.length / 1024 / 1024).toFixed(2)}MB in ${((Date.now() - t0) / 1000).toFixed(1)}s → /tmp/repro-fixed.pdf`)
}

main().catch(e => { console.error('FAILED:', e); process.exit(1) })
