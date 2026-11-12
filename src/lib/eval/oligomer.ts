/**
 * 蛋白聚集形式（寡聚态 / oligomeric state）分析 — v1.24：
 *  评估报告全面性升级：聚集形式是结构解析可行性的关键维度（组装界面、有效分子量、
 *  表达纯化策略、方法适配均受影响）。
 *
 * 证据来源优先级（按用户要求）：
 *  1. 已有结构（PDB 直接命中）：
 *     - 结构标题中的寡聚态关键词（homodimer / heterotetramer / monomeric …）
 *     - UniProt 交叉引用 Chains 化学计量（"A/B=25-646" = 该蛋白在此结构中有 2 个拷贝）
 *  2. 同源结构（BLAST / RCSB 序列检索命中）标题关键词 — 同源推断（标注来源）
 *  3. UniProt interaction 部分：
 *     - SUBUNIT comment（人工审阅的亚基结构描述）
 *     - INTERACTION comments（binary 互作；id1 === id2 为自相互作用 → 同源寡聚证据）
 *  4. 文献（PubMed 标题/摘要关键词）
 *
 * 输出 OligomerAnalysis：判定 + 证据链 + 对结构解析策略的影响要点，
 * 供评分（score.ts）、LLM 报告上下文（report.ts / report-merged.ts）、
 * HTML 报告章节（report-html.ts / report-merged.ts）与前端结果页消费。
 */
import type { BlastHit, LiteratureItem, PdbEntry, UniprotInfo } from './types'

// ─── 寡聚态关键词解析 ─────────────────────────────────────────────────────────

export type OligomerCategory =
  | 'monomer'        // 单体
  | 'homo-oligomer'  // 同源寡聚（相同链多拷贝）
  | 'hetero-complex' // 异源复合物（与其他蛋白装配）
  | 'unknown'

/** 从标题/注释中解析出的寡聚态 */
interface ParsedState {
  category: OligomerCategory
  /** 拷贝数（monomer=1；oligomer 泛指时为 null） */
  copies: number | null
  /** 原始匹配词（展示用） */
  term: string
}

/** 关键词表：按长度降序尝试匹配（homodimer 先于 dimer），词边界防误配 */
const OLIGO_TERMS: Array<{ re: RegExp; state: ParsedState }> = [
  { re: /\b(homo-)?dimer of dimers?\b/i, state: { category: 'homo-oligomer', copies: 4, term: 'dimer of dimers' } },
  { re: /\bhomodimer(s|ic|izes|ization)?\b/i, state: { category: 'homo-oligomer', copies: 2, term: 'homodimer' } },
  { re: /\bheterodimer(s|ic|izes|ization)?\b/i, state: { category: 'hetero-complex', copies: 2, term: 'heterodimer' } },
  { re: /\bhomotetramer(s|ic)?\b|\btetramerization\b/i, state: { category: 'homo-oligomer', copies: 4, term: 'homotetramer' } },
  { re: /\bheterotetramer(s|ic)?\b/i, state: { category: 'hetero-complex', copies: 4, term: 'heterotetramer' } },
  { re: /\btetramer(s|ic)?\b/i, state: { category: 'homo-oligomer', copies: 4, term: 'tetramer' } },
  { re: /\bhomotrimer(s|ic)?\b/i, state: { category: 'homo-oligomer', copies: 3, term: 'homotrimer' } },
  { re: /\bheterotrimer(s|ic)?\b/i, state: { category: 'hetero-complex', copies: 3, term: 'heterotrimer' } },
  { re: /\btrimer(s|ic|ization)?\b/i, state: { category: 'homo-oligomer', copies: 3, term: 'trimer' } },
  { re: /\bhomopentamer(s|ic)?\b/i, state: { category: 'homo-oligomer', copies: 5, term: 'homopentamer' } },
  { re: /\bpentamer(s|ic)?\b/i, state: { category: 'homo-oligomer', copies: 5, term: 'pentamer' } },
  { re: /\bhomohexamer(s|ic)?\b/i, state: { category: 'homo-oligomer', copies: 6, term: 'homohexamer' } },
  { re: /\bhexamer(s|ic)?\b/i, state: { category: 'homo-oligomer', copies: 6, term: 'hexamer' } },
  { re: /\bheptamer(s|ic)?\b/i, state: { category: 'homo-oligomer', copies: 7, term: 'heptamer' } },
  { re: /\boctamer(s|ic)?\b/i, state: { category: 'homo-oligomer', copies: 8, term: 'octamer' } },
  { re: /\bdecamer(s|ic)?\b/i, state: { category: 'homo-oligomer', copies: 10, term: 'decamer' } },
  { re: /\bdodecamer(s|ic)?\b/i, state: { category: 'homo-oligomer', copies: 12, term: 'dodecamer' } },
  { re: /\bdimer(s|ic|izes|ization)?\b/i, state: { category: 'homo-oligomer', copies: 2, term: 'dimer' } },
  { re: /\bmonomer(s|ic)?\b|\bmonomeric\b/i, state: { category: 'monomer', copies: 1, term: 'monomer' } },
  { re: /\boligomer(s|ic|ization)?\b/i, state: { category: 'homo-oligomer', copies: null, term: 'oligomer' } },
]

/** 从一段文本解析寡聚态关键词（首个命中；返回 null 表示无信号） */
export function parseOligoState(text: string): ParsedState | null {
  if (!text) return null
  for (const { re, state } of OLIGO_TERMS) {
    if (re.test(text)) {
      // 标题同时含寡聚词与复合物信号（如 "dimer in complex with inhibitor X"）
      // → 若寡聚词非 hetero 前缀且信号指向蛋白互作，保守归为原有类别
      return { ...state }
    }
  }
  return null
}

// ─── 证据与判定输出 ───────────────────────────────────────────────────────────

export type OligoEvidenceSource =
  | 'pdb-title'          // 直接 PDB 结构标题
  | 'pdb-stoichiometry'  // 直接 PDB 链化学计量（UniProt 交叉引用 Chains）
  | 'blast-title'        // 同源结构标题（同源推断）
  | 'uniprot-subunit'    // UniProt SUBUNIT 注释
  | 'uniprot-interaction'// UniProt INTERACTION（自相互作用）
  | 'literature'         // PubMed 文献标题

export interface OligomerEvidence {
  source: OligoEvidenceSource
  /** 引用标识（PDB ID / PMID / "UniProt SUBUNIT"） */
  ref: string
  /** 证据原文（截断展示） */
  text: string
  /** 解析出的寡聚态 */
  state: ParsedState
}

export interface OligomerAnalysis {
  /** 聚集形式判定汇总（一句话，报告/评分引用），如 "同源二聚体（homodimer）" */
  summary: string
  category: OligomerCategory
  /** 化学计量描述（如 "2 × 相同亚基"；unknown 时为空） */
  stoichiometry: string
  /** 判定置信度 */
  confidence: 'high' | 'medium' | 'low'
  /** 证据链（按上述优先级排序，≤8 条） */
  evidence: OligomerEvidence[]
  /** 对结构解析策略的影响要点（评分依据 + LLM 提示 + 报告展示） */
  notes: string[]
}

export interface OligomerInput {
  uniprot?: UniprotInfo | null
  directPdbs: PdbEntry[]
  blastHits: BlastHit[]
  literature: LiteratureItem[]
}

/** Chains 值（如 "A/B=25-646"、"A/B/C/D=1-240"）→ 该蛋白在结构中的拷贝链数 */
function chainCopies(chains: string | undefined): number | null {
  if (!chains) return null
  const beforeEq = chains.split('=')[0] ?? ''
  const parts = beforeEq.split(/[/,]/).map(s => s.trim()).filter(Boolean)
  if (!parts.length) return null
  return parts.length
}

const NUM_ZH = ['', '', '二', '三', '四', '五', '六', '七', '八', '', '十', '', '十二']
function copiesZh(n: number): string {
  if (n === 1) return '单'
  return NUM_ZH[n] ?? String(n)
}

/** 寡聚态 → 中文描述（summary 用） */
function stateLabel(st: ParsedState): string {
  switch (st.category) {
    case 'monomer': return '单体（monomer）'
    case 'hetero-complex':
      return st.copies ? `异源${copiesZh(st.copies)}聚体（${st.term}）` : '异源复合物'
    case 'homo-oligomer':
      if (st.term === 'self-interaction') return '同源寡聚体（自相互作用，化学计量未定）'
      return st.copies ? `同源${copiesZh(st.copies)}聚体（${st.term}）` : '寡聚体（oligomer，化学计量未定）'
    default: return '未知'
  }
}

/**
 * 分析蛋白聚集形式。
 * 判定优先级：PDB 链化学计量 + 标题（结构证据，最高）→ UniProt SUBUNIT/INTERACTION
 * → 文献标题 → BLAST 同源标题（同源推断，最低）。
 */
export function analyzeOligomericState(input: OligomerInput): OligomerAnalysis {
  const evidence: OligomerEvidence[] = []
  const u = input.uniprot

  // ── 来源 1a：直接 PDB 链化学计量（Chains 多拷贝 = 结构中多拷贝装配）──
  const stoichHits: Array<{ pdbId: string; copies: number; title: string }> = []
  if (u?.pdbChainRanges) {
    for (const p of input.directPdbs) {
      const copies = chainCopies(u.pdbChainRanges[p.pdbId])
      if (copies != null && copies >= 2) {
        stoichHits.push({ pdbId: p.pdbId, copies, title: p.title })
      }
      if (stoichHits.length >= 12) break
    }
  }
  // 拷贝数众数（最常见装配形式）
  if (stoichHits.length) {
    const freq = new Map<number, number>()
    for (const h of stoichHits) freq.set(h.copies, (freq.get(h.copies) ?? 0) + 1)
    const topCopies = [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0]
    for (const h of stoichHits.filter(x => x.copies === topCopies).slice(0, 4)) {
      evidence.push({
        source: 'pdb-stoichiometry',
        ref: h.pdbId,
        text: `结构中该蛋白占 ${h.copies} 条链（UniProt 交叉引用 Chains: ${u!.pdbChainRanges![h.pdbId]}）${h.title ? ` — ${h.title.slice(0, 80)}` : ''}`,
        state: { category: 'homo-oligomer', copies: h.copies, term: `${h.copies} chains` },
      })
    }
  }

  // ── 来源 1b：直接 PDB 标题关键词（含 hetero 复合物形式）──
  const pdbTitleHits: Array<{ pdbId: string; state: ParsedState; title: string }> = []
  for (const p of input.directPdbs) {
    const st = parseOligoState(p.title)
    if (st) pdbTitleHits.push({ pdbId: p.pdbId, state: st, title: p.title })
    if (pdbTitleHits.length >= 12) break
  }
  // 标题证据按类别聚合，各类取最多出现的形态
  if (pdbTitleHits.length) {
    const byTerm = new Map<string, { state: ParsedState; count: number; first: { pdbId: string; title: string } }>()
    for (const h of pdbTitleHits) {
      const cur = byTerm.get(h.state.term)
      if (cur) { cur.count++; continue }
      byTerm.set(h.state.term, { state: h.state, count: 1, first: { pdbId: h.pdbId, title: h.title } })
    }
    const ranked = [...byTerm.entries()].sort((a, b) => b[1].count - a[1].count)
    for (const [, v] of ranked.slice(0, 3)) {
      evidence.push({
        source: 'pdb-title',
        ref: v.first.pdbId,
        text: `结构标题含「${v.state.term}」${v.count > 1 ? `（${v.count} 个结构命中）` : ''} — ${v.first.title.slice(0, 90)}`,
        state: v.state,
      })
    }
  }

  // ── 来源 2：UniProt SUBUNIT（人工审阅注释）──
  const subunitText = u?.subunitText?.trim()
  if (subunitText) {
    const st = parseOligoState(subunitText)
    if (st) {
      evidence.push({
        source: 'uniprot-subunit',
        ref: 'UniProt SUBUNIT',
        text: subunitText.slice(0, 220),
        state: st,
      })
    }
  }

  // ── 来源 3：UniProt INTERACTION 自相互作用 ──
  const selfInteraction = (u?.interactions ?? []).find(i => i.selfInteraction)
  if (selfInteraction) {
    evidence.push({
      source: 'uniprot-interaction',
      ref: `UniProt INTERACTION ${selfInteraction.accession}`,
      text: `UniProt 记录到自相互作用（${selfInteraction.accession} ↔ ${selfInteraction.accession}${selfInteraction.geneName ? `，${selfInteraction.geneName}` : ''}）— 同源寡聚化证据`,
      state: { category: 'homo-oligomer', copies: null, term: 'self-interaction' },
    })
  }

  // ── 来源 4：文献标题 ──
  const litHits: Array<{ l: LiteratureItem; state: ParsedState }> = []
  for (const l of input.literature) {
    const st = parseOligoState(l.title)
    if (st) litHits.push({ l, state: st })
    if (litHits.length >= 6) break
  }
  for (const h of litHits.slice(0, 3)) {
    evidence.push({
      source: 'literature',
      ref: `PMID ${h.l.pmid}`,
      text: h.l.title.slice(0, 120),
      state: h.state,
    })
  }

  // ── 来源 5：BLAST 同源结构标题（同源推断，放最后）──
  if (input.directPdbs.length === 0) {
    const blastHits: Array<{ h: BlastHit; state: ParsedState }> = []
    for (const h of input.blastHits) {
      const st = parseOligoState(h.description)
      if (st) blastHits.push({ h, state: st })
      if (blastHits.length >= 6) break
    }
    for (const b of blastHits.slice(0, 2)) {
      evidence.push({
        source: 'blast-title',
        ref: b.h.pdbId,
        text: `同源结构（identity ${b.h.identity}%）描述含「${b.state.term}」 — ${b.h.description.slice(0, 90)}（同源推断，非本靶蛋白直接证据）`,
        state: b.state,
      })
    }
  }

  // ── 判定：按证据优先级与一致性 ──
  const structural = evidence.filter(e => e.source === 'pdb-title' || e.source === 'pdb-stoichiometry')
  const uniprotEv = evidence.filter(e => e.source === 'uniprot-subunit' || e.source === 'uniprot-interaction')

  let category: OligomerCategory = 'unknown'
  let confidence: OligomerAnalysis['confidence'] = 'low'
  let decided: ParsedState | null = null
  let basis = ''

  if (structural.length) {
    // 结构证据：标题词与链计量一致 → high；单一来源 → medium
    const titleStates = structural.filter(e => e.source === 'pdb-title').map(e => e.state)
    const stoichStates = structural.filter(e => e.source === 'pdb-stoichiometry').map(e => e.state)
    // 异源复合物判定：仅当标题明确含 hetero- 前缀寡聚词（heterodimer/heterotetramer…）。
    // 注意 "in complex with" 不可作为异源信号 — 该短语绝大多数指与小分子/肽段配体的复合
    // （如 "EGFR kinase in complex with erlotinib"），会系统性误判。
    const heteroTitle = titleStates.find(s => s.category === 'hetero-complex')
    if (heteroTitle) {
      category = 'hetero-complex'
      decided = heteroTitle
      confidence = 'high'
      basis = '已有结构（PDB）证据'
    } else {
      const primary = titleStates[0] ?? stoichStates[0]
      decided = primary
      category = primary.category
      const consistent = titleStates.length > 0 && stoichStates.length > 0 &&
        (stoichStates[0].copies == null || titleStates[0].copies == null || stoichStates[0].copies === titleStates[0].copies)
      confidence = titleStates.length && stoichStates.length ? (consistent ? 'high' : 'medium') : 'medium'
      basis = '已有结构（PDB）证据'
    }
  } else if (uniprotEv.length) {
    decided = uniprotEv[0].state
    category = decided.category
    confidence = uniprotEv[0].source === 'uniprot-subunit' ? 'medium' : 'low'
    basis = 'UniProt interaction 注释'
  } else if (evidence.some(e => e.source === 'literature')) {
    decided = evidence.find(e => e.source === 'literature')!.state
    category = decided.category
    confidence = 'low'
    basis = '文献证据'
  } else if (evidence.some(e => e.source === 'blast-title')) {
    decided = evidence.find(e => e.source === 'blast-title')!.state
    category = decided.category
    confidence = 'low'
    basis = '同源结构推断'
  }

  // 混合证据：同源寡聚 + 异源互作并存（如 p53 homotetramer + 与 MDM2 互作）
  const hasHeteroSignal = evidence.some(e => e.state.category === 'hetero-complex') ||
    (u?.interactions ?? []).some(i => !i.selfInteraction)
  const summaryParts: string[] = []
  if (category === 'homo-oligomer' && hasHeteroSignal) {
    summaryParts.push('（同时记录到与其他蛋白的相互作用 — 功能形式可能为同源寡聚体与异源复合物并存）')
  }

  const summary = category === 'unknown'
    ? '聚集形式未获可靠证据（无结构/注释/文献寡聚化信号）'
    : `${stateLabel(decided!)}${summaryParts[0] ?? ''} — 判定依据：${basis}`

  const stoichiometry = category === 'unknown'
    ? ''
    : category === 'monomer'
      ? '1 × 单体'
      : decided!.copies != null
        ? `${decided!.copies} × ${category === 'homo-oligomer' ? '相同亚基' : '不同亚基'}`
        : category === 'hetero-complex' ? '多亚基组装' : '化学计量未定'

  // ── 对结构解析策略的影响要点 ──
  const notes: string[] = []
  const seqLen = u?.sequenceLength ?? 0
  const oligoZh = category === 'homo-oligomer' && decided?.copies
    ? `同源${copiesZh(decided.copies)}聚体`
    : '同源寡聚体'
  switch (category) {
    case 'homo-oligomer': {
      const n = decided?.copies ?? null
      if (structural.length) {
        notes.push(`功能装配形式为${oligoZh}，且已有寡聚体形式的结构先例 — 组装界面已获结构验证，可直接借鉴已有构建边界`)
      } else {
        notes.push(`注释/文献证据表明该蛋白以${oligoZh}形式发挥功能 — 表达纯化后建议 SEC-MALS 验证组装均一性（表观分子量应为单体的${n ?? '多'}倍）`)
      }
      if (seqLen && seqLen < 400 && n && n >= 2) {
        notes.push(`寡聚化使有效分子量增至约 ${Math.round(seqLen * n / 1000)} kDa（单体 ${seqLen} aa × ${n} 拷贝）：对称寡聚体颗粒有利于 Cryo-EM 对齐；NMR 需评估亚基交换展宽`)
      }
      notes.push('构建设计时需保留寡聚化界面（截短边界勿破坏组装结构域/界面残基）')
      break
    }
    case 'hetero-complex': {
      if (structural.length) {
        notes.push('已有异源复合物形式的结构先例 — 可借鉴其共表达/体外组装策略与化学计量比')
      } else {
        notes.push('生物学功能依赖异源复合物装配：全长功能形式的结构解析需共表达或体外组装策略（组装验证 SEC-MALS）')
      }
      notes.push('单独亚基可结晶/可溶的构建可作为第一阶段目标（功能位点的完整诠释仍需复合物结构）')
      notes.push('方法适配：X-ray 需组装后结晶（或 Fab 辅助结晶）；Cryo-EM 对复合物（更大分子量 + 特征形貌）通常更有优势')
      break
    }
    case 'monomer': {
      notes.push('已有结构/注释表明该蛋白以单体形式存在 — 无需组装考量，可溶性构建可直接表达纯化')
      break
    }
    default: {
      notes.push('聚集形式未知：建议表达后以 SEC-MALS / DLS 表征实际聚集状态，并在构建设计时保留潜在寡聚化界面（生物组装可能是可溶性/结晶性的前提）')
    }
  }

  return {
    label: category === 'unknown' ? '未知' : stateLabel(decided!),
    summary,
    category,
    stoichiometry,
    confidence,
    evidence: evidence.slice(0, 8),
    notes,
  }
}

/** 证据来源 → 中文标签（报告表格用） */
export function describeEvidenceSource(s: OligoEvidenceSource): string {
  switch (s) {
    case 'pdb-title': return '已有结构 · 标题'
    case 'pdb-stoichiometry': return '已有结构 · 链化学计量'
    case 'blast-title': return '同源结构 · 标题（推断）'
    case 'uniprot-subunit': return 'UniProt · 亚基注释'
    case 'uniprot-interaction': return 'UniProt · 相互作用'
    case 'literature': return '文献标题'
  }
}

/** category → 中文（前端/报告展示） */
export function describeOligomerCategory(c: OligomerCategory): string {
  switch (c) {
    case 'monomer': return '单体'
    case 'homo-oligomer': return '同源寡聚体'
    case 'hetero-complex': return '异源复合物'
    default: return '未知'
  }

}

/** confidence → 中文 */
export function describeOligoConfidence(c: OligomerAnalysis['confidence']): string {
  return c === 'high' ? '高' : c === 'medium' ? '中' : '低'
}
