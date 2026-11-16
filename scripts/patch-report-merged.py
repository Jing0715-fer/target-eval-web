#!/usr/bin/env python3
"""report-merged.ts v2.13 重写补丁：
1. 首页（复合物评估）标题格式/字体同步单独评估：CSS 全量换用 SINGLE_REPORT_CSS
   （单靶点报告同源同版 — JetBrains Mono / 标题 28px·900 / meta-grid / badge 同款），
   刊头改为 eyebrow+大标题+副标+meta-grid+badges（批次附加：rel-box + 靶点卡片）
2. 各靶点单独评估页：v2.9「简报卡」退役 — 直接复用 renderSingleReportBody 渲染完整
   单靶点格式报告（header/glance/目录/评估分析/评分/PDB/配体/同源/文献/客户实验数据），
   PDB 结构与文献全量展开（expandAll），AF 走公共 MODELS 池，图片走首页池复用
3. loadMergedTargets 补 reportMarkdown / coverage / interaction / entryName
   （pipeline v2.13 起批次各靶点按单靶点流程生成完整独立报告并持久化）
"""
import sys

PATH = 'src/lib/eval/report-merged.ts'
src = open(PATH, encoding='utf-8').read()
orig_len = len(src)


def rep(s, old, new, label, count=1):
    n = s.count(old)
    assert n == count, f'[{label}] 期望 {count} 处，实际 {n} 处: {old[:70]!r}'
    return s.replace(old, new)


def cut(s, start_marker, end_marker, replacement, label):
    i0 = s.index(start_marker)
    i1 = s.index(end_marker, i0)
    out = s[:i0] + replacement + s[i1:]
    print(f'[{label}] 删除 {i1 - i0} 字符 → 插入 {len(replacement)} 字符')
    return out


# ── M1：imports ───────────────────────────────────────────────────────────
src = rep(src,
          "import { esc, renderMarkdown, strategyZh, ligDetailProps, ligStructFig, ligIdentFold, RESPONSIVE_PAGE_CSS, LIGHTBOX_CSS, LIGHTBOX_JS, PRINT_PAGE_CSS, UX_PAGE_CSS, UX_PAGE_JS } from './report-html'",
          "import { esc, renderMarkdown, strategyZh, ligDetailProps, ligStructFig, ligIdentFold, RESPONSIVE_PAGE_CSS, LIGHTBOX_CSS, LIGHTBOX_JS, PRINT_PAGE_CSS, UX_PAGE_CSS, UX_PAGE_JS, SINGLE_REPORT_CSS, renderSingleReportBody, type SingleBodyCtx } from './report-html'",
          'M1-import-html')
src = rep(src,
          "import { describeRelationType, describeBlastStatus, type AlphafoldSummaryInfo, type BlastHit, type BlastStatusInfo, type ConstructInfo, type FormInsights, type HomologPair, type LiteratureItem, type MethodStats, type MwAugmentAnalysis, type OligomerAnalysis, type ParsedImage, type PdbEntry, type RelationJudgment, type Scores, type SequenceAttribution, type SharedStructure } from './types'",
          "import { describeRelationType, describeBlastStatus, type AlphafoldSummaryInfo, type BlastHit, type BlastStatusInfo, type ConstructInfo, type FormInsights, type HomologPair, type LiteratureItem, type MethodStats, type MwAugmentAnalysis, type OligomerAnalysis, type ParsedImage, type PdbEntry, type PdbeCoverageResult, type InteractionAnalysis, type RelationJudgment, type Scores, type SequenceAttribution, type SequenceComparison, type SharedStructure } from './types'",
          'M1-import-types')

# ── M2：MergedTargetData 补字段 ───────────────────────────────────────────
src = rep(src,
          """  scores: Scores
  methodStats: MethodStats""",
          """  scores: Scores & { rationale: { xray: string; cryoem: string; nmr: string; overall: string } }
  methodStats: MethodStats""",
          'M2-scores-type')
src = rep(src,
          """  /** v2.9：AlphaFold 预测结构信息（v2.0+ 作业存于摘要；旧作业在渲染时按需补齐） */
  alphafold?: AlphafoldSummaryInfo
}""",
          """  /** v2.9：AlphaFold 预测结构信息（v2.0+ 作业存于摘要；旧作业在渲染时按需补齐） */
  alphafold?: AlphafoldSummaryInfo
  /** v2.13：该靶点独立 LLM 报告全文（批次评估时按单靶点流程生成并持久化；
   *  旧批次作业无此字段 — 单独评估页回退合并报告的各靶点综述） */
  reportMarkdown?: string | null
  /** v2.13：结构覆盖率完整结果（含覆盖区间 — 单独评估页覆盖率区段图用；旧作业缺省） */
  coverage?: PdbeCoverageResult | null
  /** v2.13：互作复合物证据分析（无直接结构靶点的单独评估页互作结构清单用） */
  interaction?: InteractionAnalysis | null
  /** UniProt 条目名（单独评估页 meta-grid 展示） */
  entryName?: string
}""",
          'M2-target-fields')

# ── M3：loadMergedTargets 提取新字段 ─────────────────────────────────────
old_summary_type = """      uniprot?: { uniprotId: string; proteinName: string; geneNames: string[]; organism: string; sequenceLength: number }
      scores?: Scores; methodStats?: MethodStats; coverage?: number; ligandCount?: number; literatureCount?: number
      blast?: BlastStatusInfo; construct?: ConstructInfo; durationMs?: number; coverageText?: string; gapText?: string
      oligomer?: OligomerAnalysis
  ligands?: LigandResolution[]
      mwAugment?: MwAugmentAnalysis | null
      alphafold?: AlphafoldSummaryInfo
    } | null = null"""
new_summary_type = """      uniprot?: { uniprotId: string; entryName?: string; proteinName: string; geneNames: string[]; organism: string; sequenceLength: number }
      scores?: Scores & { rationale: { xray: string; cryoem: string; nmr: string; overall: string } }
      methodStats?: MethodStats; coverage?: number; ligandCount?: number; literatureCount?: number
      blast?: BlastStatusInfo; construct?: ConstructInfo; durationMs?: number; coverageText?: string; gapText?: string
      oligomer?: OligomerAnalysis
      ligands?: LigandResolution[]
      mwAugment?: MwAugmentAnalysis | null
      alphafold?: AlphafoldSummaryInfo
      interaction?: InteractionAnalysis | null
      coveredRanges?: Array<[number, number]>
    } | null = null"""
src = rep(src, old_summary_type, new_summary_type, 'M3-summary-type')

src = rep(src,
          """      oligomer: summary.oligomer,
      ligands: summary.ligands,
      mwAugment: summary.mwAugment ?? null,
      alphafold: summary.alphafold,
    })""",
          """      oligomer: summary.oligomer,
      ligands: summary.ligands,
      mwAugment: summary.mwAugment ?? null,
      alphafold: summary.alphafold,
      // v2.13：单独评估页所需 — 独立 LLM 报告 / 覆盖区间 / 互作证据 / 条目名
      reportMarkdown: job.reportMarkdown,
      coverage: summary.coveredRanges
        ? { coveragePercent: summary.coverage ?? 0, coveredRanges: summary.coveredRanges, mappings: [] }
        : null,
      interaction: summary.interaction ?? null,
      entryName: summary.uniprot?.entryName,
    })""",
          'M3-push-fields')

# ── M4：移除 anchorOf / afWarn ───────────────────────────────────────────
src = rep(src,
          """  // v2.11：各靶点结构/同源/文献明细一律默认折叠（避免过多次要信息干扰阅读；
  // 打印时自动展开）— 阅读动线：批次级（分析 + 共有结构）→ 靶点简报 → 需要时展开明细
  // 每靶点锚点：目录「靶点速览」直达对应结构折叠块
  const anchorOf = (t: MergedTargetData) => `struct-${(t.uniprotId ?? t.label).replace(/[^A-Za-z0-9]/g, '')}`
""",
          """  // v2.13：各靶点 PDB/同源/文献明细不再以折叠块形式集中首页 — 单独评估页内
  // 按单靶点报告格式全量展开（expandAll）。
""",
          'M4-anchorOf')

src = rep(src,
          """  // v2.12：预算警告按靶点分组（随简报卡展示，不再集中首页 — 独立页内直接对应）
  const afBudgetWarnsBy = new Map<string, string[]>()
  const afWarn = (key: string, msg: string) => { const list = afBudgetWarnsBy.get(key) ?? []; list.push(msg); afBudgetWarnsBy.set(key, list) }
""",
          "",
          'M4-afWarn-def')

src = rep(src,
          """      if (!st.embeddable) {
        afWarn(t.uniprotId, `模型过大（${Math.round(st.pdbText.length / 1024)}KB > 单模型 2560KB 上限）`)
        return
      }
      if (st.pdbText.length > afBudgetLeft) {
        afWarn(t.uniprotId, `超出批次内嵌总预算（剩余 ${Math.round(afBudgetLeft / 1024)}KB）`)
        return
      }""",
          """      if (!st.embeddable) return
      if (st.pdbText.length > afBudgetLeft) return""",
          'M4-afWarn-calls')

# ── M5：删除 mtrCardOf 简报块（targetKeyOf 保留）─────────────────────────
src = cut(src,
          '  // ── v2.9：各靶点单独报告（简报卡 — 基本信息 + 预测结构）──',
          '  // 3Dmol bundle 一次内嵌 + 多视图初始化',
          """  // ── v2.13：各靶点单独评估页 — 直接渲染完整单靶点报告主体 ───────────────
  // v2.9「简报卡」退役：每靶点页复用 renderSingleReportBody（单靶点报告同款
  // header/glance/目录/评估分析/评分卡/PDB 结构/同源/文献/客户实验数据），
  // PDB 结构与文献全量展开（expandAll）；AF 视图走公共 MODELS 池，图片走首页池。
  const targetKeyOf = (t: MergedTargetData) => (t.uniprotId ?? t.label).replace(/[^A-Za-z0-9]/g, '')

""",
          'M5-mtrCard-removed')

# ── M6：删除每靶点 PDB/同源/文献折叠块（pdbFoldOf/blastFoldOf/litFoldOf）──
src = cut(src,
          '  // v2.11：每靶点折叠块带锚点 · 默认折叠',
          '  const figHtml = embedded.length ?',
          '',
          'M6-folds-removed')

# ── M7：figHtml 单靶点同款分组 + data-fig 池索引 ─────────────────────────
old_fig = """  const figHtml = embedded.length ? `
  <section class="sec" id="assets">
    <h2>${secHead(noAssets, `客户实验数据（${embedded.length} 张）`, 'Experimental Data')}</h2>
    ${embedded.map(({ meta, dataUri }) => `
    <figure class="fig">
      <img src="${dataUri}" alt="${esc(meta.caption)}" loading="lazy">
      <figcaption><span class="fig-tag fig-${meta.kind}">${meta.kind === 'gel' ? 'SDS-PAGE' : meta.kind === 'sec' ? 'SEC' : '图'}</span>${meta.vlmKind ? '<span class="fig-tag fig-ai">AI 视觉识别</span>' : ''}${esc(meta.caption)}</figcaption>
    </figure>`).join('')}
  </section>` : ''"""
new_fig = """  // v2.13：客户实验数据分组展示（与单靶点报告同版 — gel/sec/other 分组）；图片带
  // data-fig 池索引，各靶点单独评估页的同章节经水合脚本复用同一份内嵌数据。
  const figGroupDefs: Array<{ kind: 'gel' | 'sec' | 'other'; title: string; en: string }> = [
    { kind: 'gel', title: 'SDS-PAGE 胶图', en: 'SDS-PAGE' },
    { kind: 'sec', title: 'SEC 分子筛色谱图', en: 'SEC Profile' },
    { kind: 'other', title: '其他实验图', en: 'Others' },
  ]
  const vlmCount = embedded.filter(e => e.meta.vlmKind).length
  const figIdxOf = new Map(embedded.map((e, i) => [e, i]))
  const figGroups = figGroupDefs
    .map(g => ({ ...g, items: embedded.filter(e => e.meta.kind === g.kind) }))
    .filter(g => g.items.length > 0)
  let homeFigNo = 0
  const figHtml = embedded.length ? `
  <section class="sec" id="assets">
    <h2>${secHead(noAssets, `客户实验数据（${embedded.length} 张）`, `${figGroups.map(g => `${g.en} × ${g.items.length}`).join(' · ')}${vlmCount ? ' · AI 识别' : ''}`)}</h2>
    ${figGroups.map(g => `
    <h3 class="fig-group">${g.title}<span class="fig-group-count">${g.items.length} 张</span></h3>
    <div class="fig-grid">
    ${g.items.map((item) => {
      const { meta, dataUri } = item
      homeFigNo += 1
      const figIdx = figIdxOf.get(item) ?? -1
      return `
      <figure class="fig" data-fig="${figIdx}">
        ${dataUri ? `<img src="${dataUri}" alt="${esc(meta.caption)}" loading="lazy">` : `<div class="fig-missing">图片体积超出内嵌预算，请通过系统查看</div>`}
        <figcaption><span class="fig-tag fig-${meta.kind}">${meta.kind === 'gel' ? 'SDS-PAGE' : meta.kind === 'sec' ? 'SEC' : '图'}</span>${meta.vlmKind ? '<span class="fig-tag fig-ai">AI 视觉识别</span>' : ''}图 ${homeFigNo}：${esc(meta.caption)}</figcaption>
      </figure>`
    }).join('')}
    </div>`).join('')}
    <p class="note">客户实验数据为批次共享 — 各靶点单独评估页的「客户实验数据」章节展示同一组图（图片池复用，全批次只内嵌一次）。</p>
  </section>` : ''"""
src = rep(src, old_fig, new_fig, 'M7-figHtml')

# ── M8：配体 2D 兜底充实覆盖全部靶点 ─────────────────────────────────────
src = rep(src,
          """  await Promise.all(batchLigands.filter(l => l.ok).map(async l => {
    try { await ensureLigand2dVector(l) } catch { /* 充实失败不阻塞渲染（保留既有字段） */ }
  }))""",
          """  // v2.13：各靶点单独评估页均渲染各自配体章节 — 兜底充实覆盖全部靶点的配体
  // （同一批次输入一致，缓存命中时零网络开销）
  await Promise.all(targets.flatMap(t => (t.ligands ?? []).filter(l => l.ok)).map(async l => {
    try { await ensureLigand2dVector(l) } catch { /* 充实失败不阻塞渲染（保留既有字段） */ }
  }))""",
          'M8-ligand-ensure')

# ── M9：glance-foot 阅读路径文案 ─────────────────────────────────────────
src = rep(src,
          """    <div class="glance-foot">阅读路径：本页（复合物评估）先读「${noLlm} 合并评估分析」与「${noShared} 共有结构」（复合物级结论与共同结构证据/文献）→ 点击刊头靶点卡片或目录「靶点单独报告」进入各靶点单独报告页（结构可行性综述 + 基本信息 + 预测结构 + 该靶点 PDB/同源/文献同页），页内「返回报告首页」随时回到本页；打印时全部页面依序输出。</div>""",
          """    <div class="glance-foot">阅读路径：本页（复合物评估）先读「${noLlm} 合并评估分析」与「${noShared} 共有结构」（复合物级结论与共同结构证据/文献）→ 点击刊头靶点卡片或目录「靶点单独报告」进入各靶点单独评估报告页（与单靶点评估报告同格式：评估分析 / 可行性评分 / PDB 结构与文献全量展开 / 同源 / 客户实验数据），页内「← 返回报告首页」随时回到本页；打印时全部页面依序输出。</div>""",
          'M9-glance-foot')

# ── M10：靶点视图页重写（完整单靶点格式报告）────────────────────────────
NEW_TARGET_VIEWS = r'''  // ── v2.13 ②：各靶点单独评估报告视图页 ─────────────────────────────────────
  // 每个靶点一个完整「单独评估报告」页：直接复用 renderSingleReportBody（单靶点报告
  // 同款 header + glance + 目录 + 评估分析/评分/配体/PDB/同源/文献/客户实验数据），
  // PDB 结构与文献全量展开（expandAll）；页首「← 返回报告首页」+ 页脚上一/下一靶点
  // 导航；hash 深链 #view-target-<ID> 直达；打印时所有视图依序输出、靶点页另起一页。
  // LLM 章节来源：v2.13 起批次各靶点按单靶点流程生成完整独立报告（reportMarkdown，
  // pipeline 不再因复合物组分跳过单独评估）；旧批次回退合并报告的各靶点综述。
  const engineStr = input.engineSummary || '—'
  const relConfZh = relation.confidence === 'high' ? '高' : relation.confidence === 'medium' ? '中' : '低'
  const targetViews = (await Promise.all(targets.map(async (t, i) => {
    const key = targetKeyOf(t)
    const prev = i > 0 ? targets[i - 1] : null
    const next = i < targets.length - 1 ? targets[i + 1] : null
    // AF 交互视图（公共 MODELS 池）：本次获取的可内嵌模型 > 作业摘要元数据（降级统计卡）
    const view = t.uniprotId ? afViews.get(t.uniprotId) : undefined
    const afSummary = (t.alphafold?.available ? t.alphafold : (t.uniprotId ? afMetaFill.get(t.uniprotId) : undefined)) ?? t.alphafold
    const afPooled = view && t.uniprotId
      ? { mafKey: t.uniprotId, modelId: view.modelId, version: view.version, globalPlddt: view.globalPlddt, fracVeryHigh: view.fracVeryHigh, pdbKb: Math.max(1, Math.round(view.pdbText.length / 1024)) }
      : afSummary?.available && t.uniprotId
        ? { mafKey: t.uniprotId, modelId: afSummary.modelId ?? 'AF 模型', version: afSummary.version ?? 1, globalPlddt: afSummary.globalPlddt ?? null, fracVeryHigh: afSummary.fracVeryHigh ?? null, pdbKb: 0, metaOnly: true }
        : undefined
    // LLM 章节来源：独立报告（新批次）→ 合并综述（旧批次回退）→ 说明占位
    const ownMd = t.reportMarkdown?.trim() || ''
    const reviewMd = reviewByTarget.get(t.uniprotId ?? t.label) || ''
    const legacyNote = ownMd
      ? undefined
      : reviewMd
        ? '本页由历史批次数据重渲染：该批次评估时各靶点报告并入合并评估（当时未按单靶点流程生成独立报告）— 以下「评估分析」为合并报告中的该靶点综述，其余章节为该靶点确定性数据；如需完整独立评估报告可对该批次重新评估。'
        : input.llmOk
          ? '该靶点的评估分析章节未能生成或归属（LLM 小节缺失）— 批次级完整分析见报告首页「合并评估分析」章节。'
          : 'LLM 分析生成失败 — 以下为系统收集的确定性数据区块（评分 / PDB / 同源 / 文献 / 客户实验数据）。'
    // 单靶点报告上下文（该靶点作业数据 + 批次共享评估表/图片/关系说明）
    const ctx: SingleBodyCtx = {
      uniprot: t.uniprotId ? {
        uniprotId: t.uniprotId, entryName: t.entryName ?? '', proteinName: t.proteinName,
        geneNames: t.geneNames, organism: t.organism, sequenceLength: t.sequenceLength, sequence: '',
      } : null,
      sequence: '',
      goal: input.goal,
      goalHints: [],
      insights: input.insights ?? undefined,
      batchNote: `关联靶点批次 · ${relName}（置信度${relConfZh}）— 本页为该靶点的单独评估报告，批次级分析与共有结构见报告首页`,
      providedSequence: t.construct ? { sequence: '', comparison: t.construct as unknown as SequenceComparison } : undefined,
      directPdbs: t.directPdbs,
      blastHits: t.blastHits,
      blastStatus: t.blastStatus,
      coverage: t.coverage ?? null,
      coverageText: t.coverageText ?? '',
      gapText: t.gapText ?? '',
      literature: t.literature,
      images: input.images,
      scores: t.scores,
      oligomer: t.oligomer,
      ligands: t.ligands,
      alphafold: t.alphafold,
      mwAugment: t.mwAugment ?? undefined,
      interaction: t.interaction ?? undefined,
    }
    const body = await renderSingleReportBody({
      ctx,
      methodStats: t.methodStats,
      llmMarkdown: ownMd || reviewMd,
      llmOk: Boolean(ownMd || reviewMd) || input.llmOk,
      llmErrors: (ownMd || reviewMd) ? [] : input.llmErrors,
      jobId: t.jobId,
      durationMs: t.durationMs,
      totalPdbFound: t.directPdbs.length,
      engineSummary: engineStr,
      embeddedImages: embedded,
      embed: { idPrefix: key, expandAll: true, afPooled, pooledImages: true, legacyNote },
    })
    const navChip = (tgt: MergedTargetData | null, dir: 'prev' | 'next') => tgt
      ? `<a class="tgt-nav-chip" data-goto="target-${targetKeyOf(tgt)}" href="#view-target-${targetKeyOf(tgt)}" title="${esc(tgt.proteinName)}（${esc(tgt.uniprotId ?? tgt.label)}）">${dir === 'prev' ? '← ' : ''}${esc(tgt.uniprotId ?? tgt.label)}${dir === 'next' ? ' →' : ''}</a>`
      : ''
    return `
  <div class="rpt-view" id="view-target-${key}">
    <div class="tgt-topbar">
      <button type="button" class="tgt-back" data-goto="home">← 返回报告首页</button>
      <span class="tgt-topbar-tag">TargetEval · Per-Target Report · 靶点单独报告 ${i + 1}/${targets.length}</span>
    </div>
${body}
    <div class="tgt-page-foot">
      <button type="button" class="tgt-back" data-goto="home">← 返回报告首页</button>
      <div class="tgt-page-nav">
        ${navChip(prev, 'prev')}
        <span class="tgt-nav-pos">${i + 1} / ${targets.length}</span>
        ${navChip(next, 'next')}
      </div>
    </div>
  </div>`
  }))).join(''

'''
src = cut(src,
          '  // ── v2.12 ②：各靶点单独报告视图页 ──',
          '  // v2.12：视图切换脚本（首页 ↔ 各靶点单独报告页）— hash 深链 + 打印全展开；',
          NEW_TARGET_VIEWS,
          'M10-targetViews')

# ── M11：CSS 全量替换（单靶点同源 + 合并附加）───────────────────────────
ADDITIONS = r'''
  /* ── v2.13 合并报告附加（基础样式 = 单靶点报告 SINGLE_REPORT_CSS 同源同版：
        字体/标题/章节/表格/评分卡/文献/配体卡全部与单独评估一模一样）──────── */
  /* 视图分层（首页 = 复合物评估；每靶点单独评估页独立视图） */
  .rpt-view { display:none; }
  .rpt-view.rpt-view-on { display:block; }
  @media print {
    .rpt-view { display:block !important; }
    .rpt-view + .rpt-view { break-before:page; }
    .tgt-back, .tgt-open, .tgt-page-nav, .tgt-nav-pos, .tgt-topbar { display:none !important; }
  }
  .rpt-print-all .rpt-view { display:block !important; }
  /* 关系说明盒 + 靶点卡片网格（批次附加 — 点击进入该靶点单独评估页） */
  .rel-box { background:#ecfdf5; border:1px solid #a7f3d0; border-left:4px solid var(--accent); border-radius:5px; padding:14px 18px; margin:14px 0 4px; font-size:13px; color:#064e3b; line-height:1.9; }
  .rel-box b { color:#064e3b; }
  .tgt-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); gap:10px; margin:14px 0; }
  .tgt-card { border:1px solid var(--line); border-radius:5px; padding:12px 14px; background:#fff; cursor:pointer; transition:border-color .15s, box-shadow .15s; }
  .tgt-card:hover { border-color:#a7f3d0; box-shadow:0 2px 10px rgba(4,120,87,.10); }
  .tgt-name { font-weight:600; font-size:14px; color:var(--ink); } .tgt-name a { color:var(--accent-2); text-decoration:none; }
  .tgt-meta { font-size:11.5px; color:var(--sub); margin-top:3px; }
  .tgt-score { font-size:12px; color:var(--accent-2); margin-top:5px; }
  .tgt-open { margin-top:7px; padding-top:7px; border-top:1px dashed var(--line); font-family:var(--mono); font-size:10.5px; font-weight:600; letter-spacing:.5px; color:var(--accent-2); }
  .tgt-card:hover .tgt-open { color:#047857; }
  .tgt-stats { display:flex; flex-wrap:wrap; gap:4px 12px; margin-top:6px; padding-top:6px; border-top:1px dashed var(--line); font-size:10.5px; color:var(--sub); font-variant-numeric:tabular-nums; }
  .tgt-stats b { color:var(--ink); font-weight:600; }
  .tgt-oligo { display:flex; flex-wrap:wrap; align-items:center; gap:6px; margin-top:5px; }
  .tgt-oligo .oligo-badge { font-size:10px; padding:1px 8px; }
  .tgt-oligo .oligo-stoich { font-size:10px; padding:0 7px; }
  .tgt-oligo-conf { font-size:10.5px; color:var(--sub); }
  .tgt-oligo-adj { margin-left:6px; font-size:10px; color:#047857; border:1px solid #a7f3d0; border-radius:99px; padding:0 7px; background:#ecfdf5; white-space:nowrap; }
  /* 目录：共有结构条目突出 + 靶点速览导航 */
  .toc-shared { color:#065f46; font-weight:700; }
  .toc-shared::before { content:'◈ '; color:var(--accent-2); }
  .toc-targets { margin-top:10px; padding-top:10px; border-top:1px dashed var(--line); display:flex; flex-wrap:wrap; align-items:center; gap:6px 8px; }
  .toc-targets b { font-size:11px; }
  .toc-targets a { font-family:var(--mono); font-size:11px; color:var(--accent-2); background:var(--accent-bg); border:1px solid #c7ece0; border-radius:3px; padding:1px 9px; text-decoration:none; white-space:nowrap; }
  .toc-targets a:hover { background:#d9f5e8; }
  /* 靶点单独评估页：顶部返回条 + 底部导航 */
  .tgt-topbar { display:flex; flex-wrap:wrap; align-items:center; gap:10px 14px; margin-bottom:20px; }
  .tgt-topbar-tag { font-family:var(--mono); font-size:10px; letter-spacing:1.8px; text-transform:uppercase; color:var(--faint); font-weight:600; }
  .tgt-back { display:inline-flex; align-items:center; gap:5px; font-family:var(--mono); font-size:11px; font-weight:600; letter-spacing:.5px; color:var(--accent-2); background:var(--accent-bg); border:1px solid #c7ece0; border-radius:5px; padding:5px 13px; cursor:pointer; }
  .tgt-back:hover { background:#d9f5e8; color:#047857; }
  .tgt-page-foot { margin-top:34px; padding-top:16px; border-top:1px solid var(--line); display:flex; flex-wrap:wrap; align-items:center; gap:10px 12px; }
  .tgt-page-nav { margin-left:auto; display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
  .tgt-nav-chip { font-family:var(--mono); font-size:11px; font-weight:600; color:var(--accent-2); background:var(--accent-bg); border:1px solid #c7ece0; border-radius:3px; padding:1px 9px; text-decoration:none; white-space:nowrap; }
  .tgt-nav-chip:hover { background:#d9f5e8; }
  .tgt-nav-pos { font-family:var(--mono); font-size:11px; color:var(--faint); }
  /* 序列一致性矩阵（表头/行标/数值全部居中 — 列内容与表头严格对齐） */
  table.idm { margin:12px auto; max-width:100%; }
  table.idm thead th { text-align:center; }
  table.idm tbody th { font-family:var(--mono); font-size:12px; font-weight:600; color:var(--ink); background:#fafaf8; text-transform:none; letter-spacing:0; padding:6px 10px; border-bottom:1px solid var(--line); white-space:nowrap; }
  table.idm th, table.idm td, table.idm td.num { text-align:center; }
  table.idm td.num { font-size:12.5px; }
  table.idm .idm-corner { font-size:10px; color:var(--faint); letter-spacing:1px; }
  table.idm .idm-diag { background:#f7f7f5; color:var(--faint); }
  table.idm .idm-val { font-weight:600; }
  /* 共有结构面板（绿色突出） */
  .sh-hero { background:var(--accent-bg); border:1px solid #a7f3d0; border-left:4px solid var(--accent); border-radius:6px; padding:14px 18px; margin:0 0 12px; }
  .sh-hero-head { display:flex; flex-wrap:wrap; align-items:baseline; gap:6px 10px; font-size:15px; color:#064e3b; }
  .sh-hero-head b { font-size:18px; font-weight:800; }
  .sh-ico { color:var(--accent); font-size:16px; }
  .sh-hero-sub { flex-basis:100%; font-size:12px; color:#047857; line-height:1.8; }
  .sh-hero-sub b { font-size:12px; font-weight:700; }
  .sh-cov-sum { display:flex; flex-wrap:wrap; gap:6px; margin-top:10px; padding-top:10px; border-top:1px dashed #a7f3d0; }
  .sh-cov-chip { display:inline-flex; align-items:baseline; gap:5px; font-family:var(--mono); font-size:11px; padding:2px 9px; border-radius:3px; background:#fff; border:1px solid #a7f3d0; color:#065f46; white-space:nowrap; }
  .sh-cov-chip i { font-style:normal; font-weight:700; color:var(--accent); }
  .sh-cnt { display:inline-block; font-family:var(--mono); font-size:10.5px; font-weight:700; color:#065f46; background:#ecfdf5; border:1px solid #a7f3d0; border-radius:3px; padding:1px 5px; margin-right:4px; }
  .sh-mark { color:var(--accent); font-size:13px; margin-right:3px; }
  .sh-sum { font-weight:600; font-size:12px; color:#065f46; }
  .cov-cells { max-width:260px; }
  .cov-chip { display:inline-block; font-family:var(--mono); font-size:10px; line-height:1.6; padding:1px 6px; margin:1px 2px 1px 0; border-radius:3px; background:#ecfdf5; border:1px solid #a7f3d0; color:#065f46; white-space:nowrap; }
  .cov-rng { display:inline-block; margin-left:3px; padding:0 3px; border-radius:2px; background:#f0fdf4; color:#047857; font-size:9.5px; }
  /* 对比矩阵扩列（评级副文本 + 占位） */
  .mtx-rating { display:block; font-size:10px; color:var(--sub); font-weight:400; line-height:1.4; }
  .mtx-dash { color:var(--faint); }
  /* 评估表问题回应卡 */
  .qa-ans { margin:7px 0 3px; padding:9px 14px 7px; background:#ecfdf5; border:1px solid #a7f3d0; border-left:3px solid var(--accent); border-radius:4px; font-size:13px; line-height:1.9; text-align:justify; }
  .qa-ans .qa-tag { display:inline-block; font-family:var(--mono); font-size:9.5px; font-weight:700; letter-spacing:1.5px; color:#047857; text-transform:uppercase; margin-bottom:4px; }
  .qa-ans .qa-tag-q { color:#065f46; }
  .qa-ans p { font-size:13px; margin:4px 0; }
  .qa-ans ul { margin:4px 0 4px 18px; font-size:12.5px; } .qa-ans li { margin:2px 0; }
  .qa-ans blockquote { margin:6px 0; font-size:12px; }
  .qa-ans table { font-size:11.5px; } .qa-ans th, .qa-ans td { padding:4px 8px; }
  @media print { .qa-ans { break-inside:avoid-page; } }
  /* AF 统计降级卡（合并嵌入模式 — 模型超预算/获取失败时头部右栏） */
  .mtr-af-stat { display:flex; flex-direction:column; gap:6px; border:1px solid var(--line); border-radius:5px; background:#fdfdfc; padding:12px 14px; }
  .mtr-af-stat-line { font-family:var(--mono); font-size:11px; color:var(--ink); line-height:1.8; }
  .mtr-af-stat-note { font-size:11px; color:var(--sub); line-height:1.7; }
  .mtr-af-link { font-family:var(--mono); font-size:11px; color:var(--accent-2); text-decoration:none; }
  /* glance 共有结构 tile 突出（批次附加） */
  .glance-tile.gt-shared { background:var(--accent-bg); }
  .glance-tile.gt-shared .gt-value { color:#065f46; }
  /* 聚集形式证据链行（首页矩阵下折叠内） */
  .oligo-ev { margin:8px 0 0; border-top:1px dashed var(--line); padding-top:8px; }
  .oligo-ev-line { display:flex; gap:10px; font-size:12px; padding:3px 0; align-items:baseline; flex-wrap:wrap; }
  .oligo-ev-src { flex:0 0 158px; color:#065f46; white-space:nowrap; }
  .oligo-ev-ref { flex:0 0 120px; font-family:var(--mono); font-size:11px; color:var(--sub); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .oligo-ev-text { flex:1; min-width:120px; color:var(--sub); }
  .oligo-notes { margin:8px 0 2px 20px; font-size:12.5px; color:var(--sub); }
  .oligo-notes li { margin:3px 0; }
'''
i_style = src.index('<style>\n')
i_css_end = src.index('${RESPONSIVE_PAGE_CSS}${LIGHTBOX_CSS}${PRINT_PAGE_CSS}${UX_PAGE_CSS}</style>')
new_style = '<style>\n${SINGLE_REPORT_CSS}\n' + ADDITIONS + '\n'
src = src[:i_style] + new_style + src[i_css_end:]

# ── M12：首页刊头（标题/字体/版式同步单独评估）──────────────────────────
old_home_head = """  <div class="rpt-view rpt-view-on" id="view-home">
  <header class="rpt-head">
    <div class="rpt-eyebrow">TargetEval · Merged Structure Feasibility Report</div>
    <h1 class="rpt-title">${esc(reportTitle)}</h1>
    <div class="rpt-subtitle">${esc(targets.map(t => t.proteinName).join(' · '))}</div>
    <div class="rel-box">
      <b>靶点关系：${esc(relName)}</b>（置信度：${relation.confidence === 'high' ? '高' : relation.confidence === 'medium' ? '中' : '低'}）<br>
      ${esc(relation.rationale)}<br>
      <b>策略要点：</b>${esc(relation.strategy)}
    </div>
    <div class="tgt-grid">${targetMeta}</div>
    <div class="meta-line">
      靶点 ${targets.length} 个 · PDB 结构合计 ${targets.reduce((s, t) => s + t.directPdbs.length, 0)} 个 ·
      同源结构合计 ${targets.reduce((s, t) => s + t.blastHits.length, 0)} 个 · 文献合计 ${litTotal} 篇 ·
      报告编号 ${esc(input.batchReportId.slice(0, 10))} · ${dateStr}
      ${input.goal ? `<br>客户目标：${esc(input.goal.slice(0, 160))}` : ''}
    </div>
    <div>
      <span class="badge">${esc(relName)}</span>
      <span class="badge">数据源：UniProt · RCSB · PDBe${targets.some(t => t.blastHits.length > 0) ? (targets.some(t => t.blastStatus?.provider === 'rcsb') ? ' · 序列检索（RCSB 兜底）' : ' · BLAST') : ''}</span>
      ${input.llmOk ? '<span class="badge">LLM 分析：已完成</span>' : '<span class="badge amber">LLM 分析：失败（见警示）</span>'}
    </div>
  </header>"""
new_home_head = """  <div class="rpt-view rpt-view-on" id="view-home">
  <header class="rpt-head">
    <div class="rpt-eyebrow">TargetEval · Merged Structure Feasibility Report</div>
    <h1 class="rpt-title">${esc(reportTitle)}</h1>
    <div class="rpt-subtitle">${esc(targets.map(t => t.proteinName).join(' · '))}</div>
    <div class="meta-grid">
      <div><b>靶点数</b> ${targets.length} 个（${esc(relName)} · 置信度${relation.confidence === 'high' ? '高' : relation.confidence === 'medium' ? '中' : '低'}）</div>
      <div><b>PDB 结构合计</b> ${pdbTotal} 个${bestRes != null ? ` · 最佳 ${bestRes.toFixed(2)}Å` : ''}（X-ray ${msAgg.xray} · Cryo-EM ${msAgg.cryoem} · NMR ${msAgg.nmr}）</div>
      <div><b>同源结构合计</b> ${blastTotal} 个</div>
      <div><b>关键文献合计</b> ${litTotal} 篇</div>
      <div><b>共有结构</b> ${sharedStructures.length} 个（同一 PDB 覆盖 ≥2 个靶点）</div>
      <div><b>分析引擎</b> ${esc(input.engineSummary || '—')}</div>
      <div><b>报告日期</b> ${dateStr} · 编号 ${esc(input.batchReportId.slice(0, 10))}</div>
      ${input.goal ? `<div><b>客户目标</b> <span style="color:#92400e">${esc(input.goal.length > 120 ? input.goal.slice(0, 119) + '…' : input.goal)}</span></div>` : ''}
    </div>
    <div class="rpt-badges">
      <span class="badge">${esc(relName)}</span>
      <span class="badge">数据源：UniProt · RCSB · PDBe${targets.some(t => t.blastHits.length > 0) ? (targets.some(t => t.blastStatus?.provider === 'rcsb') ? ' · 序列检索（RCSB 兜底）' : ' · BLAST') : ''}${litTotal ? ' · PubMed' : ''}</span>
      ${input.llmOk ? '<span class="badge">LLM 分析：已完成</span>' : '<span class="badge amber">LLM 分析：失败（见警示）</span>'}
    </div>
    <div class="rel-box">
      <b>靶点关系：${esc(relName)}</b>（置信度：${relation.confidence === 'high' ? '高' : relation.confidence === 'medium' ? '中' : '低'}）<br>
      ${esc(relation.rationale)}<br>
      <b>策略要点：</b>${esc(relation.strategy)}
    </div>
    <div class="tgt-grid">${targetMeta}</div>
  </header>"""
src = rep(src, old_home_head, new_home_head, 'M12-home-head')

# ── M13：首页 LLM 章节加 sec-llm 类（h3 计数徽章与单靶点同款）────────────
src = rep(src,
          """  <section class="sec" id="llm">
    <h2>${secHead(noLlm, '合并评估分析', 'Merged Analysis')}</h2>""",
          """  <section class="sec sec-llm" id="llm">
    <h2>${secHead(noLlm, '合并评估分析', 'Merged Analysis')}</h2>""",
          'M13-home-llm-class')

# ── M14：toc-targets 提示文案 ────────────────────────────────────────────
src = rep(src,
          'title="${esc(t.proteinName)} — PDB ${t.directPdbs.length} · 总体 ${t.scores.overall.score}/10 · 综述/基本信息/预测结构/单独结构同页"',
          'title="${esc(t.proteinName)} — PDB ${t.directPdbs.length} · 总体 ${t.scores.overall.score}/10 · 完整单独评估报告（与单靶点评估同格式）"',
          'M14-toc-targets')

# ── M15：body 末尾 — 图片池水合 + backtop ────────────────────────────────
old_tail_views = """  ${targetViews}
</div>
<script>
// v2.12：打印准备 — 先展开全部 details 折叠块并临时显示全部视图（强制回流让隐藏"""
new_tail_views = """  ${targetViews}
</div>
<a href="#top" class="backtop no-print" id="backtop" aria-label="回到顶部" title="回到顶部">↑</a>
<script>
// v2.13：客户实验数据图片池 — 各靶点单独评估页 figure[data-fig-copy] 的 <img> 从
// 首页对应 data-fig 图片复制 src/alt（全批次只内嵌一次，单独页格式与单靶点报告一致）
(function () {
  var pool = {};
  Array.prototype.forEach.call(document.querySelectorAll('#view-home figure.fig[data-fig]'), function (f) {
    var img = f.querySelector('img');
    if (img && img.getAttribute('src')) pool[f.getAttribute('data-fig')] = img;
  });
  Array.prototype.forEach.call(document.querySelectorAll('figure.fig[data-fig-copy]'), function (c) {
    var src = pool[c.getAttribute('data-fig-copy')];
    var img = c.querySelector('img');
    if (src && img && !img.getAttribute('src')) {
      img.src = src.src;
      if (src.alt) img.alt = src.alt;
    }
  });
})();
</script>
<script>
// v2.13：backtop（与单靶点报告同款 — 滚动超一屏出现）
(function () {
  var btn = document.getElementById('backtop');
  if (btn) {
    var onScroll = function () { btn.classList.toggle('show', window.scrollY > 600); };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }
})();
</script>
<script>
// v2.12：打印准备 — 先展开全部 details 折叠块并临时显示全部视图（强制回流让隐藏"""
src = rep(src, old_tail_views, new_tail_views, 'M15-body-tail')

# ── M16：页脚文案 + marker 注释 ─────────────────────────────────────────
src = rep(src,
          "    Generated by TargetEval · 多靶点合并评估（v2.12 格式：复合物评估与单独评估分层 — 首页为复合物级分析 + 共有结构与共有文献，每靶点独立单独报告页[综述 + 基本信息 + AlphaFold 预测结构交互视图 + 该靶点 PDB/同源/文献明细，刊头靶点卡片进入] · 打印时全部页面依序输出）<br>",
          "    Generated by TargetEval · 多靶点合并评估（v2.13 格式：复合物评估与单独评估分层 — 首页为复合物级分析 + 共有结构与共有文献；每靶点独立单独评估报告页与单靶点评估报告同格式同流程[评估分析 / 可行性评分 / PDB 结构与文献全量展开 / 同源 / 客户实验数据]，刊头靶点卡片进入 · 打印时全部页面依序输出）<br>",
          'M16-foot')
src = rep(src,
          "<!-- mrg-fmt-v2.12 合并报告格式版本标记：旧版落盘 HTML 无此标记时由报告路由自动升级重渲染 -->",
          "<!-- mrg-fmt-v2.13 合并报告格式版本标记：旧版落盘 HTML 无此标记时由报告路由自动升级重渲染（v2.13：首页标题/字体同步单独评估 + 每靶点完整单独评估报告页 + PDB/文献全量展开） -->",
          'M16-marker')

# ── M17：模块头注释补 v2.13 说明 ─────────────────────────────────────────
src = rep(src,
          """ *    ④序列一致性矩阵改为居中对齐 + 行标正文化（修复表头与内容错位观感）
 */""",
          """ *    ④序列一致性矩阵改为居中对齐 + 行标正文化（修复表头与内容错位观感）
 *  - v2.13 批量报告完全对齐单独评估：①首页（复合物评估）标题/字体/版式同步单靶点
 *    报告（SINGLE_REPORT_CSS 同源同版 — meta-grid 刊头 / JetBrains Mono / 章节
 *    样式）；②每靶点单独评估页退役「简报卡」，直接渲染完整单靶点报告主体
 *    （renderSingleReportBody：header + glance + 目录 + 评估分析 + 可行性评分 +
 *    PDB 结构清单 + 配体 + 同源 + 文献 + 客户实验数据 — 格式与单靶点评估一模一样）；
 *    ③PDB 结构与文献全量展开（不再默认折叠）；④批次各靶点不再因复合物组分跳过
 *    单独评估 — pipeline 按单靶点流程生成完整独立报告并持久化（旧批次回退综述）
 */""",
          'M17-doc')

open(PATH, 'w', encoding='utf-8').write(src)
print(f'patched {PATH}: {orig_len} → {len(src)} chars')
print('OK')
