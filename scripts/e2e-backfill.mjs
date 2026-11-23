/**
 * v2.72 E2E：导入报告统计服务端补解析（backfillImportedStats）。
 * 链路：上传合成报告 → 无 stats 的导入靶点生成看板 → 轮询 → 验证表格含评分（非「—」降级行）。
 */
const BASE = 'http://localhost:3000'
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
const SEQ = 'MKTAYIAKQRQISFVKSHFSRQ' + 'LEKLA'.repeat(35) // 22 + 175 = 197? compute below
const seq = ('MKTAYIAKQRQISFVKSHFSRQ' + 'LEKLA'.repeat(35)).slice(0, 196)
const sha = async (s) => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(buf.slice(0, 8))).map(b => b.toString(16).padStart(2, '0')).join('')
}
const scoreRow = (label, score) => `
  <div class="score-row ">
    <div class="score-label">${label}</div>
    <div class="score-track"><div class="score-fill" style="width:${score * 10}%"></div></div>
    <div class="score-num">${score}<span class="score-max">/10</span></div>
    <div class="score-rating">Good·良好</div>
  </div>`
const reportHtml = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<title>靶点结构解析可行性评估报告 — RBD-fab-240816_refined_ned_006（序列靶点 · 残基 1-196）</title>
<meta name="targeteval:target" content="${esc(JSON.stringify({ seqLength: 196, seqSha: await sha(seq), header: 'RBD-fab-240816_refined_ned_006', label: 'RBD-fab-240816_refined_ned_006 · 196aa' }))}">
</head><body><div class="page">
<h1 class="rpt-title">RBD-fab-240816_refined_ned_006（序列靶点 · 残基 1-196）</h1>
<div class="meta-grid">
  <div><b>蛋白名称</b> Receptor-binding domain</div>
  <div><b>物种</b> SARS-CoV-2</div>
  <div><b>序列长度</b> 196 aa</div>
  <div><b>结构证据</b> 直接结构 3 · 同源 12 个 · 文献 5 篇</div>
</div>
<div class="glance">
  <div class="glance-score" style="color:#0d9488">7<span>/10</span></div>
  <div class="glance-tile"><div class="gt-label">已有结构</div><div class="gt-value">3 个</div><div class="gt-sub">X-ray 2 · Cryo-EM 1 · NMR 0 · 最佳 2.80Å</div></div>
  <div class="glance-tile"><div class="gt-label">结构覆盖率</div><div class="gt-value">87%</div><div class="gt-sub">已有结构覆盖完整</div></div>
</div>
${scoreRow('X-ray 结晶', 8)}
${scoreRow('Cryo-EM 冷冻电镜', 6)}
${scoreRow('NMR 溶液结构', 7)}
${scoreRow('综合评估', 7)}
</div></body></html>`

// ① 上传报告原文
const up = await fetch(`${BASE}/api/evaluate/ht-imported-report`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ fileName: 'G74_RBD-fab-240816_refined_ned_006 · 196aa', html: reportHtml }),
}).then(r => r.json())
if (!up.ok || !up.id) { console.error('上传失败:', up); process.exit(1) }
console.log('① 上传报告 → reportId:', up.id)

// ② 无 stats 生成看板（模拟客户端解析失败的降级行 — 服务端应补解析回填）
const dash = await fetch(`${BASE}/api/evaluate/ht-dashboard`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    entries: [],
    imported: [{ label: 'RBD-fab-240816_refined_ned_006 · 196aa', group: 1, sequence: seq, fileName: 'G74_RBD-fab….html', reportId: up.id }],
    goal: '抗原-抗体复合物结构解析',
  }),
}).then(r => r.json())
if (!dash.ok) { console.error('看板创建失败:', dash); process.exit(1) }
console.log('② 看板创建 → id:', dash.dashboard.id, '（无 stats 导入靶点 — 待服务端补解析）')

// ③ 轮询至终态
let status = null, progressSeen = []
for (let i = 0; i < 120; i++) {
  await new Promise(r => setTimeout(r, 2000))
  const st = await fetch(`${BASE}/api/evaluate/ht-dashboard?id=${dash.dashboard.id}`).then(r => r.json())
  status = st.dashboard?.status ?? st.status
  if (st.dashboard?.progress) progressSeen.push(st.dashboard.progress)
  if (status === 'done' || status === 'error') break
}
console.log('③ 终态:', status, '| 轮询期间进度文案:', [...new Set(progressSeen)].slice(0, 6))
if (status !== 'done') {
  const st = await fetch(`${BASE}/api/evaluate/ht-dashboard?id=${dash.dashboard.id}`).then(r => r.json())
  console.error('错误:', st.dashboard?.error ?? st.error); process.exit(1)
}

// ④ 验证看板 HTML：评分列已回填（非「—」降级行）
const html = await fetch(`${BASE}/api/evaluate/ht-dashboard?id=${dash.dashboard.id}&inline=1`).then(r => r.text())
const hasBare = html.includes('已有报告（导入匹配）— 本次运行未重复评估')
const hasScores = /score mini (hi|md|lo)" title="X-ray 方法评分">8/.test(html)
const hasCryoem6 = /title="Cryo-EM 方法评分">6/.test(html)
const hasParsedRow = html.includes('评分/结构/结论解析自导入的报告文件')
console.log(`④ 看板验证：降级行文案存在=${hasBare}（应 false）| X-ray 8 分=${hasScores} | Cryo-EM 6 分=${hasCryoem6} | 解析行说明=${hasParsedRow}`)
console.log('载入统计行数：', (html.match(/tg-load/g) ?? []).length)
if (hasBare || !hasScores || !hasCryoem6) { console.error('✗ 补解析回填未生效'); process.exit(1) }
console.log('✓ E2E 通过：无 stats 的导入靶点已由服务端补解析为完整统计行')
