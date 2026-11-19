/**
 * 结构域名提示 → UniProt domain 区间匹配（v2.29）。
 *
 * 用户诉求：评估表时常不写氨基酸范围而写结构域名（如「P51685 (CCR8 胞外域)」、
 * 「EGFR 激酶 domain」「ECD」「跨膜区」）。HT 提取链路把这类 token 作为
 * domainHint 随作业携带（EvaluationOptions.rangeHint），管线取得 UniProt features
 * 后由本模块与 UniProt 的 domain 划分匹配，推导评估区间 [begin, end] —
 * 该区间进入 effectiveRange 第三层级（手动区间 > 构建比对 > 结构域匹配），
 * 用于结构列表的「范围重叠优先展示」（与截短构建同口径，不重叠结构折叠保留）。
 *
 * 匹配策略：
 *  ① 别名类（胞外域/ECD/ectodomain → Extracellular 拓扑域；胞内域 → Cytoplasmic；
 *     跨膜区/TM → Transmembrane 全段并集；激酶域 → kinase 注释域）；
 *  ② 通用 token（剥掉 domain/结构域/域/区 后的核心词，如 SH2 / TIR / Death）→
 *     在 Domain/Region/Repeat/Topological domain 描述中子串匹配，命中区段并集。
 *  常见中文域名词的英译表兜底（死亡→death 等）。
 * 守卫：命中跨度 < 10 aa 不采用（过小区段无结构优先展示意义）；区间裁剪到序列长度内。
 * 匹配失败返回 null（作业按无区间评估，不阻塞）。
 */
import type { ResidueRange } from './range-filter'
import type { UniprotFeature } from './types'

export interface DomainRangeMatch {
  range: ResidueRange
  /** 归一后的匹配类别/核心词（展示与日志用，如「胞外域」「kinase」） */
  term: string
  /** 命中的 UniProt feature 描述原文（如 Extracellular / Protein kinase） */
  matched: string
  /** 命中 feature 类型 */
  featureType: string
  /** 并集命中的注释区段数（≥2 时报告展示「N 个区段合并」） */
  segments: number
}

/** 别名类提示 → 类别词（兼容裸词 — construct-range 扫描 token 时已剥掉「域/区/段」后缀，
 *  如「胞外域」→ token「胞外」、「TM domain」→ token「TM」） */
const ALIAS_RULES: Array<{ re: RegExp; canon: string; term: string }> = [
  { re: /ecto(?:domain)?|^ecd$|extracellular|胞外|外胞域|^exo-domain$/i, canon: 'extracellular', term: '胞外域' },
  { re: /^icd$|cytoplasmic|cytosolic|胞内|内胞域/i, canon: 'cytoplasmic', term: '胞内域' },
  { re: /^tm$|transmembrane|跨膜|穿膜/i, canon: 'transmembrane', term: '跨膜区' },
  { re: /kinase|激酶/i, canon: 'kinase', term: '激酶域' },
]

/** 常见中文域名核心词 → 英文注释子串（通用匹配兜底） */
const ZH_EN: Array<{ re: RegExp; en: string }> = [
  { re: /^死亡$/, en: 'death' },
  { re: /^免疫球蛋白$/, en: 'ig-like' },
  { re: /^锌指$/, en: 'zinc finger' },
  { re: /^螺旋卷曲$/, en: 'coiled coil' },
  { re: /^核苷酸结合$/, en: 'nucleotide-binding' },
]

/** feature 类型匹配优先级（小者优） */
function typeRank(t: string): number {
  switch (t) {
    case 'Domain': return 0
    case 'Topological domain': return 1
    case 'Region': case 'Repeat': case 'Zinc finger': case 'DNA-binding': case 'Nucleotide binding': return 2
    case 'Transmembrane': return 3
    default: return 4
  }
}

function spanOf(f: UniprotFeature): number {
  return Math.max(0, f.end - f.begin + 1)
}

/** 候选 feature 列表 → 并集区间（min begin ~ max end）+ 区段数 */
function unionSpan(list: UniprotFeature[]): { range: ResidueRange; segments: number } | null {
  if (!list.length) return null
  let lo = Infinity
  let hi = -Infinity
  for (const f of list) {
    lo = Math.min(lo, f.begin)
    hi = Math.max(hi, f.end)
  }
  if (!(lo >= 1 && hi >= lo)) return null
  return { range: [lo, hi], segments: list.length }
}

/** 描述词命中某正则的全部 features（同类型优先取大跨度代表） */
function featuresMatching(features: UniprotFeature[], re: RegExp): UniprotFeature[] {
  return features.filter(f => f.description && re.test(f.description))
}

/** 别名类匹配（extracellular / cytoplasmic / transmembrane / kinase） */
function matchCanonical(canon: string, features: UniprotFeature[], seqLen: number): DomainRangeMatch | null {
  if (canon === 'extracellular' || canon === 'cytoplasmic') {
    const word = canon === 'extracellular' ? /extracellular/i : /cytoplasmic|cytosolic/i
    const topo = featuresMatching(features, word).filter(f => f.type === 'Topological domain')
    // 取最长的一段（GPCR 的胞外环为多段小区 — 「胞外域」语义指最大连续胞外区段，
    // 通常即 N 端 ectodomain；并集会把跨膜螺旋也圈进来，不可取）
    if (topo.length) {
      const best = topo.reduce((a, b) => (spanOf(b) > spanOf(a) ? b : a))
      return {
        range: [best.begin, Math.min(best.end, seqLen || best.end)],
        term: canon === 'extracellular' ? '胞外域' : '胞内域',
        matched: best.description,
        featureType: 'Topological domain',
        segments: 1,
      }
    }
    // 无拓扑域注释 → Domain/Region 描述含 ecto/extracellular（如 "Ectodomain"）
    const fallbackRe = canon === 'extracellular' ? /ecto|extracellular/i : /cytoplasmic|cytosolic/i
    const fb = featuresMatching(features, fallbackRe)
    if (fb.length) {
      const best = fb.reduce((a, b) => (spanOf(b) > spanOf(a) ? b : a))
      return {
        range: [best.begin, Math.min(best.end, seqLen || best.end)],
        term: canon === 'extracellular' ? '胞外域' : '胞内域',
        matched: best.description,
        featureType: best.type,
        segments: 1,
      }
    }
    return null
  }
  if (canon === 'transmembrane') {
    // 跨膜区：全部 Transmembrane 段并集（7TM 受体的「TM domain」= 跨膜束整体）
    const tms = features.filter(f => f.type === 'Transmembrane')
    const u = unionSpan(tms)
    if (!u) return null
    return {
      range: [u.range[0], Math.min(u.range[1], seqLen || u.range[1])],
      term: '跨膜区',
      matched: `Transmembrane ×${tms.length}`,
      featureType: 'Transmembrane',
      segments: tms.length,
    }
  }
  // kinase：Domain 描述含 kinase（Protein kinase / Tyrosine kinase…），取最长
  const ks = featuresMatching(features, /kinase/i).filter(f => typeRank(f.type) <= 2)
  if (ks.length) {
    const best = ks.reduce((a, b) => (spanOf(b) > spanOf(a) ? b : a))
    return {
      range: [best.begin, Math.min(best.end, seqLen || best.end)],
      term: '激酶域',
      matched: best.description,
      featureType: best.type,
      segments: 1,
    }
  }
  return null
}

/**
 * 结构域名提示 → UniProt feature 区间。
 * @param hint      原始提示 token（如「胞外域」「Kinase domain」「SH2 domain」）
 * @param features  UniProt features（uniprot.ts 产出，含 Domain/Topological domain 等）
 * @param sequenceLength 序列长度（区间上界裁剪；0 = 未知不裁）
 */
export function matchDomainHint(
  hint: string,
  features: UniprotFeature[] | undefined | null,
  sequenceLength: number,
): DomainRangeMatch | null {
  if (!hint) return null
  const raw = hint.trim().slice(0, 80)
  if (raw.length < 2 || !features || features.length === 0) return null
  const seqLen = sequenceLength > 0 ? sequenceLength : 0
  const clampEnd = (r: DomainRangeMatch): DomainRangeMatch => ({
    ...r,
    range: [r.range[0], seqLen ? Math.min(r.range[1], seqLen) : r.range[1]],
  })

  // ① 别名类
  for (const rule of ALIAS_RULES) {
    if (rule.re.test(raw)) {
      const m = matchCanonical(rule.canon, features, seqLen)
      if (m) return clampEnd(m)
    }
  }

  // ② 通用 token：剥掉 domain/结构域/域/区 后取核心词
  const core = raw
    .replace(/(?:\s|\u00a0)+/g, ' ')
    .replace(/\bdomains?\b/gi, ' ')
    .replace(/结构域|结构区|区域/g, ' ')
    .replace(/[域区段]$/u, ' ')
    .trim()
    .slice(0, 40)
  if (core.length >= 2) {
    // 中文核心词 → 英译兜底
    let token = core
    for (const z of ZH_EN) {
      if (z.re.test(core)) {
        token = z.en
        break
      }
    }
    // 大小写不敏感子串匹配（SH2 → "SH2 domain"; TIR → "TIR domain"）
    const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(esc.replace(/\s+/g, '\\s+'), 'i')
    const hits = features.filter(f => f.description && re.test(f.description))
      .filter(f => typeRank(f.type) <= 3)
    if (hits.length) {
      // 同描述多区段（重复域如 Ig-like C2-set ×n）→ 并集；并集跨度过大
      // （>60% 全长 — 疑似错并，如两个相距甚远的 Death 域）时回退最长单区段
      const u = unionSpan(hits)
      if (u) {
        const span = u.range[1] - u.range[0] + 1
        const tooBig = seqLen > 0 && span / seqLen > 0.6
        const best = hits.reduce((a, b) => (spanOf(b) > spanOf(a) ? b : a))
        if (!tooBig && span >= 10) {
          return clampEnd({
            range: u.range,
            term: core,
            matched: best.description,
            featureType: best.type,
            segments: u.segments,
          })
        }
        if (spanOf(best) >= 10) {
          return clampEnd({ range: [best.begin, best.end], term: core, matched: best.description, featureType: best.type, segments: 1 })
        }
      }
    }
  }
  return null
}
