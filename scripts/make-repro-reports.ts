/** 生成 3 份仿真单靶点报告（用户下载目录扁平化命名风格）— 用于浏览器 E2E 复现 */
import * as fs from 'node:fs/promises'
import { createHash } from 'node:crypto'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)

function makeSeq(seed: string, n: number): string {
  const AAS = 'ACDEFGHIKLMNPQRSTVWY'
  let s = ''
  let h = 0
  for (let i = 0; i < n; i++) {
    h = (h * 31 + seed.charCodeAt(i % seed.length) + i) % 9973
    s += AAS[h % 20]!
  }
  return s
}

function section(o: { title: string; overall: number; xray: number; cryoem: number; nmr: number; pdb: number; blast: number; cov: number }) {
  const scoreRow = (label: string, score: number) => `
  <div class="score-row ">
    <div class="score-label">${label}</div>
    <div class="score-track"><div class="score-fill" style="width:${score * 10}%"></div></div>
    <div class="score-num">${score}<span class="score-max">/10</span></div>
    <div class="score-rating">良·可做</div>
  </div>`
  return `
  <h1 class="rpt-title">${esc(o.title)}</h1>
  <div class="meta-grid">
    <div><b>蛋白名称</b> Synthetic Protein</div>
    <div><b>物种</b> Human</div>
    <div><b>序列长度</b> 338 aa</div>
    <div><b>结构证据</b> 直接结构 ${o.pdb} · 同源 ${o.blast} 个 · 文献 4 篇</div>
  </div>
  <div class="glance">
    <div class="glance-score" style="color:#059669">${o.overall}<span>/10</span></div>
    <div class="glance-tile"><div class="gt-label">已有结构</div><div class="gt-value">${o.pdb} 个</div><div class="gt-sub">X-ray 1 · Cryo-EM 1 · 最佳 2.21Å</div></div>
    <div class="glance-tile"><div class="gt-label">结构覆盖率</div><div class="gt-value">${o.cov}%</div><div class="gt-sub">已有结构覆盖完整</div></div>
  </div>
  ${scoreRow('X-ray 结晶', o.xray)}
  ${scoreRow('Cryo-EM 冷冻电镜', o.cryoem)}
  ${scoreRow('NMR 溶液结构', o.nmr)}
  ${scoreRow('综合评估', o.overall)}`
}

const targets = [
  { acc: 'P06763', label: 'refine_coot-1·链1', group: 'G05' },
  { acc: 'P16213', label: 'model-v2·链2', group: 'G12' },
  { acc: 'P42212', label: 'construct-A·链1', group: 'G20' },
]

const dir = '/home/z/my-project/upload/repro'
await fs.mkdir(dir, { recursive: true })
for (const t of targets) {
  const seq = makeSeq(t.acc + t.label, 338)
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>TargetEval_${t.acc}_2026-11-25</title>
<meta name="targeteval:target" content="${esc(JSON.stringify({ uniprot: t.acc, range: [488, 825], seqLength: 338, seqSha: sha(seq), header: t.label }))}">
</head><body>
${section({ title: `${t.label}（${t.acc} · 残基 488-825）`, overall: 9, xray: 5, cryoem: 8, nmr: 4, pdb: 4, blast: 12, cov: 97 })}
</body></html>`
  const name = `TargetEval_HT_2026-11-25_74g ${t.group}_TargetEval_${t.acc}_2026-11-25.html`
  await fs.writeFile(`${dir}/${name}`, html, 'utf-8')
  console.log('wrote', name, html.length, 'bytes')
}
console.log('DONE — files in', dir)
