/**
 * 结构解析可行性评分 — 移植原项目评分模型并增强：
 *  - 融合 PDBe 覆盖率（已有结构覆盖越全，重复解析价值越低/参考越足）
 *  - 跨膜特征（UniProt Transmembrane features）扣分
 *  - BLAST 同源 identity 加成
 *  - v1.25：聚集形式（寡聚态）维度 — 调整整数化并后置于舍入之后，
 *    修复 v1.24 中 ±0.5 调整被 Math.round 吞掉（对最终分无影响）的问题：
 *    · 同源寡聚（homo-oligomer）：对称装配对小蛋白 Cryo-EM 有利（有效分子量×N）；
 *      无结构先例时组装均一性需验证（X-ray -1）；表观分子量超出 NMR 范围时扣分
 *    · 异源复合物（hetero-complex）：需共表达/体外组装 — X-ray 组装后结晶扣分、
 *      Cryo-EM 复合物优势加分、NMR 超范围扣分
 *    · 单体（monomer）：无组装考量，不调整
 *  - v1.26：分子量增重策略维度（小分子量靶点，mw-augment.ts）—
 *    装配/复合物有效分子量接管 Cryo-EM 分量的计分（与聚集形式维度避免双重加分）：
 *    · 装配 ≥100 kDa → Cryo-EM +1（进入常规区间）
 *    · 装配 50-100 kDa → 0（边缘区间，需 VPP/优化条件）
 *    · 装配 <50 kDa → -1（颗粒对齐困难，需技术增重）
 *    · 无生物装配路径 → 技术增重可行 0 / 与目的冲突 -1
 *  - v1.27：同源复合物扩展路径（homolog-complex）— 单体小且直接路径装配
 *    不足 50 kDa 时，BLAST 同源命中结构形成的大复合物按靶点单体换算后
 *    接管 Cryo-EM 计分（identity ≥40% 与直接路径同权；<40% 远缘不加分）
 *  - v1.29：互作复合物证据维度（无直接结构时）— Complex Portal curated 复合物
 *    组分有结构 → 组装先例与组分模板可用（X-ray +1）；curated 装配总分子量
 *    ≥100 kDa → Cryo-EM +1（curated 化学计量比 mwAugment 伙伴推断可靠，
 *    接管时抑制 mwAugment/寡聚维度的 Cryo-EM 分量，避免双重加分）
 *  - v2.14：已有结构方法先例对评分的约束（用户反馈：小分子量靶点已有结构全部为
 *    Cryo-EM 复合物时，不得仅凭分子量推荐 X-ray/NMR — 不符合科学事实）：
 *    · 已有 Cryo-EM 结构 = 该靶点以复合物/增重形式被 Cryo-EM 解析的直接先例
 *      （<50 kDa 单体无法单独冷冻电镜解析）→ <300 aa 小分子量惩罚（-2）不再适用；
 *    · BLAST「无同源先例」扣分（-1）仅在无任何直接结构时适用 — 同源检索跳过/
 *      失败不应反向压低已有直接结构（更强先例）靶点的评分；
 *    · rationale 按先例事实表述（复合物路线可行），不再按「改用其他方法」表述
 */
import type { InteractionAnalysis, InteractionAdjustInfo, MethodStats, MwAugmentAdjustInfo, MwAugmentAnalysis, OligomerAdjustInfo, OligomerAnalysis, PdbEntry, Scores, UniprotFeature, BlastHit } from './types'

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n))
}

/** v2.18：导出评级标签（score-llm.ts AI 复核调整后重算评级用） */
export function ratingLabel(score: number): string {
  return `${rating(score)}·${ratingZh(score)}`
}

function rating(score: number): string {
  if (score >= 9) return 'Excellent'
  if (score >= 7) return 'Good'
  if (score >= 5) return 'Fair'
  return 'Poor'
}

function ratingZh(score: number): string {
  if (score >= 9) return '优秀'
  if (score >= 7) return '良好'
  if (score >= 5) return '中等'
  return '困难'
}

export interface ScoreInput {
  sequenceLength: number
  features: UniprotFeature[]
  directPdbs: PdbEntry[]
  blastHits: BlastHit[]
  coveragePercent: number
  /** 聚集形式（寡聚态）分析结果（可缺省 — 历史路径/分析失败） */
  oligomer?: OligomerAnalysis | null
  /** v1.26：分子量增重策略分析（可缺省 — 历史路径/未运行） */
  mwAugment?: MwAugmentAnalysis | null
  /** v1.29：互作复合物证据分析（无直接结构时运行；可缺省） */
  interaction?: InteractionAnalysis | null
}

export interface ScoreResult extends Scores {
  /** 各方法的一句话依据（报告用） */
  rationale: { xray: string; cryoem: string; nmr: string; overall: string }
}

/** computeScores 完整返回类型（含方法统计 — v2.18 导出供 score-llm 复核层复用） */
export type FullScoreResult = ScoreResult & { methodStats: MethodStats }

/**
 * v1.26/v1.27：分子量增重策略对评分的调整（小分子量靶点维度）。
 * 当前仅 Cryo-EM 有非零调整：装配/复合物有效分子量决定颗粒可成像性。
 * X-ray（分子量非结晶瓶颈，伴侣策略属战术层面）与 NMR（增重无益，
 * 装配超范围已由聚集形式维度扣分）均不调整。
 *
 * v1.27 同源复合物路径（homolog-complex）：装配 MW 为同源推断 —
 *  - 换算装配 ≥100 kDa 且 identity ≥40%：+1（寡聚界面在同一家族内常保守）
 *  - 换算装配 ≥100 kDa 但 identity <40%（远缘）：0（界面保守性弱，按边缘证据处理）
 *  - 换算装配 50-100 kDa：0（边缘区间，与直接路径同口径 — 需 VPP/优化条件）
 */
export function computeMwAugmentAdjust(
  mw: MwAugmentAnalysis | null | undefined,
): MwAugmentAdjustInfo | null {
  if (!mw || !mw.applicable) return null
  const assemblyKda = mw.assemblyKda
  const isHomolog = mw.assemblyPath === 'homolog-complex'
  const homologIdentity = mw.homologComplexes?.[0] != null ? Math.round(mw.homologComplexes[0].identity) : null
  const hasConflict = mw.conflicts.some(c => c.level === 'conflict')
  let cryoem = 0
  let note = ''
  if (assemblyKda != null && assemblyKda >= 100) {
    if (isHomolog) {
      if (homologIdentity != null && homologIdentity >= 40) {
        cryoem = 1
        note = `同源复合物推断（identity ${homologIdentity}%）：装配后有效分子量 ~${assemblyKda} kDa（≥100 kDa）— 进入 Cryo-EM 常规可行区间；寡聚界面在同一家族内常保守，但靶点能否形成同等装配需 SEC-MALS/共表达验证`
      } else {
        cryoem = 0
        note = `同源复合物推断（identity ${homologIdentity ?? '—'}%，远缘）：换算装配 ~${assemblyKda} kDa — 同源互作界面保守性较弱，按边缘证据评估（不加分）；组装验证与互作确认前置`
      }
    } else {
      cryoem = 1
      note = `装配后有效分子量 ~${assemblyKda} kDa（≥100 kDa）— 进入 Cryo-EM 常规可行区间${mw.assemblyPath === 'complex' ? '（已有复合物结构先例）' : mw.assemblyPath === 'partner' ? '（互作伙伴推断，无结构先例，组装需验证）' : '（自身寡聚装配）'}`
    }
  } else if (assemblyKda != null && assemblyKda >= 50) {
    cryoem = 0
    note = isHomolog
      ? `同源复合物推断（identity ${homologIdentity ?? '—'}%）：换算装配 ~${assemblyKda} kDa，处于 Cryo-EM 边缘区间（50-100 kDa）— 可行但需相位板（VPP）/优化玻璃化条件，且靶点组装需实验验证`
      : `装配后 ~${assemblyKda} kDa，处于 Cryo-EM 边缘区间（50-100 kDa）— 可行但需相位板（VPP）/优化玻璃化条件`
  } else if (assemblyKda != null) {
    cryoem = -1
    note = isHomolog
      ? `同源复合物换算后仍仅 ~${assemblyKda} kDa（<50 kDa）— Cryo-EM 颗粒对齐困难，需技术增重（Fab/支架融合）后再行评估`
      : `装配后仍仅 ~${assemblyKda} kDa（<50 kDa）— Cryo-EM 颗粒对齐困难，需技术增重（Fab/支架融合）后再行评估`
  } else {
    cryoem = hasConflict ? -1 : 0
    note = hasConflict
      ? '无生物装配增重路径，且技术增重与客户目的存在冲突 — Cryo-EM 按小分子量单体评估，可行性受限'
      : '无生物装配增重路径 — Cryo-EM 可行性取决于技术增重策略（Fab/ferritin 支架等），样品开发工作量与周期相应增加'
  }
  return {
    monomerKda: mw.monomerKda,
    assemblyKda,
    assemblyPath: mw.assemblyPath,
    xray: 0,
    cryoem,
    nmr: 0,
    note,
  }
}

/** v1.29：互作复合物证据对三方法的调整明细（无直接结构时的评估依据）。
 *
 * 证据分级：
 *  - curated（Complex Portal 复合物 + 其他组分有结构，用户确认 complex viewer 可靠）：
 *    · X-ray +1 — 复合物组装有先例依据，组分结构可作构建边界参考与共表达设计依据
 *    · Cryo-EM 按 curated 装配总分子量计：≥100 kDa → +1（常规区间）；50-100 → 0（边缘）；
 *      <50 或无长度数据 → 0（证据正面不扣分；组装本身仍可行）
 *    · NMR 0 — 靶点单体的 NMR 可行性不因复合物证据改变（复合物整体超范围已由寡聚维度覆盖）
 *  - binary（仅 IntAct 互作伙伴有结构，无 curated 复合物）：证据偏弱 — 三方法均 0，
 *    结构在报告中列出作参考（互作界面建模/pull-down 验证设计）
 */
export function computeInteractionAdjust(
  interaction: InteractionAnalysis | null | undefined,
): InteractionAdjustInfo | null {
  if (!interaction || !interaction.applicable || !interaction.hasEvidence) return null
  const best = interaction.complexes.find(c => c.componentsWithStructure > 0) ?? interaction.complexes[0]

  // binary-only：无 curated 复合物（或复合物组分均无结构且无 binary）→ 不调分，仅列证据
  if (!best || best.componentsWithStructure === 0) {
    if (!interaction.binaryPartners.length) return null
    const top = interaction.binaryPartners[0]
    return {
      complexAc: '',
      complexName: '',
      componentsWithStructure: 0,
      assemblyKda: null,
      level: 'binary',
      xray: 0,
      cryoem: 0,
      nmr: 0,
      note: `IntAct binary 互作伙伴 ${top.geneName ?? top.accession} 等有结构（${interaction.binaryPartners.length} 个伙伴）— 互作界面建模与验证设计可参考，但非 curated 复合物，不改变三方法评分（评估依据已在报告中列出）`,
    }
  }

  // curated：复合物 + 组分结构
  const kda = best.assemblyKda
  const xray = 1
  const cryoem = kda != null && kda >= 100 ? 1 : 0
  const kdaNote = kda == null
    ? '组分长度数据不完整，装配分子量未知（按证据正面处理，Cryo-EM 不加分）'
    : kda >= 100
      ? `curated 装配 ~${kda} kDa（≥100 kDa）— 组装后进入 Cryo-EM 常规可行区间`
      : kda >= 50
        ? `curated 装配 ~${kda} kDa（50-100 kDa 边缘区间）— 需相位板（VPP）/优化条件`
        : `curated 装配 ~${kda} kDa（<50 kDa）— 复合物规模对 Cryo-EM 仍偏小`
  return {
    complexAc: best.complexAc,
    complexName: best.name,
    componentsWithStructure: best.componentsWithStructure,
    assemblyKda: kda,
    level: 'curated',
    xray,
    cryoem,
    nmr: 0,
    note: `Complex Portal curated 复合物 ${best.complexAc}（${best.name}${best.assembly ? ` · ${best.assembly}` : ''}）：${best.componentsWithStructure}/${best.components.length - 1} 个其他组分有结构（共 ${best.totalPdb} 个 PDB）— 组装先例与组分模板可用，X-ray ${xray > 0 ? '+1' : '±0'}；${kdaNote}${cryoem > 0 ? '，Cryo-EM +1（curated 化学计量接管分子量推断）' : ''}`,
  }
}

/** v1.25：聚集形式对三方法的调整明细（评分卡展示 + 前端/报告消费） */
export function computeOligomerAdjust(
  oligomer: OligomerAnalysis | null | undefined,
  sequenceLength: number,
): OligomerAdjustInfo | null {
  if (!oligomer) return null
  const hasStructPrecedent = oligomer.evidence.some(e => e.source === 'pdb-title' || e.source === 'pdb-stoichiometry')
  const copies = oligomer.evidence.find(e => e.source === 'pdb-stoichiometry')?.state.copies
    ?? oligomer.evidence.find(e => e.state.copies != null)?.state.copies ?? null
  const label = oligomer.label || oligomer.summary.split('—')[0].split('（')[0].trim()

  switch (oligomer.category) {
    case 'homo-oligomer': {
      const effLen = sequenceLength * (copies ?? 2) // 化学计量未知时保守按二聚估算
      const xray = hasStructPrecedent ? 0 : -1
      const cryoem = copies != null && copies >= 2 ? 1 : (sequenceLength < 500 ? 1 : 0)
      const nmr = effLen > 500 ? -1 : 0
      const effKda = Math.round(sequenceLength * 110 * (copies ?? 2) / 1000)
      return {
        label,
        stoichiometry: oligomer.stoichiometry,
        confidence: oligomer.confidence,
        xray, cryoem, nmr,
        note: `${hasStructPrecedent ? '已有寡聚体结构先例（组装界面获结构验证）' : '寡聚组装均一性需 SEC-MALS 验证'}；` +
          `${copies && copies >= 2 ? `对称装配使有效分子量增至约 ${copies}×单体（~${effKda} kDa），利于 Cryo-EM 颗粒对齐；` : '寡聚装配使有效分子量增大，利于 Cryo-EM；'}` +
          `${nmr < 0 ? `表观分子量（~${effKda} kDa）超出 NMR 常规范围` : 'NMR 需评估亚基交换谱线展宽'}`,
      }
    }
    case 'hetero-complex': {
      return {
        label,
        stoichiometry: oligomer.stoichiometry,
        confidence: oligomer.confidence,
        xray: hasStructPrecedent ? -1 : -2,
        cryoem: 1,
        nmr: -2,
        note: `功能形式依赖异源装配${hasStructPrecedent ? '（已有复合物结构先例，可借鉴组装策略）' : '（需共表达/体外组装，组装验证前置）'}；X-ray 需组装后结晶（或 Fab 辅助）；Cryo-EM 对复合物更有优势；NMR 基本超出适用范围`,
      }
    }
    case 'monomer': {
      return {
        label,
        stoichiometry: oligomer.stoichiometry,
        confidence: oligomer.confidence,
        xray: 0, cryoem: 0, nmr: 0,
        note: '已有证据表明为单体 — 无需组装考量，可溶构建直接表达纯化（三方法评分不调整）',
      }
    }
    default: {
      return {
        label,
        stoichiometry: oligomer.stoichiometry,
        confidence: oligomer.confidence,
        xray: 0, cryoem: 0, nmr: 0,
        note: '聚集形式未获可靠证据 — 建议表达后 SEC-MALS/DLS 表征实际聚集状态（三方法评分暂不调整）',
      }
    }
  }
}

export function computeScores(input: ScoreInput): FullScoreResult {
  const { sequenceLength, directPdbs, blastHits, coveragePercent } = input

  const tmCount = input.features.filter(f => f.type === 'Transmembrane').length
  const hasSignal = input.features.some(f => f.type === 'Signal')
  const domainCount = input.features.filter(f => f.type === 'Domain' || f.type === 'Repeat').length
  const hasDisordered = input.features.some(f =>
    f.type === 'Region' && /disorder|low complexity/i.test(f.description))

  const xrayCount = directPdbs.filter(p => p.isXray).length
  const cryoemCount = directPdbs.filter(p => p.isCryoem).length
  const nmrCount = directPdbs.filter(p => p.isNmr).length
  const highResXray = directPdbs.filter(p => p.isXray && p.resolution != null && p.resolution <= 2.5).length
  const highResCryoem = directPdbs.filter(p => p.isCryoem && p.resolution != null && p.resolution <= 3.5).length
  const bestResolution = directPdbs.reduce<number | null>(
    (best, p) => (p.resolution != null && (best == null || p.resolution < best) ? p.resolution : best), null)
  const bestCryoemRes = directPdbs.filter(p => p.isCryoem && p.resolution != null).reduce<number | null>(
    (best, p) => (best == null || p.resolution! < best ? p.resolution! : best), null)
  // v2.14：已有 Cryo-EM 结构先例（对 <50 kDa 小靶点意味着复合物/增重路线已被证明 —
  // 单体颗粒无法单独冷冻电镜解析，已有 EM 条目必然为复合物或含技术组分）
  const hasCryoemPrecedent = cryoemCount > 0
  const allCryoem = hasCryoemPrecedent && xrayCount === 0 && nmrCount === 0

  // ── 聚集形式（寡聚态）调整（v1.25：整数幅度，后置于舍入之后 → 必然体现在最终分）──
  const oligo = computeOligomerAdjust(input.oligomer, sequenceLength)

  // ── 分子量增重策略调整（v1.26：小分子量靶点，装配 MW 驱动 Cryo-EM 分量）──
  const mwAdj = computeMwAugmentAdjust(input.mwAugment)

  // ── 互作复合物证据调整（v1.29：无直接结构时；curated 复合物为可靠装配证据）──
  const intAdj = computeInteractionAdjust(input.interaction)
  /** curated 复合物接管 Cryo-EM 分子量分量（curated 化学计量 > 伙伴/同源推断）—
   *  抑制 mwAugment 与寡聚维度的 Cryo-EM 分量，避免同一装配证据双重加分 */
  const intTakeover = intAdj != null && intAdj.level === 'curated'
  // 分子量维度接管聚集形式维度的 Cryo-EM 分量（有装配分子量数据时）— 避免双重加分
  const mwTakeover = mwAdj != null && mwAdj.assemblyKda != null
  const oligoCryoemScored = (mwTakeover || intTakeover) ? 0 : (oligo?.cryoem ?? 0)
  const mwCryoemScored = intTakeover ? 0 : (mwAdj?.cryoem ?? 0)

  // ── X-ray（基础分）──
  let xray = 5
  if (sequenceLength < 500) xray += 2
  else if (sequenceLength <= 1000) xray += 0.5
  else xray -= 1
  if (tmCount >= 2) xray -= 3          // 多次跨膜 → 结晶困难
  else if (tmCount === 1) xray -= 1
  if (highResXray > 0) xray += 2       // 已有高分辨 X-ray 先例
  if (hasDisordered) xray -= 0.5
  xray = clamp(Math.round(xray), 1, 10)

  // ── Cryo-EM（基础分）──
  let cryoem = 5
  if (sequenceLength > 1500) cryoem += 3
  else if (sequenceLength >= 500) cryoem += 1
  else if (sequenceLength < 300) cryoem -= hasCryoemPrecedent ? 0 : 2 // v2.14：已有 Cryo-EM 先例时小分子量惩罚不适用（装配路线已被证明，仅样品制备需沿先例组装）
  if (tmCount >= 2) cryoem += 2        // 膜蛋白是 Cryo-EM 强项
  if (highResCryoem > 0) cryoem += 1.5
  if (domainCount >= 3 && sequenceLength < 600) cryoem -= 0.5 // 多结构域小蛋白柔性强
  cryoem = clamp(Math.round(cryoem), 1, 10)

  // ── NMR（基础分）──
  let nmr = 5
  if (sequenceLength < 300) nmr += 3
  else if (sequenceLength < 500) nmr += 1
  else nmr -= 2
  if (tmCount >= 1) nmr -= 3
  if (nmrCount > 0) nmr += 0.5
  nmr = clamp(Math.round(nmr), 1, 10)

  // ── BLAST 同源加成（方法无关的技术先例信号，整数）──
  const bestIdentity = blastHits.length > 0 ? Math.max(...blastHits.map(b => b.identity)) : 0
  // v2.14：「无同源先例」扣分仅在无任何直接结构时适用 — 已有直接结构（尤其 Cryo-EM
  // 复合物先例）是强于同源推断的结构先例，同源检索跳过/失败不应反向压低评分
  const noPrecedentPenalty = directPdbs.length > 0 ? 0 : -1
  const boost = bestIdentity >= 80 ? 2 : bestIdentity >= 50 ? 1 : bestIdentity >= 30 ? 0 : noPrecedentPenalty

  // ── 调整叠加（整数、最后应用 → 调整值即最终分变化值）──
  const xrayFinal = clamp(xray + boost + (oligo?.xray ?? 0) + (mwAdj?.xray ?? 0) + (intAdj?.xray ?? 0), 1, 10)
  const cryoemFinal = clamp(cryoem + boost + oligoCryoemScored + mwCryoemScored + (intAdj?.cryoem ?? 0), 1, 10)
  const nmrFinal = clamp(nmr + (oligo?.nmr ?? 0) + (mwAdj?.nmr ?? 0) + (intAdj?.nmr ?? 0), 1, 10)

  const overall = Math.max(xrayFinal, cryoemFinal, nmrFinal)

  const methodStats: MethodStats = { xrayCount, cryoemCount, nmrCount, bestResolution }

  const fmtAdj = (n: number) => (n > 0 ? `+${n}` : `${n}`)

  // ── 评分依据（报告引用）──
  const r: Record<string, string> = {}
  r.xray = [
    `${sequenceLength} aa ${sequenceLength < 500 ? '（适合结晶的长度区间）' : '（长于典型可结晶片段，需截短构建）'}`,
    tmCount >= 2 ? `含 ${tmCount} 个预测跨膜区，全长的可结晶性差` : tmCount === 1 ? '含 1 个跨膜区，建议去 TM 构建' : '无明显跨膜区',
    highResXray > 0 ? `已有 ${highResXray} 个 ≤2.5Å 的 X-ray 结构先例` : xrayCount > 0 ? `已有 ${xrayCount} 个 X-ray 结构（无 ≤2.5Å 高分辨）` : '暂无 X-ray 结构先例',
    bestIdentity > 0 ? `BLAST 最高同源 identity ${bestIdentity}%` : '',
    oligo && oligo.xray < 0 ? `聚集形式调整 ${fmtAdj(oligo.xray)}：${input.oligomer?.category === 'hetero-complex' ? '异源复合物需组装后结晶' : '寡聚组装均一性需验证（无寡聚体结构先例）'}` : '',
    intAdj && intAdj.xray > 0 ? `互作复合物加成 ${fmtAdj(intAdj.xray)}：curated 复合物（${intAdj.complexAc}）组分有结构 — 组装先例与组分模板可用` : '',
  ].filter(Boolean).join('；')
  r.cryoem = [
    // v2.14：小分子量 + 已有 Cryo-EM 先例 → 先例即复合物/增重路线被证明的直接证据，
    // 不得再按「改用其他方法」表述（科学事实：该靶点已被 Cryo-EM 反复解析）
    sequenceLength > 1500 ? '大分子量（>1500 aa）是 Cryo-EM 优势区间'
      : sequenceLength >= 500 ? '中等分子量，Cryo-EM 可行（可能需融合 MBP/ferritin 等增重策略）'
        : hasCryoemPrecedent
          ? `小分子量（<500 aa）单体颗粒成像困难，但已有 ${cryoemCount} 个 Cryo-EM 结构先例${allCryoem ? '（全部已有结构均为 Cryo-EM）' : ''}${bestCryoemRes != null ? `，最佳 ${bestCryoemRes}Å` : ''} — 靶点以复合物/装配形式可被 Cryo-EM 解析，沿已有组装路线可行`
          : '小分子量（<500 aa）Cryo-EM 数据采集困难，建议截短+增重或改用其他方法',
    tmCount >= 2 ? '多次跨膜膜蛋白，Cryo-EM 是首选方法' : '',
    highResCryoem > 0 ? `已有 ${highResCryoem} 个 ≤3.5Å 的 Cryo-EM 结构` : cryoemCount > 0 ? `已有 ${cryoemCount} 个 Cryo-EM 结构` : '',
    oligo && oligo.cryoem > 0 && !mwTakeover && !intTakeover ? `聚集形式加成 ${fmtAdj(oligo.cryoem)}：寡聚装配使有效分子量增大/复合物特征形貌利于 Cryo-EM` : '',
    mwAdj && !intTakeover ? `分子量维度（单体 ~${mwAdj.monomerKda} kDa${mwAdj.assemblyKda != null ? ` → 装配 ~${mwAdj.assemblyKda} kDa` : '，无装配路径'}）：${mwAdj.note}` : '',
    intAdj && intAdj.cryoem > 0 ? `互作复合物维度：${intAdj.note}` : '',
  ].filter(Boolean).join('；')
  r.nmr = [
    sequenceLength < 300 ? '小分子量（<300 aa），NMR 适合' : sequenceLength < 500 ? '中等偏大，NMR 周期较长' : '分子量过大（>500 aa），超出 NMR 常规范围',
    tmCount >= 1 ? '含跨膜区，NMR 样品制备困难' : '',
    nmrCount > 0 ? `已有 ${nmrCount} 个 NMR 结构先例` : allCryoem ? `无 NMR 结构先例（已有 ${cryoemCount} 个结构全部以 Cryo-EM 解析 — 单体路线未被该靶点的研究实践采用）` : '',
    oligo && oligo.nmr < 0 ? `聚集形式扣分 ${fmtAdj(oligo.nmr)}：寡聚/复合物形式使表观分子量超出 NMR 适用范围` : '',
  ].filter(Boolean).join('；')
  r.overall = `序列覆盖率 ${coveragePercent}%；已有结构 ${directPdbs.length} 个（X-ray ${xrayCount} / Cryo-EM ${cryoemCount} / NMR ${nmrCount}）${bestResolution != null ? `，最佳分辨率 ${bestResolution}Å` : ''}；BLAST 同源加成 ${fmtAdj(boost)}` +
    (oligo ? `；聚集形式调整（${oligo.label}${oligo.stoichiometry ? ` · ${oligo.stoichiometry}` : ''}）：X-ray ${fmtAdj(oligo.xray)} / Cryo-EM ${mwTakeover || intTakeover ? `并入分子量维度` : fmtAdj(oligo.cryoem)} / NMR ${fmtAdj(oligo.nmr)}` : '') +
    (mwAdj ? `；分子量增重调整（单体 ~${mwAdj.monomerKda} kDa${mwAdj.assemblyKda != null ? ` → 装配 ~${mwAdj.assemblyKda} kDa` : ''}）：Cryo-EM ${intTakeover ? `并入互作复合物维度（curated 化学计量更可靠）` : fmtAdj(mwAdj.cryoem)}` : '') +
    (intAdj ? `；互作复合物证据${intAdj.level === 'curated' ? `（${intAdj.complexAc}）` : '（binary 伙伴）'}：X-ray ${fmtAdj(intAdj.xray)} / Cryo-EM ${fmtAdj(intAdj.cryoem)} / NMR ${fmtAdj(intAdj.nmr)}` : '')

  return {
    xray: { score: xrayFinal, maxScore: 10, rating: `${rating(xrayFinal)}·${ratingZh(xrayFinal)}` },
    cryoem: { score: cryoemFinal, maxScore: 10, rating: `${rating(cryoemFinal)}·${ratingZh(cryoemFinal)}` },
    nmr: { score: nmrFinal, maxScore: 10, rating: `${rating(nmrFinal)}·${ratingZh(nmrFinal)}` },
    overall: { score: overall, maxScore: 10, rating: `${rating(overall)}·${ratingZh(overall)}` },
    rationale: r as ScoreResult['rationale'],
    oligomerAdjust: oligo ?? undefined,
    mwAugmentAdjust: mwAdj ?? undefined,
    interactionAdjust: intAdj ?? undefined,
    methodStats,
  }
}

/**
 * v2.13：历史作业评分依据（rationale）合成 — 合并报告旧批次升级重渲染时，
 * v2.9 前的作业摘要没有评分依据原文（Scores.rationale 当时未持久化）。
 * 从仍留存于摘要的确定性数据（序列长度/方法统计/BLAST/覆盖率/调整明细，
 * 调整 note 为评估时原文）重建各方法一句话依据，口吻与 computeScores 一致，
 * 供各靶点单独评估页的评分卡展示 — 内容不虚构，缺失信号（跨膜区等）不臆测。
 * v2.18.1（代码审查 P3-3）：摘要至今均不持久化 rationale（合并报告全部走本合成）—
 * 带 llmAdjust 的作业在此补齐「AI 复核」短语，口径与 applyLlmScoreAdjust 一致。
 */
export function synthesizeScoreRationale(input: {
  sequenceLength: number
  methodStats: Pick<MethodStats, 'xrayCount' | 'cryoemCount' | 'nmrCount' | 'bestResolution'>
  directPdbCount: number
  coveragePercent: number
  bestIdentity: number | null
  scores: Scores
}): { xray: string; cryoem: string; nmr: string; overall: string } {
  const L = input.sequenceLength
  const ms = input.methodStats
  const fmtAdj = (n: number) => (n > 0 ? `+${n}` : `${n}`)
  const bestRes = ms.bestResolution != null ? `（最佳分辨率 ${ms.bestResolution}Å）` : ''
  const idPart = input.bestIdentity != null && input.bestIdentity > 0 ? `BLAST 最高同源 identity ${Math.round(input.bestIdentity)}%` : ''
  const oligo = input.scores.oligomerAdjust
  const mwAdj = input.scores.mwAugmentAdjust
  const intAdj = input.scores.interactionAdjust
  // v2.18.1：AI 复核短语（与 applyLlmScoreAdjust 同款拼接 — 合并报告各靶点页一致性）
  const llmA = input.scores.llmAdjust
  const aiSuffix = (delta: number, note: string) => {
    const d = Math.trunc(Number(delta)) || 0
    const verb = d > 0 ? `AI 复核上调 ${d}` : d < 0 ? `AI 复核下调 ${-d}` : 'AI 复核维持'
    return `；${verb}：${note || '未给出补充理由'}`
  }
  const aiX = llmA ? aiSuffix(llmA.xray, llmA.notes.xray) : ''
  const aiC = llmA ? aiSuffix(llmA.cryoem, llmA.notes.cryoem) : ''
  const aiN = llmA ? aiSuffix(llmA.nmr, llmA.notes.nmr) : ''
  const aiO = llmA ? aiSuffix(llmA.overall, llmA.notes.overall || '三方法复核意见综合') : ''
  const ms0: Pick<MethodStats, 'xrayCount' | 'cryoemCount' | 'nmrCount' | 'bestResolution'> =
    ms ?? { xrayCount: 0, cryoemCount: 0, nmrCount: 0, bestResolution: null }
  // v2.14：与 computeScores 同口径 — 已有 Cryo-EM 先例时小分子量不按「改用其他方法」表述
  const hasCryoemPrecedent = ms0.cryoemCount > 0
  const allCryoem = hasCryoemPrecedent && ms0.xrayCount === 0 && ms0.nmrCount === 0
  return {
    xray: [
      `${L} aa ${L < 500 ? '（适合结晶的长度区间）' : '（长于典型可结晶片段，需截短构建）'}`,
      ms0.xrayCount > 0 ? `已有 ${ms0.xrayCount} 个 X-ray 结构先例${bestRes}` : '暂无 X-ray 结构先例',
      idPart,
      oligo && oligo.xray < 0 ? `聚集形式调整 ${fmtAdj(oligo.xray)}：${oligo.note}` : '',
      intAdj && intAdj.xray > 0 ? `互作复合物加成 ${fmtAdj(intAdj.xray)}：${intAdj.note}` : '',
    ].filter(Boolean).join('；') + aiX,
    cryoem: [
      L > 1500 ? '大分子量（>1500 aa）是 Cryo-EM 优势区间' : L >= 500 ? '中等分子量，Cryo-EM 可行（可能需融合 MBP/ferritin 等增重策略）'
        : hasCryoemPrecedent
          ? `小分子量（<500 aa）单体颗粒成像困难，但已有 ${ms0.cryoemCount} 个 Cryo-EM 结构先例${allCryoem ? '（全部已有结构均为 Cryo-EM）' : ''}${ms0.bestResolution != null ? `，最佳 ${ms0.bestResolution}Å` : ''} — 靶点以复合物/装配形式可被 Cryo-EM 解析，沿已有组装路线可行`
          : '小分子量（<500 aa）Cryo-EM 数据采集困难，建议截短+增重或改用其他方法',
      ms0.cryoemCount > 0 ? `已有 ${ms0.cryoemCount} 个 Cryo-EM 结构${bestRes}` : '',
      oligo && oligo.cryoem > 0 ? `聚集形式加成 ${fmtAdj(oligo.cryoem)}：${oligo.note}` : '',
      mwAdj ? `分子量维度（${mwAdj.note}）` : '',
      intAdj ? `互作复合物维度：${intAdj.note}` : '',
    ].filter(Boolean).join('；') + aiC,
    nmr: [
      L < 300 ? '小分子量（<300 aa），NMR 适合' : L < 500 ? '中等偏大，NMR 周期较长' : '分子量过大（>500 aa），超出 NMR 常规范围',
      ms0.nmrCount > 0 ? `已有 ${ms0.nmrCount} 个 NMR 结构` : allCryoem ? `无 NMR 结构先例（已有 ${ms0.cryoemCount} 个结构全部以 Cryo-EM 解析）` : '',
      oligo && oligo.nmr < 0 ? `聚集形式扣分 ${fmtAdj(oligo.nmr)}：${oligo.note}` : '',
    ].filter(Boolean).join('；') + aiN,
    overall: `序列覆盖率 ${Math.round(input.coveragePercent)}%；已有结构 ${input.directPdbCount} 个（X-ray ${ms0.xrayCount} / Cryo-EM ${ms0.cryoemCount} / NMR ${ms0.nmrCount}）${bestRes}${idPart ? `；${idPart}` : ''}` +
      (oligo ? `；聚集形式调整（${oligo.label}${oligo.stoichiometry ? ` · ${oligo.stoichiometry}` : ''}）：X-ray ${fmtAdj(oligo.xray)} / Cryo-EM ${fmtAdj(oligo.cryoem)} / NMR ${fmtAdj(oligo.nmr)}` : '') +
      (mwAdj ? `；分子量增重调整：Cryo-EM ${fmtAdj(mwAdj.cryoem)} — ${mwAdj.note}` : '') +
      (intAdj ? `；互作复合物证据${intAdj.level === 'curated' ? `（${intAdj.complexAc}）` : '（binary 伙伴）'}：X-ray ${fmtAdj(intAdj.xray)} / Cryo-EM ${fmtAdj(intAdj.cryoem)} / NMR ${fmtAdj(intAdj.nmr)}` : '') + aiO,
  }
}
