/**
 * 报告类资源 404 的友好 HTML 页面。
 *
 * 背景（v2.57）：评估报告 / 合并报告 / 高通量看板的在线链接会被
 * window.open 直接打开（历史记录、HT 运行记录、离线看板内的「在线」链接），
 * 或嵌入结果页 iframe。链接失效（数据过了保留期、或运行环境重置清空了
 * db/reports 与 SQLite）时，此前返回裸 JSON {"error":"作业不存在"} —
 * 用户在新标签页看到一串代码，既不美观也没有任何指引。
 *
 * 本模块提供统一的自包含 HTML 404 页（保持 404 状态码 — 前端 fetch
 * 自动下载等逻辑按 res.ok 判断，不受影响；Content-Type 换为 text/html，
 * iframe 与新标签页都能渲染）。文案不区分「不存在 / 非本人」— 不泄露
 * 资源存在性（与 request-guard.notFound 的安全口径一致）。
 */

export type NotFoundKind = 'job' | 'merged' | 'dashboard'

const KIND_LABEL: Record<NotFoundKind, string> = {
  job: '评估报告',
  merged: '合并评估报告',
  dashboard: '高通量汇总看板',
}

export interface NotFoundPageOptions {
  /** 资源类型（决定标题里的名词） */
  kind?: NotFoundKind
  /** 具体原因（仅创建者可见的细分场景，如「报告尚未生成」）；缺省用通用文案 */
  reason?: string
}

/** 生成 404 友好页面的 HTML 字符串 */
export function notFoundPageHtml(opts: NotFoundPageOptions = {}): string {
  const label = KIND_LABEL[opts.kind ?? 'job']
  const reason = opts.reason?.trim() || `对应的${label}已不在服务器上`
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(label)}不存在或已过期</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{color-scheme:light dark}
  body{
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
    background:#fafaf9;color:#1c1917;line-height:1.65;
    min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
  }
  @media(prefers-color-scheme:dark){
    body{background:#0c0a09;color:#f5f5f4}
    .card{background:#1c1917;border-color:#292524}
    .muted{color:#a8a29e}
    .icon-wrap{background:rgba(217,119,6,.12)}
  }
  .card{
    background:#fff;border:1px solid #e7e5e4;border-radius:16px;
    max-width:560px;width:100%;padding:36px 32px;text-align:center;
    box-shadow:0 1px 2px rgba(28,25,23,.04);
  }
  .icon-wrap{
    width:56px;height:56px;border-radius:14px;margin:0 auto 20px;
    background:rgba(217,119,6,.1);display:flex;align-items:center;justify-content:center;
  }
  .icon-wrap svg{width:28px;height:28px;color:#b45309}
  @media(prefers-color-scheme:dark){.icon-wrap svg{color:#fbbf24}}
  h1{font-size:19px;font-weight:650;letter-spacing:-.01em;margin-bottom:8px}
  .reason{font-size:14px;color:#57534e;margin-bottom:20px}
  @media(prefers-color-scheme:dark){.reason{color:#d6d3d1}}
  .divider{height:1px;background:#e7e5e4;margin:20px 0}
  @media(prefers-color-scheme:dark){.divider{background:#292524}}
  .tips{text-align:left;display:flex;flex-direction:column;gap:10px;margin-bottom:24px}
  .tips li{display:flex;gap:10px;font-size:13px;color:#57534e;list-style:none}
  @media(prefers-color-scheme:dark){.tips li{color:#d6d3d1}}
  .tips li::before{content:"";flex:none;width:5px;height:5px;border-radius:50%;background:#b45309;margin-top:8px}
  .muted{font-size:12px;color:#78716c}
  .actions{display:flex;justify-content:center;gap:12px;flex-wrap:wrap}
  a.btn{
    display:inline-flex;align-items:center;justify-content:center;
    padding:9px 20px;border-radius:10px;font-size:13.5px;font-weight:550;
    text-decoration:none;transition:opacity .15s;
  }
  a.btn:hover{opacity:.85}
  a.btn:active{opacity:.7}
  .btn-primary{background:#1c1917;color:#fafaf9}
  @media(prefers-color-scheme:dark){.btn-primary{background:#fafaf9;color:#1c1917}}
  .brand{margin-top:22px;font-size:11px;letter-spacing:.02em}
</style>
</head>
<body>
  <main class="card" role="main">
    <div class="icon-wrap" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14 3v4a1 1 0 0 0 1 1h4"/>
        <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2Z"/>
        <path d="m9.5 10.5 5 5m0-5-5 5"/>
      </svg>
    </div>
    <h1>${esc(label)}不存在或已过期</h1>
    <p class="reason">${esc(reason)}</p>
    <div class="divider" aria-hidden="true"></div>
    <ul class="tips">
      <li>服务器上的评估记录与报告文件为运行数据：按保留策略定期清理（约 30 天），运行环境重置时也会被一并清空。</li>
      <li>报告生成完成时会自动下载 HTML 文件到本机下载目录（高通量运行的报告按运行归入同一文件夹）——请先在本机查收。</li>
      <li>如仍需该靶点的评估结果，请在首页重新发起评估。</li>
    </ul>
    <div class="actions">
      <a class="btn btn-primary" href="/">返回首页</a>
    </div>
    <p class="brand muted">TargetEval</p>
  </main>
</body>
</html>`
}

/**
 * 报告类资源 404 响应（HTML 正文）。
 * 保持 404 状态码与 no-store；CSP 允许任意嵌入（预览面板跨源 iframe 链路）。
 */
export function reportNotFoundResponse(opts: NotFoundPageOptions = {}): Response {
  return new Response(notFoundPageHtml(opts), {
    status: 404,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': 'frame-ancestors *;',
    },
  })
}
