/**
 * v2.69 单元验证 — 导入报告统计快照解析（extractImportedStatsSections / pickImportedStats）
 * 针对真实报告文件（upload/ 下的 TargetEval 单靶点报告 + 汇总 fixture 内嵌样例）。
 * 运行：bun scripts/test-imported-stats.ts
 */
import { extractImportedStatsSections, pickImportedStats } from '../src/components/eval/ht-archive-import'
import * as fs from 'node:fs'

const FILES = [
  'upload/TargetEval_HT_2026-11-22_74g G02_TargetEval_Q8I246_2026-11-22.html',
  'upload/TargetEval_HT_2026-11-19_74g G25_TargetEval_J53_pdb_01-coot-0_2026-11-19.html',
  'upload/TargetEval_HT_2026-11-19_74g G73_TargetEval_O89342_2026-11-19.html',
]

let pass = 0
let fail = 0
function assert(cond: boolean, msg: string): void {
  if (cond) { pass++; console.log(`  ✓ ${msg}`) }
  else { fail++; console.error(`  ✗ ${msg}`) }
}

for (const f of FILES) {
  if (!fs.existsSync(f)) { console.log(`— 跳过（不存在）：${f}`); continue }
  const html = fs.readFileSync(f, 'utf-8')
  const sections = extractImportedStatsSections(html)
  const h1 = /<h1 class="rpt-title">([^<]+)</.exec(html)?.[1] ?? '(无 h1)'
  console.log(`\n【${f.split('/').pop()}】h1: ${h1.slice(0, 70)}`)
  console.log(`  区段数: ${sections.length}`)
  assert(sections.length === 1, '单靶点报告 = 恰好 1 个统计区段')
  const s = sections[0]
  if (!s) continue
  console.log(`  overall=${s.overall} xray=${s.xray} cryoem=${s.cryoem} nmr=${s.nmr}`)
  console.log(`  pdb=${s.pdbCount} blast=${s.blastHitCount} lit=${s.literatureCount} cov=${s.coverage}%`)
  console.log(`  methodX=${s.methodXrayCount} methodC=${s.methodCryoemCount} methodN=${s.methodNmrCount} bestRes=${s.bestResolution}`)
  console.log(`  protein=${s.proteinName?.slice(0, 40)} organism=${s.organism?.slice(0, 40)}`)
  console.log(`  uniprot=${s.uniprotId} range=${s.range?.join('-')} seqLen=${s.seqLength}`)
  assert(s.overall >= 0 && s.overall <= 10, '总分在 0-10')
  assert(s.xray > 0 || s.cryoem > 0 || s.nmr > 0, '至少一个方法评分 > 0')
  // 与报告原文交叉验证：总分应能在原文中找到（glance-score 值）
  const glance = /<div class="glance-score"[^>]*>\s*(\d+)<span/.exec(html)
  if (glance) assert(s.overall === Number(glance[1]), `总分与原文 glance-score 一致（${glance[1]}）`)
  const metaPdb = /结构证据<\/b>[\s\S]*?直接结构\s*(\d+)/.exec(html)
  if (metaPdb) assert(s.pdbCount === Number(metaPdb[1]), `直接结构数与原文一致（${metaPdb[1]}）`)
  // pickImportedStats：单区段直接命中
  const picked = pickImportedStats(sections, { acc: 'X', length: 0 })
  assert(picked === s, '单区段报告 pick 直接命中（身份不匹配也返回唯一区段）')
}

// ── 多区段（合并报告形态）合成样例 ──
console.log('\n【合成合并报告 — 多区段定位】')
const mkSec = (name: string, acc: string | null, range: [number, number] | null, overall: number, xray: number, seqLen: number | null): string => `
<h1 class="rpt-title">${name}（${acc ? `${acc}${range ? ` · 残基 ${range[0]}-${range[1]}` : ''}` : `序列靶点 · 残基 ${range?.[0] ?? 1}-${range?.[1] ?? seqLen ?? 1}`}）</h1>
<div class="meta-grid"><div><b>蛋白名称</b> ${name} full</div><div><b>物种</b> Test organism</div>${seqLen ? `<div><b>序列长度</b> ${seqLen} aa</div>` : ''}<div><b>结构证据</b> 直接结构 ${overall} · 同源 ${xray} 个 · 文献 3 篇</div></div>
<div class="glance-score" style="color:#059669">${overall}<span>/10</span></div>
<div class="glance-tile"><div class="gt-label">已有结构</div><div class="gt-value">${overall} 个</div><div class="gt-sub">X-ray ${xray} · Cryo-EM 0 · NMR 0 · 最佳 1.85Å</div></div>
<div class="glance-tile"><div class="gt-label">结构覆盖率</div><div class="gt-value">8${overall % 10}%</div></div>
<div class="score-card"><div class="score-row "><div class="score-label">X-ray 结晶</div><div class="score-track"></div><div class="score-num">${xray}<span class="score-max">/10</span></div><div class="score-rating">优</div></div>
<div class="score-row row-overall"><div class="score-label">综合评估</div><div class="score-track"></div><div class="score-num">${overall}<span class="score-max">/10</span></div><div class="score-rating">良</div></div></div>
`
const mergedHtml = `<!DOCTYPE html><html><head><title>合并报告 · A + B + C</title></head><body>
<h1 class="rpt-title">合并报告标题（无括号）</h1><p>封面无评分</p>
${mkSec('Protein A', 'P12345', [10, 200], 7, 6, null)}
${mkSec('Protein B', 'Q9XYZ1', null, 5, 4, null)}
${mkSec('构建链 C', null, [8, 146], 8, 8, 139)}
</body></html>`
const merged = extractImportedStatsSections(mergedHtml)
assert(merged.length === 3, `合并报告解析出 3 个区段（封面跳过，实际 ${merged.length}）`)
const a = pickImportedStats(merged, { acc: 'P12345', range: [10, 200] })
assert(a?.uniprotId === 'P12345' && a?.overall === 7, 'UniProt+区间定位到 A（overall=7）')
const b = pickImportedStats(merged, { acc: 'Q9XYZ1' })
assert(b?.uniprotId === 'Q9XYZ1' && b?.overall === 5, 'accession 唯一定位到 B（overall=5）')
const c = pickImportedStats(merged, { length: 139 })
assert(c?.overall === 8 && c?.range?.[0] === 8, '序列靶点按比对跨度 139 定位到 C（overall=8, 残基 8-146）')
assert(c?.methodXrayCount === 8 && c?.bestResolution === 1.85, '方法计数与最佳分辨率解析（X-ray 8 / 1.85Å）')
const none = pickImportedStats(merged, { acc: 'P99999' })
assert(none === undefined, '不存在的 accession → undefined（不误配）')
assert(merged.every(x => x.organism === 'Test organism'), '物种行解析（全部区段）')

// ── 旧格式（无 glance，只有 score-row）兜底 ──
console.log('\n【旧版报告兜底 — 无 glance-score】')
const oldHtml = `<h1 class="rpt-title">Old Target（P0DTC2 · 残基 16-1273）</h1>
<div class="meta-grid"><div><b>蛋白名称</b> Old protein</div></div>
<div class="score-card">
<div class="score-row "><div class="score-label">X-ray 结晶</div><div class="score-num">3<span class="score-max">/10</span></div></div>
<div class="score-row "><div class="score-label">Cryo-EM</div><div class="score-num">4<span class="score-max">/10</span></div></div>
<div class="score-row "><div class="score-label">NMR</div><div class="score-num">2<span class="score-max">/10</span></div></div>
<div class="score-row row-overall"><div class="score-label">综合评估</div><div class="score-num">4<span class="score-max">/10</span></div></div>
</div>`
const old = extractImportedStatsSections(oldHtml)
assert(old.length === 1 && old[0]!.overall === 4, '无 glance 时综合评估行兜底（overall=4）')
assert(old[0]!.xray === 3 && old[0]!.cryoem === 4 && old[0]!.nmr === 2, '三方法评分行解析（3/4/2）')

// ── 无评分的封面/垃圾输入 ──
assert(extractImportedStatsSections('<h1 class="rpt-title">封面（无评分）</h1><p>xx</p>').length === 0, '无评分区段 → 空数组')
assert(extractImportedStatsSections('').length === 0, '空输入 → 空数组')

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
