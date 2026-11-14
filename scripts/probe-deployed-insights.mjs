/**
 * 部署节点浏览器真实路径复现 v2：
 *  分块 init（预期会话丢失）→ 直传回退 stateless=1&noVlm=1（拿 fullText）
 *  → 流式 insights（携带内联 text，LLM 40s 预算 + 心跳）→ 全程计时记录
 * 重点观测：心跳是否穿透网关、done 是否到达、断流的精确时刻与错误原文。
 */
const BASE = process.argv[2] ?? 'https://targeteval.space.zhipuaidemo.cn'
const DOCX = '/home/z/my-project/upload/水木未来-结构解析评估表2026版-2026-11-10 何晓.docx'
import fs from 'node:fs'

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a)

async function main() {
  log(`目标: ${BASE}`)
  // ── 1. 直传（stateless，浏览器回退通道同款） ──
  const form = new FormData()
  form.append('file', new Blob([fs.readFileSync(DOCX)], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), '评估表.docx')
  const t1 = Date.now()
  const up = await fetch(BASE + '/api/evaluate/upload?stateless=1&noVlm=1', { method: 'POST', body: form })
  const upText = await up.text()
  if (!up.ok) { log(`上传 HTTP ${up.status}:`, upText.slice(0, 200)); return }
  const upJson = JSON.parse(upText)
  log(`[1] 直传 HTTP ${up.status} · ${((Date.now() - t1) / 1000).toFixed(1)}s · uploadId=${upJson.uploadId} · fullText=${(upJson.fullText ?? '').length} 字符 · 响应体 ${upText.length}B · images=${upJson.parsed?.images?.length}`)

  // ── 2. 流式 insights（浏览器同款请求体：uploadId + text + goalHints） ──
  const t2 = Date.now()
  log('[2] POST /api/evaluate/insights（流式，内联全文）…')
  let ins
  try {
    ins = await fetch(BASE + '/api/evaluate/insights', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId: upJson.uploadId, force: false, text: upJson.fullText, goalHints: upJson.parsed.goalHints ?? [] }),
    })
  } catch (e) {
    log('  ✗ insights fetch 异常（响应头前失败）:', e.message, '| cause:', e.cause?.code ?? e.cause?.message ?? '')
    return
  }
  log(`  HTTP ${ins.status} · ${ins.headers.get('content-type') ?? ''} · ${((Date.now() - t2) / 1000).toFixed(1)}s 到响应头`)
  if (!ins.ok || !ins.body) {
    log('  失败响应体:', (await ins.text().catch(() => '')).slice(0, 300))
    return
  }
  const reader = ins.body.getReader()
  const dec = new TextDecoder()
  let buf = '', pings = 0, lastPingAt = 0, doneEv = null, readErr = null
  const tStream = Date.now()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const chunkMs = Date.now() - tStream
      buf += dec.decode(value, { stream: true })
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
        if (!line) continue
        try {
          const ev = JSON.parse(line)
          if (ev.type === 'ping') { pings++; lastPingAt = Date.now() - tStream; if (pings <= 3 || pings % 5 === 0) log(`    ping#${pings} @${lastPingAt}ms elapsed=${ev.elapsedMs}ms`) }
          else if (ev.type === 'done') { doneEv = ev; log(`    done @${chunkMs}ms`) ; break }
        } catch { /* 半行 */ }
      }
      if (doneEv) break
    }
  } catch (e) {
    readErr = e
  }
  const totalMs = Date.now() - tStream
  log(`  读流结束 @${totalMs}ms: pings=${pings}（末次 @${lastPingAt}ms）done=${Boolean(doneEv)} readErr=${readErr ? readErr.message + ' | ' + (readErr.cause?.code ?? '') : '无'}`)
  if (readErr && pings > 0 && !doneEv) {
    const gap = totalMs - lastPingAt
    log(`  ⚠ 断流诊断：末次心跳后 ${gap}ms 断开 — ${gap > 45000 ? '心跳停发/网关静默超时' : '心跳间隔内被切断'}`)
  }
  if (doneEv) {
    log(`  done.ok=${doneEv.ok} source=${doneEv.insights?.source} goals=${doneEv.insights?.goals?.length} 条 ligands=${JSON.stringify(doneEv.insights?.ligands)} note=${doneEv.note ?? ''} error=${doneEv.error ?? ''}`)
  }
}

main().catch(e => { console.error('探针失败:', e); process.exit(1) })
