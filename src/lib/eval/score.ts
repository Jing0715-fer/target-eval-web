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
 */
import type { MethodStats, MwAugmentAdjustInfo, MwAugmentAnalysis, OligomerAdjustInfo, OligomerAnalysis, PdbEntry, Scores, UniprotFeature, BlastHit } from './types'

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n))
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
}

export interface ScoreResult extends Scores {
  /** 各方法的一句话依据（报告用） */
  rationale: { xray: string; cryoem: string; nmr: string; overall: string }
}

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

export function computeScores(input: ScoreInput): ScoreResult & { methodStats: MethodStats } {
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

  // ── 聚集形式（寡聚态）调整（v1.25：整数幅度，后置于舍入之后 → 必然体现在最终分）──
  const oligo = computeOligomerAdjust(input.oligomer, sequenceLength)

  // ── 分子量增重策略调整（v1.26：小分子量靶点，装配 MW 驱动 Cryo-EM 分量）──
  const mwAdj = computeMwAugmentAdjust(input.mwAugment)
  // 分子量维度接管聚集形式维度的 Cryo-EM 分量（有装配分子量数据时）— 避免双重加分
  const mwTakeover = mwAdj != null && mwAdj.assemblyKda != null
  const oligoCryoemScored = mwTakeover ? 0 : (oligo?.cryoem ?? 0)

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
  else if (sequenceLength < 300) cryoem -= 2
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
  const boost = bestIdentity >= 80 ? 2 : bestIdentity >= 50 ? 1 : bestIdentity >= 30 ? 0 : -1

  // ── 调整叠加（整数、最后应用 → 调整值即最终分变化值）──
  const xrayFinal = clamp(xray + boost + (oligo?.xray ?? 0) + (mwAdj?.xray ?? 0), 1, 10)
  const cryoemFinal = clamp(cryoem + boost + oligoCryoemScored + (mwAdj?.cryoem ?? 0), 1, 10)
  const nmrFinal = clamp(nmr + (oligo?.nmr ?? 0) + (mwAdj?.nmr ?? 0), 1, 10)

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
  ].filter(Boolean).join('；')
  r.cryoem = [
    sequenceLength > 1500 ? '大分子量（>1500 aa）是 Cryo-EM 优势区间' : sequenceLength >= 500 ? '中等分子量，Cryo-EM 可行（可能需融合 MBP/ferritin 等增重策略）' : '小分子量（<500 aa）Cryo-EM 数据采集困难，建议截短+增重或改用其他方法',
    tmCount >= 2 ? '多次跨膜膜蛋白，Cryo-EM 是首选方法' : '',
    highResCryoem > 0 ? `已有 ${highResCryoem} 个 ≤3.5Å 的 Cryo-EM 结构` : cryoemCount > 0 ? `已有 ${cryoemCount} 个 Cryo-EM 结构` : '',
    oligo && oligo.cryoem > 0 && !mwTakeover ? `聚集形式加成 ${fmtAdj(oligo.cryoem)}：寡聚装配使有效分子量增大/复合物特征形貌利于 Cryo-EM` : '',
    mwAdj ? `分子量维度（单体 ~${mwAdj.monomerKda} kDa${mwAdj.assemblyKda != null ? ` → 装配 ~${mwAdj.assemblyKda} kDa` : '，无装配路径'}）：${mwAdj.note}${mwTakeover ? '；装配分子量已知时，聚集形式的 Cryo-EM 分量并入本维度计分（避免双重加分）' : ''}` : '',
  ].filter(Boolean).join('；')
  r.nmr = [
    sequenceLength < 300 ? '小分子量（<300 aa），NMR 适合' : sequenceLength < 500 ? '中等偏大，NMR 周期较长' : '分子量过大（>500 aa），超出 NMR 常规范围',
    tmCount >= 1 ? '含跨膜区，NMR 样品制备困难' : '',
    oligo && oligo.nmr < 0 ? `聚集形式扣分 ${fmtAdj(oligo.nmr)}：寡聚/复合物形式使表观分子量超出 NMR 适用范围` : '',
  ].filter(Boolean).join('；')
  r.overall = `序列覆盖率 ${coveragePercent}%；已有结构 ${directPdbs.length} 个（X-ray ${xrayCount} / Cryo-EM ${cryoemCount} / NMR ${nmrCount}）${bestResolution != null ? `，最佳分辨率 ${bestResolution}Å` : ''}；BLAST 同源加成 ${fmtAdj(boost)}` +
    (oligo ? `；聚集形式调整（${oligo.label}${oligo.stoichiometry ? ` · ${oligo.stoichiometry}` : ''}）：X-ray ${fmtAdj(oligo.xray)} / Cryo-EM ${mwTakeover ? `并入分子量维度` : fmtAdj(oligo.cryoem)} / NMR ${fmtAdj(oligo.nmr)}` : '') +
    (mwAdj ? `；分子量增重调整（单体 ~${mwAdj.monomerKda} kDa${mwAdj.assemblyKda != null ? ` → 装配 ~${mwAdj.assemblyKda} kDa` : ''}）：Cryo-EM ${fmtAdj(mwAdj.cryoem)}（X-ray/NMR 不受分子量增重影响）` : '')

  return {
    xray: { score: xrayFinal, maxScore: 10, rating: `${rating(xrayFinal)}·${ratingZh(xrayFinal)}` },
    cryoem: { score: cryoemFinal, maxScore: 10, rating: `${rating(cryoemFinal)}·${ratingZh(cryoemFinal)}` },
    nmr: { score: nmrFinal, maxScore: 10, rating: `${rating(nmrFinal)}·${ratingZh(nmrFinal)}` },
    overall: { score: overall, maxScore: 10, rating: `${rating(overall)}·${ratingZh(overall)}` },
    rationale: r as ScoreResult['rationale'],
    oligomerAdjust: oligo ?? undefined,
    mwAugmentAdjust: mwAdj ?? undefined,
    methodStats,
  }
}
