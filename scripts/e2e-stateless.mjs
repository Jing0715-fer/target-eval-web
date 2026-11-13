/**
 * v2.4 无状态链路 E2E（本地模拟部署环境行为）：
 *  1. 直传上传（stateless=1&noVlm=1）→ 解析 UniProt/全文内联
 *  2. insights 内联全文 LLM 解析 → 提取配体
 *  3. POST /api/evaluate/sync 同步流式评估（含 evalTable 内联 + 配体）
 *  4. 校验：流式事件、最终 JobDetail、配体归一（Resmetirom → PubChem）、reportHtml
 */
const BASE = 'http://localhost:3000'
const DOCX = '/home/z/my-project/upload/水木未来-结构解析评估表2026版-2026-11-10 何晓.docx'
import fs from 'node:fs'

const log = (...a) => console.log(...a)
const cookieJar = { cookie: '' }

async function jfetch(url, opts = {}) {
  const headers = { ...(opts.headers || {}) }
  if (cookieJar.cookie) headers.cookie = cookieJar.cookie
  let res
  // 瞬态网络失败（sandbox DNS 冷启动）自动重试 3 次
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
  // ── 1. 直传上传（无状态模式）──
  log('── [1] 直传上传（stateless）──')
  const form = new FormData()
  form.append('file', new Blob([fs.readFileSync(DOCX)], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), '评估表.docx')
  const up = await jfetch('/api/evaluate/upload?stateless=1&noVlm=1', { method: 'POST', body: form })
  const upJson = await up.json()
  if (!upJson.ok) throw new Error('上传失败: ' + JSON.stringify(upJson).slice(0, 200))
  log('  uploadId:', upJson.uploadId, '· stateless:', upJson.stateless, '· uniprots:', upJson.parsed.uniprotIds, '· fullText:', (upJson.fullText || '').length, 'chars · goalHints:', (upJson.parsed.goalHints || []).length)

  // v2.5：直传响应的 goalHints 已结构化（无空标签行、无模板段）
  const gh = upJson.parsed.goalHints || []
  log('  v2.5 goalHints =', JSON.stringify(gh))
  if (gh.length < 3) throw new Error('FAIL: v2.5 goalHints 少于 3 条（预期目标未提取）')
  if (gh.some(g => /^预期目标|^一、项目目的|^四、项目目标/.test(g) && g.replace(/：$/, '').length <= 8))
    throw new Error('FAIL: v2.5 goalHints 仍含空标签行')
  if (!gh.some(g => /Resmetirom/.test(g))) throw new Error('FAIL: v2.5 goalHints 未含 Resmetirom 目标行')

  // ── 2. insights 内联解析 ──
  log('── [2] insights 内联解析 ──')
  const ins = await jfetch('/api/evaluate/insights', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: upJson.fullText, goalHints: upJson.parsed.goalHints || [] }),
  })
  const insJson = await ins.json()
  if (!insJson.ok) throw new Error('insights 失败: ' + JSON.stringify(insJson).slice(0, 200))
  const insights = insJson.insights
  log('  source:', insights.source, '· goals:', insights.goals?.length, '· ligands:', JSON.stringify(insights.ligands))

  // v2.5：无论 LLM 可用与否，goals 应覆盖两条核心预期目标（三维结构 + Resmetirom 结合），
  // ligands 应含 Resmetirom（LLM 路径或规则兜底路径均可）
  const igoals = (insights.goals || []).map(g => String(g))
  if (igoals.length < 2) throw new Error('FAIL: insights goals 少于 2 条（预期目标未提取）')
  if (!igoals.some(g => /整体三维结构/.test(g))) throw new Error('FAIL: insights goals 缺「预期目标一：整体三维结构」')
  if (!igoals.some(g => /Resmetirom/.test(g))) throw new Error('FAIL: insights goals 缺「预期目标二：Resmetirom 结合模式」')
  if (!(insights.ligands || []).some(l => /resmetirom/i.test(l)))
    throw new Error('FAIL: insights.ligands 未含 Resmetirom（规则兜底应提名）')

  // ── 3. 同步流式评估（v2.6 分段续跑 — 跟随 checkpoint 段循环直至终态）──
  log('── [3] 同步流式评估（O94952 + Resmetirom + evalTable 内联 · v2.6 分段续跑）──')
  const t0 = Date.now()
  const baseBody = {
    mode: 'docx',
    docxJobId: upJson.uploadId,
    uploadId: upJson.uploadId,
    uniprotFromDocx: upJson.parsed.uniprotIds[0],
    goal: (insights.goals || []).slice(0, 2).join('；'),
    ligands: [
      { raw: 'Resmetirom', source: 'eval-table' },
      { raw: 'ATP', source: 'text' },
    ],
    evalTable: {
      fullText: upJson.fullText,
      goalHints: upJson.parsed.goalHints || [],
      images: [],
      insights,
    },
    options: { skipBlast: true, maxPdb: 20 },
  }
  let events = 0
  let progressEvents = 0
  let final = null
  let streamErr = null
  let segments = 0
  let checkpoint = null
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
    const decoder = new TextDecoder()
    let buf = ''
    let nextCheckpoint = null
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
            if (progressEvents <= 3 || progressEvents % 10 === 0) {
              log(`  [进度 ${progressEvents}] stage=${ev.job.progress?.stage} ${ev.job.progress?.percent}% · ${String(ev.job.progress?.message || '').slice(0, 50)}`)
            }
          } else if (ev.type === 'done') {
            final = ev
          } else if (ev.type === 'error') {
            streamErr = ev.error
            log('  [流错误]', ev.error)
          } else if (ev.type === 'checkpoint' && ev.checkpoint) {
            nextCheckpoint = ev.checkpoint
            log(`  [段 ${segments}] 预算到点 — phase=${ev.checkpoint.state?.phase}，携快照续跑…`)
          } else if (ev.type === 'ping') {
            log('  [心跳]')
          }
        } catch { /* 半行 */ }
      }
      if (final || streamErr || nextCheckpoint) break
    }
    if (final || streamErr) break
    if (nextCheckpoint) { checkpoint = nextCheckpoint; continue }
    throw new Error('流中断：无终态事件（events=' + events + '）')
  }
  log('  分段总数:', segments, '（含 checkpoint 续跑）')

  // ── 4. 校验 ──
  log('── [4] 校验结果 ──')
  if (streamErr) throw new Error('评估失败: ' + streamErr)
  if (!final) throw new Error('流中断：无 done 事件（events=' + events + '）')
  const job = final.job
  log('  总事件数:', events, '· 进度事件:', progressEvents, '· 耗时:', ((Date.now() - t0) / 1000).toFixed(1) + 's')
  log('  status:', job.status, '· summary.uniprot:', job.summary?.uniprot?.uniprotId, job.summary?.uniprot?.proteinName)
  log('  pdbs:', job.pdbs?.length, '· blastHits:', job.blastHits?.length, '· literature:', job.literature?.length)

  // v2.5：报告含 Resmetirom（配体研究数据入报告）
  const ligInReport = /Resmetirom/i.test(final.reportHtml || '') || /Resmetirom/i.test(job.reportMarkdown || '')
  log('  v2.5 报告含 Resmetirom:', ligInReport)
  if (!ligInReport) throw new Error('FAIL: 报告未包含 Resmetirom 配体研究数据')
  log('  reportMarkdown:', (job.reportMarkdown || '').length, 'chars · reportHtml:', (final.reportHtml || '').length, 'chars')

  const ligands = job.summary?.ligands ?? []
  log('  配体归一结果:')
  for (const l of ligands) {
    log(`    - raw="${l.raw}" ok=${l.ok} compId="${l.compId}" name="${l.name}" formula=${l.formula} weight=${l.weight} strategy=${l.strategy} structures=${l.totalStructures} pubchem=${l.pubchem?.cid ?? '—'}`)
  }
  const resmetirom = ligands.find(l => /resmetirom/i.test(l.raw))
  if (!resmetirom) throw new Error('FAIL: Resmetirom 未出现在配体结果中')
  if (!resmetirom.ok) throw new Error('FAIL: Resmetirom 归一失败: ' + (resmetirom.error || ''))
  if (resmetirom.formula !== 'C17H12Cl2N6O4') throw new Error('FAIL: Resmetirom 分子式不符: ' + resmetirom.formula)
  const atp = ligands.find(l => l.raw === 'ATP')
  if (!atp || !atp.ok || atp.compId !== 'ATP') throw new Error('FAIL: ATP 未归一到 compId=ATP')
  if (!final.reportHtml || final.reportHtml.length < 5000) throw new Error('FAIL: reportHtml 缺失或过短')
  if (!final.reportHtml.includes('rpt-head')) throw new Error('FAIL: reportHtml 无报告头（渲染异常）')
  if (!job.summary?.ligands?.length) throw new Error('FAIL: summary.ligands 空')

  log('')
  log('✅ E2E 全链路通过：直传上传 → 内联 insights → 同步流式评估 → 配体归一（Resmetirom→PubChem C17H12Cl2N6O4 / ATP→direct-id）→ 内联 HTML 报告')
}

main().catch(e => { console.error('❌ E2E 失败:', e.message); process.exit(1) })
