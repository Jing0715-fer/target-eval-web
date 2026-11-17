/** 探查 sync 评估事件的真实结构（调试用） */
const BASE = process.env.EVAL_BASE ?? 'http://localhost:3000'

async function runSegment(body) {
  const res = await fetch(`${BASE}/api/evaluate/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const events = []
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line) { try { events.push(JSON.parse(line)) } catch {} }
    }
  }
  return events
}

let checkpoint
for (let seg = 0; ; seg++) {
  const events = await runSegment({
    mode: 'uniprot',
    uniprot: 'P04637',
    goal: '结构探查（事件形状调试）',
    options: { skipBlast: true, forceBlast: false, maxPdb: 20 },
    ...(checkpoint ? { checkpoint } : {}),
  })
  if (seg === 0) {
    const jobEv = events.find(e => e.type === 'job')
    console.log('── job 事件顶层键:', Object.keys(jobEv?.job ?? {}))
    console.log('── progress 键:', jobEv?.job?.progress ? Object.keys(jobEv.job.progress) : '(无)')
    console.log('── progress 样例:', JSON.stringify(jobEv?.job?.progress)?.slice(0, 600))
    const cp = events.find(e => e.type === 'checkpoint')
    if (cp) {
      console.log('── checkpoint.state 键数:', Object.keys(cp.checkpoint?.state ?? {}).length)
      console.log('── state.scores 键:', Object.keys(cp.checkpoint?.state?.scores ?? {}))
      console.log('── scoreLlmAttempts:', cp.checkpoint?.state?.scoreLlmAttempts)
    }
  }
  const doneEv = events.find(e => e.type === 'done')
  const errEv = events.find(e => e.type === 'error')
  const cpEv = events.find(e => e.type === 'checkpoint')
  if (cpEv) checkpoint = cpEv.checkpoint
  if (doneEv || errEv) {
    if (doneEv) {
      console.log('── done.job 键:', Object.keys(doneEv.job ?? {}))
      console.log('── done.job.summary 类型:', typeof doneEv.job?.summary)
      if (typeof doneEv.job?.summary === 'string') {
        const s = JSON.parse(doneEv.job.summary)
        console.log('── summary.scores 键:', Object.keys(s.scores ?? {}))
        console.log('── llmAdjust:', JSON.stringify(s.scores?.llmAdjust)?.slice(0, 400))
        console.log('── reportHtml 长度:', doneEv.reportHtml?.length ?? '(null)')
        console.log('── AI 复核条在报告中:', doneEv.reportHtml?.includes('llm-adj-strip') ?? '(null)')
      } else if (doneEv.job?.summary) {
        console.log('── summary.scores 键:', Object.keys(doneEv.job.summary.scores ?? {}))
        console.log('── llmAdjust:', JSON.stringify(doneEv.job.summary.scores?.llmAdjust)?.slice(0, 400))
      }
    }
    if (errEv) console.log('── ERROR:', JSON.stringify(errEv).slice(0, 300))
    process.exit(0)
  }
  if (seg > 40) { console.error('段数超限'); process.exit(1) }
}
