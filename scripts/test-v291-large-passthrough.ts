/**
 * v2.91 回归验证 — 用户实测场景「汇总报告生成失败：请求体不是合法 JSON」。
 *
 * 根因：v2.88 导入原文直传使生成请求体超过 Next 16 dev 代理默认
 * proxyClientMaxBodySize（10MiB）→ 框架层截断 → req.json() 抛错 → 400。
 * 修复：next.config.ts 提升至 200MiB + 两端预算改字节口径。
 *
 * 验证链路（复现用户场景 — 纯导入运行 + 直传 >10MiB 原文）：
 *  1. POST ht-dashboard：importedSources 携带 12MB HTML（超过旧 10MiB 限）+
 *     imported 载入行（stats 完整统计行）— 修复前此处即 400「请求体不是合法 JSON」；
 *  2. POST 应答 ok + ptStored=1（直传同请求落库成功）；
 *  3. 轮询 GET 至 done（生成不因载荷体积失败）；
 *  4. 产物 HTML 含共享池原文标记（sk 引用 — 字节级内嵌）。
 *
 * 用法：bun scripts/test-v291-large-passthrough.ts（dev server 3000 端口）
 */
const BASE = 'http://localhost:3000'

async function main() {
  const results: Array<[string, boolean, string]> = []
  const t = (name: string, ok: boolean, note = '') => { results.push([name, ok, note]); if (!ok) console.log(`FAIL  ${name}${note ? ` — ${note}` : ''}`); else console.log(`PASS  ${name}${note ? ` — ${note}` : ''}`) }

  // 12MiB HTML（超过旧 10MiB 框架限 — 用户场景的故障载荷量级；ASCII chunk
  // 使字符数=字节数，确保在单份 16MB 字节预算内 — CJK 版本会到 ~3x 字节，
  // 那是字节预算的拒收口径而非本测试目标）
  const chunk = '<div class="row">target-eval-data-row passthrough verify SYNTHETIC-PT-V289</div>\n'
  const bigHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>v291 直传大载荷</title></head><body>\n${chunk.repeat(12 * 1024 * 1024 / chunk.length | 0)}</body></html>`
  t('载荷体积 > 10MiB（复现旧框架限故障量级）', bigHtml.length > 10_485_760, `${(Buffer.byteLength(bigHtml) / 1048576).toFixed(1)}MiB`)

  // 纯导入运行：1 个载入行 + 直传源（sha 客户端口径任意合法 — 服务端落库重算并校正）
  const payload = {
    entries: [],
    goal: 'v2.91 大载荷直传回归',
    imported: [{
      label: 'v291pt1',
      group: 1,
      fileName: 'v291-big-report.html',
      sourceSha: 'v291fakekey01',
      stats: {
        overall: 8, xray: 6, cryoem: 4, nmr: 2, pdbCount: 120, blastHitCount: 45,
        methodXrayCount: 6, methodCryoemCount: 4, methodNmrCount: 2,
        bestResolution: 2.1, coverage: 92,
      },
    }],
    importedSources: [{ sha: 'v291fakekey01', fileName: 'v291-big-report.html', html: bigHtml }],
  }

  const t0 = Date.now()
  const res = await fetch(`${BASE}/api/evaluate/ht-dashboard`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await res.json().catch(() => null) as { ok?: boolean; dashboard?: { id?: string; status?: string; ptStored?: number; ptOffered?: number; ptError?: string }; error?: string } | null
  t('POST 生成请求不再 400（请求体合法 JSON）', res.status !== 400, `HTTP ${res.status} · ${Date.now() - t0}ms`)
  t('POST 应答 ok 且创建看板', data?.ok === true && Boolean(data?.dashboard?.id), data?.error ?? `id=${data?.dashboard?.id}`)
  t('直传原文同请求落库（ptStored=1）', data?.dashboard?.ptStored === 1, `ptOffered=${data?.dashboard?.ptOffered ?? 0} ${data?.dashboard?.ptError ? `err=${String(data.dashboard.ptError).slice(0, 80)}` : ''}`)

  const id = data?.dashboard?.id
  if (!id) {
    console.log(`\n${results.every(r => r[1]) ? '✅' : '❌'} 通过 ${results.filter(r => r[1]).length}/${results.length} 项（无看板 id — 后续步骤跳过）`)
    process.exit(results.every(r => r[1]) ? 0 : 1)
  }

  // 轮询至终态（纯导入运行无 LLM/BLAST 依赖 — 通常秒级完成）
  let final: { status?: string; error?: string | null; htmlPath?: string } | null = null
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000))
    const g = await fetch(`${BASE}/api/evaluate/ht-dashboard?id=${encodeURIComponent(id)}`).then(r => r.json()).catch(() => null) as { ok?: boolean; dashboard?: { status?: string; error?: string | null } } | null
    const st = g?.dashboard?.status
    if (st === 'done' || st === 'error') { final = { status: st, error: g?.dashboard?.error }; break }
  }
  t('生成终态 done（大载荷不致失败）', final?.status === 'done', `status=${final?.status ?? '超时'} ${final?.error ? `err=${String(final.error).slice(0, 120)}` : ''}`)

  // 产物内嵌验证：下载看板 HTML，直传原文进共享池（sk 引用 + SYNTHETIC 标记）
  if (final?.status === 'done') {
    const html = await fetch(`${BASE}/api/evaluate/ht-dashboard?id=${encodeURIComponent(id)}&download=1`).then(r => r.text()).catch(() => '')
    t('看板产物含直传原文（字节级内嵌标记）', html.includes('SYNTHETIC-PT-V289'), `产物 ${(Buffer.byteLength(html) / 1048576).toFixed(1)}MiB`)
  }

  const passed = results.filter(r => r[1]).length
  console.log(`\n${passed === results.length ? '✅ 全部通过' : '❌ 存在失败'}：${passed}/${results.length} 项`)
  process.exit(passed === results.length ? 0 : 1)
}

main().catch(e => { console.error('FATAL', e); process.exit(1) })
