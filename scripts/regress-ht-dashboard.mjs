#!/usr/bin/env node
/**
 * regress-ht-dashboard.mjs — v2.28 高通量统计看板 + 文献补全 + SIFTS 范围回填回归。
 *
 * 用户三项反馈：
 *  ① 手动输入范围后 PDB 列表未严格过滤（chainRanges 缺失的条目默认保留）
 *    → SIFTS 链范围回填后复滤（管线 phasePdbe）— E 段 LIVE 验证
 *  ② 文献列表不全（PDB 主引文 cap=20，同源命中文献未并入）
 *    → cap 120 + BLAST 命中 PMID 并入 — E 段 LIVE 验证
 *  ③ 高通量完成后缺统计看板 / AI 整体可行性报告 / 每靶点一句话结论
 *    → POST /api/evaluate/ht-dashboard（B/C/D 段）
 *
 * A. 入口防线：空 entries（400）/ 仅 merged 条目（400）/ 不存在 id（404）
 * B. 真实作业看板（内置引擎）：DB 已完成作业 → POST → 轮询 done → HTML 断言
 *    （统计卡/每靶点一句话结论/离线 zip 链接/在线链接/AI 报告或降级提示）
 * C. zip 归档一致性：ht-archive 含 dashboardId → zip 内 00_统计看板 根级文件 +
 *    看板内 G01/…html 链接与 zip 实际文件名逐一对应（共享 planArchiveNames）
 * D. LLM 失败降级：假 DeepSeek Key → 看板仍 done + 规则结论 + 降级提示
 * E. LIVE（LIVE=1）：EGFR 695-1022 完整作业 — 全部结构链范围已知且重叠 +
 *    PDB 携带 PMID 全部入文献列表
 *
 * 运行：node scripts/regress-ht-dashboard.mjs（LIVE=1 额外跑 E 段完整作业，约 2-3 分钟）
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const JSZip = require_('jszip')

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// ─── dev server：优先复用常驻 :3000（Next 16 同目录锁禁止第二实例）────────────
const PORT = Number(process.env.HT_REGRESS_PORT ?? 3000)
const ROOT = new URL('..', import.meta.url).pathname
const base = `http://127.0.0.1:${PORT}`

const probe = async () => {
  try {
    const r = await fetch(`${base}/api/llm/config`, { signal: AbortSignal.timeout(3000) })
    return r.ok
  } catch { return false }
}

if (!(await probe())) {
  const proc = spawn('npx', ['next', 'dev', '-p', String(PORT)], {
    cwd: ROOT, env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  })
  for (let i = 0; i < 150; i++) {
    if (await probe()) break
    await new Promise(r => setTimeout(r, 1000))
  }
}
ok('dev server 就绪', await probe())

/** DB 已完成作业（带报告）— 通过 GET /api/jobs 列表取（归属一致；返回裸数组或 {items}） */
const listDoneJobs = async () => {
  const res = await fetch(`${base}/api/jobs?take=30`, { cache: 'no-store', signal: AbortSignal.timeout(15_000) })
  const data = await res.json().catch(() => null)
  const items = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : [])
  return items.filter(j => j.status === 'done')
}

const pollDashboard = async (id, maxMs = 240_000) => {
  const t0 = Date.now()
  for (;;) {
    await new Promise(r => setTimeout(r, 3000))
    const res = await fetch(`${base}/api/evaluate/ht-dashboard?id=${encodeURIComponent(id)}`, { cache: 'no-store', signal: AbortSignal.timeout(15_000) })
    const data = await res.json().catch(() => null)
    const st = data?.dashboard?.status
    if (st === 'done' || st === 'error') return { status: st, error: data?.dashboard?.error ?? null }
    if (Date.now() - t0 > maxMs) return { status: 'timeout', error: '轮询超时' }
  }
}

const getDashboardHtml = async (id) => {
  const res = await fetch(`${base}/api/evaluate/ht-dashboard?id=${encodeURIComponent(id)}&inline=1`, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) return null
  return res.text()
}

const doneJobs = await listDoneJobs()
ok('DB 存在已完成作业（看板可测）', doneJobs.length >= 2, `${doneJobs.length} 个`)

// ─── A. 入口防线 ─────────────────────────────────────────────────────────────
console.log('── A. 入口防线 ──')
{
  const r = await fetch(`${base}/api/evaluate/ht-dashboard`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: [] }),
    signal: AbortSignal.timeout(15_000),
  })
  ok('A1 空 entries → 400', r.status === 400, `HTTP ${r.status}`)
}
{
  const r = await fetch(`${base}/api/evaluate/ht-dashboard`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: [{ mergedId: 'cmfakefakefakefake000000' }] }),
    signal: AbortSignal.timeout(15_000),
  })
  ok('A2 仅 merged 条目（无 jobId）→ 400', r.status === 400 || r.status === 404, `HTTP ${r.status}`)
}
{
  const r = await fetch(`${base}/api/evaluate/ht-dashboard?id=nonexistent0000000000`, { signal: AbortSignal.timeout(15_000) })
  ok('A3 不存在 id → 404', r.status === 404, `HTTP ${r.status}`)
}

// ─── B/C. 真实作业看板 + zip 归档一致性 ─────────────────────────────────────
console.log('── B. 真实作业看板（内置引擎）──')
if (doneJobs.length >= 2) {
  // 取前 4 个已完成作业（与 zip 归档同构 entries：组号 + 标签）
  const picked = doneJobs.slice(0, 4)
  const entries = picked.map((j, i) => ({ jobId: j.id, group: (i % 2) + 1, label: `${j.uniprotId || '靶点'}:regress` }))
  const post = await fetch(`${base}/api/evaluate/ht-dashboard`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries, goal: '回归验证：整体可行性统计' }),
    signal: AbortSignal.timeout(30_000),
  })
  const created = await post.json().catch(() => null)
  ok('B1 POST 创建（running）', post.ok && created?.dashboard?.id, JSON.stringify(created).slice(0, 120))
  if (created?.dashboard?.id) {
    const dashId = created.dashboard.id
    const fin = await pollDashboard(dashId)
    ok('B2 生成终态 done（LLM best-effort 不阻塞）', fin.status === 'done', JSON.stringify(fin))
    const html = await getDashboardHtml(dashId)
    ok('B3 HTML 可取（inline）', typeof html === 'string' && html.length > 2000, html ? `${html.length} 字节` : 'null')
    if (html) {
      ok('B4 统计卡（参与靶点/总体均分/建议推进）', /参与靶点/.test(html) && /总体均分/.test(html) && /建议推进/.test(html))
      ok('B5 每靶点一句话结论表', /每靶点结论/.test(html) && /(建议推进|谨慎推进|不建议)/.test(html))
      ok('B6 总分分布 + 方法可用性', /总分分布/.test(html) && /方法可用性/.test(html))
      const zipLinks = [...html.matchAll(/href="(G\d+\/[^"]+\.html)"/g)].map(m => m[1])
      ok('B7 单独报告离线链接（zip 相对路径 G01/…）', zipLinks.length >= 1, JSON.stringify(zipLinks.slice(0, 3)))
      ok('B8 单独报告在线链接（/api/jobs/{id}/report）', /\/api\/jobs\/[a-z0-9]+\/report\?download=1/.test(html))
      ok('B9 AI 整体可行性报告章节', /AI 整体可行性报告/.test(html))
      ok('B10 看板自包含（无外链资源）', !/<link[^>]+href=/.test(html) && !/<script[^>]+src=/.test(html))

      // ── C. zip 归档一致性：ht-archive 带 dashboardId ──
      console.log('── C. zip 归档一致性 ──')
      const archiveEntries = [...entries.map(e => ({ ...e, label: e.label })), { dashboardId: dashId }]
      const arcRes2 = await fetch(`${base}/api/evaluate/ht-archive?entries=${encodeURIComponent(JSON.stringify(archiveEntries))}`, {
        signal: AbortSignal.timeout(120_000),
      })
      ok('C1 zip 打包（含看板）HTTP 200', arcRes2.ok, `HTTP ${arcRes2.status}`)
      if (arcRes2.ok) {
        const zip = await JSZip.loadAsync(await arcRes2.arrayBuffer())
        const names = Object.keys(zip.files).filter(n => !zip.files[n].dir)
        const dashFile = names.find(n => n.startsWith('00_统计看板'))
        ok('C2 看板为根级 00_ 文件', !!dashFile, names.slice(0, 6).join(', '))
        const gFiles = names.filter(n => /^G\d+\//.test(n))
        ok('C3 组目录文件存在（G01/…html）', gFiles.length >= 1, gFiles.slice(0, 4).join(', '))
        // 看板内离线链接 ↔ zip 实际文件逐一对应（共享 planArchiveNames 的核心断言）
        const zipLinks = [...html.matchAll(/href="(G\d+\/[^"]+\.html)"/g)].map(m => decodeURIComponent(m[1]))
        const miss = zipLinks.filter(l => !names.includes(l))
        ok('C4 看板离线链接与 zip 文件名一致', zipLinks.length > 0 && miss.length === 0, `缺失：${miss.join('、')}`)
        const readme = await zip.file('_README.txt')?.async('string')
        ok('C5 README 说明看板根级文件', readme?.includes('00_统计看板') === true)
      }
    }
  }
}

// ─── D. LLM 失败降级（假 DeepSeek Key → 规则结论 + 降级提示仍 done）───────────
console.log('── D. LLM 失败降级 ──')
if (doneJobs.length >= 2) {
  const picked = doneJobs.slice(0, 2)
  const entries = picked.map((j, i) => ({ jobId: j.id, group: i + 1, label: j.uniprotId || '靶点' }))
  const post = await fetch(`${base}/api/evaluate/ht-dashboard`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries, llm: { providerKey: 'deepseek', apiKey: 'sk-invalid-regress', model: 'deepseek-chat' } }),
    signal: AbortSignal.timeout(30_000),
  })
  const created = await post.json().catch(() => null)
  if (created?.dashboard?.id) {
    const fin = await pollDashboard(created.dashboard.id, 180_000)
    ok('D1 LLM 失败 → 看板仍 done（统计与规则结论不受影响）', fin.status === 'done', JSON.stringify(fin))
    const html = await getDashboardHtml(created.dashboard.id)
    if (html) {
      ok('D2 每靶点结论回退规则推断（标注「规则推断」）', /规则推断/.test(html))
      ok('D3 AI 报告降级提示（warn）', /AI 报告提示/.test(html) || /未生成/.test(html))
    }
  } else {
    ok('D1 LLM 失败 → 看板仍 done（统计与规则结论不受影响）', false, 'POST 失败')
  }
}

// ─── E. LIVE：EGFR 695-1022 — SIFTS 回填复滤 + 文献补全 ─────────────────────
if (process.env.LIVE === '1' && doneJobs.length >= 0) {
  console.log('── E. LIVE 完整作业：EGFR 695-1022（SIFTS 回填 + 文献补全）──')
  const createRes = await fetch(`${base}/api/evaluate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: 'uniprot', uniprot: 'P00533',
      options: { skipBlast: true, forceBlast: false, maxPdb: 150, reportMode: 'single', range: [695, 1022] },
    }),
    signal: AbortSignal.timeout(20_000),
  })
  const created = await createRes.json().catch(() => ({}))
  if (!created.jobId) {
    ok('E1 作业创建', false, JSON.stringify(created))
  } else {
    ok('E1 作业创建', true, created.jobId)
    let job = null
    const t0 = Date.now()
    while (Date.now() - t0 < 300_000) {
      await new Promise(r => setTimeout(r, 3000))
      const res = await fetch(`${base}/api/jobs/${created.jobId}`, { signal: AbortSignal.timeout(10_000) })
      if (res.ok) {
        job = await res.json()
        if (job.status === 'done' || job.status === 'error' || job.status === 'canceled') break
      }
    }
    const overlap = (iv, range) => iv[0] <= range[1] && iv[1] >= range[0]
    const parseChainRanges = (s) => {
      if (!s) return []
      const out = []
      for (const part of String(s).split(',')) {
        const m = part.match(/=(\d+)-(\d+)/)
        if (m) out.push([Number(m[1]), Number(m[2])])
      }
      return out
    }
    if (!job || job.status !== 'done') {
      ok('E2 作业完成', false, job ? `${job.status}: ${job.error ?? ''}` : '轮询超时/失败')
    } else {
      ok('E2 作业完成', true)
      const pdbs = job.pdbs ?? []
      const range = [695, 1022]
      const unknown = pdbs.filter(p => !p.chainRanges)
      const violators = pdbs.filter(p => {
        const iv = parseChainRanges(p.chainRanges)
        return iv.length > 0 && !iv.some(x => overlap(x, range))
      })
      ok('E3 SIFTS 回填后链范围全覆盖（未知 ≤ 2）', unknown.length <= 2, `未知 ${unknown.length}/${pdbs.length}：${unknown.slice(0, 3).map(p => p.pdbId).join(',')}`)
      ok('E4 全部结构与区间重叠（未知者例外）', violators.length === 0, `违规 ${violators.length}`)
      ok('E5 范围过滤生效（130 → ≤130，含 SIFTS 复滤）', pdbs.length <= 130 && pdbs.length >= 5, `${pdbs.length}`)
      const lits = job.literature ?? []
      const pmidsInPdbs = [...new Set(pdbs.map(p => String(p.pubmedId ?? '').trim()).filter(Boolean))]
      const pmidsInLits = new Set(lits.map(l => String(l.pmid)))
      const missingPapers = pmidsInPdbs.filter(x => !pmidsInLits.has(x))
      ok('E6 PDB 主引文全量并入文献列表（缺失 = 0）', missingPapers.length === 0, `缺 ${missingPapers.length}：${missingPapers.slice(0, 5).join(',')}`)
      ok('E7 文献列表规模（≥ 40 篇）', lits.length >= 40, `${lits.length} 篇`)
      const logText = JSON.stringify(job.logs ?? [])
      ok('E8 日志含 SIFTS 回填复滤记录（若发生）', !logText.includes('SIFTS 链范围回填') || /SIFTS 链范围回填 \d+ 个结构后复滤/.test(logText))
    }
  }
} else {
  console.log('── E. LIVE 完整作业（LIVE=1 才跑，本次跳过）──')
}

console.log(`\n${pass} 通过 · ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
