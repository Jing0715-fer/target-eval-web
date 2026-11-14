/**
 * v2.6.2 部署节点全链路 E2E（真实公网环境）：
 *  1. stateless 直传上传（真实评估表 docx，noVlm=1；本地磁盘可用时同步写盘 → uploadId 可用）
 *  2. 流式 insights — v2.6.2 验证：① uploadId 磁盘模式（用户真实路径，上次 502 的确切请求形态）
 *     ② 心跳 beat 形态断言（首个 beat ≥1KB 且 ≤2.5s 到达 — 复刻 sync 报文形态）
 *     ③ quick 快速兑底（毫秒级返回规则提取）④ text 内联模式兼容覆盖
 *  3. 同步流式评估（v2.6 分段续跑 — O94952 + Resmetirom/ATP 配体 + BLAST 自动）
 *  4. 校验：done 终态、报告、配体归一、分段续跑日志
 * 用法：node scripts/e2e-deployed.mjs [BASE]
 */
const BASE = process.argv[2] ?? 'https://targeteval.space.zhipuaidemo.cn'
const DOCX = '/home/z/my-project/upload/水木未来-结构解析评估表2026版-2026-11-10 何晓.docx'
import fs from 'node:fs'

const log = (...a) => console.log(...a)
const cookieJar = { cookie: '' }

async function jfetch(url, opts = {}) {
  const headers = { ...(opts.headers || {}) }
  if (cookieJar.cookie) headers.cookie = cookieJar.cookie
  let res
  for (let attempt = 1; ; attempt++) {
    try {
      res = await fetch(BASE + url, { ...opts, headers })
      break
    } catch (e) {
      if (attempt >= 3) throw new Error(`fetch ${url} 失败: ${e.cause?.code ?? e.message}`)
      await new Promise(r => setTimeout(r, 800 * attempt))
    }
  }
  const sc = res.headers.getSetCookie?.() ?? []
  if (sc.length) cookieJar.cookie = sc.map(c => c.split(';')[0]).join('; ')
  return res
}

async function main() {
  log(`目标节点: ${BASE}`)
  const tAll = Date.now()

  // ── 1. 直传上传（stateless） ──
  log('── [1] 直传上传（stateless）──')
  const form = new FormData()
  form.append('file', new Blob([fs.readFileSync(DOCX)], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), '评估表.docx')
  const t1 = Date.now()
  const up = await jfetch('/api/evaluate/upload?stateless=1&noVlm=1', { method: 'POST', body: form })
  const upJson = await up.json()
  if (!upJson.ok) throw new Error('上传失败: ' + JSON.stringify(upJson).slice(0, 200))
  log(`  HTTP ${up.status} · ${((Date.now()-t1)/1000).toFixed(1)}s · uploadId: ${upJson.uploadId} · uniprots: ${upJson.parsed.uniprotIds} · fullText: ${(upJson.fullText||'').length} chars · goalHints: ${(upJson.parsed.goalHints||[]).length}`)

  // ── 2. 流式 insights（v2.6.2 — 502 修复验证）──
  log('── [2] 流式 insights（v2.6.2 — uploadId 用户真实路径 + 心跳形态）──')
  const t2 = Date.now()
  const ins = await jfetch('/api/evaluate/insights', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uploadId: upJson.uploadId, text: upJson.fullText, goalHints: upJson.parsed.goalHints || [] }),
  })
  log(`  HTTP ${ins.status} ${ins.headers.get('content-type') ?? ''}`)
  if (!ins.ok || !ins.body) {
    const errText = await ins.text().catch(() => '')
    throw new Error(`FAIL: insights HTTP ${ins.status}（502 未修复！）: ${errText.slice(0, 150)}`)
  }
  const insights = await (async () => {
    const reader = ins.body.getReader()
    const dec = new TextDecoder()
    let buf = '', pings = 0, firstByteMs = null, firstBeatSize = null, doneEv = null
    const tStream = Date.now()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (firstByteMs == null) firstByteMs = Date.now() - tStream
      buf += dec.decode(value, { stream: true })
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
        if (!line) continue
        try {
          const ev = JSON.parse(line)
          if (ev.type === 'ping') { pings++; if (firstBeatSize == null) firstBeatSize = line.length }
          else if (ev.type === 'done') doneEv = ev
        } catch { /* 半行 */ }
      }
      if (doneEv) break
    }
    log(`  首字节 ${firstByteMs}ms · 心跳 ×${pings}（首个 beat ${firstBeatSize}B）· 总耗时 ${((Date.now()-t2)/1000).toFixed(1)}s · source: ${doneEv?.insights?.source}`)
    if (!doneEv) throw new Error('FAIL: insights 流中断无终态')
    // v2.6.2 心跳形态断言：首 beat 与 sync 首事件同量级（≥1KB pad 防小帧被中间层缓冲吞没）
    if (firstBeatSize != null && firstBeatSize < 1000) throw new Error(`FAIL: 心跳 beat 体积 ${firstBeatSize}B < 1KB（小帧将被部署链路缓冲吞没 → 502 复发）`)
    return doneEv
  })()
  if (!insights.ok || !insights.insights) {
    throw new Error('FAIL: insights done.ok=false: ' + JSON.stringify(insights).slice(0, 200))
  }
  const goals = insights.insights.goals || []
  const ligands = insights.insights.ligands || []
  log(`  goals: ${goals.length} 条 · ligands: ${JSON.stringify(ligands)}`)
  if (goals.length < 2) throw new Error('FAIL: goals 少于 2 条（目标未提取）')
  if (!goals.some(g => /三维结构/.test(g))) throw new Error('FAIL: 缺「预期目标一：整体三维结构」')
  if (!goals.some(g => /Resmetirom/.test(g))) throw new Error('FAIL: 缺「预期目标二：Resmetirom 结合模式」')
  if (!ligands.some(l => /resmetirom/i.test(l))) throw new Error('FAIL: ligands 未含 Resmetirom')

  // ── 2b. quick 快速兑底验证（v2.6.2 三级降级末级 — 毫秒级返回规则提取）──
  {
    const tq = Date.now()
    const q = await jfetch('/api/evaluate/insights', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uploadId: upJson.uploadId, force: true, quick: true, text: upJson.fullText, goalHints: upJson.parsed.goalHints || [] }),
    })
    const qj = await q.json().catch(() => null)
    if (q.status !== 200 || !qj?.ok) {
      // 流式响应 — 逐行读 done
      if (q.body) {
        const reader = q.body.getReader(); const dec = new TextDecoder(); let b = ''
        for (;;) {
          const { done, value } = await reader.read(); if (done) break
          b += dec.decode(value, { stream: true })
        }
        const lines = b.split('\n').filter(x => x.includes('"done"'))
        const ev = lines.length ? JSON.parse(lines[lines.length - 1]) : null
        if (!ev?.ok) throw new Error(`FAIL: quick 兑底失败: ${String(b).slice(0, 150)}`)
        log(`  [2b] quick 兑底：${((Date.now()-tq)/1000).toFixed(1)}s · goals ${ev.insights?.goals?.length} 条 · source ${ev.insights?.source}`)
      } else {
        throw new Error(`FAIL: quick 兑底 HTTP ${q.status}`)
      }
    } else {
      log(`  [2b] quick 兑底：${((Date.now()-tq)/1000).toFixed(1)}s · goals ${qj.insights?.goals?.length} 条`)
    }
  }

  // ── 3. 同步流式评估（分段续跑 — O94952 + BLAST 自动 + 配体） ──
  log('── [3] 同步流式评估（O94952 · BLAST 自动 · 分段续跑）──')
  const t3 = Date.now()
  const baseBody = {
    mode: 'docx',
    docxJobId: upJson.uploadId,
    uploadId: upJson.uploadId,
    uniprotFromDocx: upJson.parsed.uniprotIds[0],
    goal: goals.slice(0, 2).join('；'),
    ligands: [
      { raw: 'Resmetirom', source: 'eval-table' },
      { raw: 'ATP', source: 'text' },
    ],
    evalTable: {
      fullText: upJson.fullText,
      goalHints: upJson.parsed.goalHints || [],
      images: [],
      insights: insights.insights,
    },
    options: { skipBlast: false, maxPdb: 20 },
  }
  let events = 0, progressEvents = 0, final = null, streamErr = null, segments = 0, checkpoint = null, blastResume = 0
  for (let round = 0; round < 100 && !final && !streamErr; round++) {
    const res = await jfetch('/api/evaluate/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(checkpoint ? { ...baseBody, checkpoint } : baseBody),
    })
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => null)
      throw new Error('sync 启动失败 HTTP ' + res.status + ': ' + JSON.stringify(err).slice(0, 200))
    }
    segments++
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = '', nextCp = null
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
        if (!line) continue
        events++
        try {
          const ev = JSON.parse(line)
          if (ev.type === 'job') {
            progressEvents++
            if (progressEvents % 15 === 0) {
              log(`  [进度 ${progressEvents}] stage=${ev.job.progress?.stage} ${ev.job.progress?.percent}% · ${String(ev.job.progress?.message || '').slice(0, 55)}`)
            }
          } else if (ev.type === 'done') {
            final = ev
          } else if (ev.type === 'error') {
            streamErr = ev.error
            log('  [流错误]', ev.error)
          } else if (ev.type === 'checkpoint' && ev.checkpoint) {
            nextCp = ev.checkpoint
            if (ev.checkpoint.state?.blastPoll) blastResume++
            log(`  [段 ${segments}] 预算到点 — phase=${ev.checkpoint.state?.phase} blastPoll=${Boolean(ev.checkpoint.state?.blastPoll)} · 携快照续跑`)
          }
        } catch { /* 半行 */ }
      }
      if (final || streamErr || nextCp) break
    }
    if (final || streamErr) break
    if (nextCp) { checkpoint = nextCp; continue }
    throw new Error('流中断：无终态事件（events=' + events + '）')
  }
  log(`  分段总数: ${segments} · BLAST 跨段续跑: ${blastResume} 次 · 耗时 ${((Date.now()-t3)/1000).toFixed(1)}s`)

  // ── 4. 校验 ──
  log('── [4] 校验结果 ──')
  if (streamErr) throw new Error('评估失败: ' + streamErr)
  if (!final) throw new Error('无终态')
  const job = final.job
  log(`  status: ${job.status} · pdbs: ${job.pdbs?.length} · blastHits: ${job.blastHits?.length} · literature: ${job.literature?.length}`)
  log(`  blastStatus: ${JSON.stringify(job.summary?.blast)}`)
  if (job.status !== 'done') throw new Error('FAIL: 非终态 done')
  const lig = job.summary?.ligands ?? []
  for (const l of lig) {
    log(`    - raw="${l.raw}" ok=${l.ok} compId="${l.compId}" formula=${l.formula} strategy=${l.strategy}`)
  }
  const resmetirom = lig.find(l => /resmetirom/i.test(l.raw))
  if (!resmetirom) throw new Error('FAIL: Resmetirom 未出现在配体结果')
  if (!resmetirom.ok) throw new Error('FAIL: Resmetirom 归一失败: ' + (resmetirom.error || ''))
  if (resmetirom.formula !== 'C17H12Cl2N6O4') throw new Error('FAIL: Resmetirom 分子式不符: ' + resmetirom.formula)
  if (!final.reportHtml || final.reportHtml.length < 5000) throw new Error('FAIL: reportHtml 缺失或过短')
  log(`  reportHtml: ${final.reportHtml.length} chars`)
  log('')
  log(`✅ 部署节点 E2E 全链路通过（总耗时 ${((Date.now()-tAll)/1000).toFixed(0)}s）：上传 → 流式 insights（无 502 · ${insights.insights.source} 提取）→ 分段评估（${segments} 段${blastResume ? ` · BLAST 跨段 ×${blastResume}` : ''}）→ 配体归一 → HTML 报告`)
}

main().catch(e => { console.error('❌ E2E 失败:', e.message); process.exit(1) })
