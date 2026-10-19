/**
 * 抗体序列检测（纯函数，前后端共用）。
 *
 * 背景：评估表常同时包含靶点抗原与抗体序列（Fab/Fc/scFv 等）。对抗体序列跑
 * BLAST（pdbaa）会命中成百上千个抗体恒定区结构，对靶点可行性评估没有增量
 * 价值 —— 检测为抗体后自动跳过 BLAST 并在 UI/报告中说明。
 *
 * 判定策略（保守，避免假阳性）：
 *  - 序列头部/标签含抗体关键词（Fc、scFv、VH、VL、heavy chain 等）→ 抗体
 *  - 命中任一强基序（IgG 恒定区/铰链区高度保守片段、J 段末端）→ 抗体
 *  - 命中 ≥2 个弱基序（VH/VL 框架区签名）→ 抗体（覆盖无恒定区的 VHH/nanobody）
 *  - 其余 → 非抗体
 */

export interface AntibodyVerdict {
  isAntibody: boolean
  /** 判定依据（命中的基序/标签描述，用于 UI 提示与日志） */
  evidence: string[]
}

/** IgG 恒定区/铰链区强保守基序（任一命中即判抗体） */
const STRONG_MOTIFS: Array<[RegExp, string]> = [
  [/CPPCP/, 'IgG 铰链区 CPPCP 基序'],
  [/PREEQYNSTYR/, 'IgG CH1 恒定区基序'],
  [/TTPPVLDSDGSFFLYS/, 'IgG CH3 恒定区基序'],
  [/PSVFLFPP/, 'CH1 恒定区起始基序'],
  [/WESNGQPENNY/, 'CH2 恒定区基序'],
  [/VDKSRWQQGNVFSCSVMHEALHNHYTQKS/, 'IgG CH3 末端恒定区'],
]

/** J 段末端变体（序列结尾匹配 → 抗体可变域的强特征） */
const J_ENDINGS: Array<[string, string]> = [
  ['GQGTLVTVSS', '重链 J 段末端（VH）'],
  ['GQGTMVTVSS', '重链 J 段末端（VH 变体）'],
  ['GQGTKVEIK', '轻链 J 段末端（VL κ）'],
  ['GQGTKVTVS', '轻链 J 段末端变体'],
  ['GTQVTVSS', 'VHH J 段末端（纳米抗体）'],
  ['SFNRGEC', '轻链恒定区末端（CL κ）'],
]

/** VH/VL 框架区签名（弱基序，≥2 命中判抗体 — 覆盖无恒定区的纳米抗体） */
const WEAK_MOTIFS: Array<[RegExp, string]> = [
  [/WVRQAPG[KQS]/, 'VH 框架区 FW2 签名'],
  [/WYQQKPG/, 'VL 框架区 FW2 签名'],
  [/RFTIS[SR]DNAK/, 'VH 框架区 FW3 签名'],
  [/SCAASGY|SCAASGF|SCAASGS/, 'VH 框架区 FW1 签名'],
]

/** 序列标签/头部中的抗体关键词 */
const HEADER_RE =
  /(?:^|[^A-Za-z])(?:scFv|Fc\b|Fab\b|VHH\b|VH\b|VL\b|IgG|IgM|IgA|IgE|IgK|heavy[- ]chain|light[- ]chain|重链|轻链|抗体|纳米抗体|nanobody)(?:[^A-Za-z]|$)/i

/** 检测一条氨基酸序列（可选提供序列标签，如 "1C9-Fc"）是否为抗体序列 */
export function detectAntibody(seq: string, header?: string): AntibodyVerdict {
  const s = (seq ?? '').toUpperCase().replace(/[^A-Z]/g, '')
  const evidence: string[] = []

  if (header && HEADER_RE.test(header)) {
    evidence.push(`序列标签「${header.slice(0, 40)}」含抗体标识`)
  }

  if (s.length >= 80) {
    for (const [re, desc] of STRONG_MOTIFS) {
      if (re.test(s)) evidence.push(desc)
    }
    // J 段末端匹配（允许结尾 `*` 终止符，取前 12 位比对）
    const tail = s.replace(/\*+$/, '').slice(-12)
    for (const [ending, desc] of J_ENDINGS) {
      if (tail.endsWith(ending)) evidence.push(desc)
    }
    const weakHits: string[] = []
    for (const [re, desc] of WEAK_MOTIFS) {
      if (re.test(s)) weakHits.push(desc)
    }
    if (weakHits.length >= 2) evidence.push(...weakHits)
  }

  return { isAntibody: evidence.length > 0, evidence }
}
