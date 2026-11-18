/**
 * UniProt REST 数据访问 — 元数据 + 序列 + 关键 features。
 * 内存策略：一次请求取回整个 JSON，提取小字段后即释放；apiCache 缓存。
 */
import { cachedJsonFetch } from './cache'
import type { UniprotInfo, UniprotFeature, UniprotProcessingChain } from './types'
import { cleanSequence, looksLikeProteinSequence } from './types'

interface UniprotRaw {
  primaryAccession: string
  uniProtkbId?: string
  proteinDescription?: {
    recommendedName?: { fullName?: { value?: string } }
    submissionNames?: Array<{ fullName?: { value?: string } }>
    alternativeNames?: Array<{ fullName?: { value?: string } }>
  }
  genes?: Array<{ geneName?: { value?: string }; synonyms?: Array<{ value?: string }> }>
  organism?: { scientificName?: string; commonName?: string }
  sequence?: { value?: string; length?: number }
  comments?: Array<{
    commentType?: string
    texts?: Array<{ value?: string }>
    subcellularLocations?: Array<{ location?: { value?: string } }>
    /**
     * INTERACTION comment（binary 互作）— 兼容两种格式：
     * 旧版：{ id1, id2, gene2: { geneName: { value } } }
     * 新版（2024+ UniProt REST）：{ interactantOne: { uniProtKBAccession }, interactantTwo: { uniProtKBAccession, geneName: string } }
     */
    interactions?: Array<{
      id1?: string
      id2?: string
      gene2?: { geneName?: { value?: string } }
      interactantOne?: { uniProtKBAccession?: string; intActId?: string }
      interactantTwo?: { uniProtKBAccession?: string; geneName?: string; intActId?: string }
      [k: string]: unknown
    }>
    [k: string]: unknown
  }>
  features?: Array<{ type?: string; description?: string; location?: { start?: { value?: number }; end?: { value?: number } } }>
  keywords?: Array<{ name?: string }>
  entryType?: string
  /** 交叉引用（含 PDB 的 Chains 残基范围，UniProt 编号） */
  uniProtKBCrossReferences?: Array<{
    database?: string
    id?: string
    properties?: Array<{ key?: string; value?: string }>
  }>
}

/** 获取 UniProt 元数据（含序列与 features）。找不到返回 null。 */
export async function fetchUniprotInfo(uniprotId: string): Promise<UniprotInfo | null> {
  const raw = await cachedJsonFetch<UniprotRaw>(
    `https://rest.uniprot.org/uniprotkb/${encodeURIComponent(uniprotId)}.json`,
    { timeoutMs: 20_000 },
  )
  if (!raw || !raw.primaryAccession) return null

  const desc = raw.proteinDescription ?? {}
  const proteinName =
    desc.recommendedName?.fullName?.value
    || desc.submissionNames?.[0]?.fullName?.value
    || desc.alternativeNames?.[0]?.fullName?.value
    || uniprotId

  const geneNames: string[] = []
  for (const g of raw.genes ?? []) {
    if (g.geneName?.value) geneNames.push(g.geneName.value)
    for (const s of g.synonyms ?? []) if (s.value) geneNames.push(s.value)
  }

  const organism =
    raw.organism?.scientificName
    || raw.organism?.commonName
    || 'Unknown'

  const sequence = raw.sequence?.value ?? ''
  const sequenceLength = raw.sequence?.length ?? sequence.length

  // v2.31：PTM/Processing 分子加工条目（UniProt「Molecule processing」— Chain/Peptide
  // features）。聚合蛋白（如 SARS-CoV-2 P0DTD1 Replicase polyprotein 1ab）的蛋白酶
  // 切割产物区段（nsp1-16 等）从这里来 — 评估区间（截短构建/BLAST 推导）据此标注
  // nsp 归属，报告题目区分同名截短靶点。覆盖全长的链 = 条目自身，不算加工产物。
  const processingChains: UniprotProcessingChain[] = []
  for (const f of raw.features ?? []) {
    if (f.type !== 'Chain' && f.type !== 'Peptide') continue
    const begin = f.location?.start?.value ?? 0
    const end = f.location?.end?.value ?? 0
    const name = (f.description ?? '').trim()
    if (!begin || !end || end < begin || !name) continue
    if (begin <= 1 && end >= sequenceLength) continue
    processingChains.push({ name, begin, end })
    if (processingChains.length >= 40) break // 防御上限
  }

  // features：结构域/跨膜/信号肽/活性位点/重复序列等关键类型
  // v2.29：补 Topological domain（胞外域/胞内域等拓扑区段 — 评估表「结构域名 →
  // UniProt domain 匹配」的别名类提示靠它解析，如 P00533 Extracellular 1-621）
  const FEATURE_KEEP = new Set([
    'Domain', 'Signal', 'Transmembrane', 'Active site', 'Binding site',
    'Region', 'Repeat', 'Zinc finger', 'DNA-binding', 'Nucleotide binding',
    'Site', 'Modified residue', 'Disulfide bond', 'Calcium binding',
    'Motif', 'Compositionally biased region', 'Intramembrane',
    'Topological domain',
  ])
  const features: UniprotFeature[] = []
  for (const f of raw.features ?? []) {
    if (!f.type || !FEATURE_KEEP.has(f.type)) continue
    const begin = f.location?.start?.value ?? 0
    const end = f.location?.end?.value ?? 0
    if (!begin || !end) continue
    features.push({ type: f.type, description: f.description ?? '', begin, end })
    if (features.length >= 120) break // 防超长蛋白撑爆 prompt
  }

  let functionText = ''
  let subcellularLocations: string[] = []
  let subunitText = ''
  const interactions: Array<{ accession: string; geneName?: string; selfInteraction: boolean }> = []
  for (const c of raw.comments ?? []) {
    if (c.commentType === 'FUNCTION' && !functionText) {
      functionText = (c.texts ?? []).map(t => t.value ?? '').join(' ').slice(0, 1500)
    }
    if (c.commentType === 'SUBCELLULAR LOCATION') {
      subcellularLocations = (c.subcellularLocations ?? [])
        .map(l => l.location?.value ?? '')
        .filter(Boolean)
        .slice(0, 8)
    }
    // v1.24：SUBUNIT 亚基结构注释 — 聚集形式（寡聚态）分析的核心注释证据
    if (c.commentType === 'SUBUNIT' && !subunitText) {
      subunitText = (c.texts ?? []).map(t => t.value ?? '').join(' ').slice(0, 1200)
    }
    // v1.24：INTERACTION binary 互作 — 自相互作用（id1 === id2）为同源寡聚证据
    // v1.26：兼容新版 REST 格式（interactantOne/Two），旧版（id1/id2/gene2）一并保留
    if (c.commentType === 'INTERACTION') {
      for (const it of c.interactions ?? []) {
        // 旧版：id1 / id2 / gene2.geneName.value
        const id1Old = (it.id1 ?? '').trim()
        const id2Old = (it.id2 ?? '').trim()
        // 新版：interactantOne/Two.uniProtKBAccession；geneName 为字符串
        const id1New = (it.interactantOne?.uniProtKBAccession ?? '').trim()
        const id2New = (it.interactantTwo?.uniProtKBAccession ?? '').trim()
        const id1 = id1Old || id1New
        const id2 = id2Old || id2New
        if (!id1 || !id2) continue
        const geneName = it.gene2?.geneName?.value || it.interactantTwo?.geneName || undefined
        const selfInteraction = id1 === id2
        // 同一伙伴去重；自相互作用优先保留；伙伴总数限 25（防超长蛋白撑爆存储）
        if (!selfInteraction && interactions.some(x => x.accession === id2 && !x.selfInteraction)) continue
        interactions.push({ accession: id2, geneName: geneName || undefined, selfInteraction })
        if (interactions.length >= 25) break
      }
    }
  }

  const keywords = (raw.keywords ?? []).map(k => k.name ?? '').filter(Boolean).slice(0, 30)

  // PDB 交叉引用 → UniProt 残基编号范围（Chains 属性，如 "A=695-1022"、"A/B=25-646"）。
  // 供 PDB 结构表展示「该结构覆盖靶点序列的哪一段」。
  const pdbChainRanges: Record<string, string> = {}
  // v1.29：ComplexPortal 交叉引用（CPX-xxxx，complex viewer 数据源）— 无直接结构时的
  // 互作复合物证据入口（用户反馈：Complex viewer 复合物可靠，组分结构可作评估依据）
  const complexPortalIds: string[] = []
  for (const x of raw.uniProtKBCrossReferences ?? []) {
    if (x.database !== 'PDB') continue
    const pdbId = (x.id ?? '').toUpperCase()
    if (!/^[0-9A-Z]{4}$/.test(pdbId)) continue
    const chains = (x.properties ?? []).find(p => p.key === 'Chains')?.value?.trim()
    if (chains) pdbChainRanges[pdbId] = chains
    if (Object.keys(pdbChainRanges).length >= 500) break // 防御上限
  }
  for (const x of raw.uniProtKBCrossReferences ?? []) {
    if (x.database !== 'ComplexPortal') continue
    const cpx = (x.id ?? '').trim().toUpperCase()
    if (/^CPX-\d+$/.test(cpx) && !complexPortalIds.includes(cpx)) complexPortalIds.push(cpx)
    if (complexPortalIds.length >= 6) break
  }

  return {
    uniprotId: raw.primaryAccession,
    entryName: raw.uniProtkbId ?? uniprotId,
    proteinName,
    geneNames: [...new Set(geneNames)].slice(0, 6),
    organism,
    sequenceLength,
    sequence,
    functionText,
    subcellularLocations,
    subunitText: subunitText || undefined,
    interactions: interactions.length ? interactions : undefined,
    complexPortalIds: complexPortalIds.length ? complexPortalIds : undefined,
    features,
    keywords,
    pdbChainRanges,
    processingChains: processingChains.length ? processingChains : undefined,
  }
}

// ─── v2.31：评估区间 → PTM/Processing 加工条目归属 ───────────────────────────

/** 加工产物名中的 nsp 编号 — 两种命名风格：
 *  "RNA-directed RNA polymerase nsp12" / "nsP1"（显式 nspN）
 *  "Non-structural protein 6"（冠状病毒聚合蛋白的常见写法，无 nsp 字样） */
const NSP_NUM_RE = /nsp\s*0*(\d{1,2})/i
const NSP_NUM_RE2 = /non-?structural\s+protein\s*0*(\d{1,2})/i

function nspNumOf(name: string): number | undefined {
  const m = NSP_NUM_RE.exec(name) ?? NSP_NUM_RE2.exec(name)
  return m ? Number(m[1]) : undefined
}

/** 评估区间与加工条目的归属匹配结果 */
export interface ProcessingSegmentMatch {
  /** 与评估区间重叠的加工条目（begin 升序） */
  segments: UniprotProcessingChain[]
  /** 各段名中解析出的 nsp 编号（与 segments 一一对应；无名者 undefined） */
  nspNumbers: Array<number | undefined>
  /** 标题 nsp 标注：所有匹配段均带 nsp 编号时生成（"nsp5" / "nsp5-nsp9" / "nsp3/nsp5"） */
  nspLabel?: string
  /** 展示/LLM 用说明（如 "RNA-directed RNA polymerase nsp12（残基 4393-5324）"） */
  note: string
}

/**
 * v2.31：评估区间（截短构建/BLAST 推导）→ 聚合蛋白加工条目归属。
 *
 * 背景：同一 UniProt 条目（如 SARS-CoV-2 P0DTD1 Replicase polyprotein 1ab）的
 * 不同截短构建题目全部同名 — 从 UniProt PTM/Processing 的分子加工注释识别
 * 蛋白酶切割产物区段（nsp1-16 的残基范围），将评估区间覆盖的 nsp 标注到
 * 报告题目（「Replicase polyprotein 1ab nsp12」），区分同名截短靶点。
 *
 * 边界口径：区间与区段重叠 ≥5 aa 且 ≥ 区段长 5% 才算覆盖（BLAST 比对端点
 * 抖动/标签头残留导致的少量越界不误判）；近全长（≥98%）提交不标注。
 */
export function matchProcessingSegments(
  range: Readonly<[number, number]> | null | undefined,
  chains: readonly UniprotProcessingChain[] | null | undefined,
  fullLength?: number,
): ProcessingSegmentMatch | null {
  if (!range || !chains || chains.length < 2) return null
  // 近全长提交（覆盖 ≥98% 全序列）与全长无实质差别 — 不标注
  if (fullLength && fullLength > 0 && range[1] - range[0] + 1 >= fullLength * 0.98) return null
  const segments = chains
    .filter(c => {
      const segLen = c.end - c.begin + 1
      const ov = Math.min(range[1], c.end) - Math.max(range[0], c.begin) + 1
      return ov > 0 && ov >= 5 && ov >= segLen * 0.05
    })
    .sort((a, b) => a.begin - b.begin)
  if (!segments.length) return null

  const nspNumbers = segments.map(c => nspNumOf(c.name))

  // nsp 标注：所有匹配段都带编号时生成（连续编号合并为区间，断档用 / 分隔）
  let nspLabel: string | undefined
  if (nspNumbers.every(n => n != null)) {
    const nums = [...new Set(nspNumbers.filter((n): n is number => n != null))].sort((a, b) => a - b)
    const parts: string[] = []
    let i = 0
    while (i < nums.length) {
      let j = i
      while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++
      parts.push(i === j ? `nsp${nums[i]}` : `nsp${nums[i]}-nsp${nums[j]}`)
      i = j + 1
    }
    nspLabel = parts.join('/')
  }

  const segText = segments
    .slice(0, 8)
    .map(c => `${c.name}（残基 ${c.begin}-${c.end}）`)
    .join('、') + (segments.length > 8 ? ` 等 ${segments.length} 段` : '')
  const note = nspLabel
    ? `评估区间归属 ${nspLabel}：${segText}`
    : `评估区间覆盖加工产物：${segText}`

  return { segments, nspNumbers, nspLabel, note }
}

/** 若序列未知来源，尝试用 BLAST 式的 UniProt 精确肽段搜索定位 accession（best effort）。 */
export async function identifyUniprotBySequence(seq: string): Promise<string | null> {
  // UniProt peptide search（peptide search API 更轻，但需要 async 轮询；这里用
  // 更简单的方案：取序列前 30aa 在 UniProt search API 的全文检索中试一次，
  // 命中且长度高度一致才返回）。失败直接 null —— 真正的识别由 BLAST 阶段兜底。
  try {
    const q = seq.slice(0, 25)
    const url = `https://rest.uniprot.org/uniprotkb/search?query=${encodeURIComponent(`"${q}"`)}&fields=accession,length&format=json&size=3`
    const raw = await cachedJsonFetch<{ results?: Array<{ primaryAccession: string; sequence?: { length?: number } }> }>(url, { timeoutMs: 12_000 })
    const hits = raw?.results ?? []
    for (const h of hits) {
      if (h.primaryAccession && Math.abs((h.sequence?.length ?? 0) - seq.length) <= 5) {
        return h.primaryAccession
      }
    }
    return null
  } catch {
    return null
  }
}

/** 校验并规整化用户输入的序列 */
export function normalizeSequenceInput(input: string): { ok: boolean; seq: string; header: string; length: number } {
  const { seq, header } = cleanSequence(input)
  const ok = looksLikeProteinSequence(seq)
  return { ok, seq, header, length: seq.length }
}
