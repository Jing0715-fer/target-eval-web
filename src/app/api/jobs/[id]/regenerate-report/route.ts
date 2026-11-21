/**
 * POST /api/jobs/[id]/regenerate-report — 单靶点报告 LLM 原地重跑（v2.51）
 * GET  /api/jobs/[id]/regenerate-report — 重跑状态查询（前端轮询至终态）
 *
 * 语义（与需求B 合并报告重生成对齐）：
 *  - 沿用作业既有数据（结构 / 同源 / 文献 / 评分不重收集），仅 10 个 LLM 章节
 *    重新生成 + HTML 重新渲染，同一 jobId 原地覆盖；
 *  - 数据上下文来自评估完成时落盘的 db/reports/{id}/llm-ctx.json（v2.51 起写入；
 *    旧作业无快照 → 400 明确提示重新评估，不做降级重跑以免报告失真）；
 *  - 全部章节失败 → 不写任何文件/DB（保留上一版内容），状态置 error；
 *    部分失败 → 照常落盘（reportLlmMissing 记录缺章数，可再次重跑补齐）；
 *  - 作业状态恒为 done（历史列表/配额计数不受影响）；在途去重：进程内
 *    globalThis 注册表（HMR 安全），轮询 GET 可见 running 态。
 * 公网加固：仅创建者（ownerKey 匹配）可操作；他人 404（不暴露存在性）。
 */
import { NextResponse } from 'next/server'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { db } from '@/lib/db'
import { getOwner, isOwnedBy, notFound } from '@/lib/eval/request-guard'
import { sanitizeLlmOverride, runWithLlmOverride, getEngineSummary } from '@/lib/eval/llm-provider'
import { generateReportSections, type ReportContext } from '@/lib/eval/report'
import { renderReportHtml } from '@/lib/eval/report-html'
import { alphafoldStructureFor, alphafoldFigureCached, extractAfDomains } from '@/lib/eval/alphafold'
import { loadCachedEsmfoldModel, esmfoldStructureFor, ESMFOLD_EMBED_MAX_BYTES } from '@/lib/eval/esmfold'
import type { JobSummary, MethodStats, ParsedImage } from '@/lib/eval/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 600

/** llm-ctx.json 快照（pipeline phaseRender 落盘 — 见 pipeline.ts v2.51 注释） */
interface LlmCtxSnapshot {
  v: 1
  ctx: ReportContext
  methodStats: MethodStats
  afFigure: { dataUri: string; modelId: string; globalPlddt: number | null; version: number; fracVeryHigh: number | null } | null
  totalPdbFound: number
  durationMs: number
  assetDir: string
}

interface RegenState {
  state: 'running' | 'done' | 'error'
  startedAt: number
  finishedAt?: number
  /** 成功章节数（done 态） */
  okChapters?: number
  /** 缺章数（部分失败时 >0 — 可再次重跑补齐） */
  missing?: number
  error?: string
}

/** 在途/最近一次重跑状态（globalThis 挂载 — HMR / 多 worker 共享同一实例时成立） */
const g = globalThis as unknown as { __jobReportRegen?: Map<string, RegenState> }
const regenStates = (g.__jobReportRegen ??= new Map<string, RegenState>())

function nowTime(): string {
  return new Date().toTimeString().slice(0, 8)
}

/** 快照形态校验（宽松 — 关键数组/对象缺失即判损坏，防畸形 JSON 进渲染管线） */
function isUsableSnapshot(s: unknown): s is LlmCtxSnapshot {
  const x = s as LlmCtxSnapshot | null
  return Boolean(
    x && x.v === 1 && x.ctx
    && Array.isArray(x.ctx.directPdbs) && Array.isArray(x.ctx.blastHits)
    && Array.isArray(x.ctx.literature) && Array.isArray((x.ctx as { images?: unknown }).images ?? [])
    && x.ctx.scores && x.methodStats,
  )
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const owner = getOwner(req)

  let body: { llm?: { providerKey?: string; baseUrl?: string; apiKey?: string; model?: string } } = {}
  try { body = (await req.json()) as typeof body } catch { /* 空请求体合法（用内置引擎） */ }

  const job = await db.evaluationJob.findUnique({ where: { id } })
  if (!job) return notFound()
  if (!isOwnedBy(job, owner)) return notFound()

  if (job.status !== 'done') {
    return NextResponse.json({ ok: false, error: '仅已完成的评估作业支持原地重跑报告' }, { status: 400 })
  }
  if (!job.reportPath) {
    return NextResponse.json(
      { ok: false, error: '该靶点的报告已并入合并评估报告（关联批次）— 请在合并报告中操作，或整靶点重新评估' },
      { status: 400 },
    )
  }
  const prev = regenStates.get(id)
  if (prev?.state === 'running') {
    return NextResponse.json({ ok: false, error: '该报告正在重新生成中，请等待完成后再试' }, { status: 409 })
  }

  // 数据上下文快照（v2.51 起随报告落盘；旧作业无快照 → 明确引导重新评估）
  let snapshot: LlmCtxSnapshot
  try {
    snapshot = JSON.parse(await fs.readFile(path.join(process.cwd(), 'db', 'reports', id, 'llm-ctx.json'), 'utf-8')) as LlmCtxSnapshot
  } catch {
    return NextResponse.json(
      { ok: false, error: '该报告生成于 v2.51 之前（缺少数据上下文快照），无法原地重跑 — 请重新发起评估（数据会重新收集）' },
      { status: 400 },
    )
  }
  if (!isUsableSnapshot(snapshot)) {
    return NextResponse.json({ ok: false, error: '该报告的数据上下文快照已损坏，无法原地重跑 — 请重新发起评估' }, { status: 400 })
  }

  const startedAt = Date.now()
  regenStates.set(id, { state: 'running', startedAt })
  const llmOverride = sanitizeLlmOverride(body.llm)
  const reportPath = job.reportPath

  void runWithLlmOverride(llmOverride, async () => {
    const ctx = snapshot.ctx
    const fail = (msg: string) => {
      regenStates.set(id, { state: 'error', startedAt, finishedAt: Date.now(), error: msg.slice(0, 400) })
    }
    try {
      // ── 1. LLM 章节全量重跑（无段预算 — 每章独立调用自带超时/重试）──
      const gen = await generateReportSections(ctx, undefined, {})
      const parts = gen.parts
      const okCount = parts.filter(p => p.llmOk).length
      const missing = parts.filter(p => !p.llmOk).length
      if (okCount === 0) {
        fail(`LLM 全部章节生成失败：${parts[0]?.error ?? '未知错误'}`)
        return
      }
      const markdown = gen.fullMarkdown

      // ── 2. 重新渲染 HTML（预测结构视图同管线口径：磁盘缓存优先、降级不阻塞）──
      const engineSummary = await getEngineSummary()
      let alphafoldFigure = snapshot.afFigure ?? undefined
      if (!alphafoldFigure && ctx.alphafold?.available && ctx.uniprot) {
        try {
          const figCached = await alphafoldFigureCached(ctx.uniprot.uniprotId)
          if (figCached) {
            alphafoldFigure = {
              dataUri: 'data:image/png;base64,' + figCached.png.toString('base64'),
              modelId: figCached.meta.modelId,
              globalPlddt: figCached.meta.globalPlddt,
              version: figCached.meta.latestVersion,
              fracVeryHigh: figCached.meta.fracVeryHigh,
            }
          }
        } catch { /* 图缺失 → 视图降级为统计信息，不阻塞 */ }
      }
      let alphafoldStructure: { pdbText: string; uniprotId: string; modelId: string; globalPlddt: number | null; version: number; fracVeryHigh: number | null } | undefined
      if (ctx.alphafold?.available && ctx.uniprot) {
        try {
          const struct = await alphafoldStructureFor(ctx.uniprot.uniprotId)
          if (struct?.embeddable) {
            alphafoldStructure = {
              pdbText: struct.pdbText, uniprotId: struct.uniprotId, modelId: struct.meta.modelId,
              globalPlddt: struct.meta.globalPlddt, version: struct.meta.latestVersion, fracVeryHigh: struct.meta.fracVeryHigh,
            }
          }
        } catch { /* 视图降级，不阻塞 */ }
      }
      let esmfoldStructure: { pdbText: string; modelId: string; globalPlddt: number | null; fracVeryHigh: number | null; sequenceLength: number } | undefined
      if (ctx.esmfold?.available && ctx.esmfold.cacheKey && !ctx.alphafold?.available) {
        try {
          const cached = await loadCachedEsmfoldModel(ctx.esmfold.cacheKey)
          if (cached && cached.pdbText.length <= ESMFOLD_EMBED_MAX_BYTES) {
            esmfoldStructure = {
              pdbText: cached.pdbText, modelId: 'ESMFold v1',
              globalPlddt: ctx.esmfold.globalPlddt ?? null,
              fracVeryHigh: ctx.esmfold.fracVeryHigh ?? null,
              sequenceLength: ctx.esmfold.sequenceLength ?? cached.meta.sequenceLength,
            }
          }
        } catch { /* 缓存丢失 → 在线重取一次（同管线口径），仍失败则视图降级 */ }
      }
      if (ctx.esmfold?.available && ctx.esmfold.cacheKey && !ctx.alphafold?.available && !esmfoldStructure) {
        try {
          const out = await esmfoldStructureFor(ctx.sequence, { timeoutMs: 12_000 })
          if (out.ok && out.embeddable) {
            esmfoldStructure = {
              pdbText: out.pdbText, modelId: 'ESMFold v1',
              globalPlddt: out.stats.meanPlddt, fracVeryHigh: out.stats.fracVeryHigh, sequenceLength: out.stats.length,
            }
          }
        } catch { /* 视图降级，不阻塞 */ }
      }
      const afDomains = alphafoldStructure
        ? extractAfDomains(ctx.uniprot?.features, ctx.uniprot?.sequenceLength)
        : undefined

      const html = await renderReportHtml({
        ctx,
        methodStats: snapshot.methodStats,
        llmMarkdown: markdown,
        llmOk: true,
        llmErrors: parts.filter(p => !p.llmOk).map(p => `${p.label}（${p.key}）: ${p.error}`),
        jobId: id,
        durationMs: snapshot.durationMs,
        totalPdbFound: snapshot.totalPdbFound ?? ctx.directPdbs.length,
        engineSummary,
        alphafoldFigure,
        alphafoldStructure,
        esmfoldStructure,
        afDomains,
        resolveImagePath: (meta: ParsedImage) => {
          const ext = meta.mime.includes('png') ? 'png' : meta.mime.includes('gif') ? 'gif' : meta.mime.includes('webp') ? 'webp' : 'jpg'
          // turbopackIgnore：snapshot.assetDir 为运行时上传目录（db/reports/<uploadId>/assets）
          return path.join(/*turbopackIgnore: true*/ snapshot.assetDir, `${meta.id}.${ext}`)
        },
      })

      // ── 3. 原子替换报告文件（tmp + rename — 并发读取不受半写影响）──
      await fs.writeFile(reportPath + '.tmp', html, 'utf-8')
      await fs.rename(reportPath + '.tmp', reportPath)

      // ── 4. DB：reportMarkdown + summary 章节标记 + 日志追加（历史日志全量保留）──
      let summary: (JobSummary & { reportLlmOk?: boolean; reportLlmMissing?: number }) | null = null
      try { summary = job.summary ? JSON.parse(job.summary) : null } catch { /* ignore */ }
      if (summary) {
        summary.reportLlmOk = okCount > 0 || undefined
        summary.reportLlmMissing = missing || undefined
      }
      let logs: string[] = []
      try { logs = job.logs ? JSON.parse(job.logs) : [] } catch { /* ignore */ }
      if (!Array.isArray(logs)) logs = []
      logs.push(`${nowTime()} [重新生成] LLM 报告原地重跑完成：${okCount}/${parts.length} 章成功${missing > 0 ? `（${missing} 章失败：${parts.filter(p => !p.llmOk).map(p => p.label).join('、')}）` : ''}`)
      if (logs.length > 200) logs.splice(0, logs.length - 200)
      await db.evaluationJob.update({
        where: { id },
        data: {
          reportMarkdown: markdown,
          ...(summary ? { summary: JSON.stringify(summary) } : {}),
          logs: JSON.stringify(logs),
          updatedAt: new Date(),
        },
      }).catch(() => undefined)

      regenStates.set(id, { state: 'done', startedAt, finishedAt: Date.now(), okChapters: okCount, missing })
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err))
    }
  })

  return NextResponse.json({ ok: true, state: 'running' as const })
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const owner = getOwner(req)
  const job = await db.evaluationJob.findUnique({ where: { id }, select: { ownerKey: true, ownerMask: true } })
  if (!job) return notFound()
  if (!isOwnedBy(job, owner)) return notFound()

  const st = regenStates.get(id)
  return NextResponse.json({ ok: true, ...(st ?? { state: 'idle' as const }) })
}
