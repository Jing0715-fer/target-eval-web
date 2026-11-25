/**
 * 独立 HTML 评估报告渲染（期刊版式）：
 *  - 内联 CSS，无外部依赖，单文件可离线打开/打印；衬线标题 + 等宽数据标签的学术排版
 *  - LLM 章节用轻量 Markdown 子集渲染器（无 JSDOM/react-markdown，零额外内存）
 *  - 确定性数据区块（评分/结构表/文献/实验图）模板直出，图片按预算 base64 内嵌
 *  - PDB ↔ 文献双向关联（PMID 映射）；长列表 details 折叠，打印时自动展开
 *  - v2.7.5：配体结构式/实验图/AlphaFold 静态图点击放大灯箱（滚轮/双指缩放 + 拖拽平移，离线内联无依赖）
 *  - v2.7.6：①A4 打印分页（@page 边距 + 分页避让 + 数据表打印自动布局防右截断）；
 *    ②配体 2D 结构式 SVG 矢量版（RCSB CCD 矢量描述优先，灯箱无限缩放不糊，PNG 回落）；
 *    ③InChIKey/SMILES 一键复制（页级 JS 自挂按钮，clipboard API + execCommand 降级）；
 *    ④覆盖率区段可视化（SVG 轨道：已覆盖绿/未覆盖琥珀 + 残基刻度，服务端渲染零 JS）；
 *    ⑥移动端表格横滚边缘渐隐指示（可滚动亮起、滚到头熄灭）。
 *  - v2.7.7：⑦AlphaFold 交互 3D 视图一键全屏放大（canvas 迁移遮罩 + pLDDT 图例 + Esc 退出，
 *    新报告模板与旧报告注入同路径）；⑧灯箱嵌入自适应 —— 应用内嵌自动高度 iframe 中
 *    position:fixed 相对 iframe 全文档高（中部图片点击后灯箱跑出屏幕、需回滚查找）→
 *    __rptEmb 可视切片定位（父页滚动实时重跟）+ 图片严格限高；旧版 v1 灯箱共存自动清理。
 *  - v2.7.8：⑨AF 卡「双放大按钮」根除（af-live 时图片角标让位 3D 全屏，MutationObserver
 *    跟随 stage 类名）；⑩嵌入遮罩避让应用吸顶栏（切片 top 下移至 header 下沿 — 关闭钮
 *    不再被顶栏遮挡）；⑪父页滚动锁（灯箱/AF 全屏开启期间锁父页 body overflow，
 *    滚轮落在 iframe 外不再派生滚动）。marker 升 rpt-zoom-v3，v1/v2 baked 旧报告
 *    serve 注入 v3 时自动清理旧根与旧句柄。
 *  - v2.47：AF 3D 放大视图随 canvas 迁入「下载 PDB / 着色切换」工具条（v2.46 小窗
 *    拥挤 → 小窗一律隐藏，仅放大后可见；图例双处同步 — 内嵌 af-legend + 全屏条
 *    af-full-legend，重开全屏对齐当前已选着色）。
 *  - v2.48：PDB / BLAST 列表筛选排序（TABLE_FILTER_JS — 方法 chips + 排序下拉 +
 *    计数；PDB 主表与折叠表同组跨表作用于全量行，激活时折叠区暂避、默认态归位）。
 *  - v2.53：① 方法 chips 之外新增分辨率阈值快捷筛选（≤2Å/≤3Å toggle chips —
 *    TABLE_FILTER_JS 内 RES_KEYS，无分辨率数据的表不渲染）；② .tbl-ctl 样式抽离
 *    TABLE_FILTER_CSS 单源（SINGLE_REPORT_CSS 内嵌 + 服务端注入共用）；③ 旧报告
 *    回填 — applyTableFilterUpgrade 三路径（v2 原样 / v1 摘旧脚本换新版 / 无标记
 *    全量注入），TBL_BOOTSTRAP_JS 从单元格文本提取 data-* 并标组（幂等回填缺失
 *    属性，v1 报告 BLAST 行缺 data-id 在此补齐）；④ 合并报告共有结构与受体×G
 *    蛋白表接入 data-tbl="shared"（report-merged.ts，pdb 类排序 + 方法/阈值筛选）。
 *  - v2.54：列表导出 CSV —— 工具条新增「导出 CSV」按钮（tc-chip tc-x — 复用基类
 *    样式，v1/v2 历史报告零 CSS 注入即可用），导出当前筛选+排序状态下可见行
 *    （BOM + CRLF，Excel 中文零乱码；表头取首表 thead，行内 .rng-outside-chip /
 *    .lig-more 装饰性片段剔除；文件名 = 标题 slug + 组名 + 筛选状态）。marker 升
 *    rpt-tbl-v3：applyTableFilterUpgrade 对 v1/v2 摘旧脚本外补注入最新
 *    TABLE_FILTER_CSS（tc-x 悬停等新增样式全路径生效；同规则重复注入无害）。
 *  - v2.56：报告排版审查修复（fixture 渲染 + VLM 审查 + DOM 核实三重）：
 *    ① PDB 表「文献」列 72→84px（8 位 PMID + lit-dot 圆点实测溢出 5px 贴边截断）；
 *    ② .lig-id-pc PubChem 徽章 #4c5fd7 靛蓝 → 青绿 #0f766e（全页唯一紫色破坏
 *    语义色统一，且违反项目禁用 indigo 规则）；③ 配体卡 2+1 布局末卡占满整行
 *    （.lig-grid > :last-child:nth-child(odd) span — 右列不再留洞）。
 * 图片预算：单图 ≤2MB（解析时已限），内嵌总数 ≤8 张、总预算 ≤6MB，gel/sec 优先。
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { BlastHit, BlastNrHit, LiteratureItem, ParsedImage, PdbEntry, MethodStats, UniprotInfo } from './types'
import { describeBlastStatus, targetIdentityTitleSuffix, type AfDomainRange } from './types'
import type { InteractionAnalysis, InteractionComplexInfo, InteractionSharedPdb } from './types'
import type { ReportContext } from './report'
import { describeEvidenceSource, describeOligoConfidence } from './oligomer'
import { ensure3DmolBundle, plddtStyleApplyJs, afToolbarJs } from './alphafold'
import { matchProcessingSegments, type ProcessingSegmentMatch } from './uniprot'
// v2.45：报告内嵌机器可读标记（targeteval:target）— 提交序列 SHA-256（服务端专用模块）
import { createHash } from 'node:crypto'

// ─── v2.31 聚合蛋白加工归属（PTM/Processing）────────────────────────────────

/** 报告题目 nsp 标注后缀（"Replicase polyprotein 1ab nsp12"；非聚合蛋白/全长时空串） */
function nspTitleSuffix(
  u: Pick<UniprotInfo, 'processingChains' | 'sequenceLength'> | null | undefined,
  range?: [number, number],
): string {
  const m = matchProcessingSegments(range, u?.processingChains, u?.sequenceLength)
  return m?.nspLabel ? ` ${m.nspLabel}` : ''
}

/** 刊头「加工归属」行（评估区间在聚合蛋白中的蛋白酶切割产物归属 — meta-grid） */
function processingRowHtml(m: ProcessingSegmentMatch): string {
  const names = m.segments.slice(0, 3).map(s => `${s.name}（${s.begin}-${s.end}）`).join('、')
  const more = m.segments.length > 3 ? ` 等 ${m.segments.length} 段` : ''
  return `<div><b>加工归属</b> <span title="评估区间在聚合蛋白中的蛋白酶切割产物归属 — 源自 UniProt PTM/Processing（Molecule processing）注释">${esc(m.nspLabel ? `${m.nspLabel} · ` : '')}${esc(names + more)}</span></div>`
}

// ─── v2.7.3 响应式版心（单源规则）────────────────────────────────────────────
//  版心随视口分级放宽（920 → 1088 → 1224 → 1360 → 1480 → 1600），宽屏两侧不再大片留白；
//  字号随版心微升保持行宽可读；数据表（min-width 856px）在 ≥1000px 版心内免横向滚动；
//  窄屏收紧留白 + 网格列最小值不超过容器宽（防小屏撑爆横向滚动）。
//  单源使用：① 新报告内嵌于模板 <style> 尾部（后于全部基础规则，层级安全）；
//           ② 旧报告（落盘于 v2.7.3 之前的 report.html）由报告路由经
//              applyResponsiveOverride 注入到 </head> 前 —— 历史作业同样自适配。

const RESPONSIVE_PAGE_MARKER = 'rpt-rw-v3'

export const RESPONSIVE_PAGE_CSS = `  /* ${RESPONSIVE_PAGE_MARKER} 响应式版心（v2.7.3）：窄屏收紧留白 / 宽屏分级放宽，字号随版心微升 */
  @media (max-width:1024px){ .page{padding:40px 30px 56px} }
  @media (max-width:640px){
    .page{padding:26px 16px 38px}
    h1.rpt-title{font-size:22px}
    .glance-kicker,.glance-foot{padding-left:14px;padding-right:14px}
    .backtop{right:14px;bottom:16px;width:38px;height:38px}
  }
  @media (min-width:1280px){ .page{max-width:1088px} }
  @media (min-width:1440px){ .page{max-width:1224px} body{font-size:15.5px} }
  @media (min-width:1600px){
    .page{max-width:1360px} body{font-size:16px}
    h1.rpt-title{font-size:30px} .sec>h2{font-size:20px}
    .af-fig{flex-basis:360px} .af-fig>img{width:360px} .af-stage,.af-poster{height:280px}
  }
  @media (min-width:1920px){ .page{max-width:1480px} body{font-size:17px} }
  @media (min-width:2200px){ .page{max-width:1600px} body{font-size:17.5px} }
  /* 窄容器防溢出：网格列最小值不超过容器宽（小屏手机） */
  .lig-grid { grid-template-columns:repeat(auto-fit,minmax(min(400px,100%),1fr)); }
  .fig-grid { grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr)); }
  .oligo-ev-line { flex-wrap:wrap; }
  .oligo-ev-line .oligo-ev-text { min-width:120px; }
  @media print { .page{padding:0;max-width:none;box-shadow:none} }
`

/** 旧报告兼容：无 v2.7.3 响应式版心标记的历史 report.html，注入覆盖 CSS（幂等，已有则原样返回） */
export function applyResponsiveOverride(html: string): string {
  if (html.includes(RESPONSIVE_PAGE_MARKER)) return html
  const i = html.indexOf('</head>')
  if (i < 0) return html
  return `${html.slice(0, i)}<style id="rpt-rw">${RESPONSIVE_PAGE_CSS}</style>\n${html.slice(i)}`
}

// ─── v2.7.5/v2.7.8 图片点击放大灯箱 + AlphaFold 3D 视图放大（单源规则）────────
//  配体 2D 结构式 / 客户实验图 / AlphaFold 静态图（af-poster 与 legacy PNG 分支）
//  点击进入全屏灯箱：滚轮（锚定光标）或双指捏合缩放、拖拽平移、双击/双轻点切换
//  适配 ↔ 2.5×、Esc/×/背景点击关闭；右下控制条（− 百分比 ＋ 复位）便于触屏；
//  打印自动隐藏；纯内联 JS 无外部依赖 — 离线单文件报告同样可用。
//  v2.7.7：⑦ AlphaFold 交互 3D 视图「放大」按钮 — canvas 节点迁入全屏遮罩
//  （WebGL 上下文保留，3Dmol ResizeObserver 自动按新尺寸重渲染），pLDDT 图例随行；
//  ⑧ 嵌入自适应定位 —— 自动高度 iframe（应用内嵌报告预览）中 fixed 相对的是
//  iframe 全文档高度而非屏幕可视区，改由 __rptEmb 探测并以「可视切片」绝对定位
//  （父页滚动 rAF 重跟、滚轮/触摸阻断滚动链），iframe 内部可滚或独立打开仍为 fixed。
//  v2.7.8：⑨ AF 卡「双放大按钮」根除 — af-live 时 poster 隐藏、3D 全屏是唯一放大
//  入口，MutationObserver 同步 figure.af-zoom-off 隐藏图片角标（af-fail/静态图恢复，
//  此时图片灯箱是唯一入口）；放大期间 af-expand 也让位幽灵提示。
//  ⑩ 嵌入遮罩避让应用吸顶栏 — 可视切片 top 由「屏幕顶」下移至「父页吸顶 header 下沿」
//  （同源可测：sticky/fixed header 高度），根除关闭按钮被应用顶栏遮挡不可见。
//  ⑪ 父页滚动锁 — 灯箱/AF 全屏开启期间锁父页 body overflow（滚动条宽度补偿防横跳，
//  仅嵌入形态；Dialog 形态宿主 Radix 已锁、独立打开无父页），根除「滚轮落在 iframe 外
//  （应用顶栏等）父页仍滚动」。
//  单源使用：① 新报告内嵌（模板 <style> 尾部 + </body> 前，report-merged 同）；
//           ② 旧报告（含 v2.7.5–2.7.7 落盘 report.html — v1/v2 灯箱）由报告路由经
//              applyZoomUpgrade 注入 v3（marker 幂等 + v1/v2 根自动清理）—— 历史作业同样可用。

const ZOOM_PAGE_MARKER = 'rpt-zoom-v3'

export const LIGHTBOX_CSS = `  /* ${ZOOM_PAGE_MARKER} 图片点击放大（配体结构式 / 实验图 / AlphaFold 静态图） + AF 3D 视图放大 */
  img.rpt-zoomable { cursor:zoom-in; }
  figure.rpt-zoomable { position:relative; }
  .rpt-zoom-badge { position:absolute; top:6px; right:6px; z-index:6; display:inline-flex; align-items:center; gap:4px; padding:2.5px 6px; border-radius:4px; background:rgba(255,255,255,.93); border:1px solid rgba(28,25,23,.22); color:#57534e; font-family:var(--mono,ui-monospace,Menlo,monospace); font-size:9px; font-weight:600; letter-spacing:.5px; box-shadow:0 1px 3px rgba(28,25,23,.14); opacity:0; transition:opacity .18s; pointer-events:none; }
  figure.rpt-zoomable:hover .rpt-zoom-badge { opacity:1; }
  @media (hover:none) { .rpt-zoom-badge { opacity:.92; } }
  /* 嵌入自适应（v2.7.7）：自动高度 iframe 内 fixed 相对全文档高 — 遮罩实际几何由 JS __rptEmb.pin 按可视切片覆盖；此处 fixed 为独立打开/内部滚动 iframe 的基准 */
  .rpt-zoom { position:fixed; inset:0; z-index:80; font-family:var(--mono,ui-monospace,Menlo,monospace); }
  .rpt-zoom[hidden] { display:none; }
  .rpt-zoom-bg { position:absolute; inset:0; background:rgba(23,21,19,.85); cursor:zoom-out; }
  .rpt-zoom-stage { position:absolute; inset:0 0 56px 0; display:flex; align-items:center; justify-content:center; overflow:hidden; touch-action:none; }
  .rpt-zoom-stage img { max-width:min(92vw,1500px); max-height:100%; background:#fff; box-shadow:0 10px 44px rgba(0,0,0,.5); transform-origin:50% 50%; will-change:transform; user-select:none; -webkit-user-drag:none; }
  .rpt-zoom-cap { position:absolute; left:0; right:0; bottom:0; height:56px; display:flex; align-items:center; gap:10px; padding:0 64px 0 18px; background:rgba(23,21,19,.93); color:#f5f4f2; font-size:10px; letter-spacing:.4px; }
  .rpt-zoom-cap b { color:#fff; font-weight:600; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .rpt-zoom-cap .rpt-zoom-hint { color:#a8a29e; margin-left:auto; white-space:nowrap; }
  .rpt-zoom-close { position:absolute; top:14px; right:14px; width:38px; height:38px; border-radius:50%; border:1px solid rgba(255,255,255,.28); background:rgba(23,21,19,.6); color:#fff; font-size:20px; line-height:1; cursor:pointer; display:flex; align-items:center; justify-content:center; }
  .rpt-zoom-close:hover { background:rgba(23,21,19,.88); }
  .rpt-zoom-ctl { position:absolute; right:14px; bottom:68px; display:flex; align-items:center; gap:5px; }
  .rpt-zoom-ctl button { width:34px; height:34px; border-radius:8px; border:1px solid rgba(255,255,255,.22); background:rgba(23,21,19,.78); color:#fff; font-size:13px; cursor:pointer; }
  .rpt-zoom-ctl button:hover { background:rgba(23,21,19,.88); }
  .rpt-zoom-ctl .rpt-zoom-pct { min-width:54px; height:34px; display:flex; align-items:center; justify-content:center; border-radius:8px; border:1px solid rgba(255,255,255,.22); background:rgba(23,21,19,.78); font-size:11px; color:#f5f4f2; }
  @media (max-width:640px){ .rpt-zoom-cap{height:50px;padding-right:56px} .rpt-zoom-stage{inset:0 0 50px 0} .rpt-zoom-cap .rpt-zoom-hint{display:none} .rpt-zoom-ctl{bottom:62px;right:10px} .rpt-zoom-close{top:10px;right:10px} }
  /* v2.7.8 ⑨：AF 交互视图与图片角标互斥 — af-live/af-expanded 时图片角标隐藏（防双放大按钮） */
  figure.rpt-zoomable.af-zoom-off .rpt-zoom-badge { display:none !important; }
  /* v2.7.8 ⑨：放大期间内嵌槽位按钮让位幽灵提示（点击无效果，隐藏免误导） */
  .af-stage.af-expanded .af-expand { display:none; }

  /* ── AlphaFold 交互 3D 视图放大（v2.7.7）：小画布看不清细节 → 一键全屏交互 ── */
  .af-expand { position:absolute; top:8px; right:8px; z-index:5; display:inline-flex; align-items:center; gap:4px; padding:3px 9px; border-radius:5px; border:1px solid rgba(28,25,23,.2); background:rgba(255,255,255,.94); color:#57534e; font-family:var(--mono,ui-monospace,Menlo,monospace); font-size:9px; font-weight:600; letter-spacing:.5px; line-height:1.5; cursor:pointer; box-shadow:0 1px 3px rgba(28,25,23,.14); opacity:0; transition:opacity .18s; }
  .af-expand:hover { background:#fff; color:#1c1917; }
  .af-stage:hover .af-expand, .af-expand:focus-visible { opacity:1; }
  @media (hover:none) { .af-expand { opacity:.92; } }
  .af-stage:not(.af-live) .af-expand { display:none; }
  /* 放大期间内嵌槽位：静态海报占位 + 幽灵提示（canvas 已迁入全屏遮罩） */
  .af-stage.af-expanded .af-poster { display:block; }
  .af-stage.af-expanded::after { content:'交互 3D 视图已放大 · 按 Esc 恢复'; position:absolute; inset:0; display:flex; align-items:center; justify-content:center; font-family:var(--mono,ui-monospace,Menlo,monospace); font-size:10px; letter-spacing:.6px; color:#a8a29e; background:rgba(253,253,252,.72); }
  .af-fullwrap { position:fixed; inset:0; z-index:70; display:flex; flex-direction:column; background:rgba(23,21,19,.87); font-family:var(--mono,ui-monospace,Menlo,monospace); }
  .af-fullwrap[hidden] { display:none; }
  .af-fullbar { display:flex; align-items:center; flex-wrap:wrap; gap:6px 14px; padding:10px 58px 10px 18px; background:rgba(23,21,19,.94); color:#f5f4f2; }
  .af-fullttl b { font-size:12px; font-weight:600; color:#fff; }
  .af-fullttl span { margin-left:10px; font-size:10px; color:#a8a29e; letter-spacing:.4px; }
  .af-full-legend { display:flex; flex-wrap:wrap; gap:6px 12px; margin-left:auto; font-size:9px; color:#a8a29e; }
  .af-full-legend span { display:inline-flex; align-items:center; gap:4px; white-space:nowrap; }
  .af-full-legend i { display:inline-block; width:9px; height:9px; border-radius:2px; border:1px solid rgba(28,25,23,.3); }
  .af-fullclose { position:absolute; top:10px; right:12px; width:34px; height:34px; border-radius:50%; border:1px solid rgba(255,255,255,.28); background:rgba(23,21,19,.6); color:#fff; font-size:19px; line-height:1; cursor:pointer; display:flex; align-items:center; justify-content:center; }
  .af-fullclose:hover { background:rgba(23,21,19,.88); }
  .af-fullslot { flex:1 1 auto; position:relative; margin:14px auto; width:min(96%,1400px); background:#fff; border-radius:10px; overflow:hidden; box-shadow:0 10px 44px rgba(0,0,0,.5); }
  @media (max-width:640px){ .af-fullslot{margin:8px auto;width:calc(100% - 16px);border-radius:8px} .af-fullttl span{display:none} .af-full-legend{margin-left:0} }
  /* v2.47：AF 工具条（下载 PDB / 着色切换）仅放大视图显示 — 小窗拥挤一律隐藏（.af-stage .af-tb 见 SINGLE_REPORT_CSS）；canvas+工具条迁入全屏槽后可见，控件随全屏尺寸放大触控友好 */
  .af-fullslot .af-tb { top:12px; left:12px; gap:8px; }
  .af-fullslot .af-tb-btn { padding:5px 12px; font-size:10.5px; border-radius:6px; box-shadow:0 2px 8px rgba(28,25,23,.2); }
  .af-fullslot .af-tb-sel { padding:5px 8px; font-size:10.5px; max-width:200px; border-radius:6px; box-shadow:0 2px 8px rgba(28,25,23,.2); }
  /* 全屏条图例：域条目多时限高滚动 + 深底上渐变条边框可见 */
  .af-full-legend.af-lgd-scroll { max-height:76px; overflow-y:auto; }
  .af-full-legend .af-lgd-rb-bar { border-color:rgba(255,255,255,.35); }
  @media print { .rpt-zoom-badge, .af-expand, .af-fullwrap { display:none !important; } .rpt-zoom { display:none !important; } }
`

export const LIGHTBOX_JS = `<script>
/* ${ZOOM_PAGE_MARKER} 图片点击放大 + 嵌入自适应 + AlphaFold 3D 视图放大 */
(function () {
  var SEL = '.lig-struct img, .fig img, .af-fig img';

  // ── 旧版灯箱（v2.7.5–2.7.7 baked v1/v2）共存清理：移除旧根 + 克隆剥离旧事件句柄 ──
  // 旧报告 serve 注入本版时旧版已先行执行：旧根随 remove() 销毁其监听；
  //  img 克隆不携带监听（cloneNode 不复制句柄）、旧 af-expand 带旧闭包一并移除
  //  由本版重新挂载 — 根除新旧双开、滚动锁错乱、双放大按钮。
  var oldRoot = document.querySelector('.rpt-zoom');
  if (oldRoot) {
    oldRoot.remove();
    Array.prototype.forEach.call(document.querySelectorAll('img.rpt-zoomable'), function (im) {
      im.replaceWith(im.cloneNode(false));
    });
    Array.prototype.forEach.call(document.querySelectorAll('.af-stage .af-expand'), function (b) { b.remove(); });
  }

  // ── 嵌入环境感知（v2.7.7/v2.7.8）：应用内嵌报告为「自动高度 iframe」—— iframe 高 = 报告全文高 ──
  //  此时 position:fixed 相对的是 iframe 全文档高（非屏幕可视区）：中部图片点击后
  //  灯箱居中于全文中点、跑出屏幕需回滚查找。改以「可视切片」文档坐标绝对定位：
  //  屏幕与 iframe 文档的交集（父页滚动实时重跟）；iframe 内部可滚（预览 Dialog h-full）
  //  或独立打开时 fixed 本就正确 — 维持原行为。
  //  v2.7.8：切片 top 下移至父页吸顶栏下沿（否则关闭钮被应用顶栏遮挡），
  //  并提供父页滚动锁（灯箱开启期间滚轮落在 iframe 外父页不派生滚动）。
  var EMB = window.__rptEmb = (function () {
    function frame() { try { return window.frameElement || null } catch (e) { return null } }
    function ownerWin() { try { var f = frame(); return f ? f.ownerDocument.defaultView : null } catch (e) { return null } }
    /** 父页吸顶 header 高度（v2.7.8 ⑩）：同源才量得到；独立打开/跨域 → 0。
     *  仅 sticky/fixed 且位于屏幕顶时计入 — 遮罩 top 避让其下沿，关闭钮不再被顶栏遮挡。 */
    function headerH(ow) {
      if (!ow || ow === window) return 0;
      try {
        var h = ow.document.querySelector('header');
        if (!h) return 0;
        var cs = ow.getComputedStyle(h);
        if (cs.position !== 'sticky' && cs.position !== 'fixed') return 0;
        var hr = h.getBoundingClientRect();
        return hr.top <= 1 ? Math.round(hr.height) : 0;
      } catch (e) { return 0 }
    }
    /** 可视切片（frame 文档坐标 {top,height}）；null = 视口模式（独立打开 / iframe 内部可滚） */
    function slice() {
      var f = frame();
      if (!f) return null;
      try {
        var doc = document.documentElement;
        var contentH = Math.max(doc.scrollHeight, document.body ? document.body.scrollHeight : 0);
        var r = f.getBoundingClientRect();
        if (contentH > r.height + 8) return null; // iframe 内部可滚 → fixed 正确
        var ow = f.ownerDocument.defaultView;
        var pH = ow.innerHeight || (ow.document.documentElement && ow.document.documentElement.clientHeight) || 0;
        if (!pH) return null;
        var H = headerH(ow); // v2.7.8 ⑩：吸顶栏避让（H=0 时与旧版行为一致）
        var top = Math.max(0, H - r.top);
        var bot = Math.min(r.height, pH - r.top);
        if (bot - top < 160) { top = Math.max(0, H - r.top); bot = Math.min(r.height, pH); } // 屏上交集过小 → 整窗兜底（仍避让吸顶栏）
        return { top: top, height: bot - top };
      } catch (e) { return null }
    }
    /** 全屏遮罩按当前模式定位（fixed=全视口 / slice=可视切片绝对定位）；返回模式名 */
    function pin(el) {
      var rc = slice();
      if (!rc) {
        el.style.position = 'fixed'; el.style.top = '0'; el.style.bottom = '0'; el.style.height = '';
        el.style.left = '0'; el.style.right = '0'; el.style.width = '';
        return 'fixed';
      }
      el.style.position = 'absolute'; el.style.top = rc.top + 'px'; el.style.bottom = ''; el.style.height = rc.height + 'px';
      el.style.left = '0'; el.style.right = '0'; el.style.width = '';
      return 'slice';
    }
    /** 父页滚动/窗口尺寸变化 → rAF 节流重定位（仅嵌入形态需要）；返回解绑函数 */
    function watch(fn) {
      var ow = null;
      try { var f = frame(); if (f) ow = f.ownerDocument.defaultView } catch (e) {}
      var raf = 0;
      var cb = function () {
        if (raf) return;
        raf = requestAnimationFrame(function () { raf = 0; fn(); });
      };
      window.addEventListener('resize', cb, { passive: true });
      if (ow && ow !== window) {
        try { ow.addEventListener('resize', cb, { passive: true }); ow.addEventListener('scroll', cb, { passive: true }) } catch (e) {}
      }
      return function () {
        window.removeEventListener('resize', cb);
        if (ow && ow !== window) { try { ow.removeEventListener('resize', cb); ow.removeEventListener('scroll', cb) } catch (e) {} }
      };
    }
    /** v2.7.8 ⑪：父页滚动锁 — 灯箱/AF 全屏开启期间，滚轮落在 iframe 外（应用吸顶栏等）
     *  父页仍会派生滚动。仅「可视切片」形态（父页实际滚动）才锁；同源才可写；
     *  滚动条宽度补偿防布局横跳；重复调用幂等。unlock() 在关闭时恢复。 */
    var unlockFn = null;
    function lockParent() {
      if (unlockFn) return;
      var ow = ownerWin();
      if (!ow || ow === window) return;
      if (!slice()) return; // 独立打开 / iframe 内部可滚（预览 Dialog）→ 父页无需本版接管
      try {
        var b = ow.document.body;
        var prev = { ov: b.style.overflow, pad: b.style.paddingRight };
        var sw = ow.innerWidth - ow.document.documentElement.clientWidth;
        b.style.overflow = 'hidden';
        if (sw > 0) b.style.paddingRight = sw + 'px';
        unlockFn = function () {
          try {
            b.style.overflow = prev.ov;
            b.style.paddingRight = prev.pad;
          } catch (e) {}
          unlockFn = null;
        };
      } catch (e) {}
    }
    function unlock() { if (unlockFn) unlockFn(); }
    return { pin: pin, watch: watch, slice: slice, lockParent: lockParent, unlock: unlock };
  })();

  var ICON = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/><path d="M11 8v6M8 11h6"/></svg>';
  var ICON_EXPAND = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M21 3l-7 7"/><path d="M9 21H3v-6"/><path d="M3 21l7-7"/></svg>';
  var LEGEND_AF = '<div class="af-full-legend"><span><i style="background:#0053D6"></i>pLDDT ≥ 90</span><span><i style="background:#65CBF3"></i>70–90</span><span><i style="background:#FFDB13"></i>50–70</span><span><i style="background:#FF7D45"></i>&lt; 50</span></div>';

  var imgs = Array.prototype.slice.call(document.querySelectorAll(SEL));

  var root = null, stage = null, bg = null, big = null, titleEl = null, pctEl = null, closeBtn = null, ctlBtns = [];
  var savedOverflow = '', lastFocus = null, unwatch = null;
  var s = 1, tx = 0, ty = 0;

  function apply() {
    big.style.transform = 'translate(' + tx.toFixed(1) + 'px,' + ty.toFixed(1) + 'px) scale(' + s.toFixed(3) + ')';
    pctEl.textContent = Math.round(s * 100) + '%';
  }
  function clampS(v) { return Math.min(12, Math.max(0.25, v)); }
  /** 以视口坐标 (cx,cy) 为锚点缩放到 ns — 锚点像素在缩放前后保持不动 */
  function zoomAt(ns, cx, cy) {
    var r = stage.getBoundingClientRect();
    var ccx = r.left + r.width / 2, ccy = r.top + r.height / 2;
    ns = clampS(ns);
    tx = cx - ccx - (cx - ccx - tx) * ns / s;
    ty = cy - ccy - (cy - ccy - ty) * ns / s;
    s = ns;
    apply();
  }
  function fit() { s = 1; tx = 0; ty = 0; apply(); }
  function open(img) {
    var fig = img.closest('figure');
    var cap = fig ? fig.querySelector('figcaption') : null;
    var t = ((cap ? cap.textContent : '') || img.alt || '').replace(/\\s+/g, ' ').trim();
    titleEl.textContent = t.length > 110 ? t.slice(0, 109) + '…' : (t || '图片预览');
    big.src = img.src;
    big.alt = img.alt || '放大预览';
    EMB.pin(root); // 嵌入形态 → 可视切片；独立打开 → 视口 fixed
    EMB.lockParent(); // v2.7.8 ⑪：嵌入形态锁父页滚动（吸顶栏等遮罩外区域滚轮不再派生滚动）
    fit();
    if (unwatch) { unwatch(); unwatch = null; }
    unwatch = EMB.watch(function () { EMB.pin(root); }); // 父页滚动实时跟停（遮罩贴屏不跑丢）
    lastFocus = document.activeElement;
    root.hidden = false;
    savedOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeBtn.focus();
  }
  function close() {
    root.hidden = true;
    document.body.style.overflow = savedOverflow;
    EMB.unlock(); // v2.7.8 ⑪：父页滚动解锁
    if (unwatch) { unwatch(); unwatch = null; }
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} }
  }

  if (imgs.length) {
    root = document.createElement('div');
    root.className = 'rpt-zoom';
    root.hidden = true;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', '图片放大预览');
    root.innerHTML =
      '<div class="rpt-zoom-bg"></div>' +
      '<div class="rpt-zoom-stage"><img alt=""></div>' +
      '<button type="button" class="rpt-zoom-close" aria-label="关闭预览">×</button>' +
      '<div class="rpt-zoom-ctl">' +
        '<button type="button" data-z="out" aria-label="缩小">−</button>' +
        '<span class="rpt-zoom-pct">100%</span>' +
        '<button type="button" data-z="in" aria-label="放大">＋</button>' +
        '<button type="button" data-z="fit" aria-label="复位" title="复位到适配大小">1:1</button>' +
      '</div>' +
      '<div class="rpt-zoom-cap"><b class="rpt-zoom-title"></b><span class="rpt-zoom-hint">滚轮/双指缩放 · 拖拽平移 · 双击复位 · Esc 关闭</span></div>';
    document.body.appendChild(root);

    stage = root.querySelector('.rpt-zoom-stage');
    bg = root.querySelector('.rpt-zoom-bg');
    big = stage.querySelector('img');
    titleEl = root.querySelector('.rpt-zoom-title');
    pctEl = root.querySelector('.rpt-zoom-pct');
    closeBtn = root.querySelector('.rpt-zoom-close');
    ctlBtns = Array.prototype.slice.call(root.querySelectorAll('.rpt-zoom-ctl button'));

    bg.addEventListener('click', close);
    closeBtn.addEventListener('click', close);
    // 遮罩全域阻断滚动链（wheel/touch 预防默认 — 嵌入形态下防事件链至父页滚动）
    root.addEventListener('wheel', function (e) { e.preventDefault(); }, { passive: false });
    root.addEventListener('touchmove', function (e) { e.preventDefault(); }, { passive: false });
    ctlBtns.forEach(function (b) {
      b.addEventListener('click', function () {
        var z = b.getAttribute('data-z');
        if (z === 'fit') return fit();
        var r = stage.getBoundingClientRect();
        zoomAt(s * (z === 'in' ? 1.5 : 1 / 1.5), r.left + r.width / 2, r.top + r.height / 2);
      });
    });
    document.addEventListener('keydown', function (e) {
      if (root.hidden) return;
      var r = stage.getBoundingClientRect(); // 锚点取遮罩中心（嵌入形态下 innerHeight 非屏幕高 — 不可用）
      if (e.key === 'Escape') close();
      else if (e.key === '+' || e.key === '=') zoomAt(s * 1.25, r.left + r.width / 2, r.top + r.height / 2);
      else if (e.key === '-') zoomAt(s / 1.25, r.left + r.width / 2, r.top + r.height / 2);
      else if (e.key === '0') fit();
    });
    stage.addEventListener('wheel', function (e) {
      e.preventDefault();
      zoomAt(s * (e.deltaY < 0 ? 1.2 : 1 / 1.2), e.clientX, e.clientY);
    }, { passive: false });

    // 指针交互：单指/鼠标拖拽平移；双指捏合缩放；触屏双轻点 = 双击（适配 ↔ 2.5×）
    var ptrs = {}, pinch = null, drag = null, lastTap = 0, lastX = 0, lastY = 0, tapZoomedAt = 0;
    function pCount() { return Object.keys(ptrs).length; }
    stage.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      ptrs[e.pointerId] = { x: e.clientX, y: e.clientY };
      if (pCount() === 1) {
        drag = { x: e.clientX, y: e.clientY, moved: 0 };
        try { stage.setPointerCapture(e.pointerId); } catch (err) {}
      } else { drag = null; pinch = null; }
    });
    stage.addEventListener('pointermove', function (e) {
      if (!ptrs[e.pointerId]) return;
      ptrs[e.pointerId] = { x: e.clientX, y: e.clientY };
      if (pCount() >= 2) {
        var ids = Object.keys(ptrs);
        var a = ptrs[ids[0]], b = ptrs[ids[1]];
        var d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        if (!pinch) pinch = { d: d, s: s };
        zoomAt(pinch.s * d / pinch.d, (a.x + b.x) / 2, (a.y + b.y) / 2);
      } else if (drag) {
        var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        drag.moved += Math.abs(dx) + Math.abs(dy);
        tx += dx; ty += dy;
        drag.x = e.clientX; drag.y = e.clientY;
        apply();
      }
    });
    function endPtr(e) {
      if (ptrs[e.pointerId] && drag && drag.moved < 6 && e.pointerType !== 'mouse') {
        var now = Date.now();
        if (now - lastTap < 320 && Math.abs(e.clientX - lastX) < 30 && Math.abs(e.clientY - lastY) < 30) {
          lastTap = 0;
          tapZoomedAt = now;
          zoomAt(s > 1 ? 1 : 2.5, e.clientX, e.clientY);
        } else { lastTap = now; lastX = e.clientX; lastY = e.clientY; }
      }
      delete ptrs[e.pointerId];
      if (pCount() < 2) pinch = null;
      if (pCount() === 0) drag = null;
    }
    stage.addEventListener('pointerup', endPtr);
    stage.addEventListener('pointercancel', endPtr);
    stage.addEventListener('dblclick', function (e) {
      e.preventDefault();
      // 触屏双轻点已由 pointerup 分支处理 — 跳过其后合成的 dblclick（否则会立刻复位掉刚触发的 2.5×）
      if (Date.now() - tapZoomedAt < 500) return;
      zoomAt(s > 1 ? 1 : 2.5, e.clientX, e.clientY);
    });

    // 缩略图 → 可点击放大（角标提示 + 键盘可达；v1 角标残留则复用 — 幂等）
    imgs.forEach(function (img) {
      img.classList.add('rpt-zoomable');
      var fig = img.closest('figure');
      if (fig) {
        fig.classList.add('rpt-zoomable');
        if (!fig.querySelector('.rpt-zoom-badge')) {
          var badge = document.createElement('span');
          badge.className = 'rpt-zoom-badge';
          badge.innerHTML = ICON + '<span>放大</span>';
          fig.insertBefore(badge, fig.firstChild);
        }
      }
      img.title = '点击放大查看';
      img.setAttribute('role', 'button');
      img.setAttribute('tabindex', '0');
      img.setAttribute('aria-label', '放大查看' + (img.alt ? '：' + img.alt : ''));
      img.addEventListener('click', function () { open(img); });
      img.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(img); }
      });
    });

    // ── v2.7.8 ⑨：AF 交互视图与图片角标互斥（根除「双放大按钮」）──
    // af-live 时 poster 隐藏、3D 全屏是唯一放大入口 → figure 加 af-zoom-off 隐藏图片角标；
    // af-fail / legacy 静态图时恢复（此时图片灯箱是唯一入口）。3Dmol 异步初始化改
    // stage 类名 → MutationObserver 跟随同步（af-expanded 全屏期间同样让位）。
    Array.prototype.forEach.call(document.querySelectorAll('.af-stage'), function (st) {
      var fig = st.closest('figure');
      if (!fig) return;
      function syncAf() {
        fig.classList.toggle('af-zoom-off', st.classList.contains('af-live') || st.classList.contains('af-expanded'));
      }
      syncAf();
      try { new MutationObserver(syncAf).observe(st, { attributes: true, attributeFilter: ['class'] }); } catch (e) {}
    });
  }

  // ── AlphaFold 交互 3D 视图一键全屏放大（新报告模板 + 旧报告注入 — 同一挂载路径）──
  //  内嵌画布仅 320×252，看不清口袋/螺旋细节 → 「放大」按钮把 canvas 节点迁入全屏
  //  遮罩（WebGL 上下文保留；3Dmol ResizeObserver 监视容器自动按新尺寸重渲染，
  //  退出时归位自动缩回）。嵌入形态遮罩同样走 __rptEmb 可视切片定位（含 v2.7.8
  //  吸顶栏避让 + 父页滚动锁）。注入旧报告时旧 af-expand 已随启动清理移除 → 此处全新挂载。
  function afFullscreen(stageEl) {
    var cv = stageEl.querySelector('.af-canvas');
    if (!cv) return;
    var prevFocus = document.activeElement;
    // v2.15：全屏标题引擎自适应 — 取所在 figure figcaption 首个 <b>（AlphaFold /
    // ESMFold 预测结构）；取不到时退化为通用「预测结构」（旧注入报告兼容）。
    var ttl = '预测结构';
    try {
      var figEl = stageEl.closest('figure');
      var ttlB = figEl ? figEl.querySelector('figcaption b') : null;
      if (ttlB && ttlB.textContent) ttl = ttlB.textContent.trim().slice(0, 24) || '预测结构';
    } catch (e) { /* 保持通用标题 */ }
    var wrap = document.createElement('div');
    wrap.className = 'af-fullwrap';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-label', ttl + '放大视图');
    wrap.innerHTML =
      '<div class="af-fullbar">' +
        '<div class="af-fullttl"><b>' + ttl + '</b><span>拖拽旋转 · 滚轮缩放 · 双指捏合 · 左上工具条可下载 PDB / 切换着色</span></div>' +
        LEGEND_AF +
        '<button type="button" class="af-fullclose" aria-label="退出放大视图">×</button>' +
      '</div>';
    var slot = document.createElement('div');
    slot.className = 'af-fullslot';
    wrap.appendChild(slot);
    // 遮罩全域阻断滚动链（wheel/touch 预防默认 — 嵌入形态下防事件链至父页滚动）
    wrap.addEventListener('wheel', function (e) { e.preventDefault(); }, { passive: false });
    wrap.addEventListener('touchmove', function (e) { e.preventDefault(); }, { passive: false });
    slot.appendChild(cv); // canvas 迁移（3Dmol ResizeObserver → 全屏尺寸重渲染）
    // v2.47：工具条（下载 PDB / 着色切换）随 canvas 迁入全屏 — 小窗拥挤仅放大后
    // 可见；__afSync 把全屏条图例对齐当前已选着色（重开不再回显默认 pLDDT 图例）
    var tbEl = stageEl.querySelector('.af-tb');
    if (tbEl) {
      slot.appendChild(tbEl);
      if (tbEl.__afSync) { try { tbEl.__afSync(); } catch (e) { /* ignore */ } }
    }
    stageEl.classList.add('af-expanded');
    document.body.appendChild(wrap);
    EMB.pin(wrap); // 嵌入形态 → 可视切片（含吸顶栏避让）
    EMB.lockParent(); // v2.7.8 ⑪：嵌入形态锁父页滚动
    var unwatchAf = EMB.watch(function () { EMB.pin(wrap); });
    function closeAf() {
      if (wrap._closed) return;
      wrap._closed = true;
      unwatchAf();
      EMB.unlock(); // v2.7.8 ⑪：父页滚动解锁
      stageEl.appendChild(cv); // 归位（viewer 随容器尺寸自动缩回）
      if (tbEl) stageEl.appendChild(tbEl); // v2.47：工具条归位（小窗 CSS 隐藏）
      stageEl.classList.remove('af-expanded');
      wrap.remove();
      document.removeEventListener('keydown', onKey, true);
      var btn = stageEl.querySelector('.af-expand');
      if (btn && btn.focus) { try { btn.focus(); } catch (e) {} }
      else if (prevFocus && prevFocus.focus) { try { prevFocus.focus(); } catch (e) {} }
    }
    function onKey(e) { if (e.key === 'Escape') closeAf(); }
    wrap.querySelector('.af-fullclose').addEventListener('click', closeAf);
    wrap.addEventListener('click', function (e) { if (e.target === wrap) closeAf(); });
    document.addEventListener('keydown', onKey, true);
    try {
      if (window.__afViewer && window.__afViewer.resize) {
        requestAnimationFrame(function () { try { window.__afViewer.resize(); } catch (e) {} });
      }
    } catch (e) { /* ResizeObserver 兜底已足够 */ }
  }
  Array.prototype.forEach.call(document.querySelectorAll('.af-stage'), function (stageEl) {
    if (stageEl.querySelector('.af-expand')) return; // 幂等（新报告模板已挂载则跳过）
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'af-expand';
    btn.title = '放大交互 3D 视图（放大后可下载 PDB / 切换着色）';
    btn.setAttribute('aria-label', '放大交互 3D 视图（放大后可下载 PDB / 切换着色）');
    btn.innerHTML = ICON_EXPAND + '<span>放大</span>';
    btn.addEventListener('click', function (e) { e.stopPropagation(); afFullscreen(stageEl); });
    stageEl.appendChild(btn);
  });
})();
</script>`

/** 旧报告兼容：无 v3 灯箱标记的历史 report.html（含 v2.7.5–2.7.7 baked v1/v2），
 *  注入灯箱 CSS+JS（含嵌入自适应 + AF 3D 放大 + v2.7.8 三项）；v3 脚本开头自动清理
 *  v1/v2 根、旧图片句柄与旧 af-expand（幂等，已有 v3 标记则原样返回） */
export function applyZoomUpgrade(html: string): string {
  if (html.includes(ZOOM_PAGE_MARKER)) return html
  let out = html
  const h = out.indexOf('</head>')
  if (h >= 0) out = `${out.slice(0, h)}<style id="rpt-zoom">${LIGHTBOX_CSS}</style>\n${out.slice(h)}`
  const b = out.lastIndexOf('</body>')
  if (b >= 0) out = `${out.slice(0, b)}${LIGHTBOX_JS}\n${out.slice(b)}`
  return out
}

// ─── v2.7.6 报告六项优化之 ①③⑥（单源规则）────────────────────────────────
//  ① 打印/PDF 导出 A4 分页：@page 边距 + 分页避让（标题不孤行/卡片不跨页腰斩）
//     + 数据表打印自动布局（打印视窗窄于 856px min-width — 固定布局会右截断，
//     auto 布局换行自适应 + 表头跨页重复）。
//  ③ InChIKey / SMILES 一键复制：页级 JS 扫描 .lig-ident 行自动挂「复制」按钮
//     （clipboard API + execCommand 兼容降级，成功/失败状态反馈）。
//  ⑥ 移动端表格横滚指示：.tbl-wrap 可滚动时边缘渐变亮起、滚到头熄灭。
//  单源使用：① 新报告内嵌于模板 <style> 尾部 + </body> 前；② 旧报告由报告路由
//  经 applyUxUpgrade 注入（marker 幂等）—— 历史作业同样获得 A4 打印/复制/横滚体验。

const UX_PAGE_MARKER = 'rpt-ux-v1'
const PRINT_PAGE_MARKER = 'rpt-pr-v1'

export const PRINT_PAGE_CSS = `  /* ${PRINT_PAGE_MARKER} A4 打印分页（v2.7.6）：@page 边距 + 分页避让 + 表格自动布局防右截断 */
  @page { size: A4; margin: 12mm 10mm 14mm; }
  @media print {
    body { font-size: 12px; line-height: 1.78; }
    p { orphans: 3; widows: 3; }
    .sec { break-inside: auto; }
    .sec > h2, .sec h3, .sec h4, .sec h5, .fig-group, .itx-h3 { break-after: avoid-page; }
    .rpt-head, .glance, .toc, .score-row, .score-rationale, .fig, .lig-card, .lit-item,
    .callout, .warn-box, .cx-card, .cx-shared, .cx-solo-comp, .oligo-strip, .oligo-card, .llm-adj-strip,
    .lig-ident, .cov-fig, blockquote { break-inside: avoid-page; }
    thead { display: table-header-group; }
    .tbl-wrap { overflow: visible; }
    /* v2.56：打印时解除 colgroup 固定列宽 — A4 内容宽 ~718px 而固定列总和 ~706px，
       标题列被挤成单词竖排窄条；改为按内容自动分配（标题列吸收余量） */
    .tbl-wrap col { width: auto !important; }
    /* v2.56：打印恢复全文（行高截断仅为屏显优化） */
    .t-clamp { display:block; overflow:visible; }
    table { table-layout: auto !important; min-width: 0 !important; font-size: 9.5px; }
    th { white-space: normal; overflow: visible; text-overflow: clip; }
    th, td { padding: 4px 6px; }
    .fig img { max-height: 300px; }
    .lig-struct img { width: 96px; height: 96px; }
    .af-stage, .af-poster { height: 200px; }
    .copy-btn, .rpt-zoom-badge, .backtop { display: none !important; }
  }
`

export const UX_PAGE_CSS = `  /* ${UX_PAGE_MARKER} 一键复制按钮 + 表格横滚指示 + 目录滚动高亮 + 表格行悬停（v2.7.6 / v2.18） */
  .lig-ident div { display: flex; align-items: baseline; flex-wrap: wrap; gap: 2px; }
  .lig-ident .mono { flex: 1 1 auto; min-width: 0; }
  .copy-btn { flex: none; margin-left: 8px; padding: 1px 9px; border-radius: 4px; border: 1px solid #c7ece0; background: #f0fdf7; color: #047857; font-family: var(--mono, ui-monospace, Menlo, monospace); font-size: 10px; font-weight: 600; letter-spacing: .4px; line-height: 1.7; cursor: pointer; }
  .copy-btn:hover { background: #d9f5e8; border-color: #a7f3d0; }
  .copy-btn.copied { background: #047857; border-color: #047857; color: #fff; }
  .copy-btn.copy-fail { background: #fef2f2; border-color: #fecaca; color: #b91c1c; }
  .tbl-wrap { position: relative; }
  .tbl-wrap::before, .tbl-wrap::after { content: ''; position: absolute; top: 0; bottom: 0; width: 26px; pointer-events: none; z-index: 3; opacity: 0; transition: opacity .18s; }
  .tbl-wrap::after { right: 0; background: linear-gradient(270deg, rgba(28,25,23,.10), rgba(28,25,23,0)); }
  .tbl-wrap::before { left: 0; background: linear-gradient(90deg, rgba(28,25,23,.10), rgba(28,25,23,0)); }
  .tbl-wrap.rw-right::after, .tbl-wrap.rw-left::before { opacity: 1; }
  @media print { .tbl-wrap::before, .tbl-wrap::after { display: none; } }
  /* v2.18 可读性：数据表行悬停反馈（长表定位行时不易跟丢）+ 目录滚动高亮 */
  .tbl-data tbody tr { transition: background .12s; }
  .tbl-data tbody tr:hover { background: #f6faf8; }
  .toc a { transition: color .15s; }
  .toc a.cur { color: var(--accent-2, #047857); font-weight: 700; border-left: 2px solid var(--accent-2, #047857); padding-left: 6px; }
  @media print { .toc a.cur { border-left: none; } }
`

export const UX_PAGE_JS = `<script>
/* ${UX_PAGE_MARKER} InChIKey/SMILES 一键复制 + 表格横滚边缘指示 */
(function () {
  // ── ③ 一键复制：.lig-ident 行自动挂按钮（新旧报告同路径，无需服务端改 HTML）──
  function legacyCopy(t) {
    var ta = document.createElement('textarea');
    ta.value = t;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
    return ok ? Promise.resolve() : Promise.reject(new Error('copy denied'));
  }
  function copyText(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(t).catch(function () { return legacyCopy(t); });
    }
    return legacyCopy(t);
  }
  Array.prototype.forEach.call(document.querySelectorAll('.lig-ident'), function (box) {
    Array.prototype.forEach.call(box.querySelectorAll(':scope > div'), function (row) {
      if (row.querySelector('.copy-btn')) return;
      var b = row.querySelector('b'), mono = row.querySelector('.mono');
      if (!b || !mono) return;
      var label = (b.textContent || '').trim();
      if (!/InChIKey|SMILES/i.test(label)) return;
      var val = (mono.textContent || '').trim();
      if (!val) return;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'copy-btn';
      btn.setAttribute('data-copy', val);
      btn.setAttribute('aria-label', '复制' + label);
      btn.title = '复制' + label;
      btn.textContent = '复制';
      row.appendChild(btn);
    });
  });
  document.addEventListener('click', function (e) {
    var t = e.target;
    var btn = t && t.closest ? t.closest('.copy-btn') : null;
    if (!btn) return;
    copyText(btn.getAttribute('data-copy') || '').then(function () {
      btn.classList.remove('copy-fail');
      btn.classList.add('copied');
      btn.textContent = '已复制✓';
    }).catch(function () {
      btn.classList.remove('copied');
      btn.classList.add('copy-fail');
      btn.textContent = '复制失败';
    });
    clearTimeout(btn._t);
    btn._t = setTimeout(function () {
      btn.classList.remove('copied');
      btn.classList.remove('copy-fail');
      btn.textContent = '复制';
    }, 1600);
  });

  // ── ⑥ 表格横滚边缘渐隐指示（可滚动时亮起，滚到头熄灭；打印隐藏）──
  var wraps = Array.prototype.slice.call(document.querySelectorAll('.tbl-wrap'));
  function upd(w) {
    var has = w.scrollWidth - w.clientWidth > 4;
    w.classList.toggle('rw-right', has && w.scrollLeft + w.clientWidth < w.scrollWidth - 4);
    w.classList.toggle('rw-left', has && w.scrollLeft > 4);
  }
  wraps.forEach(function (w) {
    w.addEventListener('scroll', function () { upd(w); }, { passive: true });
    upd(w);
  });
  window.addEventListener('resize', function () { wraps.forEach(upd); }, { passive: true });

  // ── v2.18 目录滚动高亮（scroll-spy）：当前阅读章节在目录中高亮 + 左缘标记；
  // 阅读线取视口顶部下方 140px；隐藏视图（display:none，合并报告切换页）跳过 ──
  var tocLinks = Array.prototype.slice.call(document.querySelectorAll('.toc a[href^="#"]'));
  if (tocLinks.length && 'scrollY' in window) {
    var tocIds = [];
    tocLinks.forEach(function (a) {
      var id = a.getAttribute('href').slice(1);
      if (id && document.getElementById(id) && tocIds.indexOf(id) < 0) tocIds.push(id);
    });
    var tocCur = null;
    var spy = function () {
      // 阅读线（视口顶下方 140px）：取已越过阅读线且 top 最大（最近越过）的章节 —
      // 即当前正在阅读的章节（取最小会把页面上方早已越过的章节误判为当前）
      var best = null, bestTop = -Infinity;
      tocIds.forEach(function (id) {
        var el = document.getElementById(id);
        if (!el || el.getClientRects().length === 0) return; // 隐藏视图不参与
        var top = el.getBoundingClientRect().top;
        if (top <= 140 && top > bestTop) { best = id; bestTop = top; }
      });
      if (best !== tocCur) {
        tocCur = best;
        tocLinks.forEach(function (a) {
          a.classList.toggle('cur', a.getAttribute('href').slice(1) === tocCur);
        });
      }
    };
    window.addEventListener('scroll', spy, { passive: true });
    window.addEventListener('hashchange', spy); // v2.18.1（P3）：目录点击跳转后立即刷新高亮
    spy();
  }
})();
</script>`

// ─── v2.48 PDB / BLAST 列表筛选 + 排序（报告内嵌，纯客户端零依赖）──────────────
//  表格行携带 data-m（方法归类）/data-res/data-date/data-id/data-ident/data-e/data-cov，
//  table[data-tbl] 标组（pdb 主表+折叠表同组 — 控制器跨表作用于全量行；pdb-out /
//  blast / blast-out 各自独立成组）。分组作用域 = 最近 section（合并报告多靶点
//  各自的 section id 唯一 — 不串组）。激活筛选/排序时全部可见行并入首表、折叠区
//  暂避；恢复默认则按 __home 归位原分布（预览 20 + 折叠余量的结构不变）。
//  v2.53：① 方法 chips 之外新增分辨率阈值快捷筛选（≤2Å / ≤3Å toggle，无分辨率
//  数据的表不渲染）；② marker 升 rpt-tbl-v2 — v1 报告（v2.48-v2.52 生成）由
//  applyTableFilterUpgrade 在服务端摘旧脚本注入新版，历史无标记报告注入自举。
//  v2.54：③ 「导出 CSV」按钮 —— 导出当前筛选+排序状态下的可见行（curVis 与
//  render() 同步；thead 表头 + 单元格文本，装饰性片段剔除；BOM+CRLF Excel 友好）。
const TABLE_FILTER_MARKER = 'rpt-tbl-v3'

export const TABLE_FILTER_JS = `<script>
/* ${TABLE_FILTER_MARKER} PDB/BLAST 列表筛选排序（v2.48；v2.53 分辨率阈值；v2.54 CSV 导出）*/
(function () {
  var M_LABEL = { xray: 'X-ray', cryoem: 'Cryo-EM', nmr: 'NMR', other: '其他' };
  var M_ORDER = ['xray', 'cryoem', 'nmr', 'other'];
  var RES_KEYS = [2, 3]; // v2.53 分辨率阈值（Å）
  var SORTS = {
    pdb: [
      ['default', '默认（分辨率 ↑）'],
      ['res-asc', '分辨率 ↑'], ['res-desc', '分辨率 ↓'],
      ['date-desc', '日期 新→旧'], ['date-asc', '日期 旧→新'],
      ['id-asc', 'PDB ID A→Z']
    ],
    blast: [
      ['default', '默认（Identity ↓）'],
      ['ident-desc', 'Identity 高→低'], ['ident-asc', 'Identity 低→高'],
      ['e-asc', 'E-value 小→大'], ['cov-desc', '覆盖 大→小'], ['res-asc', '分辨率 小→大'],
      ['id-asc', 'PDB ID A→Z']
    ]
  };
  function numAttr(el, k) { var v = parseFloat(el.getAttribute(k)); return Number.isFinite(v) ? v : null; }
  function strAttr(el, k) { var v = (el.getAttribute(k) || '').trim(); return v || null; }
  function cmp(av, bv, dir) { // 缺失值恒排末尾（不因方向翻转漂到头部）
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (av < bv) return -dir;
    if (av > bv) return dir;
    return 0;
  }
  var ACCESS = {
    res: function (r) { return numAttr(r, 'data-res'); },
    date: function (r) { return strAttr(r, 'data-date'); },
    id: function (r) { return strAttr(r, 'data-id'); },
    ident: function (r) { return numAttr(r, 'data-ident'); },
    e: function (r) { return numAttr(r, 'data-e'); },
    cov: function (r) { return numAttr(r, 'data-cov'); }
  };
  function sortKey(v) { var i = v.lastIndexOf('-'); return i < 0 ? null : { k: v.slice(0, i), dir: v.slice(i + 1) === 'desc' ? -1 : 1 }; }
  var groups = {};
  Array.prototype.forEach.call(document.querySelectorAll('table[data-tbl]'), function (t) {
    var g = t.getAttribute('data-tbl');
    var scope = t.closest ? (t.closest('section') || t.closest('.rpt-view') || document.body) : document.body;
    var key = (scope.id || '') + '|' + g;
    (groups[key] = groups[key] || { kind: g, tables: [] }).tables.push(t);
  });
  Object.keys(groups).forEach(function (key) {
    var grp = groups[key];
    var kind = grp.kind.indexOf('blast') === 0 ? 'blast' : 'pdb';
    var rows = [];
    grp.tables.forEach(function (t) {
      var tb = t.tBodies[0];
      if (!tb) return;
      Array.prototype.forEach.call(tb.rows, function (tr) { tr.__home = tb; rows.push(tr); });
    });
    if (rows.length < 4) return; // 极小表无筛选价值
    var mCounts = {};
    rows.forEach(function (r) { var m = r.getAttribute('data-m') || 'other'; mCounts[m] = (mCounts[m] || 0) + 1; });
    var mKeys = M_ORDER.filter(function (k) { return mCounts[k]; });
    var resCounts = {}; // v2.53 阈值命中计数（无分辨率数据 → 不渲染该组）
    var hasRes = false;
    rows.forEach(function (r) {
      var v = numAttr(r, 'data-res');
      if (v != null) { hasRes = true; RES_KEYS.forEach(function (k) { if (v <= k) resCounts[k] = (resCounts[k] || 0) + 1; }); }
    });
    var sorts = SORTS[kind];
    var firstWrap = grp.tables[0].closest ? (grp.tables[0].closest('.tbl-wrap') || grp.tables[0]) : grp.tables[0];
    var ctl = document.createElement('div');
    ctl.className = 'tbl-ctl';
    ctl.setAttribute('role', 'group');
    ctl.setAttribute('aria-label', '列表筛选与排序');
    var html = '';
    if (mKeys.length > 1) {
      html += '<span class="tc-lbl">方法</span>';
      html += '<button type="button" class="tc-chip tc-on" data-m="all" aria-pressed="true">全部 ' + rows.length + '</button>';
      mKeys.forEach(function (k) {
        html += '<button type="button" class="tc-chip" data-m="' + k + '" aria-pressed="false">' + (M_LABEL[k] || k) + ' ' + mCounts[k] + '</button>';
      });
    }
    if (hasRes) {
      html += '<span class="tc-lbl">分辨率</span>';
      RES_KEYS.forEach(function (k) {
        if (resCounts[k]) html += '<button type="button" class="tc-chip tc-res" data-res="' + k + '" aria-pressed="false" title="仅显示分辨率 ≤' + k + 'Å 的条目，再次点击取消">≤' + k + 'Å ' + resCounts[k] + '</button>';
      });
    }
    html += '<span class="tc-lbl">排序</span><select class="tc-sel" aria-label="排序方式">';
    sorts.forEach(function (s) { html += '<option value="' + s[0] + '">' + s[1] + '</option>'; });
    html += '</select><span class="tc-count"></span>';
    html += '<button type="button" class="tc-chip tc-x" title="导出当前列表（含筛选与排序状态）为 CSV 文件，可直接用 Excel / WPS 打开">导出 CSV</button>';
    ctl.innerHTML = html;
    firstWrap.parentNode.insertBefore(ctl, firstWrap);
    var state = { m: 'all', res: 0, sort: 'default' };
    var curVis = rows; // v2.54：当前筛选+排序状态下的可见行（render 同步 — CSV 导出用）
    var countEl = ctl.querySelector('.tc-count');
    var selEl = ctl.querySelector('.tc-sel');
    var hides = []; // 激活期间暂避的次表宿主（details 折叠区 / .tbl-wrap）
    grp.tables.slice(1).forEach(function (t) {
      var host = t.closest ? (t.closest('details') || t.closest('.tbl-wrap')) : null;
      if (host) hides.push(host);
    });
    // v2.54：CSV 导出（当前可见行 = curVis；表头取首表 thead）
    function csvCell(s) {
      s = String(s || '').replace(/\\s+/g, ' ').trim();
      return /[",\\r\\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }
    function cellText(td) {
      var c = td.cloneNode(true);
      // 装饰性片段不入 CSV：范围外 chip / 配体「等N」后缀 / 复制按钮
      if (c.querySelectorAll) {
        Array.prototype.forEach.call(c.querySelectorAll('.rng-outside-chip,.lig-more,.copy-btn'), function (n) { n.remove(); });
      }
      return csvCell(c.textContent || '');
    }
    function exportCsv() {
      var lines = [];
      var hr = grp.tables[0].tHead && grp.tables[0].tHead.rows[0];
      if (hr) {
        var head = [];
        Array.prototype.forEach.call(hr.cells, function (c) { head.push(csvCell(c.textContent)); });
        lines.push(head.join(','));
      }
      curVis.forEach(function (r) {
        var cells = [];
        Array.prototype.forEach.call(r.cells, function (c) { cells.push(cellText(c)); });
        lines.push(cells.join(','));
      });
      var st = ''; // 筛选/排序状态入文件名，多次导出可区分
      if (state.m !== 'all') st += '-' + state.m;
      if (state.res > 0) st += '-le' + state.res + 'A';
      if (state.sort !== 'default') st += '-' + state.sort;
      var base = (document.title || 'report').replace(/[\\\\/:*?"<>|\\s—·（）()]+/g, '').slice(0, 24) || 'report';
      var a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob(['\\ufeff' + lines.join('\\r\\n')], { type: 'text/csv;charset=utf-8' }));
      a.download = base + '-' + grp.kind + st + '.csv';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
    }
    function render() {
      var active = state.m !== 'all' || state.res > 0 || state.sort !== 'default';
      var vis = rows.filter(function (r) {
        if (state.m !== 'all' && (r.getAttribute('data-m') || 'other') !== state.m) return false;
        if (state.res > 0) { var rv = numAttr(r, 'data-res'); if (rv == null || rv > state.res) return false; }
        return true;
      });
      var sk = sortKey(state.sort);
      if (sk && ACCESS[sk.k]) vis.sort(function (a, b) { return cmp(ACCESS[sk.k](a), ACCESS[sk.k](b), sk.dir); });
      curVis = vis; // v2.54：与渲染态同步（CSV 导出取当前可见行）
      Array.prototype.forEach.call(ctl.querySelectorAll('.tc-chip.tc-res'), function (c) {
        var on = parseInt(c.getAttribute('data-res'), 10) === state.res;
        c.classList.toggle('tc-on', on);
        if (c.setAttribute) c.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      var first = grp.tables[0].tBodies[0];
      if (!first) return;
      if (active) {
        vis.forEach(function (r) { first.appendChild(r); });
        rows.forEach(function (r) { if (vis.indexOf(r) < 0) r.remove(); });
        hides.forEach(function (h) { h.style.display = 'none'; });
      } else {
        rows.forEach(function (r) { r.__home.appendChild(r); });
        hides.forEach(function (h) { h.style.display = ''; });
      }
      if (countEl) {
        countEl.textContent = '显示 ' + vis.length + ' / ' + rows.length;
        countEl.classList.toggle('tc-filtered', vis.length < rows.length);
      }
    }
    ctl.addEventListener('click', function (e) {
      var chip = e.target && e.target.closest ? e.target.closest('.tc-chip') : null;
      if (!chip || !ctl.contains(chip)) return;
      if (chip.classList.contains('tc-x')) { exportCsv(); return; } // v2.54
      if (chip.classList.contains('tc-res')) { // v2.53 阈值 toggle（再次点击取消）
        var rv = parseInt(chip.getAttribute('data-res'), 10);
        state.res = state.res === rv ? 0 : rv;
        render();
        return;
      }
      state.m = chip.getAttribute('data-m') || 'all';
      Array.prototype.forEach.call(ctl.querySelectorAll('.tc-chip:not(.tc-res):not(.tc-x)'), function (c) {
        var on = c === chip;
        c.classList.toggle('tc-on', on);
        if (c.setAttribute) c.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      render();
    });
    if (selEl) selEl.addEventListener('change', function () { state.sort = selEl.value; render(); });
    render();
  });
  // ── v2.67：BLAST 库切换（PDB 库 / nr 全库 — 两库都有结果时章节头部分段按钮）──
  Array.prototype.forEach.call(document.querySelectorAll('.lib-toggle'), function (tg) {
    var sec = tg.closest ? tg.closest('section') : null;
    var btns = tg.querySelectorAll('.lt-btn');
    var setLib = function (lib) {
      Array.prototype.forEach.call(btns, function (b) {
        var on = b.getAttribute('data-lib') === lib;
        b.classList.toggle('lt-on', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      if (!sec || !sec.querySelectorAll) return;
      Array.prototype.forEach.call(sec.querySelectorAll('[data-libpanel]'), function (p) {
        p.hidden = p.getAttribute('data-libpanel') !== lib;
      });
    };
    Array.prototype.forEach.call(btns, function (b) {
      b.addEventListener('click', function () { setLib(b.getAttribute('data-lib')); });
    });
  });
  // 打印/PDF：两库面板全展开（完整证据链入档），打印后恢复切换前状态
  window.addEventListener('beforeprint', function () {
    Array.prototype.forEach.call(document.querySelectorAll('[data-libpanel]'), function (p) { p.removeAttribute('hidden'); });
  });
  window.addEventListener('afterprint', function () {
    Array.prototype.forEach.call(document.querySelectorAll('.lib-toggle'), function (tg) {
      var on = tg.querySelector('.lt-btn.lt-on');
      var lib = on ? on.getAttribute('data-lib') : 'pdb';
      var sec = tg.closest ? tg.closest('section') : null;
      if (!sec || !sec.querySelectorAll) return;
      Array.prototype.forEach.call(sec.querySelectorAll('[data-libpanel]'), function (p) {
        p.hidden = p.getAttribute('data-libpanel') !== lib;
      });
    });
  });
})();
</script>`

/** v2.53：.tbl-ctl 工具条样式单源（SINGLE_REPORT_CSS 内嵌 + 旧报告服务端注入共用）
 *  — 从 v2.48 的 SINGLE_REPORT_CSS 块抽离；所需变量（--mono/--line/--accent 等）
 *  在 v2.48 之前的旧报告 :root 同样定义（实测核对），注入即可用 */
export const TABLE_FILTER_CSS = `  /* v2.48/v2.53/v2.54 PDB/BLAST 列表筛选排序工具条（TABLE_FILTER_JS 挂载 — chips + 阈值 + 排序下拉 + 计数 + CSV 导出） */
  .tbl-ctl { display:flex; flex-wrap:wrap; align-items:center; gap:5px 8px; margin:2px 0 10px; font-family:var(--mono); }
  .tc-lbl { font-size:9px; color:var(--faint); letter-spacing:1.2px; margin-left:2px; }
  .tbl-ctl .tc-lbl:first-child { margin-left:0; }
  .tc-chip { padding:2px 10px; border-radius:10px; border:1px solid var(--line); background:#fff; color:var(--sub); font-family:var(--mono,ui-monospace,Menlo,monospace); font-size:9.5px; font-weight:600; letter-spacing:.4px; line-height:1.7; cursor:pointer; transition:border-color .12s, color .12s; }
  .tc-chip:hover { border-color:#c7ece0; color:var(--accent-2); }
  .tc-chip.tc-on { background:var(--accent); border-color:var(--accent); color:#fff; }
  .tc-chip:focus-visible, .tc-sel:focus-visible { outline:2px solid #10b981; outline-offset:1px; }
  .tc-sel { padding:2.5px 6px; border-radius:5px; border:1px solid var(--line); background:#fff; color:var(--sub); font-family:var(--mono,ui-monospace,Menlo,monospace); font-size:9.5px; font-weight:600; cursor:pointer; }
  .tc-count { margin-left:auto; font-size:9.5px; color:var(--faint); white-space:nowrap; }
  .tc-count.tc-filtered { color:#b45309; font-weight:700; }
  .tc-x { margin-left:6px; color:var(--accent-2,#047857); border-color:#c7ece0; background:#f0fdf7; }
  .tc-x:hover { border-color:var(--accent-2,#047857); background:#d9f5e8; }
  @media print { .tbl-ctl { display:none !important; } }
  /* v2.67 BLAST 库切换分段按钮（PDB 库 / nr 全库 — 两库面板 data-libpanel 显隐） */
  .lib-toggle { display:flex; flex-wrap:wrap; gap:6px; margin:10px 0 12px; }
  .lt-btn { font-family:var(--mono,ui-monospace,Menlo,monospace); font-size:11px; font-weight:600; padding:4px 13px; border-radius:99px; border:1px solid var(--line,#e7e5e4); background:var(--paper,#fff); color:var(--sub,#57534e); cursor:pointer; transition:border-color .15s, color .15s, background .15s; }
  .lt-btn:hover { border-color:var(--accent-2,#047857); color:var(--accent,#065f46); }
  .lt-btn:focus-visible { outline:2px solid var(--accent-2,#047857); outline-offset:2px; }
  .lt-btn.lt-on { background:var(--accent,#065f46); border-color:var(--accent,#065f46); color:#fff; }
  @media print { .lib-toggle { display:none !important; } }
`

// ─── v2.53 旧报告表筛选自举（服务端按需注入 — 无/旧标记的 report.html）──────
//  自举在注入的 TABLE_FILTER_JS 之前运行（脚本顺序保证）：
//  ① 未标组表格：按表头识别种类（含 Identity → blast；含分辨率 → pdb），折叠区
//    class fold-outside → {kind}-out 独立组，其余 fold 与主表同组；互作复合物
//    卡片（.cx-card）内表格跳过 — 多卡片同 section 会跨表串行；
//  ② 行属性回填：从单元格文本提取 data-id/data-m/data-res/data-date/
//    data-ident/data-e/data-cov（仅填缺失 — v1 报告 BLAST 行缺 data-id 在此补齐，
//    方法列兼容 mth 色块 class 与纯文本两种历史形态）。
export const TBL_BOOTSTRAP_JS = `<script>
/* rpt-tblboot-v1 旧报告表格筛选自举（v2.53）*/
(function () {
  function mkey(td) {
    var chip = td.querySelector('.mth');
    var cls = chip ? chip.className : '';
    if (/mth-xray/.test(cls)) return 'xray';
    if (/mth-cryoem/.test(cls)) return 'cryoem';
    if (/mth-nmr/.test(cls)) return 'nmr';
    if (chip) return 'other';
    var t = (td.textContent || '').toUpperCase();
    if (t.indexOf('X-RAY') >= 0 || t.indexOf('XRAY') >= 0) return 'xray';
    if (t.indexOf('ELECTRON MICROSCOPY') >= 0 || t.indexOf('CRYO') >= 0) return 'cryoem';
    if (t.indexOf('NMR') >= 0) return 'nmr';
    return 'other';
  }
  Array.prototype.forEach.call(document.querySelectorAll('table.tbl-data'), function (t) {
    if (t.closest && t.closest('.cx-card')) return; // 互作复合物卡片表：多卡片同节不并入
    var head = t.tHead && t.tHead.rows[0];
    if (!head) return;
    var ths = [];
    Array.prototype.forEach.call(head.cells, function (c) { ths.push((c.textContent || '').trim()); });
    var colOf = function (re) { for (var i = 0; i < ths.length; i++) if (re.test(ths[i])) return i; return -1; };
    var isBlast = ths.some(function (h) { return h.indexOf('Identity') >= 0; });
    var isPdb = !isBlast && ths.some(function (h) { return h.indexOf('分辨率') >= 0; });
    if (!isBlast && !isPdb) return;
    if (!t.getAttribute('data-tbl')) {
      var kind = isBlast ? 'blast' : 'pdb';
      var group = kind;
      var det = t.closest ? t.closest('details') : null;
      if (det && det.className.indexOf('fold-outside') >= 0) group = kind + '-out';
      t.setAttribute('data-tbl', group);
    }
    var cId = colOf(/^PDB/), cM = colOf(/方法/), cRes = colOf(/分辨率/), cDate = colOf(/日期/);
    var cIdent = colOf(/Identity/), cE = colOf(/E-value/i), cCov = colOf(/覆盖/);
    var tb = t.tBodies[0];
    if (!tb) return;
    Array.prototype.forEach.call(tb.rows, function (tr) {
      var cells = tr.cells;
      var cell = function (i) { return i >= 0 && cells[i] ? cells[i] : null; };
      var idc = cell(cId);
      if (idc && !tr.hasAttribute('data-id')) {
        var mm = (idc.textContent || '').trim().match(/\\b[0-9A-Z]{4}\\b/);
        tr.setAttribute('data-id', mm ? mm[0] : '');
      }
      var mc = cell(cM);
      if (mc && !tr.hasAttribute('data-m')) tr.setAttribute('data-m', mkey(mc));
      var rc = cell(cRes);
      if (rc && !tr.hasAttribute('data-res')) { var rv = parseFloat(rc.textContent); tr.setAttribute('data-res', isFinite(rv) ? String(rv) : ''); }
      var dc = cell(cDate);
      if (dc && !tr.hasAttribute('data-date')) { var dm = (dc.textContent || '').match(/\\d{4}-\\d{2}-\\d{2}/); tr.setAttribute('data-date', dm ? dm[0] : ''); }
      var ic = cell(cIdent);
      if (ic && !tr.hasAttribute('data-ident')) { var iv = parseFloat(ic.textContent); tr.setAttribute('data-ident', isFinite(iv) ? String(iv) : ''); }
      var ec = cell(cE);
      if (ec && !tr.hasAttribute('data-e')) { var ev = parseFloat(ec.textContent); tr.setAttribute('data-e', isFinite(ev) ? String(ev) : ''); }
      var cc = cell(cCov);
      if (cc && !tr.hasAttribute('data-cov')) {
        var ct = (cc.textContent || '').trim();
        var cm = ct.match(/(\\d+)\\s*[-\\u2013\\u2014~]\\s*(\\d+)/);
        var span = cm ? (parseInt(cm[2], 10) - parseInt(cm[1], 10) + 1) : (parseInt(ct, 10) || '');
        tr.setAttribute('data-cov', span);
      }
    });
  });
})();
</script>`

const TBL_OLD_RE = /<script>\s*\/\* rpt-tbl-v[12][\s\S]*?<\/script>/

/** v2.53/v2.54：报告服务端表筛选升级（幂等，三类路径）：
 *  - 已含 rpt-tbl-v3（当前版本生成）→ 原样返回；
 *  - 含 rpt-tbl-v1/v2（v2.48-v2.53 生成）→ 摘除旧脚本 → 注入自举 + 新版
 *    TABLE_FILTER_JS（行为随服务端代码演进）；
 *  - 无标记（v2.48 之前的历史报告）→ 同上全量注入。
 *  v2.54：CSS 注入不再按路径区分 —— v1/v2 旧版内嵌 CSS 缺 tc-x 等新增规则
 *  （v2.53 曾因 tc-res 复用 tc-chip 基类而免注入侥幸无恙），统一补注入
 *  TABLE_FILTER_CSS（同规则重复声明无害，新增规则全路径生效）。 */
export function applyTableFilterUpgrade(html: string): string {
  if (html.includes(TABLE_FILTER_MARKER)) return html
  let out = html
  if (TBL_OLD_RE.test(out)) out = out.replace(TBL_OLD_RE, '')
  const h = out.indexOf('</head>')
  if (h >= 0) out = `${out.slice(0, h)}<style id="rpt-tbl-ctl">${TABLE_FILTER_CSS}</style>\n${out.slice(h)}`
  const b = out.lastIndexOf('</body>')
  if (b >= 0) out = `${out.slice(0, b)}${TBL_BOOTSTRAP_JS}\n${TABLE_FILTER_JS}\n${out.slice(b)}`
  return out
}

/** 旧报告兼容：无 UX 标记的历史 report.html，注入打印版式 + 复制/横滚 CSS+JS（幂等，已有则原样返回） */
export function applyUxUpgrade(html: string): string {
  if (html.includes(UX_PAGE_MARKER)) return html
  let out = html
  const h = out.indexOf('</head>')
  if (h >= 0) out = `${out.slice(0, h)}<style id="rpt-ux">${PRINT_PAGE_CSS}${UX_PAGE_CSS}</style>\n${out.slice(h)}`
  const b = out.lastIndexOf('</body>')
  if (b >= 0) out = `${out.slice(0, b)}${UX_PAGE_JS}\n${out.slice(b)}`
  return out
}

// ─── Markdown 子集 → HTML ─────────────────────────────────────────────────────

export function esc(s: string | null | undefined): string {
  // v2.48.1：null/undefined 容错 — 关系字段等外部输入可能缺省，此前直接 .replace 崩溃
  // （合并报告 HTML 落盘失败曾由 esc(relation.strategy) 触发）
  return (s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function inlineMd(s: string): string {
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).。,，；;：:]|$)/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/PMID\s*(\d{6,9})/g, 'PMID <a href="https://pubmed.ncbi.nlm.nih.gov/$1/" target="_blank" rel="noopener">$1</a>')
}

export function renderMarkdown(md: string, headingOffset = 0): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let inList = false
  let tableBuf: string[][] = []

  const flushList = () => { if (inList) { out.push('</ul>'); inList = false } }
  const flushTable = () => {
    if (tableBuf.length > 0) {
      const [head, ...body] = tableBuf
      out.push('<div class="tbl-wrap"><table>')
      out.push(`<thead><tr>${head.map(c => `<th>${inlineMd(c)}</th>`).join('')}</tr></thead>`)
      if (body.length) out.push(`<tbody>${body.map(r => `<tr>${r.map(c => `<td>${inlineMd(c)}</td>`).join('')}</tr>`).join('')}</tbody>`)
      out.push('</table></div>')
      tableBuf = []
    }
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    if (/^\|(.+)\|\s*$/.test(line)) {
      flushList()
      const cells = line.slice(1, -1).split('|').map(c => c.trim())
      // 跳过分隔行 |---|---|
      if (cells.every(c => /^:?-{2,}:?$/.test(c) || c === '')) continue
      tableBuf.push(cells)
      continue
    }
    flushTable()
    if (!line.trim()) { flushList(); continue }
    const h = line.match(/^(#{2,4})\s+(.*)$/)
    if (h) {
      flushList()
      const level = Math.min(6, h[1].length + headingOffset)
      const text = h[2].trim()
      out.push(`<h${level} id="${slug(text)}">${inlineMd(text)}</h${level}>`)
      continue
    }
    if (/^>\s?/.test(line)) {
      flushList()
      out.push(`<blockquote>${inlineMd(line.replace(/^>\s?/, ''))}</blockquote>`)
      continue
    }
    const li = line.match(/^\s*(?:[-*•]|\d+[.、)])\s+(.*)$/)
    if (li) {
      if (!inList) { out.push('<ul>'); inList = true }
      out.push(`<li>${inlineMd(li[1])}</li>`)
      continue
    }
    flushList()
    out.push(`<p>${inlineMd(line.trim())}</p>`)
  }
  flushList()
  flushTable()
  return out.join('\n')
}

function slug(s: string): string {
  return 's-' + esc(s).replace(/[^\u4e00-\u9fa5a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
}

// ─── 确定性数据区块 ───────────────────────────────────────────────────────────

function scoreBar(label: string, item: { score: number; rating: string }, color: string, cls = '', delta = 0): string {
  const pct = Math.round((item.score / 10) * 100)
  // v2.18：AI 复核调整徽章（delta≠0 时紧随分数 — 与评分行同一视觉行）。
  // v2.18.1（代码审查 P2-1）：delta 强制数值化（历史/伪造数据防御 — sanitizeCheckpoint 之外的双保险）
  const d = Math.trunc(Number(delta)) || 0
  const deltaChip = d !== 0
    ? `<span class="score-delta ${d > 0 ? 'sd-pos' : 'sd-neg'}" title="AI 复核${d > 0 ? '上调' : '下调'} ${Math.abs(d)} 分（见下方 AI 复核明细）">AI ${d > 0 ? '+' : '−'}${Math.abs(d)}</span>`
    : ''
  return `
  <div class="score-row ${cls}">
    <div class="score-label">${label}</div>
    <div class="score-track"><div class="score-fill" style="width:${pct}%;background:${color}"></div></div>
    <div class="score-num">${item.score}<span class="score-max">/10</span>${deltaChip}</div>
    <div class="score-rating">${esc(item.rating)}</div>
  </div>`
}

/** v2.18 评分依据单元格：长句按「；」拆分分行（扫读友好）+ 双列网格（评分卡更紧凑） */
function rationaleCell(label: string, text: string): string {
  const segs = text.split('；').map(s => s.trim()).filter(Boolean)
  if (!segs.length) return ''
  return `<div class="sr-item"><b class="sr-label">${label}</b>${segs.map(s => `<span class="sr-seg">${esc(s)}</span>`).join('')}</div>`
}

/** 配体短显示："A1B6E (N-[4-(3-chloro…))" → 截断化学名保留编号（悬停可见全名） */
function shortLigand(l: string, nameMax = 22): string {
  const m = l.match(/^(\S+)\s*\((.*)\)\s*$/)
  if (!m) return l.length > 32 ? l.slice(0, 31) + '…' : l
  const [, id, name] = m
  return name.length > nameMax ? `${id} (${name.slice(0, nameMax - 1)}…)` : `${id} (${name})`
}

/** 配体归一策略 → 中文短标签 */
export function strategyZh(s: string): string {
  switch (s) {
    case 'direct-id': return '直接ID'
    case 'alias': return '别名表'
    case 'pdb-search': return 'PDBe检索'
    case 'pubchem': return 'PubChem'
    case 'pubchem+similar': return 'PubChem+相似'
    case 'llm': return 'AI'
    case 'llm+pdb-search': return 'AI+检索'
    case 'llm+pubchem': return 'AI+PubChem'
    default: return s || '—'
  }
}

// ─── v2.7 / v2.7.6 配体卡展示构件（单靶点与合并报告共享 — 单源）────────────────

/** 配体卡 detail 视图（LigandResolution.detail 的结构化展示形状） */
export interface LigandCardDetail {
  cid?: number
  iupacName?: string
  xlogp?: number
  tpsa?: number
  hBondDonor?: number
  hBondAcceptor?: number
  rotatableBonds?: number
  heavyAtoms?: number
  exactMass?: number
  charge?: number
  inchiKey?: string
  canonicalSmiles?: string
  structure2d?: string
  /** v2.7.6：RCSB CCD 矢量结构式（优先于 PNG — 灯箱无限缩放不失真） */
  structure2dSvg?: string
}

/** 配体详情计算性质 chips（PubChem 计算性质，有值才显示） */
export function ligDetailProps(d: LigandCardDetail): string {
  const items: string[] = []
  if (d.xlogp != null) items.push(`XLogP <b>${d.xlogp}</b>`)
  if (d.tpsa != null) items.push(`TPSA <b>${d.tpsa} Å²</b>`)
  if (d.hBondDonor != null) items.push(`氢供体 <b>${d.hBondDonor}</b>`)
  if (d.hBondAcceptor != null) items.push(`氢受体 <b>${d.hBondAcceptor}</b>`)
  if (d.rotatableBonds != null) items.push(`可旋转键 <b>${d.rotatableBonds}</b>`)
  if (d.heavyAtoms != null) items.push(`重原子 <b>${d.heavyAtoms}</b>`)
  if (d.exactMass != null) items.push(`精确质量 <b>${d.exactMass}</b>`)
  if (d.charge != null && d.charge !== 0) items.push(`形式电荷 <b>${d.charge > 0 ? '+' : ''}${d.charge}</b>`)
  return items.length ? items.map(i => `<span>${i}</span>`).join('') : ''
}

/** 配体 2D 结构式 figure（RCSB CCD SVG 矢量优先，PubChem PNG 位图回落 — 点击可进灯箱放大） */
export function ligStructFig(l: { detail?: LigandCardDetail }): string {
  const d = l.detail
  if (!d) return ''
  const src = d.structure2dSvg ?? d.structure2d
  if (!src) return ''
  const isSvg = d.structure2dSvg != null && src === d.structure2dSvg
  return `<figure class="lig-struct"><img src="${src}" alt="2D 化学结构式${isSvg ? '（SVG 矢量）' : ''}"><figcaption>2D 结构式 · ${isSvg ? 'RCSB CCD · SVG 矢量（缩放不失真）' : `PubChem${d.cid ? ` · CID ${d.cid}` : ''}`}</figcaption></figure>`
}

/** 结构标识符折叠（InChIKey / SMILES — 复制按钮由页级 UX JS 自动挂载，新旧报告同路径） */
export function ligIdentFold(l: { detail?: LigandCardDetail }): string {
  const d = l.detail
  if (!d?.inchiKey && !d?.canonicalSmiles) return ''
  return `<details class="fold lig-fold"><summary>结构标识符（InChIKey / SMILES · 可一键复制）</summary><div class="lig-ident">${d.inchiKey ? `<div><b>InChIKey</b> <span class="mono">${esc(d.inchiKey)}</span></div>` : ''}${d.canonicalSmiles ? `<div><b>Canonical SMILES</b> <span class="mono">${esc(d.canonicalSmiles)}</span></div>` : ''}</div></details>`
}

// ─── v2.7.6 ④ 覆盖率区段可视化（SVG 轨道 — 服务端渲染，零 JS 依赖，打印友好）──

/** 覆盖区间 → 未覆盖区间（1 基；ranges 已排序合并） */
function coverageGaps(ranges: Array<[number, number]>, seqLen: number): Array<[number, number]> {
  const gaps: Array<[number, number]> = []
  let cursor = 1
  for (const [a, b] of ranges) {
    if (a > cursor) gaps.push([cursor, Math.min(a - 1, seqLen)])
    cursor = Math.max(cursor, b + 1)
  }
  if (cursor <= seqLen) gaps.push([cursor, seqLen])
  return gaps
}

/**
 * 结构覆盖率区段图（PDB 结构清单章节头部）：
 *  - 全长序列为轨道，已覆盖区间绿色实心、未覆盖区间琥珀半透明（段悬停显示区间明细）
 *  - 残基刻度 1 / 25% / 50% / 75% / 全长 — 与 UniProt 残基编号口径一致
 *  - 纯内联 SVG（无 JS、无外部依赖）— 离线打开/打印均正常呈现
 */
export function coverageFigureHtml(
  coverage: { coveragePercent: number; coveredRanges?: Array<[number, number]> } | null | undefined,
  seqLen: number,
): string {
  if (!coverage || !Number.isFinite(seqLen) || seqLen <= 0) return ''
  const ranges = (coverage.coveredRanges ?? []).filter(r => Array.isArray(r) && r[0] > 0 && r[1] >= r[0])
  const gaps = coverageGaps(ranges, seqLen)
  const W = 820, H = 64
  const x0 = 8, innerW = W - 16
  const pos = (res: number) => x0 + Math.max(0, Math.min(1, res / seqLen)) * innerW
  const seg = (a: number, b: number, fill: string, op: number, kind: string) => {
    const w = pos(b) - pos(a - 1)
    if (w < 1) return ''
    return `<rect x="${pos(a - 1).toFixed(1)}" y="16" width="${Math.max(1.2, w).toFixed(1)}" height="22" rx="2.5" fill="${fill}" opacity="${op}"><title>${a}-${b} · ${b - a + 1} aa ${kind}</title></rect>`
  }
  const rects = ranges.map(([a, b]) => seg(a, b, '#059669', .88, '已覆盖')).join('')
    + gaps.map(([a, b]) => seg(a, b, '#d97706', .22, '未覆盖')).join('')
  const ticks = [0, .25, .5, .75, 1].map((f, i) => {
    const x = x0 + f * innerW
    const label = String(Math.max(1, Math.round(seqLen * f)))
    const anchor = i === 0 ? 'start' : i === 4 ? 'end' : 'middle'
    return `<line x1="${x.toFixed(1)}" y1="42" x2="${x.toFixed(1)}" y2="46" stroke="#a8a29e"/><text x="${x.toFixed(1)}" y="57" text-anchor="${anchor}" font-size="9.5" font-family="JetBrains Mono,ui-monospace,Menlo,monospace" fill="#a8a29e">${label}</text>`
  }).join('')
  const pct = coverage.coveragePercent
  const gapsShow = gaps.slice(0, 6).map(([a, b]) => `${a}-${b}`).join('、')
  return `
  <figure class="cov-fig" aria-label="结构覆盖率区段图">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="结构覆盖率 ${pct}%（残基 1-${seqLen}）">
      <text x="${x0}" y="9" font-size="9" font-family="JetBrains Mono,ui-monospace,Menlo,monospace" fill="#a8a29e" letter-spacing="1.5">COVERAGE MAP · ${seqLen} aa</text>
      <rect x="${x0 - 1}" y="15" width="${innerW + 2}" height="24" rx="3.5" fill="#f5f5f4" stroke="#e7e5e4"/>
      ${rects}${ticks}
    </svg>
    <figcaption><b>结构覆盖率 ${pct}%</b> · 已覆盖 ${ranges.length} 段（绿）${gaps.length ? ` · 未覆盖 ${gaps.length} 段（琥珀）${gapsShow}${gaps.length > 6 ? ' …' : ''}` : ' · 全长覆盖'} · 段悬停可见区间明细 · 数据源 PDBe 映射</figcaption>
  </figure>`
}

/** PDB 表格行（配体截断悬停全名；PMID 悬停显示关联文献标题；
 *  v2.29 outside=true → 范围外行（灰色 + chip — 与评估区间无链范围重叠）；
 *  v2.48 行携带 data-m/-res/-date/-id — 表格筛选排序控制器（TABLE_FILTER_JS）消费） */
function pdbRowsHtml(pdbs: PdbEntry[], max: number, litByPmid: Map<string, LiteratureItem>, outside = false): string {
  return pdbs.slice(0, max).map(p => {
    const lit = p.pubmedId ? litByPmid.get(p.pubmedId) : undefined
    const ligShow = p.ligands.slice(0, 2).map(l => shortLigand(l)).join('; ')
    const mKey = p.isXray ? 'xray' : p.isCryoem ? 'cryoem' : p.isNmr ? 'nmr' : 'other'
    const dateSort = (p.releaseDate || '').slice(0, 10)
    return `
    <tr${outside ? ' class="tr-outside"' : ''} data-m="${mKey}" data-res="${p.resolution ?? ''}" data-date="${esc(dateSort)}" data-id="${p.pdbId}">
      <td class="td-id"><a href="https://www.rcsb.org/structure/${p.pdbId}" target="_blank" rel="noopener">${p.pdbId}</a></td>
      <td><span class="mth mth-${p.isXray ? 'xray' : p.isCryoem ? 'cryoem' : p.isNmr ? 'nmr' : 'other'}">${esc(methodLabel(p))}</span></td>
      <td class="num">${p.resolution != null ? p.resolution.toFixed(2) : '—'}</td>
      <td class="t-rng"${p.chainRanges ? ` title="${esc(p.chainRanges)}（UniProt 残基编号范围）"` : ''}>${esc(p.chainRanges || '—')}${outside ? '<span class="rng-outside-chip">范围外</span>' : ''}</td>
      <td class="t-title" title="${esc(p.title)}"><span class="t-clamp">${esc(p.title)}</span></td>
      <td class="num">${esc(p.releaseDate || '—')}</td>
      <td class="t-lig" title="${esc(p.ligands.slice(0, 5).join('; '))}">${ligShow ? esc(ligShow) : '—'}${p.ligands.length > 2 ? `<span class="lig-more"> 等${p.ligands.length}</span>` : ''}</td>
      <td class="t-journal">${esc(p.journal || '—')}</td>
      <td class="td-id">${p.pubmedId
        ? `<a href="https://pubmed.ncbi.nlm.nih.gov/${p.pubmedId}/" target="_blank" rel="noopener" title="${esc(lit ? `PMID ${p.pubmedId} · ${lit.title}` : `PubMed ${p.pubmedId}`)}">${p.pubmedId}${lit ? '<span class="lit-dot"></span>' : ''}</a>`
        : '—'}</td>
    </tr>`
  }).join('')
}

/** PDB 数据表 colgroup（固定列宽，杜绝长内容挤压/重叠；窄屏由 .tbl-wrap 横向滚动） */
const PDB_COLGROUP = `<colgroup>
  <col style="width:74px"><col style="width:62px"><col style="width:64px"><col style="width:96px"><col>
  <col style="width:86px"><col style="width:146px"><col style="width:106px"><col style="width:84px">
</colgroup>`

/** PDB 表头（v2.29 提为模块级常量 — 主表/范围外折叠表共用） */
const PDB_TABLE_THEAD = '<thead><tr><th>PDB ID</th><th>方法</th><th class="num">分辨率 (Å)</th><th>范围</th><th>标题</th><th class="num">释放日期</th><th>主要配体</th><th>期刊</th><th>文献</th></tr></thead>'

/** PDB 表格：前 preview 条直出，剩余放入 details 折叠；expandAll=true 全量直出（v2.13 单独评估页要求）。
 *  v2.48 主表/折叠表同标 data-tbl="pdb"（同组 — 筛选排序控制器跨表作用于全量行） */
function pdbTableHtml(pdbs: PdbEntry[], preview: number, max: number, litByPmid: Map<string, LiteratureItem>, expandAll = false): string {
  const shown = pdbs.slice(0, max)
  const PDB_THEAD = PDB_TABLE_THEAD
  if (expandAll) {
    return `
  <div class="tbl-wrap"><table class="tbl-data" data-tbl="pdb">
    ${PDB_COLGROUP}
    ${PDB_THEAD}
    <tbody>${pdbRowsHtml(shown, max, litByPmid)}</tbody>
  </table></div>`
  }
  const head = shown.slice(0, preview)
  const rest = shown.slice(preview)
  const headHtml = `
  <div class="tbl-wrap"><table class="tbl-data" data-tbl="pdb">
    ${PDB_COLGROUP}
    ${PDB_THEAD}
    <tbody>${pdbRowsHtml(head, preview, litByPmid)}</tbody>
  </table></div>`
  if (rest.length === 0) return headHtml
  return `${headHtml}
  <details class="fold">
    <summary>展开其余 ${rest.length} 条结构（共 ${shown.length} 条，打印时自动展开）</summary>
    <div class="tbl-wrap"><table class="tbl-data" data-tbl="pdb">
      ${PDB_COLGROUP}
      ${PDB_THEAD}
      <tbody>${pdbRowsHtml(rest, rest.length, litByPmid)}</tbody>
    </table></div>
  </details>`
}

function methodLabel(p: PdbEntry): string {
  if (p.isXray) return 'X-ray'
  if (p.isCryoem) return 'Cryo-EM'
  if (p.isNmr) return 'NMR'
  return p.method.slice(0, 12) || '—'
}

// ─── v2.29 评估区间说明横幅 + 范围外结构折叠区 ─────────────────────────────

/** 区间来源 → 短说明（横幅内） */
function rangeSourceShort(s: string | undefined): string {
  if (!s || s === '—') return '评估区间'
  if (s === '手动指定') return '手动指定区间'
  if (s === '构建比对推导') return '截短构建比对推导区间'
  if (s === 'BLAST nr 比对推导') return 'BLAST 比对推导区间（提交序列在 UniProt 条目内的覆盖范围）'
  if (s.startsWith('结构域匹配')) return '评估表结构域名 → UniProt domain 匹配区间'
  return `${s}区间`
}

/** 评估区间横幅（有区间且存在范围外结构时展示：优先展示/折叠保留口径说明） */
function rangeBannerHtml(
  range: Array<[number, number]> | [number, number] | undefined,
  rangeSource: string | undefined,
  outsideCount: number,
  outsideBlastCount: number,
): string {
  if (!range) return ''
  const [a, b] = range
  const parts: string[] = []
  if (outsideCount > 0) parts.push(`PDB 结构 ${outsideCount} 条`)
  if (outsideBlastCount > 0) parts.push(`同源结构 ${outsideBlastCount} 条`)
  const tail = parts.length
    ? `；链范围与该区间<b>无重叠</b>的 ${parts.join('、')} 已折叠保留在下方（灰色行，同样可查 — 聚蛋白名下其他片段/其他结构域的参考结构）`
    : `；当前全部结构链范围均与该区间重叠（无折叠区）`
  return `<div class="rng-banner"><b>评估区间 ${a}-${b}</b>（${rangeSourceShort(rangeSource)}）— 结构列表按「与区间链范围重叠优先」展示${tail}。</div>`
}

/** 范围外 PDB 结构折叠区（灰色行 + 范围外 chip；默认折叠，打印自动展开同 .fold） */
function pdbOutsideFoldHtml(pdbs: PdbEntry[], litByPmid: Map<string, LiteratureItem>, range: [number, number] | undefined): string {
  if (!range || pdbs.length === 0) return ''
  const shown = pdbs.slice(0, 150)
  return `
  <details class="fold fold-outside">
    <summary>范围外结构 ${pdbs.length} 条（与评估区间 ${range[0]}-${range[1]} 无链范围重叠 — 折叠保留，灰色行${pdbs.length > 150 ? `，展示前 150 条` : ''}）</summary>
    <div class="tbl-wrap"><table class="tbl-data" data-tbl="pdb-out">
      ${PDB_COLGROUP}
      ${PDB_TABLE_THEAD}
      <tbody>${pdbRowsHtml(shown, 150, litByPmid, true)}</tbody>
    </table></div>
    <p class="note">以上结构的链覆盖区间与本次评估区间无重叠（多为该 UniProt 名下其他片段/其他结构域的结构）；按「重叠优先」原则折叠保留于此，行颜色区别于上表。范围外结构不计入评分、覆盖率与「已有结构先例」统计。</p>
  </details>`
}

// ─── v1.29/v1.30 互作复合物证据（Complex Portal / IntAct，无直接结构时）──────────

function stochShort(text: string): string {
  return text.replace(/minValue:\s*/g, '').replace(/maxValue:\s*/g, '').replace(/,\s*/g, '–').trim()
}

/** 共有结构徽标方法标签（X-ray/Cryo-EM/NMR 配色与 PDB 表一致） */
function sharedMethodBadge(s: { isXray: boolean; isCryoem: boolean; isNmr: boolean; method: string }): string {
  const cls = s.isXray ? 'xray' : s.isCryoem ? 'cryoem' : s.isNmr ? 'nmr' : 'other'
  const label = s.isXray ? 'X-ray' : s.isCryoem ? 'Cryo-EM' : s.isNmr ? 'NMR' : s.method.slice(0, 10)
  return `<span class="mth mth-${cls}">${esc(label)}</span>`
}

/** v1.31 PubMed 链接（结构主引文 — 共有/单独/BLAST 列表的「文献」列；紧凑号位直显 PMID 号） */
function pmidLink(pubmedId: string | null | undefined): string {
  if (!pubmedId) return '<span class="t-pmid-none">—</span>'
  return `<a class="t-pmid" href="https://pubmed.ncbi.nlm.nih.gov/${esc(pubmedId)}/" target="_blank" rel="noopener" title="跳转 PubMed 文献 PMID ${esc(pubmedId)}">${esc(pubmedId)}</a>`
}

/** 共有/单独结构表 colgroup（与直接结构表同款列宽策略；紧凑字号 — 9 列在报告页面内免横向滚动） */
const CX_SHARED_COLGROUP = `<colgroup>
  <col style="width:66px"><col style="width:58px"><col style="width:50px"><col style="width:120px"><col style="width:84px">
  <col><col style="width:68px"><col style="width:72px"><col style="width:82px">
</colgroup>`
const CX_SHARED_THEAD = `<thead><tr><th>PDB ID</th><th>方法</th><th class="num" title="分辨率（Å）">分辨率</th><th>覆盖组分</th><th>其他组分</th><th>标题</th><th class="num">释放日期</th><th>期刊</th><th>文献</th></tr></thead>`
const CX_SOLO_COLGROUP = `<colgroup>
  <col style="width:66px"><col style="width:58px"><col style="width:50px"><col>
  <col style="width:68px"><col style="width:72px"><col style="width:82px">
</colgroup>`
const CX_SOLO_THEAD = `<thead><tr><th>PDB ID</th><th>方法</th><th class="num" title="分辨率（Å）">分辨率</th><th>标题</th><th class="num">释放日期</th><th>期刊</th><th>文献</th></tr></thead>`

/** 共有结构行：覆盖组分（绿 chip）+ 其他组分（琥珀 chip，如 FBXO22）+ 文献直跳 */
function sharedRowHtml(s: InteractionSharedPdb): string {
  const extras = s.extraComponents ?? []
  const extraShow = extras.slice(0, 3)
  const extraMore = extras.length - extraShow.length
  const accs = s.extraAccessions ?? []
  return `
    <tr>
      <td class="td-id"><a href="https://www.rcsb.org/structure/${esc(s.pdbId)}" target="_blank" rel="noopener">${esc(s.pdbId)}</a></td>
      <td>${sharedMethodBadge(s)}</td>
      <td class="num">${s.resolution != null ? s.resolution.toFixed(2) : '—'}</td>
      <td><span class="csi-comps" title="${esc(s.componentNames.join(' + '))}（覆盖 ${s.componentCount} 个复合物组分）">${esc(s.componentNames.join('+'))}<i>×${s.componentCount}</i></span></td>
      <td class="t-extras">${extraShow.length
        ? extraShow.map((n, i) => `<span class="csi-extra" title="${esc(accs[i] ?? '')}">+ ${esc(n)}</span>`).join('') + (extraMore > 0 ? `<span class="csi-extra-more">等${extraMore}</span>` : '')
        : '<span class="t-pmid-none">—</span>'}</td>
      <td class="t-title">${esc(s.title)}</td>
      <td class="num">${esc(s.releaseDate || '—')}</td>
      <td class="t-journal">${esc(s.journal || '—')}</td>
      <td class="td-id">${pmidLink(s.pubmedId)}</td>
    </tr>`
}

/** 单独结构行（组分独立解析 — 次要参考） */
function soloRowHtml(p: PdbEntry): string {
  return `
    <tr>
      <td class="td-id"><a href="https://www.rcsb.org/structure/${esc(p.pdbId)}" target="_blank" rel="noopener">${esc(p.pdbId)}</a></td>
      <td>${sharedMethodBadge(p)}</td>
      <td class="num">${p.resolution != null ? p.resolution.toFixed(2) : '—'}</td>
      <td class="t-title" title="${esc(p.title)}"><span class="t-clamp">${esc(p.title)}</span></td>
      <td class="num">${esc(p.releaseDate || '—')}</td>
      <td class="t-journal">${esc(p.journal || '—')}</td>
      <td class="td-id">${pmidLink(p.pubmedId)}</td>
    </tr>`
}

/** 共有/单独结构表壳（共有/单独复用 — 折叠区内外同款表头） */
function cxTableHtml(rows: string, colgroup: string, thead: string): string {
  return `<div class="tbl-wrap"><table class="tbl-data tbl-cx-pdb">${colgroup}${thead}<tbody>${rows}</tbody></table></div>`
}

/** 共有结构直出条数（其余折叠 — 折叠区展开后仍全量可见） */
const CX_SHARED_PREVIEW = 12
/** 单组分单独结构直出条数（其余折叠） */
const CX_SOLO_PREVIEW = 6

/**
 * v1.30/v1.31 单个 curated 复合物卡片：
 *  - 头部：CPX 编号 + 名称 + 装配/分子量/组分结构 chips
 *  - 组分构成表（靶点行高亮；共有/单独结构数分列）
 *  - 共有结构全量表（同一 PDB 含 ≥2 组分 — 组装先例，绿色面板突出；前 12 条直出、
 *    其余折叠展开可见；含其他组分标注（如 FBXO22）与 PubMed 文献直跳）
 *  - 单独结构全量表（各组分独立解析 — 次要参考，默认折叠；按组分分组，每组前 6 条
 *    直出、其余折叠展开可见）
 */
function complexCardHtml(c: InteractionComplexInfo, expandAll = false): string {
  const others = c.components.filter(x => !x.isTarget)
  const shared = c.sharedPdbs ?? []
  const sharedTotal = c.sharedPdbTotal ?? 0
  const sharedOmitted = c.sharedPdbOmitted ?? Math.max(0, sharedTotal - shared.length)
  const soloTotal = c.soloPdbTotal ?? others.reduce((s, x) => s + (x.soloPdbCount ?? 0), 0)

  const sharedHeadRows = shared.slice(0, CX_SHARED_PREVIEW)
  const sharedRest = shared.slice(CX_SHARED_PREVIEW)
  const sharedListHtml = shared.length ? `
    <div class="cx-shared">
      <div class="cx-shared-head"><span class="cx-shared-ico" aria-hidden="true">◈</span>共有结构 <b>${sharedTotal}</b> 个<span class="cx-shared-sub">同一 PDB 条目含 ≥2 个复合物组分 — 共组装先例，复合物路线最直接的结构证据；「其他组分」列为该 PDB 中复合物组分之外的蛋白（如 F-box 家族底物受体），提示更大装配语境</span></div>
      ${cxTableHtml((expandAll ? shared : sharedHeadRows).map(sharedRowHtml).join(''), CX_SHARED_COLGROUP, CX_SHARED_THEAD)}
      ${!expandAll && sharedRest.length ? `
      <details class="fold">
        <summary>展开其余 ${sharedRest.length} 个共有结构（共 ${sharedTotal} 个，打印时自动展开）</summary>
        ${cxTableHtml(sharedRest.map(sharedRowHtml).join(''), CX_SHARED_COLGROUP, CX_SHARED_THEAD)}
      </details>` : ''}
      ${sharedOmitted > 0 ? `<p class="note">另有 ${sharedOmitted} 个共有结构超出详情拉取上限未列出（总数已计入）。</p>` : ''}
    </div>` : ''

  const soloComps = others
    .map(x => ({ comp: x, list: x.soloPdbs ?? x.soloRepresentativePdbs ?? [], omitted: x.soloPdbOmitted ?? Math.max(0, (x.soloPdbCount ?? 0) - (x.soloPdbs ?? x.soloRepresentativePdbs ?? []).length) }))
    .filter(g => g.list.length > 0 || (g.comp.soloPdbCount ?? 0) > 0)
  const soloFoldHtml = soloComps.length ? `
    <details class="fold cx-solo-fold"${expandAll ? ' open' : ''}>
      <summary>单独结构（各组分独立解析，共 ${soloTotal} 个 — 次要参考：边界借鉴/构象对照${expandAll ? ' · 已展开' : ' · 默认折叠'}）</summary>
      ${soloComps.map(({ comp, list, omitted }) => {
        const head = expandAll ? list : list.slice(0, CX_SOLO_PREVIEW)
        const rest = expandAll ? [] : list.slice(CX_SOLO_PREVIEW)
        return `
      <div class="cx-solo-comp">
        <div class="cx-solo-head"><b>${esc(comp.name)}</b> <span class="mono">${esc(comp.accession)}</span> — ${comp.soloPdbCount ?? list.length} 个单独结构<span class="cx-solo-sub">（不含复合物其他组分）</span></div>
        ${list.length ? cxTableHtml(head.map(soloRowHtml).join(''), CX_SOLO_COLGROUP, CX_SOLO_THEAD) : ''}
        ${rest.length ? `
        <details class="fold">
          <summary>展开 ${esc(comp.name)} 其余 ${rest.length} 个单独结构（打印时自动展开）</summary>
          ${cxTableHtml(rest.map(soloRowHtml).join(''), CX_SOLO_COLGROUP, CX_SOLO_THEAD)}
        </details>` : ''}
        ${omitted > 0 ? `<p class="note">另有 ${omitted} 个单独结构超出详情拉取上限未列出（总数已计入）。</p>` : ''}
      </div>`
      }).join('')}
      <p class="note">单独结构仅含单一组分（不含复合物其他组分）— 可用于组分域边界设计与构象状态对照，但不能证明复合物组装形式。</p>
    </details>` : ''

  return `
  <div class="cx-card">
    <div class="cx-head">
      <span class="cx-badge">Complex Portal</span>
      <b class="cx-name"><a href="https://www.ebi.ac.uk/complexportal/complex/${esc(c.complexAc)}" target="_blank" rel="noopener">${esc(c.complexAc)}</a>${c.name ? ` ${esc(c.name)}` : ''}</b>
      ${c.assembly ? `<span class="cx-chip">${esc(c.assembly)}</span>` : ''}
      ${c.assemblyKda != null ? `<span class="cx-chip">装配 ~${c.assemblyKda} kDa</span>` : ''}
      <span class="cx-chip ${c.componentsWithStructure > 0 ? 'cx-ok' : ''}">${c.componentsWithStructure}/${others.length} 其他组分有结构</span>
      ${sharedTotal ? `<span class="cx-chip cx-chip-shared">共有结构 ${sharedTotal}</span>` : ''}
    </div>
    <div class="tbl-wrap"><table class="tbl-data tbl-cx">
      <thead><tr><th>组分</th><th style="width:88px">UniProt</th><th style="width:56px">计量</th><th style="width:82px" class="num">分子量</th><th style="width:60px" class="num">共有</th><th style="width:60px" class="num">单独</th></tr></thead>
      <tbody>${c.components.map(x => `
        <tr${x.isTarget ? ' class="cx-target"' : ''}>
          <td class="t-title">${x.isTarget ? '<b>【靶点】</b>' : ''}${esc(x.name)}${x.description ? `<span class="cx-desc"> · ${esc(x.description.slice(0, 44))}</span>` : ''}</td>
          <td class="td-id"><a href="https://www.uniprot.org/uniprotkb/${esc(x.accession)}" target="_blank" rel="noopener">${esc(x.accession)}</a></td>
          <td class="num">${esc(stochShort(x.stoichiometryText) || '—')}</td>
          <td class="num">${x.kda != null ? `~${x.kda}` : '—'}</td>
          <td class="num">${x.isTarget ? '—' : String(x.sharedPdbIds?.length ?? 0)}</td>
          <td class="num" ${x.isTarget ? 'title="评估对象 — 无直接结构（本分析前提）"' : ''}>${x.isTarget ? '—' : String(x.soloPdbCount ?? 0)}</td>
        </tr>`).join('')}</tbody>
    </table></div>
    ${sharedListHtml}
    ${soloFoldHtml}
  </div>`
}

/** v2.33 binary 互作可信度 chip（复合物结构 / 同源复合物结构 / 仅实验证据） */
function evidenceChipHtml(level: string | undefined): string {
  if (level === 'complex') return '<span class="ev-chip ev-complex">复合物结构</span>'
  if (level === 'homolog') return '<span class="ev-chip ev-homolog">同源复合物结构</span>'
  return '<span class="ev-chip ev-exp">仅实验证据</span>'
}

/** 互作复合物证据全景（v1.30 接入 PDB 章节）：curated 复合物卡片（共有突出/单独折叠）+ binary 伙伴 */
export function interactionEvidenceHtml(itx: InteractionAnalysis | null | undefined, expandAll = false): string {
  if (!itx || !itx.applicable || !itx.hasEvidence) return ''
  const complexes = itx.complexes.map(c => complexCardHtml(c, expandAll)).join('')
  const structuralCount = itx.binaryPartners.filter(b => b.evidenceLevel === 'complex' || b.evidenceLevel === 'homolog').length
  const binaries = itx.binaryPartners.length ? `
  <details class="fold">
    <summary>IntAct binary 互作伙伴（复合物之外 ${itx.binaryPartners.length} 个 · 可信度分级：${structuralCount} 个有结构证据 / ${itx.binaryPartners.length - structuralCount} 个仅实验证据 — 默认折叠）</summary>
    <ul class="mw-list">${itx.binaryPartners.map(b => {
      const evPdbs = b.evidencePdbs ?? []
      const evCount = b.evidencePdbCount ?? 0
      const evidenceHtml = (b.evidenceLevel === 'complex' || b.evidenceLevel === 'homolog') && evCount > 0
        ? `${evCount} 个证据结构${evPdbs.length ? `（${evPdbs.map(p => `<a href="https://www.rcsb.org/structure/${p.pdbId}" target="_blank" rel="noopener">${p.pdbId}</a><span class="cx-res">${p.resolution != null ? p.resolution.toFixed(1) + 'Å' : ''}</span>`).join(' ')}${evCount > evPdbs.length ? ` 等` : ''}）` : ''}`
        : '无复合物结构/同源结构支持'
      const partnerOwn = b.pdbCount > 0
        ? `${b.pdbCount} 个结构${b.representativePdbs.length ? `（代表：${b.representativePdbs.map(p => `<a href="https://www.rcsb.org/structure/${p.pdbId}" target="_blank" rel="noopener">${p.pdbId}</a><span class="cx-res">${p.resolution != null ? p.resolution.toFixed(1) + 'Å' : ''}</span>`).join(' ')}）` : ''} — 伙伴条目自身`
        : '无结构'
      return `<li><b>${esc(b.geneName ?? b.accession)}</b> <span class="mono">${esc(b.accession)}</span>${evidenceChipHtml(b.evidenceLevel)}— 互作证据：${evidenceHtml}；伙伴自身 ${partnerOwn}${b.evidenceNote ? `<br><span class="ev-note">${esc(b.evidenceNote)}</span>` : ''}</li>`
    }).join('')}</ul>
    <p class="note">可信度口径（v2.33）：仅当存在<b>复合物结构</b>（靶点与伙伴出现在同一 PDB 条目）或<b>同源复合物结构</b>（靶点同源链与伙伴/伙伴同源基因共结构）时，binary 互作才可完全信任并用于共表达增重路线设计与分子量估算；仅有实验互作证据（IntAct）的伙伴可信度有限 — <b>不应据此认定可用于增大蛋白分子量做 Cryo-EM</b>，如需采用须先 pull-down/SPR/SEC-MALS 验证互作、化学计量与组装效率。伙伴自身结构仅代表该伙伴条目已解析，不构成靶点-伙伴互作的结构证据。</p>
  </details>` : ''
  return `
  <h3 class="itx-h3">互作复合物组分结构 <span class="itx-h3-sub">Complex Portal curated · ${itx.complexes.length} 个复合物</span></h3>
  <p class="note">靶点无直接结构 — 以下为其所在复合物其他组分的结构清单，按「共有 / 单独」分类：<b>共有结构</b>（同一 PDB 含 ≥2 个组分）是复合物共组装的直接先例，重点展示；<b>单独结构</b>（组分独立解析）为次要参考，默认折叠。</p>
  ${complexes}
  ${binaries}`
}

function blastRowsHtml(hits: BlastHit[], outside = false): string {
  return hits.map(h => {
    const range = h.queryFrom != null && h.queryTo != null && h.queryFrom > 0 && h.queryTo > 0
      ? `${h.queryFrom}-${h.queryTo}`
      : (h.queryCoverage != null && h.queryCoverage > 0 ? `${h.queryCoverage} aa` : '—')
    const covSpan = h.queryFrom != null && h.queryTo != null && h.queryFrom > 0 && h.queryTo >= h.queryFrom
      ? h.queryTo - h.queryFrom + 1
      : (h.queryCoverage != null && h.queryCoverage > 0 ? h.queryCoverage : '')
    return `
    <tr${outside ? ' class="tr-outside"' : ''} data-m="${blastMethodKey(h.method)}" data-ident="${h.identity}" data-res="${h.resolution ?? ''}" data-cov="${covSpan}" data-e="${Number.isFinite(h.evalue) ? h.evalue : ''}" data-id="${h.pdbId ?? ''}">
      <td class="td-id">${h.pdbId ? `<a href="https://www.rcsb.org/structure/${h.pdbId}" target="_blank" rel="noopener">${h.pdbId}</a>` : '—'}</td>
      <td class="t-desc" title="${esc(h.description)}"><span class="t-clamp">${esc(h.description)}</span></td>
      <td class="num">${h.identity.toFixed(1)}%</td>
      <td class="num">${esc(h.evalueRaw)}</td>
      <td class="num">${esc(range)}${outside ? '<span class="rng-outside-chip">范围外</span>' : ''}</td>
      <td>${blastMethodChip(h.method)}</td>
      <td class="num">${h.resolution != null ? h.resolution.toFixed(2) : '—'}</td>
      <td class="td-id">${pmidLink(h.pubmedId)}</td>
    </tr>`
  }).join('')
}

/** v2.44：BLAST 表方法列短标签（用户反馈：RCSB 原始方法名如 ELECTRON MICROSCOPY
 *  过长，与右侧分辨率列重叠）— 与 PDB 表同款 mth 色块：X-ray / Cryo-EM / NMR /
 *  其他（限长 14 字符，完整名悬停 title 可见） */
function blastMethodChip(method: string): string {
  const m = (method || '').trim()
  if (!m) return '<span class="mth mth-other">—</span>'
  const up = m.toUpperCase()
  if (up.includes('X-RAY') || up.includes('XRAY')) return '<span class="mth mth-xray">X-ray</span>'
  if (up.includes('ELECTRON MICROSCOPY') || up.includes('CRYO-EM') || up.includes('CRYOEM') || up.includes('ELECTRON CRYSTALLOGRAPHY')) return '<span class="mth mth-cryoem">Cryo-EM</span>'
  if (up.includes('NMR')) return '<span class="mth mth-nmr">NMR</span>'
  if (m.length <= 14) return `<span class="mth mth-other" title="${esc(m)}">${esc(m)}</span>`
  return `<span class="mth mth-other" title="${esc(m)}">${esc(m.slice(0, 13))}…</span>`
}

/** v2.48：BLAST 行方法归类键（与 blastMethodChip 同口径 — 筛选 chips / data-m 属性用） */
function blastMethodKey(method: string): string {
  const m = (method || '').trim()
  if (!m) return 'other'
  const up = m.toUpperCase()
  if (up.includes('X-RAY') || up.includes('XRAY')) return 'xray'
  if (up.includes('ELECTRON MICROSCOPY') || up.includes('CRYO-EM') || up.includes('CRYOEM') || up.includes('ELECTRON CRYSTALLOGRAPHY')) return 'cryoem'
  if (up.includes('NMR')) return 'nmr'
  return 'other'
}

/** 范围外 BLAST 同源命中折叠区（灰色行 + 范围外 chip — v2.29） */
function blastOutsideFoldHtml(hits: BlastHit[], range: [number, number] | undefined): string {
  if (!range || hits.length === 0) return ''
  const shown = hits.slice(0, 100)
  return `
  <details class="fold fold-outside">
    <summary>范围外同源结构 ${hits.length} 条（查询覆盖区间与评估区间 ${range[0]}-${range[1]} 无重叠 — 折叠保留，灰色行${hits.length > 100 ? '，展示前 100 条' : ''}）</summary>
    <div class="tbl-wrap"><table class="tbl-data tbl-blast" data-tbl="blast-out">
      <colgroup>
        <col style="width:74px"><col><col style="width:78px"><col style="width:88px">
        <col style="width:74px"><col style="width:104px"><col style="width:74px"><col style="width:92px">
      </colgroup>
      <thead><tr><th>PDB ID</th><th>描述</th><th class="num">Identity</th><th class="num">E-value</th><th class="num">覆盖范围</th><th>方法</th><th class="num">分辨率 (Å)</th><th>文献</th></tr></thead>
      <tbody>${blastRowsHtml(shown, true)}</tbody>
    </table></div>
    <p class="note">以上同源命中的查询覆盖区间与评估区间无重叠（对应其他片段/其他结构域的同源参考）；折叠保留于此，行颜色区别于上表，不计入评分与「已有同源先例」统计。</p>
  </details>`
}

/** v2.67：BLAST nr 全库检索面板（靶点身份识别级联实际执行 nr 检索时展示 —
 *  PDB 库同源不足以归属 UniProt 时提交序列改查 NCBI nr 全库）。
 *  与 PDB 库同款表格版式全量直出（v2.65 前为「前 5 条直出 + 其余折叠」— 应用户要求
 *  改为同格式全量）；data-tbl="blastnr" 挂载 TABLE_FILTER_JS 工具条（Identity /
 *  E-value / 覆盖排序 + 计数 + CSV 导出）。withHead=true 时附 h3 标题（PDB 库检索
 *  失败/无命中时的单独展示；两库切换展示时由分段按钮标识，不重复出标题）。 */
function blastNrPanelHtml(hits: BlastNrHit[], withHead: boolean): string {
  if (!hits.length) return ''
  const nrRow = (h: BlastNrHit) => {
    const range = h.queryFrom != null && h.queryTo != null && h.queryFrom > 0 && h.queryTo > 0
      ? `${h.queryFrom}-${h.queryTo}`
      : (h.queryCoverage > 0 ? `${h.queryCoverage} aa` : '—')
    const covSpan = h.queryFrom != null && h.queryTo != null && h.queryFrom > 0 && h.queryTo >= h.queryFrom
      ? h.queryTo - h.queryFrom + 1
      : (h.queryCoverage > 0 ? h.queryCoverage : '')
    const dbChip = h.db === 'sp'
      ? '<span class="nr-chip nr-chip-sp" title="Swiss-Prot 人工审校条目 — UniProt 归属可信度高">Swiss-Prot</span>'
      : h.db === 'tr'
        ? '<span class="nr-chip nr-chip-tr" title="UniProt TrEMBL 自动注释条目">TrEMBL</span>'
        : '<span class="nr-chip nr-chip-other" title="nr 库其他来源条目（gb/ref 等，非 UniProt 形态）">nr 其他</span>'
    const accLink = h.db !== 'other' && /^[A-Z0-9]{6,10}$/.test(h.accession)
      ? `<a href="https://www.uniprot.org/uniprotkb/${h.accession}" target="_blank" rel="noopener">${h.accession}</a>`
      : esc(h.accession || '—')
    const descTitle = esc([h.description, h.organism ? `OS=${h.organism}` : '', h.geneName ? `GN=${h.geneName}` : ''].filter(Boolean).join(' '))
    return `
    <tr data-ident="${h.identity}" data-e="${Number.isFinite(h.evalue) ? h.evalue : ''}" data-cov="${covSpan}">
      <td class="td-id">${accLink}${h.entryName ? `<div class="nr-entry">${esc(h.entryName)}</div>` : ''}</td>
      <td class="t-desc" title="${descTitle}"><span class="t-clamp">${esc(h.description || '—')}</span></td>
      <td class="num">${h.identity.toFixed(1)}%</td>
      <td class="num">${esc(h.evalueRaw)}</td>
      <td class="num">${esc(range)}</td>
      <td>${dbChip}</td>
    </tr>`
  }
  return `
  ${withHead ? `<h3 class="itx-h3">BLAST nr 全库检索 <span class="itx-h3-sub">NCBI nr · ${hits.length} hits · 靶点身份识别</span></h3>` : ''}
  <p class="note">PDB 库同源检索未能确定 UniProt 归属（最佳一致性 &lt;85% 或覆盖 &lt;40%，或检索失败）时，提交序列已自动改查 NCBI nr 全库（非冗余蛋白序列库）定位真实蛋白身份 — 最佳命中达「一致性 ≥85% 且覆盖 ≥40%」即回填 UniProt 元数据（报告题目/刊头的「nr 识别」标注即来源于此）。命中主体为 UniProt 序列条目：Swiss-Prot（sp）= 人工审校 / TrEMBL（tr）= 自动注释；按显著性排序、同编号去重取最高一致性；「覆盖范围」为提交序列上的残基区间（首个 HSP，1-based 闭区间）。可经表头下方「排序」切换 Identity 降序等，并支持导出 CSV。</p>
  <div class="tbl-wrap"><table class="tbl-data tbl-blast" data-tbl="blastnr">
    <colgroup>
      <col style="width:118px"><col><col style="width:78px"><col style="width:92px"><col style="width:88px"><col style="width:96px">
    </colgroup>
    <thead><tr><th>UniProt / 编号</th><th>描述</th><th class="num">Identity</th><th class="num">E-value</th><th class="num" title="首个 HSP 在提交序列上的残基区间（1-based 闭区间）">覆盖范围</th><th>库</th></tr></thead>
    <tbody>${hits.map(nrRow).join('')}</tbody>
  </table></div>`
}

/** v2.82：EBI UniProt 库（Swiss-Prot）序列匹配面板（身份级联 v2.44 通道 — NCBI nr
 *  患病/失败/未达阈值时提交序列直查 UniProtKB。此前命中只用于身份处理从不展示，
 *  用户实测「搜索了库但报告不显示检索结果」— 本面板补齐检索证据链；与 nr 面板
 *  同款表格版式，独立 h3 小节（不参与 PDB/nr 切换 — 始终可见）。 */
function uniprotBlastPanelHtml(hits: BlastNrHit[]): string {
  if (!hits.length) return ''
  const nrRow = (h: BlastNrHit) => {
    const range = h.queryFrom != null && h.queryTo != null && h.queryFrom > 0 && h.queryTo > 0
      ? `${h.queryFrom}-${h.queryTo}`
      : (h.queryCoverage > 0 ? `${h.queryCoverage} aa` : '—')
    const covSpan = h.queryFrom != null && h.queryTo != null && h.queryFrom > 0 && h.queryTo >= h.queryFrom
      ? h.queryTo - h.queryFrom + 1
      : (h.queryCoverage > 0 ? h.queryCoverage : '')
    const dbChip = h.db === 'sp'
      ? '<span class="nr-chip nr-chip-sp" title="Swiss-Prot 人工审校条目 — UniProt 归属可信度高">Swiss-Prot</span>'
      : h.db === 'tr'
        ? '<span class="nr-chip nr-chip-tr" title="UniProt TrEMBL 自动注释条目">TrEMBL</span>'
        : '<span class="nr-chip nr-chip-other" title="其他来源条目（非 UniProt 形态）">其他</span>'
    const accLink = h.db !== 'other' && /^[A-Z0-9]{6,10}$/.test(h.accession)
      ? `<a href="https://www.uniprot.org/uniprotkb/${h.accession}" target="_blank" rel="noopener">${h.accession}</a>`
      : esc(h.accession || '—')
    const descTitle = esc([h.description, h.organism ? `OS=${h.organism}` : '', h.geneName ? `GN=${h.geneName}` : ''].filter(Boolean).join(' '))
    return `
    <tr data-ident="${h.identity}" data-e="${Number.isFinite(h.evalue) ? h.evalue : ''}" data-cov="${covSpan}">
      <td class="td-id">${accLink}${h.entryName ? `<div class="nr-entry">${esc(h.entryName)}</div>` : ''}</td>
      <td class="t-desc" title="${descTitle}"><span class="t-clamp">${esc(h.description || '—')}</span></td>
      <td class="num">${h.identity.toFixed(1)}%</td>
      <td class="num">${esc(h.evalueRaw)}</td>
      <td class="num">${esc(range)}</td>
      <td>${dbChip}</td>
    </tr>`
  }
  return `
  <h3 class="itx-h3">UniProt 库序列匹配 <span class="itx-h3-sub">EBI BLAST · Swiss-Prot · ${hits.length} hits · 靶点身份识别</span></h3>
  <p class="note">PDB 库同源与 NCBI nr 全库均未能确定靶点身份（或检索失败）时，提交序列已自动改查 EBI BLAST（UniProtKB Swiss-Prot 人工审校库）定位真实蛋白身份 — 最佳命中达「一致性 ≥85% 且覆盖 ≥40%」即回填 UniProt 元数据（报告题目/刊头的「UniProt 匹配」标注即来源于此）。按显著性排序、同编号去重取最高一致性；「覆盖范围」为提交序列上的残基区间（首个 HSP，1-based 闭区间）。可经表头下方「排序」切换 Identity 降序等，并支持导出 CSV。</p>
  <div class="tbl-wrap"><table class="tbl-data tbl-blast" data-tbl="uniblast">
    <colgroup>
      <col style="width:118px"><col><col style="width:78px"><col style="width:92px"><col style="width:88px"><col style="width:96px">
    </colgroup>
    <thead><tr><th>UniProt / 编号</th><th>描述</th><th class="num">Identity</th><th class="num">E-value</th><th class="num" title="首个 HSP 在提交序列上的残基区间（1-based 闭区间）">覆盖范围</th><th>库</th></tr></thead>
    <tbody>${hits.map(nrRow).join('')}</tbody>
  </table></div>`
}

/** v2.67：BLAST 结果库切换（PDB 库 / nr 全库 — 两库都有命中时表头上方分段按钮；
 *  面板显隐由 TABLE_FILTER_JS 驱动，打印时两库面板自动全展开、打印后恢复切换态） */
function blastLibToggleHtml(pdbCount: number, nrCount: number): string {
  return `
  <div class="lib-toggle" role="group" aria-label="BLAST 结果库切换">
    <button type="button" class="lt-btn lt-on" data-lib="pdb" aria-pressed="true">PDB 库 · ${pdbCount} 同源结构</button>
    <button type="button" class="lt-btn" data-lib="nr" aria-pressed="false">nr 全库 · ${nrCount} 命中</button>
  </div>`
}

/** 文献条目（附关联 PDB chips）；expandAll=true 全量直出（v2.13 单独评估页要求） */
function litItemsHtml(lits: LiteratureItem[], pdbByPmid: Map<string, PdbEntry[]>, preview: number, expandAll = false): string {
  const shown = expandAll ? lits : lits.slice(0, preview)
  const rest = expandAll ? [] : lits.slice(preview)
  const item = (l: LiteratureItem, i: number) => {
    const linked = (pdbByPmid.get(String(l.pmid).trim()) ?? []).slice(0, 6)
    return `
    <li class="lit-item">
      <div class="lit-no">${String(i + 1).padStart(2, '0')}</div>
      <div class="lit-body">
        <div class="lit-title"><a href="https://pubmed.ncbi.nlm.nih.gov/${l.pmid}/" target="_blank" rel="noopener">${esc(l.title)}</a>${l.fromPdb ? '<span class="lit-src">结构解析文献</span>' : ''}</div>
        <div class="lit-meta">${esc(l.journal)}${l.year ? ` · ${esc(l.year)}` : ''}${l.doi ? ` · DOI: <a href="https://doi.org/${esc(l.doi)}" target="_blank" rel="noopener">${esc(l.doi)}</a>` : ''} · PMID ${esc(l.pmid)}</div>
        ${l.abstractExcerpt ? `<div class="lit-abs">${esc(l.abstractExcerpt)}</div>` : ''}
        ${linked.length ? `<div class="lit-pdbs"><span class="lit-pdbs-label">关联结构</span>${linked.map(p => `<a href="https://www.rcsb.org/structure/${p.pdbId}" target="_blank" rel="noopener" title="${esc(p.title)}">${p.pdbId}</a>`).join('')}</div>` : ''}
      </div>
    </li>`
  }
  const headHtml = shown.map((l, i) => item(l, i)).join('')
  if (rest.length === 0) return `<ol class="lit-list">${headHtml}</ol>`
  return `<ol class="lit-list">${headHtml}</ol>
  <details class="fold">
    <summary>展开其余 ${rest.length} 篇文献（共 ${lits.length} 篇，打印时自动展开）</summary>
    <ol class="lit-list" start="${preview + 1}">${rest.map((l, i) => item(l, preview + i)).join('')}</ol>
  </details>`
}

// ─── 图片内嵌（预算控制）──────────────────────────────────────────────────────
// 与 docx 提取上限（12 张）对齐：任意张数/任意类型组合（仅胶图、仅 SEC、多张混合）全部内嵌；
// 体积预算超出时按 gel > sec > other 优先级截断（每张落盘前已软压 ≤800KB，典型总量 2-5MB）
const EMBED_MAX_COUNT = 12
const EMBED_MAX_TOTAL = 9 * 1024 * 1024

export interface EmbeddedImage {
  meta: ParsedImage
  dataUri: string | null // null = 超预算未嵌入
}

export async function embedImages(
  images: ParsedImage[],
  resolvePath: (meta: ParsedImage) => string,
): Promise<EmbeddedImage[]> {
  // gel/sec 优先，同 kind 内按原顺序
  const ordered = [...images].sort((a, b) => rank(b) - rank(a))
  const result: EmbeddedImage[] = []
  let total = 0
  let embeddedCount = 0
  for (const meta of ordered) {
    let dataUri: string | null = null
    if (embeddedCount < EMBED_MAX_COUNT) {
      if (meta.dataUri) {
        // v2.4 无状态模式：图片已随请求内联携带（data URI），直接嵌入（估算解码后大小计入预算）
        const approxBytes = Math.floor((meta.dataUri.length * 3) / 4)
        if (total + approxBytes <= EMBED_MAX_TOTAL) {
          dataUri = meta.dataUri
          total += approxBytes
          embeddedCount++
        }
      } else {
        try {
          const buf = await fs.readFile(resolvePath(meta))
          if (buf.length > 0 && total + buf.length <= EMBED_MAX_TOTAL) {
            dataUri = `data:${meta.mime};base64,${buf.toString('base64')}`
            total += buf.length
            embeddedCount++
          }
        } catch { /* 文件缺失 → 不嵌入 */ }
      }
    }
    result.push({ meta, dataUri })
  }
  // 恢复原顺序
  result.sort((a, b) => images.indexOf(a.meta) - images.indexOf(b.meta))
  return result
}

function rank(i: ParsedImage): number {
  return i.kind === 'gel' ? 3 : i.kind === 'sec' ? 2 : 1
}

// ─── 报告组装 ────────────────────────────────────────────────────────────────

export interface ReportRenderInput {
  ctx: ReportContext
  methodStats: MethodStats
  llmMarkdown: string
  llmOk: boolean
  llmErrors: string[]
  jobId: string
  durationMs: number
  totalPdbFound: number
  /** 分析引擎摘要（如 “Z.ai GLM-4.6（内置）” / “OpenAI · gpt-4o”） */
  engineSummary: string
  /** 图片文件路径解析（由 pipeline 提供，图片存于 db/reports/{id}/assets/） */
  /** v2.0：AlphaFold 预测结构图（base64 data URI + 元数据；报告头右侧展示） */
  alphafoldFigure?: {
    dataUri: string
    modelId: string
    globalPlddt: number | null
    version: number
    fracVeryHigh: number | null
  }
  /** v2.7.2：AlphaFold 模型 PDB 文本 — 报告头内嵌 3Dmol 交互式 3D 视图
   *  （拖拽旋转/滚轮缩放/pLDDT 四段着色；无服务端浏览器依赖，离线单文件可交互） */
  alphafoldStructure?: {
    pdbText: string
    uniprotId: string
    modelId: string
    globalPlddt: number | null
    version: number
    fracVeryHigh: number | null
  }
  /** v2.15：ESMFold 预测结构（公共 ESM Atlas API — AFDB 无收录/纯序列输入时兜底）。
   *  交互视图与 AF 同构（3Dmol + pLDDT 四段着色）；仅在无 AF 结构时呈现 */
  esmfoldStructure?: {
    pdbText: string
    modelId: string
    globalPlddt: number | null
    fracVeryHigh: number | null
    sequenceLength: number
  }
  /** v2.46：UniProt DOMAIN 结构域区间（预测结构视图「按域着色」选项数据源；
   *  仅 AFDB 模型传（残基编号 = UniProt 坐标直接映射）；无 DOMAIN 注释时缺省
   *  → 工具条「UniProt 域」选项禁用置灰） */
  afDomains?: AfDomainRange[]
  resolveImagePath: (meta: ParsedImage) => string
}

/** PDB 直出条数（其余折叠） */
const PDB_PREVIEW = 20
/** 文献直出条数（其余折叠） */
const LIT_PREVIEW = 10

export type SingleBodyCtx = Omit<ReportContext, 'sequence' | 'uniprot'> & {
  sequence?: string
  /** 报告主体仅消费刊头元信息字段 — 合并报告从作业摘要重建时无需完整 UniprotInfo
   *  v2.31：补 processingChains（聚合蛋白 nsp 归属 — 题目标注与刊头「加工归属」行） */
  uniprot?: Pick<UniprotInfo, 'uniprotId' | 'entryName' | 'proteinName' | 'geneNames' | 'organism' | 'sequenceLength' | 'processingChains'> | null
}

/** v2.13：合并报告嵌入模式（各靶点单独评估页复用单靶点报告主体 — 格式一模一样） */
export interface SingleBodyEmbedOptions {
  /** 元素 id/锚点前缀（多视图页防 id 冲突，如 'Q7KYR7' → id='Q7KYR7-llm'） */
  idPrefix: string
  /** PDB 结构 / 文献 / 互作复合物结构清单全量直出（不折叠 — 单独评估页要求展开） */
  expandAll: boolean
  /** AF 交互 3D 视图走合并报告公共 MODELS 池（stage data-maf，无内嵌脚本/模型文本） */
  afPooled?: {
    mafKey: string
    modelId: string
    version: number
    globalPlddt: number | null
    fracVeryHigh: number | null
    pdbKb: number
    /** 无可内嵌模型（超预算/获取失败）— 仅展示统计信息卡 */
    metaOnly?: boolean
    /** v2.15：预测引擎标识 — 'esmfold' 时卡片标注 ESMFold（AFDB 无收录兜底）
     *  且外链改指 esmatlas.com；缺省即 AlphaFold */
    engine?: 'esmfold'
    /** v2.15：ESMFold 预测序列长度（engine='esmfold' 时展示） */
    sequenceLength?: number
    /** v2.46：UniProt DOMAIN 结构域区间（公共 MODELS 池视图「按域着色」用 —
     *  renderSingleReportBody 序列化进 stage data-domains，mtrViewerJs 初始化后
     *  随工具条挂载；仅 AFDB 引擎视图传，ESMFold 编号不对齐不传） */
    domains?: AfDomainRange[]
  }
  /** 客户实验数据图片走首页池复用（img 不带 src，由合并报告水合脚本从首页拷贝） */
  pooledImages?: boolean
  /** 历史批次重渲染：该靶点无独立 LLM 报告时的来源说明（注入评估分析章节头） */
  legacyNote?: string
}

export interface SingleReportBodyInput {
  ctx: SingleBodyCtx
  methodStats: MethodStats
  llmMarkdown: string
  llmOk: boolean
  llmErrors: string[]
  jobId: string
  durationMs: number
  totalPdbFound: number
  engineSummary: string
  alphafoldFigure?: ReportRenderInput['alphafoldFigure']
  alphafoldStructure?: ReportRenderInput['alphafoldStructure']
  esmfoldStructure?: ReportRenderInput['esmfoldStructure']
  /** v2.46：UniProt DOMAIN 区间（AF 视图「按域着色」；仅 AFDB 模型有值） */
  afDomains?: AfDomainRange[]
  /** 3Dmol bundle（单靶点报告外壳预取传入；合并嵌入模式无需 — 公共池脚本负责初始化） */
  af3dBundle?: string | null
  resolveImagePath?: (meta: ParsedImage) => string
  /** 预先内嵌的图片（合并报告全批次只内嵌一次，各靶点单独评估页共用） */
  embeddedImages?: EmbeddedImage[]
  embed?: SingleBodyEmbedOptions
}

/** 渲染单靶点报告主体（header → glance → 目录 → 各章节 → footer；不含 <html> 外壳）
 *  v2.13：单靶点报告与合并报告各靶点单独评估页同一实现 — 格式与风格完全一致。 */
export async function renderSingleReportBody(input: SingleReportBodyInput): Promise<string> {
  const { ctx, methodStats, llmMarkdown } = input
  const emb = input.embed
  const idOf = (base: string) => (emb?.idPrefix ? `${emb.idPrefix}-${base}` : base)
  const expandAll = emb?.expandAll === true
  const pooledImages = emb?.pooledImages === true
  const u = ctx.uniprot
  const dateStr = new Date().toISOString().slice(0, 10)
  // v1.23：题目体现评估范围（UniProt 残基编号区间）
  const rangeSuffix = ctx.range ? ` · 残基 ${ctx.range[0]}-${ctx.range[1]}` : ''
  // v2.16：序列靶点有身份识别（评估表名/nr 识别/同源推断）时题目用识别名 —
  // 不再笼统写「序列靶点评估」；后缀注明识别来源与一致性（评估表来源无后缀）
  const ti = ctx.targetIdentity
  // v2.44：已归属 UniProt 但经序列匹配（UniProt 匹配 / nr 识别）定位且非全同时，
  // 题目标注同源度（用户诉求「显示同源度，避免非标准名称作题目」— 全同 100% 不注）
  const identityTitleSuffix = u && ti && ti.identity != null && ti.identity < 99.95
    && (ti.source === 'uniprot-blast' || ti.source === 'blast-nr')
    ? ` · ${ti.source === 'uniprot-blast' ? 'UniProt 匹配' : 'nr 识别'} ${Math.round(ti.identity)}%`
    : ''
  // v2.31：聚合蛋白截短题目标注（P0DTD1 不同截短均为「Replicase polyprotein 1ab」—
  // 从 PTM/Processing 加工条目归属 nsp，题目区分同名截短靶点）
  const nspSuffix = nspTitleSuffix(u, ctx.range)
  const procMatch = u ? matchProcessingSegments(ctx.range, u.processingChains, u.sequenceLength) : null
  const proteinTitle = u
    ? `${u.proteinName}${nspSuffix}（${u.uniprotId}${identityTitleSuffix}${rangeSuffix}）`
    : ti
      ? `${ti.name}（序列靶点${targetIdentityTitleSuffix(ti)}${rangeSuffix}）`
      : (ctx.range ? `序列靶点评估 · 残基 ${ctx.range[0]}-${ctx.range[1]}` : '序列靶点评估')
  const geneStr = u?.geneNames.join(', ') || ctx.targetIdentity?.geneName || '—'

  // PMID ↔ PDB 双向关联
  const pdbByPmid = new Map<string, PdbEntry[]>()
  for (const p of ctx.directPdbs) {
    const key = (p.pubmedId ?? '').trim()
    if (!key) continue
    const arr = pdbByPmid.get(key)
    if (arr) arr.push(p)
    else pdbByPmid.set(key, [p])
  }
  const litByPmid = new Map<string, LiteratureItem>()
  for (const l of ctx.literature) {
    if (l.pmid) litByPmid.set(String(l.pmid).trim(), l)
  }
  const linkedLitCount = ctx.literature.filter(l => pdbByPmid.has(String(l.pmid).trim())).length

  const embedded = input.embeddedImages ?? (input.resolveImagePath ? await embedImages(ctx.images, input.resolveImagePath) : [])
  /** 图片在 embedded 数组中的全局序号（合并模式 data-fig-copy 池复用索引） */
  const figIdxOf = new Map(embedded.map((e, i) => [e, i]))

  // 构建信息（合并评估：UniProt+伴随序列）
  const cmp = ctx.providedSequence?.comparison
  const constructHtml = cmp
    ? `${cmp.start != null && cmp.end != null ? `${cmp.start}–${cmp.end} 位 / 全长 ${cmp.fullLength} aa` : `${cmp.providedLength} / ${cmp.fullLength} aa`}${cmp.sameTarget ? ` · 一致性 ${cmp.identity}%` : ` · 相似度 ${cmp.identity}% 疑似不同靶点`}`
    : ''

  // 动态章节编号（v1.28：结构分明 — 全部章节统一编号与视觉锚点）：
  // 一 评估分析 / 二 客户评估表要点（如存在）/ 三 可行性评分 / 四 PDB 结构清单 / 后续按存在性编号
  // v1.25：聚集形式不再单独成章 — 融入评分卡（调整明细 + 证据链折叠）与 LLM 叙事
  const cnNums = ['一', '二', '三', '四', '五', '六', '七', '八']
  const hasInsights = Boolean(ctx.insights && (
    ctx.insights.goals?.length || ctx.insights.scientificQuestions?.length
    || ctx.insights.experimentalSummary || ctx.insights.sequenceNotes
    || ctx.insights.homologs || ctx.insights.keyConcerns?.length))
  let secIdx = 0
  const nextNo = () => cnNums[secIdx++]
  const llmNo = nextNo()
  const insightsNo = hasInsights ? nextNo() : ''
  const scoresNo = nextNo()
  const pdbsNo = nextNo()
  // v1.7+：BLAST 章节在 0 命中/跳过/失败时也渲染状态说明（不再凭空消失）
  const blastRan = ctx.blastStatus && (ctx.blastStatus.status === 'ok' || ctx.blastStatus.status === 'no-hits')
  // v2.59：nr 全库检索命中存在时同样展示章节（身份识别证据）
  const blastNrCount = ctx.blastNrHits?.length ?? 0
  // v2.82：UniProt 库序列匹配命中存在时同样展示（身份识别证据 — EBI 通道）
  const uniBlastCount = ctx.uniprotBlastHits?.length ?? 0
  const showBlastSec = ctx.blastHits.length > 0 || Boolean(ctx.blastStatus) || blastNrCount > 0 || uniBlastCount > 0
  const ligNo = (ctx.ligands?.length ?? 0) > 0 ? nextNo() : ''
  // v2.7/v2.7.6 配体卡展示构件（ligDetailProps / ligStructFig / ligIdentFold / strategyZh）
  // 已提升为模块级共享导出 —— 单靶点与合并报告单源同版
  const ligandSecHtml = (ctx.ligands?.length ?? 0) > 0 ? `
  <section class="sec" id="${idOf('ligands')}">
    <h2><span class="sec-no">${ligNo}</span><span class="sec-title">配体研究数据</span><span class="sec-en">Ligands · ${ctx.ligands!.filter(l => l.ok).length}/${ctx.ligands!.length}</span></h2>
    <p class="note">非标准配体输入经多策略归一（直接 ID / 别名表 / PDBe Solr 检索 / PubChem / AI 兜底）映射为 RCSB 化学组分 ID；PDB 无对应组分时以 PubChem 详情（CID / 分子式 / MW / IUPAC 名）成卡。结构列表来自 PDBe 字段化检索（含该配体的 PDB 条目，按分辨率排序），绿底标记同时为本靶点直接结构的条目；计算性质与 2D 化学结构式来自 PubChem。</p>
    <div class="lig-grid">
    ${ctx.ligands!.map(l => {
      if (!l.ok) return `
      <div class="lig-card lig-fail">
        <div class="lig-head"><span class="lig-id lig-id-fail">?</span><span class="lig-name">${esc(l.raw.length > 40 ? l.raw.slice(0, 39) + '…' : l.raw)}</span></div>
        <div class="lig-meta"><span>未能归一 — ${esc(l.error ?? '未知原因')}</span></div>
      </div>`
      const d = l.detail
      const propsHtml = d ? ligDetailProps(d) : ''
      const structFig = ligStructFig(l)
      const identFold = ligIdentFold(l)
      // v2.2：PubChem 已识别但 PDB 无对应组分（如 Resmetirom）→ CID 详情卡（v2.7 + 性质/结构式）
      if (!l.compId) {
        const pc = l.pubchem
        const cid = d?.cid ?? pc?.cid
        return `
      <div class="lig-card">
        <div class="lig-main">
        ${structFig}
        <div class="lig-info">
        <div class="lig-head">
          ${cid
            ? `<a class="lig-id lig-id-pc" href="https://pubchem.ncbi.nlm.nih.gov/compound/${cid}" target="_blank" rel="noopener" title="在 PubChem 查看化合物详情">CID ${cid}</a>`
            : `<span class="lig-id lig-id-pc">已识别</span>`}
          <span class="lig-name">${esc(l.name || l.raw)}</span>
          <span class="lig-src">输入「${esc(l.raw.length > 24 ? l.raw.slice(0, 23) + '…' : l.raw)}」· ${esc(strategyZh(l.strategy))}${l.source === 'eval-table' ? ' · 评估表' : l.source === 'file' ? ' · 文件' : ''}</span>
        </div>
        <div class="lig-meta">
          <span>分子式 <b>${esc(l.formula || '—')}</b></span>
          ${l.weight != null ? `<span>MW <b>${l.weight.toFixed(1)}</b></span>` : ''}
        </div>
        ${propsHtml ? `<div class="lig-props">${propsHtml}</div>` : ''}
        ${(d?.iupacName ?? pc?.iupacName) ? `<div class="lig-iupac">IUPAC 名 ${esc((d?.iupacName ?? pc?.iupacName) ?? '')}</div>` : ''}
        ${identFold}
        </div>
        </div>
        <div class="lig-pdbs lig-none">PDB 化学组分库无对应条目 — 已通过 PubChem 识别，点击 CID 查看化合物详情</div>
      </div>`
      }
      const best = l.structures.find(s => s.resolution != null)?.resolution
      const chips = l.structures.slice(0, 12).map(s =>
        `<a class="${s.alsoTarget ? 'lig-also' : ''}" href="https://www.rcsb.org/structure/${s.pdbId}" target="_blank" rel="noopener" title="${esc(s.title)}${s.resolution != null ? ` · ${s.resolution}Å` : ''}${s.method ? ` · ${s.method}` : ''}${s.alsoTarget ? ' · 本靶点直接结构' : ''}">${s.pdbId}${s.resolution != null ? ` <i>${s.resolution.toFixed(1)}</i>` : ''}</a>`,
      ).join('')
      return `
      <div class="lig-card">
        <div class="lig-main">
        ${structFig}
        <div class="lig-info">
        <div class="lig-head">
          <span class="lig-id">${esc(l.compId)}</span>
          <span class="lig-name">${esc(l.name || l.raw)}</span>
          <span class="lig-src">输入「${esc(l.raw.length > 24 ? l.raw.slice(0, 23) + '…' : l.raw)}」· ${esc(strategyZh(l.strategy))}${l.source === 'eval-table' ? ' · 评估表' : l.source === 'file' ? ' · 文件' : ''}</span>
        </div>
        <div class="lig-meta">
          <span>分子式 <b>${esc(l.formula || '—')}</b></span>
          ${l.weight != null ? `<span>MW <b>${l.weight.toFixed(1)}</b></span>` : ''}
          <span>含该配体结构 <b>${l.totalStructures}</b> 个</span>
          ${best != null ? `<span>最佳分辨率 <b>${best.toFixed(2)} Å</b></span>` : ''}
        </div>
        ${propsHtml ? `<div class="lig-props">${propsHtml}</div>` : ''}
        ${(d?.iupacName ?? l.pubchem?.iupacName) ? `<div class="lig-iupac">IUPAC 名 ${esc((d?.iupacName ?? l.pubchem?.iupacName) ?? '')}</div>` : ''}
        ${identFold}
        </div>
        </div>
        ${l.structures.length ? `
        <div class="lig-pdbs">${chips}${l.totalStructures > 12 ? `<span class="lig-more">+${l.totalStructures - 12}</span>` : ''}</div>` : `<div class="lig-pdbs lig-none">暂无含该配体的 PDB 结构记录</div>`}
      </div>`
    }).join('')}
    </div>
  </section>` : ''
  const blastNo = showBlastSec ? nextNo() : ''
  const litNo = ctx.literature.length ? nextNo() : ''
  const assetsNo = embedded.length ? nextNo() : ''
  /** v1.28 章节头：编号方块 + 标题 + 英文标签（结构分明、便于导航） */
  const secHead = (no: string, title: string, en: string) =>
    `<span class="sec-no">${no}</span><span class="sec-title">${esc(title)}</span><span class="sec-en">${esc(en)}</span>`

  const scoreColor = (n: number) => (n >= 7 ? '#047857' : n >= 5 ? '#b45309' : '#b91c1c')

  // v1.25：聚集形式（寡聚态）— 评分卡内嵌调整明细 + 证据链折叠（不单独成章）
  const oligo = ctx.oligomer
  const adj = ctx.scores.oligomerAdjust
  const oligoConfZh = oligo ? describeOligoConfidence(oligo.confidence) : ''
  const oligoBadgeColor = oligo?.category === 'monomer' ? '#047857' : oligo?.category === 'hetero-complex' ? '#b45309' : oligo?.category === 'homo-oligomer' ? '#065f46' : '#78716c'
  const oligoCategoryZh = oligo?.category === 'monomer' ? '单体' : oligo?.category === 'homo-oligomer' ? '同源寡聚体' : oligo?.category === 'hetero-complex' ? '异源复合物' : '未知'
  const adjChip = (label: string, v: number) =>
    `<span class="adj-chip ${v > 0 ? 'adj-pos' : v < 0 ? 'adj-neg' : 'adj-zero'}">${label} ${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v)}</span>`
  // v2.18：AI 复核条（LLM 智能调分明细 — 评分卡内嵌，紧随评分依据）
  const llmA = ctx.scores.llmAdjust
  const llmAdjStripHtml = llmA ? `
    <div class="llm-adj-strip">
      <div class="llm-adj-head">
        <span class="llm-adj-badge">AI 复核</span>
        <span class="llm-adj-title">${llmA.applied ? `已微调系统评分${llmA.overall !== 0 ? `（总体 ${llmA.overall > 0 ? '+' : '−'}${Math.abs(llmA.overall)}）` : '（总体维持）'}` : '复核确认维持系统评分'}</span>
        <span class="llm-chips">${adjChip('X-ray', llmA.xray)}${adjChip('Cryo-EM', llmA.cryoem)}${adjChip('NMR', llmA.nmr)}</span>
        <span class="llm-conf">置信度：${llmA.confidence === 'high' ? '高' : llmA.confidence === 'medium' ? '中' : '低'}</span>
      </div>
      ${(llmA.notes.xray || llmA.notes.cryoem || llmA.notes.nmr || llmA.notes.overall) ? `
      <ul class="llm-notes">
        ${llmA.notes.xray ? `<li><b>X-ray</b>：${esc(llmA.notes.xray)}</li>` : ''}
        ${llmA.notes.cryoem ? `<li><b>Cryo-EM</b>：${esc(llmA.notes.cryoem)}</li>` : ''}
        ${llmA.notes.nmr ? `<li><b>NMR</b>：${esc(llmA.notes.nmr)}</li>` : ''}
        ${llmA.notes.overall ? `<li><b>总体</b>：${esc(llmA.notes.overall)}</li>` : ''}
      </ul>` : ''}
      <span class="llm-engine">复核引擎 ${esc(llmA.engine ?? '—')} · ${(llmA.durationMs / 1000).toFixed(1)}s — 调整幅度经服务端钳制（±2 以内），已计入上述分值</span>
    </div>` : ''
  const oligoStripHtml = oligo ? `
    <div class="oligo-strip">
      <div class="oligo-strip-head">
        <span class="oligo-badge" style="background:${oligoBadgeColor}">${esc(oligoCategoryZh)}</span>
        <span class="oligo-strip-label">聚集形式<b>${esc(oligo.label || oligo.summary.split('—')[0].split('（')[0].trim())}</b></span>
        ${oligo.stoichiometry ? `<span class="oligo-stoich">${esc(oligo.stoichiometry)}</span>` : ''}
        <span class="oligo-conf">置信度：${esc(oligoConfZh)}</span>
        ${adj ? `<span class="oligo-chips">${adjChip('X-ray', adj.xray)}${adjChip('Cryo-EM', adj.cryoem)}${adjChip('NMR', adj.nmr)}</span>` : ''}
      </div>
      ${adj ? `<p class="oligo-strip-note">${esc(adj.note)}（上述调整已计入三方法分数与综合评分）</p>` : `<p class="oligo-strip-note">${esc(oligo.summary)}</p>`}
      ${oligo.evidence.length ? `
      <details class="fold"><summary>聚集形式判定证据链（${oligo.evidence.length} 条 · 按优先级：已有结构 → 同源结构 → UniProt interaction → 文献）</summary>
      <div class="tbl-wrap"><table class="tbl-data">
        <thead><tr><th style="width:150px">来源</th><th style="width:110px">引用</th><th>证据</th></tr></thead>
        <tbody>${oligo.evidence.map(e => `
          <tr>
            <td>${esc(describeEvidenceSource(e.source))}</td>
            <td class="td-id">${/^[0-9A-Z]{4}$/.test(e.ref) ? `<a href="https://www.rcsb.org/structure/${e.ref}" target="_blank" rel="noopener">${e.ref}</a>` : /^PMID /.test(e.ref) ? `<a href="https://pubmed.ncbi.nlm.nih.gov/${e.ref.slice(5)}/" target="_blank" rel="noopener">${e.ref}</a>` : esc(e.ref)}</td>
            <td class="t-title">${esc(e.text)}</td>
          </tr>`).join('')}</tbody>
      </table></div></details>` : ''}
    </div>` : ''

  // v1.26/v1.27：分子量增重策略（小分子量靶点）— 评分卡内嵌（不单独成章，与聚集形式同区呈现）
  const mwA = ctx.mwAugment
  const mwAdj = ctx.scores.mwAugmentAdjust
  const mwPathZh = mwA?.assemblyPath === 'complex' ? '已有复合物结构' : mwA?.assemblyPath === 'oligomer' ? '自身寡聚装配' : mwA?.assemblyPath === 'homolog-complex' ? '同源复合物推断（BLAST）' : mwA?.assemblyPath === 'partner' ? (mwA.assemblyEvidence === 'complex' ? '互作伙伴推断（复合物结构支持）' : mwA.assemblyEvidence === 'homolog' ? '互作伙伴推断（同源复合物结构支持）' : '互作伙伴推断') : mwA?.assemblyPath === 'antibody' ? `抗原-抗体复合物（评估表提供的 ${mwA.antibodyPartner?.chains ?? '?'} 条抗体链）` : '无生物装配路径'
  const mwBadgeColor = mwA?.assemblyPath === 'homolog-complex'
    ? (mwA.assemblyKda != null && mwA.assemblyKda >= 100 ? '#0f766e' : '#b45309')
    : mwA?.assemblyKda != null && mwA.assemblyKda >= 100 ? '#065f46' : mwA?.assemblyKda != null && mwA.assemblyKda >= 50 ? '#b45309' : '#78716c'
  const mwHomologs = mwA?.homologComplexes ?? []
  const mwStripHtml = mwA?.applicable ? `
    <div class="oligo-strip mw-strip">
      <div class="oligo-strip-head">
        <span class="oligo-badge" style="background:${mwBadgeColor}">小分子量靶点</span>
        <span class="oligo-strip-label">分子量<b>单体 ~${mwA.monomerKda} kDa${mwA.assemblyKda != null ? ` → 装配 ~${mwA.assemblyKda} kDa${mwA.assemblyPath === 'homolog-complex' ? '（同源推断）' : ''}` : ''}</b></span>
        <span class="oligo-stoich">${esc(mwPathZh)}</span>
        ${mwAdj ? `<span class="oligo-chips">${adjChip('X-ray', mwAdj.xray)}${adjChip('Cryo-EM', mwAdj.cryoem)}${adjChip('NMR', mwAdj.nmr)}</span>` : ''}
      </div>
      ${mwAdj ? `<p class="oligo-strip-note">${esc(mwAdj.note)}（分子量调整已计入 Cryo-EM 分数与综合评分；X-ray/NMR 不受增重影响${mwA.assemblyKda != null ? '；装配分子量已知时，聚集形式维度的 Cryo-EM 分量并入本维度计分（避免双重加分）' : ''}）</p>` : ''}
      ${mwA.homologSearchNote ? `<p class="oligo-strip-note">${esc(mwA.homologSearchNote)}</p>` : ''}
      ${mwA.complexes.length || mwHomologs.length || mwA.partners.some(p => p.kda != null) || mwA.conflicts.length ? `
      <details class="fold"><summary>增重路径明细（复合物结构 ${mwA.complexes.length} · 同源复合物 ${mwHomologs.length} · 互作伙伴 ${mwA.partners.filter(p => p.kda != null).length} · 目的比对 ${mwA.conflicts.length} 条）</summary>
        ${mwA.complexes.length ? `
        <p class="note"><b>已有复合物结构 — 组分总分子量统计</b>（RCSB 实体/装配口径）</p>
        <div class="tbl-wrap"><table class="tbl-data">
          <thead><tr><th style="width:86px">PDB</th><th style="width:150px">方法 · 分辨率</th><th>组分（+ 总分子量）</th><th style="width:110px">装配总 MW</th></tr></thead>
          <tbody>${mwA.complexes.map(c => `
            <tr>
              <td class="td-id"><a href="https://www.rcsb.org/structure/${c.pdbId}" target="_blank" rel="noopener">${c.pdbId}</a></td>
              <td>${esc(c.method.slice(0, 18))}${c.resolution != null ? ` · ${c.resolution}Å` : ''}</td>
              <td class="t-title">${c.components.map(x => `<span class="${x.isTarget ? 'mw-target' : 'mw-partner'}">${esc(x.name.slice(0, 34))} ~${x.kda} kDa</span>`).join(' + ')}<br><span class="mw-basis">${esc(c.note)}</span></td>
              <td><b>~${c.totalKda} kDa</b></td>
            </tr>`).join('')}</tbody>
        </table></div>` : ''}
        ${mwHomologs.length ? `
        <p class="note"><b>同源结构形成的大复合物（BLAST 扩展检索）</b>— 直接装配路径不足 50 kDa 时检索；同源亚基按靶点单体换算</p>
        <div class="tbl-wrap"><table class="tbl-data">
          <thead><tr><th style="width:86px">PDB</th><th style="width:64px">Identity</th><th style="width:132px">方法 · 分辨率</th><th>组分（同源装配口径）</th><th style="width:96px">同源装配</th><th style="width:96px">靶点换算</th></tr></thead>
          <tbody>${mwHomologs.map(h => `
            <tr>
              <td class="td-id"><a href="https://www.rcsb.org/structure/${h.pdbId}" target="_blank" rel="noopener">${h.pdbId}</a></td>
              <td><b>${Math.round(h.identity)}%</b></td>
              <td>${esc(h.method.slice(0, 16))}${h.resolution != null ? ` · ${h.resolution}Å` : ''}</td>
              <td class="t-title">${esc(h.componentSummary)}<br><span class="mw-basis">${esc(h.note)}</span></td>
              <td>~${h.totalKda} kDa</td>
              <td><b>~${h.estimatedKda} kDa</b></td>
            </tr>`).join('')}</tbody>
        </table></div>` : ''}
        ${(() => { const ps = mwA.partners.filter(p => p.kda != null); return ps.length ? `
        <p class="note"><b>UniProt 互作伙伴</b>（按 1:1 估计；v2.33 可信度分级 — 仅复合物/同源复合物结构证据支持的伙伴计入装配估计，其余仅作参考并警示）</p>
        <ul class="mw-list">${ps.slice(0, 8).map(p => `<li><span class="mw-partner">${esc((p.geneName ?? p.proteinName ?? p.accession).slice(0, 40))}</span> <span class="mono">${esc(p.accession)}</span>${evidenceChipHtml(p.evidenceLevel)}— ${p.lengthAa} aa，~${p.kda} kDa${p.evidencePdbIds?.length ? `（证据：${p.evidencePdbIds.map(id => `<a href="https://www.rcsb.org/structure/${id}" target="_blank" rel="noopener">${id}</a>`).join(' ')}）` : (p.evidenceLevel === 'complex' || p.evidenceLevel === 'homolog') ? '' : '（无结构证据支持，未计入装配估计 — 不可据此认定可用于 Cryo-EM 增重）'}${mwA.assemblyPath === 'partner' && (p.evidenceLevel === 'complex' || p.evidenceLevel === 'homolog') && p.kda === Math.max(...ps.filter(x => x.evidenceLevel === 'complex' || x.evidenceLevel === 'homolog').map(x => x.kda ?? 0)) ? '（已计入装配估计）' : ''}</li>`).join('')}</ul>` : '' })()}
        <p class="note"><b>技术增重工具箱</b>（无生物装配路径时的兜底策略；需评估开发周期）</p>
        <ul class="mw-list">${mwA.options.map(o => `<li><b>${esc(o.name)}</b>（${esc(o.addKda)}）— ${esc(o.note)}</li>`).join('')}</ul>
        ${mwA.conflicts.length ? `
        <p class="note"><b>与客户目的的比对</b>（加入的蛋白是否与目的冲突 — 契合 / 需注意 / 冲突）</p>
        <ul class="mw-list">${mwA.conflicts.map(c => `<li><span class="mw-conf-tag mw-${c.level}">${c.level === 'aligned' ? '契合' : c.level === 'caution' ? '需注意' : '冲突'}</span> ${esc(c.text)}</li>`).join('')}</ul>` : ''}
      </details>` : ''}
    </div>` : ''

  // v1.29：互作复合物证据条（无直接结构时；评分卡内嵌，不单独成章）
  const itxA = ctx.interaction
  const itxAdj = ctx.scores.interactionAdjust
  const itxBest = itxA?.complexes[0]
  const interactionStripHtml = itxA?.applicable && itxA.hasEvidence ? `
    <div class="oligo-strip itx-strip">
      <div class="oligo-strip-head">
        <span class="oligo-badge" style="background:${itxAdj?.level === 'curated' ? '#0f766e' : '#b45309'}">${itxAdj?.level === 'curated' ? 'Complex Portal' : 'IntAct 互作'}</span>
        <span class="oligo-strip-label">互作证据<b>${esc(itxBest ? `${itxBest.complexAc}${itxBest.assembly ? ` · ${itxBest.assembly}` : ''}` : 'binary 伙伴')}</b></span>
        ${itxAdj ? `<span class="oligo-chips">${adjChip('X-ray', itxAdj.xray)}${adjChip('Cryo-EM', itxAdj.cryoem)}${adjChip('NMR', itxAdj.nmr)}</span>` : ''}
      </div>
      <p class="oligo-strip-note">${esc(itxA.summary)}${itxAdj ? '（上述调整已计入对应方法分数与综合评分；curated 复合物接管 Cryo-EM 分子量分量时，分子量增重与聚集形式维度的 Cryo-EM 分量不再重复计分）' : ''}${itxA.complexes.length ? ' — 组分结构清单（共有结构/单独结构分类）见「PDB 结构清单」章节。' : ''}</p>
      ${itxA.notes.length ? `<details class="fold"><summary>互作证据要点与策略影响（${itxA.notes.length} 条）</summary><ul class="mw-list">${itxA.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul></details>` : ''}
    </div>` : ''

  const scoreHtml = `
  <div class="score-card">
    ${scoreBar('X-ray 结晶', ctx.scores.xray, scoreColor(ctx.scores.xray.score), '', llmA?.xray ?? 0)}
    ${scoreBar('Cryo-EM', ctx.scores.cryoem, scoreColor(ctx.scores.cryoem.score), '', llmA?.cryoem ?? 0)}
    ${scoreBar('NMR', ctx.scores.nmr, scoreColor(ctx.scores.nmr.score), '', llmA?.nmr ?? 0)}
    ${scoreBar('综合评估', ctx.scores.overall, scoreColor(ctx.scores.overall.score), 'row-overall', llmA?.overall ?? 0)}
    <div class="score-rationale">
      ${rationaleCell('X-ray', ctx.scores.rationale.xray)}
      ${rationaleCell('Cryo-EM', ctx.scores.rationale.cryoem)}
      ${rationaleCell('NMR', ctx.scores.rationale.nmr)}
      ${rationaleCell('综合', ctx.scores.rationale.overall)}
    </div>
    ${llmAdjStripHtml}
    ${oligoStripHtml}
    ${mwStripHtml}
    ${interactionStripHtml}
  </div>`

  // ─── v1.28 核心结论速览（At a Glance）：关键结论前置，10 秒抓住要点 ──────
  const methodsRanked = [
    { label: 'X-ray 结晶', s: ctx.scores.xray },
    { label: 'Cryo-EM', s: ctx.scores.cryoem },
    { label: 'NMR', s: ctx.scores.nmr },
  ].sort((a, b) => b.s.score - a.s.score)
  const topM = methodsRanked[0]
  const secondM = methodsRanked[1]
  const methodTie = topM.s.score === secondM.s.score
  const recommendVal = methodTie ? `${topM.label} / ${secondM.label}` : topM.label
  const recommendSub = methodTie
    ? `两方法并列 ${topM.s.score}/10 — 按靶点特点与周期取舍`
    : `${topM.s.score}/10 · 备选 ${secondM.label} ${secondM.s.score}/10`

  const bestIdentity = ctx.blastHits.length ? Math.max(...ctx.blastHits.map(h => h.identity)) : null
  let blastTileVal: string
  let blastTileSub: string
  let blastTileWarn = false
  if (ctx.blastHits.length) {
    blastTileVal = `${ctx.blastHits.length} 个同源结构`
    blastTileSub = `最高 identity ${bestIdentity!.toFixed(0)}%${ctx.blastStatus?.provider === 'rcsb' ? ' · RCSB 检索' : ''}`
  } else if (ctx.blastStatus?.status === 'no-hits') {
    blastTileVal = '无显著同源命中'
    blastTileSub = '检索已完成 — 全新靶点，无先例可借鉴'
  } else if (ctx.blastStatus?.status === 'failed') {
    blastTileVal = '同源检索失败'
    blastTileSub = '本报告不含同源证据 — 建议重新评估'
    blastTileWarn = true
  } else if (ctx.blastStatus) {
    blastTileVal = '未单独检索'
    blastTileSub = describeBlastStatus(ctx.blastStatus).split('（')[0].slice(0, 30)
  } else {
    blastTileVal = '—'
    blastTileSub = '未记录检索状态'
  }

  const mwA2 = ctx.mwAugment
  let mwTileVal: string
  let mwTileSub: string
  if (mwA2?.applicable) {
    mwTileVal = mwA2.assemblyKda != null
      ? `单体 ~${mwA2.monomerKda} kDa → 装配 ~${mwA2.assemblyKda} kDa`
      : `单体 ~${mwA2.monomerKda} kDa（小分子量）`
    mwTileSub = mwA2.assemblyKda != null
      ? `${mwPathZh}${mwA2.assemblyPath === 'homolog-complex' ? ' — 需实验验证' : ''}`
      : '无生物装配增重路径 — 需技术增重'
  } else {
    mwTileVal = mwA2 ? `单体 ~${mwA2.monomerKda} kDa` : `${ctx.uniprot?.sequenceLength ?? ctx.sequence?.length ?? 0} aa`
    mwTileSub = '分子量处于常规适配区间'
  }

  // v1.29：互作复合物 tile（无直接结构且有证据时）
  const itxTile = ctx.interaction?.applicable && ctx.interaction.hasEvidence
    ? (() => {
        const best = ctx.interaction!.complexes[0]
        const val = best ? best.complexAc : 'binary 伙伴'
        const binStruct = ctx.interaction!.binaryPartners.filter(b => b.evidenceLevel === 'complex' || b.evidenceLevel === 'homolog').length
        const sub = best
          ? `${best.componentsWithStructure}/${best.components.length - 1} 组分有结构${best.sharedPdbTotal ? ` · 共有 ${best.sharedPdbTotal}` : ''}${best.assemblyKda != null ? ` · 装配 ~${best.assemblyKda} kDa` : ''}`
          : ctx.interaction!.binaryPartners.length
            ? `${ctx.interaction!.binaryPartners.length} 个伙伴 · ${binStruct} 个有结构证据可信`
            : 'binary 伙伴均无结构'
        return `<div class="glance-tile"><div class="gt-label">互作复合物</div><div class="gt-value">${esc(val)}</div><div class="gt-sub">${esc(sub)} · ${best ? 'Complex Portal' : 'IntAct'}</div></div>`
      })()
    : ''

  const glanceHtml = `
  <section class="glance" id="${idOf('glance')}" aria-label="核心结论速览">
    <div class="glance-kicker">Key Findings · 核心结论速览</div>
    <div class="glance-grid">
      <div class="glance-hero">
        <div class="glance-score" style="color:${scoreColor(ctx.scores.overall.score)}">${ctx.scores.overall.score}<span>/10</span></div>
        <div class="glance-hero-label">综合可行性 · ${esc(ctx.scores.overall.rating)}</div>
        <span class="glance-rating" style="background:${scoreColor(ctx.scores.overall.score)}">${esc(ctx.scores.overall.rating.split('·')[1] ?? ctx.scores.overall.rating)}</span>
        ${llmA ? `<span class="glance-ai-tag" title="评分经 AI 专家复核${llmA.applied ? '微调' : '确认'} — 详见「可行性评分」章节">AI 复核${llmA.applied ? (llmA.overall > 0 ? ` +${llmA.overall}` : llmA.overall < 0 ? ` −${Math.abs(llmA.overall)}` : '') : ' · 维持'}</span>` : ''}
      </div>
      <div class="glance-tiles">
        <div class="glance-tile"><div class="gt-label">推荐方法</div><div class="gt-value">${esc(recommendVal)}</div><div class="gt-sub">${esc(recommendSub)}</div></div>
        <div class="glance-tile ${ctx.directPdbs.length === 0 ? 'gt-warn' : ''}"><div class="gt-label">已有结构</div><div class="gt-value">${ctx.directPdbs.length > 0 ? `${ctx.directPdbs.length} 个` : '无（全新靶点）'}</div><div class="gt-sub">${ctx.directPdbs.length > 0 ? `X-ray ${methodStats.xrayCount} · Cryo-EM ${methodStats.cryoemCount} · NMR ${methodStats.nmrCount}${methodStats.bestResolution != null ? ` · 最佳 ${methodStats.bestResolution.toFixed(2)}Å` : ''}` : ctx.interaction?.hasEvidence ? '结构证据来自互作复合物组分（见互作复合物 tile）' : 'RCSB 无直接关联结构 — 依据同源与文献判断'}</div></div>
        ${itxTile}
        <div class="glance-tile ${blastTileWarn ? 'gt-warn' : ''}"><div class="gt-label">同源参考</div><div class="gt-value">${esc(blastTileVal)}</div><div class="gt-sub">${esc(blastTileSub)}</div></div>
        ${oligo ? `<div class="glance-tile"><div class="gt-label">聚集形式</div><div class="gt-value">${esc(oligo.label || oligoCategoryZh)}</div><div class="gt-sub">${esc(oligo.stoichiometry ? oligo.stoichiometry + ' · ' : '')}置信度${esc(oligoConfZh)}</div></div>` : ''}
        <div class="glance-tile"><div class="gt-label">分子量</div><div class="gt-value">${esc(mwTileVal)}</div><div class="gt-sub">${esc(mwTileSub)}</div></div>
        <div class="glance-tile"><div class="gt-label">结构覆盖率</div><div class="gt-value">${ctx.coverage ? ctx.coverage.coveragePercent + '%' : '—'}</div><div class="gt-sub">${ctx.coverage ? (ctx.gapText ? '存在未覆盖区间（见评分与结构章节）' : '已有结构覆盖完整') : '无覆盖率数据（PDBe 未返回）'}</div></div>
      </div>
    </div>
    <div class="glance-foot">推荐路线：${esc(topM.label)}为主${methodTie ? '' : `，${esc(secondM.label)}备选`} — 评分依据与增重/寡聚调整${llmA ? '与 AI 复核意见' : ''}详见「可行性评分」章节，实验策略详见「评估分析」的推荐技术路线与实验方案建议。</div>
  </section>`

  // 实验图分组展示：gel / sec / other 各成小组，类型一目了然
  const figGroupDefs: Array<{ kind: 'gel' | 'sec' | 'other'; title: string; en: string }> = [
    { kind: 'gel', title: 'SDS-PAGE 胶图', en: 'SDS-PAGE' },
    { kind: 'sec', title: 'SEC 分子筛色谱图', en: 'SEC Profile' },
    { kind: 'other', title: '其他实验图', en: 'Others' },
  ]
  const vlmCount = embedded.filter(e => e.meta.vlmKind).length
  const figGroups = figGroupDefs
    .map(g => ({ ...g, items: embedded.filter(e => e.meta.kind === g.kind) }))
    .filter(g => g.items.length > 0)
  let figNo = 0
  const imagesHtml = embedded.length ? `
  <section class="sec" id="${idOf('assets')}">
    <h2>${secHead(assetsNo, `客户提供的实验数据（${embedded.length} 张）`, `${figGroups.map(g => `${g.en} × ${g.items.length}`).join(' · ')}${vlmCount ? ' · AI 识别' : ''}`)}</h2>
    ${figGroups.map(g => `
    <h3 class="fig-group">${g.title}<span class="fig-group-count">${g.items.length} 张</span></h3>
    <div class="fig-grid">
    ${g.items.map((item) => {
      const { meta, dataUri } = item
      figNo += 1
      const figIdx = figIdxOf.get(item) ?? -1
      const imgTag = dataUri
        ? `<img${pooledImages ? '' : ` src="${dataUri}"`} alt="${esc(meta.caption)}" loading="lazy">`
        : `<div class="fig-missing">图片体积超出内嵌预算，请通过系统查看</div>`
      return `
      <figure class="fig"${pooledImages && figIdx >= 0 ? ` data-fig-copy="${figIdx}"` : ''}>
        ${imgTag}
        <figcaption><span class="fig-tag fig-${meta.kind}">${meta.kind === 'gel' ? 'SDS-PAGE' : meta.kind === 'sec' ? 'SEC' : '图'}</span>${meta.vlmKind ? '<span class="fig-tag fig-ai">AI 视觉识别</span>' : ''}图 ${figNo}：${esc(meta.caption)}</figcaption>
      </figure>`
    }).join('')}
    </div>`).join('')}
  </section>` : ''

  const pdbCountHtml = `${ctx.directPdbs.length}${input.totalPdbFound > ctx.directPdbs.length ? ` / 检索命中 ${input.totalPdbFound}` : ''}`

  // v2.7.6 ④：覆盖率区段图（PDB 结构清单章节头部 — 已覆盖/未覆盖区间一目了然）
  const covFigHtml = coverageFigureHtml(ctx.coverage, u ? u.sequenceLength : (ctx.sequence?.length ?? 0))

  // v2.7.2：AlphaFold 头图 — 优先内嵌 3Dmol 交互式 3D 视图（拖拽旋转/滚轮缩放，
  // pLDDT 四段着色；与无头截图页共用 plddtStyleApplyJs 同一着色实现）。失败降级链：
  // 交互视图 → legacy 静态 PNG（磁盘缓存命中时）→ 仅统计信息；打印/无 WebGL 时
  // poster 静态图兜底（viewer 初始化成功后用 pngURI 生成打印海报）。
  const af3dBundle = input.af3dBundle ?? (input.alphafoldStructure ? await ensure3DmolBundle() : null)
  const af = input.alphafoldStructure
  const afP = emb?.afPooled
  /** v2.15：池化引擎为 ESMFold — 卡片标注/外链切换为 ESM Atlas 口径 */
  const efP = afP?.engine === 'esmfold' ? afP : undefined
  // v2.46：下载文件名 + 域着色数据（脚本安全转义 — JSON 内 < 转为 \u003c 防 </script 逃逸）
  const fnSafe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_')
  const afPooledFn = afP ? (efP ? 'ESMFold_prediction.pdb' : fnSafe(`${afP.modelId}-model_v${afP.version}.pdb`)) : ''
  const afPooledDomainsAttr = afP && !efP && afP.domains?.length ? ` data-domains="${esc(JSON.stringify(afP.domains))}"` : ''
  const afFileName = af ? fnSafe(`${af.modelId}-model_v${af.version}.pdb`) : ''
  const afDomainsJs = JSON.stringify(input.afDomains ?? null).replace(/</g, '\\u003c')
  // v2.13：合并报告嵌入 — AF 视图走公共 MODELS 池（data-maf stage 由合并报告统一
  // 初始化）；无可内嵌模型时降级统计卡（mtr-af-stat — 合并报告附加样式）。
  const afBlockHtml = afP ? `
      <figure class="af-fig">
        ${afP.metaOnly
        ? `<div class="mtr-af-stat">
          <div class="mtr-af-stat-line">${esc(afP.modelId)}${efP ? ` · ${efP.sequenceLength ?? '—'} aa` : ` · v${afP.version}`} · 平均 pLDDT ${afP.globalPlddt ?? '—'}${afP.fracVeryHigh != null ? ` · pLDDT ≥90 区段 ${Math.round(afP.fracVeryHigh * 100)}%` : ''}</div>
          <div class="mtr-af-stat-note">${efP ? 'ESMFold 模型体积超出内嵌预算或本次获取失败 — 交互视图请前往 ESM Atlas（下方链接）' : '模型体积超出内嵌预算或本次获取失败 — 交互视图请前往 AlphaFold DB（下方链接）'}</div>
          <a class="mtr-af-link" href="${efP ? 'https://esmatlas.com/resources?action=fold' : `https://alphafold.ebi.ac.uk/entry/${esc(afP.mafKey)}`}" target="_blank" rel="noopener">${efP ? 'esmatlas.com' : 'alphafold.ebi.ac.uk'} →</a>
        </div>`
        : `<div class="af-stage" data-maf="${esc(afP.mafKey)}" data-afn="${esc(afPooledFn)}"${afPooledDomainsAttr}>
          <div class="af-canvas"></div>
          <img class="af-poster" alt="${efP ? 'ESMFold' : 'AlphaFold'} 预测结构（pLDDT 着色）">
        </div>
        <div class="af-legend">
          <span><i style="background:#0053D6"></i>pLDDT ≥ 90</span>
          <span><i style="background:#65CBF3"></i>70–90</span>
          <span><i style="background:#FFDB13"></i>50–70</span>
          <span><i style="background:#FF7D45"></i>&lt; 50</span>
        </div>`}
        <figcaption>${efP ? `<b>ESMFold 预测结构</b> · 拖拽旋转 · 滚轮缩放 · pLDDT 置信着色 · 点击放大后可切换彩虹着色、下载 PDB 模型<br>${esc(afP.modelId)}（ESM Atlas 公共 API）· ${efP.sequenceLength ?? '—'} aa · 平均 pLDDT ${afP.globalPlddt ?? '—'} · ${afP.pdbKb}KB 内嵌模型<br>该靶点在 AlphaFold DB 无收录 — 由 ESM-2 语言模型单序列预测（无 MSA，可信度低于 AF2）· <a href="https://esmatlas.com/resources?action=fold" target="_blank" rel="noopener">esmatlas.com →</a>` : `<b>AlphaFold 预测结构</b> · 拖拽旋转 · 滚轮缩放 · pLDDT 置信着色 · 点击放大后可切换彩虹 / UniProt 域着色、下载 PDB 模型<br>${esc(afP.modelId)} · v${afP.version} · 平均 pLDDT ${afP.globalPlddt ?? '—'} · ${afP.pdbKb}KB 内嵌模型<br><a href="https://alphafold.ebi.ac.uk/entry/${esc(afP.mafKey)}" target="_blank" rel="noopener">alphafold.ebi.ac.uk →</a>`}</figcaption>
      </figure>` : af ? `
      <figure class="af-fig">
        <div class="af-stage" id="af-stage">
          <div class="af-canvas" id="af-canvas"></div>
          <img id="af-poster" class="af-poster"${input.alphafoldFigure ? ` src="${input.alphafoldFigure.dataUri}"` : ''} alt="AlphaFold 预测结构静态视图（pLDDT 着色）">
        </div>
        <div class="af-legend">
          <span><i style="background:#0053D6"></i>pLDDT ≥ 90</span>
          <span><i style="background:#65CBF3"></i>70–90</span>
          <span><i style="background:#FFDB13"></i>50–70</span>
          <span><i style="background:#FF7D45"></i>&lt; 50</span>
        </div>
        ${af3dBundle ? `<script>${af3dBundle.replace(/<\/script/gi, '<\\/script')}</script>` : ''}
        <script>${afToolbarJs()}</script>
        <script>
        (function () {
          var stage = document.getElementById('af-stage');
          var cv = document.getElementById('af-canvas');
          var poster = document.getElementById('af-poster');
          function fail() { if (stage) stage.className = 'af-stage af-fail'; }
          function init() {
            try {
              if (!window.$3Dmol || !cv) return fail();
              var pdb = ${JSON.stringify(af.pdbText).replace(/<\//g, '<\\/')};
              var viewer = $3Dmol.createViewer(cv, { defaultcolors: $3Dmol.rasmolElementColors });
              viewer.setBackgroundColor(0xffffff);
              viewer.addModel(pdb, 'pdb');
              ${plddtStyleApplyJs()}
              viewer.zoomTo();
              viewer.zoom(1.2);
              viewer.render();
              stage.className = 'af-stage af-live';
              window.__afViewerReady = true;
              window.__afViewer = viewer; // v2.7.7：全屏放大后显式 resize（ResizeObserver 之外的保险）
              try {
                var uri = viewer.pngURI ? viewer.pngURI() : null;
                if (uri && poster) poster.src = uri;
              } catch (e) { /* 打印海报生成失败不影响交互 */ }
              // v2.46：挂载「下载 PDB + 着色切换」工具条（域着色仅 AFDB 模型 — 残基编号 = UniProt 坐标）
              try {
                if (window.__afTb && window.__afTb.mount) window.__afTb.mount(stage, viewer, pdb, { fileName: ${JSON.stringify(afFileName)}, domains: ${afDomainsJs} });
              } catch (e) { /* 工具条失败不影响视图 */ }
            } catch (e) { fail(); }
          }
          if (window.$3Dmol) init();
          else {
            var s = document.createElement('script');
            s.src = 'https://3Dmol.org/build/3Dmol-min.js';
            s.onload = init; s.onerror = fail;
            (document.head || document.documentElement).appendChild(s);
          }
        })();
        </script>
        <figcaption><b>AlphaFold 预测结构</b> · 拖拽旋转 · 滚轮缩放 · pLDDT 置信着色 · 点击放大后可切换彩虹 / UniProt 域着色、下载 PDB 模型<br>${esc(af.modelId)} · v${af.version} · 平均 pLDDT ${af.globalPlddt ?? '—'} · ${Math.round(af.pdbText.length / 1024)}KB 内嵌模型<br><a href="https://alphafold.ebi.ac.uk/entry/${esc(af.uniprotId)}" target="_blank" rel="noopener">alphafold.ebi.ac.uk →</a></figcaption>
      </figure>`
    : (input.alphafoldFigure ? `
      <figure class="af-fig">
        <img src="${input.alphafoldFigure.dataUri}" alt="AlphaFold 预测结构（pLDDT 着色）">
        <figcaption><b>AlphaFold 预测结构</b> · pLDDT 着色<br>${esc(input.alphafoldFigure.modelId)} · v${input.alphafoldFigure.version} · 平均 pLDDT ${input.alphafoldFigure.globalPlddt ?? '—'}<br><a href="https://alphafold.ebi.ac.uk/entry/${u ? u.uniprotId : ''}" target="_blank" rel="noopener">alphafold.ebi.ac.uk →</a></figcaption>
      </figure>` : '')

  // v2.15：ESMFold 预测结构（公共 ESM Atlas API）— AFDB 无收录/纯序列输入靶点的
  // 兜底预测。仅在无 AF 区块时呈现（引擎互斥：有 AFDB 模型不占用公共服务配额）；
  // 交互视图与 AF 同构（3Dmol + pLDDT 四段着色 + 全屏放大 + 打印海报），
  // 元素 id 经 idOf 前缀化（合并报告多靶点单文档防冲突）。
  const ef = !afP && !af ? input.esmfoldStructure : undefined
  const efBlockHtml = ef ? `
      <figure class="af-fig">
        <div class="af-stage" id="${idOf('ef-stage')}">
          <div class="af-canvas" id="${idOf('ef-canvas')}"></div>
          <img id="${idOf('ef-poster')}" class="af-poster" alt="ESMFold 预测结构静态视图（pLDDT 着色）">
        </div>
        <div class="af-legend">
          <span><i style="background:#0053D6"></i>pLDDT ≥ 90</span>
          <span><i style="background:#65CBF3"></i>70–90</span>
          <span><i style="background:#FFDB13"></i>50–70</span>
          <span><i style="background:#FF7D45"></i>&lt; 50</span>
        </div>
        ${af3dBundle ? `<script>${af3dBundle.replace(/<\/script/gi, '<\\/script')}</script>` : ''}
        <script>${afToolbarJs()}</script>
        <script>
        (function () {
          var stage = document.getElementById('${idOf('ef-stage')}');
          var cv = document.getElementById('${idOf('ef-canvas')}');
          var poster = document.getElementById('${idOf('ef-poster')}');
          function fail() { if (stage) stage.className = 'af-stage af-fail'; }
          function init() {
            try {
              if (!window.$3Dmol || !cv) return fail();
              var pdb = ${JSON.stringify(ef.pdbText).replace(/<\//g, '<\\/')};
              var viewer = $3Dmol.createViewer(cv, { defaultcolors: $3Dmol.rasmolElementColors });
              viewer.setBackgroundColor(0xffffff);
              viewer.addModel(pdb, 'pdb');
              ${plddtStyleApplyJs()}
              viewer.zoomTo();
              viewer.zoom(1.2);
              viewer.render();
              stage.className = 'af-stage af-live';
              window.__afViewerReady = true;
              window.__afViewer = viewer; // 全屏放大后显式 resize（与 AF 视图同保险）
              try {
                var uri = viewer.pngURI ? viewer.pngURI() : null;
                if (uri && poster) poster.src = uri;
              } catch (e) { /* 打印海报生成失败不影响交互 */ }
              // v2.46：挂载工具条（ESMFold 残基编号自 1 起与 UniProt 坐标不保证
              // 对齐 → 不传 domains，域着色选项禁用置灰）
              try {
                if (window.__afTb && window.__afTb.mount) window.__afTb.mount(stage, viewer, pdb, { fileName: 'ESMFold_prediction.pdb' });
              } catch (e) { /* 工具条失败不影响视图 */ }
            } catch (e) { fail(); }
          }
          if (window.$3Dmol) init();
          else {
            var s = document.createElement('script');
            s.src = 'https://3Dmol.org/build/3Dmol-min.js';
            s.onload = init; s.onerror = fail;
            (document.head || document.documentElement).appendChild(s);
          }
        })();
        </script>
        <figcaption><b>ESMFold 预测结构</b> · 拖拽旋转 · 滚轮缩放 · pLDDT 置信着色 · 点击放大后可切换彩虹着色、下载 PDB 模型<br>${esc(ef.modelId)}（ESM Atlas 公共 API · 免登录）· ${ef.sequenceLength} aa · 平均 pLDDT ${ef.globalPlddt ?? '—'}${ef.fracVeryHigh != null ? ` · pLDDT ≥90 区段 ${Math.round(ef.fracVeryHigh * 100)}%` : ''} · ${Math.round(ef.pdbText.length / 1024)}KB 内嵌模型<br>该靶点在 AlphaFold DB 无收录 — 由 ESM-2 语言模型单序列预测（无 MSA，可信度低于 AF2）；引用须注明计算预测而非实验结构 · <a href="https://esmatlas.com/resources?action=fold" target="_blank" rel="noopener">esmatlas.com →</a></figcaption>
      </figure>` : ''

  // ─── 报告主体组装（header → glance → 目录 → 章节 → footer；不含外壳）──────
  // v2.13：从 renderReportHtml 抽出 — 单靶点报告与合并报告各靶点单独评估页共用，
  // embed.idPrefix 前缀化全部锚点/元素 id（多视图单文档防冲突），章节结构与样式不变。
  const body = `
  <header class="rpt-head">
    <div class="rpt-headflex">
    <div class="rpt-headtxt">
    <div class="rpt-eyebrow">TargetEval · Structure Feasibility Report</div>
    <h1 class="rpt-title">${esc(proteinTitle)}</h1>
    <div class="rpt-subtitle">蛋白靶点结构解析可行性评估报告</div>
    <div class="meta-grid">
      <div><b>UniProt</b> ${u ? `<a href="https://www.uniprot.org/uniprotkb/${u.uniprotId}" target="_blank" rel="noopener">${u.uniprotId}</a>（${esc(u.entryName)}）${identityTitleSuffix ? `<span class="id-src">${esc(identityTitleSuffix.trim())} — 序列靶点经同源匹配归属</span>` : ''}` : ctx.targetIdentity?.uniprotId ? `—（序列输入；nr 最近条目 <a href="https://www.uniprot.org/uniprotkb/${esc(ctx.targetIdentity.uniprotId)}" target="_blank" rel="noopener">${esc(ctx.targetIdentity.uniprotId)}</a>${ctx.targetIdentity.uniprotEntry ? ` ${esc(ctx.targetIdentity.uniprotEntry)}` : ''}）` : '—（序列直接输入）'}</div>
      <div><b>蛋白名称</b> ${esc(u?.proteinName ?? ctx.targetIdentity?.name ?? '—')}</div>
      ${procMatch ? processingRowHtml(procMatch) : ''}
      <div><b>基因</b> ${esc(geneStr)}</div>
      <div><b>物种</b> ${esc(u?.organism ?? ctx.targetIdentity?.organism ?? '—')}</div>
      <div><b>序列长度</b> ${u ? u.sequenceLength + ' aa' : ctx.sequence ? ctx.sequence.length + ' aa' : '—'}</div>
      ${!u && ctx.targetIdentity ? `<div><b>靶点身份</b> <span class="id-src">${esc(ctx.targetIdentity.sourceLabel)}${ctx.targetIdentity.identity != null ? ` · 一致性 ${Math.round(ctx.targetIdentity.identity)}%` : ''}${ctx.targetIdentity.note ? ` · ${esc(ctx.targetIdentity.note.slice(0, 80))}` : ''}</span></div>` : ''}
      <div><b>结构证据</b> 直接结构 ${pdbCountHtml} · 同源 ${ctx.blastHits.length} 个 · 文献 ${ctx.literature.length} 篇${linkedLitCount ? `（${linkedLitCount} 篇与结构关联）` : ''}</div>
      ${cmp ? `<div><b>客户构建</b> ${constructHtml}</div>` : ''}
      ${ctx.batchNote ? `<div><b>批次关系</b> <span style="color:#92400e">${esc(ctx.batchNote.slice(0, 90))}${ctx.batchNote.length > 90 ? '…' : ''}</span></div>` : ''}
      <div><b>分析引擎</b> ${esc(input.engineSummary || '—')}</div>
      <div><b>报告日期</b> ${dateStr}</div>
    </div>
    <div class="rpt-badges">
      <span class="badge">数据源：UniProt · RCSB · PDBe${blastRan ? (ctx.blastStatus?.provider === 'rcsb' ? ' · RCSB 序列检索' : ' · BLAST') : ''}${ctx.literature.length ? ' · PubMed' : ''}</span>
      ${input.llmOk
        ? (input.llmErrors.length ? '<span class="badge amber">LLM 分析：部分完成（有章节缺失）</span>' : '<span class="badge">LLM 分析：已完成</span>')
        : '<span class="badge amber">LLM 分析：失败（见数据区块）</span>'}
    </div>
    </div>
    ${afBlockHtml}${efBlockHtml}
    </div>
  </header>

  ${glanceHtml}

  <nav class="toc">
    <b>Contents · 目录</b>
    <ol>
      <li><a href="#${idOf('llm')}">评估分析（摘要 / 目标可行性 / 研究全景 / 实验策略）</a></li>
      ${hasInsights ? `<li><a href="#${idOf('insights')}">客户评估表要点</a></li>` : ''}
      <li><a href="#${idOf('scores')}">可行性评分（含聚集形式与分子量调整）</a></li>
      <li><a href="#${idOf('pdbs')}">PDB 结构清单</a></li>
      ${ligandSecHtml ? `<li><a href="#${idOf('ligands')}">配体研究数据</a></li>` : ''}
      ${showBlastSec ? `<li><a href="#${idOf('blast')}">BLAST 同源结构</a></li>` : ''}
      ${ctx.literature.length ? `<li><a href="#${idOf('literature')}">关键文献</a></li>` : ''}
      ${embedded.length ? `<li><a href="#${idOf('assets')}">客户实验数据（评估表）</a></li>` : ''}
    </ol>
  </nav>

  ${input.llmErrors.length ? (() => {
    const shown = input.llmErrors.slice(0, 3).map(esc).join('；')
    const more = input.llmErrors.length > 3 ? `；等共 ${input.llmErrors.length} 章` : ''
    return input.llmOk
      ? `<div class="warn-box">部分 LLM 章节未能生成（${shown}${more}）— 报告相应章节缺失，其余章节正常；可重新评估补全。</div>`
      : `<div class="warn-box">LLM 分析生成失败（${shown}${more || '；未知原因'}）。以下为系统收集的确定性数据与评估表 AI 解析要点，可稍后重试生成。</div>`
  })() : ''}

  <section class="sec sec-llm" id="${idOf('llm')}">
    <h2>${secHead(llmNo, '评估分析', 'Analysis')}</h2>
    ${emb?.legacyNote ? `<p class="note">${esc(emb.legacyNote)}</p>` : ''}
    ${renderMarkdown(llmMarkdown || '（LLM 分析不可用 — 未能生成，请参考下方数据区块与评估表要点）', 1)}
  </section>

  ${ctx.insights ? (() => {
    const i = ctx.insights!
    if (!hasInsights) return ''
    return `
  <section class="sec" id="${idOf('insights')}">
    <h2>${secHead(insightsNo, '客户评估表要点', 'Form Insights')}</h2>
    <p class="note">由 AI 从上传的评估表中结构化提取的关键要点 — 供比对 LLM 分析的复述是否忠于原始输入。</p>
    ${i.goals?.length ? `<h3>客户目标</h3><ul>${i.goals.map(g => `<li>${esc(g)}</li>`).join('')}</ul>` : ''}
    ${i.scientificQuestions?.length ? `<h3>待解决科学问题</h3><ol>${i.scientificQuestions.map(q => `<li>${esc(q)}</li>`).join('')}</ol>` : ''}
    ${i.experimentalSummary ? `<h3>实验数据要点</h3><blockquote>${esc(i.experimentalSummary)}</blockquote>` : ''}
    ${i.sequenceNotes ? `<h3>构建 / 序列说明</h3><blockquote>${esc(i.sequenceNotes)}</blockquote>` : ''}
    ${i.homologs ? `<h3>同源 / 参考信息</h3><blockquote>${esc(i.homologs)}</blockquote>` : ''}
    ${i.keyConcerns?.length ? `<h3>风险关注点</h3><ul>${i.keyConcerns.map(c => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
  </section>`
  })() : ''}

  <section class="sec" id="${idOf('scores')}">
    <h2>${secHead(scoresNo, '可行性评分', 'Scores')}</h2>
    ${scoreHtml}
    <p class="note">评分流程分两层：系统规则先计算基础分（1-10：序列长度/跨膜特征/已有结构先例/结构域柔性，经舍入后叠加 BLAST 同源加成、蛋白聚集形式（寡聚态）与分子量增重调整${llmA ? '），随后由 AI 专家基于同一证据链复核' : ' — 调整值见评分卡内明细；两步调整均为整数，直接体现在最终分'}${llmA ? (llmA.applied ? '，并对分值做了 ±2 以内的微调（调整已计入上述分值，逐方法理由见上方「AI 复核」明细）' : '，复核结论为维持系统评分（意见见上方明细）') : ''}。评分数值仅供参考，最终可行性需结合实验条件判断；聚集形式判定的证据链与策略影响在评估分析章节中展开。</p>
  </section>

  <section class="sec" id="${idOf('pdbs')}">
    <h2>${secHead(pdbsNo, 'PDB 结构清单', ctx.directPdbs.length ? `Structures · ${ctx.directPdbs.length}${(ctx.rangeOutsidePdbs?.length ?? 0) > 0 ? ` · 范围外 ${(ctx.rangeOutsidePdbs?.length ?? 0)}` : ''}` : (ctx.interaction?.hasEvidence ? 'Structures · 互作组分证据' : 'Structures · 0'))}</h2>
    ${rangeBannerHtml(ctx.range, ctx.rangeSource, ctx.rangeOutsidePdbs?.length ?? 0, ctx.rangeOutsideBlastHits?.length ?? 0)}
    ${covFigHtml}
    ${ctx.directPdbs.length ? `<p class="note">按分辨率升序排列；点击 PDB ID 跳转 RCSB 查看详情；「文献」列带绿点表示与本页文献章节互链。表头下方可按方法筛选、切换排序。${expandAll ? '本页为单独评估页 — 全量结构默认展开。' : ''}${ctx.range ? ' 本表仅含链范围与评估区间重叠（或范围未知）的结构。' : ''}</p>${pdbTableHtml(ctx.directPdbs, PDB_PREVIEW, 150, litByPmid, expandAll)}` +
      (input.totalPdbFound > 150 ? `<p class="note">共检索命中 ${input.totalPdbFound} 个结构，表中展示前 150 个（按分辨率排序）。</p>`
      : (input.totalPdbFound > ctx.directPdbs.length ? `<p class="note">共检索命中 ${input.totalPdbFound} 个结构，表中展示详情完整的前 ${ctx.directPdbs.length} 个。</p>` : '')) +
      pdbOutsideFoldHtml(ctx.rangeOutsidePdbs ?? [], litByPmid, ctx.range)
    : `<div class="callout callout-amber"><b>暂无直接关联的 PDB 结构 — 全新结构靶点</b>该靶点（或该 UniProt）在 RCSB 无直接关联结构条目${ctx.interaction?.hasEvidence ? '，但存在互作复合物证据 — 下方列出其复合物其他组分的结构清单（共有结构突出显示、单独结构默认折叠），作为组装路线与构建边界设计的评估依据' : '，结构可行性判断主要依据同源结构先例（见 BLAST 章节）与文献证据'}；构建边界与实验策略需从零设计，风险与周期相应增加。</div>${interactionEvidenceHtml(ctx.interaction, expandAll)}${pdbOutsideFoldHtml(ctx.rangeOutsidePdbs ?? [], litByPmid, ctx.range)}`}
  </section>

  ${ligandSecHtml}

  ${showBlastSec ? `
  <section class="sec" id="${idOf('blast')}">
    <h2>${secHead(blastNo, 'BLAST 同源结构', `Homologs · ${ctx.blastHits.length}${blastNrCount ? ` · nr ${blastNrCount}` : ''}${uniBlastCount ? ` · UniProt 匹配 ${uniBlastCount}` : ''}`)}</h2>
    ${(ctx.blastHits.length > 0 && blastNrCount > 0) ? blastLibToggleHtml(ctx.blastHits.length, blastNrCount) : ''}
    ${ctx.blastHits.length ? `<div${blastNrCount > 0 ? ' data-libpanel="pdb"' : ''}><p class="note">按检索显著性排序（已排除直接结构重复项；可经表头下方「排序」切换为 Identity 降序等）；同源结构可用作分子置换模板 / Cryo-EM 初始模型 / 域边界参考。表头下方可按方法筛选、切换排序。</p>${ctx.blastStatus?.provider === 'rcsb' ? '<p class="note">NCBI BLAST 队列拥堵/故障，本章节同源结构经 RCSB 序列检索（mmseqs2）获得，命中含一致性/E 值/覆盖度，与 BLAST 同源结构等效。</p>' : ''}<div class="tbl-wrap"><table class="tbl-data tbl-blast" data-tbl="blast">
      <colgroup>
        <col style="width:74px"><col><col style="width:78px"><col style="width:88px">
        <col style="width:74px"><col style="width:104px"><col style="width:74px"><col style="width:92px">
      </colgroup>
      <thead><tr><th>PDB ID</th><th>描述</th><th class="num">Identity</th><th class="num">E-value</th><th class="num">覆盖范围</th><th>方法</th><th class="num">分辨率 (Å)</th><th>文献</th></tr></thead>
      <tbody>${blastRowsHtml(ctx.blastHits)}</tbody>
    </table></div>${blastOutsideFoldHtml(ctx.rangeOutsideBlastHits ?? [], ctx.range)}</div>`
    : ctx.blastStatus?.status === 'failed'
      ? `<div class="callout callout-amber"><b>同源检索失败 — 本报告不含同源结构证据</b>${esc(describeBlastStatus(ctx.blastStatus))}。本报告结论主要基于直接结构与文献证据；同源先例缺失可能低估或高估可行性，建议重新评估补齐同源证据。</div>`
      : `<p class="note">${esc(describeBlastStatus(ctx.blastStatus))}。同源结构证据在本报告中缺位，结论主要基于直接结构与文献证据；如需同源检索可重新评估并勾选「强制 BLAST」。</p>`}
    ${blastNrCount > 0 ? `<div${ctx.blastHits.length > 0 ? ' data-libpanel="nr" hidden' : ''}>${blastNrPanelHtml(ctx.blastNrHits ?? [], ctx.blastHits.length === 0)}</div>` : ''}
    ${uniBlastCount > 0 ? `<div>${uniprotBlastPanelHtml(ctx.uniprotBlastHits ?? [])}</div>` : ''}
  </section>` : ''}

  ${ctx.literature.length ? `
  <section class="sec" id="${idOf('literature')}">
    <h2>${secHead(litNo, '关键文献', `References · ${ctx.literature.length}${linkedLitCount ? ` · ${linkedLitCount} linked` : ''}`)}</h2>
    <p class="note">结构解析文献（与 PDB 条目直接关联）置前，其余按相关性排列；点击标题跳转 PubMed。${expandAll ? '本页为单独评估页 — 全部文献默认展开。' : ''}</p>
    ${litItemsHtml(ctx.literature, pdbByPmid, LIT_PREVIEW, expandAll)}
  </section>` : ''}

  ${imagesHtml}

  <footer class="rpt-foot">
    <div>SOURCES — UniProt REST · RCSB PDB · PDBe (EBI)${blastRan ? (ctx.blastStatus?.provider === 'rcsb' ? ' · RCSB 序列检索 (mmseqs2)' : ' · NCBI BLAST (pdbaa)') : ''} · PubMed eutils${ctx.images.length ? ' · 客户评估表' : ''}</div>
    <div>本报告由 TargetEval 系统自动生成：数据区块为数据库实时检索结果；「评估分析」章节由大语言模型基于上述数据生成，可能存在解读偏差，关键决策请以原始数据库与文献为准。</div>
    <div>JOB ${esc(input.jobId)} · GENERATED ${(input.durationMs / 1000).toFixed(1)}s · ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC</div>
  </footer>`
  return body
}

/** 单靶点报告 CSS — 单靶点报告与合并报告（首页 + 各靶点单独评估页）同源同版（v2.13）；
 *  原 #llm 选择器类化为 .sec-llm（合并报告多视图页内同章节出现多次，id 前缀化后
 *  样式仍以类命中 — 单靶点报告视觉完全不变）。 */
export const SINGLE_REPORT_CSS = `  :root {
    --ink:#1c1917; --sub:#57534e; --faint:#a8a29e; --line:#e7e5e4; --hairline:#efedeb;
    --accent:#065f46; --accent-2:#047857; --accent-bg:#f0fdf7; --bg:#fcfcfb; --paper:#ffffff;
    --serif:"Source Serif 4","Noto Serif SC",Georgia,"Songti SC","STSong","SimSun","Times New Roman",serif;
    --mono:"JetBrains Mono",ui-monospace,"SF Mono",Menlo,Consolas,"Courier New",monospace;
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  html { -webkit-print-color-adjust:exact; print-color-adjust:exact; scroll-behavior:smooth; }
  [id] { scroll-margin-top:18px; }
  body { font-family:var(--serif); color:var(--ink); background:var(--bg); line-height:1.92; font-size:15px; letter-spacing:.006em; }
  .mono { font-family:var(--mono); }
  ::-webkit-scrollbar{width:10px;height:10px}
  ::-webkit-scrollbar-thumb{background:#d6d3d1;border-radius:99px;border:3px solid var(--paper)}
  ::-webkit-scrollbar-thumb:hover{background:#a8a29e}
  ::-webkit-scrollbar-track{background:transparent}
  html{scrollbar-width:thin;scrollbar-color:#d6d3d1 transparent}
  .page { max-width:920px; margin:0 auto; padding:56px 44px 72px; background:var(--paper); min-height:100vh; box-shadow:0 0 0 1px var(--hairline); }
  @media print {
    body{background:#fff} .page{padding:0;max-width:none;box-shadow:none}
    .no-print{display:none!important} .sec{break-inside:avoid-page} .fig{break-inside:avoid}
    .glance{break-inside:avoid}
    table{break-inside:auto} tr{break-inside:avoid} details{display:block}
  }

  /* ── 报告封面头（期刊风双线）── */
  .rpt-head { padding-bottom:22px; margin-bottom:30px; border-bottom:1px solid var(--ink); position:relative; }
  .rpt-head::after { content:''; display:block; position:absolute; left:0; bottom:3px; width:100%; border-bottom:3px solid var(--ink); }
  .rpt-eyebrow { font-family:var(--mono); color:var(--accent); font-weight:600; font-size:10.5px; letter-spacing:2.4px; text-transform:uppercase; margin-bottom:14px; }
  h1.rpt-title { font-size:28px; line-height:1.4; margin-bottom:6px; font-weight:900; }
  .rpt-subtitle { font-size:13px; color:var(--sub); font-style:italic; margin-bottom:18px; }
  .meta-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:9px 22px; font-size:12.5px; color:var(--sub); }
  /* v2.16：靶点身份行（序列靶点的识别证据 — 来源/一致性） */
  .id-src { color:#92400e; }
  .meta-grid b { color:var(--ink); font-weight:600; margin-right:2px; }
  .meta-grid a { color:var(--accent-2); text-decoration:none; border-bottom:1px solid #a7f3d0; }
  .meta-grid a:hover { border-bottom-color:var(--accent-2); }
  .rpt-badges { margin-top:16px; display:flex; flex-wrap:wrap; gap:8px; }
  .badge { display:inline-block; padding:2px 11px; border-radius:3px; font-family:var(--mono); font-size:11px; font-weight:600; background:var(--accent-bg); color:var(--accent); border:1px solid #b8e6d2; }
  .badge.amber { background:#fffbeb; color:#92400e; border-color:#fde68a; }

  /* ── 目录 ── */
  .toc { border:1px solid var(--line); border-radius:6px; padding:16px 22px; margin-bottom:34px; font-size:13px; background:#fdfdfc; }
  .toc b { display:block; margin-bottom:8px; font-family:var(--mono); font-size:10px; letter-spacing:1.6px; color:var(--faint); text-transform:uppercase; }
  .toc ol { margin-left:20px; columns:2; column-gap:36px; }
  .toc li { margin:3px 0; break-inside:avoid; }
  .toc a { color:var(--ink); text-decoration:none; }
  .toc a:hover { color:var(--accent-2); }
  @media (max-width:640px){ .toc ol{columns:1} }

  /* ── v1.28 核心结论速览（At a Glance）── */
  .glance { border:1.5px solid var(--ink); border-radius:8px; margin:0 0 34px; background:#fff; overflow:hidden; }
  .glance-kicker { font-family:var(--mono); font-size:10px; letter-spacing:2.2px; text-transform:uppercase; color:var(--accent); padding:13px 20px 11px; font-weight:700; border-bottom:1px solid var(--line); background:linear-gradient(180deg,#ffffff,#f7fcf9); }
  .glance-grid { display:grid; grid-template-columns:200px 1fr; }
  .glance-hero { padding:18px 20px; border-right:1px solid var(--line); display:flex; flex-direction:column; justify-content:center; align-items:flex-start; background:#fbfdfc; }
  .glance-score { font-family:var(--mono); font-size:46px; font-weight:700; line-height:1; }
  .glance-score span { font-size:15px; color:var(--faint); font-weight:400; }
  .glance-hero-label { font-size:12px; color:var(--sub); margin-top:8px; }
  .glance-rating { display:inline-block; margin-top:9px; padding:2px 12px; border-radius:3px; font-size:12px; font-weight:700; color:#fff; letter-spacing:1px; }
  .glance-tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(158px,1fr)); }
  .glance-tile { padding:13px 16px 11px; border-right:1px solid var(--hairline); border-bottom:1px solid var(--hairline); min-width:0; }
  .glance-tile:nth-child(3n) { border-right:none; }
  .glance-tile.gt-warn { background:#fffbeb; }
  .glance-tile.gt-warn .gt-value { color:#b45309; }
  .gt-label { font-family:var(--mono); font-size:9.5px; letter-spacing:1.4px; text-transform:uppercase; color:var(--faint); font-weight:600; }
  .gt-value { font-size:14px; font-weight:700; margin-top:4px; line-height:1.5; overflow-wrap:anywhere; }
  .gt-sub { font-size:11px; color:var(--sub); margin-top:3px; line-height:1.55; }
  .glance-foot { padding:10px 20px; border-top:1px dashed var(--line); font-size:12px; color:var(--sub); background:#fbfdfc; line-height:1.8; }
  @media (max-width:680px){
    .glance-grid { grid-template-columns:1fr; }
    .glance-hero { border-right:none; border-bottom:1px solid var(--line); flex-direction:row; align-items:center; gap:16px; }
    .glance-score { font-size:36px; }
    .glance-tile { border-right:none; border-bottom:1px solid var(--hairline); }
  }

  /* ── v1.28 回顶部 ── */
  .backtop { position:fixed; right:26px; bottom:26px; width:42px; height:42px; border-radius:50%; background:var(--ink); color:#fff; display:flex; align-items:center; justify-content:center; font-size:17px; text-decoration:none; box-shadow:0 4px 14px rgba(0,0,0,.2); opacity:0; pointer-events:none; transition:opacity .25s, background .2s; z-index:50; }
  .backtop.show { opacity:1; pointer-events:auto; }
  .backtop:hover { background:var(--accent-2); }

  /* ── v1.28 空态/警示块 ── */
  .callout { border-radius:6px; padding:14px 18px; margin:12px 0; font-size:13px; line-height:1.95; border:1px solid; text-align:justify; }
  .callout b { display:block; margin-bottom:5px; font-size:13.5px; }
  .callout-amber { background:#fffbeb; border-color:#fde68a; color:#92400e; }

  /* ── 章节（v1.28：编号方块 + 标题 + 英文标签，结构分明）── */
  .sec { margin-bottom:40px; }
  .sec > h2 { font-size:19px; padding-bottom:10px; margin-bottom:16px; border-bottom:2px solid var(--ink); font-weight:700; display:flex; align-items:center; gap:12px; }
  .sec-no { flex:none; width:32px; height:32px; background:var(--ink); color:#fff; display:inline-flex; align-items:center; justify-content:center; font-size:15px; font-weight:700; border-radius:5px; }
  .sec-title { min-width:0; }
  .sec > h2 .sec-en { margin-left:auto; font-family:var(--mono); font-size:10px; font-weight:500; letter-spacing:1.8px; color:var(--faint); text-transform:uppercase; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .sec h3 { font-size:15.5px; margin:20px 0 8px; color:#064e3b; font-weight:700; }
  .sec h4 { font-size:14px; margin:16px 0 6px; font-weight:700; border-left:3px solid #a7f3d0; padding-left:10px; }
  .sec h5, .sec h6 { font-size:13.5px; margin:12px 0 5px; font-weight:700; }
  /* v1.30：LLM 章节层次强化 — 子章节编号徽章 + 分隔线 + 摘要导语 + 强调色 */
  .sec-llm { counter-reset: llmch; }
  .sec-llm h3 { counter-increment: llmch; display:flex; align-items:center; gap:11px; margin:34px 0 12px; padding-bottom:9px; border-bottom:1px solid var(--line); }
  .sec-llm h3::before { content:"1." counter(llmch); flex:none; font-family:var(--mono); font-size:11px; font-weight:700; color:#fff; background:var(--accent-2); border-radius:4px; padding:2px 9px; letter-spacing:.5px; line-height:1.5; }
  .sec-llm h3:first-child { margin-top:6px; }
  /* 执行摘要首段 = 全报告导语 — 大字号 + 主色竖线，突出总体结论 */
  .sec-llm h3:first-of-type + p { font-size:15.5px; line-height:2.05; color:var(--ink); border-left:3px solid var(--accent-2); padding:2px 0 2px 15px; margin:12px 0 14px; }
  .sec-llm p { margin:9px 0; }
  .sec-llm ul li::marker, .sec-llm ol li::marker { color:var(--accent-2); font-family:var(--mono); font-weight:600; }
  .sec-llm strong { color:#064e3b; }
  .sec-llm blockquote { border-left:3px solid #a7f3d0; background:#f7fdfb; }
  .sec-llm .tbl-wrap { margin:16px 0 12px; }
  p { margin:8px 0; text-align:justify; }
  ul { margin:8px 0 8px 22px; }
  li { margin:4px 0; }
  blockquote { border-left:3px solid #d6d3d1; padding:5px 14px; margin:12px 0; color:var(--sub); background:#fafaf9; border-radius:0 4px 4px 0; font-size:13.5px; }
  strong { font-weight:700; }
  em { font-style:italic; }
  code { font-family:var(--mono); background:#f5f5f4; padding:1px 5px; border-radius:3px; font-size:.88em; }

  /* ── 表格 ── */
  .tbl-wrap { overflow-x:auto; margin:12px 0 6px; }
  table { width:100%; border-collapse:collapse; font-size:12.5px; font-family:var(--serif); }
  /* 数据表（PDB/BLAST）：固定列宽防长串挤压重叠；窄屏由 .tbl-wrap 横向滚动 */
  table.tbl-data { table-layout:fixed; min-width:856px; }
  table.tbl-blast { min-width:740px; }
  th { background:#f7f7f5; text-align:left; font-size:10px; letter-spacing:1px; text-transform:uppercase; color:var(--sub); font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  th.num { text-align:right; }
  th, td { border-top:1px solid var(--line); border-bottom:1px solid var(--line); padding:6px 8px; vertical-align:top; }
  thead th { border-top:none; border-bottom:1.5px solid #d6d3d1; }
  tbody tr:last-child td { border-bottom:none; }
  tbody tr:nth-child(even) td { background:#fafaf8; }
  tbody tr:hover td { background:#f5f5f4; }
  td { overflow-wrap:anywhere; }
  td.num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; font-family:var(--mono); }
  td.td-id a, .t-nowrap { white-space:nowrap; }
  td.td-id { font-family:var(--mono); }
  .t-title, .t-desc { font-family:var(--serif); overflow-wrap:break-word; }
  /* v2.56：长标题 3 行截断（全文字在 td title 悬停可见；打印恢复全文、CSV 导出
    不受影响 — textContent 保留全文，-webkit-box 仅视觉折叠）— 长表行高归一，
    斑马纹恢复行定位价值 */
  .t-clamp { display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
  .t-lig { font-size:11px; overflow-wrap:anywhere; }
  .t-journal { font-size:11px; }
  .t-rng { font-family:var(--mono); font-size:11px; color:var(--sub); overflow-wrap:anywhere; }
  .lig-more { color:var(--faint); white-space:nowrap; }
  table a { color:var(--accent-2); text-decoration:none; border-bottom:1px solid #c7ece0; }
  table a:hover { border-bottom-color:var(--accent-2); }
  .lit-dot { display:inline-block; width:4px; height:4px; border-radius:99px; background:var(--accent-2); margin-left:4px; vertical-align:2px; }
  .mth { display:inline-block; padding:0 7px; border-radius:3px; font-size:10.5px; font-weight:600; white-space:nowrap; }
  .mth-xray { background:#ecfdf5; color:#065f46; }
  .mth-cryoem { background:#fef3c7; color:#92400e; }
  .mth-nmr { background:#f5f3ff; color:#5b21b6; }
  .mth-other { background:#f5f5f4; color:var(--sub); }

  /* ── 折叠区（details）── */
  details.fold { margin:2px 0 10px; border-top:1px dashed #d6d3d1; }
  details.fold summary { list-style:none; cursor:pointer; padding:9px 4px; font-family:var(--mono); font-size:11px; letter-spacing:.6px; color:var(--accent-2); user-select:none; }
  details.fold summary::-webkit-details-marker { display:none; }
  details.fold summary::before { content:'＋ '; font-family:var(--mono); }
  details.fold[open] summary::before { content:'－ '; }
  details.fold summary:hover { color:var(--accent); }

  /* ── v2.29 范围外结构折叠区（灰色行 + 范围外 chip）── */
  details.fold.fold-outside { border:1px dashed #d6d3d1; border-radius:6px; background:#f7f7f6; padding:0 6px 4px; }
  details.fold.fold-outside summary { color:#78716c; border-top:none; }
  details.fold.fold-outside summary:hover { color:#57534e; }
  tr.tr-outside td { color:var(--faint); background:#fafaf9; }
  tr.tr-outside:hover td { background:#f5f5f4; }
  tr.tr-outside td a { color:#a8a29e; }
  tr.tr-outside .t-title, tr.tr-outside .t-desc { color:#a8a29e; }
  .rng-outside-chip { display:inline-block; margin-left:6px; padding:0 7px; border-radius:99px; background:#f3f4f6; color:#78716c; font-size:10px; font-family:var(--mono); border:1px solid #e7e5e4; vertical-align:middle; }

  /* ── v2.59 BLAST nr 全库检索命中块（身份识别证据 — 前 5 条直出 + 折叠）── */
  .nr-block { margin-top:28px; }
  table.tbl-blastnr { min-width:640px; }
  .nr-entry { font-family:var(--serif); font-size:10.5px; color:var(--faint); margin-top:2px; overflow-wrap:anywhere; }
  .nr-chip { display:inline-block; padding:0 7px; border-radius:99px; font-size:10px; font-weight:600; font-family:var(--mono); white-space:nowrap; border:1px solid #e7e5e4; }
  .nr-chip-sp { background:#f0fdf7; color:#065f46; border-color:#bbf7d0; }
  .nr-chip-tr { background:#fffbeb; color:#92400e; border-color:#fde68a; }
  .nr-chip-other { background:#f5f5f4; color:#78716c; }
  .rng-banner { border:1px solid #bbf7d0; background:#f0fdf4; color:#065f46; border-radius:6px; padding:10px 14px; margin:10px 0 14px; font-size:12.5px; line-height:1.8; }
  .rng-banner b { font-family:var(--mono); }

  /* ── 评分卡 ── */
  .score-card { background:#fdfdfc; border:1px solid var(--line); border-radius:6px; padding:18px 22px; margin:14px 0 10px; }
  .score-row { display:grid; grid-template-columns:96px 1fr 64px 110px; gap:14px; align-items:center; margin:10px 0; }
  .score-label { font-weight:700; font-size:13px; }
  .score-track { height:8px; border-radius:99px; background:#eceae6; overflow:hidden; }
  .score-fill { height:100%; border-radius:99px; }
  .score-num { font-family:var(--mono); font-size:16px; font-weight:700; text-align:right; font-variant-numeric:tabular-nums; }
  .score-max { color:var(--faint); font-size:11px; font-weight:400; }
  .score-rating { font-size:12px; color:var(--sub); text-align:right; font-family:var(--mono); }
  @media (max-width:560px){
    .score-card{ padding:14px 16px; }
    .score-row{ grid-template-columns:1fr auto; gap:5px 12px; }
    .score-label{ grid-column:1; grid-row:1; }
    .score-num{ grid-column:2; grid-row:1; }
    .score-track{ grid-column:1 / -1; grid-row:2; }
    .score-rating{ grid-column:1 / -1; grid-row:3; text-align:left; }
  }
  .score-rationale { margin-top:14px; padding-top:12px; border-top:1px dashed var(--line); font-size:12.5px; color:var(--sub); line-height:1.9; display:grid; grid-template-columns:1fr 1fr; gap:8px 28px; }
  .sr-item { min-width:0; }
  .sr-label { display:block; color:var(--ink); font-weight:700; margin-bottom:2px; }
  .sr-seg { display:block; padding-left:11px; position:relative; overflow-wrap:anywhere; }
  .sr-seg::before { content:'·'; position:absolute; left:1px; color:var(--faint); }
  @media (max-width:860px){ .score-rationale{ grid-template-columns:1fr; gap:6px; } }

  /* ── v2.18 AI 复核（LLM 智能调分）— 紫色系视觉语言，与绿色方法分区分 ── */
  .score-delta { display:inline-block; margin-left:7px; padding:0 8px; border-radius:99px; font-size:10px; font-weight:700; font-family:var(--mono); vertical-align:2px; line-height:1.7; }
  .score-delta.sd-pos { background:#ede9fe; color:#5b21b6; border:1px solid #c4b5fd; }
  .score-delta.sd-neg { background:#fef2f2; color:#b91c1c; border:1px solid #fecaca; }
  .llm-adj-strip { margin-top:14px; border:1px solid #ddd6fe; background:linear-gradient(180deg,#faf5ff,#fdfdfc); border-radius:6px; padding:12px 16px 10px; }
  .llm-adj-head { display:flex; flex-wrap:wrap; gap:7px 10px; align-items:center; }
  .llm-adj-badge { font-family:var(--mono); font-size:10.5px; font-weight:700; letter-spacing:1.2px; color:#fff; background:#6d28d9; border-radius:3px; padding:2px 9px; }
  .llm-adj-title { font-weight:700; font-size:13px; color:#4c1d95; }
  .llm-conf { font-size:11.5px; color:var(--sub); }
  .llm-notes { margin:9px 0 7px; padding-left:2px; list-style:none; font-size:12.5px; color:var(--sub); line-height:1.95; }
  .llm-notes li { padding-left:15px; position:relative; }
  .llm-notes li::before { content:'◆'; position:absolute; left:0; top:2px; font-size:8px; color:#a78bfa; }
  .llm-notes li b { color:#5b21b6; font-weight:700; margin-right:3px; }
  .llm-engine { font-size:11px; color:var(--faint); font-family:var(--mono); }
  .glance-ai-tag { display:inline-block; margin-top:7px; padding:1px 10px; border-radius:99px; background:#ede9fe; color:#5b21b6; font-family:var(--mono); font-size:10.5px; font-weight:700; letter-spacing:.5px; border:1px solid #c4b5fd; }
  @media print { .score-delta, .glance-ai-tag { -webkit-print-color-adjust:exact; print-color-adjust:exact; } }
  /* v1.28：综合分行强调（突出关键信息）*/
  .score-row.row-overall { background:var(--accent-bg); border:1px solid #b8e6d2; border-radius:6px; padding:10px 12px; margin:16px -12px 4px; }
  .score-row.row-overall .score-label { color:var(--accent); font-size:14px; }
  .score-row.row-overall .score-num { font-size:19px; }
  .score-row.row-overall .score-track { height:10px; }

  /* ── 聚集形式（评分卡内嵌，v1.25）── */
  .oligo-card { background:#fdfdfc; border:1px solid var(--line); border-radius:6px; padding:16px 20px; margin:14px 0; }
  .oligo-head { display:flex; flex-wrap:wrap; align-items:center; gap:10px; margin-bottom:10px; }
  .oligo-badge { color:#fff; font-size:12px; font-weight:700; padding:3px 12px; border-radius:3px; letter-spacing:1px; }
  .oligo-stoich { font-family:var(--mono); font-size:12.5px; color:var(--ink); background:#f5f5f4; border:1px solid var(--line); padding:2px 10px; border-radius:3px; }
  .oligo-conf { font-size:12px; color:var(--sub); margin-left:auto; }
  .oligo-summary { margin:6px 0 0; font-size:13.5px; }
  .oligo-strip { margin-top:14px; padding-top:12px; border-top:1px dashed var(--line); }
  .oligo-strip-head { display:flex; flex-wrap:wrap; align-items:center; gap:8px 10px; }
  .oligo-strip-label { font-size:12.5px; color:var(--sub); }
  .oligo-strip-label b { color:var(--ink); font-weight:700; margin: 0 2px; }
  .oligo-chips { display:inline-flex; flex-wrap:wrap; gap:6px; }
  .adj-chip { font-family:var(--mono); font-size:11px; font-weight:700; padding:1px 9px; border-radius:99px; white-space:nowrap; }
  .adj-pos { background:#ecfdf5; color:#047857; border:1px solid #a7f3d0; }
  .adj-neg { background:#fef2f2; color:#b91c1c; border:1px solid #fecaca; }
  .adj-zero { background:#f5f5f4; color:var(--sub); border:1px solid var(--line); }
  .oligo-strip-note { font-size:12.5px; color:var(--sub); margin:8px 0 0; }
  .note { font-size:12px; color:var(--sub); margin-top:6px; }

  /* ── v1.26 分子量增重条（沿用聚集形式条布局，复用 .oligo-strip 类）── */
  .mw-target { background:#ecfdf5; color:#047857; border:1px solid #a7f3d0; border-radius:3px; padding:0 5px; font-weight:600; }
  .mw-partner { background:#fffbeb; color:#92400e; border:1px solid #fde68a; border-radius:3px; padding:0 5px; font-weight:600; }
  .mw-basis { font-family:var(--mono); font-size:10.5px; color:var(--faint); }
  /* ── v2.33 binary 互作可信度分级 chips ── */
  .ev-chip { display:inline-block; margin:0 6px; padding:0 7px; border-radius:99px; font-family:var(--mono); font-size:10px; font-weight:700; vertical-align:1px; }
  .ev-complex { background:#ecfdf5; color:#047857; border:1px solid #a7f3d0; }
  .ev-homolog { background:#f0fdfa; color:#0f766e; border:1px solid #99f6e4; }
  .ev-exp { background:#fef3c7; color:#b45309; border:1px solid #fde68a; }
  .ev-note { font-family:var(--mono); font-size:10.5px; color:var(--faint); }
  ul.mw-list { list-style:none; margin:2px 0 10px; }
  ul.mw-list li { position:relative; padding:5px 0 5px 16px; border-bottom:1px solid var(--hairline); font-size:12.5px; color:var(--sub); line-height:1.7; }
  ul.mw-list li:last-child { border-bottom:none; }
  ul.mw-list li::before { content:'·'; position:absolute; left:4px; color:var(--accent-2); font-weight:700; }
  .mw-conf-tag { display:inline-block; min-width:44px; text-align:center; font-family:var(--mono); font-size:10.5px; font-weight:700; border-radius:3px; padding:0 6px; margin-right:6px; vertical-align:1px; }
  .mw-aligned { background:#ecfdf5; color:#047857; border:1px solid #a7f3d0; }
  .mw-caution { background:#fffbeb; color:#b45309; border:1px solid #fde68a; }
  .mw-conflict { background:#fef2f2; color:#b91c1c; border:1px solid #fecaca; }

  /* ── v1.30/v1.31 互作复合物结构清单（共有结构突出 / 单独结构折叠，全量表列）── */
  .itx-h3 { margin:22px 0 6px !important; display:flex; align-items:baseline; gap:10px; }
  .itx-h3-sub { font-family:var(--mono); font-size:10.5px; font-weight:500; letter-spacing:1px; color:var(--faint); }
  .cx-card { background:#fdfdfc; border:1px solid var(--line); border-radius:6px; padding:16px 20px; margin:14px 0; }
  .cx-head { display:flex; flex-wrap:wrap; align-items:center; gap:8px 10px; margin-bottom:12px; }
  .cx-badge { flex:none; font-family:var(--mono); font-size:10.5px; font-weight:700; letter-spacing:1px; color:#fff; background:#0f766e; border-radius:3px; padding:2px 10px; }
  .cx-name { font-size:14.5px; min-width:0; overflow-wrap:anywhere; }
  .cx-name a { color:var(--accent-2); text-decoration:none; border-bottom:1px solid #c7ece0; }
  .cx-name a:hover { border-bottom-color:var(--accent-2); }
  .cx-chip { font-family:var(--mono); font-size:11px; color:var(--sub); background:#f5f5f4; border:1px solid var(--line); border-radius:3px; padding:1px 9px; white-space:nowrap; }
  .cx-chip.cx-ok { background:#ecfdf5; color:#047857; border-color:#a7f3d0; }
  .cx-chip.cx-chip-shared { background:#065f46; color:#fff; border-color:#065f46; font-weight:700; }
  table.tbl-cx { min-width:660px; }
  .tbl-cx tr.cx-target td { background:#ecfdf5; border-top:1px solid #d1e9dd; border-bottom:1px solid #d1e9dd; }
  .cx-desc { font-family:var(--serif); font-size:11px; color:var(--faint); }
  .cx-res { font-family:var(--mono); font-size:10.5px; color:var(--faint); margin-left:2px; }
  /* 共有结构：绿色面板突出（组装先例）— v1.31 全量表列 */
  .cx-shared { border:1px solid #b8e6d2; background:linear-gradient(180deg,#f5fcf8,#ffffff); border-radius:6px; padding:12px 18px 10px; margin:14px 0 8px; }
  .cx-shared-head { display:flex; flex-wrap:wrap; align-items:baseline; gap:6px 10px; font-size:13.5px; font-weight:700; color:#065f46; margin-bottom:4px; }
  .cx-shared-ico { color:var(--accent-2); font-size:14px; }
  .cx-shared-head b { font-family:var(--mono); font-size:15px; color:#047857; }
  .cx-shared-sub { flex-basis:100%; font-size:11px; font-weight:400; color:var(--sub); line-height:1.7; }
  .cx-shared .tbl-wrap, .cx-solo-comp .tbl-wrap { margin:6px 0 4px; }
  /* v1.31 紧凑版式：9 列在报告页宽（.cx-card/.cx-shared 嵌套后 ~752px）内免横向滚动 */
  table.tbl-cx-pdb { min-width:748px; font-size:11.5px; }
  .tbl-cx-pdb th, .tbl-cx-pdb td { padding:5px 6px; }
  .tbl-cx-pdb .t-title { font-size:11px; }
  .tbl-cx-pdb .t-journal { font-size:10.5px; }
  .tbl-cx-pdb td.num { font-size:10px; }
  .tbl-cx-pdb .mth { padding:0 4px; font-size:9.5px; }
  .csi-comps { font-size:11px; color:#065f46; background:#ecfdf5; border:1px solid #a7f3d0; border-radius:3px; padding:0 6px; white-space:nowrap; display:inline-block; max-width:100%; }
  .csi-comps i { font-style:normal; font-family:var(--mono); font-size:10px; color:#047857; margin-left:4px; }
  .csi-extra { display:inline-block; font-size:10.5px; color:#92400e; background:#fffbeb; border:1px dashed #fde68a; border-radius:3px; padding:0 6px; margin:1px 3px 1px 0; white-space:nowrap; }
  .csi-extra-more { font-family:var(--mono); font-size:10px; color:#b45309; white-space:nowrap; }
  .t-extras { overflow-wrap:anywhere; }
  .t-pmid { font-family:var(--mono); font-size:10.5px; white-space:nowrap; }
  .t-pmid-none { color:var(--faint); }
  /* 单独结构：按组分分组（默认折叠，展开全量表） */
  .cx-solo-fold { margin-top:10px; }
  .cx-solo-comp { margin:10px 0 14px; padding:10px 14px 8px; border:1px solid var(--hairline); border-radius:6px; background:#fdfdfc; }
  .cx-solo-head { font-size:12.5px; color:var(--ink); margin-bottom:2px; }
  .cx-solo-head .mono { font-size:10.5px; color:var(--faint); }
  .cx-solo-sub { font-size:11px; color:var(--faint); }

  /* ── 文献 ── */
  ol.lit-list { list-style:none; }
  .lit-item { display:flex; gap:14px; padding:12px 2px; border-bottom:1px solid var(--hairline); }
  .lit-item:last-child { border-bottom:none; }
  .lit-no { font-family:var(--mono); font-size:11px; color:var(--faint); min-width:22px; text-align:right; padding-top:3px; }
  .lit-title a { color:var(--ink); font-weight:600; text-decoration:none; font-size:13.5px; }
  .lit-title a:hover { color:var(--accent-2); }
  .lit-src { display:inline-block; margin-left:8px; padding:0 7px; border-radius:3px; font-family:var(--mono); font-size:9.5px; font-weight:600; letter-spacing:1px; background:var(--accent-bg); color:var(--accent); border:1px solid #c7ece0; vertical-align:2px; }
  .lit-meta { font-family:var(--mono); font-size:11.5px; color:var(--sub); margin:3px 0 2px; }
  .lit-meta a { color:var(--accent-2); text-decoration:none; }
  .lit-abs { font-size:12.5px; color:var(--sub); margin-top:4px; text-align:justify; }
  .lit-pdbs { display:flex; flex-wrap:wrap; align-items:center; gap:5px; margin-top:6px; }
  .lit-pdbs-label { font-family:var(--mono); font-size:9.5px; letter-spacing:1.2px; text-transform:uppercase; color:var(--faint); margin-right:2px; }
  .lit-pdbs a { font-family:var(--mono); font-size:10.5px; font-weight:600; color:var(--accent); background:var(--accent-bg); border:1px solid #c7ece0; border-radius:3px; padding:0 6px; text-decoration:none; }
  .lit-pdbs a:hover { background:#d9f5e8; }

  /* ── 图 ── */
  .fig-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr)); gap:20px; margin-top:6px; }
  .fig { text-align:center; }
  .fig img { max-width:100%; max-height:420px; border:1px solid var(--line); border-radius:4px; background:#fff; padding:8px; }
  .fig-missing { padding:40px; background:#fafaf9; border:1px dashed var(--line); border-radius:4px; color:var(--sub); }
  .fig figcaption { font-size:12.5px; color:var(--sub); margin-top:8px; text-align:left; }
  .fig-tag { display:inline-block; padding:0 7px; border-radius:3px; font-family:var(--mono); font-size:10px; font-weight:600; margin-right:6px; }
  .fig-gel { background:#ecfdf5; color:#065f46; }
  .fig-sec { background:#fef3c7; color:#92400e; }
  .fig-other { background:#f5f5f4; color:var(--sub); }
  .fig-ai { background:#f0fdfa; color:#0f766e; border:1px solid #99f6e4; }
  .fig-group { margin:18px 0 4px !important; font-size:14.5px !important; color:#064e3b; display:flex; align-items:baseline; gap:8px; }
  .fig-group-count { font-family:var(--mono); font-size:10.5px; font-weight:500; color:var(--faint); letter-spacing:1px; }

  /* ── v2.7.6 覆盖率区段图（SVG 轨道 — 服务器渲染，零 JS，打印友好）── */
  .cov-fig { margin: 14px 0 10px; }
  .cov-fig svg { display: block; width: 100%; height: auto; border: 1px solid var(--line); border-radius: 6px; background: #fdfdfc; padding: 6px 8px; }
  .cov-fig figcaption { font-size: 11px; color: var(--sub); margin-top: 6px; line-height: 1.8; }
  .cov-fig figcaption b { color: var(--accent); }

  /* ── 报告头图与元信息并排（v2.0 AlphaFold；v2.2 截图去白边；v2.7 图上提与标题齐平）──
   *  头部双栏：左栏 = 眉标/标题/副标/蛋白信息/徽标，右栏 = AlphaFold 头图顶端对齐 —
   *  图不再挂在蛋白信息下方（原来信息栏下方留出大片空白）。移动端 (<720px) 上下堆叠。 */
  .rpt-headflex { display:flex; gap:26px; align-items:flex-start; }
  .rpt-headtxt { flex:1 1 auto; min-width:0; }
  .af-fig { flex:0 0 320px; margin:0; text-align:center; align-self:flex-start; }
  .af-fig > img { display:block; width:320px; max-width:100%; height:auto; border:1px solid var(--line); border-radius:6px; background:#fff; padding:4px; box-shadow:0 1px 3px rgba(28,25,23,.06); }
  /* v2.7.2 交互式 3D 视图（沿用 .af-fig 头部槽位 — 几何不变；fallback 层级：canvas 生效→poster 隐藏；异常→canvas 隐藏；打印→poster 常显） */
  .af-stage { position:relative; width:100%; height:252px; border:1px solid var(--line); border-radius:6px; background:#fff; overflow:hidden; box-shadow:0 1px 3px rgba(28,25,23,.06); }
  .af-canvas { position:absolute; inset:0; cursor:grab; }
  .af-canvas:active { cursor:grabbing; }
  .af-poster { display:block; width:100%; height:252px; object-fit:contain; background:#fff; }
  .af-poster:not([src]) { display:none; }
  .af-stage.af-live .af-poster { display:none; }
  .af-stage.af-fail .af-canvas { display:none; }
  .af-legend { display:flex; gap:10px; margin-top:6px; font-size:9.5px; font-family:var(--mono); color:var(--sub); justify-content:center; flex-wrap:wrap; }
  .af-legend span { display:inline-flex; align-items:center; gap:4px; white-space:nowrap; }
  .af-legend i { display:inline-block; width:10px; height:10px; border-radius:2px; border:1px solid rgba(28,25,23,.15); }
  /* v2.46 预测结构视图工具条（下载 PDB + 着色切换 — 池化/独立视图共用）；v2.47 小窗拥挤 → 仅放大视图显示（迁入 .af-fullslot 后由 LIGHTBOX_CSS 恢复 flex） */
  .af-tb { position:absolute; top:8px; left:8px; z-index:6; display:flex; gap:6px; align-items:center; }
  .af-tb-btn { display:inline-flex; align-items:center; gap:4px; padding:3px 9px; border-radius:5px; border:1px solid rgba(28,25,23,.2); background:rgba(255,255,255,.94); color:#57534e; font-family:var(--mono,ui-monospace,Menlo,monospace); font-size:9px; font-weight:600; letter-spacing:.5px; line-height:1.5; cursor:pointer; box-shadow:0 1px 3px rgba(28,25,23,.14); }
  .af-tb-btn:hover { background:#fff; color:#1c1917; }
  .af-tb-btn svg { flex:none; }
  .af-tb-sel { padding:3px 5px; border-radius:5px; border:1px solid rgba(28,25,23,.2); background:rgba(255,255,255,.94); color:#57534e; font-family:var(--mono,ui-monospace,Menlo,monospace); font-size:9px; font-weight:600; letter-spacing:.5px; line-height:1.5; cursor:pointer; box-shadow:0 1px 3px rgba(28,25,23,.14); max-width:132px; }
  .af-tb-btn:focus-visible, .af-tb-sel:focus-visible { outline:2px solid #10b981; outline-offset:1px; }
  .af-stage .af-tb { display:none; } /* v2.47：小窗一律隐藏（仅全屏槽内可见） */
  /* 域着色图例（条目多时滚动）与彩虹图例渐变条 */
  .af-legend.af-lgd-scroll { max-height:76px; overflow-y:auto; justify-content:flex-start; }
  .af-lgd-item { max-width:170px; overflow:hidden; text-overflow:ellipsis; }
  .af-lgd-rb-bar { display:inline-block; width:56px; height:10px; border-radius:2px; border:1px solid rgba(28,25,23,.15); background:linear-gradient(90deg,#4363D8,#46F0F0,#3CB44B,#FFE119,#F58231,#E6194B); }
  /* v2.53：PDB/BLAST 列表筛选排序工具条样式抽离单源（TABLE_FILTER_CSS — 与旧报告服务端注入共用） */
  ${TABLE_FILTER_CSS}
  @media print { .af-stage .af-canvas, .af-stage .af-tb { display:none; } .af-stage .af-poster, .af-stage.af-live .af-poster { display:block; } }
  .af-fig figcaption { margin-top:8px; font-size:10.5px; line-height:1.75; color:var(--sub); font-family:var(--mono); }
  .af-fig figcaption b { color:var(--ink); font-weight:600; }
  .af-fig figcaption a { color:var(--accent-2); text-decoration:none; border-bottom:1px solid #c7ece0; }
  @media (max-width:720px){ .rpt-headflex{flex-direction:column} .af-fig{flex-basis:auto; width:100%; max-width:400px; margin:0 auto} .af-stage,.af-poster{height:260px} }

  /* ── 配体卡（v2.0；v2.7 + 2D 结构式与计算性质双栏卡）── */
  .lig-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(400px,100%),1fr)); gap:14px; margin-top:8px; }
  /* v2.56：奇数末卡占满整行 — 2+1 布局不再右列留洞 */
  .lig-grid > .lig-card:last-child:nth-child(odd) { grid-column:1 / -1; }
  .lig-card { background:#fdfdfc; border:1px solid var(--line); border-radius:6px; padding:14px 18px; break-inside:avoid; }
  .lig-fail { border-style:dashed; opacity:.78; }
  .lig-main { display:flex; gap:14px; align-items:flex-start; }
  .lig-struct { flex:0 0 150px; margin:0; text-align:center; }
  .lig-struct img { display:block; width:150px; height:150px; object-fit:contain; background:#fff; border:1px solid var(--line); border-radius:4px; padding:3px; box-shadow:0 1px 2px rgba(28,25,23,.05); }
  .lig-struct figcaption { margin-top:5px; font-size:9.5px; line-height:1.5; color:var(--faint); font-family:var(--mono); }
  .lig-info { flex:1 1 auto; min-width:0; }
  .lig-head { display:flex; flex-wrap:wrap; align-items:baseline; gap:8px 10px; }
  .lig-id { font-family:var(--mono); font-size:14.5px; font-weight:700; color:#065f46; background:var(--accent-bg); border:1px solid #b8e6d2; border-radius:4px; padding:1px 10px; letter-spacing:.5px; }
  .lig-id-fail { color:#92400e; background:#fffbeb; border-color:#fde68a; }
  .lig-id-pc { color:#0f766e; background:#f0fdfa; border-color:#99f6e4; }
  .lig-iupac { margin-top:7px; font-size:10.5px; line-height:1.65; color:var(--faint); overflow-wrap:anywhere; }
  .lig-name { font-size:13px; font-weight:600; color:var(--ink); overflow-wrap:anywhere; min-width:120px; }
  .lig-src { margin-left:auto; font-family:var(--mono); font-size:10px; color:var(--faint); letter-spacing:.4px; }
  .lig-meta { display:flex; flex-wrap:wrap; gap:4px 16px; margin-top:9px; font-size:11.5px; color:var(--sub); }
  .lig-meta b { color:var(--ink); font-weight:600; font-variant-numeric:tabular-nums; }
  .lig-props { display:flex; flex-wrap:wrap; gap:4px 14px; margin-top:8px; padding-top:8px; border-top:1px dashed var(--hairline); font-size:11px; color:var(--sub); }
  .lig-props b { color:var(--ink); font-weight:600; font-variant-numeric:tabular-nums; }
  .lig-fold { margin:8px 0 0; }
  .lig-ident { font-size:11px; color:var(--sub); line-height:1.9; overflow-wrap:anywhere; }
  .lig-ident b { color:var(--ink); font-weight:600; margin-right:4px; }
  .lig-ident .mono { font-size:10px; color:var(--sub); }
  .lig-pdbs { display:flex; flex-wrap:wrap; gap:6px; margin-top:10px; padding-top:10px; border-top:1px dashed var(--hairline); }
  .lig-pdbs a { font-family:var(--mono); font-size:10.5px; font-weight:600; color:var(--accent); background:var(--accent-bg); border:1px solid #c7ece0; border-radius:3px; padding:1px 8px; text-decoration:none; white-space:nowrap; }
  .lig-pdbs a i { font-style:normal; color:var(--faint); font-weight:400; margin-left:3px; }
  .lig-pdbs a.lig-also { background:#e0faf1; border-color:#71cdb2; color:#04503c; }
  .lig-pdbs a:hover { background:#d9f5e8; }
  .lig-more { align-self:center; font-family:var(--mono); font-size:10.5px; color:var(--faint); }
  .lig-none { font-size:12px; color:var(--faint); border-top:1px dashed var(--hairline); margin-top:10px; padding-top:8px; }
  @media (max-width:560px){ .lig-main{flex-direction:column; align-items:center} .lig-info{align-self:stretch} .lig-struct{flex-basis:auto} }

  /* ── 页脚 ── */
  .rpt-foot { margin-top:48px; padding-top:18px; border-top:1px solid var(--ink); font-size:11.5px; color:var(--sub); line-height:2; font-family:var(--mono); }
  .warn-box { background:#fffbeb; border:1px solid #fde68a; color:#92400e; border-radius:4px; padding:12px 16px; font-size:12.5px; margin:14px 0; }

`

export async function renderReportHtml(input: ReportRenderInput): Promise<string> {
  // v2.13：主体渲染抽出为 renderSingleReportBody（合并报告各靶点单独评估页复用，
  // 格式与单靶点报告一模一样）；本函数仅组装文档外壳（head/CSS/backtop/脚本）。
  const af3dBundle = input.alphafoldStructure || input.esmfoldStructure ? await ensure3DmolBundle() : null
  const body = await renderSingleReportBody({ ...input, af3dBundle })
  const u = input.ctx.uniprot
  const rangeSuffix = input.ctx.range ? ` · 残基 ${input.ctx.range[0]}-${input.ctx.range[1]}` : ''
  // v2.44：序列匹配（UniProt 匹配 / nr 识别）归属且非全同时 <title> 同步标注同源度
  //  （与 renderSingleReportBody 内 h1 同口径 — 单独报告导入匹配也从 <title> 提取）
  const outTi = input.ctx.targetIdentity
  const outIdentitySuffix = u && outTi && outTi.identity != null && outTi.identity < 99.95
    && (outTi.source === 'uniprot-blast' || outTi.source === 'blast-nr')
    ? ` · ${outTi.source === 'uniprot-blast' ? 'UniProt 匹配' : 'nr 识别'} ${Math.round(outTi.identity)}%`
    : ''
  const proteinTitle = u
    ? `${u.proteinName}${nspTitleSuffix(u, input.ctx.range)}（${u.uniprotId}${outIdentitySuffix}${rangeSuffix}）`
    : input.ctx.targetIdentity
      ? `${input.ctx.targetIdentity.name}（序列靶点${targetIdentityTitleSuffix(input.ctx.targetIdentity)}${rangeSuffix}）`
      : (input.ctx.range ? `序列靶点评估 · 残基 ${input.ctx.range[0]}-${input.ctx.range[1]}` : '序列靶点评估')
  // v2.45 机器可读靶点标记：报告导入精确匹配用（uniprot/range/seqLength/header/seqSha/label）。
  // v2.68 另发 targeteval:job（本报告的评估作业 id）— 单文件导入既有报告后，
  // 新运行的汇总报告据此 id 从服务端恢复该靶点的完整统计行（评分/结构/结论）。
  //  - uniprot 仅真 UniProt 靶点携带（序列靶点的同源命中不冒充 accession — 避免误匹配
  //    到同源 UniProt 靶点）；
  //  - seqSha = 提交序列 SHA-256 前 16 hex（与运行侧 sha256Hex16 同口径）；
  //  - label = 运行侧序列靶点标签同公式（头22…尾7 截断 + 「· Naa」— 旧标签通道兼容）。
  const metaTarget = (() => {
    const seq = input.ctx.sequence || ''
    const header = input.ctx.sequenceHeader?.trim() || undefined
    const seqSha = seq ? createHash('sha256').update(seq).digest('hex').slice(0, 16) : undefined
    const label = header && seq
      ? `${header.length > 30 ? `${header.slice(0, 22)}…${header.slice(-7)}` : header} · ${seq.length}aa`
      : undefined
    return {
      uniprot: u?.uniprotId,
      range: u ? input.ctx.range : undefined,
      seqLength: seq ? seq.length : (u?.sequenceLength || undefined),
      header,
      seqSha,
      label,
    }
  })()
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;600;700;900&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;0,8..60,700;1,8..60,400&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<title>靶点结构解析可行性评估报告 — ${esc(proteinTitle)}</title>
<meta name="targeteval:target" content="${esc(JSON.stringify(metaTarget))}">
<meta name="targeteval:job" content="${esc(JSON.stringify({ jobId: input.jobId }))}">
<style>
${SINGLE_REPORT_CSS}${RESPONSIVE_PAGE_CSS}${LIGHTBOX_CSS}${PRINT_PAGE_CSS}${UX_PAGE_CSS}</style>
</head>
<body>
<div class="page" id="top">
${body}
</div>
<a href="#top" class="backtop no-print" id="backtop" aria-label="回到顶部" title="回到顶部">↑</a>
<script>
(function(){
  var els;
  window.addEventListener('beforeprint', function(){
    els = [];
    document.querySelectorAll('details').forEach(function(d){
      if(!d.open){ d.dataset.pc='1'; d.open = true; els.push(d); }
    });
  });
  window.addEventListener('afterprint', function(){
    (els||[]).forEach(function(d){ if(d.dataset.pc){ d.open=false; delete d.dataset.pc; } });
    els = [];
  });
  var btn = document.getElementById('backtop');
  if (btn) {
    var onScroll = function(){ btn.classList.toggle('show', window.scrollY > 600); };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }
})();
</script>
${UX_PAGE_JS}
${TABLE_FILTER_JS}
${LIGHTBOX_JS}
</body>
</html>`
}
