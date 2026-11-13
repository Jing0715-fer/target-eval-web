/**
 * v2.6 BLAST 跨段续跑验证（用户实际场景：O94952 + BLAST 自动）：
 * 跟随 checkpoint 段循环直至终态，校验：
 *  - BLAST 轮询跨段续跑（RID 保留在 checkpoint.state.blastPoll）
 *  - 最终 done + 报告生成
 * 用法：node scripts/e2e-blast-resume.mjs
 */
const BASE = 'http://localhost:3000'

const log = (...a) => console.log(...a)

async function main() {
  const body = {
    mode: 'uniprot',
    uniprot: 'O94952',
    options: { skipBlast: false, maxPdb: 20 },
  }
  const t0 = Date.now()
  let events = 0, progressEvents = 0, final = null, streamErr = null, segments = 0, checkpoint = null
  let blastResumeSeen = 0
  for (let round = 0; round < 100 && !final && !streamErr; round++) {
    const res = await fetch(BASE + '/api/evaluate/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(checkpoint ? { ...body, checkpoint } : body),
    })
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => null)
      throw new Error('sync 启动失败 HTTP ' + res.status + ': ' + JSON.stringify(err).slice(0, 200))
    }
    segments++
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = '', nextCheckpoint = null
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        events++
        try {
          const ev = JSON.parse(line)
          if (ev.type === 'job') {
            progressEvents++
            const msg = String(ev.job.progress?.message || '')
            if (progressEvents % 10 === 0) {
              log(`  [进度 ${progressEvents}] stage=${ev.job.progress?.stage} ${ev.job.progress?.percent}% · ${msg.slice(0, 60)}`)
            }
          } else if (ev.type === 'done') {
            final = ev
          } else if (ev.type === 'error') {
            streamErr = ev.error
            log('  [流错误]', ev.error)
          } else if (ev.type === 'checkpoint' && ev.checkpoint) {
            nextCheckpoint = ev.checkpoint
            const st = ev.checkpoint.state || {}
            if (st.blastPoll) blastResumeSeen++
            log(`  [段 ${segments}] 预算到点 — phase=${st.phase} blastPoll=${Boolean(st.blastPoll)} blastHits=${(st.blastHits || []).length} pdbs=${(st.directPdbs || []).length}`)
          }
        } catch { /* 半行 */ }
      }
      if (final || streamErr || nextCheckpoint) break
    }
    if (final || streamErr) break
    if (nextCheckpoint) { checkpoint = nextCheckpoint; continue }
    throw new Error('流中断：无终态事件')
  }
  log('分段总数:', segments, '· BLAST 轮询跨段:', blastResumeSeen, '次 · 总耗时', ((Date.now() - t0) / 1000).toFixed(1) + 's')
  if (streamErr) throw new Error('评估失败: ' + streamErr)
  if (!final) throw new Error('无终态')
  const job = final.job
  log('  status:', job.status, '· pdbs:', job.pdbs?.length, '· blastHits:', job.blastHits?.length, '· literature:', job.literature?.length)
  log('  blastStatus:', JSON.stringify(job.summary?.blast))
  if (job.status !== 'done') throw new Error('FAIL: 非终态 done')
  if (!final.reportHtml || final.reportHtml.length < 5000) throw new Error('FAIL: reportHtml 缺失或过短')
  log('')
  log('✅ BLAST 跨段续跑 E2E 通过（' + segments + ' 段 · 轮询续跑 ' + blastResumeSeen + ' 次）')
}

main().catch(e => { console.error('❌ E2E 失败:', e.message); process.exit(1) })
