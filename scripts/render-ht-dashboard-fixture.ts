/**
 * render-ht-dashboard-fixture.ts — 汇总报告视觉审查 fixture（bun 直跑）。
 *
 * 用途：以覆盖各类边缘形态的确定性 mock 数据直接调 renderHtDashboardHtml，
 * 产出 /tmp/ht-dash/preview.html 供 agent-browser 多视口截图 + VLM 视觉审查。
 * 覆盖形态：
 *  - 表内 UniProt（eval-table 来源）/ 序列回补 UniProt（BLAST nr 98%）/ 无 UniProt
 *  - 生效区间（nsp 截短构建）/ 缓存恢复行（fromArchive）/ 原文报告内嵌行（reportHtml）
 *  - 无序列行 / 超长名称与种属 / 低分不建议 / NMR 强势 / 原表行快照（excelText — v2.65 序列折叠）
 *  - go / caution / no × rule / llm 结论来源
 *  - v2.65：内嵌一份真实单独报告原文（upload/Q8I246 · 1.1MB — 验证弹出与下载的字节级一致性）
 * 运行：bun scripts/render-ht-dashboard-fixture.ts
 */
import * as fs from 'node:fs'
import {
  computeHtStats,
  ruleVerdict,
  attachExcelRows,
  renderHtDashboardHtml,
  type HtDashboardRow,
  type HtVerdict,
} from '../src/lib/eval/ht-dashboard'

const OUT = '/tmp/ht-dash'
fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })

const seq = (n: number, seed = 'MKTAYIAKQRQISFVKSHFSRQ'): string => {
  let s = ''
  for (let i = 0; i < n; i++) s += seed[(i * 7 + n) % seed.length]
  return s.slice(0, n)
}

const md = (title: string, points: string[]): string =>
  `## 综合评估结论\n\n**${title}** 的结构生物学可行性综合评分见刊头。核心判断：\n\n${points.map((p, i) => `${i + 1}. ${p}`).join('\n')}\n\n## 结构证据明细\n\n| 方法 | 可用结构 | 最佳分辨率 | 覆盖率 | 评分 |\n| --- | --- | --- | --- | --- |\n| X-ray | 130 | 1.53 Å | 96% | 9/10 |\n| Cryo-EM | 8 | 3.1 Å | 88% | 7/10 |\n| NMR | 0 | — | 0% | 3/10 |\n\n## 风险与建议\n\n> 区间外柔性片段可能影响结晶；建议优先沿用已验证构建。\n\n同源建模可行（覆盖率 \`92%\`，序列一致性 > 40%）。`

const rows: HtDashboardRow[] = [
  {
    // v2.65：真实单独报告原文（用户上传的 Q8I246 报告 · ~1.1MB）— 验证「完整报告」
    // 弹出与「下载」的字节级一致性（含 PDB 列表 / BLAST / AlphaFold 预测结构与附件）
    jobId: 'jobq8i24600000000000015', label: 'Q8I246', uniprotId: 'Q8I246',
    proteinName: 'Phenylalanine--tRNA ligase alpha subunit', organism: 'Plasmodium falciparum (isolate 3D7)',
    range: [294, 451], overall: 7, xray: 7, cryoem: 5, nmr: 3,
    directPdbCount: 12, blastHitCount: 26, coverage: 88,
    methodXrayCount: 10, methodCryoemCount: 2, methodNmrCount: 0,
    bestResolution: 2.1, ligandCount: 3, literatureCount: 24,
    reportLlmOk: true, durationMs: 240_000, zipHref: 'G02/Q8I246.html', hasReport: true,
    reportHtml: fs.readFileSync('/home/z/my-project/upload/TargetEval_HT_2026-11-22_74g G02_TargetEval_Q8I246_2026-11-22.html', 'utf-8'),
    sequence: seq(158),
  },
  {
    jobId: 'jobegfr0000000000000001', label: 'P00533', uniprotId: 'P00533',
    proteinName: 'Epidermal growth factor receptor', organism: 'Homo sapiens (Human)',
    range: [695, 1022], overall: 8.5, xray: 9, cryoem: 7, nmr: 4,
    directPdbCount: 130, blastHitCount: 45, coverage: 96,
    methodXrayCount: 118, methodCryoemCount: 8, methodNmrCount: 0,
    bestResolution: 1.53, ligandCount: 34, literatureCount: 120,
    reportLlmOk: true, durationMs: 214_000, zipHref: 'G01/P00533.html', hasReport: true,
    reportMarkdown: md('P00533（EGFR 激酶域 695-1022）', ['X-ray 结构 118 个，激酶域全覆盖', '共晶配体 34 个，抑制剂数据充分', 'ATP 结合位点保守性高']),
    sequence: seq(328), identifiedVia: undefined,
  },
  {
    jobId: 'jobmTOR000000000000000002', label: 'P42345', uniprotId: 'P42345',
    proteinName: 'Serine/threonine-protein kinase mTOR', organism: 'Homo sapiens (Human)',
    overall: 7.5, xray: 4, cryoem: 9, nmr: 2,
    directPdbCount: 62, blastHitCount: 18, coverage: 89,
    methodXrayCount: 21, methodCryoemCount: 38, methodNmrCount: 0,
    bestResolution: 2.9, ligandCount: 12, literatureCount: 88,
    reportLlmOk: true, durationMs: 268_000, zipHref: 'G02/P42345.html', hasReport: true,
    reportMarkdown: md('P42345（mTOR）', ['Cryo-EM 复合物 38 个，全长构象完整', 'Raptor/Rictor 结合界面清晰', 'X-ray 限于 FKBP12-雷帕霉素复合片段']),
    sequence: seq(2549),
  },
  {
    jobId: 'jobache0000000000000000003', label: 'P22303', uniprotId: 'P22303',
    proteinName: 'Acetylcholinesterase', organism: 'Homo sapiens (Human)',
    overall: 7, xray: 8, cryoem: 3, nmr: 8,
    directPdbCount: 44, blastHitCount: 22, coverage: 93,
    methodXrayCount: 36, methodCryoemCount: 2, methodNmrCount: 9,
    bestResolution: 2.0, ligandCount: 41, literatureCount: 95,
    reportLlmOk: true, durationMs: 190_000, zipHref: 'G02/P22303.html', hasReport: true,
    reportMarkdown: md('P22303（AChE）', ['三方法均有可用结构（罕见）', 'NMR 溶液构象补充活性环柔性', '催化 gorge 深度适合小分子设计']),
    sequence: seq(614),
  },
  {
    jobId: 'jobnsp15000000000000000004', label: 'P0DTD1', uniprotId: 'P0DTD1',
    proteinName: 'Replicase polyprotein 1a/1b nsp15', organism: 'SARS-CoV-2 (Severe acute respiratory syndrome coronavirus 2)',
    range: [10002, 10950], overall: 6.5, xray: 7, cryoem: 5, nmr: 3,
    directPdbCount: 28, blastHitCount: 60, coverage: 91,
    methodXrayCount: 22, methodCryoemCount: 4, methodNmrCount: 2,
    bestResolution: 1.6, ligandCount: 5, literatureCount: 64,
    reportLlmOk: true, durationMs: 232_000, zipHref: 'G03/P0DTD1.html', hasReport: true,
    reportMarkdown: md('P0DTD1 nsp15（尿苷酸特异性内切酶）', ['截短构建 10002-10950 有效表达', '六聚体界面 Crystal 结构完整', '单体-六聚体平衡需 Cryo-EM 验证']),
    sequence: seq(348),
  },
  {
    jobId: 'jobseq000000000000000000005', label: 'MKTAYIAKQRQISFVKSHFSRQLE…（序列识别）', uniprotId: 'Q9H2K2',
    proteinName: 'Serine/threonine-protein kinase 25', organism: 'Homo sapiens (Human)',
    overall: 6, xray: 6, cryoem: 5, nmr: 4,
    directPdbCount: 9, blastHitCount: 30, coverage: 82,
    methodXrayCount: 7, methodCryoemCount: 1, methodNmrCount: 1,
    bestResolution: 2.4, ligandCount: 2, literatureCount: 21,
    reportLlmOk: true, durationMs: 205_000, zipHref: 'G03/Q9H2K2.html', hasReport: true,
    reportMarkdown: md('Q9H2K2（STK25，序列提交回补）', ['BLAST nr 98% 身份定位 UniProt 条目', '激酶域结构可用但数量有限', '需补充共晶配体数据']),
    sequence: seq(426), identifiedVia: 'BLAST nr 识别 98%',
  },
  {
    jobId: 'jobtanky00000000000000000006', label: '超长名称测试靶点 TRANSMEMBRANE PROTEIN WITH EGF-LIKE AND TWO FOLLISTATIN-LIKE DOMAINS 2（TMEFF2 染色体 2q32.3-q33 区域，跨膜蛋白，含 EGF 样与卵泡抑素样结构域）', uniprotId: 'Q9NZL9',
    proteinName: 'Transmembrane protein with EGF-like and two follistatin-like domains 2', organism: 'Homo sapiens (Human) — very long organism line for wrapping test in the summary master table cell',
    overall: 5.5, xray: 5, cryoem: 4, nmr: 6,
    directPdbCount: 4, blastHitCount: 12, coverage: 58,
    methodXrayCount: 2, methodCryoemCount: 0, methodNmrCount: 2,
    bestResolution: 2.8, ligandCount: 0, literatureCount: 18,
    reportLlmOk: false, durationMs: 178_000, zipHref: 'G04/Q9NZL9.html', hasReport: true,
    reportMarkdown: md('Q9NZL9（TMEFF2）', ['胞外域结构可用，跨膜区无结构', '覆盖率中等（58%）', '建议只交付胞外域构建']),
    sequence: seq(140),
  },
  {
    jobId: 'jobgpcr000000000000000000007', label: 'P41145', uniprotId: 'P41145',
    proteinName: 'C-C chemokine receptor type 8', organism: 'Homo sapiens (Human)',
    overall: 5, xray: 3, cryoem: 7, nmr: 2,
    directPdbCount: 15, blastHitCount: 24, coverage: 74,
    methodXrayCount: 4, methodCryoemCount: 11, methodNmrCount: 0,
    bestResolution: 3.4, ligandCount: 8, literatureCount: 47,
    reportLlmOk: true, durationMs: 250_000, zipHref: 'G04/P41145.html', hasReport: true,
    reportMarkdown: md('P41145（CCR8 GPCR）', ['GPCR 需融合蛋白策略', 'Cryo-EM 拮抗态结构 11 个', ' agonist 态缺失为风险点']),
    sequence: seq(355),
  },
  {
    jobId: 'jobkinase0000000000000000008', label: 'Q08345', uniprotId: 'Q08345',
    proteinName: 'Receptor-type tyrosine-protein phosphatase alpha', organism: 'Homo sapiens (Human)',
    overall: 4.5, xray: 5, cryoem: 2, nmr: 5,
    directPdbCount: 6, blastHitCount: 9, coverage: 47,
    methodXrayCount: 4, methodCryoemCount: 0, methodNmrCount: 2,
    bestResolution: 2.6, ligandCount: 1, literatureCount: 15,
    reportLlmOk: true, durationMs: 165_000, zipHref: 'G05/Q08345.html', hasReport: true,
    reportMarkdown: md('Q08345（PTPRα）', ['覆盖率不足 50%', '胞内磷酸酶域结构可用', '全长蛋白去垢剂方案未验证']),
    sequence: seq(802),
  },
  {
    jobId: 'jobarchi00000000000000000009', label: 'O15530', uniprotId: 'O15530',
    proteinName: 'Peroxisomal acyl-coenzyme A oxidase 1', organism: 'Homo sapiens (Human)',
    overall: 6, xray: 7, cryoem: 3, nmr: 1,
    directPdbCount: 17, blastHitCount: 25, coverage: 85,
    methodXrayCount: 14, methodCryoemCount: 2, methodNmrCount: 1,
    bestResolution: 1.9, ligandCount: 6, literatureCount: 33,
    reportLlmOk: true, durationMs: 199_000,
    hasReport: false, fromArchive: true,
    reportMarkdown: md('O15530（ACOX1，缓存恢复）', ['服务器文件已回收 — 本行来自浏览器快照', '统计与结论完整可用', '在线/离线链接不可用']),
    sequence: seq(660),
  },
  {
    jobId: 'jobionch00000000000000000010', label: 'Q9UKN8（序列识别·BMAL1 截短）', uniprotId: 'Q9UKN8',
    proteinName: 'Basic helix-loop-helix ARNT-like protein 1', organism: 'Homo sapiens (Human)',
    range: [1, 120], overall: 4, xray: 2, cryoem: 1, nmr: 8,
    directPdbCount: 3, blastHitCount: 8, coverage: 38,
    methodXrayCount: 0, methodCryoemCount: 0, methodNmrCount: 3,
    bestResolution: null, ligandCount: 0, literatureCount: 12,
    reportLlmOk: false, durationMs: 142_000, zipHref: 'G05/Q9UKN8.html', hasReport: true,
    reportMarkdown: md('Q9UKN8 bHLH-PAS 结构域（1-120）', ['仅 NMR 结构可用（3 个）', '无 X-ray/Cryo-EM 先例', '内在无序倾向需预防']),
    sequence: seq(120), identifiedVia: 'UniProt 精确匹配',
  },
  {
    jobId: 'jobprion00000000000000000011', label: 'P04156', uniprotId: 'P04156',
    proteinName: 'Major prion protein', organism: 'Homo sapiens (Human)',
    overall: 3.5, xray: 2, cryoem: 2, nmr: 6,
    directPdbCount: 8, blastHitCount: 11, coverage: 44,
    methodXrayCount: 2, methodCryoemCount: 1, methodNmrCount: 5,
    bestResolution: 2.9, ligandCount: 0, literatureCount: 55,
    reportLlmOk: false, durationMs: 156_000, zipHref: 'G06/P04156.html', hasReport: true,
    reportMarkdown: md('P04156（PrP 朊蛋白）', ['结构集中在 C 端结构域', 'N 端无序区不可结晶', '聚集风险高']),
    sequence: seq(253),
  },
  {
    jobId: 'jobidp000000000000000000012', label: 'A0A024R4T8（无序列提交行）', uniprotId: 'A0A024R4T8',
    proteinName: 'Uncharacterized protein', organism: '',
    overall: 2, xray: 1, cryoem: 0, nmr: 1,
    directPdbCount: 0, blastHitCount: 2, coverage: 21,
    methodXrayCount: 0, methodCryoemCount: 0, methodNmrCount: 0,
    bestResolution: null, ligandCount: 0, literatureCount: 3,
    reportLlmOk: false, durationMs: 98_000, zipHref: 'G06/A0A024R4T8.html', hasReport: true,
    reportMarkdown: md('A0A024R4T8', ['无任何直接结构证据', '同源覆盖仅 2 个远缘命中', '不建议立项']),
    sequence: undefined,
  },
  {
    jobId: 'joborig00000000000000000013', label: 'Q16539', uniprotId: 'Q16539',
    proteinName: 'Mitogen-activated protein kinase 14', organism: 'Homo sapiens (Human)',
    overall: 8, xray: 9, cryoem: 4, nmr: 3,
    directPdbCount: 96, blastHitCount: 31, coverage: 94,
    methodXrayCount: 90, methodCryoemCount: 3, methodNmrCount: 3,
    bestResolution: 1.3, ligandCount: 52, literatureCount: 143,
    reportLlmOk: true, durationMs: 224_000, zipHref: 'G01/Q16539.html', hasReport: true,
    // v2.63 原文报告路径：reportHtml 非空 → 内嵌原文（与下载的单独报告一致）
    reportHtml: `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>Q16539 · 单靶点评估报告（原文模拟）</title><style>body{font-family:Georgia,serif;color:#1c1917;line-height:1.9;max-width:900px;margin:0 auto;padding:40px 24px}h1{font-size:24px;border-bottom:2px solid #1c1917;padding-bottom:8px}h2{font-size:17px;margin-top:26px;color:#065f46}table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid #e7e5e4;padding:6px 9px;text-align:left}th{background:#f9fafb}blockquote{border-left:3px solid #6ee7c7;background:#f0fdf7;margin:12px 0;padding:8px 14px}</style></head><body><h1>Q16539（p38α MAPK）单靶点评估报告</h1><p><b>原文报告模拟页</b> — 该条目模拟 v2.63 的「报告文件原文内嵌」路径：与「在线 / 离线包」下载的单独报告完全一致（含图表与脚本）。</p><h2>结构证据</h2><table><tr><th>方法</th><th>结构数</th><th>最佳分辨率</th></tr><tr><td>X-ray</td><td>90</td><td>1.30 Å</td></tr><tr><td>Cryo-EM</td><td>3</td><td>3.2 Å</td></tr><tr><td>NMR</td><td>3</td><td>—</td></tr></table><h2>结论</h2><blockquote>建议推进 — p38α 为充分验证的成药靶点，共晶配体 52 个，构建风险低。</blockquote></body></html>`,
    sequence: seq(360),
  },
  {
    jobId: 'jobzero00000000000000000014', label: '无正文靶点（报告未生成）', uniprotId: undefined,
    proteinName: 'Unknown target', organism: '',
    overall: 1, xray: 0, cryoem: 0, nmr: 0,
    directPdbCount: 0, blastHitCount: 0, coverage: 0,
    methodXrayCount: 0, methodCryoemCount: 0, methodNmrCount: 0,
    bestResolution: null, ligandCount: 0, literatureCount: 0,
    reportLlmOk: false, durationMs: 60_000,
    hasReport: false,
    reportMarkdown: undefined, sequence: undefined,
  },
]

// 原始 Excel 行快照（attachExcelRows 匹配挂接；v2.65 序列格折叠 — 一行旧格式前缀验证渲染端兑底折叠）
attachExcelRows(rows, [
  { label: 'P00533', text: 'P00533 | EGFR | 激酶域构建 695-1022 | 优先级 A | [序列 328 aa] | 备注：共晶数据丰富' },
  { label: 'P42345', text: 'P42345 | mTOR | 全长 | 优先级 B | [序列 2549 aa] | 备注：Cryo-EM 首选' },
  { label: 'Q9H2K2', text: '序列提交行（无 ID） | STK25 同源 | MKTAYIAKQRQISFVKSHFSRQLEKMFNTQATLEKSQWKVFQHGL（旧快照序列前缀形态） | 优先级 C' },
  { label: 'P04156', text: 'P04156 | PrP | C 端结构域 121-231 | 优先级 D | 备注：N 端无序勿送结晶' },
])

const stats = computeHtStats(rows, 16)

// 结论：一半用规则推断（reportLlmOk=false），一半模拟 LLM 撰写
const verdicts: HtVerdict[] = rows.map(r => {
  const base = ruleVerdict(r)
  if (!r.reportLlmOk) return base
  const line = r.overall >= 7
    ? `建议推进 — 结构证据链完整（${r.directPdbCount} 直接结构 + ${r.blastHitCount} 同源），配体与文献支撑充分`
    : r.overall >= 5
      ? `谨慎推进 — 结构可用但覆盖受限（${Math.round(r.coverage)}%），建议先补齐关键域数据再立项`
      : `不建议直接立项 — 结构证据薄弱（覆盖 ${Math.round(r.coverage)}%），同源模板不足`
  return { jobId: r.jobId, verdict: base.verdict, line, source: 'llm' }
})

const markdown = `## 一、批次总体判断

本批 **16** 个靶点（成功 15 · 失败 1）整体可行性**中等偏上**：总体均分 5.1/10，其中 4 个建议推进、5 个谨慎推进、5 个不建议直接立项。X-ray 证据链最完整（12/15 靶点有射线结构），NMR 仅个别小蛋白可用。

## 二、方法维度分析

| 方法 | 均分 | 有结构靶点 | 适用场景 |
| --- | --- | --- | --- |
| X-ray | 5.4 | 12/14 | 稳定可溶域首选 |
| Cryo-EM | 4.0 | 6/14 | 大复合物 / GPCR |
| NMR | 3.9 | 6/14 | 小蛋白 / 无序区 |

### 关键观察

1. **激酶类靶点证据充分**（EGFR / p38α / mTOR），共晶配体丰富，建议直接进入构建交付。
2. **膜蛋白（CCR8）依赖 Cryo-EM**：拮抗态结构可用，agonist 态缺失是交付风险。
3. **无序倾向靶点（PrP / BMAL1 截短）**：NMR 是唯一可行路径，需控制构建长度。

## 三、推进档位建议

> 建议按「4 推进 → 5 谨慎 → 5 暂缓」三档分配资源；谨慎档先补齐 SIFTS 覆盖与共晶数据。

- **A 档（直接推进）**：P00533、Q16539、P42345、P22303
- **B 档（补数据后推进）**：P0DTD1 nsp15、Q9H2K2、P41145、Q9NZL9、O15530
- **C 档（暂缓）**：Q08345、Q9UKN8、P04156、A0A024R4T8、无正文靶点

## 四、数据口径说明

评分与统计为确定性数据；\`fromArchive\` 行（O15530）来自浏览器缓存快照恢复，评分、计数与结论完整可用，仅在线/离线报告链接失效。`

const html = renderHtDashboardHtml({
  title: '高通量评估汇总报告 · 16 靶点 · 2026-01-30（视觉审查 Fixture）',
  goal: '客户目标：从 15 个候选靶点中筛选结构生物学可行性最高的前 4-6 个进入结晶/Cryo-EM 交付管线，重点关注 X-ray 证据与共晶配体可用性；预算与周期约束下优先排除无序倾向与覆盖率不足的靶点。',
  rows,
  stats,
  verdicts,
  markdown,
  llmOk: true,
  llmErrors: [],
  engineSummary: '内置规则引擎 + LLM（deepseek-chat）',
  origin: 'https://eval.example.com',
  durationSec: 2_584,
  generatedAt: '2026-01-30 14:32:08',
  excelRows: [],
})

fs.writeFileSync(`${OUT}/preview.html`, html)
console.log(`written ${OUT}/preview.html · ${(html.length / 1024).toFixed(1)} KB`)
