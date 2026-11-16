/**
 * v2.14 E2E：重跑 Q99603（TRGV9）单独评估 — 验证冷冻电镜先例进入评分/装配/报告
 * 修复前（历史作业）：X-ray 6 / Cryo-EM 3 / NMR 8 · mwAugment 装配 27 kDa（oligomer）
 * 修复后预期：Cryo-EM ≥7 · 装配路径 complex ≥100 kDa · rationale 含先例表述 · 报告推荐含 Cryo-EM 路线
 * 处理 sync 路由的 14s 段预算：checkpoint 事件 → 回传续跑直至 done
 */
const BASE = 'http://localhost:3000'
const log = (...a) => console.log(...a)

async function runSegment(checkpoint) {
  const res = await fetch(BASE + '/api/evaluate/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mode: 'uniprot',
      uniprot: 'Q99603',
      goal: '',
      options: { skipBlast: false, reportMode: 'single' },
      ...(checkpoint ? { checkpoint } : {}),
    }),
  })
  if (!res.ok || !res.body) throw new Error('sync 启动失败 HTTP ' + res.status)
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = '', doneEv = null, cpEv = null, errEv = null, lastStage = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
      if (!line) continue
      try {
        const ev = JSON.parse(line)
        if (ev.type === 'job') {
          const st = ev.job?.progress?.stage ?? ''
          if (st && st !== lastStage) { lastStage = st; log(`  [${st}] ${ev.job?.progress?.message ?? ''}`) }
        } else if (ev.type === 'done') doneEv = ev
        else if (ev.type === 'checkpoint') cpEv = ev
        else if (ev.type === 'error') errEv = ev
      } catch { /* 半行 */ }
    }
  }
  return { doneEv, cpEv, errEv }
}

async function main() {
  let checkpoint = null
  for (let seg = 1; seg <= 60; seg++) {
    if (seg > 1) log(`── 续跑段 ${seg} ──`)
    const { doneEv, cpEv, errEv } = await runSegment(checkpoint)
    if (errEv) throw new Error('评估失败: ' + errEv.error)
    if (doneEv) return finish(doneEv)
    if (cpEv) { checkpoint = cpEv.checkpoint; continue }
    throw new Error('流结束但无 done/checkpoint 事件')
  }
  throw new Error('续跑段数超限')
}

async function finish(doneEv) {
  const job = doneEv.job
  const summary = typeof job.summary === 'string' ? JSON.parse(job.summary) : (job.summary ?? {})
  const s = summary.scores ?? job.scores
  log('\n══ E2E 结果 ══')
  log(`作业: ${job.id} · ${job.title}`)
  log(`评分: X-ray ${s.xray.score} / Cryo-EM ${s.cryoem.score} / NMR ${s.nmr.score} / 总体 ${s.overall.score}（修复前：6 / 3 / 8）`)
  log(`mwAugment: applicable=${summary.mwAugment?.applicable} 单体 ${summary.mwAugment?.monomerKda} kDa → 装配 ${summary.mwAugment?.assemblyKda} kDa（路径 ${summary.mwAugment?.assemblyPath}；复合物 ${summary.mwAugment?.complexes?.length} 个）`)
  log(`方法统计: ${JSON.stringify(summary.methodStats)}`)
  const html = doneEv.reportHtml ?? ''
  const ratCryoem = (html.match(/· Cryo-EM：([^<]*)/) ?? [])[1] ?? ''
  const ratNmr = (html.match(/· NMR：([^<]*)/) ?? [])[1] ?? ''
  log(`rationale.cryoem（报告 HTML）: ${ratCryoem}`)
  log(`rationale.nmr（报告 HTML）: ${ratNmr}`)

  const md = job.reportMarkdown ?? ''
  const c2 = md.split(/## (?=结构解析可行性评估)/)[1]?.split(/^## /m)[0] ?? ''
  log(`\nC2 章节（结构解析可行性评估，${c2.length} 字）关键句检测:`)
  const checks = [
    ['评分达标', s.cryoem.score >= 7],
    ['装配路径 complex ≥100kDa', summary.mwAugment?.assemblyPath === 'complex' && (summary.mwAugment?.assemblyKda ?? 0) >= 100],
    ['rationale 含 Cryo-EM 先例', ratCryoem.includes('Cryo-EM 结构先例')],
    ['rationale 无「改用其他方法」', !ratCryoem.includes('改用其他方法')],
    ['报告 C2 含复合物/Cryo-EM 推荐路线', /Cryo-EM|冷冻电镜/.test(c2) && /复合物|装配/.test(c2)],
    ['报告 C2 不再单独推荐 NMR 首选', !/第一推荐[^。]{0,20}NMR/.test(c2)],
  ]
  let fail = 0
  for (const [name, ok] of checks) {
    log(`${ok ? '✓' : '✗ FAIL'} ${name}`)
    if (!ok) fail++
  }
  if (fail) process.exitCode = 1
  else log('\n=== E2E 全部通过 ===')
  log('\n──── C2 章节全文（前 1600 字）────\n' + c2.slice(0, 1600))
}

main().catch(e => { console.error('E2E ERR', e); process.exit(1) })
