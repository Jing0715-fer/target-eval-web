/**
 * 高通量运行统计看板（v2.28）— 一次运行完成后的评分统计 + AI 整体可行性报告。
 *
 * 用户需求：高通量评估完成后自动生成 ① 评分统计 dashboard ② AI 整体可行性统计
 * 报告 — 以离线 HTML 自动下载，并链接到所有单独报告；每个靶点给一句话结论
 * （能否做）。
 *
 * 组成：
 *  - loadHtDashboardRows：从 DB 加载各已完成作业的摘要行（评分/计数/区间/结论素材）
 *    v2.60：作业已不在服务器（实例回收/过期）时，可用前端上传的浏览器本地缓存
 *    快照（ArchivedJobSnapshot）恢复统计行 — 汇总报告在服务器数据丢失后仍可重建
 *  - computeHtStats：批次统计（分数分布、方法可用性、覆盖率、推进档位计数）
 *  - ruleVerdict：确定性一句话结论（评分 + 结构证据；LLM 失败/超限时的兜底）
 *  - generateHtDashboardReport：LLM 整体可行性报告（失败静默降级 — 看板仍渲染
 *    统计与规则结论）+ LLM 每靶点一句话结论（≤40 靶点时尝试，校验失败回退规则）
 *  - renderHtDashboardHtml：自包含离线 HTML（内联 CSS/SVG，无外链资源）—
 *    统计卡 + 分数分布图 + 方法分布 + 每靶点结论表（链接：zip 相对路径 +
 *    在线绝对路径）+ AI 报告正文
 *    v2.61：① 总分与 X-ray/Cryo-EM/NMR 评分分列（各自列头独立排序）；
 *    ② 回补的 UniProt ID 以醒目徽标展示（可点开 UniProt 条目，「回补 · 来源」
 *    标注识别链）；③ 序列一键复制（前端按 jobId 携带提交序列全文）；
 *    v2.62：④ 所有靶点的完整报告内嵌于汇总报告 — 行内「完整报告 ↗」点击
 *    拼装该靶点自己的单页报告，Blob 新标签弹出；
 *    v2.63：⑤ 内嵌的单独报告改为报告文件原文（job.reportPath 读取 — 与
 *    下载的单独报告完全一致，含全部图表与脚本；服务端文件丢失时回退
 *    markdown 重建页）；⑥ 页宽随浏览器动态调整（去 1224px 固定上限）；
 *    ⑦ 总表靶点名称 / UniProt / 序列拆为三列（UniProt 列可排序）。
 *
 * 离线链接语义：zip 相对路径与 ht-archive 打包命名同源（planArchiveNames 共享
 * 规划器）— 「批量下载全部」zip 解压后，看板内 G01/xxx.html 链接直接可点。
 */
import { db } from '@/lib/db'
import { readFile } from 'node:fs/promises'
import { llmChat } from './llm'
import { getEngineSummary } from './llm-provider'
import { renderMarkdown } from './report-html'
import { planArchiveNames, type ArchivePlanItem } from './ht-archive-names'
import type { HtExcelRowSnapshot } from './ht-excel'
import type { PdbEntry, BlastHit } from './types'

// ─── 数据行 ───────────────────────────────────────────────────────────────────

export interface HtDashboardRow {
  jobId: string
  /** 展示名（运行条目的 label 或作业标题） */
  label: string
  uniprotId?: string
  proteinName: string
  organism: string
  /** v2.27 生效评估区间（截短构建/聚蛋白片段） */
  range?: [number, number]
  overall: number
  xray: number
  cryoem: number
  nmr: number
  directPdbCount: number
  blastHitCount: number
  coverage: number
  /** 三方法结构可用（methodStats 计数 > 0） */
  methodXrayCount: number
  methodCryoemCount: number
  methodNmrCount: number
  bestResolution: number | null
  ligandCount: number
  literatureCount: number
  reportLlmOk: boolean
  durationMs: number
  /** zip 内相对路径（离线链接） */
  zipHref?: string
  /** 单独报告是否存在（在线链接可用性） */
  hasReport: boolean
  /** v2.36 汇总报告：LLM 评估报告正文（「完整报告」弹出的单靶点报告页内嵌渲染） */
  reportMarkdown?: string
  /** v2.36 汇总报告：匹配到的原始 Excel 行文本（折叠快照） */
  excelText?: string
  /** v2.60：本行数据来自浏览器本地缓存快照（服务端作业已过期 — 在线/离线链接不可用，仅展开报告可用） */
  fromArchive?: boolean
  /** v2.61：提交序列全文（前端按 jobId 精确携带 — 汇总表「复制序列」按钮 + 单靶点完整报告弹出页展示） */
  sequence?: string
  /** v2.63：单独报告文件原文（job.reportPath — 与下载的单独报告完全一致；
   *  服务端文件丢失/超预算时缺省，回退 reportMarkdown 重建页） */
  reportHtml?: string
  /** v2.61：回补来源标注（序列靶点身份识别链 — 如「BLAST nr 识别 98%」「UniProt 精确匹配」；
  *  uniprotId 为评估中回补时的徽标提示） */
  identifiedVia?: string
}

export interface HtVerdict {
  jobId: string
  /** go = 建议推进；caution = 谨慎推进（需补数据/降预期）；no = 不建议 */
  verdict: 'go' | 'caution' | 'no'
  /** 一句话结论（≤80 字，含证据要点） */
  line: string
  /** 结论来源：rule = 规则推断；llm = AI 撰写 */
  source: 'rule' | 'llm'
}

export interface HtDashboardStats {
  totalTargets: number
  /** 成功加载（参与统计）的靶点数；差值 = 失败/未完成 */
  loadedTargets: number
  failedTargets: number
  overallMean: number
  overallMedian: number
  overallMin: number
  overallMax: number
  /** 总分分布直方（0-10 分十桶） */
  overallBuckets: number[]
  methodMeans: { xray: number; cryoem: number; nmr: number }
  /** 任一方法有结构的靶点数 */
  targetsWithStructures: number
  targetsWithXray: number
  targetsWithCryoem: number
  targetsWithNmr: number
  coverageMean: number
  targetsCoverage50: number
  targetsWithLigand: number
  rangeTargets: number
  verdictCounts: { go: number; caution: number; no: number }
}

/** 看板条目输入（POST 载荷；job 条目出统计行，merged 条目只参与 zip 命名规划） */
export interface HtDashboardEntry {
  jobId?: string
  mergedId?: string
  group?: number
  label?: string
}

/** v2.60：浏览器本地缓存恢复的作业快照 — 服务端作业已过期（实例回收/起出保留期）
 *  时由前端从本地缓存（作业完成瞬间的终态详情副本）提取上传，恢复该靶点的统计行。
 *  字段为看板统计所需最小集：评分 summary + 结构/同源计数 + 报告正文。 */
export interface ArchivedJobSnapshot {
  jobId: string
  uniprotId?: string
  title?: string
  /** 评分摘要对象（与 DB EvaluationJob.summary JSON 同构；必须含 scores） */
  summary: Record<string, unknown>
  pdbCount: number
  blastHitCount: number
  reportMarkdown?: string
}

/** 行构建的公共素材（DB 作业与缓存快照共用同一构造器 — 字段口径一致） */
interface RowSource {
  jobId: string
  entry: HtDashboardEntry
  uniprotId?: string | null
  title?: string | null
  summary: Record<string, unknown> | null
  pdbCount: number
  blastHitCount: number
  reportMarkdown?: string | null
  hasReport: boolean
  fromArchive?: boolean
  /** v2.61：提交序列全文（前端载荷按 jobId 回填） */
  sequence?: string | null
  /** v2.63：单独报告文件原文（与下载的单独报告完全一致 — 由加载层读文件回填） */
  reportHtml?: string | null
}

/** 从评分摘要等素材构造统计行（summary 缺失 → null） */
function buildDashboardRow(src: RowSource): HtDashboardRow | null {
  const summary = src.summary
  if (!summary) return null
  const uni = (summary.uniprot ?? {}) as Record<string, unknown>
  const scores = (summary.scores ?? {}) as Record<string, Record<string, unknown> & { score?: number }>
  const methodStats = (summary.methodStats ?? {}) as Record<string, unknown>
  const range = summary.range as [number, number] | undefined
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  // v2.36：评估报告正文（单靶点完整报告弹出页内嵌）+ 标题（无 label 时的展示兑底）
  const reportMarkdown = typeof src.reportMarkdown === 'string' && src.reportMarkdown.trim() ? src.reportMarkdown : undefined
  // v2.61：回补来源标注（序列靶点身份识别 — 评估中由序列定位到 UniProt 条目时留下证据链）
  const ti = summary.targetIdentity as { source?: unknown; sourceLabel?: unknown; identity?: unknown } | undefined
  const identifiedVia = ti && typeof ti.sourceLabel === 'string' && ti.source !== 'eval-table'
    ? `${ti.sourceLabel}${typeof ti.identity === 'number' && Number.isFinite(ti.identity) ? ` ${Math.round(ti.identity)}%` : ''}`
    : undefined
  return {
    jobId: src.jobId,
    label: (src.entry.label || src.uniprotId || src.title || src.jobId).slice(0, 60),
    uniprotId: src.uniprotId ?? undefined,
    proteinName: String(uni.proteinName || src.uniprotId || src.entry.label || '未知靶点').slice(0, 80)
      // v2.31：聚合蛋白截短追加 nsp 标注（同名靶点行可区分 — 如 P0DTD1 的不同 nsp 构建）
      + (uni.nspLabel ? ` ${String(uni.nspLabel).slice(0, 24)}` : ''),
    organism: String(uni.organism ?? ''),
    range: Array.isArray(range) && range.length === 2 && range[0] >= 1 && range[1] >= range[0] ? [range[0], range[1]] : undefined,
    overall: num(scores.overall?.score),
    xray: num(scores.xray?.score),
    cryoem: num(scores.cryoem?.score),
    nmr: num(scores.nmr?.score),
    directPdbCount: src.pdbCount,
    blastHitCount: src.blastHitCount,
    coverage: num(summary.coverage),
    methodXrayCount: num(methodStats.xrayCount),
    methodCryoemCount: num(methodStats.cryoemCount),
    methodNmrCount: num(methodStats.nmrCount),
    bestResolution: typeof methodStats.bestResolution === 'number' ? methodStats.bestResolution : null,
    ligandCount: num(summary.ligandCount),
    literatureCount: num(summary.literatureCount),
    reportLlmOk: summary.reportLlmOk === true,
    durationMs: num(summary.durationMs),
    hasReport: src.hasReport,
    reportMarkdown,
    fromArchive: src.fromArchive ? true : undefined,
    sequence: src.sequence ?? undefined,
    reportHtml: src.reportHtml ?? undefined,
    identifiedVia,
  }
}

/** v2.63：内嵌单独报告的体积护栏 — 单份 ≤12MB / 批次总量 ≤64MB（正常报告
 *  远小于此；超出仅丢失「完全一致」内嵌，回退 markdown 重建页，不影响统计） */
const REPORT_HTML_MAX_BYTES = 12_000_000
const REPORT_HTML_TOTAL_BUDGET = 64_000_000

/** v2.63：读取单独报告文件原文（与下载的单独报告完全一致）— 文件丢失/超预算
 *  时返回 null，弹出页回退 markdown 重建页（统计不受影响）。 */
async function readReportHtml(reportPath: string | null, budget: { total: number }): Promise<string | null> {
  if (!reportPath) return null
  try {
    const html = await readFile(reportPath, 'utf-8')
    if (html.length > REPORT_HTML_MAX_BYTES) return null
    if (budget.total + html.length > REPORT_HTML_TOTAL_BUDGET) return null
    budget.total += html.length
    return html
  } catch {
    return null
  }
}

/** 从 DB 加载统计行（不校验归属 — 路由层负责）；v2.60：DB 无该作业时回退
 *  前端上传的缓存快照（archivedByJob）恢复统计行（行标 fromArchive）；
 *  v2.61：sequencesByJob 按 jobId 回填提交序列全文（汇总表复制按钮 + 弹出报告页展示）。 */
export async function loadHtDashboardRows(entries: HtDashboardEntry[], archivedByJob?: Map<string, ArchivedJobSnapshot>, sequencesByJob?: Map<string, string>): Promise<{ rows: HtDashboardRow[]; jobCount: number }> {
  const rows: HtDashboardRow[] = []
  let jobCount = 0
  const reportBudget = { total: 0 }
  for (const entry of entries) {
    if (!entry.jobId) continue
    jobCount++
    const job = await db.evaluationJob.findUnique({ where: { id: entry.jobId } })
    if (job && job.status === 'done') {
      let summary: Record<string, unknown> | null = null
      try { summary = job.summary ? JSON.parse(job.summary) : null } catch { /* ignore */ }
      let pdbs: PdbEntry[] = []
      let blastHits: BlastHit[] = []
      try { pdbs = job.pdbs ? JSON.parse(job.pdbs) : [] } catch { /* ignore */ }
      try { blastHits = job.blastHits ? JSON.parse(job.blastHits) : [] } catch { /* ignore */ }
      const row = buildDashboardRow({
        jobId: job.id,
        entry,
        uniprotId: job.uniprotId,
        title: job.title,
        summary,
        pdbCount: pdbs.length,
        blastHitCount: blastHits.length,
        reportMarkdown: job.reportMarkdown,
        hasReport: Boolean(job.reportPath),
        fromArchive: undefined,
        sequence: sequencesByJob?.get(job.id) ?? null,
        // v2.63：报告文件原文（与下载的单独报告完全一致）— 丢失/超预算时回退 markdown 重建页
        reportHtml: await readReportHtml(job.reportPath, reportBudget),
      })
      if (row) rows.push(row)
    } else {
      // v2.60：作业不在服务器（实例回收/过期）→ 用前端上传的缓存快照恢复
      const snap = archivedByJob?.get(entry.jobId)
      if (!snap) continue
      const row = buildDashboardRow({
        jobId: snap.jobId,
        entry,
        uniprotId: snap.uniprotId ?? null,
        title: snap.title ?? null,
        summary: snap.summary,
        pdbCount: snap.pdbCount,
        blastHitCount: snap.blastHitCount,
        reportMarkdown: snap.reportMarkdown ?? null,
        hasReport: false, // 服务器无报告文件 — 在线/离线链接均不可用，评估正文经「完整报告」弹出页提供
        fromArchive: true,
        sequence: sequencesByJob?.get(snap.jobId) ?? null,
        reportHtml: null, // 快照仅存 markdown — 弹出页由重建页提供（无服务器文件可内嵌）
      })
      if (row) rows.push(row)
    }
  }
  return { rows, jobCount }
}

/** v2.36：评估条目 ↔ 原始 Excel 行匹配（汇总报告「原表内容」列）。
 *  匹配优先级：label 前缀（结构交付行标签）> Excel 行文本含 label > uniprot 在行文本中。
 *  每条 Excel 行最多被引用一次后从候选池退位（多靶点同行的场景仍可重复命中 uniprot）。 */
export function attachExcelRows(rows: HtDashboardRow[], excelRows: HtExcelRowSnapshot[]): void {
  if (!excelRows.length) return
  for (const r of rows) {
    const label = r.label.split('·')[0]?.trim() ?? r.label
    let hit = excelRows.find((e) => label && (e.label === label || e.label.startsWith(label) || label.startsWith(e.label)))
    if (!hit && r.uniprotId) {
      hit = excelRows.find((e) => e.text.toUpperCase().includes(String(r.uniprotId).toUpperCase()))
    }
    if (hit) r.excelText = hit.text
  }
}

// ─── 统计 ─────────────────────────────────────────────────────────────────────

export function computeHtStats(rows: HtDashboardRow[], jobCount: number): HtDashboardStats {
  const n = rows.length
  const overall = rows.map(r => r.overall).sort((a, b) => a - b)
  const mean = (xs: number[]): number => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10 : 0)
  const buckets = new Array(10).fill(0)
  for (const r of rows) {
    const b = Math.min(9, Math.max(0, Math.floor(r.overall)))
    buckets[b]++
  }
  const verdicts = rows.map(r => ruleVerdict(r).verdict)
  return {
    totalTargets: jobCount,
    loadedTargets: n,
    failedTargets: Math.max(0, jobCount - n),
    overallMean: mean(overall),
    overallMedian: n ? overall[Math.floor(n / 2)] : 0,
    overallMin: n ? overall[0] : 0,
    overallMax: n ? overall[n - 1] : 0,
    overallBuckets: buckets,
    methodMeans: {
      xray: mean(rows.map(r => r.xray)),
      cryoem: mean(rows.map(r => r.cryoem)),
      nmr: mean(rows.map(r => r.nmr)),
    },
    targetsWithStructures: rows.filter(r => r.directPdbCount > 0 || r.blastHitCount > 0).length,
    targetsWithXray: rows.filter(r => r.methodXrayCount > 0).length,
    targetsWithCryoem: rows.filter(r => r.methodCryoemCount > 0).length,
    targetsWithNmr: rows.filter(r => r.methodNmrCount > 0).length,
    coverageMean: mean(rows.map(r => r.coverage)),
    targetsCoverage50: rows.filter(r => r.coverage >= 50).length,
    targetsWithLigand: rows.filter(r => r.ligandCount > 0).length,
    rangeTargets: rows.filter(r => r.range).length,
    verdictCounts: {
      go: verdicts.filter(v => v === 'go').length,
      caution: verdicts.filter(v => v === 'caution').length,
      no: verdicts.filter(v => v === 'no').length,
    },
  }
}

// ─── 规则结论 ─────────────────────────────────────────────────────────────────

/** 确定性一句话结论（评分 + 结构证据 — LLM 不可用时的兜底与默认） */
export function ruleVerdict(r: HtDashboardRow): HtVerdict {
  const struct = r.directPdbCount > 0
    ? `${r.directPdbCount} 个直接结构（X-ray ${r.methodXrayCount}${r.methodCryoemCount ? ` / Cryo-EM ${r.methodCryoemCount}` : ''}）`
    : r.blastHitCount > 0 ? `无直接结构，同源命中 ${r.blastHitCount} 个` : '无任何结构证据'
  const res = r.bestResolution != null ? `，最佳分辨率 ${r.bestResolution}Å` : ''
  const cov = r.coverage > 0 ? `，序列覆盖 ${r.coverage}%` : ''
  const rng = r.range ? `（限定 ${r.range[0]}-${r.range[1]}）` : ''
  if (r.overall >= 7 && r.directPdbCount >= 3) {
    return { jobId: r.jobId, verdict: 'go', source: 'rule', line: `建议推进${rng} — ${struct}${res}${cov}` }
  }
  if (r.overall >= 5 || (r.directPdbCount >= 1 && r.overall >= 4)) {
    return { jobId: r.jobId, verdict: 'caution', source: 'rule', line: `谨慎推进${rng} — ${struct}${res}${cov}${r.overall < 5 ? '，证据有限需先补数据' : ''}` }
  }
  return { jobId: r.jobId, verdict: 'no', source: 'rule', line: `不建议直接立项${rng} — ${struct}${cov}${r.blastHitCount > 0 ? '，同源覆盖不足' : ''}` }
}

// ─── LLM 整体可行性报告 ───────────────────────────────────────────────────────

/** 行摘要（LLM prompt 用 — 每行一段紧凑文本） */
function rowDigest(r: HtDashboardRow, verdict: HtVerdict): string {
  return `- ${r.label}${r.range ? `（残基 ${r.range[0]}-${r.range[1]}）` : ''}：总分 ${r.overall}/10（X ${r.xray}/C ${r.cryoem}/N ${r.nmr}）；直接结构 ${r.directPdbCount}${r.blastHitCount ? `，同源 ${r.blastHitCount}` : ''}；覆盖 ${r.coverage}%${r.bestResolution != null ? `；最佳 ${r.bestResolution}Å` : ''}；结论：${verdict.line.slice(0, 60)}`
}

export interface HtDashboardGeneration {
  markdown: string
  ok: boolean
  errors: string[]
  verdicts: HtVerdict[]
}

/**
 * LLM 整体可行性报告 + 每靶点一句话结论（best-effort — 任一失败均静默降级，
 * 统计与规则结论不受影响）。
 *  - 报告章：执行摘要 / 整体可行性画像 / 优先级与分组推进建议 / 共性风险与资源建议
 *  - 每靶点结论：≤40 靶点时让 LLM 重写为一句话（校验失败逐条回退规则结论）
 */
export async function generateHtDashboardReport(
  rows: HtDashboardRow[],
  stats: HtDashboardStats,
  goal?: string,
): Promise<HtDashboardGeneration> {
  const errors: string[] = []
  const ruleVerdicts = rows.map(r => ruleVerdict(r))

  // ① 每靶点一句话结论（LLM 重写 — ≤40 靶点；输入行摘要 + 规则结论供参考）
  let verdicts = ruleVerdicts
  if (rows.length > 0 && rows.length <= 40) {
    try {
      const vSystem = '你是蛋白靶点结构解析可行性评估平台的决策摘要助手。输入为一批已评估靶点的分数与证据行，请为每个靶点输出一句话结论（能否做结构解析项目）。严格输出一个 JSON 对象，不要任何其他文字或 Markdown 标记：{"verdicts":[{"jobId":"...","verdict":"go|caution|no","line":"一句话结论，≤70字，含关键证据（结构数/分辨率/覆盖率/区间）"}]}。判定口径：go=证据充分建议推进（一般总分≥7 且直接结构≥3）；caution=有限可行需补数据或降预期（总分≥5 或有少量结构）；no=不建议直接立项。结论必须基于给定证据，不得编造数字。'
      const vPrompt =
        `靶点评估结果如下（每行含评分/结构证据/覆盖/规则结论参考）：\n` +
        rows.map((r, i) => `${rowDigest(r, ruleVerdicts[i])} [jobId:${r.jobId}]`).join('\n') +
        `\n\n请输出 JSON。`
      const vr = await llmChat(vPrompt, vSystem, AbortSignal.timeout(60_000))
      if (vr.ok) {
        const cleaned = vr.text.replace(/```json/gi, '```').replace(/```/g, '').trim()
        const start = cleaned.indexOf('{')
        const end = cleaned.lastIndexOf('}')
        if (start >= 0 && end > start) {
          const parsed = JSON.parse(cleaned.slice(start, end + 1)) as { verdicts?: Array<{ jobId?: unknown; verdict?: unknown; line?: unknown }> }
          const byJob = new Map<string, HtVerdict>()
          for (const v of parsed.verdicts ?? []) {
            if (typeof v.jobId !== 'string' || typeof v.line !== 'string') continue
            const verdict = v.verdict === 'go' || v.verdict === 'caution' || v.verdict === 'no' ? v.verdict : null
            if (!verdict) continue
            byJob.set(v.jobId, { jobId: v.jobId, verdict, source: 'llm', line: v.line.trim().slice(0, 80) })
          }
          verdicts = rows.map((r, i) => byJob.get(r.jobId) ?? ruleVerdicts[i])
        }
      } else {
        errors.push(`AI 每靶点结论未生成（${vr.error ?? '不可用'}）— 已使用规则结论`)
      }
    } catch {
      errors.push('AI 每靶点结论解析失败 — 已使用规则结论')
    }
  }

  // ② 整体可行性报告（markdown 四章）
  let markdown = ''
  let ok = false
  try {
    const rSystem = `你是蛋白靶点结构解析可行性评估平台的首席评估科学家，为一次高通量评估运行（${rows.length} 个靶点）撰写整体可行性统计报告。严格基于给定数据，禁止编造数字、结构或文献。Markdown 输出四章（用 ## 标题）：
## 执行摘要
本批次总体可行性画像（2-4 句：可推进/谨慎/放弃的大致比例与主导因素）。
## 整体可行性画像
评分分布解读（均分/中位/两端）、三方法可用性（X-ray/Cryo-EM/NMR 各多少靶点有结构）、覆盖率与区间（截短构建）特点；点出共性有利因素与共性短板。
## 优先级与分组推进建议
按证据强度给出推进优先级（先做哪几个、为什么）；对 caution 档靶点给补数据建议（哪些实验/构建边界调整）；对 no 档明确说明不建议的理由。可用少量表格（| 靶点 | 建议 | 依据 |）。
## 共性风险与资源建议
批次级风险（如同源覆盖率低、无配体证据、区间截短导致的结构缺失）与资源分配建议（哪些靶点共用构建/表达体系、哪些可合并委托）。`
    const rPrompt =
      `客户目标：${goal?.trim() || '（未填写）'}\n` +
      `批次统计：靶点 ${stats.totalTargets}（成功 ${stats.loadedTargets}${stats.failedTargets ? `，失败 ${stats.failedTargets}` : ''}）；总分均 ${stats.overallMean}/中位 ${stats.overallMedian}（${stats.overallMin}-${stats.overallMax}）；建议推进 ${stats.verdictCounts.go} · 谨慎 ${stats.verdictCounts.caution} · 不建议 ${stats.verdictCounts.no}；有结构靶点 ${stats.targetsWithStructures}（X-ray ${stats.targetsWithXray} / Cryo-EM ${stats.targetsWithCryoem} / NMR ${stats.targetsWithNmr}）；平均覆盖 ${stats.coverageMean}%；带评估区间（截短构建）${stats.rangeTargets} 个。\n\n` +
      `各靶点明细（${rows.length} 行）：\n` + rows.map((r, i) => `${rowDigest(r, verdicts[i])} [jobId:${r.jobId}]`).join('\n') +
      `\n\n请撰写报告（Markdown）。`
    const rr = await llmChat(rPrompt, rSystem, AbortSignal.timeout(120_000))
    if (rr.ok && rr.text.trim()) {
      markdown = rr.text.trim()
      ok = true
    } else {
      errors.push(`AI 整体报告未生成（${rr.error ?? '输出为空'}）— 看板保留统计与每靶点结论`)
    }
  } catch (e) {
    errors.push(`AI 整体报告异常（${e instanceof Error ? e.message : '未知'})— 看板保留统计与每靶点结论`)
  }
  return { markdown, ok, errors, verdicts }
}

// ─── zip 相对链接（与 ht-archive 命名同源）────────────────────────────────────

/** 解析条目 zip 命名（job: label/uniprotId/title/jobId；merged: DB title/短 id）→ 与输入同序路径 */
export async function resolveZipHrefs(entries: HtDashboardEntry[]): Promise<Map<string, string>> {
  const plan: ArchivePlanItem[] = []
  for (const e of entries) {
    if (e.jobId) {
      const job = await db.evaluationJob.findUnique({ where: { id: e.jobId }, select: { uniprotId: true, title: true } })
      plan.push({ kind: 'job', group: e.group, title: e.label || job?.uniprotId || job?.title || e.jobId })
    } else if (e.mergedId) {
      const rec = await db.batchReport.findUnique({ where: { id: e.mergedId }, select: { title: true } })
      plan.push({ kind: 'merged', group: e.group, title: rec?.title || `merged-${e.mergedId.slice(0, 8)}` })
    }
  }
  const names = planArchiveNames(plan)
  const byJob = new Map<string, string>()
  entries.forEach((e, i) => { if (e.jobId) byJob.set(e.jobId, names[i]) })
  return byJob
}

// ─── v2.36 汇总报告 HTML 渲染（自包含离线 · 期刊版式与单靶点报告同源）──────────

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const VERDICT_META: Record<HtVerdict['verdict'], { label: string; color: string; bg: string; border: string }> = {
  go: { label: '建议推进', color: '#0f766e', bg: '#ccfbf1', border: '#99e5d5' },
  caution: { label: '谨慎推进', color: '#a16207', bg: '#fef3c7', border: '#fde68a' },
  no: { label: '不建议', color: '#b91c1c', bg: '#fee2e2', border: '#fecaca' },
}

function distBar(buckets: number[], total: number): string {
  const max = Math.max(1, ...buckets)
  return `<div class="dist">${buckets.map((c, i) => {
    const h = total > 0 ? Math.max(c > 0 ? 6 : 2, Math.round((c / max) * 84)) : 2
    const color = i >= 7 ? '#0d9488' : i >= 5 ? '#d97706' : '#dc2626'
    return `<div class="dist-col" title="${i}-${i + 1} 分：${c} 个"><span class="dist-n">${c || ''}</span><div class="dist-bar" style="background:${color};height:${h}px"></div><span class="dist-x">${i}</span></div>`
  }).join('')}</div>`
}

export interface RenderHtDashboardInput {
  title: string
  goal?: string
  rows: HtDashboardRow[]
  stats: HtDashboardStats
  verdicts: HtVerdict[]
  markdown: string
  llmOk: boolean
  llmErrors: string[]
  engineSummary: string
  /** 在线链接 origin（如 https://host）— 为空时仅保留 zip 相对链接 */
  origin: string
  /** 运行时长（秒，可选展示） */
  durationSec?: number
  generatedAt: string
  /** v2.36：原始 Excel 行快照（「原表内容」列；匹配逻辑见 attachExcelRows） */
  excelRows?: Array<{ label: string; text: string }>
}

/** v2.61：JSON 载荷内嵌为 <script type="application/json">（所有 `<` 转义为 \u003c —
 *  阻断 `</script>` 提前闭合与脚本数据态陷阱；前端 JSON.parse 解码还原） */
function embedJsonScript(id: string, data: unknown): string {
  return `<script type="application/json" id="${id}">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`
}

/** 评分 → 高/中/低配色（与总分 chip 同口径） */
function scoreTone(n: number): string {
  return n >= 7 ? 'hi' : n >= 5 ? 'md' : 'lo'
}

/** v2.62：单靶点完整报告页共享样式（「完整报告 ↗」弹出页内联 — 与汇总报告同源的
 *  期刊风；一份样式随载荷只内嵌一次，各靶点弹出页共用，避免逐靶点重复内联） */
const HT_TARGET_REPORT_CSS = `:root{--ink:#1c1917;--sub:#57534e;--faint:#a8a29e;--line:#e7e5e4;--hairline:#efedeb;--accent:#065f46;--accent-2:#047857;--accent-bg:#f0fdf7;--bg:#fcfcfb;--paper:#fff;
--serif:"Source Serif 4","Noto Serif SC",Georgia,"Songti SC","STSong","SimSun","Times New Roman",serif;--mono:"JetBrains Mono",ui-monospace,"SF Mono",Menlo,Consolas,monospace}
*{margin:0;padding:0;box-sizing:border-box}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact;scroll-behavior:smooth}
body{font-family:var(--serif);color:var(--ink);background:var(--bg);line-height:1.92;font-size:15px;letter-spacing:.006em}
.mono{font-family:var(--mono)}
.page{max-width:980px;margin:0 auto;padding:56px 44px 72px;background:var(--paper);min-height:100vh;box-shadow:0 0 0 1px var(--hairline)}
@media(max-width:1024px){.page{padding:40px 30px 56px}}
@media(max-width:640px){.page{padding:26px 16px 38px}}
@media print{body{background:#fff}.page{padding:0;max-width:none;box-shadow:none}.no-print{display:none!important}.seq-pre{max-height:none!important;overflow:visible}}
.rpt-head{padding-bottom:22px;margin-bottom:30px;border-bottom:1px solid var(--ink);position:relative}
.rpt-head::after{content:'';display:block;position:absolute;left:0;bottom:3px;width:100%;border-bottom:3px solid var(--ink)}
.rpt-eyebrow{font-family:var(--mono);color:var(--accent);font-weight:600;font-size:10.5px;letter-spacing:2.4px;text-transform:uppercase;margin-bottom:14px}
h1.rpt-title{font-size:26px;line-height:1.4;margin-bottom:6px;font-weight:900;overflow-wrap:anywhere}
.rpt-subtitle{font-size:13px;color:var(--sub);font-style:italic;margin-bottom:18px}
.meta-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:9px 22px;font-size:12.5px;color:var(--sub)}
.meta-grid b{color:var(--ink);font-weight:600;margin-right:2px}
.tg-range{color:var(--accent-2);font-family:var(--mono);font-size:11px}
.score{display:inline-block;min-width:30px;text-align:center;border-radius:5px;padding:0 6px;font-family:var(--mono);font-size:11px;font-weight:700}
.score.hi{color:#0f766e;background:#ccfbf1}.score.md{color:#a16207;background:#fef3c7}.score.lo{color:#b91c1c;background:#fee2e2}
.vd{display:inline-block;border-radius:4px;padding:0 7px;font-size:10px;font-weight:700;letter-spacing:.5px}
.vd-go{color:#0f766e;background:#ccfbf1;border:1px solid #99e5d5}
.vd-caution{color:#a16207;background:#fef3c7;border:1px solid #fde68a}
.vd-no{color:#b91c1c;background:#fee2e2;border:1px solid #fecaca}
.dim{color:var(--faint);font-size:10px}
article.tg{margin:0}
.tg-head{border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:8px;background:linear-gradient(180deg,#ffffff,#f7fcf9);padding:13px 18px;margin-bottom:12px}
.tg-cache{display:inline-block;margin-left:8px;padding:0 6px;border-radius:4px;border:1px solid #fde68a;background:#fffbeb;color:#a16207;font-family:var(--mono);font-size:9.5px;font-weight:600;letter-spacing:.5px;vertical-align:2px}
.tg-meta{display:flex;flex-wrap:wrap;align-items:center;gap:5px 14px;margin-top:6px;font-size:11.5px;color:var(--sub);font-family:var(--mono)}
.tg-meta a{color:var(--accent-2)}
.uni-id{display:inline-block;font-family:var(--mono);font-size:12px;font-weight:700;color:var(--accent);background:var(--accent-bg);border:1.5px solid #6ee7c7;border-radius:6px;padding:1px 9px;text-decoration:none;letter-spacing:.2px}
.uni-id:hover{background:#d1fae5;border-color:var(--accent-2)}
.uni-src{font-family:var(--mono);font-size:9.5px;color:#0f766e;background:#ecfdf5;border:1px dashed #6ee7c7;border-radius:4px;padding:0 6px}
.tg-verdict{margin-top:8px;font-size:12px;line-height:1.7}
.tg-verdict .vl{margin-left:6px;color:var(--ink)}
.seqbox{border:1px dashed #b8e6d2;background:var(--accent-bg);border-radius:8px;padding:10px 14px;margin-top:14px}
.seq-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;font-size:11.5px;color:var(--sub)}
.seq-pre{margin-top:8px;font-family:var(--mono);font-size:10.5px;line-height:1.75;white-space:pre-wrap;word-break:break-all;max-height:240px;overflow-y:auto;background:#fff;border:1px solid var(--hairline);border-radius:6px;padding:10px 12px;color:var(--ink)}
.seq-copy{font-family:var(--mono);font-size:10px;font-weight:600;padding:2px 10px;border-radius:5px;border:1px solid #b8e6d2;background:#fff;color:var(--accent);cursor:pointer;white-space:nowrap}
.seq-copy:hover{background:var(--accent-bg)}
.seq-copy.ok{background:var(--accent);color:#fff;border-color:var(--accent)}
.md{font-size:13px;line-height:1.85}
.md h2{font-size:16px;margin:20px 0 8px;padding-bottom:5px;border-bottom:1px solid var(--hairline);font-weight:800}
.md h3{font-size:13.5px;margin:14px 0 6px;font-weight:700}
.md h4{font-size:12.5px;margin:12px 0 4px;font-weight:700}
.md p{margin:8px 0}
.md ul,.md ol{margin:8px 0;padding-left:22px}
.md li{margin:3px 0}
.md code{background:#f3f4f6;border-radius:4px;padding:1px 5px;font-size:11.5px;font-family:var(--mono)}
.md table{width:100%;border-collapse:collapse;margin:10px 0;font-size:12px}
.md th,.md td{padding:6px 9px;border:1px solid var(--line);text-align:left}
.md th{background:#f9fafb;font-weight:600;font-family:var(--mono);font-size:11px}
.md blockquote{border-left:3px solid #b8e6d2;background:var(--accent-bg);padding:8px 14px;margin:10px 0;color:var(--sub)}
.md a{color:var(--accent-2)}
.note{color:var(--faint);font-size:11px;margin-top:14px;line-height:1.7}
.backtop{position:fixed;right:18px;bottom:18px;width:40px;height:40px;border-radius:50%;border:1px solid var(--line);background:#fff;color:var(--sub);font-size:16px;cursor:pointer;box-shadow:0 2px 8px rgba(28,25,23,.1);display:none;z-index:50}
.backtop.show{display:block}
@media print{.backtop{display:none}}`

/** v2.62：单靶点报告正文块 — 刊头元信息（回补 UniProt 徽标 / 蛋白名 / 种属 / 评分 /
 *  一句话结论）+ renderMarkdown 渲染的评估正文 + 提交序列块（弹出页脚本从 <pre>
 *  文本读取序列完成一键复制，无需另行内嵌序列数据）。 */
function renderTargetArticle(r: HtDashboardRow, v: HtVerdict, origin: string): string {
  const body = r.reportMarkdown
    ? renderMarkdown(r.reportMarkdown, 0)
    : '<p style="color:var(--sub)">（该靶点无内嵌报告正文 — AI 报告未生成成功或未随缓存快照保留；评分、计数与结论不受影响，完整判定见汇总报告主表。）</p>'
  const uniBadge = r.uniprotId && r.label !== r.uniprotId
    ? `<a class="uni-id" href="https://www.uniprot.org/uniprotkb/${encodeURIComponent(r.uniprotId)}" target="_blank" rel="noopener"${r.identifiedVia ? ` title="回补的 UniProt ID（${esc(r.identifiedVia)}）— 点击打开 UniProt 条目"` : ' title="UniProt ID — 点击打开 UniProt 条目"'}>UniProt ${esc(r.uniprotId)}</a>${r.identifiedVia ? `<span class="uni-src" title="该 ID 为评估中由提交序列识别回补（${esc(r.identifiedVia)}）">回补 · ${esc(r.identifiedVia)}</span>` : ''}`
    : ''
  const online = r.hasReport && origin ? `<span><a href="${esc(origin)}/api/jobs/${esc(r.jobId)}/report" target="_blank" rel="noopener">在线报告 ↗</a></span>` : ''
  return `<article class="tg">
<div class="tg-head">
  <div class="tg-meta">${uniBadge}${r.proteinName && r.proteinName !== r.label && r.proteinName !== r.uniprotId ? `<span>${esc(r.proteinName)}</span>` : ''}${r.organism ? `<span>${esc(r.organism)}</span>` : ''}</div>
  <div class="tg-meta"><span>总分 <b class="score ${scoreTone(r.overall)}">${r.overall}</b></span><span>X-ray ${r.xray} · Cryo-EM ${r.cryoem} · NMR ${r.nmr}</span><span>直接结构 ${r.directPdbCount}${r.blastHitCount ? ` +同源 ${r.blastHitCount}` : ''}${r.bestResolution != null ? ` · 最佳 ${r.bestResolution}Å` : ''}</span><span>覆盖 ${Math.round(r.coverage)}%</span>${online}</div>
  <div class="tg-verdict"><span class="vd vd-${v.verdict}">${VERDICT_META[v.verdict].label}</span><span class="vl">${esc(v.line)}${v.source === 'rule' ? '<span class="dim">（规则推断）</span>' : ''}</span></div>
</div>
<div class="md">${body}</div>
${r.sequence ? `<div class="seqbox"><div class="seq-head"><b>提交序列</b> · ${r.sequence.length} aa · 完整序列一键复制<button type="button" class="seq-copy">复制序列</button></div><pre class="seq-pre">${esc(r.sequence)}</pre></div>` : ''}
</article>`
}

/** v2.63：单靶点完整报告内嵌载荷 — 所有靶点的单独报告以数据内嵌于汇总报告；
 *  行内「完整报告 ↗」点击时前端按 data-i 取对应条目，经 Blob URL 在新标签页
 *  弹出该靶点自己的完整报告。两类条目：
 *  - html：报告文件原文（job.reportPath 读取 — 与下载的单独报告完全一致，
 *    含全部图表与脚本，自包含离线）；
 *  - h/a：重建页（服务端报告文件丢失/缓存快照恢复的靶点 — 由 markdown 与
 *    统计数据拼装，共享样式 c）。
 *  键名精简：c=共享样式 g=生成时间 m=母报告 e=引擎；r[]=tt 页标题 / j 作业 ID /
 *  html 报告原文 / h 刊头 HTML / a 正文块 HTML（动态文本均已在服务端 esc 转义）。 */
function buildHtReportPayload(input: {
  title: string
  rows: HtDashboardRow[]
  verdicts: HtVerdict[]
  generatedAt: string
  engineSummary: string
  origin: string
}): { c?: string; g: string; m: string; e: string; r: Array<{ tt: string; j: string; html?: string; h?: string; a?: string }> } {
  const verdictByJob = new Map(input.verdicts.map(v => [v.jobId, v]))
  const needFallbackCss = input.rows.some(r => !r.reportHtml)
  return {
    // 共享样式仅在有重建页条目时才内嵌（原文报告自带完整样式，无需共享）
    c: needFallbackCss ? HT_TARGET_REPORT_CSS : undefined,
    g: esc(input.generatedAt),
    m: esc(input.title),
    e: esc(input.engineSummary),
    r: input.rows.map(r => {
      if (r.reportHtml) {
        // 原文报告自带 <title>，tt 仅作 Blob 打不开时的索引提示
        return { tt: esc(`${r.label}${r.range ? ` 残基 ${r.range[0]}-${r.range[1]}` : ''} · 完整评估报告`), j: esc(r.jobId), html: r.reportHtml }
      }
      const v = verdictByJob.get(r.jobId) ?? ruleVerdict(r)
      return {
        tt: esc(`${r.label}${r.range ? ` 残基 ${r.range[0]}-${r.range[1]}` : ''} · 完整评估报告`),
        h: `${esc(r.label)}${r.range ? `<span class="tg-range"> · 残基 ${r.range[0]}-${r.range[1]}</span>` : ''}${r.fromArchive ? '<span class="tg-cache" title="该靶点数据来自浏览器本地缓存恢复（服务端作业已过期/实例回收）— 在线/离线报告链接不可用，正文与统计完整保留">缓存恢复</span>' : ''}`,
        j: esc(r.jobId),
        a: renderTargetArticle(r, v, input.origin),
      }
    }),
  }
}

/** 汇总主表（可筛选 · 可排序 · X-ray/Cryo-EM/NMR 评分分列单独排序 · 「完整报告」弹出单靶点完整报告） */
export function renderHtDashboardHtml(input: RenderHtDashboardInput): string {
  const { rows, stats, verdicts, markdown, llmOk, llmErrors, engineSummary, origin } = input
  const verdictByJob = new Map(verdicts.map(v => [v.jobId, v]))
  const sorted = [...rows].sort((a, b) => b.overall - a.overall)
  // v2.60：缓存恢复行（服务端作业已过期 — 由浏览器本地快照重建统计）头部提示 + 行内徽标
  const recoveredCount = rows.filter(r => r.fromArchive).length
  // v2.63：单靶点完整报告内嵌载荷（原文报告或 markdown 正文任一存在才内嵌）
  const anyBody = sorted.some(r => r.reportHtml || r.reportMarkdown)
  const rptPayload = anyBody
    ? buildHtReportPayload({ title: input.title, rows: sorted, verdicts, generatedAt: input.generatedAt, engineSummary, origin })
    : null
  // v2.61：序列数据（jobId → 全文 — 主表「复制序列」按钮）
  const seqByJob: Record<string, string> = {}
  for (const r of rows) if (r.sequence) seqByJob[r.jobId] = r.sequence

  const body = renderMarkdown(markdown || '（AI 整体可行性报告未生成 — 见上方提示；统计与每靶点结论不受影响）', 0)

  const tile = (label: string, value: string, sub = ''): string =>
    `<div class="gt"><div class="gt-label">${label}</div><div class="gt-value">${value}</div>${sub ? `<div class="gt-sub">${sub}</div>` : ''}</div>`

  const methodBar = (label: string, mean: number, count: number, total: number, color: string): string =>
    `<div class="mb-row"><div class="mb-cap"><span>${label}</span><span class="mb-sub">均分 ${mean}/10 · ${count}/${total} 靶点有结构</span></div><div class="mb-track"><div class="mb-fill" style="background:${color};width:${Math.round(mean * 10)}%"></div></div></div>`

  // ── 主表行（v2.63：靶点 / UniProt / 序列三列分列 · X/C/N 分列 · 完整报告新标签弹出）──
  const rowPairs = sorted.map((r, idx) => {
    const v = verdictByJob.get(r.jobId) ?? ruleVerdict(r)
    const meta = VERDICT_META[v.verdict]
    const search = esc([r.label, r.uniprotId ?? '', r.proteinName, r.organism, r.excelText ?? '', v.line, r.identifiedVia ?? ''].join(' ').toLowerCase())
    const links: string[] = []
    if (r.zipHref) links.push(`<a href="${esc(r.zipHref)}">离线包</a>`)
    if (r.hasReport && origin) links.push(`<a href="${esc(origin)}/api/jobs/${esc(r.jobId)}/report?download=1">在线</a>`)
    // v2.63：UniProt 独立列（始终展示 — 点击打开 UniProt 条目；回补来源标注识别链）
    const uniBadge = r.uniprotId
      ? `<div class="tg-uni"><a class="uni-id" href="https://www.uniprot.org/uniprotkb/${encodeURIComponent(r.uniprotId)}" target="_blank" rel="noopener"${r.identifiedVia ? ` title="回补的 UniProt ID（${esc(r.identifiedVia)}）— 点击打开 UniProt 条目"` : ' title="UniProt ID — 点击打开 UniProt 条目"'}>UniProt ${esc(r.uniprotId)}</a>${r.identifiedVia ? `<span class="uni-src" title="该 ID 为评估中由提交序列识别回补（${esc(r.identifiedVia)}）">回补 · ${esc(r.identifiedVia)}</span>` : ''}</div>`
      : '<span class="dim">—</span>'
    // v2.63：序列独立列（一键复制全文 — 原表内容列为折叠快照，序列只保留识别前缀）
    const seqCell = r.sequence
      ? `<button type="button" class="seq-copy" data-job="${esc(r.jobId)}" title="一键复制该靶点的完整提交序列（${r.sequence.length} aa）">复制 · ${r.sequence.length}aa</button>`
      : '<span class="dim">—</span>'
    const hasPopup = Boolean(r.reportHtml || r.reportMarkdown)
    const openBtn = anyBody && hasPopup
      ? `<button type="button" class="mt-open" data-i="${idx}"${r.reportHtml
          ? ' title="新标签页弹出该靶点的完整评估报告（报告文件原文内嵌于本汇总报告 — 与下载的单独报告完全一致，含全部图表与脚本，离线可用）"'
          : ' title="新标签页弹出该靶点的完整评估报告（服务端报告文件不可用/缓存恢复 — 由 markdown 与统计数据重建）"'}>完整报告 ↗</button>`
      : ''
    return `<tr class="mt-row" data-job="${esc(r.jobId)}" data-overall="${r.overall}" data-xray="${r.xray}" data-cryoem="${r.cryoem}" data-nmr="${r.nmr}" data-pdb="${r.directPdbCount}" data-cov="${Math.round(r.coverage)}" data-verdict="${v.verdict}" data-uniprot="${esc(r.uniprotId ?? '')}" data-search="${search}">
<td class="td-idx">${idx + 1}</td>
<td class="td-target">
  <div class="tg-label">${esc(r.label)}${r.range ? `<span class="tg-range">:${r.range[0]}-${r.range[1]}</span>` : ''}${r.fromArchive ? '<span class="tg-cache" title="该靶点数据来自浏览器本地缓存恢复（服务端作业已过期/实例回收）— 在线/离线报告链接不可用；评估正文经「完整报告」弹出页提供">缓存恢复</span>' : ''}</div>
  ${r.proteinName && r.proteinName !== r.label && r.proteinName !== r.uniprotId ? `<div class="tg-sub">${esc(r.proteinName)}</div>` : ''}
  ${r.organism ? `<div class="tg-sub">${esc(r.organism)}</div>` : ''}
  ${r.excelText ? `<div class="tg-excel" title="原始表该行内容（序列已折叠 — 完整序列用「复制序列」按钮）">${esc(r.excelText)}</div>` : ''}
</td>
<td class="td-uni">${uniBadge}</td>
<td class="td-seq">${seqCell}</td>
<td class="td-num"><span class="score ${scoreTone(r.overall)}">${r.overall}</span></td>
<td class="td-num"><span class="score mini ${scoreTone(r.xray)}" title="X-ray 方法评分">${r.xray}</span></td>
<td class="td-num"><span class="score mini ${scoreTone(r.cryoem)}" title="Cryo-EM 方法评分">${r.cryoem}</span></td>
<td class="td-num"><span class="score mini ${scoreTone(r.nmr)}" title="NMR 方法评分">${r.nmr}</span></td>
<td class="td-num mono">${r.directPdbCount}${r.blastHitCount ? `<span class="dim"> +${r.blastHitCount}</span>` : ''}${r.bestResolution != null ? `<div class="dim">${r.bestResolution}Å</div>` : ''}</td>
<td class="td-num mono">${Math.round(r.coverage)}%</td>
<td class="td-verdict"><span class="vd vd-${v.verdict}">${meta.label}</span><div class="vd-line">${esc(v.line)}${v.source === 'rule' ? '<span class="dim">（规则推断）</span>' : ''}</div></td>
<td class="td-act">
  ${openBtn}
  ${links.length ? `<div class="mt-links">${links.join(' · ')}</div>` : ''}
</td>
</tr>`
  }).join('')

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(input.title)}</title>
<style>
:root{--ink:#1c1917;--sub:#57534e;--faint:#a8a29e;--line:#e7e5e4;--hairline:#efedeb;--accent:#065f46;--accent-2:#047857;--accent-bg:#f0fdf7;--bg:#fcfcfb;--paper:#fff;
--serif:"Source Serif 4","Noto Serif SC",Georgia,"Songti SC","STSong","SimSun","Times New Roman",serif;--mono:"JetBrains Mono",ui-monospace,"SF Mono",Menlo,Consolas,monospace}
*{margin:0;padding:0;box-sizing:border-box}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact;scroll-behavior:smooth}
body{font-family:var(--serif);color:var(--ink);background:var(--bg);line-height:1.92;font-size:15px;letter-spacing:.006em}
.mono{font-family:var(--mono)}
/* v2.63：页宽随浏览器动态调整（去固定 1224px 上限 — 宽屏不再两侧留白；
   左右留白用 clamp 随视口收缩，窄屏自动收紧） */
.page{width:100%;max-width:none;margin:0;padding:56px clamp(20px,4vw,72px) 72px;background:var(--paper);min-height:100vh;box-shadow:0 0 0 1px var(--hairline)}
@media(max-width:1024px){.page{padding:40px 24px 56px}}
@media(max-width:640px){.page{padding:26px 14px 38px}}
@media print{body{background:#fff}.page{padding:0;max-width:none;box-shadow:none}.no-print{display:none!important}}

/* 报告封面头（期刊风双线 — 与单靶点报告同源） */
.rpt-head{padding-bottom:22px;margin-bottom:30px;border-bottom:1px solid var(--ink);position:relative}
.rpt-head::after{content:'';display:block;position:absolute;left:0;bottom:3px;width:100%;border-bottom:3px solid var(--ink)}
.rpt-eyebrow{font-family:var(--mono);color:var(--accent);font-weight:600;font-size:10.5px;letter-spacing:2.4px;text-transform:uppercase;margin-bottom:14px}
h1.rpt-title{font-size:28px;line-height:1.4;margin-bottom:6px;font-weight:900}
.rpt-subtitle{font-size:13px;color:var(--sub);font-style:italic;margin-bottom:18px}
.meta-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:9px 22px;font-size:12.5px;color:var(--sub)}
.meta-grid b{color:var(--ink);font-weight:600;margin-right:2px}
h2.sec{font-size:20px;margin:38px 0 14px;padding-bottom:8px;border-bottom:1px solid var(--line);font-weight:800}
h2.sec .k{font-family:var(--mono);font-size:11px;color:var(--accent);letter-spacing:2px;margin-right:10px;font-weight:600;vertical-align:2px}

/* 统计速览（glance 瓦片 — 单靶点报告 At-a-Glance 同源） */
.glance{border:1.5px solid var(--ink);border-radius:8px;margin:0 0 10px;background:#fff;overflow:hidden}
.glance-kicker{font-family:var(--mono);font-size:10px;letter-spacing:2.2px;text-transform:uppercase;color:var(--accent);padding:13px 20px 11px;font-weight:700;border-bottom:1px solid var(--line);background:linear-gradient(180deg,#ffffff,#f7fcf9)}
.glance-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr))}
.gt{padding:13px 16px 11px;border-right:1px solid var(--hairline);border-bottom:1px solid var(--hairline);min-width:0}
.gt-label{font-family:var(--mono);font-size:9.5px;letter-spacing:1.4px;text-transform:uppercase;color:var(--faint);font-weight:600}
.gt-value{font-size:17px;font-weight:700;margin-top:4px;line-height:1.5}
.gt-value .u{font-size:11px;color:var(--faint);font-weight:400}
.gt-sub{font-size:11px;color:var(--sub);margin-top:3px;line-height:1.55}

/* 分布图 / 方法条 */
.panel{background:#fff;border:1px solid var(--line);border-radius:8px;padding:16px 18px}
.dist{display:flex;align-items:flex-end;gap:4px;height:96px}
.dist-col{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:2px}
.dist-n{font-size:9px;color:var(--sub);font-family:var(--mono)}
.dist-bar{width:100%;border-radius:3px 3px 0 0}
.dist-x{font-size:8.5px;color:var(--faint);font-family:var(--mono)}
.mb-row{margin-bottom:9px}
.mb-cap{display:flex;justify-content:space-between;font-size:12px;color:var(--ink);margin-bottom:3px}
.mb-sub{color:var(--sub);font-family:var(--mono);font-size:10.5px}
.mb-track{height:9px;border-radius:5px;background:#f3f4f6}
.mb-fill{height:9px;border-radius:5px}

/* ── 主表（可筛选 · 可排序 · X/C/N 分列 · 完整报告弹出单靶点报告）── */
.mt-tools{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0 0 10px}
.mt-tools input[type=search],.mt-tools select{font-family:var(--mono);font-size:12px;padding:6px 10px;border:1px solid var(--line);border-radius:6px;background:#fff;color:var(--ink);outline:none}
.mt-tools input[type=search]{min-width:220px;flex:1;max-width:360px}
.mt-tools input[type=search]:focus,.mt-tools select:focus{border-color:var(--accent-2);box-shadow:0 0 0 3px rgba(4,120,87,.1)}
.mt-tools label{font-size:11.5px;color:var(--sub);display:inline-flex;align-items:center;gap:5px}
.mt-count{font-family:var(--mono);font-size:11px;color:var(--faint);margin-left:auto}
.tblwrap{overflow-x:auto;border:1px solid var(--line);border-radius:8px;background:#fff}
table.mt{width:100%;min-width:1320px;border-collapse:collapse;font-size:12.5px}
table.mt th{position:sticky;top:0;background:#f9fafb;color:var(--sub);font-weight:600;font-size:11px;padding:8px 9px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap;font-family:var(--mono);letter-spacing:.3px}
table.mt th.sortable{cursor:pointer;user-select:none}
table.mt th.sortable:hover{color:var(--accent-2)}
table.mt th .arr{font-size:9px;color:var(--accent-2);margin-left:2px}
table.mt td{padding:8px 9px;border-bottom:1px solid var(--hairline);vertical-align:top}
tr.mt-row:hover td{background:#fbfdfc}
.td-idx{color:var(--faint);font-family:var(--mono);font-size:11px}
.td-num{text-align:center;white-space:nowrap}
.tg-label{font-weight:600;font-size:12.5px;line-height:1.6;overflow-wrap:anywhere}
.tg-range{color:var(--accent-2);font-family:var(--mono);font-size:11px}
.tg-sub{font-size:10.5px;color:var(--sub);line-height:1.6}
/* v2.63 UniProt / 序列独立列 */
.td-uni{vertical-align:top;max-width:230px}
.td-uni .dim,.td-seq .dim{font-family:var(--mono)}
.td-seq{vertical-align:top;white-space:nowrap}
/* v2.63 回补 UniProt 醒目徽标（独立列内 — 评估中由序列识别回补，可点开条目） */
.tg-uni{display:flex;align-items:flex-start;flex-wrap:wrap;gap:4px}
.tg-uni .uni-src{flex-basis:100%}
.uni-id{display:inline-block;font-family:var(--mono);font-size:12px;font-weight:700;color:var(--accent);background:var(--accent-bg);border:1.5px solid #6ee7c7;border-radius:6px;padding:1px 9px;text-decoration:none;letter-spacing:.2px;line-height:1.7;white-space:nowrap}
.uni-id:hover{background:#d1fae5;border-color:var(--accent-2)}
.uni-src{font-family:var(--mono);font-size:9.5px;color:#0f766e;background:#ecfdf5;border:1px dashed #6ee7c7;border-radius:4px;padding:0 6px;line-height:1.9;display:inline-block}
/* v2.63 序列列一键复制按钮 */
.seq-copy{font-family:var(--mono);font-size:10px;font-weight:600;padding:2px 10px;border-radius:5px;border:1px solid #b8e6d2;background:#fff;color:var(--accent);cursor:pointer;white-space:nowrap}
.seq-copy:hover{background:var(--accent-bg)}
.seq-copy.ok{background:var(--accent);color:#fff;border-color:var(--accent)}
.tg-excel{margin-top:4px;padding:4px 8px;border-left:2px solid #b8e6d2;background:var(--accent-bg);font-size:10.5px;color:var(--sub);line-height:1.6;overflow-wrap:anywhere;border-radius:0 4px 4px 0}
.tg-cache{display:inline-block;margin-left:6px;padding:0 6px;border-radius:4px;border:1px solid #fde68a;background:#fffbeb;color:#a16207;font-family:var(--mono);font-size:9.5px;font-weight:600;letter-spacing:.5px;vertical-align:1px}
.score{display:inline-block;min-width:34px;text-align:center;border-radius:5px;padding:1px 7px;font-family:var(--mono);font-size:12px;font-weight:700}
.score.hi{color:#0f766e;background:#ccfbf1}.score.md{color:#a16207;background:#fef3c7}.score.lo{color:#b91c1c;background:#fee2e2}
.score.mini{min-width:26px;padding:1px 4px;font-size:11px}
.dim{color:var(--faint);font-size:10px}
.vd{display:inline-block;border-radius:4px;padding:1px 8px;font-size:10.5px;font-weight:700;letter-spacing:.5px}
.vd-go{color:#0f766e;background:#ccfbf1;border:1px solid #99e5d5}
.vd-caution{color:#a16207;background:#fef3c7;border:1px solid #fde68a}
.vd-no{color:#b91c1c;background:#fee2e2;border:1px solid #fecaca}
.vd-line{font-size:11px;color:var(--ink);line-height:1.65;margin-top:3px;max-width:420px}
.mt-open{font-family:var(--mono);font-size:10.5px;font-weight:600;padding:3px 10px;border-radius:5px;border:1px solid var(--accent-2);background:var(--accent);color:#fff;cursor:pointer;white-space:nowrap}
.mt-open:hover{background:var(--accent-2)}
.mt-links{margin-top:4px;font-size:10px;font-family:var(--mono)}
.mt-links a{color:var(--accent-2);text-decoration:none;border-bottom:1px solid #a7f3d0}

/* Markdown 正文（AI 报告 — 与单靶点报告 .md 风格同源；靶点正文在弹出页） */
.md{font-size:13px;line-height:1.85}
.md h2{font-size:16px;margin:20px 0 8px;padding-bottom:5px;border-bottom:1px solid var(--hairline);font-weight:800}
.md h3{font-size:13.5px;margin:14px 0 6px;font-weight:700}
.md h4{font-size:12.5px;margin:12px 0 4px;font-weight:700}
.md p{margin:8px 0}
.md ul,.md ol{margin:8px 0;padding-left:22px}
.md li{margin:3px 0}
.md code{background:#f3f4f6;border-radius:4px;padding:1px 5px;font-size:11.5px;font-family:var(--mono)}
.md table{width:100%;border-collapse:collapse;margin:10px 0;font-size:12px}
.md th,.md td{padding:6px 9px;border:1px solid var(--line);text-align:left}
.md th{background:#f9fafb;font-weight:600;font-family:var(--mono);font-size:11px}
.md blockquote{border-left:3px solid #b8e6d2;background:var(--accent-bg);padding:8px 14px;margin:10px 0;color:var(--sub)}
.md a{color:var(--accent-2)}
.warn{border:1px solid #fde68a;background:#fffbeb;color:#92400e;border-radius:8px;padding:8px 12px;font-size:12px;margin:10px 0}
.note{color:var(--faint);font-size:11px;margin-top:14px;line-height:1.7}
.backtop{position:fixed;right:18px;bottom:18px;width:40px;height:40px;border-radius:50%;border:1px solid var(--line);background:#fff;color:var(--sub);font-size:16px;cursor:pointer;box-shadow:0 2px 8px rgba(28,25,23,.1);display:none;z-index:50}
.backtop.show{display:block}
@media print{.backtop{display:none}}
</style></head><body><div class="page" id="top">

<div class="rpt-head">
  <div class="rpt-eyebrow">TargetEval · High-Throughput Master Report</div>
  <h1 class="rpt-title">${esc(input.title)}</h1>
  <div class="rpt-subtitle">高通量评估汇总报告 — 统计看板 · 全靶点结论总表（靶点 / UniProt / 序列分列 · X-ray/Cryo-EM/NMR 分列单独排序 · 「完整报告」弹出与下载版完全一致的单靶点报告）· AI 整体可行性分析，页宽随浏览器自适应 · 单文件离线自包含</div>
  <div class="meta-grid">
    <div><b>生成时间</b> ${esc(input.generatedAt)}</div>
    ${input.durationSec ? `<div><b>运行时长</b> ${Math.round(input.durationSec / 60)} 分钟</div>` : ''}
    <div><b>评估引擎</b> ${esc(engineSummary)}</div>
    <div><b>靶点规模</b> ${stats.totalTargets} 个（成功 ${stats.loadedTargets}${stats.failedTargets ? ` · 失败 ${stats.failedTargets}` : ''}）</div>
  </div>
</div>

${recoveredCount > 0 ? `<div class="warn" style="margin:-14px 0 22px">数据恢复说明：${recoveredCount} 个靶点的统计数据来自浏览器本地缓存快照恢复（服务端作业已过期或实例回收）。这些靶点的评分、计数与结论完整可用，评估正文经「完整报告」弹出页提供；但在线/离线报告链接不可用（服务器无报告文件）。其余 ${rows.length - recoveredCount} 个靶点数据完整来自服务器。</div>` : ''}

${input.goal ? `<div class="meta-grid" style="margin-bottom:26px"><div style="grid-column:1/-1"><b>客户目标</b> ${esc(input.goal.slice(0, 300))}</div></div>` : ''}

<h2 class="sec"><span class="k">01</span>批次统计速览</h2>
<div class="glance">
  <div class="glance-kicker">At a Glance · 批次画像</div>
  <div class="glance-tiles">
    ${tile('参与靶点', `${stats.totalTargets}`, `${stats.loadedTargets} 成功${stats.failedTargets ? ` · ${stats.failedTargets} 失败` : ''}`)}
    ${tile('总体均分', `${stats.overallMean}<span class="u">/10</span>`, `中位 ${stats.overallMedian} · 区间 ${stats.overallMin}-${stats.overallMax}`)}
    ${tile('建议推进', `${stats.verdictCounts.go}`, `谨慎 ${stats.verdictCounts.caution} · 不建议 ${stats.verdictCounts.no}`)}
    ${tile('有结构靶点', `${stats.targetsWithStructures}/${stats.loadedTargets}`, `X-ray ${stats.targetsWithXray} · Cryo-EM ${stats.targetsWithCryoem} · NMR ${stats.targetsWithNmr}`)}
    ${tile('平均覆盖率', `${Math.round(stats.coverageMean)}%`, `≥50%：${stats.targetsCoverage50} 个 · 带区间 ${stats.rangeTargets} 个`)}
    ${tile('带配体证据', `${stats.targetsWithLigand}`, `PDB 复合物内配体`)}
  </div>
</div>

<div class="panel" style="margin-bottom:12px">
  <div class="mb-cap" style="margin-bottom:6px"><b style="font-size:12.5px">总分分布（0-10，十档）</b></div>
  ${distBar(stats.overallBuckets, stats.loadedTargets)}
</div>
<div class="panel">
  ${methodBar('X-ray 射线晶体学', stats.methodMeans.xray, stats.targetsWithXray, stats.loadedTargets, '#0d9488')}
  ${methodBar('Cryo-EM 冷冻电镜', stats.methodMeans.cryoem, stats.targetsWithCryoem, stats.loadedTargets, '#7c3aed')}
  ${methodBar('NMR 核磁共振', stats.methodMeans.nmr, stats.targetsWithNmr, stats.loadedTargets, '#d97706')}
</div>

${!llmOk && llmErrors.length ? `<div class="warn">AI 报告提示：${llmErrors.map(esc).join('；')}</div>` : ''}

<h2 class="sec"><span class="k">02</span>全靶点结论总表<span style="font-size:12px;color:var(--faint);font-weight:400;margin-left:10px">靶点名称 / UniProt / 序列三列分列 · 总分与 X-ray / Cryo-EM / NMR 评分分列（列头点击各自排序）· 回补 UniProt 徽标可点开 · 「完整报告」弹出与下载的单独报告完全一致</span></h2>
<div class="mt-tools no-print">
  <input type="search" id="mt-q" placeholder="搜索靶点 / UniProt / 蛋白名 / 原表内容…" aria-label="筛选搜索">
  <label>结论
    <select id="mt-verdict"><option value="all">全部</option><option value="go">建议推进</option><option value="caution">谨慎推进</option><option value="no">不建议</option></select>
  </label>
  <label>总分 ≥
    <select id="mt-min"><option value="0">0</option><option value="5">5</option><option value="6">6</option><option value="7">7</option><option value="8">8</option></select>
  </label>
  <span class="mt-count" id="mt-count"></span>
</div>
<div class="tblwrap">
<table class="mt" id="mt-table">
<thead><tr>
<th>#</th>
<th data-k="label" title="原始表靶点名称（含蛋白名 / 种属 / 原表行快照）">靶点（原始表名称）</th>
<th class="sortable num" data-k="uniprot" title="UniProt ID（回补的以徽标展示）— 点击排序">UniProt<span class="arr"></span></th>
<th title="提交序列（一键复制全文 — 原表内容列为折叠快照）">序列</th>
<th class="sortable num" data-k="overall" title="综合可行性总分 — 点击排序">总分<span class="arr"></span></th>
<th class="sortable num" data-k="xray" title="X-ray 方法评分 — 点击单独排序">X-ray<span class="arr"></span></th>
<th class="sortable num" data-k="cryoem" title="Cryo-EM 方法评分 — 点击单独排序">Cryo-EM<span class="arr"></span></th>
<th class="sortable num" data-k="nmr" title="NMR 方法评分 — 点击单独排序">NMR<span class="arr"></span></th>
<th class="sortable num" data-k="pdb" title="直接结构数（+ 同源命中）— 点击排序">结构<span class="arr"></span></th>
<th class="sortable num" data-k="cov" title="序列覆盖率 — 点击排序">覆盖<span class="arr"></span></th>
<th data-k="verdict">结论（一句话能否做）</th>
<th data-k="act">报告</th>
</tr></thead>
<tbody>${rowPairs || '<tr><td colspan="12" style="padding:16px;color:var(--faint)">无成功靶点</td></tr>'}</tbody>
</table>
</div>
<div class="note">「完整报告 ↗」新标签页弹出该靶点的完整评估报告 — 服务器数据保留期内的靶点弹出<b>报告文件原文（与「在线/离线包」下载的单独报告完全一致，含全部图表与脚本）</b>；缓存恢复的靶点（服务端文件已回收）弹出由 markdown 与统计数据重建的页面。「离线包」链接在「批量下载全部」的 zip 解压后可用（本报告随 zip 一并打包，命名与链接一致）；「在线」链接在服务器数据保留期内可用。UniProt 列回补的 ID 以徽标展示（标注识别来源）；序列列「复制」一键复制该靶点的完整提交序列（原始表名称列内的原表行快照已折叠序列，只保留识别前缀）。</div>

<h2 class="sec"><span class="k">03</span>AI 整体可行性报告</h2>
<div class="panel md">${body}</div>
<div class="note">统计与每靶点结论为确定性数据（不依赖 AI）；AI 章节为 LLM 基于上述数据的分析，生成失败时保留统计结论。</div>

<button type="button" class="backtop no-print" id="backtop" aria-label="回到顶部" title="回到顶部">↑</button>
</div>

${rptPayload ? embedJsonScript('ht-rpt-data', rptPayload) : ''}
${Object.keys(seqByJob).length ? embedJsonScript('ht-seq-data', seqByJob) : ''}

<script>
(function(){
  var rows = [].slice.call(document.querySelectorAll('tr.mt-row'));
  var state = { key: 'overall', dir: -1 };
  var q = document.getElementById('mt-q');
  var selV = document.getElementById('mt-verdict');
  var selMin = document.getElementById('mt-min');
  var countEl = document.getElementById('mt-count');
  function visible(r){
    if (selV.value !== 'all' && r.getAttribute('data-verdict') !== selV.value) return false;
    if (parseInt(r.getAttribute('data-overall') || '0', 10) < parseInt(selMin.value, 10)) return false;
    var s = (q.value || '').trim().toLowerCase();
    if (s && (r.getAttribute('data-search') || '').indexOf(s) < 0) return false;
    return true;
  }
  function apply(){
    var n = 0, idx = 0;
    rows.forEach(function(r){
      var ok = visible(r);
      r.style.display = ok ? '' : 'none';
      if (ok) { n++; var t = r.querySelector('.td-idx'); if (t) t.textContent = ++idx; }
    });
    countEl.textContent = '显示 ' + n + ' / ' + rows.length + ' 个靶点';
  }
  function sort(){
    var k = state.key, d = state.dir;
    var tbody = document.querySelector('#mt-table tbody');
    var items = rows.map(function(r){
      var v = parseFloat(r.getAttribute('data-' + k) || '0');
      return { r: r, v: isNaN(v) ? 0 : v, t: (r.querySelector('.td-target') || r).textContent || '', u: r.getAttribute('data-uniprot') || '' };
    });
    items.sort(function(a, b){
      var c = k === 'label' ? a.t.localeCompare(b.t, 'zh') : k === 'uniprot' ? (a.u < b.u ? -1 : a.u > b.u ? 1 : 0) : (a.v - b.v);
      if (c === 0) c = a.r === b.r ? 0 : 1;
      return c * d;
    });
    items.forEach(function(it){ tbody.appendChild(it.r); });
  }
  document.querySelectorAll('#mt-table th.sortable').forEach(function(th){
    th.addEventListener('click', function(){
      var k = th.getAttribute('data-k');
      if (state.key === k) state.dir = -state.dir; else { state.key = k; state.dir = (k === 'label' || k === 'uniprot') ? 1 : -1; }
      document.querySelectorAll('#mt-table th .arr').forEach(function(a){ a.textContent = ''; });
      var arr = th.querySelector('.arr'); if (arr) arr.textContent = state.dir > 0 ? '▲' : '▼';
      sort(); apply();
    });
  });
  q.addEventListener('input', apply);
  selV.addEventListener('change', apply);
  selMin.addEventListener('change', apply);

  // v2.63 单靶点完整报告 — 全部单独报告内嵌为数据（ht-rpt-data）；服务器保留期内的
  // 靶点为报告文件原文（与下载的单独报告完全一致），直接 Blob 新标签弹出；
  // 缓存恢复/文件丢失的靶点由 markdown + 统计数据拼装重建页（共享样式 c）
  var rptEl = document.getElementById('ht-rpt-data');
  var RP = null;
  try { RP = JSON.parse(rptEl ? rptEl.textContent : 'null'); } catch (e) {}
  function rptPageInit(){
    function copyText(t, btn){
      var done = function(){
        var old = btn.getAttribute('data-label') || btn.textContent;
        btn.setAttribute('data-label', old);
        btn.textContent = '已复制 ✓';
        btn.classList.add('ok');
        setTimeout(function(){ btn.textContent = old; btn.classList.remove('ok'); }, 1600);
      };
      var fallback = function(){
        try {
          var ta = document.createElement('textarea');
          ta.value = t;
          ta.style.position = 'fixed'; ta.style.opacity = '0';
          document.body.appendChild(ta); ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
          done();
        } catch (e) {}
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(t).then(done, fallback);
      } else fallback();
    }
    document.querySelectorAll('button.seq-copy').forEach(function(b){
      b.addEventListener('click', function(){
        var box = b.closest ? b.closest('.seqbox') : null;
        var pre = box ? box.querySelector('.seq-pre') : null;
        if (pre) copyText(pre.textContent, b);
      });
    });
    var bt = document.getElementById('backtop');
    if (bt) {
      window.addEventListener('scroll', function(){ bt.classList.toggle('show', window.scrollY > 600); }, { passive: true });
      bt.addEventListener('click', function(){ window.scrollTo({ top: 0, behavior: 'smooth' }); });
    }
  }
  var RPT_JS = '<scr' + 'ipt>(' + rptPageInit.toString() + ')();</scr' + 'ipt>';
  var rptUrl = null;
  function openReport(i){
    if (!RP || !RP.r || !RP.r[i]) return;
    var r = RP.r[i];
    try {
      var html;
      if (typeof r.html === 'string' && r.html) {
        // v2.63：报告文件原文 — 与下载的单独报告完全一致（含全部图表与脚本）
        html = r.html;
      } else {
        // 重建页（服务端报告文件不可用/缓存恢复 — markdown + 统计数据拼装）
        html = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
          + '<title>' + r.tt + '</title><style>' + (RP.c || '') + '</style></head><body><div class="page" id="top">'
          + '<div class="rpt-head"><div class="rpt-eyebrow">TargetEval · Target Full Report</div>'
          + '<h1 class="rpt-title">' + r.h + '</h1>'
          + '<div class="rpt-subtitle">单靶点完整评估报告（重建页）— 服务端报告文件不可用，由缓存数据重建 · 离线自包含</div>'
          + '<div class="meta-grid"><div><b>生成时间</b> ' + RP.g + '</div><div><b>母报告</b> ' + RP.m + '</div><div><b>评估引擎</b> ' + RP.e + '</div>' + (r.j ? '<div><b>作业 ID</b> <span class="mono">' + r.j + '</span></div>' : '') + '</div></div>'
          + r.a
          + '<div class="note">本页为重建页（服务端报告文件已回收 — 原文报告不可内嵌时由缓存 markdown 与统计数据拼装）。序列块为该靶点的完整提交序列（一键复制）。</div>'
          + '<button type="button" class="backtop no-print" id="backtop" aria-label="回到顶部" title="回到顶部">↑</button>'
          + '</div>' + RPT_JS + '</body></html>';
      }
      var blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      if (rptUrl) { try { URL.revokeObjectURL(rptUrl); } catch (e) {} }
      rptUrl = URL.createObjectURL(blob);
      var w = window.open(rptUrl, '_blank');
      if (!w) window.alert('浏览器拦截了新标签页 — 请允许本页弹出窗口后重试。');
    } catch (e) {
      window.alert('打开完整报告失败：' + (e && e.message ? e.message : e));
    }
  }
  document.querySelectorAll('button.mt-open').forEach(function(b){
    b.addEventListener('click', function(){
      var i = parseInt(b.getAttribute('data-i'), 10);
      if (!isNaN(i)) openReport(i);
    });
  });

  // v2.61 序列一键复制（jobId → 全文 — 原表内容列为折叠快照，复制的是完整提交序列）
  var seqEl = document.getElementById('ht-seq-data');
  var seqs = null;
  try { seqs = JSON.parse(seqEl ? seqEl.textContent : 'null'); } catch (e) {}
  function copyText(t, btn){
    var done = function(){
      var old = btn.getAttribute('data-label') || btn.textContent;
      btn.setAttribute('data-label', old);
      btn.textContent = '已复制 ✓';
      btn.classList.add('ok');
      setTimeout(function(){ btn.textContent = old; btn.classList.remove('ok'); }, 1600);
    };
    var fallback = function(){
      try {
        var ta = document.createElement('textarea');
        ta.value = t;
        ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        done();
      } catch (e) {}
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(done, fallback);
    } else fallback();
  }
  document.querySelectorAll('button.seq-copy').forEach(function(b){
    b.addEventListener('click', function(){
      var s = seqs ? seqs[b.getAttribute('data-job')] : '';
      if (s) copyText(s, b);
    });
  });

  var bt = document.getElementById('backtop');
  window.addEventListener('scroll', function(){ bt.classList.toggle('show', window.scrollY > 600); }, { passive: true });
  bt.addEventListener('click', function(){ window.scrollTo({ top: 0, behavior: 'smooth' }); });
  apply();
})();
</script>
</body></html>`
}

/** 看板标题（运行时间 + 靶点规模） */
export function htDashboardTitle(totalTargets: number, generatedAt: string): string {
  return `高通量评估汇总报告 · ${totalTargets} 靶点 · ${generatedAt.slice(0, 10)}`
}
