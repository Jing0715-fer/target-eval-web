#!/usr/bin/env node
/**
 * regress-construct-range.mjs — v2.27 截短构建感知回归。
 *
 * 用户场景（第三批自研清单第 78/82 行）：P0DTD1 聚蛋白的两个片段（nsp12 4393-5324 /
 * nsp2 181-818）此前被按 accession 全局去重合并为一，且无区间过滤 → 结构列表混入
 * 该 UniProt 名下全部 ~3400 个新冠结构。本回归锁定：
 *
 * A. 规则提取区间（quick=1，确定性）：
 *    A1 聚蛋白片段：同 accession 不同区间 → 两个独立靶点（不再被全局去重合并）
 *    A2 Tier 1 UniProt 列括号注释区间（4393-5324 / 181-818）
 *    A3 Tier 3 单靶点 + 构建列区间（STAT1 M1-R683）
 *    A4 Tier 2 复合物构建名配对（NTRC 83-548 + 2CP 两 isoform 70-269；GIPR 22-421
 *        不误配 GNAS/ADRB2；CD19 20-329 不误配 CD81）
 *    A5 边界守卫：isoform 后缀（P04637-2）/ 标签段（SLC10A1-3C）/ 克隆号（CD1-H5243）
 *        / Nav1.5 → 不产生假区间；同 acc 同区间仍去重、同 acc 不同区间保留
 *    A6 序列兜底组区间（行缺 UniProt + 构建区间 → seqTargets.range）
 *    A7 meta.rangeTargets 计数
 * B. LLM 失败回退路径区间保活（假 DeepSeek Key → 规则兜底仍带区间）
 * C. 在线事实（快）：UniProt P0DTD1 PDB 交叉引用 — ~3400 条、nsp12 链范围用聚蛋白
 *    编号（"A=4393-5324"）、nsp2 有结构 → 过滤坐标空间假设成立
 * D. 完整作业端到端（慢，LIVE=1 才跑）：P0DTD1 + range 4393-5324 → pdbs 全部与区间
 *    重叠（chainRanges 缺省保留）、summary.range 记录生效区间、覆盖率为区间口径
 *
 * 运行：node scripts/regress-construct-range.mjs（复用常驻 dev server :3000；
 * LIVE=1 额外跑 D 段完整作业，约 1-3 分钟）
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
const LOG = '/tmp/regress-construct-range-dev.log'
const base = `http://127.0.0.1:${PORT}`

let proc = null
const killServer = () => {
  if (!proc) return
  try { process.kill(-proc.pid, 'SIGTERM') } catch { /* already gone */ }
  try { proc.kill('SIGTERM') } catch { /* already gone */ }
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

const seq120 = 'M' + 'A'.repeat(119)

// 复刻第三批清单结构（表头 + 12 行代表性数据；序列列仅在序列兜底行使用）
const header = ['靶点编号', '靶点名称', '类型', 'UniProt ID', 'PDB ID', '构建 / 组分（复合物同行）', '表达载体', '备注 / 核对问题', '序列（含标签与构建）']
const fixtureRows = [
  header,
  ['1', 'RdRP / nsp12 (2019-nCoV)', '单蛋白', 'P0DTD1 (nsp12, 4393-5324)', '—', '8His-StrepII-TEV-Avi-RdRP (S1-Q932 end)', 'pFastBac', '—', ''],
  ['2', 'NSP2 (2019-nCoV)', '单蛋白', 'P0DTD1 (nsp2, 181-818)', '—', 'NSP2 (A181-G818)-Avi-His', 'pET28a', '—', ''],
  ['3', 'STAT1', '单蛋白', 'P42224', '—', '8His-TEV-STAT1 (M1-R683)', 'pET28a', '—', ''],
  ['4', 'NTRC + 2CP 复合物', '复合物', 'A0A1S4BZQ6 (NTRC, 烟草); A0A1S3ZLD2 / A0A1U7YLE7 (2CP, 烟草)', '—', 'His-TEV-NTRC-83-548\nHis-MBP-TEV-2CP-70-269', 'pET28a (两个组分)', '—', ''],
  ['5', 'GIPR 复合物', '复合物', 'P48546 (GIPR); P63092 (GNAS, mini-Gs); P07550 (ADRB2)', '—', 'GIPR(T345F)-LgBiT-OMBP-MBP (8YW4 Chain R) Mini-Gs (8YW4 Chain A, 工程化) GIPr04: β2AR-3C-GIPR(R22-R421,T345F)-3C-8His', '未标注', 'GIPR 含工程化突变', ''],
  ['6', 'CD19-CD81', '复合物', 'P15391 (CD19); P60033 (CD81)', '—', 'FLAG-3C-CD19(20-329)-(GGS)4-CD81(FL)', 'pcDNA3.1 (+)', '—', ''],
  ['7', 'ABCB11', '单蛋白', '—', '—', '8His-StrepII-TEV-(GG)-ABCB11 (S2-S1321 end)-Flag', 'pcDNA3.1', '—', `[8His-StrepII-TEV--ABCB11-Flag] ${seq120}`],
  ['8', 'NTCP + Fab', '复合物', 'Q14973', '—', 'SLC10A1-3C-EGFP-twin-strep (FL) 购自 ACROBiosystems CD1-H5243；Nav1.5 结构见 PPT', 'pcDNA3.4', '—', ''],
  ['9', 'p53 β', '单蛋白', 'P04637-2', '—', '6His-TEV-p53β (S2-S393 end)', 'pET28a', '—', ''],
  ['10', 'p53 β（重复行）', '单蛋白', 'P04637-2', '—', '6His-TEV-p53β (S2-S393 end)', 'pET28a', '—', ''],
  ['11', 'NEDD4L-a', '单蛋白', 'Q96PU5', '—', '6His-TEV-(GG)-NEDD4L (S2-E802 end)', 'pET28a', '—', ''],
  ['12', 'NEDD4L-b', '单蛋白', 'Q96PU5', '—', '6His-TEV-(GG)-NEDD4L (A2-D975 end)', 'pET28a', '—', ''],
]

// ─── A. 规则提取区间（quick=1 确定性路径）──────────────────────────────────
console.log('── A. 规则提取区间（quick=1）──')
const r = await postExcel(buildXlsx(fixtureRows), 'batch3-fixture.xlsx', { quick: '1' })
const groups = r.data.groups ?? []
const groupRanges = r.data.groupRanges ?? []
const seqGroups = r.data.seqGroups ?? []

ok('A1 聚蛋白片段独立成组（不再被 accession 全局去重合并）',
  groups.filter(g => g.length === 1 && g[0] === 'P0DTD1').length === 2,
  JSON.stringify(groups))

ok('A2 Tier 1 UniProt 列注释区间（nsp12 4393-5324 / nsp2 181-818）',
  groups[0]?.[0] === 'P0DTD1' && JSON.stringify(groupRanges[0]) === '[[4393,5324]]'
  && groups[1]?.[0] === 'P0DTD1' && JSON.stringify(groupRanges[1]) === '[[181,818]]',
  `g0=${JSON.stringify(groups[0])}/${JSON.stringify(groupRanges[0])} g1=${JSON.stringify(groups[1])}/${JSON.stringify(groupRanges[1])}`)

ok('A3 Tier 3 单靶点构建列区间（STAT1 M1-R683 → 1-683）',
  groups[2]?.[0] === 'P42224' && JSON.stringify(groupRanges[2]) === '[[1,683]]',
  JSON.stringify([groups[2], groupRanges[2]]))

ok('A4a Tier 2 复合物构建名配对（NTRC 83-548；2CP 两 isoform 均 70-269）',
  JSON.stringify(groups[3]) === JSON.stringify(['A0A1S4BZQ6', 'A0A1S3ZLD2', 'A0A1U7YLE7'])
  && JSON.stringify(groupRanges[3]) === '[[83,548],[70,269],[70,269]]',
  JSON.stringify([groups[3], groupRanges[3]]))

ok('A4b 区间只配到对应组分（GIPR 22-421；GNAS/ADRB2 不误配）',
  JSON.stringify(groupRanges[4]) === '[[22,421],null,null]',
  JSON.stringify(groupRanges[4]))

ok('A4c 区间只配到对应组分（CD19 20-329；CD81 无区间不过滤）',
  JSON.stringify(groupRanges[5]) === '[[20,329],null]',
  JSON.stringify(groupRanges[5]))

ok('A5a 边界守卫：isoform/标签段/克隆号不产生假区间（Q14973 行全无区间）',
  groups[6]?.[0] === 'Q14973' && JSON.stringify(groupRanges[6]) === '[null]',
  JSON.stringify([groups[6], groupRanges[6]]))

ok('A5b isoform 后缀不误配 + 同 acc 同区间跨行去重（P04637-2 仅一次，区间 2-393）',
  groups.filter(g => g[0] === 'P04637-2').length === 1
  && JSON.stringify(groupRanges[groups.findIndex(g => g[0] === 'P04637-2')]) === '[[2,393]]',
  JSON.stringify(groups.filter(g => g[0] === 'P04637-2')))

ok('A5c 同 acc 不同区间 → 各自独立靶点（NEDD4L 2-802 / 2-975）',
  groups.filter(g => g[0] === 'Q96PU5').length === 2
  && JSON.stringify(groupRanges[groups.length - 2]) === '[[2,802]]'
  && JSON.stringify(groupRanges[groups.length - 1]) === '[[2,975]]',
  JSON.stringify(groups.slice(-2)))

ok('A6 序列兜底组区间（ABCB11 行缺 UniProt → seqTarget.range = 2-1321）',
  seqGroups.length === 1 && seqGroups[0].length === 1
  && JSON.stringify(seqGroups[0][0].range) === '[2,1321]',
  JSON.stringify(seqGroups))

const rangeTargetCount = (groupRanges ?? []).reduce((n, g) => n + g.filter(Boolean).length, 0)
// 行1/2/3 各 1 + NTRC 3 + GIPR 1 + CD19 1 + p53β 1 + NEDD4L×2 = 11
ok('A7 meta.rangeTargets 计数（UniProt 组 11 个带区间靶点）',
  (r.data.meta?.rangeTargets ?? 0) === 11 && rangeTargetCount === 11,
  `meta=${r.data.meta?.rangeTargets} local=${rangeTargetCount}`)

ok('A8 groupRanges 与 groups 逐组对齐（长度一致）',
  groups.length === groupRanges.length,
  `${groups.length} vs ${groupRanges.length}`)

// ─── B. LLM 失败回退路径区间保活（假 Key → llmChat 失败 → 规则兜底）────────
console.log('── B. LLM 失败回退区间保活 ──')
{
  const r2 = await postExcel(buildXlsx(fixtureRows), 'batch3-fixture.xlsx', {
    llm: JSON.stringify({ providerKey: 'deepseek', apiKey: 'sk-invalid-regress', model: 'deepseek-chat' }),
  })
  const g2 = r2.data.groups ?? []
  const gr2 = r2.data.groupRanges ?? []
  const p0again = g2.filter(g => g.length === 1 && g[0] === 'P0DTD1')
  ok('B1 LLM 失败 → 规则兜底仍带区间（P0DTD1 两片段 + 区间）',
    r2.data.source === 'regex' && p0again.length === 2
    && JSON.stringify(gr2[0]) === '[[4393,5324]]' && JSON.stringify(gr2[1]) === '[[181,818]]',
    `source=${r2.data.source} groups=${JSON.stringify(g2.slice(0, 2))}`)
}

// ─── C. 在线事实：UniProt P0DTD1 交叉引用（过滤坐标空间假设）────────────────
console.log('── C. 在线事实（UniProt REST）──')
{
  let refs = null
  try {
    const res = await fetch('https://rest.uniprot.org/uniprotkb/P0DTD1.json?fields=xref_pdb', { signal: AbortSignal.timeout(25_000) })
    if (res.ok) {
      const d = await res.json()
      refs = (d.uniProtKBCrossReferences ?? []).filter(x => x.database === 'PDB')
    }
  } catch { /* 网络不可达 — 下面按缺省失败 */ }
  ok('C1 P0DTD1 名下 PDB 交叉引用 ≥ 3000（未过滤即「全新冠结构大杂烩」）',
    Array.isArray(refs) && refs.length >= 3000, refs ? `${refs.length}` : 'fetch failed')
  const chainStr = (ref) => (ref.properties ?? []).filter(p => p.key === 'Chains').map(p => p.value).join(';')
  const nsp12Count = (refs ?? []).filter(ref => /4393-5324/.test(chainStr(ref))).length
  const nsp2Count = (refs ?? []).filter(ref => /181-818/.test(chainStr(ref))).length
  ok('C2 nsp12 链范围用聚蛋白编号（Chains 含 "4393-5324" 的条目 ≥ 60）', nsp12Count >= 60, `${nsp12Count}`)
  ok('C3 nsp2 有结构（Chains 含 "181-818" 的条目 ≥ 1）', nsp2Count >= 1, `${nsp2Count}`)
  const hasCombined = (refs ?? []).some(ref => /4393-5324/.test(chainStr(ref)) && /3943-4140/.test(chainStr(ref)))
  ok('C4 同一结构可含多个片段链（如 nsp12+nsp13 共结晶 — 重叠语义可命中）', hasCombined)
}

// ─── D. 完整作业端到端（慢 — LIVE=1 才跑）──────────────────────────────────
if (process.env.LIVE === '1') {
  console.log('── D. 完整作业端到端（LIVE=1；P0DTD1 + range 4393-5324）──')
  const createRes = await fetch(`${base}/api/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: 'uniprot',
      uniprot: 'P0DTD1',
      options: { skipBlast: true, forceBlast: false, maxPdb: 300, reportMode: 'single', range: [4393, 5324] },
    }),
    signal: AbortSignal.timeout(20_000),
  })
  const created = await createRes.json().catch(() => ({}))
  if (!created.jobId) {
    ok('D1 作业创建', false, JSON.stringify(created))
  } else {
    ok('D1 作业创建', true, created.jobId)
    let job = null
    const t0 = Date.now()
    while (Date.now() - t0 < 300_000) {
      await new Promise(rr => setTimeout(rr, 3000))
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
      ok('D2 作业完成', false, job ? `${job.status}: ${job.error ?? ''}` : '轮询超时/失败')
    } else {
      ok('D2 作业完成', true)
      const pdbs = job.pdbs ?? []
      const range = [4393, 5324]
      const violators = pdbs.filter(p => {
        const iv = parseChainRanges(p.chainRanges)
        return iv.length > 0 && !iv.some(x => overlap(x, range))
      })
      ok('D3 直接结构全部与区间重叠（chainRanges 缺省保留）', violators.length === 0,
        `${pdbs.length} 个结构，违规 ${violators.length}：${violators.slice(0, 3).map(p => `${p.pdbId}:${p.chainRanges}`).join(' ')}`)
      ok('D4 有区间过滤生效证据（nsp12 相关结构 ≥ 5）', pdbs.length >= 5, `${pdbs.length}`)
      ok('D5 summary.range 记录生效区间', JSON.stringify(job.summary?.range) === '[4393,5324]',
        JSON.stringify(job.summary?.range))
      ok('D6 覆盖率为区间口径（nsp12 片段覆盖 > 0%）', (job.summary?.coverage ?? 0) > 0, `${job.summary?.coverage}`)
      const logText = JSON.stringify(job.logs ?? [])
      ok('D7 作业日志含范围过滤记录', logText.includes('4393-5324'), logText.slice(0, 200))
    }
  }
} else {
  console.log('── D. 完整作业端到端（LIVE=1 才跑，本次跳过）──')
}

console.log(`\n${pass} 通过 · ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
