/**
 * 存量报告热修脚本（一次性）：
 * 为 db/reports 下所有 report.html 注入 CSS 覆盖补丁，
 * 修复 PDB 表配体列 nowrap 长串溢出与后续列重叠的问题。
 * （新生成的报告已在新版 report-html.ts 中修复，此补丁仅作用于历史文件）
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const REPORTS_DIR = path.resolve(process.cwd(), 'db/reports')

const HOTFIX = `
<style>
/* v1.2.1 hotfix — 修复长配体名/长标题与后续列重叠；评分行窄屏溢出 */
.t-lig { white-space:normal !important; overflow-wrap:anywhere !important; }
.t-title { overflow-wrap:break-word !important; word-break:break-word !important; }
tbody tr:nth-child(even) td { background:#fbfaf8; }
@media (max-width:560px){
  .score-card{ padding:14px 16px; }
  .score-row{ grid-template-columns:1fr auto !important; gap:5px 12px; }
  .score-label{ grid-column:1; grid-row:1; }
  .score-num{ grid-column:2; grid-row:1; }
  .score-track{ grid-column:1 / -1; grid-row:2; }
  .score-rating{ grid-column:1 / -1; grid-row:3; text-align:left; }
}
</style>
`

let patched = 0
for (const dir of fs.readdirSync(REPORTS_DIR, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue
  const file = path.join(REPORTS_DIR, dir.name, 'report.html')
  if (!fs.existsSync(file)) continue
  const html = fs.readFileSync(file, 'utf-8')
  if (html.includes('v1.2.1 hotfix')) continue
  if (!html.includes('</head>')) continue
  fs.writeFileSync(file, html.replace('</head>', `${HOTFIX}</head>`))
  patched++
}
console.log(`patched ${patched} report files`)
