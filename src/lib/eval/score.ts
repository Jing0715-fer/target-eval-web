/**
 * 结构解析可行性评分 — 移植原项目评分模型并增强：
 *  - 融合 PDBe 覆盖率（已有结构覆盖越全，重复解析价值越低/参考越足）
 *  - 跨膜特征（UniProt Transmembrane features）扣分
 *  - BLAST 同源 identity 加成
 */
import type { MethodStats, PdbEntry, Scores, UniprotFeature, BlastHit } from './types'

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
}

export interface ScoreResult extends Scores {
  /** 各方法的一句话依据（报告用） */
  rationale: { xray: string; cryoem: string; nmr: string; overall: string }
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

  // ── X-ray ──
  let xray = 5
  if (sequenceLength < 500) xray += 2
  else if (sequenceLength <= 1000) xray += 0.5
  else xray -= 1
  if (tmCount >= 2) xray -= 3          // 多次跨膜 → 结晶困难
  else if (tmCount === 1) xray -= 1
  if (highResXray > 0) xray += 2       // 已有高分辨 X-ray 先例
  if (hasDisordered) xray -= 0.5
  xray = clamp(Math.round(xray), 1, 10)

  // ── Cryo-EM ──
  let cryoem = 5
  if (sequenceLength > 1500) cryoem += 3
  else if (sequenceLength >= 500) cryoem += 1
  else if (sequenceLength < 300) cryoem -= 2
  if (tmCount >= 2) cryoem += 2        // 膜蛋白是 Cryo-EM 强项
  if (highResCryoem > 0) cryoem += 1.5
  if (domainCount >= 3 && sequenceLength < 600) cryoem -= 0.5 // 多结构域小蛋白柔性强
  cryoem = clamp(Math.round(cryoem), 1, 10)

  // ── NMR ──
  let nmr = 5
  if (sequenceLength < 300) nmr += 3
  else if (sequenceLength < 500) nmr += 1
  else nmr -= 2
  if (tmCount >= 1) nmr -= 3
  if (nmrCount > 0) nmr += 0.5
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
  ].filter(Boolean).join('；')
  r.cryoem = [
    sequenceLength > 1500 ? '大分子量（>1500 aa）是 Cryo-EM 优势区间' : sequenceLength >= 500 ? '中等分子量，Cryo-EM 可行（可能需融合 MBP/ferritin 等增重策略）' : '小分子量（<500 aa）Cryo-EM 数据采集困难，建议截短+增重或改用其他方法',
    tmCount >= 2 ? '多次跨膜膜蛋白，Cryo-EM 是首选方法' : '',
    highResCryoem > 0 ? `已有 ${highResCryoem} 个 ≤3.5Å 的 Cryo-EM 结构` : cryoemCount > 0 ? `已有 ${cryoemCount} 个 Cryo-EM 结构` : '',
  ].filter(Boolean).join('；')
  r.nmr = [
    sequenceLength < 300 ? '小分子量（<300 aa），NMR 适合' : sequenceLength < 500 ? '中等偏大，NMR 周期较长' : '分子量过大（>500 aa），超出 NMR 常规范围',
    tmCount >= 1 ? '含跨膜区，NMR 样品制备困难' : '',
  ].filter(Boolean).join('；')
  r.overall = `序列覆盖率 ${coveragePercent}%；已有结构 ${directPdbs.length} 个（X-ray ${xrayCount} / Cryo-EM ${cryoemCount} / NMR ${nmrCount}）${bestResolution != null ? `，最佳分辨率 ${bestResolution}Å` : ''}；BLAST 同源加成 ${boost >= 0 ? '+' : ''}${boost}`

  return {
    xray: { score: xrayBoosted, maxScore: 10, rating: `${rating(xrayBoosted)}·${ratingZh(xrayBoosted)}` },
    cryoem: { score: cryoemBoosted, maxScore: 10, rating: `${rating(cryoemBoosted)}·${ratingZh(cryoemBoosted)}` },
    nmr: { score: nmr, maxScore: 10, rating: `${rating(nmr)}·${ratingZh(nmr)}` },
    overall: { score: overall, maxScore: 10, rating: `${rating(overall)}·${ratingZh(overall)}` },
    rationale: r as ScoreResult['rationale'],
    methodStats,
  }
}
