/**
 * v2.84 验证脚本（scripts/ 目录 — 不进 lint/tsc 基线）：
 *
 * 用户实测两大回归（117 靶点导入 → 汇总报告）：
 *  A. 「和之前相比多了很多 UniProt ID 和评分也没有识别出来的条目，上传的报告
 *     都是一样的」— v2.83 enrichImportedReports 组装误按 rep 对象引用查 Map，
 *     同一合并报告文件的次链（链2/链3）全部静默丢失 stats/sourceSha/reportId
 *     （24/117 退化为 bare 降级行）。验证：多靶点各自匹配不同 rep 对象（同源
 *     文件）→ 全部拿到 stats + sourceSha（按 sourceKey 查找修复）。
 *  B. 「留存校验暂不可用 — 沿用既有服务端留存」后 117/117 原文未内嵌 —
 *     ensureImportedRetention 把「端点应答成功但服务端零留存」（实例回收常态）
 *     误判为「端点不可达」提前返回，跳过自愈重传。验证（真实 dev server）：
 *     服务端留存为空时 GET ?shas= 正常应答 retained={} → 走重传路径而非短路；
 *     重传后 GET 再校验全部 retained；二次生成（幂等去重）拿同一 id 零重传。
 *
 * 运行：bun scripts/test-v284-enrich-retention.ts（需 dev server 在 3000 端口）
 */

// 相对 URL → 绝对（客户端模块 fetch('/api/...') 在 Node 无 base — 指向 dev server）
const realFetch = globalThis.fetch
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' && input.startsWith('/')
    ? `http://localhost:3000${input}`
    : input
  return realFetch(url as RequestInfo, init)
}) as typeof fetch

import { enrichImportedReports, ensureImportedRetention, type HtArchiveReport, type ImportEnrichItem } from '../src/components/eval/ht-archive-import'
import { verifyImportedSources } from '../src/components/eval/api'

// ── 合成合并报告（一组两链：链1 已识别 UniProt · 链2 序列靶点）──
function section(opts: { title: string; header: string; seq: string; overall: number; uniprot?: string }) {
  const len = opts.seq.length
  return `
  <h1 class="rpt-title">${opts.title}</h1>
  <div class="meta-grid">
    <div><b>蛋白名称</b> Test Protein ${opts.header}</div>
    <div><b>物种</b> Test organism</div>
    <div><b>序列长度</b> ${len} aa</div>
    <div><b>结构证据</b> 直接结构 2 · 同源 5 个 · 文献 3 篇</div>
  </div>
  <div class="glance">
    <div class="glance-score" style="color:#059669">${opts.overall}<span>/10</span></div>
    <div class="glance-tile"><div class="gt-label">已有结构</div><div class="gt-value">2 个</div><div class="gt-sub">X-ray 1 · Cryo-EM 1 · NMR 0 · 最佳 2.80Å</div></div>
    <div class="glance-tile"><div class="gt-label">结构覆盖率</div><div class="gt-value">90%</div><div class="gt-sub">已有结构覆盖完整</div></div>
  </div>
  <div class="score-row "><div class="score-label">X-ray 结晶</div><div class="score-track"></div><div class="score-num">${Math.max(1, opts.overall - 2)}<span class="score-max">/10</span></div></div>
  <div class="score-row "><div class="score-label">Cryo-EM 冷冻电镜</div><div class="score-track"></div><div class="score-num">${opts.overall}<span class="score-max">/10</span></div></div>
  <div class="score-row "><div class="score-label">NMR 溶液结构</div><div class="score-track"></div><div class="score-num">3<span class="score-max">/10</span></div></div>
  <div class="score-row "><div class="score-label">综合评估</div><div class="score-track"></div><div class="score-num">${opts.overall}<span class="score-max">/10</span></div></div>`
}

const CHAIN1_SEQ = 'MKTAYIAKQRQISFVKSHFSRQLEERLIENLNSTKDLLKKKVTKA'.repeat(10) // 470 aa
const CHAIN2_SEQ = 'GIVEQCCTSICSLYQLENYCNFVNQHLCGSHLVEALYLVCGERGFFYTPKT'.repeat(5) // 245 aa

async function sha16(s: string): Promise<string> {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(s).digest('hex').slice(0, 16)
}
async function sha32(s: string): Promise<string> {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(s).digest('hex').slice(0, 32)
}

const metaEntries = [
  { uniprot: 'P99999', range: [1, 470] as [number, number], seqLength: 470, seqSha: await sha16(CHAIN1_SEQ), header: 'complexA·链1', label: 'complexA·链1 · 470aa' },
  { seqLength: 245, seqSha: await sha16(CHAIN2_SEQ), header: 'complexA·链2', label: 'complexA·链2 · 245aa' },
]
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
const mergedHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>合并报告 · complexA（P99999 · 残基 1-470） + complexA·链2</title>
<meta name="targeteval:targets" content="${esc(JSON.stringify(metaEntries))}">
</head><body>
${section({ title: 'Cytochrome c（P99999 · 残基 1-470）', header: '链1', seq: CHAIN1_SEQ, overall: 7, uniprot: 'P99999' })}
${section({ title: 'complexA·链2（序列靶点 · 残基 1-245）', header: '链2', seq: CHAIN2_SEQ, overall: 5 })}
</body></html>`

// 模拟 parseHtImportFiles 的 readSource/sourceKey（单文件 → f:{srcIdx}）
const parsed = {
  reports: [] as HtArchiveReport[],
  readSource: async (rep: HtArchiveReport) => (rep.path.split('::')[0] === 'G05_test.html' ? mergedHtml : null),
  sourceKey: (rep: HtArchiveReport) => `f:${rep.path.split('::')[0]}`,
}

// 两个靶点匹配到**不同的**报告条目对象（同一源文件 — 复现用户场景：
// 链1 走 h1 条目（UniProt 通道）、链2 走 meta 条目（SHA 通道））
const repForChain1: HtArchiveReport = { kind: 'job', path: 'G05_test.html::Cytochrome c', stem: 'Cytochrome c', uniprot: 'P99999', range: [1, 470] }
const repForChain2: HtArchiveReport = { kind: 'job', path: 'G05_test.html::complexA·链2 · 245aa', stem: 'complexA·链2 · 245aa', seqSha: await sha16(CHAIN2_SEQ), seqLength: 245 }

const items: ImportEnrichItem[] = [
  { acc: undefined, range: [1, 470], length: 470, seqSha: await sha16(CHAIN1_SEQ), label: 'complexA·链1 · 470aa', rep: repForChain1 },
  { acc: undefined, range: undefined, length: 245, seqSha: await sha16(CHAIN2_SEQ), label: 'complexA·链2 · 245aa', rep: repForChain2 },
]

async function main() {
  let pass = 0, fail = 0
  const t = (name: string, ok: boolean, detail?: string) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
    if (ok) pass++; else fail++
  }

  // ── A. enrich 组装修复（v2.83 bug：次链 rep 对象不同 → entryOfRep.get 落空）──
  console.log('── A. enrichImportedReports 组装（同源文件多靶点 · 不同 rep 对象）──')
  const progresses: string[] = []
  const enriched = await enrichImportedReports(items, parsed, { onProgress: m => progresses.push(m) })
  t('链1（首个靶点）拿到 stats', enriched[0]?.stats != null && enriched[0]!.stats!.overall === 7,
    `overall=${enriched[0]?.stats?.overall ?? '无'}`)
  t('链2（次链 · v2.83 丢失对象）拿到 stats', enriched[1]?.stats != null && enriched[1]!.stats!.overall === 5,
    `overall=${enriched[1]?.stats?.overall ?? '无'}`)
  t('链2 stats 携带 UniProt 消歧数据齐全', enriched[1]?.stats != null && (enriched[1]!.stats!.cryoem ?? -1) === 5,
    `cryoem=${enriched[1]?.stats?.cryoem ?? '无'}`)
  t('链1 拿到 sourceSha（本地留存键）', typeof enriched[0]?.sourceSha === 'string' && enriched[0]!.sourceSha!.length === 32,
    `sha=${enriched[0]?.sourceSha?.slice(0, 12) ?? '无'}…`)
  t('链2 拿到 sourceSha（v2.83 一并丢失 → 自愈死链）', typeof enriched[1]?.sourceSha === 'string' && enriched[1]!.sourceSha === enriched[0]?.sourceSha,
    `sha=${enriched[1]?.sourceSha?.slice(0, 12) ?? '无'}…`)

  // ── B. ensureImportedRetention 修复（真实 dev server）──
  console.log('\n── B. ensureImportedRetention（真实 dev server · 服务端零留存场景）──')
  // 先清掉 A 阶段 enrich 上传的留存（制造「实例回收/DB 重置后零留存」的真实场景）
  const shaA = await sha32(mergedHtml)
  const { db } = await import('../src/lib/db')
  await db.importedReport.deleteMany({ where: { contentSha: shaA } })
  // 服务端当前零留存 — GET ?shas= 应正常应答 retained={}
  const pre = await verifyImportedSources([shaA])
  t('服务端留存为空时端点正常应答（retained 空 ≠ 端点不可达）', pre != null && Object.keys(pre.retained).length === 0,
    pre ? `retained=${Object.keys(pre.retained).length} missing=${pre.missing.length}` : '端点不可达（dev server 未启动？）')

  if (pre != null) {
    // ensureImportedRetention：retention 为空 + 本地缓存有源文件（enrich 已 saveImportedSource）
    // → 旧版在这里误判「端点不可达」提前返回（0 重传）；v2.84 应走重传路径
    const healProgresses: string[] = []
    const heal = await ensureImportedRetention(
      items.map(() => ({ sha: shaA })),
      { onProgress: m => healProgresses.push(m) },
    )
    t('零留存时不再短路（旧版返回 0 重传 + 0 采纳）', heal.reuploaded + heal.adopted > 0 || heal.fixed.size > 0,
      `reuploaded=${heal.reuploaded} adopted=${heal.adopted} fixed=${heal.fixed.size} stillMissing=${heal.stillMissing}`)
    t('重传/采纳拿到 reportId', typeof heal.fixed.get(shaA) === 'string', `id=${heal.fixed.get(shaA)?.slice(0, 12) ?? '无'}…`)
    t('进度消息不再误报「沿用既有服务端留存」', !healProgresses.some(m => m.includes('沿用既有服务端留存')),
      `msgs=[${healProgresses.map(m => m.slice(0, 30)).join(' | ')}]`)

    // 重传后服务端应留存（生成侧 loadImportedReportHtml 可读 → 原文内嵌）
    const post = await verifyImportedSources([shaA])
    t('重传后服务端留存可校验（弹出页原文可内嵌）', post != null && post.retained[shaA] != null,
      `retained id=${post?.retained[shaA]?.slice(0, 12) ?? '无'}…`)

    // 幂等去重：同内容再上传 → 同 id 不重复落盘
    const heal2 = await ensureImportedRetention(
      items.map(() => ({ sha: shaA, reportId: heal.fixed.get(shaA) })),
      { onProgress: () => undefined },
    )
    t('二次生成零重传采纳（幂等去重 — 同内容同 id）', heal2.adopted >= 1 && heal2.reuploaded === 0 && heal2.fixed.get(shaA) === heal.fixed.get(shaA),
      `adopted=${heal2.adopted} reuploaded=${heal2.reuploaded}`)

    // 清理：删除测试留存（DB 记录 + 落盘文件 — 避免污染用户数据）
    try {
      const dbMod = await import('../src/lib/db')
      const recs = await dbMod.db.importedReport.findMany({ where: { contentSha: shaA }, select: { htmlPath: true } })
      await dbMod.db.importedReport.deleteMany({ where: { contentSha: shaA } })
      const fsMod = await import('node:fs/promises')
      for (const r of recs) await fsMod.rm(r.htmlPath, { force: true }).catch(() => undefined)
      console.log(`（测试留存已清理：${recs.length} 份）`)
    } catch (e) {
      console.log('（清理跳过：', e instanceof Error ? e.message : String(e), '）')
    }
  }

  console.log(`\n结果：${pass} PASS / ${fail} FAIL`)
  if (fail > 0) process.exit(1)
}

main().catch(err => {
  console.error('脚本异常：', err)
  process.exit(1)
})
