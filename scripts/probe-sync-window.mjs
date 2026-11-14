/**
 * 部署网关流式窗口判别实验：
 *   POST /api/evaluate/sync（O94952 + BLAST 自动）— 前 60s+ 为 BLAST 提交/轮询阶段，
 *   无 LLM 参与，但每 1.2s 有 job 进度事件。观测：
 *   ① 字节流是否在 ~24s 后停止转发（网关流式窗口 < 段预算 55s？）
 *   ② checkpoint/done 终态事件是否到达
 *   ③ 每个事件块的到达时刻（判断转发节奏）
 */
const BASE = process.argv[2] ?? 'https://targeteval.space.zhipuaidemo.cn'
import fs from 'node:fs'

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a)

async function main() {
  log(`目标: ${BASE}`)
  const body = {
    mode: 'uniprot',
    uniprot: 'O94952',
    goal: '判别网关流式窗口的对照实验（BLAST 自动）',
    options: { skipBlast: false, maxPdb: 20 },
  }
  const t0 = Date.now()
  log('POST /api/evaluate/sync …')
  let res
  try {
    res = await fetch(BASE + '/api/evaluate/sync', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
  } catch (e) {
    log('sync fetch 异常:', e.message, '| cause:', e.cause?.code ?? ''); return
  }
  log(`HTTP ${res.status} · ${((Date.now() - t0) / 1000).toFixed(1)}s 到响应头`)
  if (!res.ok || !res.body) { log('响应体:', (await res.text().catch(() => '')).slice(0, 200)); return }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = '', jobs = 0, pings = 0, doneEv = null, cpEv = null, errEv = null, readErr = null
  let lastDataAt = 0, firstChunkAt = null
  const tStream = Date.now()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const at = Date.now() - tStream
      if (firstChunkAt == null) firstChunkAt = at
      lastDataAt = at
      buf += dec.decode(value, { stream: true })
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
        if (!line) continue
        try {
          const ev = JSON.parse(line)
          if (ev.type === 'job') { jobs++; if (jobs % 10 === 1) log(`  job#${jobs} @${at}ms stage=${ev.job.progress?.stage} ${ev.job.progress?.percent}%`) }
          else if (ev.type === 'ping') pings++
          else if (ev.type === 'done') { doneEv = ev; log(`  done @${at}ms`) ; break }
          else if (ev.type === 'checkpoint') { cpEv = ev; log(`  checkpoint @${at}ms phase=${ev.checkpoint?.state?.phase}`); break }
          else if (ev.type === 'error') { errEv = ev; log('  流 error @' + at + 'ms:', ev.error); break }
        } catch { /* 半行 */ }
      }
      if (doneEv || cpEv || errEv) break
    }
  } catch (e) {
    readErr = e
  }
  const totalMs = Date.now() - tStream
  log(`读流结束 @${totalMs}ms（距请求发起 ${((Date.now() - t0) / 1000).toFixed(1)}s）: jobs=${jobs} pings=${pings} lastData@${lastDataAt}ms`)
  log(`终态: done=${Boolean(doneEv)} checkpoint=${Boolean(cpEv)} error=${errEv?.error ?? null} readErr=${readErr ? readErr.message + ' | ' + (readErr.cause?.code ?? '') : '无'}`)
  if (readErr && !doneEv && !cpEv) {
    log(`⚠ 字节停止于 ${lastDataAt}ms，socket 死于 ${totalMs}ms — 网关流式窗口 ≈ ${lastDataAt}ms`)
  }
  if (cpEv) {
    // 段预算 55s 的段在网关下到底能不能完整交还 checkpoint？
    log('  → checkpoint 到达：网关可转发 >24s 的流（问题在 insights 侧）；快照留存可续跑验证')
    fs.writeFileSync('/tmp/probe-sync-cp.json', JSON.stringify(cpEv.checkpoint))
  }
  if (doneEv) log(`  job.status=${doneEv.job?.status} pdbs=${doneEv.job?.pdbs?.length} reportHtml=${(doneEv.reportHtml ?? '').length}B`)
}

main().catch(e => { console.error('探针失败:', e); process.exit(1) })
