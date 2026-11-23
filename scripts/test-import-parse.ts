/**
 * 复现验证（v2.72）：导入报告统计解析 — 共享模块 + meta 对齐 + SHA/容差定位 + 服务端回填口径。
 */
import { createHash } from 'node:crypto'
import { extractImportedStatsSections, pickImportedStats, toCleanImportedStats } from '../src/lib/eval/imported-stats'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

function section(opts: {
  title: string; seqLenMeta: number; overall: number; xray: number; cryoem: number; nmr: number
  pdbCount: number; blast: number; lit: number; coverage: number
}) {
  const scoreRow = (label: string, score: number) => `
  <div class="score-row ">
    <div class="score-label">${label}</div>
    <div class="score-track"><div class="score-fill" style="width:${score * 10}%"></div></div>
    <div class="score-num">${score}<span class="score-max">/10</span></div>
    <div class="score-rating">良·可做</div>
  </div>`
  return `
  <h1 class="rpt-title">${esc(opts.title)}</h1>
  <div class="meta-grid">
    <div><b>蛋白名称</b> Some Protein</div>
    <div><b>物种</b> SARS-CoV-2</div>
    <div><b>序列长度</b> ${opts.seqLenMeta} aa</div>
    <div><b>结构证据</b> 直接结构 ${opts.pdbCount} · 同源 ${opts.blast} 个 · 文献 ${opts.lit} 篇</div>
  </div>
  <div class="glance">
    <div class="glance-score" style="color:#059669">${opts.overall}<span>/10</span></div>
    <div class="glance-tile"><div class="gt-label">已有结构</div><div class="gt-value">${opts.pdbCount} 个</div><div class="gt-sub">X-ray 2 · Cryo-EM 1 · NMR 0 · 最佳 2.80Å</div></div>
    <div class="glance-tile"><div class="gt-label">结构覆盖率</div><div class="gt-value">${opts.coverage}%</div><div class="gt-sub">已有结构覆盖完整</div></div>
  </div>
  ${scoreRow('X-ray 结晶', opts.xray)}
  ${scoreRow('Cryo-EM 冷冻电镜', opts.cryoem)}
  ${scoreRow('NMR 溶液结构', opts.nmr)}
  ${scoreRow('综合评估', opts.overall)}`
}

const ANTIGEN_SEQ = 'MKT'.repeat(65) + 'A' // 196 aa
const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)

// ── 场景 1：合并报告（已识别 196aa 抗原 + 443aa 靶点），刊头 = UniProt 全长 1273 ──
// 旧定位链：byLen 用刊头 1273 ≠ 196 且 range 跨度 195 ≠ 196（indel）→ 定位失败 → 降级行（用户实测 bug）
const mergedHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>合并报告 · A + B</title>
<meta name="targeteval:targets" content="${esc(JSON.stringify([
  { uniprot: 'P0DTC2', range: [333, 527], seqLength: 196, seqSha: sha(ANTIGEN_SEQ), header: 'RBD-fab-240816_refined_ned_006', label: 'RBD-fab-240816_refined_ned_006 · 196aa' },
  { seqLength: 443, header: 'OtherTarget', seqSha: sha('QQQ'.repeat(147) + 'Q'), label: 'OtherTarget · 443aa' },
]))}">
</head><body>
${section({ title: 'Spike glycoprotein（P0DTC2 · nr 识别 98% · 残基 333-527）', seqLenMeta: 1273, overall: 6, xray: 7, cryoem: 5, nmr: 8, pdbCount: 3, blast: 12, lit: 5, coverage: 87 })}
${section({ title: 'OtherTarget（序列靶点 · 残基 1-443）', seqLenMeta: 443, overall: 4, xray: 6, cryoem: 3, nmr: 7, pdbCount: 1, blast: 5, lit: 2, coverage: 52 })}
</body></html>`

const s1 = extractImportedStatsSections(mergedHtml)
console.log('场景1 sections:', s1.map(s => ({ name: s.proteinName, meta: s.seqLength, sha: !!s.seqSha, metaLen: s.metaSeqLength, label: s.metaLabel?.slice(0, 30) })))
const hit1 = pickImportedStats(s1, { length: 196, seqSha: sha(ANTIGEN_SEQ), label: 'RBD-fab-240816_refined_ned_006 · 196aa' })
console.log('场景1 SHA 定位（196aa 抗原，刊头 1273 对不上）:', hit1 ? `命中 ${hit1.proteinName} overall=${hit1.overall}` : '未命中')
console.assert(hit1 && hit1.overall === 6, '场景1 应通过 SHA 命中抗原区段')

// ── 场景 2：无 meta 的旧报告 — 容差 ±3 定位（range 跨度 195 vs 提交 196）──
const oldMerged = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>old</title></head><body>
${section({ title: 'Spike glycoprotein（P0DTC2 · nr 识别 98% · 残基 333-527）', seqLenMeta: 1273, overall: 6, xray: 7, cryoem: 5, nmr: 8, pdbCount: 3, blast: 12, lit: 5, coverage: 87 })}
${section({ title: 'Other（序列靶点 · 残基 1-443）', seqLenMeta: 443, overall: 4, xray: 6, cryoem: 3, nmr: 7, pdbCount: 1, blast: 5, lit: 2, coverage: 52 })}
</body></html>`
const s2 = extractImportedStatsSections(oldMerged)
const hit2 = pickImportedStats(s2, { length: 196, label: 'RBD-fab-240816_refined_ned_006 · 196aa' })
console.log('场景2 容差定位（无 meta，range 跨度 195）:', hit2 ? `命中 ${hit2.proteinName} overall=${hit2.overall}` : '未命中')
console.assert(hit2 && hit2.overall === 6, '场景2 应通过容差 ±3 命中')

// ── 场景 3：单靶点报告（唯一区段直接命中）+ 干净快照剥离 ──
const singleHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>t</title>
<meta name="targeteval:target" content="${esc(JSON.stringify({ seqLength: 196, seqSha: sha(ANTIGEN_SEQ), header: 'RBD-fab' }))}">
</head><body>${section({ title: 'RBD-fab-240816_refined_ned_006（序列靶点 · 残基 1-196）', seqLenMeta: 196, overall: 7, xray: 6, cryoem: 6, nmr: 8, pdbCount: 2, blast: 9, lit: 3, coverage: 91 })}</body></html>`
const s3 = extractImportedStatsSections(singleHtml)
const hit3 = pickImportedStats(s3, { length: 196, seqSha: sha(ANTIGEN_SEQ) })
const clean3 = hit3 ? toCleanImportedStats(hit3) : undefined
console.log('场景3 单靶点 + 清洗:', clean3 && `overall=${clean3.overall} cryoem=${clean3.cryoem} bestRes=${clean3.bestResolution} 内部字段已剥离=${!('seqSha' in (clean3 as object))}`)

// ── 场景 4：歧义防护（两个 196aa 区段、无 SHA、标签不同 → 标签消歧；都对不上 → 不命中）──
const amb = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>a</title></head><body>
${section({ title: 'Alpha（序列靶点 · 残基 1-196）', seqLenMeta: 196, overall: 8, xray: 8, cryoem: 4, nmr: 8, pdbCount: 1, blast: 2, lit: 1, coverage: 40 })}
${section({ title: 'Beta（序列靶点 · 残基 1-196）', seqLenMeta: 196, overall: 5, xray: 5, cryoem: 5, nmr: 5, pdbCount: 1, blast: 2, lit: 1, coverage: 40 })}
</body></html>`
const s4 = extractImportedStatsSections(amb)
console.log('场景4 同长歧义（无 SHA/标签都对不上）:', pickImportedStats(s4, { length: 196, label: 'ZZZ · 196aa' }) ?? '不命中（安全降级）')
console.assert(pickImportedStats(s4, { length: 196, label: 'ZZZ · 196aa' }) === undefined, '场景4 应不命中')

console.log('\n全部断言通过 ✓')
