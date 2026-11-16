/**
 * POST /api/evaluate/batch-report — 生成多靶点合并评估报告（v1.8）
 *  关联靶点批量评估全部完成后调用：加载各作业数据 → LLM 三段式生成
 *  （摘要+关系分析 / 各靶点综述 / 整合策略）→ 渲染 HTML → BatchReport 落库。
 *
 * GET /api/evaluate/batch-report?id=xxx — 查询合并报告（历史/结果页展示）
 * GET /api/evaluate/batch-report?id=xxx&download=1 — 下载 HTML 报告文件
 * 公网加固：仅创建者（ownerKey 匹配）可访问。
 */
import { NextResponse } from 'next/server'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { db } from '@/lib/db'
import { getOwner, isOwnedBy, notFound, ownerListFilter } from '@/lib/eval/request-guard'
import { uploadOwnedBy, isUploadId } from '@/lib/eval/upload-owner'
import { generateMergedReport, loadMergedTargets, renderMergedReportHtml, toMergedTargetLite } from '@/lib/eval/report-merged'
import { applyResponsiveOverride, applyZoomUpgrade, applyUxUpgrade } from '@/lib/eval/report-html'
import { propagateFamilyBlast } from '@/lib/eval/blast-family'
import { getEngineSummary } from '@/lib/eval/llm-provider'
import { fetchUniprotInfo } from '@/lib/eval/uniprot'
import { attributeSequences } from '@/lib/eval/homology'
import { computeSharedStructures } from '@/lib/eval/shared-structures'
import type { FormInsights, ParsedImage, ParsedSequence, RelationJudgment, SequenceAttribution, SharedStructure } from '@/lib/eval/types'
import type { BatchReport } from '@prisma/client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 600

interface BatchReportBody {
  jobIds?: string[]
  uploadId?: string
  relation?: RelationJudgment
  goal?: string
}

/** 服务端重算评估表序列归属（不信任前端透传；fetchUniprotInfo LRU 缓存，二次拉取快） */
async function recomputeAttribution(
  uploadDir: string,
  targets: Array<{ uniprotId?: string }>,
): Promise<SequenceAttribution[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(uploadDir, 'parsed.json'), 'utf-8')) as { sequences?: ParsedSequence[] }
    const sequences = (parsed.sequences ?? []).map(s => ({ header: s.header, seq: s.seq, length: s.length }))
    if (!sequences.length) return []
    const withSeq: Array<{ uniprotId: string; sequence: string }> = []
    for (const t of targets) {
      if (!t.uniprotId) continue
      try {
        const info = await fetchUniprotInfo(t.uniprotId)
        if (info?.sequence && info.sequence.length >= 40) withSeq.push({ uniprotId: info.uniprotId, sequence: info.sequence })
      } catch { /* 单靶点失败仅降级 */ }
    }
    if (!withSeq.length) return []
    return attributeSequences(sequences, withSeq)
  } catch {
    return []
  }
}

function isRelationJudgment(v: unknown): v is RelationJudgment {
  if (!v || typeof v !== 'object') return false
  const j = v as Partial<RelationJudgment>
  return typeof j.related === 'boolean' && typeof j.relationType === 'string' && typeof j.rationale === 'string'
}

// ── v2.11 旧版合并报告自动升级（格式重渲染）────────────────────────────
// 落盘 HTML 无 `mrg-fmt-v2.11` 标记的历史报告：GET inline/download 时从 DB 数据
// （markdown/relation/insights/序列归属/共有结构）+ 作业库重加载 targets，用当前模板
// 重渲染并回写同一 htmlPath — 旧报告无需重新评估即可获得新格式（批次速览 / 共有
// 结构突出 / 明细默认折叠）。作业被 TTL 清理（targets 不可加载）→ 返回 null，
// 调用方继续服务旧 HTML（叠加既有 CSS/UX 升级注入）。
// 并发去重：同 id 在途请求共享同一 Promise（iframe 预览 + 下载同时到达只渲染一次）。
const upgradeInflight = new Map<string, Promise<string | null>>()
const MERGED_FMT_MARKER = 'mrg-fmt-v2.11'

async function upgradeLegacyHtml(record: BatchReport): Promise<string | null> {
  let jobIds: string[] = []
  try { jobIds = JSON.parse(record.jobIds) } catch { return null }
  if (jobIds.length < 2) return null
  let relation: RelationJudgment | null = null
  try { relation = JSON.parse(record.relation) } catch { /* ignore */ }
  if (!isRelationJudgment(relation)) return null

  // 作业可能已被 TTL 清理 — 数据不可完整重建时保留旧 HTML
  let targets: Awaited<ReturnType<typeof loadMergedTargets>> = []
  try { targets = await loadMergedTargets(jobIds) } catch { return null }
  if (targets.length < 2) return null

  // 上传共享数据（评估表要点 / 图片 / 资产目录）
  let insights: FormInsights | null = null
  let images: ParsedImage[] = []
  let assetDir = ''
  const uploadId = record.uploadId ?? ''
  if (uploadId) {
    const uploadDir = path.join(process.cwd(), 'db', 'reports', uploadId)
    assetDir = path.join(uploadDir, 'assets')
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(uploadDir, 'parsed.json'), 'utf-8')) as { images?: ParsedImage[] }
      images = parsed.images ?? []
    } catch { /* 图片缺失容错 */ }
    try {
      const data = JSON.parse(await fs.readFile(path.join(uploadDir, 'insights.json'), 'utf-8')) as FormInsights
      if (Array.isArray(data.goals)) insights = data
    } catch { /* insights 可选 */ }
  }

  let sequenceAttribution: SequenceAttribution[] | undefined
  try { sequenceAttribution = record.sequenceAttribution ? JSON.parse(record.sequenceAttribution) : undefined } catch { /* ignore */ }
  let sharedStructures: SharedStructure[] | undefined
  try { sharedStructures = record.sharedStructures ? JSON.parse(record.sharedStructures) : undefined } catch { /* ignore */ }
  if (!sharedStructures) sharedStructures = computeSharedStructures(targets)

  const llmErrors = record.error ? [record.error] : []
  const html = await renderMergedReportHtml({
    targets,
    relation: relation!,
    markdown: record.markdown ?? '',
    title: record.title ?? undefined,
    llmOk: !record.error,
    llmErrors,
    images,
    assetDir,
    batchReportId: record.id,
    engineSummary: record.engine ?? '—',
    sequenceAttribution,
    sharedStructures,
    insights,
  })

  // 回写同一 htmlPath — 后续请求直接命中新格式（不再触发本分支）
  const htmlPath = path.join(process.cwd(), 'db', 'reports', record.id, 'report.html')
  try {
    await fs.mkdir(path.dirname(htmlPath), { recursive: true })
    await fs.writeFile(htmlPath, html, 'utf-8')
    await db.batchReport.update({ where: { id: record.id }, data: { htmlPath } }).catch(() => undefined)
  } catch { /* 回写失败（磁盘只读等）→ 本次直接返回新 HTML，不落盘 */ }
  return html
}

/** 旧报告升级入口（含并发去重 + 失败静默降级 — 任何异常都退回旧 HTML） */
async function upgradedMergedHtml(record: BatchReport): Promise<string | null> {
  const existing = upgradeInflight.get(record.id)
  if (existing) return existing
  const p = (async () => {
    try { return await upgradeLegacyHtml(record) } catch { return null }
  })().finally(() => { upgradeInflight.delete(record.id) })
  upgradeInflight.set(record.id, p)
  return p
}

export async function POST(req: Request) {
  const owner = getOwner(req)
  let body: BatchReportBody
  try {
    body = (await req.json()) as BatchReportBody
  } catch {
    return NextResponse.json({ ok: false, error: '请求体不是合法 JSON' }, { status: 400 })
  }

  // v2.8：取消 6 作业截断 → 全量合并；防御性上限（与关系判断路由/前端一致）超限明确告知
  const MAX_BATCH_JOBS = 30
  const jobIds = (body.jobIds ?? []).filter(Boolean)
  const relation = body.relation
  if (jobIds.length < 2) {
    return NextResponse.json({ ok: false, error: '合并报告至少需要 2 个评估作业' }, { status: 400 })
  }
  if (jobIds.length > MAX_BATCH_JOBS) {
    return NextResponse.json({ ok: false, error: `一次最多合并 ${MAX_BATCH_JOBS} 个评估作业` }, { status: 400 })
  }
  if (!isRelationJudgment(relation)) {
    return NextResponse.json({ ok: false, error: '缺少有效的关系判定结果（relation）' }, { status: 400 })
  }

  // 归属校验：全部作业须为本人创建
  const jobs = await db.evaluationJob.findMany({ where: { id: { in: jobIds } } })
  if (jobs.length !== jobIds.length) return notFound()
  for (const j of jobs) {
    if (!isOwnedBy(j, owner)) return notFound()
  }

  // 数据完整性校验（同步快速失败，读库开销小）
  const targets = await loadMergedTargets(jobIds)
  if (targets.length < 2) {
    return NextResponse.json({ ok: false, error: '完成的评估作业不足 2 个，无法生成合并报告' }, { status: 400 })
  }

  const uploadId = body.uploadId?.trim() || undefined
  if (uploadId && (!isUploadId(uploadId) || !(await uploadOwnedBy(uploadId, owner)))) {
    return NextResponse.json({ ok: false, error: '无权使用该上传（仅上传者本人可用）' }, { status: 403 })
  }
  // v1.12：异步生成 — LLM 三段式生成耗时分钟级，同步等待会触发网关超时（HTTP 502）。
  // 立即落库 running 记录并返回，后台继续生成，前端轮询 GET 直到终态。
  const record = await db.batchReport.create({
    data: {
      jobIds: JSON.stringify(jobIds),
      uploadId: uploadId ?? null,
      relation: JSON.stringify(relation),
      ownerKey: owner.key,
      ownerMask: owner.mask,
      status: 'running',
    },
  })

  // 后台生成（fire-and-forget；uploadId 归属已在上传流程验证，此处透传可信）
  void runBatchReportGeneration({
    batchReportId: record.id,
    jobIds,
    uploadId,
    relation,
    goal: body.goal,
  })

  return NextResponse.json({
    ok: true,
    batchReport: {
      id: record.id,
      jobIds,
      relation,
      status: 'running',
      markdown: '',
      sequenceAttribution: [],
      createdAt: record.createdAt.toISOString(),
    },
  })
}

/** 后台生成合并报告：传播同源检索 → 聚合上传数据 → LLM 三段式 → markdown/HTML 落库 → 更新终态 */
async function runBatchReportGeneration(ctx: {
  batchReportId: string
  jobIds: string[]
  uploadId?: string
  relation: RelationJudgment
  goal?: string
}): Promise<void> {
  const { batchReportId, jobIds, uploadId, relation } = ctx
  const startedAt = Date.now()
  const fail = async (msg: string) => {
    console.error(`[batch-report] 合并报告生成失败（${batchReportId}）：${msg}`)
    await db.batchReport.update({
      where: { id: batchReportId },
      data: { status: 'error', error: msg.slice(0, 500), updatedAt: new Date() },
    }).catch(() => undefined)
  }
  try {
    // 重新加载（拿到各作业最新持久化数据）
    const targets = await loadMergedTargets(jobIds)
    if (targets.length < 2) return void (await fail('完成的评估作业不足 2 个'))

    // v1.11 同源家族 BLAST 委托结果传播：≥90% 组内代表检索一次，其余成员在此补齐
    // （先于 LLM 生成执行 — 即使 LLM 失败，传播结果也已持久化到各成员作业）
    const propagation = await propagateFamilyBlast(targets, relation)
    if (propagation.shared > 0 || propagation.rescued > 0) {
      console.log(`[batch-report] 家族同源检索传播：共享 ${propagation.shared} 个成员 · 兜底 ${propagation.rescued} 个 — ${propagation.notes.join('；')}`)
    }

    // 上传共享数据（insights + 图片 + 序列归属）
    let insights: FormInsights | null = null
    let images: ParsedImage[] = []
    let assetDir = ''
    let sequenceAttribution: SequenceAttribution[] = []
    if (uploadId && isUploadId(uploadId)) {
      const uploadDir = path.join(process.cwd(), 'db', 'reports', uploadId)
      assetDir = path.join(uploadDir, 'assets')
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(uploadDir, 'parsed.json'), 'utf-8')) as { images?: ParsedImage[] }
        images = parsed.images ?? []
      } catch { /* 图片缺失容错 */ }
      try {
        const data = JSON.parse(await fs.readFile(path.join(uploadDir, 'insights.json'), 'utf-8')) as FormInsights
        if (Array.isArray(data.goals)) insights = data
      } catch { /* insights 可选 */ }
      // v1.10：序列归属服务端重算（评估表序列的去向在合并报告中显性呈现）
      sequenceAttribution = await recomputeAttribution(uploadDir, targets)
    }

    // LLM 生成合并报告（三段式）
    const generated = await generateMergedReport({ targets, relation, goal: ctx.goal, insights, images, sequenceAttribution })

    // v1.22 共有结构（同一 PDB 覆盖多个输入 UniProt 的交集）
    const sharedStructures = computeSharedStructures(targets)

    // markdown + title + 终态落库
    const engineSummary = await getEngineSummary()
    await db.batchReport.update({
      where: { id: batchReportId },
      data: {
        title: generated.title || null,
        markdown: generated.fullMarkdown?.trim() || null,
        sequenceAttribution: sequenceAttribution.length ? JSON.stringify(sequenceAttribution) : null,
        sharedStructures: sharedStructures.length ? JSON.stringify(sharedStructures) : null,
        engine: engineSummary,
        status: 'done',
        error: generated.ok ? null : (generated.errors.join('；').slice(0, 500) || 'LLM 生成失败'),
        updatedAt: new Date(),
      },
    })

    // HTML 始终落盘（LLM 全失败时也渲染结构化数据区块 + warn-box 警示，
    // 用户仍可预览/下载报告 — 结构化数据不依赖 LLM）
    {
      try {
        const html = await renderMergedReportHtml({
          targets,
          relation,
          goal: ctx.goal,
          markdown: generated.fullMarkdown,
          title: generated.title,
          llmOk: generated.ok,
          llmErrors: generated.errors,
          images,
          assetDir,
          batchReportId,
          engineSummary,
          sequenceAttribution,
          sharedStructures,
          insights,
        })
        const dir = path.join(process.cwd(), 'db', 'reports', batchReportId)
        await fs.mkdir(dir, { recursive: true })
        const htmlPath = path.join(dir, 'report.html')
        await fs.writeFile(htmlPath, html, 'utf-8')
        await db.batchReport.update({
          where: { id: batchReportId },
          data: { htmlPath, engine: engineSummary },
        })
      } catch (err) {
        console.error(`[batch-report] HTML 渲染失败（${batchReportId}）：${err instanceof Error ? err.message : String(err)}`)
      }
    }

    console.log(`[batch-report] 合并报告生成完成（${batchReportId}）：${targets.length} 个靶点 · 耗时 ${Math.round((Date.now() - startedAt) / 1000)}s`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await fail(msg)
  }
}

export async function GET(req: Request) {
  const owner = getOwner(req)
  const url = new URL(req.url)
  const id = url.searchParams.get('id')?.trim()

  // 无 id 参数 — 返回当前用户的合并报告列表（v1.13：批量评估历史记录）
  if (!id) {
    const rows = await db.batchReport.findMany({
      where: ownerListFilter(owner),
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: {
        id: true, jobIds: true, status: true, error: true,
        title: true, markdown: true, createdAt: true, updatedAt: true,
      },
    })
    const items = rows.map(r => {
      let jobIds: string[] = []
      try { jobIds = JSON.parse(r.jobIds) } catch { /* ignore */ }
      const md = r.markdown ?? ''
      // v1.14：title 优先取 DB title，fallback 从 markdown 提取，再 fallback 通用标题
      const titleMatch = md.match(/^#\s+(.+)$/m)
      const title = r.title?.trim() || titleMatch?.[1]?.trim() || `合并报告 ${r.id.slice(0, 8)}`
      return {
        id: r.id,
        jobIds,
        title,
        status: r.status === 'done' || r.status === 'error' ? r.status : (r.markdown ? 'done' : 'running'),
        hasContent: md.length > 0,
        createdAt: r.createdAt.toISOString(),
      }
    })
    return NextResponse.json({ ok: true, items })
  }

  const record = await db.batchReport.findUnique({ where: { id } })
  if (!record) return notFound()
  // 归属校验（v2.5：与 request-guard.isOwnedBy 统一两层回退，移除同 IP 段掩码分支 ——
  // 代理重写 XFF 的部署下该分支会让「知道 ID 者皆可访问」）
  if (record.ownerKey && record.ownerKey !== owner.key && record.ownerKey !== owner.ipKey) {
    return notFound()
  }

  // inline 预览模式 — 返回 HTML（允许 iframe 嵌入，用于报告预览 Dialog）
  if (url.searchParams.get('inline') === '1') {
    if (!record.htmlPath) return NextResponse.json({ ok: false, error: '该报告无 HTML 文件' }, { status: 404 })
    try {
      let html = await fs.readFile(record.htmlPath, 'utf-8')
      // v2.11：旧版报告自动升级重渲染（批次速览 / 共有结构突出 / 明细默认折叠）
      if (!html.includes(MERGED_FMT_MARKER)) {
        html = (await upgradedMergedHtml(record)) ?? html
      }
      html = applyUxUpgrade(applyZoomUpgrade(applyResponsiveOverride(html)))
      return new Response(html, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': 'frame-ancestors *;',
        },
      })
    } catch {
      return NextResponse.json({ ok: false, error: '报告文件已过期清理' }, { status: 404 })
    }
  }

  // 下载 HTML 文件
  if (url.searchParams.get('download') === '1') {
    if (!record.htmlPath) return NextResponse.json({ ok: false, error: '该报告无 HTML 文件' }, { status: 404 })
    try {
      let html = await fs.readFile(record.htmlPath, 'utf-8')
      // v2.11：旧版报告自动升级重渲染（与 inline 预览同一份文件 — web 展示与下载一致）
      if (!html.includes(MERGED_FMT_MARKER)) {
        html = (await upgradedMergedHtml(record)) ?? html
      }
      html = applyUxUpgrade(applyZoomUpgrade(applyResponsiveOverride(html)))
      // v2.10 ①：文件名改用报告题目（LLM 生成的描述性标题，如「BTN-TCR 复合物结构解析可行性评估」）
      // — 清洗文件系统非法字符并限长；RFC 5987 filename* 携带中文原题（现代浏览器优先采用），
      // ASCII 回退名仅供不支持 filename* 的旧解析器（前端自动下载已同步优先解析 filename*）
      const titleBase = (record.title ?? '')
        .replace(/[\x00-\x1f\\/:*?"<>|]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[.\s]+$/, '')
        .slice(0, 80)
      const date = new Date().toISOString().slice(0, 10)
      const asciiBase = titleBase && /^[\x20-\x7e]+$/.test(titleBase) ? titleBase : `TargetEval_Merged_${date}`
      const finalBase = titleBase || `merged-report-${record.id.slice(0, 8)}`
      return new Response(html, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Disposition': `attachment; filename="${asciiBase}.html"; filename*=UTF-8''${encodeURIComponent(finalBase)}.html`,
        },
      })
    } catch {
      return NextResponse.json({ ok: false, error: '报告文件已过期清理' }, { status: 404 })
    }
  }

  let jobIds: string[] = []
  let relation: unknown = null
  let sequenceAttribution: SequenceAttribution[] | null = null
  let sharedStructures: SharedStructure[] | null = null
  try { jobIds = JSON.parse(record.jobIds) } catch { /* ignore */ }
  try { relation = JSON.parse(record.relation) } catch { /* ignore */ }
  try { sequenceAttribution = record.sequenceAttribution ? JSON.parse(record.sequenceAttribution) : null } catch { /* ignore */ }
  try { sharedStructures = record.sharedStructures ? JSON.parse(record.sharedStructures) : null } catch { /* ignore */ }

  // v1.12：异步生成状态。
  // 旧记录兼容：db:push 前 status 列被补填为 'running'，但当时同步生成已落 markdown —
  // 有 markdown 的 running 记录视为已完成，避免前端误等。
  const status: 'running' | 'done' | 'error' =
    record.status === 'done' || record.status === 'error'
      ? record.status
      : record.markdown
        ? 'done'
        : 'running'

  // 生成中 — 不做重数据加载（targets 在终态时返回），快速返回
  if (status === 'running') {
    return NextResponse.json({
      ok: true,
      batchReport: {
        id: record.id,
        jobIds,
        relation,
        sequenceAttribution,
        sharedStructures,
        title: record.title ?? '',
        markdown: '',
        status: 'running',
        uploadId: record.uploadId,
        createdAt: record.createdAt,
        targets: [],
      },
    })
  }

  // v1.11：各靶点结构化数据（传播结果已在 POST 时持久化 — 此处直接读库；
  // 作业被 TTL 清理后 targets 为空数组，前端降级为仅展示 markdown）
  let targets: unknown[] = []
  try { targets = (await loadMergedTargets(jobIds)).map(toMergedTargetLite) } catch { /* ignore */ }

  return NextResponse.json({
    ok: true,
    batchReport: {
      id: record.id,
      jobIds,
      relation,
      sequenceAttribution,
      sharedStructures,
      title: record.title ?? '',
      markdown: record.markdown ?? '',
      status,
      error: record.error ?? null,
      llmOk: !record.error,
      errors: record.error ? [record.error] : [],
      uploadId: record.uploadId,
      createdAt: record.createdAt,
      targets,
    },
  })
}
