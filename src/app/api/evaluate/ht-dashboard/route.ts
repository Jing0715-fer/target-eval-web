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
import { runWithLlmOverride, sanitizeLlmOverride, getEngineSummary } from '@/lib/eval/llm-provider'
import type { HtDashboard } from '@prisma/client'
import {
  loadHtDashboardRows,
  computeHtStats,
  generateHtDashboardReport,
  renderHtDashboardHtml,
  resolveZipHrefs,
  htDashboardTitle,
  type HtDashboardEntry,
} from '@/lib/eval/ht-dashboard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 600

interface DashboardBody {
  entries?: unknown
  goal?: string
  llm?: { providerKey?: string; baseUrl?: string; apiKey?: string; model?: string }
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

  // 归属校验：全部作业须为本人创建（merged 条目在 zip 规划时按 DB 归属读取，此处校验 job）
  const jobs = await db.evaluationJob.findMany({ where: { id: { in: jobIds } }, select: { id: true, ownerKey: true, ownerMask: true } })
  if (jobs.length !== jobIds.length) return notFound()
  for (const j of jobs) {
    if (!isOwnedBy(j, owner)) return notFound()
  }
  // 至少 1 个已完成作业（可统计）
  const doneCount = await db.evaluationJob.count({ where: { id: { in: jobIds }, status: 'done' } })
  if (doneCount === 0) {
    return NextResponse.json({ ok: false, error: '没有已完成的评估作业（统计看板需要至少 1 个成功靶点）' }, { status: 400 })
  }

  const record = await db.htDashboard.create({
    data: {
      jobIds: JSON.stringify(jobIds),
      entries: JSON.stringify(entries),
      goal: body.goal?.trim().slice(0, 500) || null,
      ownerKey: owner.key,
      ownerMask: owner.mask,
      status: 'running',
    },
  })

  // 后台生成（LLM 在用户引擎作用域内；失败静默降级 — 统计/规则结论不受影响）
  const llmOverride = sanitizeLlmOverride(body.llm)
  void runWithLlmOverride(llmOverride, () => runDashboardGeneration({
    dashboardId: record.id,
    entries,
    goal: body.goal?.trim().slice(0, 500),
    origin: new URL(req.url).origin,
  }))

  return NextResponse.json({ ok: true, dashboard: { id: record.id, status: 'running', jobIds } })
}

/** 后台生成：行加载 → 统计 → LLM（报告 + 每靶点结论）→ HTML 落盘 → 终态 */
async function runDashboardGeneration(ctx: {
  dashboardId: string
  entries: HtDashboardEntry[]
  goal?: string
  origin: string
}): Promise<void> {
  const { dashboardId, entries, goal } = ctx
  const startedAt = Date.now()
  const fail = async (msg: string) => {
    await db.htDashboard.update({
      where: { id: dashboardId },
      data: { status: 'error', error: msg.slice(0, 500), updatedAt: new Date() },
    }).catch(() => undefined)
  }
  try {
    const { rows, jobCount } = await loadHtDashboardRows(entries)
    if (rows.length === 0) return void (await fail('没有可统计的已完成靶点'))
    const stats = computeHtStats(rows, jobCount)
    const generated = await generateHtDashboardReport(rows, stats, goal)
    const engineSummary = await getEngineSummary()
    // zip 相对链接（与 ht-archive 命名同源 — 解压后 G01/xxx.html 可点）
    const zipHrefs = await resolveZipHrefs(entries)
    for (const r of rows) r.zipHref = zipHrefs.get(r.jobId)

    const generatedAt = new Date().toISOString().replace('T', ' ').slice(0, 16)
    const title = htDashboardTitle(jobCount, generatedAt)
    const html = renderHtDashboardHtml({
      title,
      goal,
      rows,
      stats,
      verdicts: generated.verdicts,
      markdown: generated.markdown,
      llmOk: generated.ok,
      llmErrors: generated.errors,
      engineSummary,
      origin: ctx.origin,
      generatedAt,
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
    console.log(`[ht-dashboard] 统计看板生成完成（${dashboardId}）：${rows.length} 个靶点 · AI 报告 ${generated.ok ? '成功' : '降级'} · 耗时 ${Math.round((Date.now() - startedAt) / 1000)}s`)
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
  if (!/^[a-z0-9]{20,40}$/i.test(id)) return notFound('看板不存在')
  let record: HtDashboard | null = null
  try {
    record = await db.htDashboard.findUnique({ where: { id } })
  } catch {
    return notFound('看板不存在')
  }
  if (!record) return notFound('看板不存在')
  if (record.ownerKey && record.ownerKey !== owner.key && record.ownerKey !== owner.ipKey) {
    return notFound('看板不存在')
  }

  if (url.searchParams.get('inline') === '1' || url.searchParams.get('download') === '1') {
    if (!record.htmlPath) return NextResponse.json({ ok: false, error: '该看板无 HTML 文件' }, { status: 404 })
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
      return NextResponse.json({ ok: false, error: '看板文件已过期清理' }, { status: 404 })
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
