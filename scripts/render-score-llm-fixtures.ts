/**
 * v2.18 LLM 智能调分 — 报告渲染 fixture + 字符串断言（bun 直接跑 TS）：
 *  1. 富上下文 mock（EGFR 场景 + llmAdjust 微调版：X-ray +1 / Cryo-EM ±0 / NMR −2）
 *     → /tmp/score-llm-fixtures/report-llmadj.html
 *  2. 复核维持版（全 0 delta，applied=false）→ report-llmkeep.html
 *  3. 无复核版（历史作业 — llmAdjust 缺省）→ report-nollm.html（回归：不出现任何 AI 复核元素）
 *  4. 字符串断言：llm-adj-strip / score-delta 徽章 / glance-ai-tag / 评分说明段 /
 *     rationale AI 短语 / 打印分页避让；无复核版上述全部缺位
 * 配套 DOM/截图断言见 scripts/e2e-score-llm.mjs（playwright）。
 */
import * as fs from 'node:fs'
import { renderReportHtml } from '../src/lib/eval/report-html'
import type { ReportContext } from '../src/lib/eval/report'
import type { LlmScoreAdjustInfo } from '../src/lib/eval/types'

const OUT = '/tmp/score-llm-fixtures'
fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })

/** 基础评分上下文（EGFR 场景 — 与 ux-fixtures 同源，可复用断言经验） */
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
    } as never,
    sequence: 'M'.repeat(100),
    goal: '客户希望获得 EGFR 激酶区与新型抑制剂的复合物结构',
    goalHints: [],
    directPdbs: [
      { pdbId: 'A1B6E', method: 'X-RAY DIFFRACTION', resolution: 1.85, title: 'EGFR kinase domain in complex with a strain-release covalent inhibitor', releaseDate: '2026-01-01', ligands: ['Erlotinib'], journal: 'J. Biol. Chem.', doi: '10.0000/x', pubmedId: '39000000', organisms: ['Homo sapiens'], isXray: true, isCryoem: false, isNmr: false },
    ],
    blastHits: [
      { pdbId: '7XYZ1', description: 'EGFR homolog from Mus musculus, kinase domain with inhibitor', identity: 92.5, evalueRaw: '2e-180', evalue: 2e-180, queryCoverage: 267, method: 'X-RAY DIFFRACTION', resolution: 2.0 },
    ],
    coverage: { coveragePercent: 22.1, mappings: [], coveredRanges: [[713, 979]] } as never,
    coverageText: '713-979 (267 aa)',
    gapText: '1-712 (712 aa), 980-1210 (231 aa)',
    literature: [
      { pmid: '39000000', title: 'Structure of EGFR kinase domain with covalent inhibitor', journal: 'J. Biol. Chem.', year: '2026', doi: '10.0000/x', fromPdb: true },
    ],
    images: [],
    scores: {
      xray: { score: 9, maxScore: 10, rating: 'Excellent·优秀' },
      cryoem: { score: 8, maxScore: 10, rating: 'Good·良好' },
      nmr: { score: 3, maxScore: 10, rating: 'Poor·困难' },
      overall: { score: 9, maxScore: 10, rating: 'Excellent·优秀' },
      rationale: {
        xray: '1210 aa（长于典型可结晶片段，需截短构建）；已有 1 个 X-ray 结构先例；BLAST 最高同源 identity 92%',
        cryoem: '中等分子量，Cryo-EM 可行（可能需融合 MBP/ferritin 等增重策略）',
        nmr: '分子量过大（>500 aa），超出 NMR 常规范围',
        overall: '序列覆盖率 22.1%；已有结构 1 个（X-ray 1 / Cryo-EM 0 / NMR 0），最佳分辨率 1.85Å；BLAST 同源加成 +2',
      },
    },
    oligomer: undefined,
    ligands: undefined,
    alphafold: { available: false, note: 'fixture 无预测' } as never,
  } as unknown as ReportContext
}

/** 微调版 llmAdjust（模拟 applyLlmScoreAdjust 产出：X-ray +1 / Cryo-EM ±0 / NMR −2） */
const adjustApplied: LlmScoreAdjustInfo = {
  applied: true,
  xray: 1, cryoem: 0, nmr: -2, overall: 0,
  confidence: 'high',
  notes: {
    xray: '已有 1.85Å 共晶结构且覆盖激酶区 — 高分辨先例充分，规则分略保守',
    cryoem: '中等分子量可行但已有结构全部为 X-ray 单体路线，无 EM 先例，维持',
    nmr: '1210 aa 远超 NMR 常规范围且无 NMR 先例，规则分仍偏高 2 分',
    overall: '复核确认 X-ray 为首选路线；总体分维持 9/10（受 X-ray +1 与 NMR −2 抵消）',
  },
  engine: 'Z.ai GLM-4.6（内置）',
  durationMs: 4230,
}

/** 维持版 llmAdjust（复核确认 — 全 0） */
const adjustKeep: LlmScoreAdjustInfo = {
  applied: false,
  xray: 0, cryoem: 0, nmr: 0, overall: 0,
  confidence: 'medium',
  notes: {
    xray: '规则分与高分辨先例证据一致，维持',
    cryoem: '中等分子量判断合理，维持',
    nmr: '分子量约束判断合理，维持',
    overall: '证据与规则评分一致，无需调整',
  },
  engine: 'Z.ai GLM-4.6（内置）',
  durationMs: 1980,
}

/** 把 llmAdjust 的 rationale 后缀模拟进去（与 applyLlmScoreAdjust 同款拼接） */
function withAdjust(ctx: ReportContext, adj: LlmScoreAdjustInfo): ReportContext {
  const suffix = (d: number, note: string) => `；AI 复核${d > 0 ? `上调 ${d}` : d < 0 ? `下调 ${-d}` : '维持'}：${note}`
  const c = { ...ctx, scores: { ...ctx.scores } } as ReportContext & {
    scores: typeof ctx.scores & { llmAdjust?: LlmScoreAdjustInfo }
  }
  c.scores.llmAdjust = adj
  // 微调版：分值按 delta 应用（X-ray 9+1=10 clamp、NMR 3−2=1、总体 max=10）
  if (adj.applied) {
    c.scores.xray = { score: 10, maxScore: 10, rating: 'Excellent·优秀' }
    c.scores.nmr = { score: 1, maxScore: 10, rating: 'Poor·困难' }
    c.scores.overall = { score: 10, maxScore: 10, rating: 'Excellent·优秀' }
  }
  c.scores.rationale = {
    xray: ctx.scores.rationale.xray + suffix(adj.xray, adj.notes.xray),
    cryoem: ctx.scores.rationale.cryoem + suffix(adj.cryoem, adj.notes.cryoem),
    nmr: ctx.scores.rationale.nmr + suffix(adj.nmr, adj.notes.nmr),
    overall: ctx.scores.rationale.overall + `；AI 复核维持：${adj.notes.overall}`,
  }
  return c
}

async function render(ctx: ReportContext, name: string): Promise<string> {
  const html = await renderReportHtml({
    ctx,
    methodStats: { xrayCount: 1, cryoemCount: 0, nmrCount: 0, bestResolution: 1.85 } as never,
    llmMarkdown: '## 执行摘要\n**EGFR 激酶区结构解析可行性高**，X-ray 已有 1.85 Å 共晶先例。',
    llmOk: true,
    llmErrors: [],
    jobId: 'score-llm-e2e',
    durationMs: 12345,
    totalPdbFound: 1,
    engineSummary: 'Z.ai GLM-4.6（内置）',
    resolveImagePath: () => '',
  })
  fs.writeFileSync(`${OUT}/${name}`, html, 'utf-8')
  return html
}

const htmlAdj = await render(withAdjust(baseCtx(), adjustApplied), 'report-llmadj.html')
const htmlKeep = await render(withAdjust(baseCtx(), adjustKeep), 'report-llmkeep.html')
const htmlNo = await render(baseCtx(), 'report-nollm.html')

// ─── 字符串断言 ────────────────────────────────────────────────────────────
let pass = 0, fail = 0
const ok = (name: string, cond: boolean) => { cond ? pass++ : fail++; console.log(`  ${cond ? '✓' : '✗'} ${name}`) }

console.log('【微调版 report-llmadj.html】')
ok('AI 复核条存在', htmlAdj.includes('llm-adj-strip'))
ok('AI 复核徽章（badge）', htmlAdj.includes('llm-adj-badge'))
ok('微调标题文案', htmlAdj.includes('已微调系统评分'))
ok('X-ray delta 徽章（+1，紫色正调整）', htmlAdj.includes('score-delta sd-pos') && /AI \+1/.test(htmlAdj))
ok('NMR delta 徽章（−2，负调整）', htmlAdj.includes('score-delta sd-neg') && /AI −2/.test(htmlAdj))
ok('逐方法意见列表（X-ray 意见出现）', htmlAdj.includes('高分辨先例充分'))
ok('置信度中文呈现', htmlAdj.includes('置信度：高'))
ok('复核引擎元数据行', htmlAdj.includes('复核引擎 Z.ai GLM-4.6（内置） · 4.2s'))
ok('评分说明段含两层流程表述', htmlAdj.includes('评分流程分两层'))
ok('评分说明段含 ±2 钳制说明', htmlAdj.includes('±2 以内的微调'))
ok('rationale 含 AI 复核短语', htmlAdj.includes('AI 复核上调 1') && htmlAdj.includes('AI 复核下调 2'))
ok('glance 速览 AI 标签', htmlAdj.includes('glance-ai-tag'))
ok('glance-foot 提及 AI 复核意见', htmlAdj.includes('与 AI 复核意见'))
ok('打印分页避让包含 llm-adj-strip', htmlAdj.includes('.llm-adj-strip,'))
ok('调整 chips（adj-chip X-ray +1）', htmlAdj.includes('adj-chip adj-pos') && htmlAdj.includes('X-ray +1'))
ok('CSS 定义存在（.score-delta）', htmlAdj.includes('.score-delta {'))
ok('调整后分值渲染（X-ray 10）', /X-ray 结晶[\s\S]{0,200}?10<span class="score-max">\/10<\/span>/.test(htmlAdj))

console.log('\n【维持版 report-llmkeep.html】')
ok('AI 复核条存在（维持意见展示）', htmlKeep.includes('llm-adj-strip'))
ok('维持文案', htmlKeep.includes('复核确认维持系统评分'))
ok('无正/负 delta 徽章（全 ±0）', !htmlKeep.includes('score-delta sd-pos') && !htmlKeep.includes('score-delta sd-neg'))
ok('无 glance AI 正调整标签（维持态弱呈现）', htmlKeep.includes('glance-ai-tag'))
ok('维持意见列表呈现', htmlKeep.includes('证据与规则评分一致'))

console.log('\n【无复核版 report-nollm.html（历史作业回归）】')
ok('无 AI 复核条元素（CSS 类定义不算）', !htmlNo.includes('class="llm-adj-strip"'))
ok('无 delta 徽章元素（CSS 类定义不算）', !htmlNo.includes('class="score-delta'))
ok('无 glance AI 标签元素（CSS 类定义不算）', !htmlNo.includes('class="glance-ai-tag"'))
ok('评分说明段为规则表述（正文无「AI 专家复核」两层流程文案）', htmlNo.includes('调整值见评分卡内明细') && !htmlNo.includes('AI 专家基于同一证据链'))
ok('rationale 无 AI 短语', !htmlNo.includes('AI 复核维持'))

console.log(`\n通过 ${pass} · 失败 ${fail}`)
if (fail > 0) process.exit(1)
