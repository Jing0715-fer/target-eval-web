#!/usr/bin/env node
/**
 * regress-v29.mjs — v2.29 回归（结构域名提示 → UniProt domain 匹配 + 范围分流显示）。
 *
 * 用户场景：
 *  A. 评估表不写氨基酸范围而写结构域名（「P51685 (CCR8 胞外域)」「EGFR kinase domain」
 *     「跨膜区」「ECD」）→ ht-extract 提取 domainHint（与 groupRanges 平行结构），
 *     作业携带 options.rangeHint，管线内与 UniProt domain 划分匹配推导评估区间；
 *     优先展示该区段结构，无重叠结构折叠保留（灰色行）。
 *  B. 截短构建区间不再丢弃无重叠结构 — 重叠者优先展示（主列表），无重叠折叠保留
 *     （rangeOutsidePdbs / rangeOutsideBlastHits，报告 HTML 灰色行 + 范围外 chip）。
 *
 * 段落：
 *  A. 规则提取域名提示（quick=1 确定性）：括号注释域名 / 构建列中英文域名 /
 *     数值区间优先（有区间不扫域名）/ 复合同行计数配对 / meta.domainHintTargets
 *  B. 在线事实（快）：UniProt P00533 features 含 Extracellular 1-621 与
 *     Protein kinase 712-979（域名匹配的坐标空间前提）+ Topological domain 类型在册
 *  C. 完整作业端到端（慢，LIVE=1）：
 *     C1 P00533 + rangeHint「胞外域」→ summary.range=[1,621]、rangeSource=结构域匹配、
 *        主列表全重叠、rangeOutsidePdbs>0（激酶域结构折叠）、报告 HTML 含范围外折叠区
 *     C2 P00533 + 手动 range [712,979]（激酶域）→ 同口径分流 + 报告 HTML 横幅/折叠区
 *
 * 运行：node scripts/regress-v29.mjs（复用常驻 dev server :3000；
 * LIVE=1 额外跑 C 段两个完整作业，约 2-6 分钟）
 */
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const XLSX = require_('xlsx')

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

// ─── dev server：优先复用常驻 :3000（Next 16 同目录锁禁止第二实例）；不可用才自启 ────
const PORT = Number(process.env.HT_REGRESS_PORT ?? 3000)
const ROOT = new URL('..', import.meta.url).pathname
const LOG = '/tmp/regress-v29-dev.log'
const base = `http://127.0.0.1:${PORT}`

let proc = null
const killServer = () => {
  if (!proc) return
  try { process.kill(-proc.pid, 'SIGTERM') } catch { /* already gone */ }
  try { proc.kill('SIGTERM') } catch { /* best-effort */ }
  try { spawn('pkill', ['-f', `next dev -p ${PORT}`]) } catch { /* best-effort */ }
}
process.on('exit', killServer)

const probe = async () => {
  try {
    const r = await fetch(`${base}/api/llm/config`, { signal: AbortSignal.timeout(3000) })
    return r.ok
  } catch { return false }
}

let ready = false
if (await probe()) {
  ready = true
  console.log(`  复用常驻 dev server（:${PORT}）`)
} else {
  proc = spawn('npx', ['next', 'dev', '-p', String(PORT)], {
    cwd: ROOT,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  const logStream = fs.createWriteStream(LOG, { flags: 'w' })
  proc.stdout.pipe(logStream)
  proc.stderr.pipe(logStream)
  for (let i = 0; i < 150; i++) {
    if (await probe()) { ready = true; break }
    await new Promise(r => setTimeout(r, 1000))
  }
  if (!ready) {
    console.log(`✗ dev server 未就绪（150s）— 日志：${LOG}`)
    killServer()
    process.exit(1)
  }
  console.log(`  dev server 就绪（:${PORT}）`)
}

// ─── 工具 ──────────────────────────────────────────────────────────────────
const buildXlsx = (rows, name = '靶点清单') => {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name)
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
}

const postExcel = async (buf, fileName, extra = {}) => {
  const fd = new FormData()
  if (buf != null) fd.append('file', new File([buf], fileName, { type: 'application/octet-stream' }))
  for (const [k, v] of Object.entries(extra)) fd.append(k, v)
  const res = await fetch(`${base}/api/evaluate/ht-extract`, {
    method: 'POST',
    body: fd,
    signal: AbortSignal.timeout(90_000),
  })
  const ct = res.headers.get('content-type') || ''
  if (ct.includes('ndjson')) {
    const text = await res.text()
    let done = null
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const ev = JSON.parse(line)
        if (ev.type === 'done') done = ev
      } catch { /* 心跳 pad 噪音行丢弃 */ }
    }
    return { status: res.status, data: done ?? {} }
  }
  return { status: res.status, data: await res.json().catch(() => ({})) }
}

// ─── A. 规则提取域名提示（quick=1 确定性路径）──────────────────────────────
console.log('── A. 规则提取域名提示（quick=1）──')
const header = ['靶点编号', '靶点名称', '类型', 'UniProt ID', '构建 / 组分（复合物同行）', '备注', '序列（含标签与构建）']
const fixtureRows = [
  header,
  // A1：UniProt 列括号注释写域名（Tier 1 — 注释域名直配该靶点）
  ['1', 'CCR8 受体（胞外域）', '单蛋白', 'P51685 (CCR8 胞外域)', '—', '—', ''],
  // A2：构建列英文域名（单靶点行 → 行内域名配对）
  ['2', 'EGFR', '单蛋白', 'P00533', 'EGFR kinase domain 构建', '—', ''],
  // A3：数值区间优先（有区间不扫域名 — 域名匹配仅垫底）
  ['3', 'RdRP / nsp12', '单蛋白', 'P0DTD1 (nsp12, 4393-5324)', '8His-TEV-RdRP', '—', ''],
  // A4：复合同行两靶点 + 两域名 → 计数顺序配对（P29374/P62873 均首现 — 不受跨行去重影响）
  ['5', '受体-信号复合物', '复合物', 'P29374; P62873', '胞外域 / 胞内域', '—', ''],
  // A5：ECD 缩写独立词（名称列不再含 ECD token — 干扰剔除）
  ['6', '某受体胞外段', '单蛋白', 'Q08462', 'ectodomain-Fc 融合', '—', ''],
  // A6：跨膜区提示（英文 TM domain 前缀词）
  ['7', '某通道', '单蛋白', 'Q08463', 'TM domain 构建边界待定', '—', ''],
]
const r = await postExcel(buildXlsx(fixtureRows), 'v29-domain-hints.xlsx', { quick: '1' })
const groups = r.data.groups ?? []
const groupRanges = r.data.groupRanges ?? []
const groupDomainHints = r.data.groupDomainHints ?? []

const idxOf = (acc) => groups.findIndex(g => g.includes(acc))

ok('A1 提取成功（6 组）', groups.length === 6, JSON.stringify(groups))
ok('A2 括号注释域名（P51685 → 胞外）',
  groups[0]?.[0] === 'P51685' && groupDomainHints[0]?.[0] === '胞外',
  JSON.stringify([groups[0], groupDomainHints[0]]))
ok('A3 构建列英文域名（P00533 → EGFR kinase 短语）',
  groups[1]?.[0] === 'P00533' && /kinase/i.test(String(groupDomainHints[1]?.[0] ?? '')),
  JSON.stringify(groupDomainHints[1]))
ok('A4 数值区间优先（P0DTD1 带区间 → 不扫域名）',
  groups[2]?.[0] === 'P0DTD1' && JSON.stringify(groupRanges[2]) === '[[4393,5324]]' && groupDomainHints[2]?.[0] == null,
  JSON.stringify([groupRanges[2], groupDomainHints[2]]))
ok('A5 复合同行计数配对（P29374 → 胞外；P62873 → 胞内）',
  groups[3]?.length === 2 && groupDomainHints[3]?.[0] === '胞外' && groupDomainHints[3]?.[1] === '胞内',
  JSON.stringify([groups[3], groupDomainHints[3]]))
ok('A6 ECD 独立词（Q08462 → ectodomain）',
  groups[4]?.[0] === 'Q08462' && /ectodomain/i.test(String(groupDomainHints[4]?.[0] ?? '')),
  JSON.stringify(groupDomainHints[4]))
ok('A7 TM domain 前缀词（Q08463 → tm）',
  groups[5]?.[0] === 'Q08463' && /^tm$/i.test(String(groupDomainHints[5]?.[0] ?? '')),
  JSON.stringify(groupDomainHints[5]))

const hintCount = (groupDomainHints ?? []).reduce((n, gh) => n + gh.filter(Boolean).length, 0)
ok('A8 meta.domainHintTargets 计数（6 个带域名提示靶点）',
  (r.data.meta?.domainHintTargets ?? 0) === 6 && hintCount === 6,
  `meta=${r.data.meta?.domainHintTargets} local=${hintCount}`)
ok('A9 groupDomainHints 与 groups 逐组对齐（长度一致）',
  groups.length === groupDomainHints.length,
  `${groups.length} vs ${groupDomainHints.length}`)

// ─── B. 在线事实：UniProt P00533 features（域名匹配坐标空间前提）────────────
console.log('── B. 在线事实（UniProt REST）──')
{
  let feats = null
  try {
    const res = await fetch('https://rest.uniprot.org/uniprotkb/P00533.json?fields=ft_domain,ft_topo_dom,ft_transmem', { signal: AbortSignal.timeout(25_000) })
    if (res.ok) feats = (await res.json()).features ?? []
  } catch { /* 网络不可达 — 下面按缺省失败 */ }
  const topo = (feats ?? []).filter(f => f.type === 'Topological domain' && /extracellular/i.test(f.description ?? ''))
  const kin = (feats ?? []).filter(f => f.type === 'Domain' && /kinase/i.test(f.description ?? ''))
  const getRange = (f) => [f.location?.start?.value ?? -1, f.location?.end?.value ?? -1]
  const ecd = topo.length ? topo.reduce((a, b) => ((b.location?.end?.value ?? 0) - (b.location?.start?.value ?? 0) > (a.location?.end?.value ?? 0) - (a.location?.start?.value ?? 0) ? b : a)) : null
  ok('B1 Topological domain「Extracellular」在册（REST 返回该类型）', topo.length > 0, `${topo.length} 段`)
  ok('B2 最长胞外段 = 25-645（EGFR Extracellular — 域名匹配应得此区间）',
    ecd != null && JSON.stringify(getRange(ecd)) === '[25,645]',
    ecd ? JSON.stringify(getRange(ecd)) : 'null')
  ok('B3 Domain「Protein kinase」712-979 在册', kin.length > 0 && JSON.stringify(getRange(kin[0])) === '[712,979]',
    kin.length ? JSON.stringify(getRange(kin[0])) : 'none')
}

// ─── C. 完整作业端到端（慢 — LIVE=1 才跑）──────────────────────────────────
if (process.env.LIVE === '1') {
  console.log('── C. 完整作业端到端（LIVE=1）──')

  const runJob = async (label, body) => {
    const createRes = await fetch(`${base}/api/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    })
    const created = await createRes.json().catch(() => ({}))
    if (!created.jobId) {
      ok(`${label} 作业创建`, false, JSON.stringify(created))
      return null
    }
    ok(`${label} 作业创建`, true, created.jobId)
    let job = null
    const t0 = Date.now()
    while (Date.now() - t0 < 240_000) {
      await new Promise(rr => setTimeout(rr, 3000))
      const res = await fetch(`${base}/api/jobs/${created.jobId}`, { signal: AbortSignal.timeout(10_000) })
      if (res.ok) {
        job = await res.json()
        if (job.status === 'done' || job.status === 'error' || job.status === 'canceled') break
      }
    }
    if (!job || job.status !== 'done') {
      ok(`${label} 作业完成`, false, job ? `${job.status}: ${job.error ?? ''}` : '轮询超时/失败')
      return null
    }
    ok(`${label} 作业完成`, true)
    return job
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

  const fetchReportHtml = async (jobId) => {
    try {
      const res = await fetch(`${base}/api/jobs/${jobId}/report`, { signal: AbortSignal.timeout(20_000) })
      if (!res.ok) return ''
      return await res.text()
    } catch { return '' }
  }

  // C1：域名提示端到端（P00533 + rangeHint 胞外域 → 区间 25-645 — UniProt Extracellular 拓扑域）
  {
    const job = await runJob('C1(P00533 rangeHint=胞外域)', {
      mode: 'uniprot',
      uniprot: 'P00533',
      options: { skipBlast: true, forceBlast: false, maxPdb: 300, reportMode: 'single', rangeHint: '胞外域' },
    })
    if (job) {
      const pdbs = job.pdbs ?? []
      const range = [25, 645]
      ok('C1-a summary.range = [25,645]（域名匹配生效）', JSON.stringify(job.summary?.range) === '[25,645]',
        JSON.stringify(job.summary?.range))
      ok('C1-b summary.rangeSource = 结构域匹配（UniProt 注释）',
        job.summary?.rangeSource === '结构域匹配（UniProt 注释）', String(job.summary?.rangeSource))
      const violators = pdbs.filter(p => {
        const iv = parseChainRanges(p.chainRanges)
        return iv.length > 0 && !iv.some(x => overlap(x, range))
      })
      ok('C1-c 主列表全部与区间重叠（重叠优先）', violators.length === 0,
        `${pdbs.length} 个结构，违规 ${violators.length}`)
      ok('C1-d 无重叠结构折叠保留（rangeOutsidePdbs > 0 — 激酶域结构在折叠区）',
        (job.summary?.rangeOutsidePdbs?.length ?? 0) > 0, `${job.summary?.rangeOutsidePdbs?.length ?? 0} 条`)
      const outCheck = (job.summary?.rangeOutsidePdbs ?? []).every(p => {
        const iv = parseChainRanges(p.chainRanges)
        return iv.length === 0 || !iv.some(x => overlap(x, range))
      })
      ok('C1-e 折叠区条目确与区间无重叠（完整性校验 — 不应有重叠条目混入）', outCheck, '')
      const logs = JSON.stringify(job.logs ?? [])
      ok('C1-f 日志含域名匹配记录（结构域提示 → UniProt 匹配）',
        logs.includes('结构域提示') && logs.includes('25-645'), logs.slice(0, 120))
      const html = await fetchReportHtml(job.id)
      ok('C1-g 报告 HTML 含「范围外结构」折叠区 + 范围外 chip（按 DOM 结构匹配 — CSS 注释不算）',
        html.includes('<details class="fold fold-outside"') && html.includes('rng-outside-chip">范围外</span>'), `${html.length} chars`)
      ok('C1-h 报告 HTML 含区间横幅（评估区间 25-645 · 结构域匹配）',
        html.includes('评估区间 25-645') && html.includes('domain 匹配区间'), '')
    }
  }

  // C2：手动区间分流显示（P00533 + range [712,979] 激酶域 → 胞外结构折叠）
  {
    const job = await runJob('C2(P00533 range=712-979)', {
      mode: 'uniprot',
      uniprot: 'P00533',
      options: { skipBlast: true, forceBlast: false, maxPdb: 300, reportMode: 'single', range: [712, 979] },
    })
    if (job) {
      const pdbs = job.pdbs ?? []
      const range = [712, 979]
      ok('C2-a summary.range = [712,979]（手动指定优先）', JSON.stringify(job.summary?.range) === '[712,979]',
        JSON.stringify(job.summary?.range))
      ok('C2-b rangeSource = 手动指定', job.summary?.rangeSource === '手动指定', String(job.summary?.rangeSource))
      const violators = pdbs.filter(p => {
        const iv = parseChainRanges(p.chainRanges)
        return iv.length > 0 && !iv.some(x => overlap(x, range))
      })
      ok('C2-c 主列表全部与区间重叠', violators.length === 0, `${pdbs.length} 个结构，违规 ${violators.length}`)
      ok('C2-d 无重叠结构折叠保留（ECD 结构在折叠区）',
        (job.summary?.rangeOutsidePdbs?.length ?? 0) > 0, `${job.summary?.rangeOutsidePdbs?.length ?? 0} 条`)
      const html = await fetchReportHtml(job.id)
      ok('C2-e 报告 HTML 含范围外折叠区（灰色行样式）',
        html.includes('范围外结构') && html.includes('tr-outside'), '')
    }
  }
} else {
  console.log('── C. 完整作业端到端（LIVE=1 才跑，本次跳过）──')
}

console.log(`\n${pass} 通过 · ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
