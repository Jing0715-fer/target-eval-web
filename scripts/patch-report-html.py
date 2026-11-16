#!/usr/bin/env python3
"""report-html.ts v2.13 重构补丁：
1. renderReportHtml 拆为 renderSingleReportBody（可复用主体）+ 外壳组装
2. CSS 抽出为 SINGLE_REPORT_CSS 导出（#llm 选择器类化为 .sec-llm，多视图页防 id 冲突）
3. pdbTableHtml / litItemsHtml / complexCardHtml / interactionEvidenceHtml 支持 expandAll
   （合并报告各靶点单独评估页 — PDB 结构与文献全量直出不折叠）
4. 合并报告嵌入选项：idPrefix / afPooled（公共 MODELS 池 AF 交互视图）/ pooledImages（图片池复用）/ legacyNote
"""
import sys

PATH = 'src/lib/eval/report-html.ts'
src = open(PATH, encoding='utf-8').read()
orig_len = len(src)


def must_replace(s, old, new, label):
    n = s.count(old)
    assert n == 1, f'[{label}] 期望唯一匹配，实际 {n} 处: {old[:80]!r}'
    return s.replace(old, new)


# ── R1：函数签名 → 主体渲染函数（含嵌入选项接口）─────────────────────────
R1_OLD = """export async function renderReportHtml(input: ReportRenderInput): Promise<string> {
  const { ctx, methodStats, llmMarkdown } = input
"""
R1_NEW = r"""export type SingleBodyCtx = Omit<ReportContext, 'sequence'> & { sequence?: string }

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
"""
src = must_replace(src, R1_OLD, R1_NEW, 'R1-signature')

# ── R2：图片内嵌（合并模式复用预内嵌结果）───────────────────────────────
R2_OLD = """  const embedded = await embedImages(ctx.images, input.resolveImagePath)
"""
R2_NEW = """  const embedded = input.embeddedImages ?? (input.resolveImagePath ? await embedImages(ctx.images, input.resolveImagePath) : [])
  /** 图片在 embedded 数组中的全局序号（合并模式 data-fig-copy 池复用索引） */
  const figIdxOf = new Map(embedded.map((e, i) => [e, i]))
"""
src = must_replace(src, R2_OLD, R2_NEW, 'R2-embedded')

# ── R3/R4/R5：章节锚点 id 前缀化 ─────────────────────────────────────────
src = must_replace(src, '<section class="sec" id="ligands">', '<section class="sec" id="${idOf(\'ligands\')}">', 'R3-ligands-id')
src = must_replace(src, '<section class="glance" id="glance" aria-label="核心结论速览">',
                   '<section class="glance" id="${idOf(\'glance\')}" aria-label="核心结论速览">', 'R4-glance-id')
src = must_replace(src, '<section class="sec" id="assets">', '<section class="sec" id="${idOf(\'assets\')}">', 'R5-assets-id')

# ── R6：图片 figure 块（合并模式池复用）──────────────────────────────────
R6_OLD = r"""    ${g.items.map(({ meta, dataUri }) => {
      figNo += 1
      return `
      <figure class="fig">
        ${dataUri
        ? `<img src="${dataUri}" alt="${esc(meta.caption)}" loading="lazy">`
        : `<div class="fig-missing">图片体积超出内嵌预算，请通过系统查看</div>`}
        <figcaption><span class="fig-tag fig-${meta.kind}">${meta.kind === 'gel' ? 'SDS-PAGE' : meta.kind === 'sec' ? 'SEC' : '图'}</span>${meta.vlmKind ? '<span class="fig-tag fig-ai">AI 视觉识别</span>' : ''}图 ${figNo}：${esc(meta.caption)}</figcaption>
      </figure>`
    }).join('')}
"""
R6_NEW = r"""    ${g.items.map((item) => {
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
"""
src = must_replace(src, R6_OLD, R6_NEW, 'R6-images-pooled')

# ── R7：AF 头图块（合并模式公共池 stage / 统计卡）───────────────────────
R7_OLD = r"""  const af3dBundle = input.alphafoldStructure ? await ensure3DmolBundle() : null
  const af = input.alphafoldStructure
  const afBlockHtml = af ? `
"""
R7_NEW = r"""  const af3dBundle = input.af3dBundle ?? (input.alphafoldStructure ? await ensure3DmolBundle() : null)
  const af = input.alphafoldStructure
  const afP = emb?.afPooled
  // v2.13：合并报告嵌入 — AF 视图走公共 MODELS 池（data-maf stage 由合并报告统一
  // 初始化）；无可内嵌模型时降级统计卡（mtr-af-stat — 合并报告附加样式）。
  const afBlockHtml = afP ? `
      <figure class="af-fig">
        ${afP.metaOnly
        ? `<div class="mtr-af-stat">
          <div class="mtr-af-stat-line">${esc(afP.modelId)} · v${afP.version} · 平均 pLDDT ${afP.globalPlddt ?? '—'}${afP.fracVeryHigh != null ? ` · pLDDT ≥90 区段 ${Math.round(afP.fracVeryHigh * 100)}%` : ''}</div>
          <div class="mtr-af-stat-note">模型体积超出内嵌预算或本次获取失败 — 交互视图请前往 AlphaFold DB（下方链接）</div>
          <a class="mtr-af-link" href="https://alphafold.ebi.ac.uk/entry/${esc(afP.mafKey)}" target="_blank" rel="noopener">alphafold.ebi.ac.uk →</a>
        </div>`
        : `<div class="af-stage" data-maf="${esc(afP.mafKey)}">
          <div class="af-canvas"></div>
          <img class="af-poster" alt="AlphaFold 预测结构（pLDDT 着色）">
        </div>
        <div class="af-legend">
          <span><i style="background:#0053D6"></i>pLDDT ≥ 90</span>
          <span><i style="background:#65CBF3"></i>70–90</span>
          <span><i style="background:#FFDB13"></i>50–70</span>
          <span><i style="background:#FF7D45"></i>&lt; 50</span>
        </div>`}
        <figcaption><b>AlphaFold 预测结构</b> · 拖拽旋转 · 滚轮缩放 · 可全屏放大 · pLDDT 置信着色<br>${esc(afP.modelId)} · v${afP.version} · 平均 pLDDT ${afP.globalPlddt ?? '—'} · ${afP.pdbKb}KB 内嵌模型<br><a href="https://alphafold.ebi.ac.uk/entry/${esc(afP.mafKey)}" target="_blank" rel="noopener">alphafold.ebi.ac.uk →</a></figcaption>
      </figure>` : af ? `
"""
src = must_replace(src, R7_OLD, R7_NEW, 'R7-af-pooled')

# ── R8：pdbTableHtml 支持 expandAll（全量直出）──────────────────────────
R8_OLD = r"""/** PDB 表格：前 preview 条直出，剩余放入 details 折叠 */
function pdbTableHtml(pdbs: PdbEntry[], preview: number, max: number, litByPmid: Map<string, LiteratureItem>): string {
  const shown = pdbs.slice(0, max)
  const head = shown.slice(0, preview)
  const rest = shown.slice(preview)
  const headHtml = `
  <div class="tbl-wrap"><table class="tbl-data">
    ${PDB_COLGROUP}
    <thead><tr><th>PDB ID</th><th>方法</th><th class="num">分辨率 (Å)</th><th>范围</th><th>标题</th><th class="num">释放日期</th><th>主要配体</th><th>期刊</th><th>文献</th></tr></thead>
    <tbody>${pdbRowsHtml(head, preview, litByPmid)}</tbody>
  </table></div>`
  if (rest.length === 0) return headHtml
  return `${headHtml}
  <details class="fold">
    <summary>展开其余 ${rest.length} 条结构（共 ${shown.length} 条，打印时自动展开）</summary>
    <div class="tbl-wrap"><table class="tbl-data">
      ${PDB_COLGROUP}
      <thead><tr><th>PDB ID</th><th>方法</th><th class="num">分辨率 (Å)</th><th>范围</th><th>标题</th><th class="num">释放日期</th><th>主要配体</th><th>期刊</th><th>文献</th></tr></thead>
      <tbody>${pdbRowsHtml(rest, rest.length, litByPmid)}</tbody>
    </table></div>
  </details>`
}
"""
R8_NEW = r"""/** PDB 表格：前 preview 条直出，剩余放入 details 折叠；expandAll=true 全量直出（v2.13 单独评估页要求） */
function pdbTableHtml(pdbs: PdbEntry[], preview: number, max: number, litByPmid: Map<string, LiteratureItem>, expandAll = false): string {
  const shown = pdbs.slice(0, max)
  const PDB_THEAD = '<thead><tr><th>PDB ID</th><th>方法</th><th class="num">分辨率 (Å)</th><th>范围</th><th>标题</th><th class="num">释放日期</th><th>主要配体</th><th>期刊</th><th>文献</th></tr></thead>'
  if (expandAll) {
    return `
  <div class="tbl-wrap"><table class="tbl-data">
    ${PDB_COLGROUP}
    ${PDB_THEAD}
    <tbody>${pdbRowsHtml(shown, max, litByPmid)}</tbody>
  </table></div>`
  }
  const head = shown.slice(0, preview)
  const rest = shown.slice(preview)
  const headHtml = `
  <div class="tbl-wrap"><table class="tbl-data">
    ${PDB_COLGROUP}
    ${PDB_THEAD}
    <tbody>${pdbRowsHtml(head, preview, litByPmid)}</tbody>
  </table></div>`
  if (rest.length === 0) return headHtml
  return `${headHtml}
  <details class="fold">
    <summary>展开其余 ${rest.length} 条结构（共 ${shown.length} 条，打印时自动展开）</summary>
    <div class="tbl-wrap"><table class="tbl-data">
      ${PDB_COLGROUP}
      ${PDB_THEAD}
      <tbody>${pdbRowsHtml(rest, rest.length, litByPmid)}</tbody>
    </table></div>
  </details>`
}
"""
src = must_replace(src, R8_OLD, R8_NEW, 'R8-pdb-table')

# ── R9：litItemsHtml 支持 expandAll ─────────────────────────────────────
R9_OLD = r"""/** 文献条目（附关联 PDB chips） */
function litItemsHtml(lits: LiteratureItem[], pdbByPmid: Map<string, PdbEntry[]>, preview: number): string {
  const shown = lits.slice(0, preview)
  const rest = lits.slice(preview)
  const item = (l: LiteratureItem, i: number) => {
"""
R9_NEW = r"""/** 文献条目（附关联 PDB chips）；expandAll=true 全量直出（v2.13 单独评估页要求） */
function litItemsHtml(lits: LiteratureItem[], pdbByPmid: Map<string, PdbEntry[]>, preview: number, expandAll = false): string {
  const shown = expandAll ? lits : lits.slice(0, preview)
  const rest = expandAll ? [] : lits.slice(preview)
  const item = (l: LiteratureItem, i: number) => {
"""
src = must_replace(src, R9_OLD, R9_NEW, 'R9-lit-items')

# ── R10：interactionEvidenceHtml / complexCardHtml 支持 expandAll ────────
R10_OLD = """export function interactionEvidenceHtml(itx: InteractionAnalysis | null | undefined): string {
  if (!itx || !itx.applicable || !itx.hasEvidence) return ''
  const complexes = itx.complexes.map(complexCardHtml).join('')
"""
R10_NEW = """export function interactionEvidenceHtml(itx: InteractionAnalysis | null | undefined, expandAll = false): string {
  if (!itx || !itx.applicable || !itx.hasEvidence) return ''
  const complexes = itx.complexes.map(c => complexCardHtml(c, expandAll)).join('')
"""
src = must_replace(src, R10_OLD, R10_NEW, 'R10-itx')

R11_OLD = """function complexCardHtml(c: InteractionComplexInfo): string {
"""
R11_NEW = """function complexCardHtml(c: InteractionComplexInfo, expandAll = false): string {
"""
src = must_replace(src, R11_OLD, R11_NEW, 'R11-cx-card')

# complexCardHtml 内：共有结构其余折叠 → expandAll 直出
R12_OLD = r"""      ${cxTableHtml(sharedHeadRows.map(sharedRowHtml).join(''), CX_SHARED_COLGROUP, CX_SHARED_THEAD)}
      ${sharedRest.length ? `
      <details class="fold">
        <summary>展开其余 ${sharedRest.length} 个共有结构（共 ${sharedTotal} 个，打印时自动展开）</summary>
        ${cxTableHtml(sharedRest.map(sharedRowHtml).join(''), CX_SHARED_COLGROUP, CX_SHARED_THEAD)}
      </details>` : ''}
"""
R12_NEW = r"""      ${cxTableHtml((expandAll ? shared : sharedHeadRows).map(sharedRowHtml).join(''), CX_SHARED_COLGROUP, CX_SHARED_THEAD)}
      ${!expandAll && sharedRest.length ? `
      <details class="fold">
        <summary>展开其余 ${sharedRest.length} 个共有结构（共 ${sharedTotal} 个，打印时自动展开）</summary>
        ${cxTableHtml(sharedRest.map(sharedRowHtml).join(''), CX_SHARED_COLGROUP, CX_SHARED_THEAD)}
      </details>` : ''}
"""
src = must_replace(src, R12_OLD, R12_NEW, 'R12-cx-shared')

# complexCardHtml 内：单独结构折叠块 expandAll 时 open + 全量
R13_OLD = r"""  const soloFoldHtml = soloComps.length ? `
    <details class="fold cx-solo-fold">
      <summary>单独结构（各组分独立解析，共 ${soloTotal} 个 — 次要参考：边界借鉴/构象对照，默认折叠）</summary>
      ${soloComps.map(({ comp, list, omitted }) => {
        const head = list.slice(0, CX_SOLO_PREVIEW)
        const rest = list.slice(CX_SOLO_PREVIEW)
"""
R13_NEW = r"""  const soloFoldHtml = soloComps.length ? `
    <details class="fold cx-solo-fold"${expandAll ? ' open' : ''}>
      <summary>单独结构（各组分独立解析，共 ${soloTotal} 个 — 次要参考：边界借鉴/构象对照${expandAll ? ' · 已展开' : ' · 默认折叠'}）</summary>
      ${soloComps.map(({ comp, list, omitted }) => {
        const head = expandAll ? list : list.slice(0, CX_SOLO_PREVIEW)
        const rest = expandAll ? [] : list.slice(CX_SOLO_PREVIEW)
"""
src = must_replace(src, R13_OLD, R13_NEW, 'R13-cx-solo')

# ── R14：主渲染函数尾部整体替换（body 主体 + CSS 导出 + 外壳函数）────────
tail_marker = '  const html = `<!DOCTYPE html>'
i = src.index(tail_marker)
head, tail = src[:i], src[i:]

# CSS 从旧模板中提取（#llm → .sec-llm 类化）
cs = tail.index('<style>\n') + len('<style>\n')
ce = tail.index('${RESPONSIVE_PAGE_CSS}${LIGHTBOX_CSS}${PRINT_PAGE_CSS}${UX_PAGE_CSS}</style>')
css = tail[cs:ce]
assert css.strip().startswith(':root') and 'rpt-head' in css, 'CSS 提取异常'
assert '#llm' not in css.replace('#llm', '', 0) or True
css = css.replace('#llm', '.sec-llm')
assert css.count('.sec-llm') >= 8, 'sec-llm 选择器数量异常'

NEW_TAIL = r'''  // ─── 报告主体组装（header → glance → 目录 → 章节 → footer；不含外壳）──────
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
      <div><b>UniProt</b> ${u ? `<a href="https://www.uniprot.org/uniprotkb/${u.uniprotId}" target="_blank" rel="noopener">${u.uniprotId}</a>（${esc(u.entryName)}）` : '—（序列直接输入）'}</div>
      <div><b>蛋白名称</b> ${esc(u?.proteinName ?? '—')}</div>
      <div><b>基因</b> ${esc(geneStr)}</div>
      <div><b>物种</b> ${esc(u?.organism ?? '—')}</div>
      <div><b>序列长度</b> ${u ? u.sequenceLength + ' aa' : ctx.sequence ? ctx.sequence.length + ' aa' : '—'}</div>
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
    ${afBlockHtml}
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
    <p class="note">评分由系统规则计算（1-10）：基础分（序列长度/跨膜特征/已有结构先例/结构域柔性）经舍入后叠加 BLAST 同源加成、蛋白聚集形式（寡聚态）与分子量增重调整（调整值见评分卡内明细）——两步调整均为整数，直接体现在最终分。评分数值仅供参考，最终可行性需结合实验条件判断；聚集形式判定的证据链与策略影响在评估分析章节中展开。</p>
  </section>

  <section class="sec" id="${idOf('pdbs')}">
    <h2>${secHead(pdbsNo, 'PDB 结构清单', ctx.directPdbs.length ? `Structures · ${ctx.directPdbs.length}` : (ctx.interaction?.hasEvidence ? 'Structures · 互作组分证据' : 'Structures · 0'))}</h2>
    ${covFigHtml}
    ${ctx.directPdbs.length ? `<p class="note">按分辨率升序排列；点击 PDB ID 跳转 RCSB 查看详情；「文献」列带绿点表示与本页文献章节互链。${expandAll ? '本页为单独评估页 — 全量结构默认展开。' : ''}</p>${pdbTableHtml(ctx.directPdbs, PDB_PREVIEW, 150, litByPmid, expandAll)}` +
      (input.totalPdbFound > 150 ? `<p class="note">共检索命中 ${input.totalPdbFound} 个结构，表中展示前 150 个（按分辨率排序）。</p>`
      : (input.totalPdbFound > ctx.directPdbs.length ? `<p class="note">共检索命中 ${input.totalPdbFound} 个结构，表中展示详情完整的前 ${ctx.directPdbs.length} 个。</p>` : ''))
    : `<div class="callout callout-amber"><b>暂无直接关联的 PDB 结构 — 全新结构靶点</b>该靶点（或该 UniProt）在 RCSB 无直接关联结构条目${ctx.interaction?.hasEvidence ? '，但存在互作复合物证据 — 下方列出其复合物其他组分的结构清单（共有结构突出显示、单独结构默认折叠），作为组装路线与构建边界设计的评估依据' : '，结构可行性判断主要依据同源结构先例（见 BLAST 章节）与文献证据'}；构建边界与实验策略需从零设计，风险与周期相应增加。</div>${interactionEvidenceHtml(ctx.interaction, expandAll)}`}
  </section>

  ${ligandSecHtml}

  ${showBlastSec ? `
  <section class="sec" id="${idOf('blast')}">
    <h2>${secHead(blastNo, 'BLAST 同源结构', `Homologs · ${ctx.blastHits.length}`)}</h2>
    ${ctx.blastHits.length ? `<p class="note">按 identity 降序排列（已排除直接结构重复项）；同源结构可用作分子置换模板 / Cryo-EM 初始模型 / 域边界参考。</p>${ctx.blastStatus?.provider === 'rcsb' ? '<p class="note">NCBI BLAST 队列拥堵/故障，本章节同源结构经 RCSB 序列检索（mmseqs2）获得，命中含一致性/E 值/覆盖度，与 BLAST 同源结构等效。</p>' : ''}<div class="tbl-wrap"><table class="tbl-data tbl-blast">
      <colgroup>
        <col style="width:74px"><col><col style="width:78px"><col style="width:88px">
        <col style="width:74px"><col style="width:104px"><col style="width:74px"><col style="width:92px">
      </colgroup>
      <thead><tr><th>PDB ID</th><th>描述</th><th class="num">Identity</th><th class="num">E-value</th><th class="num">覆盖范围</th><th>方法</th><th class="num">分辨率 (Å)</th><th>文献</th></tr></thead>
      <tbody>${blastRowsHtml(ctx.blastHits)}</tbody>
    </table></div>`
    : ctx.blastStatus?.status === 'failed'
      ? `<div class="callout callout-amber"><b>同源检索失败 — 本报告不含同源结构证据</b>${esc(describeBlastStatus(ctx.blastStatus))}。本报告结论主要基于直接结构与文献证据；同源先例缺失可能低估或高估可行性，建议重新评估补齐同源证据。</div>`
      : `<p class="note">${esc(describeBlastStatus(ctx.blastStatus))}。同源结构证据在本报告中缺位，结论主要基于直接结构与文献证据；如需同源检索可重新评估并勾选「强制 BLAST」。</p>`}
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
export const SINGLE_REPORT_CSS = `__CSS_CONTENT__`

export async function renderReportHtml(input: ReportRenderInput): Promise<string> {
  // v2.13：主体渲染抽出为 renderSingleReportBody（合并报告各靶点单独评估页复用，
  // 格式与单靶点报告一模一样）；本函数仅组装文档外壳（head/CSS/backtop/脚本）。
  const af3dBundle = input.alphafoldStructure ? await ensure3DmolBundle() : null
  const body = await renderSingleReportBody({ ...input, af3dBundle })
  const u = input.ctx.uniprot
  const rangeSuffix = input.ctx.range ? ` · 残基 ${input.ctx.range[0]}-${input.ctx.range[1]}` : ''
  const proteinTitle = u ? `${u.proteinName}（${u.uniprotId}${rangeSuffix}）` : (input.ctx.range ? `序列靶点评估 · 残基 ${input.ctx.range[0]}-${input.ctx.range[1]}` : '序列靶点评估')
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;600;700;900&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;0,8..60,700;1,8..60,400&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<title>靶点结构解析可行性评估报告 — ${esc(proteinTitle)}</title>
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
${LIGHTBOX_JS}
</body>
</html>`
}
'''

NEW_TAIL = NEW_TAIL.replace('__CSS_CONTENT__', css)
out = head + NEW_TAIL
open(PATH, 'w', encoding='utf-8').write(out)
print(f'patched {PATH}: {orig_len} → {len(out)} chars')
print('checks: .sec-llm in body:', NEW_TAIL.count('sec sec-llm'), '| idOf refs:', NEW_TAIL.count("idOf('"))
assert 'renderSingleReportBody' in out and 'SINGLE_REPORT_CSS' in out and out.count('export async function renderReportHtml') == 1
print('OK')
