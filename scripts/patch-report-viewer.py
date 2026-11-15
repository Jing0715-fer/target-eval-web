#!/usr/bin/env python3
"""v2.7.2 report-html.ts 交互式 AlphaFold 3D 视图补丁：
1) ReportRenderInput 新增 alphafoldStructure 字段
2) afFigureHtml → afBlockHtml：内嵌 3Dmol bundle + PDB + plddtStyleApplyJs 共用着色
   （拖拽旋转/滚轮缩放；失败降级 legacy PNG / 统计信息）
3) CSS：.af-stage/.af-canvas/.af-legend + 打印回落 poster
4) legacy `.af-fig img` 选择器收紧为 `.af-fig > img`（poster 不被 320px 规则命中）
"""
import io, sys

P = '/home/z/my-project/src/lib/eval/report-html.ts'
src = io.open(P, encoding='utf-8').read()

if 'afBlockHtml' in src:
    print('SKIP: already patched'); sys.exit(0)

# ── 1) import ──
old_import = "import { describeEvidenceSource, describeOligoConfidence } from './oligomer'"
new_import = ("import { describeEvidenceSource, describeOligoConfidence } from './oligomer'\n"
              "import { ensure3DmolBundle, plddtStyleApplyJs } from './alphafold'")
assert old_import in src
src = src.replace(old_import, new_import, 1)

# ── 2) 类型字段 ──
old_field = """  alphafoldFigure?: {
    dataUri: string
    modelId: string
    globalPlddt: number | null
    version: number
    fracVeryHigh: number | null
  }
  resolveImagePath: (meta: ParsedImage) => string
}"""
new_field = """  alphafoldFigure?: {
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
  resolveImagePath: (meta: ParsedImage) => string
}"""
assert old_field in src, 'input type block not found'
src = src.replace(old_field, new_field, 1)

# ── 3) afFigureHtml → afBlockHtml ──
old_block = """  const afFigureHtml = input.alphafoldFigure ? `
      <figure class="af-fig">
        <img src="${input.alphafoldFigure.dataUri}" alt="AlphaFold 预测结构（pLDDT 着色）">
        <figcaption><b>AlphaFold 预测结构</b> · pLDDT 着色<br>${esc(input.alphafoldFigure.modelId)} · v${input.alphafoldFigure.version} · 平均 pLDDT ${input.alphafoldFigure.globalPlddt ?? '—'}<br><a href="https://alphafold.ebi.ac.uk/entry/${u ? u.uniprotId : ''}" target="_blank" rel="noopener">alphafold.ebi.ac.uk →</a></figcaption>
      </figure>` : ''"""
assert old_block in src, 'afFigureHtml block not found'

new_block = r"""  // v2.7.2：AlphaFold 头图 — 优先内嵌 3Dmol 交互式 3D 视图（拖拽旋转/滚轮缩放，
  // pLDDT 四段着色；与无头截图页共用 plddtStyleApplyJs 同一着色实现）。失败降级链：
  // 交互视图 → legacy 静态 PNG（磁盘缓存命中时）→ 仅统计信息；打印/无 WebGL 时
  // poster 静态图兜底（viewer 初始化成功后用 pngURI 生成打印海报）。
  const af3dBundle = input.alphafoldStructure ? await ensure3DmolBundle() : null
  const af = input.alphafoldStructure
  const afBlockHtml = af ? `
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
              try {
                var uri = viewer.pngURI ? viewer.pngURI() : null;
                if (uri && poster) poster.src = uri;
              } catch (e) { /* 打印海报生成失败不影响交互 */ }
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
        <figcaption><b>AlphaFold 预测结构</b> · 拖拽旋转 · 滚轮缩放 · pLDDT 置信着色<br>${esc(af.modelId)} · v${af.version} · 平均 pLDDT ${af.globalPlddt ?? '—'} · ${Math.round(af.pdbText.length / 1024)}KB 内嵌模型<br><a href="https://alphafold.ebi.ac.uk/entry/${esc(af.uniprotId)}" target="_blank" rel="noopener">alphafold.ebi.ac.uk →</a></figcaption>
      </figure>`
    : (input.alphafoldFigure ? `
      <figure class="af-fig">
        <img src="${input.alphafoldFigure.dataUri}" alt="AlphaFold 预测结构（pLDDT 着色）">
        <figcaption><b>AlphaFold 预测结构</b> · pLDDT 着色<br>${esc(input.alphafoldFigure.modelId)} · v${input.alphafoldFigure.version} · 平均 pLDDT ${input.alphafoldFigure.globalPlddt ?? '—'}<br><a href="https://alphafold.ebi.ac.uk/entry/${u ? u.uniprotId : ''}" target="_blank" rel="noopener">alphafold.ebi.ac.uk →</a></figcaption>
      </figure>` : '')"""
src = src.replace(old_block, new_block, 1)

# ── 4) 头部模板引用 ──
assert '\n    ${afFigureHtml}\n' in src
src = src.replace('\n    ${afFigureHtml}\n', '\n    ${afBlockHtml}\n', 1)

# ── 5) CSS：legacy img 规则收紧 + 交互视图样式 + 打印回落 ──
old_css = """  .af-fig { flex:0 0 320px; margin:0; text-align:center; align-self:flex-start; }
  .af-fig img { display:block; width:320px; max-width:100%; height:auto; border:1px solid var(--line); border-radius:6px; background:#fff; padding:4px; box-shadow:0 1px 3px rgba(28,25,23,.06); }"""
new_css = """  .af-fig { flex:0 0 320px; margin:0; text-align:center; align-self:flex-start; }
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
  @media print { .af-stage .af-canvas { display:none; } .af-stage .af-poster, .af-stage.af-live .af-poster { display:block; } }"""
assert old_css in src, 'af-fig css block not found'
src = src.replace(old_css, new_css, 1)

# 移动端：视图高度适配
old_m = "@media (max-width:720px){ .rpt-headflex{flex-direction:column} .af-fig{flex-basis:auto; width:100%; max-width:400px; margin:0 auto} }"
new_m = "@media (max-width:720px){ .rpt-headflex{flex-direction:column} .af-fig{flex-basis:auto; width:100%; max-width:400px; margin:0 auto} .af-stage,.af-poster{height:260px} }"
assert old_m in src, 'mobile media query not found'
src = src.replace(old_m, new_m, 1)

io.open(P, 'w', encoding='utf-8').write(src)
print('patched OK')
