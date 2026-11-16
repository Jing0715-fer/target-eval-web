const BASE = 'http://localhost:3000'
const res = await fetch(BASE + '/api/evaluate', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ mode: 'uniprot', uniprot: 'O94952', options: { skipBlast: true, maxPdb: 20 } }),
})
const data = await res.json()
console.log('创建作业:', JSON.stringify(data))
if (!data.ok) process.exit(1)
for (let i = 1; i <= 30; i++) {
  await new Promise(r => setTimeout(r, 5000))
  try {
    const j = await fetch(`${BASE}/api/jobs/${data.jobId}`, { cache: 'no-store' }).then(r => r.json())
    if (j.status === 'done' || j.status === 'error') {
      console.log(`[${i * 5}s] 终态: ${j.status} · error=${j.error ?? '—'} · pdbs=${j.pdbs?.length ?? 'null'} · blastHits=${j.blastHits?.length ?? 'null'} · report=${(j.reportMarkdown || '').length} chars`)
      process.exit(j.status === 'done' ? 0 : 1)
    }
    console.log(`[${i * 5}s] ${j.status} ${j.progress?.stage} ${j.progress?.percent}%`)
  } catch (e) { console.log(`[${i * 5}s] 轮询异常:`, e.cause?.code ?? e.message) }
}
console.log('超时未完成'); process.exit(1)
