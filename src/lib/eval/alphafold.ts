/**
 * AlphaFold DB 预测结构集成（仅服务端）：
 *  - fetchAlphafoldPrediction: AFDB REST（/api/prediction/{uniprot}）→ 模型地址与 pLDDT 指标
 *  - alphafoldFigure: 下载模型 PDB → 3Dmol.js（本地缓存 bundle）+ Playwright 无头截图
 *    → pLDDT 着色卡通图（官方四段配色：≥90 蓝 / 70-90 青 / 50-70 黄 / <50 橙）
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
  try {
    const res = await fetch(`${AFDB_API}/${encodeURIComponent(id)}`, {
      headers: { Accept: 'application/json', 'User-Agent': AFDB_UA },
      signal: AbortSignal.timeout(15_000),
    })
    if (res.ok) {
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
  apiCache.set(key, out)
  return out
}

/** 下载 AlphaFold 模型 PDB 文本（≤4MB） */
async function downloadModelPdb(pdbUrl: string): Promise<string | null> {
  // log via wrapper
  try {
    const res = await fetch(pdbUrl, {
      headers: { 'User-Agent': AFDB_UA },
      signal: AbortSignal.timeout(30_000),
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

/** 3Dmol bundle 本地缓存（db/cache/3dmol.min.js） */
async function ensure3DmolBundle(): Promise<string | null> {
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

// ─── pLDDT 着色渲染页 ─────────────────────────────────────────────────────────

/** 残基 pLDDT → 官方四段配色（AlphaFold DB 配色规范） */
const PLDDT_COLORS = { hi: '#0053D6', mid: '#65CBF3', low: '#FFDB13', poor: '#FF7D45' } as const

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
  var viewer = $3Dmol.createViewer('viewport', { defaultcolors: $3Dmol.rasmolElementColors });
  viewer.setBackgroundColor(0xffffff);
  viewer.addModel(pdb, 'pdb');
  var ok = true;
  try {
    var groups = [['hi', '${PLDDT_COLORS.hi}'], ['mid', '${PLDDT_COLORS.mid}'], ['low', '${PLDDT_COLORS.low}'], ['poor', '${PLDDT_COLORS.poor}']];
    for (var g = 0; g < groups.length; g++) {
      var runs = runsOf(groups[g][0]);
      for (var q = 0; q < runs.length; q++) {
        viewer.setStyle({ resi: runs[q] }, { cartoon: { color: groups[g][1] } });
      }
    }
  } catch (e) { ok = false; }
  if (!ok) viewer.setStyle({}, { cartoon: { color: 'spectrum' } });
  viewer.zoomTo();
  viewer.zoom(1.2); // framing: fit then modest zoom-in, leaves margins without cropping
  viewer.render();
  window.__READY__ = true;
})();
</script>
</body></html>`
}

// ─── Playwright 单例 ──────────────────────────────────────────────────────────

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
  pwGlobal.__afBrowser ??= mod.chromium.launch({
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  })
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

// ─── 对外编排（磁盘缓存）─────────────────────────────────────────────────────

export interface AlphafoldFigure {
  uniprotId: string
  png: Buffer
  meta: AlphafoldPrediction
}

/** AFDB 预测结构图（带 db/cache/alphafold/{uniprot}.png 磁盘缓存） */
export async function alphafoldFigureFor(uniprotId: string): Promise<AlphafoldFigure | null> {
  const id = uniprotId.trim().toUpperCase()
  const meta = await fetchAlphafoldPrediction(id)
  if (!meta) return null
  const cacheDir = path.join(process.cwd(), 'db', 'cache', 'alphafold')
  const file = path.join(cacheDir, `${id}.png`)
  try {
    const cached = await fs.readFile(file)
    if (cached.length > 5_000) return { uniprotId: id, png: cached, meta }
  } catch { /* 未缓存 */ }
  const pdbText = await downloadModelPdb(meta.pdbUrl)
  if (!pdbText) console.error('[af] model pdb download failed:', meta.pdbUrl)
  if (!pdbText) return null
  if (!pdbText) return null
  const png = await screenshotModel(pdbText)
  if (!png || png.length < 5_000) return null
  try {
    await fs.mkdir(cacheDir, { recursive: true })
    await fs.writeFile(file, png)
  } catch { /* 缓存失败不影响返回 */ }
  return { uniprotId: id, png, meta }
}
