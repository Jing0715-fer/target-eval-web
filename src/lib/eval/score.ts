/**
 * 结构解析可行性评分 — 移植原项目评分模型并增强：
 *  - 融合 PDBe 覆盖率（已有结构覆盖越全，重复解析价值越低/参考越足）
 *  - 跨膜特征（UniProt Transmembrane features）扣分
 *  - BLAST 同源 identity 加成
 *  - v1.24：聚集形式（寡聚态）维度 — 同源寡聚/异源复合物/单体对三方法的不同影响：
 *    · 同源寡聚（homo-oligomer）：对称装配对小蛋白 Cryo-EM 有利（有效分子量×N）；
 *      无结构先例时需组装验证（轻微扣 X-ray/NMR）；NMR 表观分子量倍增扣分
 *    · 异源复合物（hetero-complex）：需共表达/体外组装 — X-ray 组装后结晶扣分、
 *      Cryo-EM 复合物优势加分、NMR 超范围扣分
 *    · 单体（monomer）：无组装考量，不调整
 */
import type { MethodStats, OligomerAnalysis, PdbEntry, Scores, UniprotFeature, BlastHit } from './types'

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
  /** v1.24：聚集形式（寡聚态）分析结果（可缺省 — 历史路径/分析失败） */
  oligomer?: OligomerAnalysis | null
}

export interface ScoreResult extends Scores {
  /** 各方法的一句话依据（报告用） */
  rationale: { xray: string; cryoem: string; nmr: string; overall: string }
}

/** 聚集形式 → 三方法分数调整与依据（保守幅度 ±0.5~1.5，不推翻基础评分） */
function oligomerAdjust(oligomer: OligomerAnalysis | null | undefined, sequenceLength: number): {
  xray: number; cryoem: number; nmr: number; rationale: string
} {
  if (!oligomer) return { xray: 0, cryoem: 0, nmr: 0, rationale: '' }
  const hasStructPrecedent = oligomer.evidence.some(e => e.source === 'pdb-title' || e.source === 'pdb-stoichiometry')
  const zh = oligomer.summary.split('—')[0].trim()

  switch (oligomer.category) {
    case 'homo-oligomer': {
      const copies = oligomer.evidence.find(e => e.source === 'pdb-stoichiometry')?.state.copies
        ?? oligomer.evidence.find(e => e.state.copies != null)?.state.copies ?? null
      // 有效分子量倍增 → Cryo-EM 优势（尤其小蛋白）；NMR 展宽/交换风险
      const cryoemGain = sequenceLength < 500 && copies && copies >= 2 ? 1 : 0.5
      const nmrPenalty = copies && copies >= 2 ? -1 : -0.5
      // 无结构先例的寡聚体：表达产物组装均一性需验证（结晶均一性风险）
      const xrayPenalty = hasStructPrecedent ? 0 : -0.5
      return {
        xray: xrayPenalty,
        cryoem: cryoemGain,
        nmr: nmrPenalty,
        rationale: `聚集形式：${zh}${oligomer.stoichiometry ? `（${oligomer.stoichiometry}）` : ''}${hasStructPrecedent ? '，已有寡聚体结构先例（组装界面获结构验证）' : '，寡聚组装需 SEC-MALS 验证'}；对称寡聚体使有效分子量${copies ? `增至约 ${copies}×单体` : '增大'}（Cryo-EM 利好，NMR 需评估亚基交换）`,
      }
    }
    case 'hetero-complex': {
      return {
        xray: hasStructPrecedent ? -0.5 : -1,
        cryoem: hasStructPrecedent ? 0.5 : 1,
        nmr: -1.5,
        rationale: `聚集形式：${zh} — 功能形式依赖异源装配${hasStructPrecedent ? '（已有复合物结构先例，可借鉴组装策略）' : '（需共表达/体外组装，组装验证前置）'}；X-ray 需组装后结晶（或 Fab 辅助），Cryo-EM 对复合物更有优势，NMR 基本超出适用范围`,
      }
    }
    case 'monomer': {
      return {
        xray: 0,
        cryoem: 0,
        nmr: 0,
        rationale: `聚集形式：单体（已有证据表明无需组装考量，可溶构建直接表达纯化）`,
      }
    }
    default: {
      return {
        xray: 0,
        cryoem: 0,
        nmr: 0,
        rationale: '聚集形式未获可靠证据 — 建议表达后 SEC-MALS/DLS 表征实际聚集状态',
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

  // ── 聚集形式（寡聚态）调整（v1.24）──
  const oligo = oligomerAdjust(input.oligomer, sequenceLength)

  // ── X-ray ──
  let xray = 5
  if (sequenceLength < 500) xray += 2
  else if (sequenceLength <= 1000) xray += 0.5
  else xray -= 1
  if (tmCount >= 2) xray -= 3          // 多次跨膜 → 结晶困难
  else if (tmCount === 1) xray -= 1
  if (highResXray > 0) xray += 2       // 已有高分辨 X-ray 先例
  if (hasDisordered) xray -= 0.5
  xray += oligo.xray
  xray = clamp(Math.round(xray), 1, 10)

  // ── Cryo-EM ──
  let cryoem = 5
  if (sequenceLength > 1500) cryoem += 3
  else if (sequenceLength >= 500) cryoem += 1
  else if (sequenceLength < 300) cryoem -= 2
  if (tmCount >= 2) cryoem += 2        // 膜蛋白是 Cryo-EM 强项
  if (highResCryoem > 0) cryoem += 1.5
  if (domainCount >= 3 && sequenceLength < 600) cryoem -= 0.5 // 多结构域小蛋白柔性强
  cryoem += oligo.cryoem
  cryoem = clamp(Math.round(cryoem), 1, 10)

  // ── NMR ──
  let nmr = 5
  if (sequenceLength < 300) nmr += 3
  else if (sequenceLength < 500) nmr += 1
  else nmr -= 2
  if (tmCount >= 1) nmr -= 3
  if (nmrCount > 0) nmr += 0.5
  nmr += oligo.nmr
  nmr = clamp(Math.round(nmr), 1, 10)

  // ── BLAST 同源加成（方法无关的技术先例信号）──
  const bestIdentity = blastHits.length > 0 ? Math.max(...blastHits.map(b => b.identity)) : 0
  const boost = bestIdentity >= 80 ? 2 : bestIdentity >= 50 ? 1 : bestIdentity >= 30 ? 0 : -1
  const xrayBoosted = clamp(xray + boost, 1, 10)
  const cryoemBoosted = clamp(cryoem + boost, 1, 10)

  const overall = Math.max(xrayBoosted, cryoemBoosted, nmr)

  const methodStats: MethodStats = { xrayCount, cryoemCount, nmrCount, bestResolution }

  // ── 评分依据（报告引用）──
  const r: Record<string, string> = {}
  r.xray = [
    `${sequenceLength} aa ${sequenceLength < 500 ? '（适合结晶的长度区间）' : '（长于典型可结晶片段，需截短构建）'}`,
    tmCount >= 2 ? `含 ${tmCount} 个预测跨膜区，全长的可结晶性差` : tmCount === 1 ? '含 1 个跨膜区，建议去 TM 构建' : '无明显跨膜区',
    highResXray > 0 ? `已有 ${highResXray} 个 ≤2.5Å 的 X-ray 结构先例` : xrayCount > 0 ? `已有 ${xrayCount} 个 X-ray 结构（无 ≤2.5Å 高分辨）` : '暂无 X-ray 结构先例',
    bestIdentity > 0 ? `BLAST 最高同源 identity ${bestIdentity}%` : '',
    oligo.rationale && input.oligomer?.category === 'hetero-complex' ? `寡聚态调整 ${oligo.xray}：异源复合物需组装后结晶` : (oligo.xray !== 0 ? `寡聚态调整 ${oligo.xray}` : ''),
  ].filter(Boolean).join('；')
  r.cryoem = [
    sequenceLength > 1500 ? '大分子量（>1500 aa）是 Cryo-EM 优势区间' : sequenceLength >= 500 ? '中等分子量，Cryo-EM 可行（可能需融合 MBP/ferritin 等增重策略）' : '小分子量（<500 aa）Cryo-EM 数据采集困难，建议截短+增重或改用其他方法',
    tmCount >= 2 ? '多次跨膜膜蛋白，Cryo-EM 是首选方法' : '',
    highResCryoem > 0 ? `已有 ${highResCryoem} 个 ≤3.5Å 的 Cryo-EM 结构` : cryoemCount > 0 ? `已有 ${cryoemCount} 个 Cryo-EM 结构` : '',
    oligo.cryoem > 0 ? `寡聚态加成 +${oligo.cryoem}：寡聚装配使有效分子量增大/复合物特征形貌利于 Cryo-EM` : '',
  ].filter(Boolean).join('；')
  r.nmr = [
    sequenceLength < 300 ? '小分子量（<300 aa），NMR 适合' : sequenceLength < 500 ? '中等偏大，NMR 周期较长' : '分子量过大（>500 aa），超出 NMR 常规范围',
    tmCount >= 1 ? '含跨膜区，NMR 样品制备困难' : '',
    oligo.nmr < 0 ? `寡聚态扣分 ${oligo.nmr}：寡聚/复合物形式使表观分子量超出 NMR 适用范围` : '',
  ].filter(Boolean).join('；')
  r.overall = `序列覆盖率 ${coveragePercent}%；已有结构 ${directPdbs.length} 个（X-ray ${xrayCount} / Cryo-EM ${cryoemCount} / NMR ${nmrCount}）${bestResolution != null ? `，最佳分辨率 ${bestResolution}Å` : ''}；BLAST 同源加成 ${boost >= 0 ? '+' : ''}${boost}${oligomerAdjustLabel(input.oligomer)}`

  return {
    xray: { score: xrayBoosted, maxScore: 10, rating: `${rating(xrayBoosted)}·${ratingZh(xrayBoosted)}` },
    cryoem: { score: cryoemBoosted, maxScore: 10, rating: `${rating(cryoemBoosted)}·${ratingZh(cryoemBoosted)}` },
    nmr: { score: nmr, maxScore: 10, rating: `${rating(nmr)}·${ratingZh(nmr)}` },
    overall: { score: overall, maxScore: 10, rating: `${rating(overall)}·${ratingZh(overall)}` },
    rationale: r as ScoreResult['rationale'],
    methodStats,
  }
}

/** 总体依据里的寡聚态短语（简短版） */
function oligomerAdjustLabel(oligomer: OligomerAnalysis | null | undefined): string {
  if (!oligomer) return ''
  switch (oligomer.category) {
    case 'homo-oligomer': return '；聚集形式为同源寡聚体（评分已考虑组装界面与有效分子量）'
    case 'hetero-complex': return '；聚集形式为异源复合物（评分已考虑组装策略对三方法的差异化影响）'
    case 'monomer': return '；单体形式（无组装考量）'
    default: return '；聚集形式未知（建议 SEC-MALS 表征）'
  }
}
