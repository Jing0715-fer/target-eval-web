/**
 * POST /api/evaluate/ht-dashboard — 高通量运行统计看板生成（v2.28）。
 *
 * v2.69：导入靶点内容整合 — imported 载荷扩展 stats（客户端解析的统计快照，
 *  严格消毒：评分 0-10 / 覆盖率 0-100 / 全零快照视为解析失败）+ reportId
 *  （原文服务端留存 id — 归属校验后读回内嵌弹出页）；纯导入运行（0 评估作业）
 *  全守卫放行；后台生成接收 owner（留存读取校验）并共用报告原文体积预算。
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
import { APP_VERSION } from '@/lib/version'
import {
  loadHtDashboardRows,
  buildImportedRows,
  loadImportedReportHtml,
  backfillImportedStats,
  computeHtStats,
  generateHtDashboardReport,
  renderHtDashboardHtml,
  writeHtDashboardHtmlFile,
  ensureHtDashboardProgressColumn,
  makeHtDashboardProgressWriter,
  parseHtDashboardProgress,
  resolveZipHrefs,
  htDashboardTitle,
  attachExcelRows,
  markStalledHtDashboards,
  stalledHtDashboardError,
  HT_DASHBOARD_STALL_MS,
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

/** v2.68→v2.69：imported 消毒 — 导入既有报告的靶点（stats 存在时构建完整统计行，
 *  否则降级「载入」行；reportId 供弹出页内嵌原文）。≤600 条；sequence 氨基酸
 *  清洗 ≤50K、总预算 400K；stats 数值严格钳制（0-10 评分 / 0-100 覆盖率 /
 *  计数上限；字符串截断） */
function sanitizeImported(v: unknown): HtImportedTarget[] {
  if (!Array.isArray(v)) return []
  const out: HtImportedTarget[] = []
  let seqBudget = 400_000
  const score = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 10 ? Math.round(x) : 0)
  const count = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.min(Math.round(x), 100_000) : 0)
  for (const e of v) {
    if (!e || typeof e !== 'object' || out.length >= 600) continue
    const o = e as {
      label?: unknown; group?: unknown; sequence?: unknown; fileName?: unknown
      reportId?: unknown; range?: unknown; stats?: unknown
    }
    const label = typeof o.label === 'string' ? o.label.trim().slice(0, 60) : ''
    if (!label) continue
    const group = typeof o.group === 'number' && Number.isFinite(o.group) && o.group > 0 && o.group <= 999 ? Math.round(o.group) : undefined
    const fileName = typeof o.fileName === 'string' && o.fileName.trim() ? o.fileName.trim().slice(0, 80) : undefined
    const reportId = typeof o.reportId === 'string' && /^[a-z0-9]{20,40}$/i.test(o.reportId) ? o.reportId : undefined
    const rv = o.range
    const range = Array.isArray(rv) && rv.length === 2 && Number(rv[0]) >= 1 && Number(rv[1]) >= Number(rv[0])
      ? [Number(rv[0]), Number(rv[1])] as [number, number]
      : undefined
    let sequence: string | undefined
    if (typeof o.sequence === 'string') {
      const seq = o.sequence.replace(/\s+/g, '').replace(/[^ACDEFGHIKLMNPQRSTVWYBXZJUO*-]/gi, '').toUpperCase()
      if (seq && seq.length <= 50_000 && seqBudget >= seq.length) {
        sequence = seq
        seqBudget -= seq.length
      }
    }
    // v2.69 stats：客户端解析的统计快照（存在即完整统计行）— 逐字段消毒
    let stats: HtImportedTarget['stats']
    if (o.stats && typeof o.stats === 'object' && !Array.isArray(o.stats)) {
      const s = o.stats as Record<string, unknown>
      const br = s.bestResolution
      const res = typeof br === 'number' && Number.isFinite(br) && br >= 0.3 && br <= 99 ? Math.round(br * 100) / 100 : null
      const pn = typeof s.proteinName === 'string' && s.proteinName.trim() ? s.proteinName.trim().slice(0, 80) : undefined
      const og = typeof s.organism === 'string' && s.organism.trim() ? s.organism.trim().slice(0, 80) : undefined
      const up = typeof s.uniprotId === 'string' && /^(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9][A-Z][A-Z0-9]{2}[0-9])(?:[A-Z0-9]{3}[0-9])?$/i.test(s.uniprotId) ? s.uniprotId.toUpperCase() : undefined
      const rv2 = s.range
      const rg = Array.isArray(rv2) && rv2.length === 2 && Number(rv2[0]) >= 1 && Number(rv2[1]) >= Number(rv2[0])
        ? [Number(rv2[0]), Number(rv2[1])] as [number, number]
        : undefined
      const sl = typeof s.seqLength === 'number' && Number.isFinite(s.seqLength) && s.seqLength >= 10 && s.seqLength <= 100_000 ? Math.round(s.seqLength) : undefined
      stats = {
        overall: score(s.overall),
        xray: score(s.xray),
        cryoem: score(s.cryoem),
        nmr: score(s.nmr),
        pdbCount: count(s.pdbCount),
        blastHitCount: count(s.blastHitCount),
        literatureCount: count(s.literatureCount),
        methodXrayCount: count(s.methodXrayCount),
        methodCryoemCount: count(s.methodCryoemCount),
        methodNmrCount: count(s.methodNmrCount),
        bestResolution: res,
        coverage: typeof s.coverage === 'number' && Number.isFinite(s.coverage) && s.coverage >= 0 ? Math.min(Math.round(s.coverage), 100) : 0,
        ...(pn ? { proteinName: pn } : {}),
        ...(og ? { organism: og } : {}),
        ...(up ? { uniprotId: up } : {}),
        ...(rg ? { range: rg } : {}),
        ...(sl ? { seqLength: sl } : {}),
      }
      // 全零快照视为解析失败（真实报告至少有一项非零 — 防止伪造空数据入统计）
      if (stats.overall === 0 && stats.xray === 0 && stats.cryoem === 0 && stats.nmr === 0
        && stats.pdbCount === 0 && stats.blastHitCount === 0) stats = undefined
    }
    out.push({
      label,
      ...(group ? { group } : {}),
      ...(sequence ? { sequence } : {}),
      ...(fileName ? { fileName } : {}),
      ...(reportId ? { reportId } : {}),
      ...(range ? { range } : {}),
      ...(stats ? { stats } : {}),
    })
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
  // v2.69：导入靶点载荷先行消毒（纯导入运行 — 全部靶点载入既有报告，无评估作业
  //  — 也允许生成看板：stats 完整统计行 / 降级行仍可呈现）
  const importedSanitized = sanitizeImported(body.imported)
  if (entries.length === 0 && importedSanitized.length === 0) {
    return NextResponse.json({ ok: false, error: '缺少报告条目（entries 为空且无导入靶点）' }, { status: 400 })
  }
  if (jobIds.length === 0 && importedSanitized.length === 0) {
    return NextResponse.json({ ok: false, error: '条目中没有评估作业（jobId）且无导入靶点 — 统计看板需要至少 1 个已完成靶点' }, { status: 400 })
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
  // v2.68：纯导入运行（全部靶点载入既有报告）允许无统计作业 — 导入靶点的完整统计行（stats）/降级行仍可生成
  const importedBareSanitized = importedSanitized
  if (keptJobIds.length === 0 && importedBareSanitized.length === 0) {
    return NextResponse.json({ ok: false, error: '条目中没有可统计的评估作业（均已过期且无本地缓存副本）' }, { status: 400 })
  }
  // 至少 1 个可统计行（本人已完成作业 / 有效快照 — summary 含 scores）；
  // v2.68：纯导入运行（bare 降级行）同样放行
  const ownedDoneCount = jobs.filter(j => ownedIds.has(j.id) && j.status === 'done').length
  if (ownedDoneCount === 0 && recoveredCount === 0 && importedBareSanitized.length === 0) {
    return NextResponse.json({ ok: false, error: '没有已完成的评估作业（统计看板需要至少 1 个成功靶点）' }, { status: 400 })
  }

  // v2.71：progress 列自愈（本地部署未 db:push 时 Prisma create 返回全列 → P2021）
  await ensureHtDashboardProgressColumn().catch((err: unknown) => {
    console.error('[ht-dashboard] progress 列自愈失败（不影响生成 — 进度展示将缺省）：', err instanceof Error ? err.message : String(err))
  })
  // v2.78：创建前清扫本人名下的僵死 running 看板（服务重启/OOM 被杀遗留 —
  // 生成后台任务已不在，记录永远停在 running；此处标记为「生成中断」让历史
  // 列表如实呈现，避免僵尸态在「打开运行自动重试」时被误判为仍在生成）
  await markStalledHtDashboards(owner.key).catch(() => 0)
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
  // v2.68→v2.69：导入载入靶点 — stats 完整统计行 + 降级行 + 原文内嵌（reportId）
  //  + entries 内导入作业的「载入」徽标集
  const importedBare = importedBareSanitized
  const importedJobIds = importedJobIdSet
  // v2.79：.catch 进程死亡保险 — runDashboardGeneration 全程 try/catch 理论不
  //  会 reject，但 void 下的未捕获 rejection 会直接杀死整个 Node 进程（用户
  //  环境「服务进程已中断」的最坏形态，与生成卡滞同担后果）；AsyncLocalStorage
  //  机制层异常等不可预见路径在此兜底：记日志 + 尽力落库 error 终态（带
  //  status:'running' 条件 — 不覆盖生成器已写入的终态）。
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
    owner: { key: owner.key, ipKey: owner.ipKey },
  })).catch((err: unknown) => {
    console.error(`[ht-dashboard] 生成任务异常退出（${record.id}）：`, err)
    void db.htDashboard.updateMany({
      where: { id: record.id, status: 'running' },
      data: {
        status: 'error',
        error: `生成异常退出：${err instanceof Error ? err.message : String(err)}`.slice(0, 500),
        progress: null,
        updatedAt: new Date(),
      },
    }).catch(() => undefined)
  })

  return NextResponse.json({
    ok: true,
    v: APP_VERSION,
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
 *  文件原文路径；v2.68 含导入载入靶点；v2.69 导入报告原文留存规划 + stats
 *  完整统计行构建）→ 统计 → LLM（报告 + 每靶点结论）→ HTML 落盘 → 终态。
 *  v2.71：① 各阶段进度写入 DB（前端轮询展示 — 生成不再黑盒等待）；② HTML
 *  落盘改流式（writeHtDashboardHtmlFile — 报告原文逐份读盘写入，修复百级
 *  靶点全量内嵌时四份全量字符串拷贝同驻堆内存导致的 OOM/502）。 */
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
  /** v2.68→v2.69：导入既有报告的靶点（stats 完整统计行 / 无 stats 降级行） */
  importedBare?: HtImportedTarget[]
  /** v2.68：entries 中来自导入报告的原作业 id（行标「载入」徽标） */
  importedJobIds?: Set<string>
  /** v2.69：请求者归属（导入原文留存的读取校验） */
  owner?: { key: string; ipKey: string }
}): Promise<void> {
  const { dashboardId, entries, archivedByJob, goal, excelRows, sequencesByJob, importedBare, importedJobIds, owner } = ctx
  const startedAt = Date.now()
  const progress = makeHtDashboardProgressWriter(dashboardId)
  // v2.79：生成开始落 console（用户环境排查「服务进程已中断」— dev 控制台可见
  //  生成是否真的启动、卡在哪个阶段、是否走到终态）
  console.log(`[ht-dashboard] 统计看板生成开始（${dashboardId}）：${entries.filter(e => e.jobId).length} 个作业条目 + ${importedBare?.length ?? 0} 个导入载入靶点`)
  // ── v2.77：全局阶段看门狗（根除「10 分钟无进展」误报的最后一环）──
  //  v2.74 的 LLM 心跳只覆盖 LLM 阶段；其余阶段（数据加载/导入留存规划/批次
  //  统计/zip 规划/shell 渲染）无逐项 tick 时进度静默，前端 10 分钟窗口照旧
  //  超时误报。本看门狗对「任何阶段」生效：静默 ≥5s 即以「原文本 · 已 Ns」心跳
  //  写库（文本持续变化 → 前端窗口持续重置）；≥3min 附「耗时异常」提示；
  //  ≥20min（PHASE_STALL_GIVEUP_MS — 各大阶段均有逐行/逐项 tick，LLM 有调
  //  用方 60s/120s 硬预算，真实生成不可能静默这么久）判定真卡滞：落库 error
  //  终态让前端立刻拿到明确失败（不再空转 30 分钟硬上限）；后台 promise 若
  //  此后自行完成/失败，终态 update 仍会覆盖落库（自愈为 done）。
  let phaseBaseText = '准备生成…'
  let phaseBasePct: number | undefined
  let phaseStartAt = Date.now()
  let watchdogGivenUp = false
  const PHASE_STALL_NOTE_MS = 3 * 60_000
  const PHASE_STALL_GIVEUP_MS = 20 * 60_000
  const progressWithPhase = (msg: string, pct?: number): void => {
    // 规范化：剥离调用方（LLM 心跳）已内嵌的「· 已 Ns」尾巴 — 看门狗追加自己的
    // 计时尾巴，避免静默子阶段期间出现「…· 已 187s · 已 12s」双重尾巴。
    phaseBaseText = msg.replace(/\s*·\s*已\s*\d+s.*$/, '')
    phaseBasePct = pct
    phaseStartAt = Date.now()
    progress(msg, pct)
  }
  const phaseWatchdog = setInterval(() => {
    const silentMs = Date.now() - phaseStartAt
    if (silentMs < 5_000 || watchdogGivenUp) return
    const elapsedSec = Math.round(silentMs / 1000)
    const note = silentMs >= PHASE_STALL_NOTE_MS && silentMs < PHASE_STALL_GIVEUP_MS
      ? '（该阶段耗时异常 — 仍在等待完成，可稍后刷新查看）'
      : ''
    progress(`${phaseBaseText} · 已 ${elapsedSec}s${note}`, phaseBasePct)
    if (silentMs >= PHASE_STALL_GIVEUP_MS) {
      watchdogGivenUp = true
      clearInterval(phaseWatchdog)
      void db.htDashboard.update({
        where: { id: dashboardId },
        data: {
          status: 'error',
          error: `生成卡滞：${phaseBaseText} 阶段 ${Math.round(silentMs / 60_000)} 分钟无进展 — 已判定失败（运行结果不受影响，可点击「重新生成汇总报告」重试；若后台实际仍在完成，历史记录中会出现该看板）`.slice(0, 500),
          progress: null,
          updatedAt: new Date(),
        },
      }).catch(() => undefined)
    }
  }, 5_000)
  const fail = async (msg: string) => {
    clearInterval(phaseWatchdog)
    console.error(`[ht-dashboard] 统计看板生成失败（${dashboardId}）：${msg.slice(0, 300)}`)
    await db.htDashboard.update({
      where: { id: dashboardId },
      data: { status: 'error', error: msg.slice(0, 500), progress: null, updatedAt: new Date() },
    }).catch(() => undefined)
  }
  // v2.76：全局进度百分比（进度条）— 阶段权重按典型耗时分布标定：
  //  数据加载 2→15 / 导入留存规划 16→20 / 导入统计补解析 21→30（逐个 tick）/
  //  批次统计 31→35 / LLM（每靶点结论 + 整体报告）36→60（心跳渐近推进 — 时长
  //  不可知，限流重试可静默数分钟）/ zip 链接 61→65 / HTML 流式落盘 66→98
  //  （百级靶点报告原文逐份读盘写入 — 主耗时阶段，逐行 tick）。各阶段仅推进到
  //  本阶段起始值（实际耗时未知），下一阶段消息携带自身起始百分比自然接续。
  try {
    // v2.69：报告原文体积预算（作业报告 + 导入留存共用 — 弹出页内嵌总量护栏；
    // v2.71 起按 stat 字节分配，内容写盘时逐份延迟读取）
    const reportBudget = { total: 0 }
    progressWithPhase(`加载 ${entries.filter(e => e.jobId).length} 个靶点的评估数据…`, 2)
    const { rows, jobCount } = await loadHtDashboardRows(entries, archivedByJob, sequencesByJob, importedJobIds, reportBudget)
    // v2.68→v2.69：导入载入靶点 — DB 命中（完整统计已从原作业恢复）的同名靶点剔除
    //  （以 DB 恢复行为准 — 数据更全），仅保留未命中的：stats 存在 → 完整统计行
    //  （解析自导入报告文件，不依赖 DB 保留期），否则降级行（label 与运行侧条目
    //  同源 — 去重键可靠）
    const restoredLabels = new Set(rows.filter(r => r.imported).map(r => r.label))
    const pendingImported = (importedBare ?? []).filter(t => !restoredLabels.has(t.label.slice(0, 60)))
    if (pendingImported.length > 0) progressWithPhase(`规划 ${pendingImported.length} 个导入报告的原文留存…`, 16)
    // v2.69：导入报告原文留存规划（归属校验 + 体积预算 — 弹出页内嵌报告原文）
    const reportPathById = owner
      ? await loadImportedReportHtml(pendingImported, owner, reportBudget)
      : new Map<string, string>()
    // v2.72：服务端补解析（客户端 enrich 解析失败的降级行兜底 — 修复「报告打开
    //  正常但表格评分列为空」：读留存原文前缀，同一解析器 + 提交序列 SHA/容差
    //  定位，命中即回填 stats → 完整统计行，与本次评估同权参与统计）
    const backfillPending = pendingImported.filter(t =>
      !t.stats && t.reportId && reportPathById.has(t.reportId)).length
    if (backfillPending > 0) {
      progressWithPhase(`解析导入报告统计（待补 ${backfillPending} 个）…`, 21)
      const backfilled = await backfillImportedStats(pendingImported, reportPathById, (d, n) => {
        progressWithPhase(`解析导入报告统计 ${d}/${n}…`, 21 + Math.round((d / n) * 9))
      })
      if (backfilled > 0) {
        console.log(`[ht-dashboard] 导入报告统计服务端补解析：${backfilled}/${backfillPending} 个降级行已回填为完整统计行`)
      }
    }
    const { rows: importedRows, bareRows } = buildImportedRows(pendingImported, reportPathById)
    const statRows = [...rows, ...importedRows]
    if (statRows.length === 0 && bareRows.length === 0) return void (await fail('没有可统计的已完成靶点'))
    // v2.68：导入但 DB 过期/无快照的 jobId 不计入「失败」（这些靶点已由导入行兜底呈现，
    //  双计会同时虚增失败数与靶点总数）
    const restoredJobIds = new Set(rows.map(r => r.jobId))
    const droppedImported = importedJobIds
      ? [...importedJobIds].filter(id => !restoredJobIds.has(id)).length
      : 0
    const allRows = [...statRows, ...bareRows]
    progressWithPhase('汇总批次统计…', 31)
    const stats = computeHtStats(statRows, Math.max(0, jobCount - droppedImported), bareRows.length)
    // v2.74：LLM 阶段心跳进度 — 每靶点结论（≤60s）+ 整体报告（≤120s）叠加限流重试
    //  （20s/40s/60s/90s/120s 退避）时可静默数分钟，前端无进展判定会把仍在正常
    //  生成的运行误判超时；心跳每 5s 写一次带已等待秒数的进度文本（progress 写入器
    //  自带 1.5s 节流 — 文本变化即落库，前端轮询可见 → 进度窗口持续重置）。
    const llmT0 = Date.now()
    const llmHeartbeat = setInterval(() => {
      // v2.76：百分比渐近推进（36→60 永不越界）— LLM 总时长不可知（限流重退
      //  可静默数分钟），线性会提前到顶显得「假完成」，渐近曲线持续前进又不过冲
      //  v2.77：改走 progressWithPhase — 与全局看门狗同一口径（心跳期间看门狗静默）
      const elapsedSec = (Date.now() - llmT0) / 1000
      progressWithPhase(
        `AI 撰写整体可行性报告（${statRows.length} 个靶点）· 已 ${Math.round(elapsedSec)}s`,
        36 + 24 * (1 - Math.exp(-elapsedSec / 90)),
      )
    }, 5_000)
    let generated
    try {
      progressWithPhase(`AI 撰写整体可行性报告（${statRows.length} 个靶点）…`, 36)
      generated = await generateHtDashboardReport(statRows, stats, goal)
    } finally {
      clearInterval(llmHeartbeat)
    }
    const engineSummary = await getEngineSummary()
    // zip 相对链接（与 ht-archive 命名同源 — 解压后 G01/xxx.html 可点）；
    // v2.60：缓存恢复行无服务器报告文件，zip 内无对应文件 — 不挂离线链接
    progressWithPhase('规划离线包链接命名…', 61)
    const zipHrefs = await resolveZipHrefs(entries)
    for (const r of allRows) r.zipHref = r.fromArchive || r.bare || r.importedFromFile ? undefined : zipHrefs.get(r.jobId)

    const generatedAt = new Date().toISOString().replace('T', ' ').slice(0, 16)
    // v2.68→v2.69：标题与统计的靶点规模含载入靶点（有效作业数 + 解析导入行 + 降级行）
    const title = htDashboardTitle(Math.max(0, jobCount - droppedImported) + importedRows.length + bareRows.length, generatedAt)
    // v2.36：原始 Excel 行匹配到各靶点（「原表内容」列）
    if (excelRows && excelRows.length) attachExcelRows(allRows, excelRows)
    // v2.71：流式落盘（内存安全 — 载荷报告原文逐份读盘写入，不再四份全量拷贝）
    const dir = path.join(process.cwd(), 'db', 'reports', dashboardId)
    await fs.mkdir(dir, { recursive: true })
    const htmlPath = path.join(dir, 'report.html')
    // v2.76：写盘子进度 → 全局百分比（shell 渲染 = 阶段头部 66；载荷逐行
    //  70→98 — 百级靶点时该阶段占比最大，逐行 tick 让进度条持续前进）。
    //  v2.77：经 progressWithPhase — 逐行 tick 持续重置看门狗静默计时。
    const writeProgress = (msg: string, frac?: number): void => {
      progressWithPhase(msg, frac != null ? 70 + Math.round(frac * 28) : 66)
    }
    await writeHtDashboardHtmlFile({
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
    }, htmlPath, writeProgress)
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
        progress: null,
        updatedAt: new Date(),
      },
    })
    clearInterval(phaseWatchdog)
    console.log(`[ht-dashboard] 统计看板生成完成（${dashboardId}）：${statRows.length + bareRows.length} 个靶点（含载入 ${bareRows.length + statRows.filter(r => r.imported).length}，其中解析导入报告 ${statRows.filter(r => r.importedFromFile).length}）· AI 报告 ${generated.ok ? '成功' : '降级'} · 耗时 ${Math.round((Date.now() - startedAt) / 1000)}s${watchdogGivenUp ? '（看门狗曾判卡滞 — 本次完成已自愈覆盖）' : ''}`)
  } catch (err) {
    await fail(err instanceof Error ? err.message : String(err))
  }
}

export async function GET(req: Request) {
  const owner = getOwner(req)
  const url = new URL(req.url)
  const id = url.searchParams.get('id')?.trim()
  // v2.71：progress 列自愈（旧库无此列时 findUnique 全列查询抛 P2021 → 误报 404）
  await ensureHtDashboardProgressColumn().catch(() => undefined)
  if (!id) {
    // 无 id — 最近看板列表（历史回看入口）
    // v2.78：列表前清扫本人僵死 running 看板（服务重启遗留 — 生成进程已不在，
    //  记录停在 running 会让历史项永远显示「生成中」且不可打开）
    await markStalledHtDashboards(owner.key).catch(() => 0)
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

  // ── v2.78：僵死检测（前端轮询路径的核心修复）──
  //  running 且 updatedAt 停滞 >90s = 生成后台任务已不在（服务重启/OOM 被杀/
  //  进程退出把 promise 带走 — 看门狗每 5s 心跳写库，活着不可能停滞这么久）。
  //  旧实现此时前端只能盲等 10 分钟拿误导性「无进展超时」且进度条全程空转；
  //  现在立即标记「生成中断」error 终态 — 前端马上拿到明确失败并自动重试一次
  //  （api.ts 识别前缀），用户无感恢复。竞态安全：updateMany 带 status:'running'
  //  条件，若生成器恰好在此刻完成/失败，其终态写入先到则本标记败退（重读回落）。
  //
  //  v2.79 漏洞补齐：v2.78 的标记写库失败（磁盘满/SQLite 被占用/旧库列缺失）时
  //  被 .catch(()=>0) 静默吞掉 — 重读仍返 running，前端继续盲等 10 分钟黑盒
  //  （用户实测复现路径之一）。现在写库失败时 JSON 状态路径直接以内存终态应答
  //  「生成中断」（本次响应不落库；DB 恢复后由清扫/终态写入自愈）— 轮询方
  //  在 90s 内必然拿到明确失败并自动重试，不再依赖落库成功。updatedAt 停滞
  //  >90s 已证明生成进程不在（活着每 5s 写库），不会误伤活生成器。
  if (record.status === 'running' && Date.now() - record.updatedAt.getTime() > HT_DASHBOARD_STALL_MS) {
    const stallErr = stalledHtDashboardError().slice(0, 500)
    let markFailed = false
    try {
      await db.htDashboard.updateMany({
        where: { id: record.id, status: 'running' },
        data: { status: 'error', error: stallErr, progress: null, updatedAt: new Date() },
      })
    } catch (err) {
      markFailed = true
      console.error(`[ht-dashboard] 僵死看板标记落库失败（数据库写入受阻 — 磁盘满/库被占用/旧库缺列？）：${record.id}`, err instanceof Error ? err.message : String(err))
    }
    console.warn(`[ht-dashboard] 检测到僵死看板（running 且写入停滞 >${Math.round(HT_DASHBOARD_STALL_MS / 1000)}s — 生成进程已不存在）：${record.id}${markFailed ? '（标记落库失败 — 本次响应以内存态告知轮询方）' : '，已标记为「生成中断」'}`)
    // 重读落库终态（本标记生效 → error；生成器竞态先完成 → done/error 原值）
    const reread = await db.htDashboard.findUnique({ where: { id } }).catch(() => null)
    if (reread) record = reread
    if (record.status === 'running' && !htmlView) {
      return NextResponse.json({
        ok: true,
        v: APP_VERSION,
        dashboard: {
          id: record.id,
          status: 'error',
          title: record.title ?? '',
          error: stallErr,
          createdAt: record.createdAt.toISOString(),
        },
      })
    }
  }

  if (url.searchParams.get('inline') === '1' || url.searchParams.get('download') === '1') {
    if (!record.htmlPath) return reportNotFoundResponse({ kind: 'dashboard', reason: '该看板无 HTML 文件（生成失败或未落盘）' })
    try {
      // v2.71：流式回送（百级靶点全量内嵌的看板可达数百 MB — readFile 整读会
      //  在生成刚结束时再制造一次堆内存尖峰，与生成期间同样的 OOM 风险）。
      //  v2.74：弃用 Readable.toWeb — 它给非对象模式流挂 ByteLengthQueuingStrategy
      //  （size = chunk.byteLength，内部 enqueueValueWithSize 对非数值 size 抛
      //  RangeError "The argument 'size' is invalid"→ uncaughtException + "failed
      //  to pipe response" + 读文件句柄泄漏 — 用户实测流式预览期间进程级崩溃），
      //  改手写适配器：默认策略（size 恒 1，无 size 计算 → 该类崩溃免疫）、
      //  cancel/error 路径显式 destroy 释放 fd、enqueue/close/error 全兜底
      //  （客户端中途取消不再可能产生未捕获异常）。Buffer → Uint8Array 拷贝
      //  与 toWeb 同口径（脱离池缓冲，避免响应生命周期外引用池块）。
      const { createReadStream } = await import('node:fs')
      const nodeStream = createReadStream(record.htmlPath)
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          let ended = false
          nodeStream.pause()
          nodeStream.on('data', (chunk: Buffer | string) => {
            if (ended) return
            try {
              controller.enqueue(typeof chunk === 'string' ? new Uint8Array(Buffer.from(chunk, 'utf-8')) : new Uint8Array(chunk))
              if ((controller.desiredSize ?? 1) <= 0) nodeStream.pause()
            } catch {
              // 控制器已关闭/出错（消费端取消竞态）— 停止读取并释放底层句柄
              ended = true
              nodeStream.destroy()
            }
          })
          nodeStream.on('end', () => {
            if (ended) return
            ended = true
            try { controller.close() } catch { /* 已关闭 */ }
          })
          nodeStream.on('error', (err: Error) => {
            if (ended) return
            ended = true
            try { controller.error(err) } catch { /* 已关闭 */ }
          })
        },
        pull() {
          nodeStream.resume()
        },
        cancel(reason) {
          nodeStream.destroy(reason instanceof Error ? reason : undefined)
        },
      })
      if (url.searchParams.get('download') === '1') {
        const base = (record.title ?? '').replace(/[\x00-\x1f\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || `TargetEval_Dashboard_${record.id.slice(0, 8)}`
        return new Response(stream, {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Disposition': `attachment; filename="TargetEval_Dashboard.html"; filename*=UTF-8''${encodeURIComponent(base)}.html`,
            'Cache-Control': 'no-store',
          },
        })
      }
      return new Response(stream, {
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

  // JSON 状态（前端轮询）— v2.71 附带生成阶段进度（running 期间横幅实时展示）；
  //  v2.76 progress 列编码「#P{pct}# 文本」（见 encodeHtDashboardProgress）—
  //  解析后回传 progress（展示文本）+ progressPct（0-100 进度条）；旧格式纯文本
  //  不带前缀，无 progressPct（前端进度条退化为不确定态动画）
  let progressPayload: { progress: string; progressPct?: number } | undefined
  if (record.status !== 'done' && record.status !== 'error' && record.progress) {
    const { text, pct } = parseHtDashboardProgress(record.progress)
    progressPayload = { progress: text, ...(pct != null ? { progressPct: pct } : {}) }
  }
  return NextResponse.json({
    ok: true,
    v: APP_VERSION,
    dashboard: {
      id: record.id,
      status: record.status === 'done' ? 'done' : record.status === 'error' ? 'error' : 'running',
      title: record.title ?? '',
      error: record.error ?? null,
      ...(progressPayload ?? {}),
      createdAt: record.createdAt.toISOString(),
    },
  })
}
