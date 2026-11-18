/**
 * 高通量运行统计看板（v2.28）— 一次运行完成后的评分统计 + AI 整体可行性报告。
 *
 * 用户需求：高通量评估完成后自动生成 ① 评分统计 dashboard ② AI 整体可行性统计
 * 报告 — 以离线 HTML 自动下载，并链接到所有单独报告；每个靶点给一句话结论
 * （能否做）。
 *
 * 组成：
 *  - loadHtDashboardRows：从 DB 加载各已完成作业的摘要行（评分/计数/区间/结论素材）
 *  - computeHtStats：批次统计（分数分布、方法可用性、覆盖率、推进档位计数）
 *  - ruleVerdict：确定性一句话结论（评分 + 结构证据；LLM 失败/超限时的兜底）
 *  - generateHtDashboardReport：LLM 整体可行性报告（失败静默降级 — 看板仍渲染
 *    统计与规则结论）+ LLM 每靶点一句话结论（≤40 靶点时尝试，校验失败回退规则）
 *  - renderHtDashboardHtml：自包含离线 HTML（内联 CSS/SVG，无外链资源）—
 *    统计卡 + 分数分布图 + 方法分布 + 每靶点结论表（链接：zip 相对路径 +
 *    在线绝对路径）+ AI 报告正文
 *
 * 离线链接语义：zip 相对路径与 ht-archive 打包命名同源（planArchiveNames 共享
 * 规划器）— 「批量下载全部」zip 解压后，看板内 G01/xxx.html 链接直接可点。
 */
import { db } from '@/lib/db'
import { llmChat } from './llm'
import { getEngineSummary } from './llm-provider'
import { renderMarkdown } from './report-html'
import { planArchiveNames, type ArchivePlanItem } from './ht-archive-names'
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

/** 从 DB 加载统计行（不校验归属 — 路由层负责） */
export async function loadHtDashboardRows(entries: HtDashboardEntry[]): Promise<{ rows: HtDashboardRow[]; jobCount: number }> {
  const rows: HtDashboardRow[] = []
  let jobCount = 0
  for (const entry of entries) {
    if (!entry.jobId) continue
    jobCount++
    const job = await db.evaluationJob.findUnique({ where: { id: entry.jobId } })
    if (!job || job.status !== 'done') continue
    let summary: Record<string, unknown> | null = null
    try { summary = job.summary ? JSON.parse(job.summary) : null } catch { /* ignore */ }
    if (!summary) continue
    const uni = (summary.uniprot ?? {}) as Record<string, unknown>
    const scores = (summary.scores ?? {}) as Record<string, Record<string, unknown> & { score?: number }>
    const methodStats = (summary.methodStats ?? {}) as Record<string, unknown>
    const range = summary.range as [number, number] | undefined
    let pdbs: PdbEntry[] = []
    let blastHits: BlastHit[] = []
    try { pdbs = job.pdbs ? JSON.parse(job.pdbs) : [] } catch { /* ignore */ }
    try { blastHits = job.blastHits ? JSON.parse(job.blastHits) : [] } catch { /* ignore */ }
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
    rows.push({
      jobId: job.id,
      label: (entry.label || job.uniprotId || job.title || job.id).slice(0, 60),
      uniprotId: job.uniprotId ?? undefined,
      proteinName: String(uni.proteinName || job.uniprotId || entry.label || '未知靶点').slice(0, 80)
        // v2.31：聚合蛋白截短追加 nsp 标注（同名靶点行可区分 — 如 P0DTD1 的不同 nsp 构建）
        + (uni.nspLabel ? ` ${String(uni.nspLabel).slice(0, 24)}` : ''),
      organism: String(uni.organism ?? ''),
      range: Array.isArray(range) && range.length === 2 && range[0] >= 1 && range[1] >= range[0] ? [range[0], range[1]] : undefined,
      overall: num(scores.overall?.score),
      xray: num(scores.xray?.score),
      cryoem: num(scores.cryoem?.score),
      nmr: num(scores.nmr?.score),
      directPdbCount: pdbs.length,
      blastHitCount: blastHits.length,
      coverage: num(summary.coverage),
      methodXrayCount: num(methodStats.xrayCount),
      methodCryoemCount: num(methodStats.cryoemCount),
      methodNmrCount: num(methodStats.nmrCount),
      bestResolution: typeof methodStats.bestResolution === 'number' ? methodStats.bestResolution : null,
      ligandCount: num(summary.ligandCount),
      literatureCount: num(summary.literatureCount),
      reportLlmOk: summary.reportLlmOk === true,
      durationMs: num(summary.durationMs),
      hasReport: Boolean(job.reportPath),
    })
  }
  return { rows, jobCount }
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

// ─── HTML 渲染（自包含离线）──────────────────────────────────────────────────

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const VERDICT_META: Record<HtVerdict['verdict'], { label: string; color: string; bg: string }> = {
  go: { label: '建议推进', color: '#0f766e', bg: '#ccfbf1' },
  caution: { label: '谨慎推进', color: '#a16207', bg: '#fef3c7' },
  no: { label: '不建议', color: '#b91c1c', bg: '#fee2e2' },
}

function scoreBadge(v: number): string {
  const color = v >= 7 ? '#0f766e' : v >= 5 ? '#a16207' : '#b91c1c'
  return `<span style="display:inline-block;min-width:34px;text-align:center;border-radius:6px;padding:1px 6px;font-size:12px;font-weight:700;color:${color};background:${v >= 7 ? '#ccfbf1' : v >= 5 ? '#fef3c7' : '#fee2e2'}">${v}</span>`
}

function distBar(buckets: number[], total: number): string {
  const max = Math.max(1, ...buckets)
  return `<div style="display:flex;align-items:flex-end;gap:4px;height:88px">${buckets.map((c, i) => {
    const h = total > 0 ? Math.max(c > 0 ? 6 : 2, Math.round((c / max) * 84)) : 2
    const color = i >= 7 ? '#0d9488' : i >= 5 ? '#d97706' : '#dc2626'
    return `<div style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:2px" title="${i}-${i + 1} 分：${c} 个"><span style="font-size:9px;color:#6b7280">${c || ''}</span><div style="width:100%;border-radius:3px 3px 0 0;background:${color};height:${h}px"></div><span style="font-size:8.5px;color:#9ca3af">${i}</span></div>`
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
}

export function renderHtDashboardHtml(input: RenderHtDashboardInput): string {
  const { rows, stats, verdicts, markdown, llmOk, llmErrors, engineSummary, origin } = input
  const verdictByJob = new Map(verdicts.map(v => [v.jobId, v]))
  const sorted = [...rows].sort((a, b) => b.overall - a.overall)

  const card = (label: string, value: string, sub = ''): string =>
    `<div style="flex:1;min-width:150px;border:1px solid #e5e7eb;border-radius:10px;padding:10px 14px;background:#fff">
      <div style="font-size:11px;color:#6b7280;letter-spacing:.4px">${label}</div>
      <div style="font-size:22px;font-weight:700;color:#111827;margin-top:2px">${value}</div>
      ${sub ? `<div style="font-size:10.5px;color:#9ca3af;margin-top:1px">${sub}</div>` : ''}
    </div>`

  const rowHtml = sorted.map(r => {
    const v = verdictByJob.get(r.jobId) ?? ruleVerdict(r)
    const meta = VERDICT_META[v.verdict]
    return `<tr>
      <td style="padding:7px 8px;font-size:12px;color:#374151;white-space:nowrap">${esc(r.label)}${r.range ? `<div style="font-size:10px;color:#0d9488">残基 ${r.range[0]}-${r.range[1]}</div>` : ''}${r.uniprotId && r.label !== r.uniprotId ? `<div style="font-size:10px;color:#9ca3af">${esc(r.uniprotId)}</div>` : ''}</td>
      <td style="padding:7px 8px;text-align:center">${scoreBadge(r.overall)}</td>
      <td style="padding:7px 8px;text-align:center;font-size:11.5px;color:#374151;white-space:nowrap">${r.xray} · ${r.cryoem} · ${r.nmr}</td>
      <td style="padding:7px 8px;text-align:center;font-size:11.5px;color:#374151;white-space:nowrap">${r.directPdbCount}${r.blastHitCount ? `<span style="color:#9ca3af"> +${r.blastHitCount}</span>` : ''}${r.bestResolution != null ? `<div style="font-size:10px;color:#9ca3af">${r.bestResolution}Å</div>` : ''}</td>
      <td style="padding:7px 8px;text-align:center;font-size:11.5px;color:#374151">${Math.round(r.coverage)}%</td>
      <td style="padding:7px 8px;font-size:11.5px;line-height:1.5;color:#111827"><span style="display:inline-block;border-radius:5px;padding:1px 7px;font-size:10.5px;font-weight:700;color:${meta.color};background:${meta.bg};margin-right:5px">${meta.label}</span>${esc(v.line)}${v.source === 'rule' ? `<span style="color:#9ca3af;font-size:9.5px">（规则推断）</span>` : ''}</td>
      <td style="padding:7px 8px;font-size:11px;white-space:nowrap">
        ${r.zipHref ? `<a href="${esc(r.zipHref)}" style="color:#0d9488;font-weight:600;text-decoration:none">离线包</a>` : ''}
        ${r.hasReport && origin ? `${r.zipHref ? ' · ' : ''}<a href="${esc(origin)}/api/jobs/${esc(r.jobId)}/report?download=1" style="color:#6b7280;text-decoration:none">在线</a>` : ''}
      </td>
    </tr>`
  }).join('')

  const methodBar = (label: string, mean: number, count: number, total: number, color: string): string =>
    `<div style="margin-bottom:7px"><div style="display:flex;justify-content:space-between;font-size:11px;color:#374151;margin-bottom:2px"><span>${label}</span><span style="color:#6b7280">均分 ${mean}/10 · ${count}/${total} 靶点有结构</span></div><div style="height:9px;border-radius:5px;background:#f3f4f6"><div style="height:9px;border-radius:5px;background:${color};width:${Math.round(mean * 10)}%"></div></div></div>`

  const body = renderMarkdown(markdown || '（AI 整体可行性报告未生成 — 见上方提示；统计与每靶点结论不受影响）', 0)

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(input.title)}</title>
<style>
body{font-family:-apple-system,'Noto Sans SC','PingFang SC','Microsoft YaHei',sans-serif;margin:0;background:#f6f7f9;color:#111827}
.wrap{max-width:1080px;margin:0 auto;padding:28px 20px 60px}
h1{font-size:21px;margin:0 0 4px} .sub{color:#6b7280;font-size:12px;margin-bottom:18px}
.cards{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:16px}
h2{font-size:15px;margin:26px 0 8px;border-left:4px solid #0d9488;padding-left:9px}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;font-size:12px}
th{background:#f9fafb;color:#6b7280;font-weight:600;font-size:11px;padding:7px 8px;text-align:left;border-bottom:1px solid #e5e7eb}
td{border-bottom:1px solid #f3f4f6}
.panel{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px}
.md{font-size:13px;line-height:1.75}.md h2{margin-top:20px}.md table{margin:10px 0}.md th,.md td{padding:6px 8px}
.md p{margin:8px 0}.md ul,.md ol{margin:8px 0;padding-left:22px}.md code{background:#f3f4f6;border-radius:4px;padding:1px 5px;font-size:11.5px}
.warn{border:1px solid #fde68a;background:#fffbeb;color:#92400e;border-radius:8px;padding:8px 12px;font-size:12px;margin:10px 0}
.note{color:#9ca3af;font-size:11px;margin-top:14px;line-height:1.6}
a{color:#0d9488}
</style></head><body><div class="wrap">
<h1>${esc(input.title)}</h1>
<div class="sub">高通量运行统计看板 · AI 整体可行性报告 · 生成于 ${esc(input.generatedAt)}${input.durationSec ? ` · 运行时长 ${Math.round(input.durationSec / 60)} 分钟` : ''}${engineSummary !== '—' ? ` · 引擎 ${esc(engineSummary)}` : ''}</div>
${input.goal ? `<div class="sub">客户目标：${esc(input.goal.slice(0, 300))}</div>` : ''}

<div class="cards">
${card('参与靶点', `${stats.totalTargets}`, `${stats.loadedTargets} 成功${stats.failedTargets ? ` · ${stats.failedTargets} 失败` : ''}`)}
${card('总体均分', `${stats.overallMean}<span style="font-size:13px;color:#6b7280">/10</span>`, `中位 ${stats.overallMedian} · 区间 ${stats.overallMin}-${stats.overallMax}`)}
${card('建议推进', `${stats.verdictCounts.go}`, `谨慎 ${stats.verdictCounts.caution} · 不建议 ${stats.verdictCounts.no}`)}
${card('有结构靶点', `${stats.targetsWithStructures}/${stats.loadedTargets}`, `X-ray ${stats.targetsWithXray} · Cryo-EM ${stats.targetsWithCryoem} · NMR ${stats.targetsWithNmr}`)}
${card('平均覆盖率', `${Math.round(stats.coverageMean)}%`, `≥50%：${stats.targetsCoverage50} 个 · 带区间 ${stats.rangeTargets} 个`)}
</div>

<h2>总分分布（0-10）</h2>
<div class="panel">${distBar(stats.overallBuckets, stats.loadedTargets)}</div>

<h2>方法可用性（均分 + 有结构靶点数）</h2>
<div class="panel">
${methodBar('X-ray 射线晶体学', stats.methodMeans.xray, stats.targetsWithXray, stats.loadedTargets, '#0d9488')}
${methodBar('Cryo-EM 冷冻电镜', stats.methodMeans.cryoem, stats.targetsWithCryoem, stats.loadedTargets, '#7c3aed')}
${methodBar('NMR 核磁共振', stats.methodMeans.nmr, stats.targetsWithNmr, stats.loadedTargets, '#d97706')}
</div>

${!llmOk && llmErrors.length ? `<div class="warn">AI 报告提示：${llmErrors.map(esc).join('；')}</div>` : ''}

<h2>每靶点结论（按总分降序 · 一句话能否做）</h2>
<table><thead><tr><th>靶点</th><th style="text-align:center">总分</th><th style="text-align:center">X·C·N</th><th style="text-align:center">结构</th><th style="text-align:center">覆盖</th><th>一句话结论</th><th>单独报告</th></tr></thead>
<tbody>${rowHtml || '<tr><td colspan="7" style="padding:14px;color:#9ca3af">无成功靶点</td></tr>'}</tbody></table>
<div class="note">「离线包」链接在「批量下载全部」的 zip 解压后可用（看板随 zip 一并打包，命名与链接一致）；「在线」链接在服务器数据保留期内可用。</div>

<h2>AI 整体可行性报告</h2>
<div class="panel md">${body}</div>
<div class="note">统计与每靶点结论为确定性数据（不依赖 AI）；AI 章节为 LLM 基于上述数据的分析，生成失败时保留统计结论。</div>
</div></body></html>`
}

/** 看板标题（运行时间 + 靶点规模） */
export function htDashboardTitle(totalTargets: number, generatedAt: string): string {
  return `高通量评估统计看板 · ${totalTargets} 靶点 · ${generatedAt.slice(0, 10)}`
}
