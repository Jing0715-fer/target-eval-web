/**
 * v1.28 报告模板冒烟测试：
 *  - 核心结论速览（At a Glance）卡片
 *  - 章节编号方块（sec-no）与统一编号
 *  - LLM 子章节 CSS 计数器（1.1 / 1.2 …）
 *  - 空结构 / BLAST 失败 callout 提示
 *  - 回到顶部按钮与打印规则
 *  - 综合评分行强调（row-overall）
 */
import { renderReportHtml } from '../src/lib/eval/report-html'
import type { ReportContext } from '../src/lib/eval/report'

function baseCtx(): ReportContext {
  return {
    uniprot: {
      uniprotId: 'P00533',
      entryName: 'EGFR_HUMAN',
      proteinName: 'Epidermal growth factor receptor',
      geneNames: ['EGFR', 'ERBB1'],
      organism: 'Homo sapiens',
      sequenceLength: 1210,
      sequence: 'M'.repeat(100),
      features: [],
    },
    sequence: 'M'.repeat(100),
    goal: '客户希望获得 EGFR 激酶区与新型抑制剂的复合物结构',
    goalHints: [],
    directPdbs: [
      {
        pdbId: 'A1B6E', method: 'X-RAY DIFFRACTION', resolution: 1.85, title: 'EGFR kinase domain in complex with inhibitor',
        releaseDate: '2026-01-01', ligands: ['ANP (adenylate)'], journal: 'J. Biol. Chem.',
        doi: '10.0000/x', pubmedId: '39000000', organisms: ['Homo sapiens'], isXray: true, isCryoem: false, isNmr: false,
      },
    ],
    blastHits: [
      { pdbId: '7XYZ1', description: 'EGFR homolog kinase domain', identity: 92.5, evalueRaw: '2e-180', evalue: 2e-180, queryCoverage: 267, method: 'X-RAY DIFFRACTION', resolution: 2.0 },
    ],
    blastStatus: { status: 'ok', note: '1 个同源命中' },
    coverage: { coveragePercent: 92, mappedResidues: 1113, totalResidues: 1210, segments: [] } as never,
    coverageText: '92%',
    gapText: '',
    literature: [
      { pmid: '39000000', title: 'Structure of EGFR kinase domain', journal: 'J. Biol. Chem.', year: '2026', doi: '10.0000/x', fromPdb: true },
    ],
    images: [],
    scores: {
      xray: { score: 9, maxScore: 10, rating: 'Excellent·优秀' },
      cryoem: { score: 8, maxScore: 10, rating: 'Good·良好' },
      nmr: { score: 3, maxScore: 10, rating: 'Poor·困难' },
      overall: { score: 9, maxScore: 10, rating: 'Excellent·优秀' },
      rationale: { xray: '大量高分辨率结构', cryoem: '有全长结构先例', nmr: '蛋白过大', overall: '综合优' },
    },
    oligomer: {
      category: 'homo-oligomer',
      label: '同源二聚体',
      summary: '同源二聚体（2×相同亚基）',
      stoichiometry: 'Homodimer (2×)',
      confidence: 'high',
      evidence: [{ source: 'uniprot-subunit', ref: 'P00533', text: 'SUBUNIT: Homodimer', state: {} } as never],
      notes: ['组装界面需保留'],
    } as never,
    mwAugment: {
      applicable: false,
      monomerKda: 133,
      zoneNote: '≥50 kDa',
      complexes: [], partners: [], options: [], conflicts: [], notes: [],
    } as never,
  } as unknown as ReportContext
}

const renderOpts = {
  methodStats: { xrayCount: 1, cryoemCount: 0, nmrCount: 0, bestResolution: 1.85 } as never,
  llmMarkdown: '## 执行摘要\n\n**核心结论句测试。**\n\n### 小节\n\n内容。\n\n## 客户目标与可行性结论\n\n内容。',
  llmOk: true,
  llmErrors: [],
  jobId: 'test-v128',
  durationMs: 12345,
  totalPdbFound: 1,
  engineSummary: 'Z.ai GLM-4.6（内置）',
  resolveImagePath: () => '',
}

// ── 场景 1：常规报告（有结构 + 有同源 + 有寡聚分析）────────────────────────
const html1 = await renderReportHtml({ ctx: baseCtx(), ...renderOpts })

// ── 场景 2：无结构 + BLAST 失败（callout 路径；注意守门会拦截此场景于 pipeline 层）──
const ctx2 = baseCtx()
ctx2.directPdbs = []
ctx2.blastHits = []
ctx2.blastStatus = { status: 'failed', note: '网络不可达' }
const html2 = await renderReportHtml({ ctx: ctx2, ...renderOpts })

// ── 场景 3：无结构 + BLAST 无命中（no-hits 为有效结论，正常出报告）────────
const ctx3 = baseCtx()
ctx3.directPdbs = []
ctx3.blastHits = []
ctx3.blastStatus = { status: 'no-hits' }
const html3 = await renderReportHtml({ ctx: ctx3, ...renderOpts })

// ── 场景 4：含评估表要点（insights 独立成章编号）──────────────────────────
const ctx4 = baseCtx()
ctx4.insights = { goals: ['目标 A'], scientificQuestions: [], experimentalSummary: 'SEC 主峰 90%' } as never
const html4 = await renderReportHtml({ ctx: ctx4, ...renderOpts })

const checks: [string, boolean][] = [
  // 场景 1：速览卡
  ['S1 速览卡容器', html1.includes('class="glance"') && html1.includes('Key Findings · 核心结论速览')],
  ['S1 速览卡推荐方法 tile', html1.includes('推荐方法') && html1.includes('X-ray 结晶')],
  ['S1 速览卡聚集形式 tile', html1.includes('同源二聚体') && html1.includes('置信度')],
  ['S1 速览卡分子量 tile', html1.includes('单体 ~133 kDa')],
  ['S1 速览卡脚注（推荐路线）', html1.includes('推荐路线')],
  // 场景 1：章节结构
  ['S1 章节编号方块 sec-no', html1.includes('class="sec-no"')],
  ['S1 章节一（评估分析）', html1.includes('<span class="sec-no">一</span>')],
  ['S1 无 insights 时评分为二章', html1.includes('<span class="sec-no">二</span><span class="sec-title">可行性评分')],
  ['S1 PDB 章节为三章', html1.includes('<span class="sec-no">三</span><span class="sec-title">PDB 结构清单')],
  ['S1 LLM 子章节计数器 CSS', html1.includes('counter-reset: llmch') && html1.includes('content:"1." counter(llmch)')],
  ['S1 综合评分行强调', html1.includes('row-overall')],
  ['S1 回到顶部按钮', html1.includes('class="backtop') && html1.includes('id="backtop"')],
  ['S1 平滑滚动', html1.includes('scroll-behavior:smooth')],
  ['S1 速览卡打印不跨页', html1.includes('.glance{break-inside:avoid}')],
  ['S1 目录含分子量调整说明', html1.includes('含聚集形式与分子量调整')],
  // 场景 2：空态
  ['S2 无结构 callout 提示', html2.includes('暂无直接关联的 PDB 结构 — 全新结构靶点')],
  ['S2 BLAST 失败 callout', html2.includes('同源检索失败 — 本报告不含同源结构证据')],
  ['S2 速览卡已有结构警示 tile', html2.includes('无（全新靶点）') && html2.includes('gt-warn')],
  ['S2 同源参考警示 tile', html2.includes('同源检索失败')],
  // 场景 3：no-hits
  ['S3 no-hits 速览 tile', html3.includes('无显著同源命中')],
  ['S3 no-hits 非 callout（有效结论）', !html3.includes('同源检索失败 — 本报告不含同源结构证据')],
  // 场景 4：insights 编号
  ['S4 insights 独立编号为二章', html4.includes('<span class="sec-no">二</span><span class="sec-title">客户评估表要点')],
  ['S4 有 insights 时评分为三章', html4.includes('<span class="sec-no">三</span><span class="sec-title">可行性评分')],
  ['S4 目录含评估表要点', html4.includes('href="#insights"')],
]

let pass = 0
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
  if (ok) pass++
}
console.log(`\n${pass}/${checks.length} passed`)
if (pass !== checks.length) process.exit(1)
