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
import { getOwner, isOwnedBy, notFound } from '@/lib/eval/request-guard'
import { uploadOwnedBy, isUploadId } from '@/lib/eval/upload-owner'
import { generateMergedReport, loadMergedTargets, renderMergedReportHtml, toMergedTargetLite } from '@/lib/eval/report-merged'
import { propagateFamilyBlast } from '@/lib/eval/blast-family'
import { getEngineSummary } from '@/lib/eval/llm-provider'
import { fetchUniprotInfo } from '@/lib/eval/uniprot'
import { attributeSequences } from '@/lib/eval/homology'
import type { FormInsights, ParsedImage, ParsedSequence, RelationJudgment, SequenceAttribution } from '@/lib/eval/types'

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

export async function POST(req: Request) {
  const owner = getOwner(req)
  let body: BatchReportBody
  try {
    body = (await req.json()) as BatchReportBody
  } catch {
    return NextResponse.json({ ok: false, error: '请求体不是合法 JSON' }, { status: 400 })
  }

  const jobIds = (body.jobIds ?? []).filter(Boolean).slice(0, 6)
  const relation = body.relation
  if (jobIds.length < 2) {
    return NextResponse.json({ ok: false, error: '合并报告至少需要 2 个评估作业' }, { status: 400 })
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

  // 加载数据完整的已完成作业
  const targets = await loadMergedTargets(jobIds)
  if (targets.length < 2) {
    return NextResponse.json({ ok: false, error: '完成的评估作业不足 2 个，无法生成合并报告' }, { status: 400 })
  }

  // v1.11 同源家族 BLAST 委托结果传播：≥90% 组内代表检索一次，其余成员在此补齐
  // （先于 LLM 生成执行 — 即使 LLM 失败，传播结果也已持久化到各成员作业）
  const propagation = await propagateFamilyBlast(targets, relation)
  if (propagation.shared > 0 || propagation.rescued > 0) {
    console.log(`[batch-report] 家族同源检索传播：共享 ${propagation.shared} 个成员 · 兜底 ${propagation.rescued} 个 — ${propagation.notes.join('；')}`)
  }

  // 上传共享数据（insights + 图片 + 序列归属）
  const uploadId = body.uploadId?.trim() || undefined
  let insights: FormInsights | null = null
  let images: ParsedImage[] = []
  let assetDir = ''
  let sequenceAttribution: SequenceAttribution[] = []
  if (uploadId && isUploadId(uploadId) && (await uploadOwnedBy(uploadId, owner))) {
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
  const generated = await generateMergedReport({ targets, relation, goal: body.goal, insights, images, sequenceAttribution })

  // 落库 + HTML 落盘
  const record = await db.batchReport.create({
    data: {
      jobIds: JSON.stringify(jobIds),
      uploadId: uploadId ?? null,
      relation: JSON.stringify(relation),
      sequenceAttribution: sequenceAttribution.length ? JSON.stringify(sequenceAttribution) : null,
      markdown: generated.fullMarkdown?.trim() || null,
      ownerKey: owner.key,
      ownerMask: owner.mask,
    },
  })
  let htmlPath: string | null = null
  if (generated.fullMarkdown.trim()) {
    const engineSummary = await getEngineSummary()
    const html = await renderMergedReportHtml({
      targets,
      relation,
      goal: body.goal,
      markdown: generated.fullMarkdown,
      llmOk: generated.ok,
      llmErrors: generated.errors,
      images,
      assetDir,
      batchReportId: record.id,
      engineSummary,
      sequenceAttribution,
    })
    const dir = path.join(process.cwd(), 'db', 'reports', record.id)
    await fs.mkdir(dir, { recursive: true })
    htmlPath = path.join(dir, 'report.html')
    await fs.writeFile(htmlPath, html, 'utf-8')
    await db.batchReport.update({
      where: { id: record.id },
      data: { htmlPath, engine: engineSummary },
    })
  }

  return NextResponse.json({
    ok: true,
    batchReport: {
      id: record.id,
      jobIds,
      relation,
      sequenceAttribution,
      markdown: generated.fullMarkdown,
      llmOk: generated.ok,
      errors: generated.errors,
      createdAt: record.createdAt,
      /** 各靶点结构化数据（v1.11 — PDB/同源结构/文献列表带 UniProt 归属，网页合并视图展示） */
      targets: targets.map(toMergedTargetLite),
    },
  })
}

export async function GET(req: Request) {
  const owner = getOwner(req)
  const url = new URL(req.url)
  const id = url.searchParams.get('id')?.trim()
  if (!id) return NextResponse.json({ ok: false, error: '缺少 id 参数' }, { status: 400 })

  const record = await db.batchReport.findUnique({ where: { id } })
  if (!record) return notFound()
  if (record.ownerKey && record.ownerKey !== owner.key) return notFound()

  // 下载 HTML 文件
  if (url.searchParams.get('download') === '1') {
    if (!record.htmlPath) return NextResponse.json({ ok: false, error: '该报告无 HTML 文件' }, { status: 404 })
    try {
      const html = await fs.readFile(record.htmlPath, 'utf-8')
      return new Response(html, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Disposition': `attachment; filename="merged-report-${record.id.slice(0, 8)}.html"`,
        },
      })
    } catch {
      return NextResponse.json({ ok: false, error: '报告文件已过期清理' }, { status: 404 })
    }
  }

  let jobIds: string[] = []
  let relation: unknown = null
  let sequenceAttribution: SequenceAttribution[] | null = null
  try { jobIds = JSON.parse(record.jobIds) } catch { /* ignore */ }
  try { relation = JSON.parse(record.relation) } catch { /* ignore */ }
  try { sequenceAttribution = record.sequenceAttribution ? JSON.parse(record.sequenceAttribution) : null } catch { /* ignore */ }

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
      markdown: record.markdown,
      uploadId: record.uploadId,
      createdAt: record.createdAt,
      targets,
    },
  })
}
