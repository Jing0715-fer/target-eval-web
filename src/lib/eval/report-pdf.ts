/**
 * 报告 HTML → PDF（服务端 Chromium print-to-PDF）— v2.87
 *
 *  用户需求：「结果除了 HTML 外，增加导出 PDF 的选项，（分页）不要扰乱排版」。
 *  报告模板自 v2.7.6 起内嵌 @media print A4 分页规则（@page 边距 + 分页避让 +
 *  表头跨页重复 + 表格自动布局防右截断），合并报告另有视图全展开 + 每靶点
 *  break-before:page — Chromium print-to-PDF 原生应用同一套规则，HTML 下载版
 *  浏览器打印与服务器导出 PDF 版式完全一致（所见即所得，零新排版逻辑）。
 *
 *  设计要点：
 *  - Playwright chromium 单例复用（alphafold.ts 同款毒丸清理：launch 失败不缓存
 *    被拒 promise，下次重试）；--no-sandbox 沙箱环境必需；
 *  - 串行队列：同时只渲染一份（百 MB 级合并报告在 Chromium 内的内存峰值可观，
 *    并发两份会放大 RSS — 队列化把峰值封在单份）；
 *  - 体积护栏：HTML > 160MB 直接拒绝并给出明确指引（建议下载 HTML 后浏览器
 *    打印为 PDF，版式规则相同）；
 *  - 等待策略：load → 全图片解码完成（data URI 为主，best-effort 超时不阻塞）→
 *    document.fonts.ready（best-effort）→ 300ms 落定 → page.pdf()；
 *  - 页脚页码：「N / M」居中 8px 灰字（Noto Sans SC 回退系统 CJK 字体），
 *    边距与 @page（12mm 10mm 14mm）严格一致 — 页码落在底边距内不压正文。
 */
import type { ReadableStream as WebReadableStream } from 'node:stream/web'

// ── Playwright 类型（最小面 — 只声明用到的 API，避免整包类型耦合）─────────────

interface PdfPageLike {
  setContent(html: string, opts: { waitUntil: 'load' | 'domcontentloaded'; timeout: number }): Promise<void>
  waitForFunction(fn: string, arg: unknown, opts: { timeout: number; polling: number }): Promise<void>
  evaluate<T>(fn: () => T): Promise<T>
  on(event: 'pageerror', fn: (e: Error) => void): void
  on(event: 'console', fn: (msg: { type(): string; text(): string }) => void): void
  pdf(opts: {
    format?: string
    printBackground?: boolean
    preferCSSPageSize?: boolean
    displayHeaderFooter?: boolean
    headerTemplate?: string
    footerTemplate?: string
    margin?: { top?: string; bottom?: string; left?: string; right?: string }
  }): Promise<Buffer>
  close(): Promise<void>
}
interface PdfBrowserLike {
  newPage(): Promise<PdfPageLike>
  close(): Promise<void>
}
interface PdfChromiumLike {
  launch(opts: { args: string[] }): Promise<PdfBrowserLike>
}

const pwPdfGlobal = globalThis as unknown as { __rptPdfBrowser?: Promise<PdfBrowserLike> }

async function getBrowser(): Promise<PdfBrowserLike> {
  const mod = (await import('playwright')) as unknown as { chromium: PdfChromiumLike }
  const p = mod.chromium.launch({
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  })
  // 毒丸清理（alphafold.ts 同款）：launch 失败不把被拒 promise 永久缓在单例里
  pwPdfGlobal.__rptPdfBrowser ??= p
  p.catch(() => { if (pwPdfGlobal.__rptPdfBrowser === p) pwPdfGlobal.__rptPdfBrowser = undefined })
  return pwPdfGlobal.__rptPdfBrowser
}

// ── 串行队列（同时只渲染一份 PDF）───────────────────────────────────────────

let queueTail: Promise<unknown> = Promise.resolve()

/** 把任务排入队列执行（不并发 — 内存峰值封在单份报告） */
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queueTail.then(task, task)
  // 队尾吞掉前序失败，后续任务照常执行
  queueTail = run.then(() => undefined, () => undefined)
  return run
}

// ── PDF 渲染 ────────────────────────────────────────────────────────────────

/** 体积护栏：超过该值的 HTML 拒绝渲染（Chromium 内存峰值 + 渲染时长失控） */
export const PDF_HTML_MAX_BYTES = 160 * 1024 * 1024

/** 页脚模板：居中「N / M」页码（类名 pageNumber/totalPages 由 Chromium 注入） */
const FOOTER_TEMPLATE = `<div style="width:100%;text-align:center;font-size:8px;color:#a8a29e;font-family:'Noto Sans SC','Noto Sans CJK SC',sans-serif;">
<span class="pageNumber"></span>&nbsp;/&nbsp;<span class="totalPages"></span>
</div>`

export interface RenderReportPdfOptions {
  /** 总预算（毫秒）— 大报告（含大量内嵌图）放宽；默认 180s */
  timeoutMs?: number
}

export class ReportPdfTooLargeError extends Error {
  constructor(sizeBytes: number) {
    super(`报告体积 ${(sizeBytes / 1024 / 1024).toFixed(0)}MB 超出 PDF 导出上限（160MB）— 请下载 HTML 后在浏览器中打开，Ctrl/Cmd+P 打印为 PDF（版式规则相同）`)
    this.name = 'ReportPdfTooLargeError'
  }
}

/**
 * 报告 HTML → A4 PDF 字节流。
 * 例外向上抛（调用方转 HTTP 错误响应）；ReportPdfTooLargeError 携带用户可读指引。
 */
export async function renderReportPdf(html: string, opts: RenderReportPdfOptions = {}): Promise<Uint8Array> {
  const timeoutMs = opts.timeoutMs ?? 180_000
  if (Buffer.byteLength(html, 'utf-8') > PDF_HTML_MAX_BYTES) {
    throw new ReportPdfTooLargeError(Buffer.byteLength(html, 'utf-8'))
  }
  return enqueue(async () => {
    const browser = await getBrowser()
    let page: PdfPageLike | null = null
    try {
      page = await browser.newPage()
      page.on('pageerror', e => console.error('[report-pdf] pageerror:', String(e).slice(0, 300)))
      page.on('console', m => { if (m.type() === 'error') console.error('[report-pdf] console.error:', m.text().slice(0, 300)) })
      await page.setContent(html, { waitUntil: 'load', timeout: Math.min(timeoutMs, 90_000) })
      // 全图片解码完成（报告以 data URI 内嵌为主；外部图 best-effort 不阻塞）
      await page
        .waitForFunction('Array.from(document.images).every(function(i){return i.complete})', null, { timeout: 30_000, polling: 250 })
        .catch(() => console.warn('[report-pdf] 图片等待超时（best-effort 继续）'))
      // 字体就绪（Google Fonts 网络字体；失败回退系统 CJK 字体不影响成稿）
      await page.evaluate(() => (document as unknown as { fonts?: { ready: Promise<unknown> } }).fonts?.ready).catch(() => undefined)
      // 布局落定（字体替换/图片解码引起的再排）
      await new Promise(r => setTimeout(r, 300))
      const buf = await page.pdf({
        format: 'A4',
        printBackground: true,
        preferCSSPageSize: true, // @page { size: A4; margin: 12mm 10mm 14mm } 生效
        displayHeaderFooter: true,
        headerTemplate: '<span></span>',
        footerTemplate: FOOTER_TEMPLATE,
        // 与 @page 边距一致 — 页码落在底边距内，正文边距不被页码挤占
        margin: { top: '12mm', bottom: '14mm', left: '10mm', right: '10mm' },
      })
      return new Uint8Array(buf)
    } finally {
      try { await page?.close() } catch { /* ignore */ }
    }
  })
}

// ── 看板（HT Dashboard）打印分页规则 ────────────────────────────────────────
// 看板模板自带 @media print 仅有零星规则（去背景/去悬浮钮），无 @page 边距与分页
// 避让 — PDF 导出时注入本块（与新报告内嵌的 PRINT_PAGE_CSS v2.87 规则同口径，
// 选择器适配看板类名：.gt 统计卡 / .mb-row 方法条 / .mt 主表 / .panel 面板…）。
// 弹出的单靶点完整报告以 <script> 数据载荷内嵌（非 DOM），打印不展开 — 看板
// PDF 即统计 + 总表 + AI 分析的紧凑汇总版。
const DASH_PRINT_MARKER = 'dash-pr-v1'
export const DASHBOARD_PRINT_CSS = `  /* ${DASH_PRINT_MARKER} v2.87 看板 PDF/打印分页（注入）：@page 边距 + 行/卡避让 + 表头跨页重复 */
  @page { size: A4; margin: 12mm 10mm 14mm; }
  @media print {
    body { font-size: 12px; line-height: 1.75; }
    p { orphans: 3; widows: 3; }
    h1, h2, h3, h4 { break-after: avoid-page; }
    .rpt-head, .meta-grid, .panel, .gt, .mb-row, .seqbox, .tg-head, .note, .warn, blockquote, img, figure { break-inside: avoid-page; }
    tr { break-inside: avoid-page; }
    thead { display: table-header-group; }
    table { table-layout: auto !important; min-width: 0 !important; font-size: 9px; }
    th { white-space: normal; overflow: visible; text-overflow: clip; }
    th, td { padding: 4px 6px; }
    .tblwrap, .md-tblwrap { overflow: visible !important; }
    .tblwrap::after, .md-tblwrap::after { display: none !important; }
    .mt-btns, .mt-tools, .seq-copy, .backtop, .no-print { display: none !important; }
    .seq-pre { max-height: none !important; overflow: visible !important; }
  }
`

/** 看板 HTML 注入打印分页规则（幂等 — 已带标记原样返回） */
export function applyDashboardPrintCss(html: string): string {
  if (html.includes(DASH_PRINT_MARKER)) return html
  const h = html.indexOf('</head>')
  if (h < 0) return html
  return `${html.slice(0, h)}<style id="dash-pr">${DASHBOARD_PRINT_CSS}</style>\n${html.slice(h)}`
}

// ── 响应构造助手 ────────────────────────────────────────────────────────────

/** Content-Disposition：.pdf 附件（RFC 5987 中文文件名 + ASCII 回退） */
export function pdfDisposition(asciiBase: string, titleBase: string): string {
  const finalBase = titleBase || asciiBase || 'TargetEval_Report'
  return `attachment; filename="${asciiBase.replace(/[^\x20-\x7e]+/g, '_') || 'TargetEval_Report'}.pdf"; filename*=UTF-8''${encodeURIComponent(finalBase)}.pdf`
}

/** PDF 响应（Uint8Array 一次性回送 — 队列化后内存峰值受控） */
export function pdfResponse(bytes: Uint8Array, disposition: string): Response {
  return new Response(bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': disposition,
      'Cache-Control': 'no-store',
    },
  })
}

/** PDF 失败响应（JSON — 前端 fetch 消费并 toast） */
export function pdfErrorResponse(err: unknown, kind: string): Response {
  const msg = err instanceof ReportPdfTooLargeError
    ? err.message
    : `PDF 生成失败（${err instanceof Error ? err.message.slice(0, 180) : '渲染服务异常'}）— 可下载 HTML 后在浏览器中 Ctrl/Cmd+P 打印为 PDF（版式规则相同）`
  console.error(`[report-pdf] ${kind} 导出失败：`, err instanceof Error ? err.message : err)
  return Response.json({ ok: false, error: msg }, { status: err instanceof ReportPdfTooLargeError ? 413 : 500 })
}

/** 流式 HTML（ht-dashboard 大文件复用现有流式通道）→ 一次性读出字符串（PDF 用） */
export async function readStreamToString(stream: WebReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.byteLength
    if (total > PDF_HTML_MAX_BYTES) {
      await reader.cancel().catch(() => undefined)
      throw new ReportPdfTooLargeError(total)
    }
  }
  const out = Buffer.allocUnsafe(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out.toString('utf-8')
}
