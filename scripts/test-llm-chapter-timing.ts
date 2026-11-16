/**
 * v2.7 章节级 LLM 调用时长实测 — 验证单章生成落在段预算（~50s）内。
 * 用 O94952 真实报告场景构造 digest，逐章计时（A1 摘要 / B1 全景 / C2 可行性）。
 */
import { llmChat } from '../src/lib/eval/llm'
import { REPORT_CHAPTERS } from '../src/lib/eval/report'

const DIGEST = `【靶点基本信息】
UniProt: O94952 (FBX21_HUMAN)
蛋白: F-box only protein 21
基因: FBXO21, FBX21, KIAA0875
物种: Homo sapiens
序列长度: 628 aa
功能注释: F-box 蛋白，SCF（Skp1-Cul1-F-box）E3 泛素连接酶复合物的底物识别亚基。

【客户目标与科学问题】
解析FBX021蛋白的整体三维结构，明确关键结构域及构象特征；研究FBX021蛋白与Resmetirom配体结合模式。

【已有 PDB 结构】共 0 个（无直接关联 PDB 结构）

【互作复合物证据】Complex Portal curated 复合物 CPX-7930（SCF E3 ubiquitin ligase complex, FBXO21 variant · Heterotetramer）：3/3 个其他组分有结构（SKP1/CUL1/RBX1，共 232 个 PDB，其中共有结构 44 个）；装配 ~184.3 kDa。

【BLAST 同源结构】已执行 RCSB 序列检索，未检索到显著同源结构。

【PubMed 文献】0 篇。

【配体研究数据】Resmetirom → PubChem CID 15981237（分子式 C17H12Cl2N6O4，MW 435.2）

【AlphaFold 预测】AF-O94952-F1（v6）：平均 pLDDT 85.3，pLDDT ≥90 区段占 71%

【可行性评分（本系统计算，1-10）】
- X-ray: 6/10 — 长于典型可结晶片段，需截短构建
- Cryo-EM: 6/10 — 装配后 ~184.3 kDa 进入常规可行区间
- NMR: 3/10 — 分子量过大
- 总体: 6/10 — Fair`

const ctx: Record<string, unknown> = {
  oligomer: null, mwAugment: null, interaction: null, insights: undefined,
  images: [], batchNote: undefined, providedSequence: undefined,
}
// 构造最小 ctx（章节指令仅读取这些字段，缺省安全）
const anyCtx = ctx as never

async function main() {
  for (const key of ['A1', 'B1', 'C2']) {
    const ch = REPORT_CHAPTERS.find(c => c.key === key)!
    const t0 = Date.now()
    const r = await llmChat(`${DIGEST}

━━━━━━━━━━━━━━━━━━━━━━━━
基于以上数据上下文，${ch.instruction(anyCtx)}`, '你是结构生物学专家。', undefined)
    const ms = Date.now() - t0
    console.log(`${key}「${ch.label}」 ${r.ok ? 'ok' : 'FAIL ' + r.error} ${ms}ms ${r.text.length}字 ${r.ok ? '' : ''}`)
  }
}
main().catch(e => { console.error(e); process.exit(1) })
