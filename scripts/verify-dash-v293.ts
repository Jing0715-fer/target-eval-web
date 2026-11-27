import * as fs from 'node:fs'
import { renderReportPdf, applyDashboardPrintCss } from '@/lib/eval/report-pdf'

async function main() {
  const raw = fs.readFileSync('db/reports/cmwvx0di50006p286l85jywbg/report.html', 'utf-8')
  const html = applyDashboardPrintCss(raw)
  console.log('dashboard html:', (html.length / 1024).toFixed(0) + 'KB', '| has @page A4:', html.includes('size: A4'))
  const t0 = Date.now()
  const bytes = await renderReportPdf(html)
  fs.writeFileSync('/tmp/dash-fixed.pdf', bytes)
  console.log(`OK: ${(bytes.length / 1024 / 1024).toFixed(2)}MB in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
}
main().catch(e => { console.error('FAILED:', e); process.exit(1) })
