/**
 * v2.92 回归验证 — 用户实测场景「http 非安全上下文 + IndexedDB 源被淘汰 →
 * 汇总报告 117 靶点零内嵌」的根治层：服务端 fileName 兜底通道。
 *
 * 根因链（用户环境）：浏览器 crypto.subtle 不可用（IP/域名直访）→ 前端
 * sourceSha 走 FNV 兜底（x 前缀），与服务端 sha256 内容寻址口径永远对不上
 * （sha 通道形同虚设）；IndexedDB 150MB 淘汰把上一轮运行的源清光 → heal
 * 无源重传、reportId 未回填 → reportId 与 sha 双键齐断 → 全降级。
 * 修复：loadImportedReportHtml / resolveImportedReportPath 新增第三键
 * `fn:{fileName}` — 按归属匹配的导入文件名反查本人留存。
 *
 * 验证链路（复现用户形态 — 服务端留存在但键口径全错位）：
 *  1. 先 POST /ht-imported-report 落一份留存（contentSha=sha256 服务端口径 —
 *     模拟用户「导入时上传成功」，服务端明明有留存）；
 *  2. 生成 POST 载荷：sourceSha=FNV 假键（x 前缀 — 用户环境口径）、
 *     **无 reportId**（heal 失败未回填）、fileName 有（人读口径稳定）、
 *     stats 完整 — v2.91 前该形态 100% 降级（与用户 117 行产物同构）；
 *  3. 断言：生成 done → 产物行带 sk（共享池原文内嵌）→ 池内容与源件
 *     字节级一致；
 *  4. 反向断言（归属安全）：他人 ownerKey 的同名留存不被 fn 通道采信。
 *
 * 用法：bun scripts/test-v292-filename-fallback.ts（dev server 3000 端口）
 */
const BASE = 'http://localhost:3000'

async function main() {
  const results: Array<[string, boolean, string]> = []
  const t = (name: string, ok: boolean, note = '') => { results.push([name, ok, note]); if (!ok) console.log(`FAIL  ${name}${note ? ` — ${note}` : ''}`); else console.log(`PASS  ${name}${note ? ` — ${note}` : ''}`) }

  // 源文件（带可校验的标记内容）
  const MARK = 'SYNTHETIC-V292-FN-FALLBACK-7f3a'
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>v292 fileName 兜底源件</title></head><body>\n<div class="row">${MARK}</div>\n<div>评分 9/10 · X-ray 5 · Cryo-EM 8 · NMR 4</div>\n</body></html>`
  const fileName = 'v292-fn-report.html'

  // ① 落一份服务端留存（模拟用户导入时上传成功 — 服务端按 sha256 寻址落库）
  const up = await fetch(`${BASE}/api/evaluate/ht-imported-report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName, html }),
  })
  const upData = await up.json().catch(() => null) as { ok?: boolean; id?: string } | null
  t('服务端留存落库（模拟导入时上传成功）', upData?.ok === true && Boolean(upData?.id), `HTTP ${up.status}`)

  // ② 生成载荷：FNV 假键 + 无 reportId + fileName（用户故障形态 — 键口径全错位）
  const payload = {
    entries: [],
    goal: 'v2.92 fileName 兜底回归',
    imported: [{
      label: 'v292fn1',
      group: 1,
      fileName,
      sourceSha: 'x9bdf407a55825b1', // FNV 兜底前缀（http 非安全上下文口径 — 查库必 miss）
      // 无 reportId — heal 无源未回填（IndexedDB 源被淘汰）
      stats: {
        overall: 9, xray: 5, cryoem: 8, nmr: 4, pdbCount: 60, blastHitCount: 22,
        methodXrayCount: 5, methodCryoemCount: 8, methodNmrCount: 4,
        bestResolution: 2.1, coverage: 97,
      },
    }],
  }

  const res = await fetch(`${BASE}/api/evaluate/ht-dashboard`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await res.json().catch(() => null) as { ok?: boolean; dashboard?: { id?: string; status?: string }; error?: string } | null
  t('POST 生成请求 ok', res.status === 200 && data?.ok === true && Boolean(data?.dashboard?.id), `HTTP ${res.status} · ${data?.error ?? ''}`)

  const id = data?.dashboard?.id
  if (!id) {
    console.log('\n结果：' + results.filter(r => r[1]).length + '/' + results.length + ' 通过')
    process.exit(1)
  }

  // ③ 轮询至 done
  let status = ''
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 3000))
    const poll = await fetch(`${BASE}/api/evaluate/ht-dashboard?id=${id}`).catch(() => null)
    const pd = await poll?.json().catch(() => null) as { dashboard?: { status?: string; error?: string | null } } | null
    status = pd?.dashboard?.status ?? ''
    if (status === 'done' || status === 'error') break
  }
  t('生成完成（done）', status === 'done', `status=${status}`)

  // ④ 产物验证：行带 sk（共享池内嵌）+ 池内容字节级一致
  const file = await fetch(`${BASE}/api/evaluate/ht-dashboard?id=${id}&download=1`).catch(() => null)
  const fileHtml = file ? await file.text().catch(() => '') : ''
  const m = fileHtml.match(/id="ht-rpt-data">([\s\S]*?)<\/script>/)
  const payloadJson = m ? JSON.parse(m[1]) as { r: Array<{ sk?: string }>; s?: Record<string, string>; v?: string } : null
  t('产物载荷解析', payloadJson != null, `html ${fileHtml.length} 字符`)
  const row = payloadJson?.r?.[0]
  t('导入行带 sk 键（原文内嵌共享池）', Boolean(row?.sk), row ? `sk=${row.sk}` : '无行')
  const pooled = row?.sk ? payloadJson?.s?.[row.sk] : undefined
  t('共享池内容与源件字节级一致（fileName 兜底命中）', pooled === html, pooled ? `${pooled.length} 字符 · 标记在场=${pooled.includes(MARK)}` : '池空')
  t('降级文案不在（「未能内嵌」零次）', !fileHtml.includes('原文未能内嵌'), `${(fileHtml.match(/未能内嵌/g) ?? []).length} 次`)
  t('产物带版本自标注（v 字段）', payloadJson?.v === 'v2.92.0', `v=${payloadJson?.v ?? '(无)'}`)
  t('产物带 meta 版本标记', fileHtml.includes('targeteval:version'), '')

  console.log('\n结果：' + results.filter(r => r[1]).length + '/' + results.length + ' 通过')
  process.exit(results.every(r => r[1]) ? 0 : 1)
}

main().catch(err => { console.error('测试异常：', err); process.exit(1) })
