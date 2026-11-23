/**
 * POST /api/evaluate/ht-dashboard — 高通量运行统计看板生成（v2.28）。
 *
 * 输入：{ entries: [{jobId, group?, label?, mergedId?}], goal?, llm? } —
 * entries 与「批量下载全部」zip 归档同一份结构（mergedId 条目仅参与 zip 相对
 * 链接命名规划，保证看板内 G01/xxx.html 与解压后文件对得上）。
 * 校验（400）：entries 空 / 全部非 jobId+mergedId / 无已完成作业。
 * 归属校验：全部作业须为本人创建（403/404）。
 * 异步生成（对齐 batch-report 模式）：立即落库 running 返回 id，后台加载各作业
 * 摘要 → 批次统计 → 每靶点一句话结论（LLM + 规则兜底）→ AI 整体可行性报告 →
 * 自包含离线 HTML 落盘 → 终态 done/error。LLM 失败不阻塞（统计与规则结论仍渲染）。
 *
 * GET /api/evaluate/ht-dashboard?id=xxx — JSON 状态（前端轮询）
 * GET ?id=xxx&inline=1 — HTML 预览（iframe/新窗口）
 * GET ?id=xxx&download=1 — 下载 HTML 看板文件（前端自动落盘复用此通道）
 */
import { NextResponse } from 'next/server'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { db } from '@/lib/db'
import { getOwner, isOwnedBy, notFound } from '@/lib/eval/request-guard'
import { reportNotFoundResponse } from '@/lib/eval/report-not-found'
import { runWithLlmOverride, sanitizeLlmOverride, getEngineSummary } from '@/lib/eval/llm-provider'
import type { HtDashboard } from '@prisma/client'
import {
  loadHtDashboardRows,
  buildImportedBareRows,
  computeHtStats,
  generateHtDashboardReport,
  renderHtDashboardHtml,
  resolveZipHrefs,
  htDashboardTitle,
  attachExcelRows,
  type ArchivedJobSnapshot,
  type HtDashboardEntry,
  type HtImportedTarget,
} from '@/lib/eval/ht-dashboard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 600

interface DashboardBody {
  entries?: unknown
  goal?: string
  /** v2.36：原始 Excel 行快照（汇总报告「原表内容」列；v2.68 seqs = 行内序列格原文） */
  excelRows?: Array<{ label?: unknown; text?: unknown; seqs?: unknown }>
  /** v2.68：导入既有报告但无作业标记的靶点（降级「载入」行） */
  imported?: unknown
  /** v2.68：entries 中来自导入报告的原作业 id（行标「载入」徽标） */
  importedJobIds?: unknown
  /** v2.61：各靶点提交序列（jobId → 全文 — 汇总表「复制序列」按钮 + 单靶点完整报告弹出页展示） */
  sequences?: Array<{ jobId?: unknown; sequence?: unknown }>
  llm?: { providerKey?: string; baseUrl?: string; apiKey?: string; model?: string }
  /** v2.60：浏览器本地缓存恢复的作业快照（服务端作业已过期时恢复统计行） */
  archived?: unknown
  /** v2.60：允许部分生成（仍缺失的靶点计入 dropped 跳过，不整单失败） */
  allowPartial?: boolean
}

/** v2.60：archived 快照消毒（≤600 条；summary 必须是非空对象且含 scores 对象 —
 *  与 DB EvaluationJob.summary JSON 同构；正文 ≤30 万字符防负载膨胀） */
function sanitizeArchived(v: unknown): Map<string, ArchivedJobSnapshot> {
  const out = new Map<string, ArchivedJobSnapshot>()
  if (!Array.isArray(v)) return out
  for (const e of v) {
    if (!e || typeof e !== 'object' || out.size >= 600) continue
    const o = e as { jobId?: unknown; uniprotId?: unknown; title?: unknown; summary?: unknown; pdbCount?: unknown; blastHitCount?: unknown; reportMarkdown?: unknown }
    const jobId = typeof o.jobId === 'string' ? o.jobId.trim() : ''
    if (!/^[a-z0-9]{20,40}$/i.test(jobId) || out.has(jobId)) continue
    if (!o.summary || typeof o.summary !== 'object' || Array.isArray(o.summary)) continue
    const summary = o.summary as Record<string, unknown>
    if (!summary.scores || typeof summary.scores !== 'object' || Array.isArray(summary.scores)) continue
    const int = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.min(Math.round(x), 1_000_000) : 0)
    out.set(jobId, {
      jobId,
      uniprotId: typeof o.uniprotId === 'string' ? o.uniprotId.trim().slice(0, 60) || undefined : undefined,
      title: typeof o.title === 'string' ? o.title.trim().slice(0, 120) || undefined : undefined,
      summary,
      pdbCount: int(o.pdbCount),
      blastHitCount: int(o.blastHitCount),
      reportMarkdown: typeof o.reportMarkdown === 'string' && o.reportMarkdown.trim() ? o.reportMarkdown.slice(0, 300_000) : undefined,
    })
  }
  return out
}

/** excelRows 消毒：{label, text, seqs?} 形态（≤600 行；每字段截断）。
 *  v2.68 seqs：行内序列格原文（与 text 中 [序列 N aa] 标记按序对应 — 主表复制按钮；
 *  氨基酸字符集清洗、单条 ≤50K、总预算 400K 防载荷膨胀，超出丢弃余下序列） */
function sanitizeExcelRows(v: unknown): Array<{ label: string; text: string; seqs?: string[] }> {
  if (!Array.isArray(v)) return []
  const out: Array<{ label: string; text: string; seqs?: string[] }> = []
  let seqBudget = 400_000
  for (const e of v) {
    if (!e || typeof e !== 'object' || out.length >= 600) continue
    const o = e as { label?: unknown; text?: unknown; seqs?: unknown }
    const label = typeof o.label === 'string' ? o.label.trim().slice(0, 60) : ''
    const text = typeof o.text === 'string' ? o.text.trim().slice(0, 400) : ''
    if (!label && !text) continue
    const seqs: string[] = []
    if (Array.isArray(o.seqs)) {
      const marks = (text.match(/\[序列 \d+ aa\]/g) ?? []).length
      for (const raw of o.seqs) {
        if (seqs.length >= marks || seqs.length >= 8) break
        if (typeof raw !== 'string') continue
        const seq = raw.replace(/\s+/g, '').replace(/[^ACDEFGHIKLMNPQRSTVWYBXZJUO*-]/gi, '').toUpperCase()
        if (!seq || seq.length > 50_000 || seqBudget < seq.length) continue
        seqs.push(seq)
        seqBudget -= seq.length
      }
    }
    out.push(seqs.length ? { label, text, seqs } : { label, text })
  }
  return out
}

/** v2.68：imported 消毒 — 导入既有报告但无作业标记的靶点（降级「载入」行；
 *  ≤600 条；sequence 氨基酸清洗 ≤50K、总预算 400K；fileName 截断） */
function sanitizeImported(v: unknown): HtImportedTarget[] {
  if (!Array.isArray(v)) return []
  const out: HtImportedTarget[] = []
  let seqBudget = 400_000
  for (const e of v) {
    if (!e || typeof e !== 'object' || out.length >= 600) continue
    const o = e as { label?: unknown; group?: unknown; sequence?: unknown; fileName?: unknown }
    const label = typeof o.label === 'string' ? o.label.trim().slice(0, 60) : ''
    if (!label) continue
    const group = typeof o.group === 'number' && Number.isFinite(o.group) && o.group > 0 && o.group <= 999 ? Math.round(o.group) : undefined
    const fileName = typeof o.fileName === 'string' && o.fileName.trim() ? o.fileName.trim().slice(0, 80) : undefined
    let sequence: string | undefined
    if (typeof o.sequence === 'string') {
      const seq = o.sequence.replace(/\s+/g, '').replace(/[^ACDEFGHIKLMNPQRSTVWYBXZJUO*-]/gi, '').toUpperCase()
      if (seq && seq.length <= 50_000 && seqBudget >= seq.length) {
        sequence = seq
        seqBudget -= seq.length
      }
    }
    out.push(sequence || fileName || group ? { label, ...(group ? { group } : {}), ...(sequence ? { sequence } : {}), ...(fileName ? { fileName } : {}) } : { label })
  }
  return out
}

/** v2.68：importedJobIds 消毒 — entries 中来自导入报告的原作业 id（行标「载入」） */
function sanitizeImportedJobIds(v: unknown): Set<string> {
  const out = new Set<string>()
  if (!Array.isArray(v)) return out
  for (const x of v) {
    if (typeof x === 'string' && /^[a-z0-9]{20,40}$/i.test(x)) out.add(x)
    if (out.size >= 600) break
  }
  return out
}

/** v2.61 sequences 消毒：{jobId, sequence} 形态（≤600 条；序列清洗到氨基酸字符集
 *  — 与 cleanSequence 同口径；单条 ≤50K；总量预算 600K 防载荷膨胀） */
function sanitizeSequences(v: unknown): Map<string, string> {
  const out = new Map<string, string>()
  if (!Array.isArray(v)) return out
  let total = 0
  for (const e of v) {
    if (!e || typeof e !== 'object' || out.size >= 600) continue
    const o = e as { jobId?: unknown; sequence?: unknown }
    const jobId = typeof o.jobId === 'string' ? o.jobId.trim() : ''
    if (!/^[a-z0-9]{20,40}$/i.test(jobId) || out.has(jobId)) continue
    const seq = typeof o.sequence === 'string'
      ? o.sequence.replace(/\s+/g, '').replace(/[^ACDEFGHIKLMNPQRSTVWYBXZJUO*-]/gi, '').toUpperCase()
      : ''
    if (!seq || seq.length > 50_000 || total + seq.length > 600_000) continue
    out.set(jobId, seq)
    total += seq.length
  }
  return out
}

/** entries 消毒：jobId/mergedId 形态 + 组号/标签形态（≤600 条对齐归档上限） */
function sanitizeEntries(v: unknown): HtDashboardEntry[] {
  if (!Array.isArray(v)) return []
  const out: HtDashboardEntry[] = []
  for (const e of v) {
    if (!e || typeof e !== 'object') continue
    const o = e as { jobId?: unknown; mergedId?: unknown; group?: unknown; label?: unknown }
    const jobId = typeof o.jobId === 'string' ? o.jobId.trim() : ''
    const mergedId = typeof o.mergedId === 'string' ? o.mergedId.trim() : ''
    if (!jobId && !mergedId) continue
    if (jobId && !/^[a-z0-9]{20,40}$/i.test(jobId)) continue
    if (mergedId && !/^[a-z0-9]{20,40}$/i.test(mergedId)) continue
    out.push({
      jobId: jobId || undefined,
      mergedId: mergedId || undefined,
      group: typeof o.group === 'number' && Number.isFinite(o.group) && o.group > 0 ? Math.round(o.group) : undefined,
      label: typeof o.label === 'string' ? o.label.trim().slice(0, 60) || undefined : undefined,
    })
    if (out.length >= 600) break
  }
  return out
}

export async function POST(req: Request) {
  const owner = getOwner(req)
  let body: DashboardBody
  try {
    body = (await req.json()) as DashboardBody
  } catch {
    return NextResponse.json({ ok: false, error: '请求体不是合法 JSON' }, { status: 400 })
  }

  const entries = sanitizeEntries(body.entries)
  const jobIds = entries.filter(e => e.jobId).map(e => e.jobId as string)
  if (entries.length === 0) {
    return NextResponse.json({ ok: false, error: '缺少报告条目（entries 为空）' }, { status: 400 })
  }
  if (jobIds.length === 0) {
    return NextResponse.json({ ok: false, error: '条目中没有评估作业（jobId）— 统计看板需要至少 1 个已完成靶点' }, { status: 400 })
  }

  // ── v2.60 归属与存在性校验（不再整单 404「作业不存在」）──
  //  DB 有记录且归属本人 → 正常参与统计；
  //  DB 无记录（实例回收/过期）→ 用前端上传的浏览器缓存快照恢复统计行；
  //  DB 有记录但非本人 → 静默剔除（不泄露存在性，快照也不采信）；
  //  DB 无记录且无快照 → allowPartial 时计入 dropped 跳过，否则 409 让前端
  //  先回本地缓存提取快照重试（两阶段 — 覆盖「运行中途环境重置后续跑」场景）。
  const archivedByJob = sanitizeArchived(body.archived)
  // v2.68：导入报告携带的原作业 id（这些靶点有 importedBare 降级兜底 — DB 过期
  //  时不强制要求快照恢复，不触发 409 两阶段重试）
  const importedJobIdSet = sanitizeImportedJobIds(body.importedJobIds)
  const jobs = await db.evaluationJob.findMany({ where: { id: { in: jobIds } }, select: { id: true, ownerKey: true, ownerMask: true, status: true } })
  const jobById = new Map(jobs.map(j => [j.id, j]))
  // 快照仅用于 DB 无记录的作业（DB 有记录一律以 DB 为准 — 含他人作业不采信快照）
  for (const id of jobById.keys()) archivedByJob.delete(id)
  const ownedIds = new Set<string>()
  for (const j of jobs) {
    if (isOwnedBy(j, owner)) ownedIds.add(j.id)
  }
  const missingIds: string[] = []
  for (const id of new Set(jobIds)) {
    if (!jobById.has(id) && !archivedByJob.has(id) && !importedJobIdSet.has(id)) missingIds.push(id)
  }
  if (missingIds.length > 0 && body.allowPartial !== true) {
    return NextResponse.json({
      ok: false,
      error: `部分靶点作业已不在服务器（${missingIds.length} 个 — 实例回收或超出保留期），可从浏览器本地缓存恢复`,
      missingJobIds: missingIds,
    }, { status: 409 })
  }
  // 采信的条目：本人 DB 作业 / 有快照的缺失作业（mergedId 条目仅参与 zip 链接规划，保留）
  const kept = entries.filter(e => !e.jobId || ownedIds.has(e.jobId) || archivedByJob.has(e.jobId))
  const keptJobIds = kept.filter(e => e.jobId).map(e => e.jobId as string)
  const recoveredCount = keptJobIds.filter(id => !jobById.has(id)).length
  const droppedEntries = entries.filter(e => e.jobId && !ownedIds.has(e.jobId) && !archivedByJob.has(e.jobId))
  const droppedLabels = droppedEntries.map(e => (e.label ?? e.jobId ?? '').slice(0, 40)).filter(Boolean).slice(0, 10)
  // v2.68：纯导入运行（全部靶点载入既有报告）允许无统计作业 — importedBare 降级行仍可生成
  const importedBareSanitized = sanitizeImported(body.imported)
  if (keptJobIds.length === 0 && importedBareSanitized.length === 0) {
    return NextResponse.json({ ok: false, error: '条目中没有可统计的评估作业（均已过期且无本地缓存副本）' }, { status: 400 })
  }
  // 至少 1 个可统计行（本人已完成作业 / 有效快照 — summary 含 scores）；
  // v2.68：纯导入运行（bare 降级行）同样放行
  const ownedDoneCount = jobs.filter(j => ownedIds.has(j.id) && j.status === 'done').length
  if (ownedDoneCount === 0 && recoveredCount === 0 && importedBareSanitized.length === 0) {
    return NextResponse.json({ ok: false, error: '没有已完成的评估作业（统计看板需要至少 1 个成功靶点）' }, { status: 400 })
  }

  const record = await db.htDashboard.create({
    data: {
      jobIds: JSON.stringify(keptJobIds),
      entries: JSON.stringify(kept),
      goal: body.goal?.trim().slice(0, 500) || null,
      ownerKey: owner.key,
      ownerMask: owner.mask,
      status: 'running',
      excelRows: JSON.stringify(sanitizeExcelRows(body.excelRows)),
    },
  })

  // 后台生成（LLM 在用户引擎作用域内；失败静默降级 — 统计/规则结论不受影响）
  const llmOverride = sanitizeLlmOverride(body.llm)
  const excelRows = sanitizeExcelRows(body.excelRows)
  const sequencesByJob = sanitizeSequences(body.sequences)
  // v2.68：导入载入靶点 — bare 行（含 DB 过期兜底）+ entries 内导入作业的「载入」徽标集
  const importedBare = importedBareSanitized
  const importedJobIds = importedJobIdSet
  void runWithLlmOverride(llmOverride, () => runDashboardGeneration({
    dashboardId: record.id,
    entries: kept,
    archivedByJob,
    goal: body.goal?.trim().slice(0, 500),
    origin: new URL(req.url).origin,
    excelRows,
    sequencesByJob,
    importedBare,
    importedJobIds,
  }))

  return NextResponse.json({
    ok: true,
    dashboard: {
      id: record.id,
      status: 'running',
      jobIds: keptJobIds,
      ...(recoveredCount > 0 ? { recoveredCount } : {}),
      ...(droppedEntries.length > 0 ? { droppedCount: droppedEntries.length, droppedLabels } : {}),
    },
  })
}

/** 后台生成：行加载（v2.60 含缓存快照回退；v2.61 含序列回填；v2.63 含单独报告
 *  文件原文读取；v2.68 含导入载入靶点 — entries 内导入作业打「载入」徽标 +
 *  无作业标记的旧报告降级行）→ 统计 → LLM（报告 + 每靶点结论）→ HTML 落盘 → 终态 */
async function runDashboardGeneration(ctx: {
  dashboardId: string
  entries: HtDashboardEntry[]
  /** v2.60：DB 无记录作业的浏览器缓存快照（恢复统计行） */
  archivedByJob?: Map<string, ArchivedJobSnapshot>
  goal?: string
  origin: string
  excelRows?: Array<{ label: string; text: string; seqs?: string[] }>
  /** v2.61：jobId → 提交序列全文（汇总表复制按钮 + 单靶点弹出报告页） */
  sequencesByJob?: Map<string, string>
  /** v2.68：导入既有报告但无作业标记的靶点（降级「载入」行） */
  importedBare?: HtImportedTarget[]
  /** v2.68：entries 中来自导入报告的原作业 id（行标「载入」徽标） */
  importedJobIds?: Set<string>
}): Promise<void> {
  const { dashboardId, entries, archivedByJob, goal, excelRows, sequencesByJob, importedBare, importedJobIds } = ctx
  const startedAt = Date.now()
  const fail = async (msg: string) => {
    await db.htDashboard.update({
      where: { id: dashboardId },
      data: { status: 'error', error: msg.slice(0, 500), updatedAt: new Date() },
    }).catch(() => undefined)
  }
  try {
    const { rows, jobCount } = await loadHtDashboardRows(entries, archivedByJob, sequencesByJob, importedJobIds)
    // v2.68：导入载入的降级行 — DB 命中（完整统计已恢复）的同名靶点剔除，
    //  仅保留未命中/旧版报告（无作业标记）的降级行（主表呈现 + 完成口径，
    //  不参与评分分布；label 与运行侧条目同源 — 去重键可靠）
    const restoredLabels = new Set(rows.filter(r => r.imported).map(r => r.label))
    const bareRows = buildImportedBareRows((importedBare ?? []).filter(t => !restoredLabels.has(t.label.slice(0, 60))))
    if (rows.length === 0 && bareRows.length === 0) return void (await fail('没有可统计的已完成靶点'))
    // v2.68：导入但 DB 过期/无快照的 jobId 不计入「失败」（这些靶点已由 bare 行兜底呈现，
    //  双计会同时虚增失败数与靶点总数）
    const restoredJobIds = new Set(rows.map(r => r.jobId))
    const droppedImported = importedJobIds
      ? [...importedJobIds].filter(id => !restoredJobIds.has(id)).length
      : 0
    const allRows = [...rows, ...bareRows]
    const stats = computeHtStats(rows, Math.max(0, jobCount - droppedImported), bareRows.length)
    const generated = await generateHtDashboardReport(rows, stats, goal)
    const engineSummary = await getEngineSummary()
    // zip 相对链接（与 ht-archive 命名同源 — 解压后 G01/xxx.html 可点）；
    // v2.60：缓存恢复行无服务器报告文件，zip 内无对应文件 — 不挂离线链接
    const zipHrefs = await resolveZipHrefs(entries)
    for (const r of allRows) r.zipHref = r.fromArchive || r.bare ? undefined : zipHrefs.get(r.jobId)

    const generatedAt = new Date().toISOString().replace('T', ' ').slice(0, 16)
    // v2.68：标题与统计的靶点规模含载入靶点（有效作业数 + 降级行数）
    const title = htDashboardTitle(Math.max(0, jobCount - droppedImported) + bareRows.length, generatedAt)
    // v2.36：原始 Excel 行匹配到各靶点（「原表内容」列）
    if (excelRows && excelRows.length) attachExcelRows(allRows, excelRows)
    const html = renderHtDashboardHtml({
      title,
      goal,
      rows: allRows,
      stats,
      verdicts: generated.verdicts,
      markdown: generated.markdown,
      llmOk: generated.ok,
      llmErrors: generated.errors,
      engineSummary,
      origin: ctx.origin,
      generatedAt,
      excelRows,
    })

    const dir = path.join(process.cwd(), 'db', 'reports', dashboardId)
    await fs.mkdir(dir, { recursive: true })
    const htmlPath = path.join(dir, 'report.html')
    await fs.writeFile(htmlPath, html, 'utf-8')
    await db.htDashboard.update({
      where: { id: dashboardId },
      data: {
        title,
        stats: JSON.stringify(stats),
        verdicts: JSON.stringify(generated.verdicts),
        markdown: generated.markdown || null,
        htmlPath,
        engine: engineSummary,
        status: 'done',
        error: generated.ok ? null : (generated.errors.join('；').slice(0, 500) || null),
        updatedAt: new Date(),
      },
    })
    console.log(`[ht-dashboard] 统计看板生成完成（${dashboardId}）：${rows.length + bareRows.length} 个靶点（含载入 ${bareRows.length + rows.filter(r => r.imported).length}）· AI 报告 ${generated.ok ? '成功' : '降级'} · 耗时 ${Math.round((Date.now() - startedAt) / 1000)}s`)
  } catch (err) {
    await fail(err instanceof Error ? err.message : String(err))
  }
}

export async function GET(req: Request) {
  const owner = getOwner(req)
  const url = new URL(req.url)
  const id = url.searchParams.get('id')?.trim()
  if (!id) {
    // 无 id — 最近看板列表（历史回看入口）
    const rows = await db.htDashboard.findMany({
      where: { ownerKey: owner.key },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, jobIds: true, title: true, status: true, error: true, createdAt: true },
    })
    const items = rows.map(r => {
      let jobIds: string[] = []
      try { jobIds = JSON.parse(r.jobIds) } catch { /* ignore */ }
      return { id: r.id, jobIds, title: r.title ?? '', status: r.status, createdAt: r.createdAt.toISOString() }
    })
    return NextResponse.json({ ok: true, items })
  }

  // id 形态守卫 + 查询容错（非 cuid / 查询异常 → 404，不翻 500）
  // v2.57：inline 预览（新标签页锚链接/iframe）与 download 链接的 404 返友好 HTML；
  // 纯 id 的 JSON 状态轮询（前端 fetch）保持 JSON。
  const htmlView = url.searchParams.get('inline') === '1' || url.searchParams.get('download') === '1'
  if (!/^[a-z0-9]{20,40}$/i.test(id)) return htmlView ? reportNotFoundResponse({ kind: 'dashboard' }) : notFound('看板不存在')
  let record: HtDashboard | null = null
  try {
    record = await db.htDashboard.findUnique({ where: { id } })
  } catch {
    return htmlView ? reportNotFoundResponse({ kind: 'dashboard' }) : notFound('看板不存在')
  }
  if (!record) return htmlView ? reportNotFoundResponse({ kind: 'dashboard' }) : notFound('看板不存在')
  if (record.ownerKey && record.ownerKey !== owner.key && record.ownerKey !== owner.ipKey) {
    return htmlView ? reportNotFoundResponse({ kind: 'dashboard' }) : notFound('看板不存在')
  }

  if (url.searchParams.get('inline') === '1' || url.searchParams.get('download') === '1') {
    if (!record.htmlPath) return reportNotFoundResponse({ kind: 'dashboard', reason: '该看板无 HTML 文件（生成失败或未落盘）' })
    try {
      const html = await fs.readFile(record.htmlPath, 'utf-8')
      if (url.searchParams.get('download') === '1') {
        const base = (record.title ?? '').replace(/[\x00-\x1f\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || `TargetEval_Dashboard_${record.id.slice(0, 8)}`
        return new Response(html, {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Disposition': `attachment; filename="TargetEval_Dashboard.html"; filename*=UTF-8''${encodeURIComponent(base)}.html`,
            'Cache-Control': 'no-store',
          },
        })
      }
      return new Response(html, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': 'frame-ancestors *;',
        },
      })
    } catch {
      return reportNotFoundResponse({ kind: 'dashboard', reason: '看板文件已过期清理（磁盘数据已被回收或重置）' })
    }
  }

  // JSON 状态（前端轮询）
  return NextResponse.json({
    ok: true,
    dashboard: {
      id: record.id,
      status: record.status === 'done' ? 'done' : record.status === 'error' ? 'error' : 'running',
      title: record.title ?? '',
      error: record.error ?? null,
      createdAt: record.createdAt.toISOString(),
    },
  })
}
