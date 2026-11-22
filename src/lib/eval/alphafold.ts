/**
 * AlphaFold DB 预测结构集成（仅服务端）：
 *  - fetchAlphafoldPrediction: AFDB REST（/api/prediction/{uniprot}）→ 模型地址与 pLDDT 指标
 *  - alphafoldStructureFor: 下载模型 PDB → 磁盘缓存（db/cache/alphafold/pdb/）——
 *    v2.7.2 报告内嵌 3Dmol 交互视图的数据源（拖拽旋转/滚轮缩放/pLDDT 着色），
 *    下载上限 12s，稳落 14s 段预算与网关 ~24s 转发窗内；v2.7.4 起磁盘优先
 *  - alphafoldMetaFor（v2.7.4）：元数据「磁盘优先」——sidecar {id}.meta.json
 *    7 天新鲜窗口内零网络直读；过期联网核对模型版本；网络失败回退本地。
 *    部署节点断网时已评估过的靶点仍能出完整 AlphaFold 区块（元数据+PDB+3D 视图）
 *  - alphafoldFigure: （旧路径，v2.7.2 起仅当 legacy PNG 缓存已存在时复用）
 *    3Dmol.js + Playwright 无头截图 → sharp 后处理。生产管线不再调用其冷渲染：
 *    无头 Chromium 冷启动 15-40s 且不可中断，远超段预算——多实例负载均衡下
 *    图片永远渲染不完（部署节点「生成 alphafold 图片失败」的根因）
 *
 * 图片落盘缓存 db/cache/alphafold/{uniprot}.png（TTL 无限 — 模型版本升级才失效，
 * 命中时直接复用）。渲染失败静默降级（报告无图但不阻塞生成）。
 *
 * 通道实测（2026-11）：
 *  - AFDB REST 可用；pdbUrl 形如 https://alphafold.ebi.ac.uk/files/AF-P00533-F1-model_v6.pdb
 *  - /files/ 直链下载需浏览器 User-Agent（默认 curl UA 返回 403）
 *  - 3Dmol 官方 bundle：https://3dmol.csb.pitt.edu/build/3Dmol-min.js（~545KB）
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { apiCache } from './cache'
import type { AfDomainRange, UniprotFeature } from './types'

const AFDB_API = 'https://alphafold.ebi.ac.uk/api/prediction'
const AFDB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36'
const BUNDLE_URL = 'https://3dmol.csb.pitt.edu/build/3Dmol-min.js'
const BUNDLE_ALT_URL = 'https://3Dmol.org/build/3Dmol-min.js'

export interface AlphafoldPrediction {
  uniprotId: string
  modelId: string // 如 AF-P00533-F1
  pdbUrl: string
  cifUrl: string
  /** 平均 pLDDT（0-100） */
  globalPlddt: number | null
  /** pLDDT ≥90 区段占比（0-1） */
  fracVeryHigh: number | null
  /** pLDDT <50 区段占比（0-1） */
  fracVeryLow: number | null
  latestVersion: number
  gene: string
  organism: string
  sequenceLength: number
}

interface AfApiResponse {
  modelEntityId?: string
  pdbUrl?: string
  cifUrl?: string
  globalMetricValue?: number
  fractionPlddtVeryHigh?: number
  fractionPlddtVeryLow?: number
  latestVersion?: number
  gene?: { geneName?: string[] } | string[]
  organismScientificName?: string
  sequence?: string
}

/** AFDB 预测元数据（无预测时返回 null） */
export async function fetchAlphafoldPrediction(uniprotId: string): Promise<AlphafoldPrediction | null> {
  const id = uniprotId.trim().toUpperCase()
  const key = `af:meta:${id}`
  const hit = apiCache.get<AlphafoldPrediction | null>(key)
  if (hit !== undefined) return hit
  let out: AlphafoldPrediction | null = null
  let definitive = false // v2.5：404（无模型）或成功入缓存；网络/超时不入缓存（原实现把瞬时失败缓存为永久 null，该靶点报告长期无头图）
  try {
    const res = await fetch(`${AFDB_API}/${encodeURIComponent(id)}`, {
      headers: { Accept: 'application/json', 'User-Agent': AFDB_UA },
      signal: AbortSignal.timeout(15_000),
    })
    if (res.status === 404) definitive = true
    if (res.ok) {
      definitive = true
      const arr = (await res.json()) as AfApiResponse[]
      const e = Array.isArray(arr) ? arr[0] : undefined
      if (e?.pdbUrl) {
        const gene = Array.isArray(e.gene)
          ? e.gene.join(', ')
          : (e.gene?.geneName?.join(', ') ?? '')
        out = {
          uniprotId: id,
          modelId: (e.modelEntityId ?? `AF-${id}-F1`).slice(0, 32),
          pdbUrl: e.pdbUrl,
          cifUrl: e.cifUrl ?? '',
          globalPlddt: typeof e.globalMetricValue === 'number' ? Math.round(e.globalMetricValue * 10) / 10 : null,
          fracVeryHigh: typeof e.fractionPlddtVeryHigh === 'number' ? e.fractionPlddtVeryHigh : null,
          fracVeryLow: typeof e.fractionPlddtVeryLow === 'number' ? e.fractionPlddtVeryLow : null,
          latestVersion: e.latestVersion ?? 0,
          gene: gene.slice(0, 60),
          organism: (e.organismScientificName ?? '').slice(0, 80),
          sequenceLength: e.sequence?.length ?? 0,
        }
      }
    }
  } catch {
    out = null
  }
  if (definitive) apiCache.set(key, out)
  return out
}

/** 下载 AlphaFold 模型 PDB 文本（≤4MB；timeoutMs 可调 — 结构获取路径用 12s 上限） */
async function downloadModelPdb(pdbUrl: string, timeoutMs = 30_000): Promise<string | null> {
  // log via wrapper
  try {
    const res = await fetch(pdbUrl, {
      headers: { 'User-Agent': AFDB_UA },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return null
    const text = await res.text()
    if (!text.startsWith('HEADER') && !text.includes('ATOM')) return null
    if (text.length > 4 * 1024 * 1024) return null
    return text
  } catch {
    return null
  }
}

/** 3Dmol bundle 本地缓存（db/cache/3dmol.min.js）；报告内嵌交互视图共用（v2.7.2 导出） */
export async function ensure3DmolBundle(): Promise<string | null> {
  const cacheDir = path.join(process.cwd(), 'db', 'cache')
  const file = path.join(cacheDir, '3dmol.min.js')
  try {
    const existing = await fs.readFile(file, 'utf-8')
    if (existing.length > 100_000) return existing
  } catch { /* 未缓存 */ }
  for (const url of [BUNDLE_URL, BUNDLE_ALT_URL]) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': AFDB_UA },
        signal: AbortSignal.timeout(20_000),
      })
      if (!res.ok) continue
      const text = await res.text()
      if (text.length < 100_000) continue
      await fs.mkdir(cacheDir, { recursive: true })
      await fs.writeFile(file, text, 'utf-8')
      return text
    } catch { /* 尝试备用地址 */ }
  }
  return null
}

// ─── pLDDT 着色（无头渲染页与报告内嵌交互视图共用同一实现）──────────────────

/** 残基 pLDDT → 官方四段配色（AlphaFold DB 配色规范） */
const PLDDT_COLORS = { hi: '#0053D6', mid: '#65CBF3', low: '#FFDB13', poor: '#FF7D45' } as const

/**
 * pLDDT 四段着色核心（函数体文本 — 期望 pdb / viewer 两个绑定在包装作用域内可用）。
 * v2.46 抽出：plddtStyleApplyJs（初始化内联）与 afToolbarJs（运行时切换回 pLDDT
 * 模式）共用同一段逻辑，防两处漂移。
 * 关键语义（v2.7 修复）：3Dmol 的 resi 数组是「任一命中」（仅端点残基着色，
 * 区间中段无样式 → 结构大片透明看不到）；区间选择必须用 "min-max" 字符串
 * （propertyMatches 解析 (\d+)\s*-\s*(\d+) 为闭区间，全区间残基着色）。
 */
function plddtApplyCoreJs(): string {
  return `
  // 残基 pLDDT（B-factor 列）分桶
  var lines = pdb.split('\\n');
  var resB = {};
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    if (l.indexOf('ATOM  ') !== 0) continue;
    var resi = parseInt(l.slice(22, 26), 10);
    var b = parseFloat(l.slice(60, 66));
    if (Number.isFinite(resi) && Number.isFinite(b) && resB[resi] === undefined) resB[resi] = b;
  }
  var bucketOf = {};
  var ids = Object.keys(resB);
  for (var j = 0; j < ids.length; j++) {
    var r = +ids[j], v = resB[r];
    bucketOf[r] = v >= 90 ? 'hi' : v >= 70 ? 'mid' : v >= 50 ? 'low' : 'poor';
  }
  // 相同桶的连续残基段 → resi 区间选择器（3Dmol [min,max] 区间语义）
  function runsOf(filter) {
    var sorted = ids.map(Number).sort(function (a, b) { return a - b });
    var runs = [], cur = null;
    for (var k = 0; k < sorted.length; k++) {
      if (bucketOf[sorted[k]] !== filter) continue;
      if (cur && sorted[k] === cur[1] + 1) cur[1] = sorted[k];
      else { if (cur) runs.push(cur); cur = [sorted[k], sorted[k]]; }
    }
    if (cur) runs.push(cur);
    return runs;
  }
  // 兜底基础样式：无 pLDDT 桶的残基（若有）以浅灰可见，避免「透明看不到」
  viewer.setStyle({}, { cartoon: { color: '#e7e5e4' } });
  var ok = true;
  try {
    var groups = [['hi', '${PLDDT_COLORS.hi}'], ['mid', '${PLDDT_COLORS.mid}'], ['low', '${PLDDT_COLORS.low}'], ['poor', '${PLDDT_COLORS.poor}']];
    for (var g = 0; g < groups.length; g++) {
      var runs = runsOf(groups[g][0]);
      for (var q = 0; q < runs.length; q++) {
        viewer.setStyle({ resi: runs[q][0] + '-' + runs[q][1] }, { cartoon: { color: groups[g][1] } });
      }
    }
  } catch (e) { ok = false; }
  if (!ok) viewer.setStyle({}, { cartoon: { color: 'spectrum' } });
`
}

/**
 * pLDDT 四段着色脚本（v2.7.2 抽出共用 — 无头截图页与报告内嵌 3Dmol 交互视图同源，
 * 防两处逻辑漂移）。IIFE 接受 (pdb, viewer)；调用方作用域需已定义同名变量且
 * viewer 已 addModel 完成模型加载。
 */
export function plddtStyleApplyJs(): string {
  return `(function (pdb, viewer) {${plddtApplyCoreJs()}})(pdb, viewer);`
}

// ─── v2.46：UniProt 域划分提取（报告预测结构视图「按域着色」数据源）───────────

/** 落库/内嵌的 DOMAIN 区间上限（防重复序列蛋白如纤维粘连蛋白撑爆报告与图例） */
const AF_DOMAINS_MAX = 24

/**
 * 从 UniProt features 过滤 DOMAIN 结构域区间（v2.46；v2.47 修复大小写）：
 *  - 仅 type === 'Domain'（UniProt REST 原文大小写 — uniprot.ts FEATURE_KEEP 同款；
 *    v2.46 误写成全大写 'DOMAIN' 恒不命中 → 域着色数据恒空、选项永远置灰）；
 *  - 区间有效性校验（end ≥ begin ≥ 1）+ 与序列长度弱校验（防异常注释越界）；
 *  - begin 升序稳定排序，名称截断 60 字符，上限 24 条；
 *  - AFDB 模型残基编号 = UniProt 坐标 → 区间直接映射 3Dmol resi（无需换算）。
 * 无 Domain 注释/无归属时返回 undefined（报告「UniProt 域」选项禁用）。
 */
export function extractAfDomains(
  features: UniprotFeature[] | undefined | null,
  sequenceLength: number | undefined | null,
): AfDomainRange[] | undefined {
  if (!features || !features.length) return undefined
  const limit = sequenceLength && sequenceLength > 0 ? sequenceLength : Number.MAX_SAFE_INTEGER
  const out: AfDomainRange[] = []
  for (const f of features) {
    if (f.type !== 'Domain') continue
    const start = Number(f.begin)
    const end = Number(f.end)
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    if (start < 1 || end < start) continue
    if (start > limit || end - start + 1 > limit) continue
    const name = (f.description ?? '').trim().slice(0, 60) || 'Domain'
    out.push({ name, start, end })
  }
  if (!out.length) return undefined
  out.sort((a, b) => a.start - b.start)
  return out.slice(0, AF_DOMAINS_MAX)
}

/**
 * v2.46/v2.47：预测结构视图工具条公共脚本（单靶点报告 AF/ESMFold 视图 + 合并报告公共
 * MODELS 池三处共用 — 一份实现防漂移）。注入后暴露：
 *  - window.__afPlddtApply(pdb, viewer)：pLDDT 四段着色（与初始化同源核心）；
 *  - window.__afTb.mount(stage, viewer, pdb, { fileName, domains })：给 af-stage
 *    挂载「下载 PDB + 着色切换」工具条（pLDDT 置信 / 彩虹 N→C / UniProt 域），
 *    切换时同步重建图例并刷新打印海报（pngURI）。
 *    v2.47：小窗拥挤 → 工具条 CSS 仅在放大视图（.af-fullslot 内）显示（小窗内
 *    .af-stage .af-tb 一律 display:none，见 SINGLE_REPORT_CSS）；灯箱脚本放大时
 *    把 .af-tb 随 canvas 迁入全屏槽、关闭时归位，并调 tb.__afSync() 把图例
 *    （内嵌 .af-legend + 全屏条 .af-full-legend 双处）对齐当前已选着色。
 * 域着色仅 AFDB 模型启用（残基编号 = UniProt 坐标）；ESMFold 模型编号自 1 起
 * 不保证对齐 → 调用方不传 domains（选项禁用置灰）。
 */
export function afToolbarJs(): string {
  return `(function () {
  if (window.__afTb) return;
  window.__afPlddtApply = function (pdb, viewer) {${plddtApplyCoreJs()}  };
  var PALETTE = ['#E64B35', '#4DBBD5', '#00A087', '#3C5488', '#F39B7F', '#8491B4',
                 '#91D1C2', '#DC9300', '#7E6148', '#B09C85', '#0C90A0', '#C49A2C'];
  function escT(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  window.__afTb = {
    mount: function (stage, viewer, pdb, opts) {
      if (!stage || !viewer || !pdb || stage.__afTbDone) return;
      stage.__afTbDone = true;
      opts = opts || {};
      var fileName = opts.fileName || 'model.pdb';
      var domains = opts.domains || null;
      var tb = document.createElement('div');
      tb.className = 'af-tb';
      // — 下载按钮（内嵌 PDB 文本 → Blob → a[download]）—
      var dl = document.createElement('button');
      dl.type = 'button';
      dl.className = 'af-tb-btn';
      dl.title = '下载预测结构 PDB 文件（' + fileName + '）';
      dl.setAttribute('aria-label', '下载预测结构 PDB 文件');
      dl.innerHTML = '<svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 1.5v9m0 0l-3.5-3.5M8 10.5l3.5-3.5M2.5 13.5h11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>PDB';
      dl.addEventListener('click', function () {
        try {
          var blob = new Blob([pdb], { type: 'chemical/x-pdb' });
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url; a.download = fileName;
          a.style.display = 'none';
          (document.body || stage).appendChild(a);
          a.click();
          setTimeout(function () { a.remove(); try { URL.revokeObjectURL(url); } catch (er) {} }, 5000);
        } catch (e) { /* 下载失败静默（沙箱 iframe 拦截等） */ }
      });
      // — 着色切换 + 图例（v2.47：图例双处同步 — 内嵌 .af-legend + 全屏条 .af-full-legend）—
      function legendEls() {
        var out = [];
        try {
          var fig = stage.closest ? stage.closest('figure') : null;
          var fl = fig ? fig.querySelector('.af-legend') : null;
          if (fl) out.push(fl);
          // 全屏打开时 tb 已随 canvas 迁入 .af-fullslot → 自 tb 向上找全屏条图例
          var wrap = tb.closest ? tb.closest('.af-fullwrap') : null;
          var wl = wrap ? wrap.querySelector('.af-full-legend') : null;
          if (wl) out.push(wl);
        } catch (e) { /* ignore */ }
        return out;
      }
      function legendHtml(mode) {
        if (mode === 'rainbow') {
          return '<span class="af-lgd-rb"><i class="af-lgd-rb-bar"></i>N 端 → C 端（彩虹渐变）</span>';
        }
        if (mode === 'domain' && domains && domains.length) {
          var h = '';
          for (var i = 0; i < domains.length; i++) {
            h += '<span class="af-lgd-item" title="' + escT(domains[i].name) + '（残基 ' + domains[i].start + '-' + domains[i].end + '）"><i style="background:' + PALETTE[i % PALETTE.length] + '"></i>' + escT(domains[i].name) + ' ' + domains[i].start + '-' + domains[i].end + '</span>';
          }
          return h + '<span class="af-lgd-item"><i style="background:#e7e5e4"></i>无注释区段</span>';
        }
        return '<span><i style="background:#0053D6"></i>pLDDT ≥ 90</span>'
             + '<span><i style="background:#65CBF3"></i>70–90</span>'
             + '<span><i style="background:#FFDB13"></i>50–70</span>'
             + '<span><i style="background:#FF7D45"></i>&lt; 50</span>';
      }
      function setLegends(mode) {
        var els = legendEls();
        for (var n = 0; n < els.length; n++) {
          els[n].innerHTML = legendHtml(mode);
          els[n].classList.toggle('af-lgd-scroll', mode === 'domain');
        }
      }
      function apply(mode) {
        try {
          if (mode === 'rainbow') {
            viewer.setStyle({}, { cartoon: { color: 'spectrum' } });
          } else if (mode === 'domain' && domains && domains.length) {
            viewer.setStyle({}, { cartoon: { color: '#e7e5e4' } });
            for (var i = 0; i < domains.length; i++) {
              viewer.setStyle({ resi: String(domains[i].start) + '-' + String(domains[i].end) }, { cartoon: { color: PALETTE[i % PALETTE.length] } });
            }
          } else {
            window.__afPlddtApply(pdb, viewer);
          }
          viewer.render();
        } catch (e) { /* 切换失败保持当前样式 */ }
        setLegends(mode);
        // 打印海报跟随当前着色刷新
        try {
          var uri = viewer.pngURI ? viewer.pngURI() : null;
          var p = stage.querySelector('.af-poster');
          if (uri && p) p.src = uri;
        } catch (e) { /* ignore */ }
      }
      var sel = document.createElement('select');
      sel.className = 'af-tb-sel';
      sel.title = '切换结构着色方式';
      sel.setAttribute('aria-label', '结构着色方式');
      var oP = document.createElement('option'); oP.value = 'plddt'; oP.textContent = 'pLDDT 置信';
      var oR = document.createElement('option'); oR.value = 'rainbow'; oR.textContent = '彩虹 N→C';
      var oD = document.createElement('option'); oD.value = 'domain';
      if (domains && domains.length) { oD.textContent = 'UniProt 域'; oD.title = '按 UniProt DOMAIN 结构域注释区间着色'; }
      else { oD.textContent = 'UniProt 域（无注释）'; oD.disabled = true; oD.title = '该靶点无 UniProt DOMAIN 注释（或模型残基编号与 UniProt 坐标不对齐）'; }
      sel.appendChild(oP); sel.appendChild(oR); sel.appendChild(oD);
      sel.addEventListener('change', function () { apply(sel.value); });
      tb.appendChild(dl);
      tb.appendChild(sel);
      stage.appendChild(tb);
      // v2.47：放大打开时灯箱脚本调用 — 图例对齐当前已选着色（重开全屏不再回显默认 pLDDT 图例）
      tb.__afSync = function () { setLegends(sel.value); };
    }
  };
})();`
}

export function buildRenderPage(bundleJs: string, pdbText: string, width: number, height: number): string {
  const safePdb = JSON.stringify(pdbText)
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
  html,body { margin:0; padding:0; background:#ffffff; overflow:hidden; }
  #viewport { width:${width}px; height:${height}px; position:relative; }
</style>
<script>${bundleJs}</script>
</head>
<body>
<div id="viewport"></div>
<script>
(function () {
  var pdb = ${safePdb};
  var viewer = $3Dmol.createViewer('viewport', { defaultcolors: $3Dmol.rasmolElementColors });
  viewer.setBackgroundColor(0xffffff);
  viewer.addModel(pdb, 'pdb');
  ${plddtStyleApplyJs()}
  viewer.zoomTo();
  viewer.zoom(1.2); // framing: fit then modest zoom-in, leaves margins without cropping
  viewer.render();
  window.__READY__ = true;
})();
</script>
</body></html>`
}

// ─── Playwright 单例 ──────────────────────────────────────────────────────

const pwGlobal = globalThis as unknown as { __afBrowser?: Promise<unknown> }

interface ChromiumLike {
  launch(opts: { args: string[] }): Promise<BrowserLike>
}
interface BrowserLike {
  newPage(): Promise<PageLike>
  close(): Promise<void>
}
interface PageLike {
  setViewportSize(size: { width: number; height: number }): Promise<void>
  setContent(html: string, opts: { waitUntil: string; timeout: number }): Promise<void>
  waitForFunction(fn: string, arg: unknown, opts: { timeout: number; polling: number }): Promise<void>
  on(event: 'pageerror', fn: (e: Error) => void): void
  on(event: 'console', fn: (msg: { type(): string; text(): string }) => void): void
  screenshot(opts: { type: 'png' }): Promise<Buffer>
  close(): Promise<void>
}

async function getBrowser(): Promise<BrowserLike> {
  const mod = (await import('playwright')) as unknown as { chromium: ChromiumLike }
  const p = mod.chromium.launch({
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  })
  // v2.7.2 毒丸修复：launch 失败会把被拒绝的 promise 永久缓在单例里，后续所有
  // 尝试都重放同一拒绝（进程生命周期内 AF 图永远失败）。失败即清除单例，下次重试。
  pwGlobal.__afBrowser ??= p
  p.catch(() => { if (pwGlobal.__afBrowser === p) pwGlobal.__afBrowser = undefined })
  return pwGlobal.__afBrowser as Promise<BrowserLike>
}

/** 渲染尺寸（CSS px；截图 DSF 1.5 → 1440×960 PNG） */
const RENDER_W = 960
const RENDER_H = 640

async function screenshotModel(pdbText: string): Promise<Buffer | null> {
  const bundle = await ensure3DmolBundle()
  if (!bundle) return null
  let page: PageLike | null = null
  try {
    const browser = await getBrowser()
    page = await browser.newPage()
    await page.setViewportSize({ width: RENDER_W, height: RENDER_H })
    const html = buildRenderPage(bundle, pdbText, RENDER_W, RENDER_H)
    page.on('pageerror', e => console.error('[af] pageerror:', String(e).slice(0, 300)))
    page.on('console', m => { if (m.type() === 'error') console.error('[af] console.error:', m.text().slice(0, 300)) })
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForFunction('window.__READY__ === true', null, { timeout: 20_000, polling: 120 })
    // 等一帧动画稳定后再截屏
    await new Promise(r => setTimeout(r, 600))
    return await page.screenshot({ type: 'png' })
  } catch (e) {
    console.error('[af] screenshotModel failed:', e instanceof Error ? e.name + ' :: ' + e.message : String(e))
    return null
  } finally {
    try { await page?.close() } catch { /* ignore */ }
  }
}

// ─── 截图后处理（sharp：白底压平 + trim 去白边 + 小边距）─────────────────────

type SharpModule = typeof import('sharp')
let sharpMod: SharpModule | null = null
async function getSharp(): Promise<SharpModule | null> {
  if (sharpMod) return sharpMod
  try {
    sharpMod = (await import('sharp')).default as SharpModule
    return sharpMod
  } catch {
    return null // sharp 不可用 → 优雅降级，原样返回
  }
}

/**
 * 去白边（v2.2）：3Dmol zoomTo 留白常达 50-160px，报告头图 300px 宽度下显得大片空白。
 * trim 白色边缘后均匀留 ~3% 边距（结构不贴边）；异常时返回原图。
 */
async function trimFigurePng(png: Buffer): Promise<Buffer> {
  const sharp = await getSharp()
  if (!sharp) return png
  try {
    const img = sharp(png, { limitInputPixels: 4_000_000 })
    const meta = await img.metadata()
    if (!meta.width || !meta.height) return png
    const pad = Math.max(10, Math.round(Math.min(meta.width, meta.height) * 0.03))
    const out = await img
      .flatten({ background: '#ffffff' })
      .trim({ threshold: 12 })
      .extend({ top: pad, bottom: pad, left: pad, right: pad, background: '#ffffff' })
      .png({ compressionLevel: 9 })
      .toBuffer()
    if (out.length < 5_000) return png
    const m2 = await sharp(out).metadata()
    // trim 异常（内容被裁得过小）→ 放弃后处理
    if ((m2.width ?? 0) < 160 || (m2.height ?? 0) < 120) return png
    return out
  } catch {
    return png
  }
}

// ─── 对外编排（磁盘缓存）─────────────────────────────────────────────────────

export interface AlphafoldFigure {
  uniprotId: string
  png: Buffer
  meta: AlphafoldPrediction
}

/** AFDB 预测结构图（带 db/cache/alphafold/v2/{uniprot}.png 磁盘缓存）
 *  v2.7：缓存路径升到 v2 子目录 — 旧渲染存在「区间中段残基未着色（透明看不到）」缺陷，
 *  与修复后的选择器产物不兼容，需整体失效重新渲染。 */
export async function alphafoldFigureFor(uniprotId: string): Promise<AlphafoldFigure | null> {
  const id = uniprotId.trim().toUpperCase()
  const meta = await fetchAlphafoldPrediction(id)
  if (!meta) return null
  const cacheDir = path.join(process.cwd(), 'db', 'cache', 'alphafold', 'v2')
  const file = path.join(cacheDir, `${id}.png`)
  try {
    const cached = await fs.readFile(file)
    if (cached.length > 5_000) return { uniprotId: id, png: cached, meta }
  } catch { /* 未缓存 */ }
  const pdbText = await downloadModelPdb(meta.pdbUrl)
  if (!pdbText) console.error('[af] model pdb download failed:', meta.pdbUrl)
  if (!pdbText) return null
  const pngRaw = await screenshotModel(pdbText)
  if (!pngRaw || pngRaw.length < 5_000) return null
  const png = await trimFigurePng(pngRaw)
  try {
    await fs.mkdir(cacheDir, { recursive: true })
    await fs.writeFile(file, png)
  } catch { /* 缓存失败不影响返回 */ }
  return { uniprotId: id, png, meta }
}

// ─── v2.7.2：报告内嵌交互视图数据源（无 Playwright/Chromium 依赖）────────────

/** 内嵌报告的 PDB 文本预算（>2.5MB 的超大蛋白跳过交互视图，保统计信息呈现） */
export const AF_EMBED_MAX_BYTES = 2.5 * 1024 * 1024

export interface AlphafoldStructure {
  uniprotId: string
  pdbText: string
  meta: AlphafoldPrediction
  /** ≤AF_EMBED_MAX_BYTES（可安全内嵌进报告 HTML，经 done 事件回传前端） */
  embeddable: boolean
}

// ─── v2.7.4：磁盘优先元数据/结构（离线可用）──────────────────────────────

/** 元数据 sidecar 新鲜度窗口：7 天内零网络直读；过期联网核对模型版本，失败回退本地 */
const AF_META_TTL_MS = 7 * 24 * 3600 * 1000

/** 磁盘缓存目录（db/cache/alphafold/pdb/：元数据 {id}.meta.json + 模型 {id}.pdb） */
function afDiskDir(): string {
  return path.join(process.cwd(), 'db', 'cache', 'alphafold', 'pdb')
}

/** ID 白名单（UniProt accession 字符集 — 防路径注入；异常 ID 直接视为无预测） */
function safeAfId(uniprotId: string): string | null {
  const id = uniprotId.trim().toUpperCase()
  return /^[A-Z0-9_-]{1,12}$/.test(id) ? id : null
}

interface AfDiskMeta {
  savedAt: number
  meta: AlphafoldPrediction
}

async function readAfMetaFile(id: string): Promise<AfDiskMeta | null> {
  try {
    const raw = await fs.readFile(path.join(afDiskDir(), `${id}.meta.json`), 'utf-8')
    const parsed = JSON.parse(raw) as AfDiskMeta
    if (parsed?.meta?.pdbUrl && typeof parsed.savedAt === 'number') return parsed
  } catch { /* 未缓存/损坏 */ }
  return null
}

async function writeAfMetaFile(id: string, meta: AlphafoldPrediction): Promise<void> {
  try {
    await fs.mkdir(afDiskDir(), { recursive: true })
    const payload: AfDiskMeta = { savedAt: Date.now(), meta }
    await fs.writeFile(path.join(afDiskDir(), `${id}.meta.json`), JSON.stringify(payload), 'utf-8')
  } catch { /* 缓存失败不影响主流程 */ }
}

async function readAfPdbFile(id: string): Promise<string | null> {
  try {
    const cached = await fs.readFile(path.join(afDiskDir(), `${id}.pdb`), 'utf-8')
    return cached.includes('ATOM') ? cached : null
  } catch { /* 未缓存 */ }
  return null
}

async function writeAfPdbFile(id: string, pdbText: string): Promise<void> {
  try {
    await fs.mkdir(afDiskDir(), { recursive: true })
    await fs.writeFile(path.join(afDiskDir(), `${id}.pdb`), pdbText, 'utf-8')
  } catch { /* 缓存失败不影响主流程 */ }
}

function makeAfStructure(id: string, pdbText: string, meta: AlphafoldPrediction): AlphafoldStructure {
  return { uniprotId: id, pdbText, meta, embeddable: pdbText.length <= AF_EMBED_MAX_BYTES }
}

/**
 * v2.7.4：AF 元数据「磁盘优先」——sidecar 7 天新鲜窗口内零网络直读；
 * 过期联网核对（模型版本升级换 pdbUrl）；网络失败回退本地缓存（离线可用）。
 * af2 相位与 legacy PNG 复用均改走本入口，部署节点断网不再丢 AlphaFold 区块。
 */
export async function alphafoldMetaFor(uniprotId: string): Promise<AlphafoldPrediction | null> {
  const id = safeAfId(uniprotId)
  if (!id) return null
  const disk = await readAfMetaFile(id)
  if (disk && Date.now() - disk.savedAt < AF_META_TTL_MS) return disk.meta
  const meta = await fetchAlphafoldPrediction(id)
  if (meta) {
    await writeAfMetaFile(id, meta)
    return meta
  }
  if (disk) {
    console.warn('[af] metadata network unavailable — serving local cache:', id)
    return disk.meta
  }
  return null
}

/**
 * AFDB 模型 PDB 文本（v2.7.2 报告内嵌 3Dmol 交互视图的数据源；v2.7.4 磁盘优先）。
 * 磁盘缓存 db/cache/alphafold/pdb/{id}.pdb + {id}.meta.json sidecar：
 *  - 元数据新鲜（<7 天）且模型已缓存 → 零网络直读（部署节点离线可用）；
 *  - 过期 → 联网核对（模型版本升级换 pdbUrl 时重下载）；
 *  - 网络失败 → 回退本地缓存（降级不丢区块）；下载上限 12s ——
 *   稳落 14s 段预算与网关 ~24s 转发窗内，与旧 Playwright 截图路径（冷启动
 *   15-40s 不可中断）形成对照：这是部署节点图片生成失败根因的修复侧。
 */
export async function alphafoldStructureFor(uniprotId: string): Promise<AlphafoldStructure | null> {
  const id = safeAfId(uniprotId)
  if (!id) return null
  const diskMeta = await readAfMetaFile(id)
  const diskPdb = await readAfPdbFile(id)
  const fresh = diskMeta != null && Date.now() - diskMeta.savedAt < AF_META_TTL_MS

  // 快路径：元数据新鲜 + 模型已缓存 → 零网络（离线可用核心路径）
  if (fresh && diskMeta) {
    if (diskPdb) return makeAfStructure(id, diskPdb, diskMeta.meta)
    const pdbText = await downloadModelPdb(diskMeta.meta.pdbUrl, 12_000)
    if (pdbText == null) {
      console.error('[af] model pdb download failed:', diskMeta.meta.pdbUrl)
      return null
    }
    await writeAfPdbFile(id, pdbText)
    return makeAfStructure(id, pdbText, diskMeta.meta)
  }

  // 慢路径：sidecar 缺失/过期 → 联网刷新（alphafoldMetaFor 内含断网回退）
  const meta = await alphafoldMetaFor(id)
  if (meta) {
    const unchanged = diskMeta != null && diskMeta.meta.pdbUrl === meta.pdbUrl
    let pdbText = unchanged ? diskPdb : null
    if (pdbText == null) {
      pdbText = await downloadModelPdb(meta.pdbUrl, 12_000)
      if (pdbText == null) console.error('[af] model pdb download failed:', meta.pdbUrl)
      if (pdbText != null) await writeAfPdbFile(id, pdbText)
    }
    if (pdbText != null) return makeAfStructure(id, pdbText, meta)
    // 新版下载失败但本地旧模型在 → 旧 meta+旧 pdb 成对回退（版本口径一致）
    if (diskPdb && diskMeta) return makeAfStructure(id, diskPdb, diskMeta.meta)
    return null
  }
  return null
}

/** 已缓存的 legacy PNG 头图（只读复用 — 不再冷渲染；v2.7.2 起生产管线仅此路径取 PNG。
 *  v2.7.4 起元数据改走 alphafoldMetaFor 磁盘优先 — 断网时 poster 兜底同样可用） */
export async function alphafoldFigureCached(uniprotId: string): Promise<AlphafoldFigure | null> {
  const id = safeAfId(uniprotId)
  if (!id) return null
  const meta = await alphafoldMetaFor(id)
  if (!meta) return null
  try {
    const file = path.join(process.cwd(), 'db', 'cache', 'alphafold', 'v2', `${id}.png`)
    const cached = await fs.readFile(file)
    if (cached.length > 5_000) return { uniprotId: id, png: cached, meta }
  } catch { /* 未缓存 */ }
  return null
}
