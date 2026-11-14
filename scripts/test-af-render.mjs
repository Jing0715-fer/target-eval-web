#!/usr/bin/env node
/**
 * v2.7 验证：AF pLDDT 渲染「区间选择」修复 — 对比旧 resi 数组选择器（仅端点着色，
 * 中段透明）与新 "min-max" 区间字符串（全区间着色）的非白像素覆盖率。
 * 输出两张截图到 scripts/out/ 供人工查看。
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { chromium } from 'playwright'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36'
const UNIPROT = process.argv[2] ?? 'O94952'
const W = 960, H = 640
const PLDDT_COLORS = { hi: '#0053D6', mid: '#65CBF3', low: '#FFDB13', poor: '#FF7D45' }

async function main() {
  const bundle = await fs.readFile('db/cache/3dmol.min.js', 'utf-8')
  // AF 模型 PDB（优先本地 v2/原始缓存都没有 → 在线下载）
  let pdb
  try {
    pdb = await fs.readFile(`scripts/out/${UNIPROT}.pdb`, 'utf-8')
  } catch {
    const res = await fetch(`https://alphafold.ebi.ac.uk/files/AF-${UNIPROT}-F1-model_v6.pdb`, { headers: { 'User-Agent': UA } })
    if (!res.ok) throw new Error(`AF pdb download HTTP ${res.status}`)
    pdb = await res.text()
    await fs.mkdir('scripts/out', { recursive: true })
    await fs.writeFile(`scripts/out/${UNIPROT}.pdb`, pdb, 'utf-8')
  }

  const head = (selExpr) => `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
  html,body { margin:0; padding:0; background:#ffffff; overflow:hidden; }
  #viewport { width:${W}px; height:${H}px; position:relative; }
</style>
<script>${bundle}</script>
</head>
<body>
<div id="viewport"></div>
<script>
(function () {
  var pdb = ${JSON.stringify(pdb)};
  var lines = pdb.split('\\n');
  var resB = {};
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    if (l.indexOf('ATOM  ') !== 0) continue;
    var resi = parseInt(l.slice(22, 26), 10);
    var b = parseFloat(l.slice(60, 66));
    if (Number.isFinite(resi) && Number.isFinite(b) && resB[resi] === undefined) resB[resi] = b;
  }
  var bucketOf = {};
  var ids = Object.keys(resB);
  for (var j = 0; j < ids.length; j++) {
    var r = +ids[j], v = resB[r];
    bucketOf[r] = v >= 90 ? 'hi' : v >= 70 ? 'mid' : v >= 50 ? 'low' : 'poor';
  }
  function runsOf(filter) {
    var sorted = ids.map(Number).sort(function (a, b) { return a - b });
    var runs = [], cur = null;
    for (var k = 0; k < sorted.length; k++) {
      if (bucketOf[sorted[k]] !== filter) continue;
      if (cur && sorted[k] === cur[1] + 1) cur[1] = sorted[k];
      else { if (cur) runs.push(cur); cur = [sorted[k], sorted[k]]; }
    }
    if (cur) runs.push(cur);
    return runs;
  }
  var viewer = $3Dmol.createViewer('viewport', { defaultcolors: $3Dmol.rasmolElementColors });
  viewer.setBackgroundColor(0xffffff);
  viewer.addModel(pdb, 'pdb');
  var groups = [['hi', '${PLDDT_COLORS.hi}'], ['mid', '${PLDDT_COLORS.mid}'], ['low', '${PLDDT_COLORS.low}'], ['poor', '${PLDDT_COLORS.poor}']];
  for (var g = 0; g < groups.length; g++) {
    var runs = runsOf(groups[g][0]);
    for (var q = 0; q < runs.length; q++) {
      var sel = { resi: ${selExpr} };
      viewer.setStyle(sel, { cartoon: { color: groups[g][1] } });
    }
  }
  viewer.zoomTo();
  viewer.zoom(1.2);
  viewer.render();
  window.__READY__ = true;
})();
</script>
</body></html>`

  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] })
  const stats = async (html, file) => {
    const page = await browser.newPage()
    await page.setViewportSize({ width: W, height: H })
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForFunction('window.__READY__ === true', null, { timeout: 20_000, polling: 120 })
    await new Promise(r => setTimeout(r, 600))
    const png = await page.screenshot({ type: 'png' })
    await fs.writeFile(path.join('scripts/out', file), png)
    await page.close()
    // 非白像素统计（sharp 原始通道）
    const sharp = (await import('sharp')).default
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true })
    let nonWhite = 0
    for (let i = 0; i < data.length; i += info.channels) {
      if (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250) nonWhite++
    }
    const total = info.width * info.height
    return { file, nonWhite, total, ratio: +(nonWhite / total * 100).toFixed(2) }
  }

  const oldSel = 'runs[q]'                       // 旧：数组 = 任一命中（仅端点）
  const newSel = "runs[q][0] + '-' + runs[q][1]" // 新：区间字符串
  const s1 = await stats(head(oldSel), `af-old-${UNIPROT}.png`)
  const s2 = await stats(head(newSel), `af-new-${UNIPROT}.png`)
  await browser.close()
  console.log('OLD', s1)
  console.log('NEW', s2)
  console.log(`coverage gain: ${s2.ratio / Math.max(0.01, s1.ratio)}x  (${s1.ratio}% -> ${s2.ratio}%)`)
}

main().catch(e => { console.error(e); process.exit(1) })
