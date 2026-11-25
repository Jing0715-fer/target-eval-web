/**
 * 报告 HTML → PDF（服务端 Chromium print-to-PDF · 连续长页不分页）— v2.88
 *
 *  用户需求（v2.87 新增 PDF 导出后的实测反馈）：「pdf 能完全不分页吗？格式尽量
 *  和 html 保持一致」。本版把 PDF 从「A4 分页打印版」改为「连续长页」：
 *  - 单页连续：纸张尺寸 = 内容实测尺寸（宽 = .page 版心、高 = 全文高度）+
 *    pageRanges '1' + 高度 8px 裕量 — 整份报告一页装下，零页断点、零页码；
 *  - 版式 = 网页版：page.emulateMedia('screen') 让 print-to-PDF 按**屏幕媒体**
 *    渲染 — 与浏览器打开 HTML 的观感一致（字号/配色/间距/表格列宽原样），
 *    @media print 的 A4 压缩规则（12px 正文/9.5px 表格）全部不参与；
 *  - 版心冻结：.page 宽度/内边距与 body 字号在页内实测后以 !important 钉死 —
 *    印刷重排宽度（= 纸张宽）与测量视口不同时命中的媒体查询档位不同（如
 *    920px 版心落入 max-width:1024 档收紧 padding），钉死后版式不漂移；
 *  - 静态化注入（与打印口径同源）：
 *      · 合并报告 .rpt-view 视图全展开（首页 + 各靶点报告页连续呈现，不分页）；
 *      · BLAST PDB/nr 两库面板全展开（CDP print 不派发 beforeprint — 页内等价
 *        移除 [data-libpanel] 的 hidden 属性）；
 *      · 表格 3 行截断（.t-clamp）恢复全文 — 内容完整入档；
 *      · 交互控件隐藏（复制/放大/回顶/工具条/库切换钮 — 静态 PDF 中的死按钮）；
 *      · AF 交互 3D 视图回退静态 poster（headless WebGL 不确定，poster 确定性）；
 *      · 懒加载图转立即加载（打印管线强制加载全部图，屏幕媒体不会 — 折叠
 *        视口外的 loading=lazy 图必须显式取数，否则连续长页下方图片缺失）；
 *      · 数据表防截断：横向滚动容器在 PDF 里不可滚 — 溢出改可见，看板宽表
 *        （.tblwrap/.md-tblwrap）自动布局换行（报告 .tbl-wrap 表 ≤ 版心宽，
 *        固定列宽原样保留，个别 24px 溢出由 .page 内边距吸收）；
 *  - 物理极限兜底：Chromium/PDF 单页 ≤ ~200in（96dpi ≈ 19200px）— 内容更高
 *    时（百靶点级报告）退化为「最少分页」：页高 19008px 的连续长条，仅在
 *    物理极限处断页，并注入分页避让（行/图不腰斩、标题不孤行尾、卡片整卡）；
 *  - v2.87 基建保留：Playwright chromium 单例 + 毒丸清理（launch 失败不缓存
 *    被拒 promise）、串行队列（内存峰值封在单份）、160MB 体积护栏、
 *    load → 图片解码 → fonts.ready → 落定的等待策略。
 *  HTML 下载后的浏览器 Ctrl/Cmd+P 仍是 A4 分页版（打印归档场景由它承担）。
 */
import type { ReadableStream as WebReadableStream } from 'node:stream/web'

// ── Playwright 类型（最小面 — 只声明用到的 API，避免整包类型耦合）─────────────

interface PdfPageLike {
  setContent(html: string, opts: { waitUntil: 'load' | 'domcontentloaded'; timeout: number }): Promise<void>
  waitForFunction(fn: string, arg: unknown, opts: { timeout: number; polling: number }): Promise<void>
  /** 连续长页关键：按屏幕媒体渲染（print-to-PDF 默认 print 媒体 — 版式会走 A4 压缩规则） */
  emulateMedia(opts: { media: 'screen' | 'print' }): Promise<void>
  setViewportSize(size: { width: number; height: number }): Promise<void>
  evaluate<T>(fn: (arg: never) => T | Promise<T>, arg?: unknown): Promise<T>
  on(event: 'pageerror', fn: (e: Error) => void): void
  on(event: 'console', fn: (msg: { type(): string; text(): string }) => void): void
  pdf(opts: {
    width?: string
    height?: string
    pageRanges?: string
    printBackground?: boolean
    preferCSSPageSize?: boolean
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

// ── 连续长页常量 ─────────────────────────────────────────────────────────────

/** 体积护栏：超过该值的 HTML 拒绝渲染（Chromium 内存峰值 + 渲染时长失控） */
export const PDF_HTML_MAX_BYTES = 160 * 1024 * 1024

/** 单页/长条页高上限（px）— Chromium printToPDF 纸张 ~200in 上限（96dpi=19200px）留安全余量（198in） */
export const PDF_MAX_PAGE_PX = 19_008

/** 测量视口宽（px）— 桌面基准：报告 .page 版心 1224（≥1440 档）/ 看板 980-1224 */
const MEASURE_VIEWPORT_W = 1440

/** 超上限内容的长条分页避让（与 PRINT_PAGE_DELTA_CSS 同源选择器 — 无 @media 包裹，屏幕媒体下生效） */
const SEGMENT_BREAK_CSS = `/* rpt-cont-v1 长条分页避让：行/图不腰斩 + 标题不孤行尾 + 卡片整卡 */
  tr, img, figure { break-inside: avoid; }
  h1, h2, h3, h4, h5 { break-after: avoid; }
  .rpt-head, .glance, .toc, .score-row, .score-rationale, .fig, .lig-card, .lit-item,
  .callout, .warn-box, .cx-card, .cx-shared, .cx-solo-comp, .oligo-strip, .oligo-card, .llm-adj-strip,
  .lig-ident, .cov-fig, blockquote,
  .glance-grid, .glance-tiles, .meta-grid, .fig-grid, .lig-grid,
  .af-stage, .af-poster, .af-fig, .seqbox, .tgt-card, .rel-box, .qa-ans, .note { break-inside: avoid; }`

/** 版心实测值（页内 getComputedStyle 采样 — 印刷重排时钉死用） */
interface PageMetrics {
  /** .page 版心宽（px）；无 .page（未知模板）回退视口宽 */
  pw: number
  /** .page 四向内边距（"top right bottom left" 计算值串） */
  pad: string
  /** body 字号计算值（响应式档位随版心微升 — 跨档位重排时冻结） */
  bfs: string
}

/** 连续长页注入 CSS：版心冻结 + 视图/面板全展开 + 交互静态化 + 表格防截断 */
function buildContinuousCss(m: PageMetrics): string {
  // 版心钉死（值来自页内实测；越界值视为异常布局不钉，走视口宽回退）
  const pin = m.pw > 400 && m.pw <= 4096
    ? `  html, body { margin: 0 !important; }
  body { font-size: ${m.bfs} !important; }
  .page { margin: 0 !important; max-width: none !important; width: ${m.pw}px !important;${m.pad ? ` padding: ${m.pad} !important;` : ''} min-height: 0 !important; }
`
    : ''
  return `/* rpt-cont-v1 连续长页版式（v2.88 PDF 导出）*/
${pin}  /* 合并报告视图全展开（首页 + 各靶点报告页连续呈现 — 不分页） */
  .rpt-view { display: block !important; }
  /* 表格防截断：横向滚动容器在 PDF 不可滚 — 溢出改可见；看板宽表自动布局换行
     （报告 .tbl-wrap 表 ≤ 版心宽，固定列宽原样 — 个别 24px 溢出由 .page 内边距吸收） */
  .tbl-wrap, .tblwrap, .md-tblwrap { overflow: visible !important; }
  .tbl-wrap::before, .tbl-wrap::after, .tblwrap::after { display: none !important; }
  .tblwrap table, .md-tblwrap table { table-layout: auto !important; min-width: 0 !important; }
  .tblwrap th, .md-tblwrap th { white-space: normal; }
  /* 屏显 3 行截断恢复全文（内容完整入档） */
  .t-clamp { display: block !important; -webkit-line-clamp: unset !important; overflow: visible !important; }
  /* 交互控件静态化（与打印口径同源 — 静态 PDF 中的死按钮不出镜） */
  .copy-btn, .rpt-zoom-badge, .backtop, .af-expand, .af-fullwrap, .rpt-zoom,
  .af-tb-sel, .tbl-ctl, .lib-toggle, .mt-btns, .mt-tools, .seq-copy, .no-print { display: none !important; }
  /* AF 交互 3D → 静态 poster（headless WebGL 不确定 — poster 确定性；无图除外） */
  .af-stage .af-canvas, .af-stage .af-tb { display: none !important; }
  .af-stage .af-poster[src], .af-stage.af-live .af-poster[src] { display: block !important; }
  /* 看板序列折叠区展开 */
  .seq-pre { max-height: none !important; overflow: visible !important; }`
}

export interface RenderReportPdfOptions {
  /** 总预算（毫秒）— 大报告（含大量内嵌图）放宽；默认 180s */
  timeoutMs?: number
}

export class ReportPdfTooLargeError extends Error {
  constructor(sizeBytes: number) {
    super(`报告体积 ${(sizeBytes / 1024 / 1024).toFixed(0)}MB 超出 PDF 导出上限（160MB）— 请下载 HTML 离线查看（浏览器 Ctrl/Cmd+P 可另存 A4 分页 PDF）`)
    this.name = 'ReportPdfTooLargeError'
  }
}

/**
 * 报告 HTML → 连续长页 PDF 字节流（单页装下整份报告；超物理上限时最少分页长条）。
 * 例外向上抛（调用方转 HTTP 错误响应）；ReportPdfTooLargeError 携带用户可读指引。
 */
export async function renderReportPdf(html: string, opts: RenderReportPdfOptions = {}): Promise<Uint8Array> {
  const timeoutMs = opts.timeoutMs ?? 180_000
  const htmlBytes = Buffer.byteLength(html, 'utf-8')
  if (htmlBytes > PDF_HTML_MAX_BYTES) {
    throw new ReportPdfTooLargeError(htmlBytes)
  }
  return enqueue(async () => {
    const browser = await getBrowser()
    let page: PdfPageLike | null = null
    try {
      page = await browser.newPage()
      page.on('pageerror', e => console.error('[report-pdf] pageerror:', String(e).slice(0, 300)))
      page.on('console', m => { if (m.type() === 'error') console.error('[report-pdf] console.error:', m.text().slice(0, 300)) })
      // ① 屏幕媒体 + 桌面基准视口 — 版式与浏览器打开 HTML 一致（@media print 规则全部不参与）
      await page.emulateMedia({ media: 'screen' })
      await page.setViewportSize({ width: MEASURE_VIEWPORT_W, height: 900 })
      await page.setContent(html, { waitUntil: 'load', timeout: Math.min(timeoutMs, 90_000) })
      // ② 懒加载图转立即（打印管线强制加载全部图，屏幕媒体不会 — 连续长页下方图不缺失）
      await page
        .evaluate(() => {
          document.querySelectorAll('img[loading]').forEach(el => el.setAttribute('loading', 'eager'))
        })
        .catch(() => undefined)
      // ③ 全图片解码完成（报告以 data URI 内嵌为主；外部图 best-effort 不阻塞）
      await page
        .waitForFunction('Array.from(document.images).every(function(i){return i.complete})', null, { timeout: 30_000, polling: 250 })
        .catch(() => console.warn('[report-pdf] 图片等待超时（best-effort 继续）'))
      // 字体就绪（Google Fonts 网络字体；失败回退系统 CJK 字体不影响成稿）
      await page.evaluate(() => (document as unknown as { fonts?: { ready: Promise<unknown> } }).fonts?.ready).catch(() => undefined)
      // 布局落定（字体替换/图片解码引起的再排）
      await new Promise(r => setTimeout(r, 300))
      // ④ 版心实测（.page 宽度/内边距 + body 字号）→ 注入连续版式 CSS + 展开折叠面板
      const m: PageMetrics = await page.evaluate(() => {
        const de = document.documentElement
        const b = document.body
        const pg = document.querySelector('.page')
        const cs = pg ? window.getComputedStyle(pg) : null
        return {
          pw: pg ? Math.ceil(pg.getBoundingClientRect().width) : Math.ceil(de.getBoundingClientRect().width) || 1440,
          pad: cs ? `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}` : '',
          bfs: b ? window.getComputedStyle(b).fontSize : '15px',
        }
      })
      const css = buildContinuousCss(m)
      await page.evaluate((payload: { css: string }) => {
        const st = document.createElement('style')
        st.setAttribute('data-marker', 'rpt-cont-v1')
        st.textContent = payload.css
        document.head.appendChild(st)
        // BLAST PDB/nr 两库面板全展开 — beforeprint 等价（CDP print 不派发打印事件）
        document.querySelectorAll('[data-libpanel][hidden]').forEach(p => p.removeAttribute('hidden'))
      }, { css })
      // 视图/面板展开 + 版心钉死后的再排落定
      await new Promise(r => setTimeout(r, 250))
      // ⑤ 全文高度实测（展开 + 钉死后的终态）
      const h = await page.evaluate(() => {
        const de = document.documentElement
        const b = document.body
        return Math.ceil(Math.max(de.scrollHeight, b ? b.scrollHeight : 0))
      })
      const w = Math.max(400, Math.min(m.pw || MEASURE_VIEWPORT_W, 4096))
      const mb = { top: '0px', bottom: '0px', left: '0px', right: '0px' }
      let buf: Buffer
      if (h <= PDF_MAX_PAGE_PX) {
        // ⑥ 单页连续：纸张 = 内容尺寸（+8px 裕量防舍入溢页；pageRanges '1' 兜底截断 1px 溢条）
        buf = await page.pdf({
          width: `${w}px`,
          height: `${Math.min(h + 8, PDF_MAX_PAGE_PX)}px`,
          printBackground: true,
          preferCSSPageSize: false,
          pageRanges: '1',
          margin: mb,
        })
        console.info(`[report-pdf] 连续长页 ${w}×${h}px · 单页 · HTML ${(htmlBytes / 1024 / 1024).toFixed(1)}MB`)
      } else {
        // ⑥' 物理极限兜底：19008px 连续长条 × 最少页数（断点避让 — 行/图不腰斩）
        await page
          .evaluate((c: string) => {
            const st = document.createElement('style')
            st.setAttribute('data-marker', 'rpt-cont-seg')
            st.textContent = c
            document.head.appendChild(st)
          }, SEGMENT_BREAK_CSS)
          .catch(() => undefined)
        await new Promise(r => setTimeout(r, 150))
        buf = await page.pdf({
          width: `${w}px`,
          height: `${PDF_MAX_PAGE_PX}px`,
          printBackground: true,
          preferCSSPageSize: false,
          margin: mb,
        })
        console.info(`[report-pdf] 连续长条 ${w}×${PDF_MAX_PAGE_PX}px × ${Math.ceil(h / PDF_MAX_PAGE_PX)} 页（内容 ${h}px 超单页物理上限）· HTML ${(htmlBytes / 1024 / 1024).toFixed(1)}MB`)
      }
      return new Uint8Array(buf)
    } finally {
      try { await page?.close() } catch { /* ignore */ }
    }
  })
}

// ── 看板（HT Dashboard）打印分页规则（浏览器 Ctrl+P 归档路径）────────────────
// 看板模板自带 @media print 仅有零星规则（去背景/去悬浮钮）。PDF 导出已改连续长页
// （v2.88：屏幕媒体渲染，本块 @media print 规则不参与）—— 此注入保留给「下载
// HTML 后浏览器打印」的归档场景与未来 A4 打印需求（幂等）。
const DASH_PRINT_MARKER = 'dash-pr-v1'
export const DASHBOARD_PRINT_CSS = `  /* ${DASH_PRINT_MARKER} v2.87 看板 PDF/打印分页（注入）：@page 边距 + 行/卡避让 + 表头跨页重复 */
  @page { size: A4; margin: 12mm 10mm 14mm; }
  @media print {
    body { font-size: 12px; line-height: 1.75; }
    p { orphans: 3; widows: 3; }
    h1, h2, h3, h4 { break-after: avoid-page; }
    .rpt-head, .meta-grid, .panel, .gt, .mb-row, .mt, .seqbox, .tg-head, .note, .warn, blockquote, img, figure { break-inside: avoid-page; }
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
    : `PDF 生成失败（${err instanceof Error ? err.message.slice(0, 180) : '渲染服务异常'}）— 可下载 HTML 报告离线查看，或浏览器 Ctrl/Cmd+P 另存 A4 分页 PDF`
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
