'use client'

/**
 * 报告下载菜单（v2.87 · v2.88 连续长页）—「下载报告 ▾」下拉：HTML / PDF 双格式。
 *
 *  用户需求：「结果除了 HTML 外，增加导出 PDF 的选项」+「pdf 能完全不分页吗？
 *  格式尽量和 html 保持一致」。
 *  - HTML：沿用既有通道（window.open 服务端文件流，即时下载；浏览器 Ctrl/Cmd+P
 *    可另存 A4 分页 PDF — 打印归档由它承担）；
 *  - PDF：服务端 Chromium print-to-PDF · 连续长页 — 纸张 = 内容实测尺寸，整份
 *    报告一页装下（零页断点零页码）；按屏幕媒体渲染，版式与网页版一致。渲染
 *    数秒到数十秒 — fetch blob 另存，按钮即时反馈生成中/完成/失败（toast），
 *    期间可关闭菜单继续浏览；
 *  - PDF 不可用（本地缓存副本 / 无状态内联报告无服务端文件）→ 退化为单按钮
 *    （保持既有 HTML/Markdown 降级行为，不出现死选项）。
 */

import { useState } from 'react'
import { ChevronDown, Download, FileText, LoaderCircle } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { toast } from '@/hooks/use-toast'
import { downloadReportPdf } from './api'
import { cn } from '@/lib/utils'

export interface ReportDownloadMenuProps {
  /** HTML 下载动作（服务端报告 = window.open URL；缓存副本/无状态 = 回调走 blob 另存） */
  onDownloadHtml: () => void
  /** PDF 接口相对路径（null = 无服务端文件，不提供 PDF 选项） */
  pdfUrl: string | null
  /** PDF 兜底文件名（响应缺 Content-Disposition 时） */
  pdfFallbackName?: string
  /** 触发按钮文案 */
  label?: string
  /** 尺寸：sm = 内嵌工具条（h-8）；default = 结果卡（h-10） */
  size?: 'sm' | 'default'
  /** PDF 选项附注（如合并报告题目截断） */
  pdfNote?: string
  className?: string
}

export function ReportDownloadMenu({
  onDownloadHtml,
  pdfUrl,
  pdfFallbackName = 'TargetEval_Report',
  label = '下载报告',
  size = 'sm',
  pdfNote,
  className,
}: ReportDownloadMenuProps) {
  const [pdfBusy, setPdfBusy] = useState(false)

  const exportPdf = async () => {
    if (!pdfUrl || pdfBusy) return
    setPdfBusy(true)
    toast({
      title: '正在生成 PDF…',
      description: '服务端按网页版式渲染连续长页 PDF（整份报告一页装下、不分页），约数秒到一分钟，取决于报告长度。',
    })
    try {
      await downloadReportPdf(pdfUrl, pdfFallbackName)
      toast({ title: 'PDF 已导出', description: '已保存到浏览器下载目录（与 HTML 报告同一份内容 · 连续长页不分页 · 版式同网页版）。' })
    } catch (e) {
      toast({
        title: 'PDF 导出失败',
        description: e instanceof Error ? e.message : '服务暂时不可用，请稍后重试。',
        variant: 'destructive',
      })
    } finally {
      setPdfBusy(false)
    }
  }

  // PDF 不可用：单按钮（保持既有行为 — 缓存副本 Markdown / 无状态 HTML blob）
  if (!pdfUrl) {
    return (
      <button
        type="button"
        onClick={onDownloadHtml}
        className={cn(
          size === 'sm'
            ? 'inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 font-mono text-[11px] transition-all hover:border-primary/40 active:scale-[0.98]'
            : 'inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-card px-4 transition-all hover:border-primary/40 active:scale-[0.98]',
          className,
        )}
      >
        <Download className={size === 'sm' ? 'size-3.5' : 'size-4'} aria-hidden />
        {label}
      </button>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={pdfBusy}
        className={cn(
          'group inline-flex items-center gap-1.5 rounded-lg border border-border bg-card outline-none transition-all hover:border-primary/40 focus-visible:ring-[3px] focus-visible:ring-ring/30 active:scale-[0.98] disabled:cursor-progress disabled:opacity-70',
          size === 'sm' ? 'h-8 px-2.5 font-mono text-[11px]' : 'h-10 px-4 text-sm font-medium',
          className,
        )}
      >
        {pdfBusy ? (
          <LoaderCircle className={cn('animate-spin text-primary', size === 'sm' ? 'size-3.5' : 'size-4')} aria-hidden />
        ) : (
          <Download className={size === 'sm' ? 'size-3.5' : 'size-4'} aria-hidden />
        )}
        {pdfBusy ? 'PDF 生成中…' : label}
        {!pdfBusy && <ChevronDown className="size-3 text-muted-foreground/70 transition-transform group-data-[state=open]:rotate-180" aria-hidden />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[240px]">
        <DropdownMenuLabel className="text-[10.5px] font-medium tracking-wide text-muted-foreground">
          选择导出格式
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={onDownloadHtml}
          className="gap-2.5 py-2.5"
        >
          <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium">HTML 报告（.html）</div>
            <div className="text-[11px] text-muted-foreground">离线自包含 · 交互完整（折叠/复制/弹出页）</div>
          </div>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => void exportPdf()}
          disabled={pdfBusy}
          className="gap-2.5 py-2.5"
        >
          {pdfBusy ? (
            <LoaderCircle className="size-4 shrink-0 animate-spin text-primary" aria-hidden />
          ) : (
            <FileText className="size-4 shrink-0 text-primary" aria-hidden />
          )}
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium">PDF 报告（.pdf）</div>
            <div className="text-[11px] text-muted-foreground">
              连续长页 · 不分页 · 版式同网页版{pdfNote ? ` · ${pdfNote}` : ' · 适合阅读分享'}
            </div>
          </div>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
