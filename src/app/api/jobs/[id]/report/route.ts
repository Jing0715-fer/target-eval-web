/**
 * GET /api/jobs/[id]/report — 评估报告 HTML（独立文件）
 * ?download=1 → 触发浏览器下载
 * ?format=pdf → A4 PDF 导出（v2.87：Chromium print-to-PDF，与服务端 HTML 同源
 *   @media print 分页规则 — 卡片/表格行不腰斩、标题不孤行尾；页脚带页码）
 * 公网加固：仅创建者可取报告；他人 404（报告含评估表提取的客户目标等敏感内容）。
 */
import { NextResponse } from 'next/server'
import * as fs from 'node:fs/promises'
import { db } from '@/lib/db'
import { getOwner, isOwnedBy } from '@/lib/eval/request-guard'
import { reportNotFoundResponse } from '@/lib/eval/report-not-found'
import { applyResponsiveOverride, applyZoomUpgrade, applyUxUpgrade, applyTableFilterUpgrade } from '@/lib/eval/report-html'
import { renderReportPdf, pdfResponse, pdfDisposition, pdfErrorResponse } from '@/lib/eval/report-pdf'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const owner = getOwner(req)
  const job = await db.evaluationJob.findUnique({ where: { id }, select: { reportPath: true, status: true, uniprotId: true, title: true, ownerKey: true, ownerMask: true } })
  // v2.57：本链接带被 window.open 直开 / 嵌入 iframe（历史记录、HT 运行记录、离线看板内链）—
  // 404 改返友好 HTML 页（保持 404 状态码；fetch 自动下载按 res.ok 判断不受影响）。
  // 「不存在 / 非本人」同一文案 — 不泄露资源存在性。
  if (!job) return reportNotFoundResponse()
  if (!isOwnedBy(job, owner)) return reportNotFoundResponse()
  if (!job.reportPath || job.status !== 'done') {
    return reportNotFoundResponse({ reason: '报告尚未生成（作业未完成）' })
  }
  let html: string
  try {
    html = await fs.readFile(job.reportPath, 'utf-8')
  } catch {
    return reportNotFoundResponse({ reason: '报告文件已丢失（磁盘数据已被清理或重置）' })
  }
  // v2.7.3：旧报告（无响应式版心标记）注入覆盖 CSS —— 历史作业同样宽屏自适应/移动端自适配；幂等
  html = applyResponsiveOverride(html)
  // v2.7.5：旧报告（无灯箱标记）注入点击放大 CSS+JS —— 历史作业的配体结构式/实验图同样可放大；幂等
  html = applyZoomUpgrade(html)
  // v2.7.6：旧报告（无 UX 标记）注入 A4 打印分页 + InChIKey/SMILES 复制 + 表格横滚指示；幂等
  html = applyUxUpgrade(html)
  // v2.53：旧报告（无/旧表筛选标记）注入或升级 PDB/BLAST 列表筛选排序；幂等
  html = applyTableFilterUpgrade(html)
  const url = new URL(req.url)
  const download = url.searchParams.get('download') === '1'
  // v2.87：PDF 导出（与服务端 HTML 同一份文件 + 同一套打印分页规则）
  if (url.searchParams.get('format') === 'pdf') {
    try {
      const bytes = await renderReportPdf(html)
      const base = (job.uniprotId || (job.title ?? 'target') || 'target').replace(/[^\w-]+/g, '_').slice(0, 40)
      const date = new Date().toISOString().slice(0, 10)
      return pdfResponse(bytes, pdfDisposition(`TargetEval_${base}_${date}`, `TargetEval_${base}_${date}`))
    } catch (err) {
      return pdfErrorResponse(err, `单靶点报告（${id}）`)
    }
  }
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
