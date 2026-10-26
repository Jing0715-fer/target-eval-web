/**
 * GET /api/jobs/[id]/report — 评估报告 HTML（独立文件）
 * ?download=1 → 触发浏览器下载
 * 公网加固：仅创建者可取报告；他人 404（报告含评估表提取的客户目标等敏感内容）。
 */
import { NextResponse } from 'next/server'
import * as fs from 'node:fs/promises'
import { db } from '@/lib/db'
import { getOwner, isOwnedBy, notFound } from '@/lib/eval/request-guard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const owner = getOwner(req)
  const job = await db.evaluationJob.findUnique({ where: { id }, select: { reportPath: true, status: true, uniprotId: true, title: true, ownerKey: true, ownerMask: true } })
  if (!job) return notFound()
  if (!isOwnedBy(job, owner)) return notFound()
  if (!job.reportPath || job.status !== 'done') {
    return NextResponse.json({ error: '报告尚未生成（作业未完成）' }, { status: 404 })
  }
  let html: string
  try {
    html = await fs.readFile(job.reportPath, 'utf-8')
  } catch {
    return NextResponse.json({ error: '报告文件已丢失' }, { status: 404 })
  }
  const url = new URL(req.url)
  const download = url.searchParams.get('download') === '1'
  const headers: Record<string, string> = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    // 注意：不能设置 X-Frame-Options: SAMEORIGIN ——
    // 应用常被嵌入外部预览面板（外层 iframe 与本应用不同源），
    // 该头会导致祖先链跨源时报告预览 iframe 被浏览器拦截（表现为预览空白、仅能下载）。
    // 资源已按创建者 IP 隔离且 jobId 为不可猜测的 cuid，允许任意嵌入是安全的。
    'Content-Security-Policy': 'frame-ancestors *;',
  }
  if (download) {
    const base = (job.uniprotId || (job.title ?? 'target') || 'target').replace(/[^\w-]+/g, '_').slice(0, 40)
    const date = new Date().toISOString().slice(0, 10)
    headers['Content-Disposition'] = `attachment; filename="TargetEval_${base}_${date}.html"; filename*=UTF-8''TargetEval_${encodeURIComponent(base)}_${date}.html`
  }
  return new NextResponse(html, { status: 200, headers })
}
