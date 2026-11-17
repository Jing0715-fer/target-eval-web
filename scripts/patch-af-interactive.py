#!/usr/bin/env python3
"""v2.7.2 alphafold.ts 重构补丁：
1) 抽出 plddtStyleApplyJs（无头渲染页与报告内嵌交互视图共用着色实现）
2) buildRenderPage 瘦身为共用脚本调用
3) getBrowser 毒丸修复（launch 失败不再永久缓存被拒绝的 promise）
4) 新增 alphafoldStructureFor（PDB 文本磁盘缓存 + 12s 下载上限）与
   alphafoldFigureCached（legacy PNG 只读复用，无 Playwright 依赖）
"""
import io, sys

P = '/home/z/my-project/src/lib/eval/alphafold.ts'
src = io.open(P, encoding='utf-8').read()

# ── 1+2) 替换「pLDDT 着色渲染页」整段（到 Playwright 单例注释行之前）──
start = src.index('// ─── pLDDT 着色渲染页')
end = src.index('// ─── Playwright 单例')
old_region = src[start:end]
if 'plddtStyleApplyJs' in old_region:
    print('SKIP: already patched'); sys.exit(0)

new_region = r'''// ─── pLDDT 着色（无头渲染页与报告内嵌交互视图共用同一实现）──────────────────

/** 残基 pLDDT → 官方四段配色（AlphaFold DB 配色规范） */
const PLDDT_COLORS = { hi: '#0053D6', mid: '#65CBF3', low: '#FFDB13', poor: '#FF7D45' } as const

/**
 * pLDDT 四段着色脚本（v2.7.2 抽出共用 — 无头截图页与报告内嵌 3Dmol 交互视图同源，
 * 防两处逻辑漂移）。IIFE 接受 (pdb, viewer)；调用方作用域需已定义同名变量且
 * viewer 已 addModel 完成模型加载。
 * 关键语义（v2.7 修复）：3Dmol 的 resi 数组是「任一命中」（仅端点残基着色，
 * 区间中段无样式 → 结构大片透明看不到）；区间选择必须用 "min-max" 字符串
 * （propertyMatches 解析 (\d+)\s*-\s*(\d+) 为闭区间，全区间残基着色）。
 */
export function plddtStyleApplyJs(): string {
  return `(function (pdb, viewer) {
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
})(pdb, viewer);`
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

'''
src = src[:start] + new_region + src[end:]

# ── 3) getBrowser 毒丸修复 ──
old_browser = """async function getBrowser(): Promise<BrowserLike> {
  const mod = (await import('playwright')) as unknown as { chromium: ChromiumLike }
  pwGlobal.__afBrowser ??= mod.chromium.launch({
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  })
  return pwGlobal.__afBrowser as Promise<BrowserLike>
}"""
new_browser = """async function getBrowser(): Promise<BrowserLike> {
  const mod = (await import('playwright')) as unknown as { chromium: ChromiumLike }
  const p = mod.chromium.launch({
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  })
  // v2.7.2 毒丸修复：launch 失败会把被拒绝的 promise 永久缓在单例里，后续所有
  // 尝试都重放同一拒绝（进程生命周期内 AF 图永远失败）。失败即清除单例，下次重试。
  pwGlobal.__afBrowser ??= p
  p.catch(() => { if (pwGlobal.__afBrowser === p) pwGlobal.__afBrowser = undefined })
  return pwGlobal.__afBrowser as Promise<BrowserLike>
}"""
assert old_browser in src, 'getBrowser block not found'
src = src.replace(old_browser, new_browser)

# ── 4) 追加新导出（文件末尾）──
src = src.rstrip('\n') + r'''

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

/**
 * AFDB 模型 PDB 文本（v2.7.2 报告内嵌 3Dmol 交互视图的数据源）：
 * db/cache/alphafold/pdb/{id}.pdb 磁盘缓存（TTL 无限）；下载上限 12s ——
 * 稳落 14s 段预算与网关 ~24s 转发窗内，与旧 Playwright 截图路径（冷启动
 * 15-40s 不可中断）形成对照：这是部署节点图片生成失败根因的修复侧。
 */
export async function alphafoldStructureFor(uniprotId: string): Promise<AlphafoldStructure | null> {
  const id = uniprotId.trim().toUpperCase()
  const meta = await fetchAlphafoldPrediction(id)
  if (!meta) return null
  const cacheDir = path.join(process.cwd(), 'db', 'cache', 'alphafold', 'pdb')
  const file = path.join(cacheDir, `${id}.pdb`)
  let pdbText: string | null = null
  try {
    const cached = await fs.readFile(file, 'utf-8')
    if (cached.includes('ATOM')) pdbText = cached
  } catch { /* 未缓存 */ }
  if (pdbText == null) {
    pdbText = await downloadModelPdb(meta.pdbUrl, 12_000)
    if (pdbText == null) console.error('[af] model pdb download failed:', meta.pdbUrl)
    if (pdbText != null) {
      try {
        await fs.mkdir(cacheDir, { recursive: true })
        await fs.writeFile(file, pdbText, 'utf-8')
      } catch { /* 缓存失败不影响返回 */ }
    }
  }
  if (pdbText == null) return null
  return { uniprotId: id, pdbText, meta, embeddable: pdbText.length <= AF_EMBED_MAX_BYTES }
}

/** 已缓存的 legacy PNG 头图（只读复用 — 不再冷渲染；v2.7.2 起生产管线仅此路径取 PNG） */
export async function alphafoldFigureCached(uniprotId: string): Promise<AlphafoldFigure | null> {
  const id = uniprotId.trim().toUpperCase()
  const meta = await fetchAlphafoldPrediction(id)
  if (!meta) return null
  try {
    const file = path.join(process.cwd(), 'db', 'cache', 'alphafold', 'v2', `${id}.png`)
    const cached = await fs.readFile(file)
    if (cached.length > 5_000) return { uniprotId: id, png: cached, meta }
  } catch { /* 未缓存 */ }
  return null
}
'''

io.open(P, 'w', encoding='utf-8').write(src)
print('patched OK')
