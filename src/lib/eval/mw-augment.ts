/**
 * 分子量增重策略分析（v1.26 / v1.27）— 小分子量靶点（单体 < 50 kDa）的结构解析可行性关键维度：
 *
 * 用户需求：
 *  - 单体分子量较小时，需考虑如何增加样品分子量（Cryo-EM 颗粒尺寸/数据采集的关键门槛）
 *  - 已有复合物结构：统计所有组分的总分子量（RCSB 生物装配 / 实体口径）
 *  - 根据装配/复合物的总分子量综合衡量各方法可行性（评分由 score.ts 的
 *    computeMwAugmentAdjust 消费 — 装配 MW 接管聚集形式维度的 Cryo-EM 分量）
 *  - 同时评估加入的组分（生理伙伴 / Fab / 融合标签）是否与客户目的冲突
 *
 * 增重路径（按证据强度）：
 *  1. complex — 已有复合物结构（RCSB 实体/装配数据；含 PDB 内的技术性组分先例如 Fab/MBP）
 *  2. oligomer — 自身寡聚（oligomer.ts 的拷贝数 → 有效 MW = N × 单体）
 *  3. homolog-complex（v1.27）— 同源复合物推断：单体小且上述直接路径装配均不足
 *     50 kDa 时，经 BLAST 同源命中扩展检索 RCSB 装配，若同源结构形成 ≥50 kDa
 *     复合物/寡聚装配，则将同源亚基尺寸按靶点单体换算后作为装配 MW 估计
 *     （寡聚状态/互作界面在同一家族内常保守，需实验验证）
 *  4. partner — UniProt 互作伙伴（1:1 假设的二元素装配估计，无结构先例）
 * 取可用路径中装配分子量最高者作为 assemblyKda；技术工具箱（Fab/nanobody/MBP/ferritin）
 * 作为兜底策略在 notes/options 中给出。
 *
 * 网络访问：UniProt 伙伴长度批量查询 + RCSB GraphQL（装配/实体；直接复合物与
 * 同源扩展两阶段），全部防御式降级，失败不阻塞主管线（返回已有数据 + 说明）。
 */
import { cachedJsonFetch } from './cache'
import type {
  BlastHit,
  MwAugmentAnalysis,
  MwAugmentOption,
  MwComplex,
  MwComponent,
  MwConflictNote,
  MwHomologComplex,
  OligomerAnalysis,
  PdbEntry,
  UniprotInfo,
} from './types'

/** 平均残基分子量 ≈ 110 Da */
export const AA_KDA = 0.11
/** 小分子量靶点判定阈值（单体 kDa）— 低于此值 Cryo-EM 需增重策略 */
export const SMALL_MONOMER_KDA = 50
/** Cryo-EM 常规可行门槛（装配 kDa）*/
const EM_ROUTINE_KDA = 100
/** Cryo-EM 边缘区间下限（装配 kDa，需 VPP/优化条件）*/
const EM_MARGINAL_KDA = 50

export function aaToKda(aa: number): number {
  return Math.round(aa * AA_KDA * 10) / 10
}

// ─── 数据获取：UniProt 互作伙伴长度（批量）──────────────────────────────

export interface PartnerMwInfo {
  accession: string
  geneName?: string
  proteinName?: string
  lengthAa?: number
}

const MAX_PARTNERS_FETCH = 12

/** 批量获取互作伙伴的序列长度（UniProt REST search；accession OR 查询） */
export async function fetchPartnerLengths(uniprot: UniprotInfo | null | undefined): Promise<PartnerMwInfo[]> {
  const partners = (uniprot?.interactions ?? []).filter(i => !i.selfInteraction).slice(0, MAX_PARTNERS_FETCH)
  if (!partners.length) return []
  const accessions = [...new Set(partners.map(p => p.accession).filter(Boolean))]
  if (!accessions.length) return []
  const query = `accession:(${accessions.join(' OR ')})`
  const url = `https://rest.uniprot.org/uniprotkb/search?query=${encodeURIComponent(query)}&fields=accession,length,protein_name,gene_names&format=json&size=${MAX_PARTNERS_FETCH}`
  interface PartnerRaw {
    primaryAccession?: string
    sequence?: { length?: number }
    proteinDescription?: { recommendedName?: { fullName?: { value?: string } } }
    genes?: Array<{ geneName?: { value?: string } }>
  }
  try {
    const raw = await cachedJsonFetch<{ results?: PartnerRaw[] }>(url, { timeoutMs: 15_000 })
    const byId = new Map<string, PartnerMwInfo>()
    for (const r of raw?.results ?? []) {
      const acc = r.primaryAccession ?? ''
      if (!acc) continue
      const gn = r.genes?.find(g => g.geneName?.value)?.geneName?.value
      byId.set(acc, {
        accession: acc,
        geneName: gn || partners.find(p => p.accession === acc)?.geneName,
        proteinName: r.proteinDescription?.recommendedName?.fullName?.value?.slice(0, 60),
        lengthAa: r.sequence?.length,
      })
    }
    // 未查到的伙伴保留占位（长度未知）
    return partners.map(p => byId.get(p.accession) ?? {
      accession: p.accession,
      geneName: p.geneName,
      proteinName: undefined,
      lengthAa: undefined,
    })
  } catch {
    return partners.map(p => ({ accession: p.accession, geneName: p.geneName }))
  }
}

// ─── 数据获取：RCSB 复合物装配（GraphQL 批量）───────────────────────────

export interface ComplexAssemblyInfo {
  pdbId: string
  title: string
  method: string
  resolution: number | null
  /** 去重蛋白实体（描述 + 序列长度 + uniprot） */
  entities: Array<{ description: string; lengthAa: number; uniprotIds: string[] }>
  /** 生物装配分子量（RCSB formula_weight，kDa 单位；缺失时为 null） */
  assemblyWeightKda: number | null
  /** 装配计量描述（如 homotetrameric） */
  oligomericDetails: string | null
}

const RCSB_GRAPHQL = 'https://data.rcsb.org/graphql'

/** 鉴别技术性组分（助构/增重标签）的描述词 */
const ARTIFICIAL_RE = /\b(fab|fab\s*fragment|scfv|nanobody|vhhl?|mbp|maltose[\s-]?binding|ferritin|sumo[\s-]?fusion|gst|glutathione|his[\s-]?tag|semb|antibody)\b/i

/** 完整查询（实体 + 装配）；字段不存在时由调用方降级到最小查询 */
const FULL_QUERY = `query($ids:[String!]!){
  entries(entry_ids:$ids){
    rcsb_id
    struct { title }
    exptl { method }
    rcsb_entry_info { resolution_combined }
    polymer_entities {
      rcsb_polymer_entity_container_identifiers { uniprot_ids auth_asym_ids }
      rcsb_polymer_entity { pdbx_description }
      entity_poly { pdbx_seq_one_letter_code_can type }
    }
    assemblies {
      pdbx_struct_assembly { oligomeric_details oligomeric_count }
      rcsb_assembly_info { formula_weight polymer_entity_instance_count }
    }
  }
}`

/** 最小查询（仅实体 — 字段集合最保守，作为完整查询失败时的降级） */
const MIN_QUERY = `query($ids:[String!]!){
  entries(entry_ids:$ids){
    rcsb_id
    struct { title }
    exptl { method }
    rcsb_entry_info { resolution_combined }
    polymer_entities {
      rcsb_polymer_entity_container_identifiers { uniprot_ids }
      rcsb_polymer_entity { pdbx_description }
      entity_poly { pdbx_seq_one_letter_code_can type }
    }
  }
}`

interface GqlEntry {
  rcsb_id?: string
  struct?: { title?: string }
  exptl?: Array<{ method?: string }>
  rcsb_entry_info?: { resolution_combined?: number[] }
  polymer_entities?: Array<{
    rcsb_polymer_entity_container_identifiers?: { uniprot_ids?: string[]; auth_asym_ids?: string[] }
    rcsb_polymer_entity?: { pdbx_description?: string }
    entity_poly?: { pdbx_seq_one_letter_code_can?: string; type?: string }
  }>
  assemblies?: Array<{
    pdbx_struct_assembly?: { oligomeric_details?: string; oligomeric_count?: number }
    rcsb_assembly_info?: { formula_weight?: number; polymer_entity_instance_count?: number }
  }>
}

type GqlAssembly = NonNullable<GqlEntry['assemblies']>[number]

async function gqlEntries(pdbIds: string[], query: string, signal?: AbortSignal): Promise<GqlEntry[]> {
  if (!pdbIds.length) return []
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const res = await fetch(RCSB_GRAPHQL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { ids: pdbIds } }),
      signal: controller.signal,
    })
    if (!res.ok) return []
    const data = await res.json() as { data?: { entries?: GqlEntry[] } }
    return data.data?.entries ?? []
  } catch {
    return []
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * 拉取候选复合物结构的实体/装配组成（RCSB GraphQL）。
 * 候选：directPdbs 中标题含异源寡聚词/复合物信号的条目，按分辨率优先，上限 24
 * （小分子 "in complex with" 条目占多数 — 大样本量保证真蛋白复合物进入实体判定）。
 * GraphQL 12 id/批，最多 2 批。
 */
export async function fetchComplexAssemblyInfo(
  pdbs: PdbEntry[],
  signal?: AbortSignal,
): Promise<Map<string, ComplexAssemblyInfo>> {
  // 候选筛选：标题含 hetero 寡聚词（蛋白-蛋白装配的直接信号）
  const heteroRe = /\bhetero(dimer|trimer|tetramer|pentamer|hexamer|oligomer|complex)\b/i
  const complexRe = /\bcomplex (with|of)\b/i
  const candidates = pdbs
    .filter(p => heteroRe.test(p.title) || complexRe.test(p.title))
    .sort((a, b) => (a.resolution ?? 99) - (b.resolution ?? 99))
    .slice(0, 24)
  if (!candidates.length) return new Map()

  const out = new Map<string, ComplexAssemblyInfo>()
  const ids = candidates.map(p => p.pdbId)
  let entries: GqlEntry[] = []
  const BATCH = 12
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH)
    let got = await gqlEntries(chunk, FULL_QUERY, signal)
    if (!got.length) got = await gqlEntries(chunk, MIN_QUERY, signal)
    if (got.length) entries = entries.concat(got)
    if (signal?.aborted) break
  }

  for (const e of entries) {
    const pdbId = String(e.rcsb_id ?? '').toUpperCase()
    if (!/^[0-9A-Z]{4}$/.test(pdbId)) continue
    const entities: ComplexAssemblyInfo['entities'] = []
    for (const pe of e.polymer_entities ?? []) {
      // 仅计蛋白实体（polypeptide）— 排除 DNA/RNA（如 p53-DNA 复合物中的核酸）
      if (pe.entity_poly?.type != null && !/polypeptide/i.test(pe.entity_poly.type)) continue
      const seq = pe.entity_poly?.pdbx_seq_one_letter_code_can ?? ''
      // 序列清洗：去空白后计残基
      const len = seq.replace(/\s+/g, '').length
      if (len < 30) continue // 短肽不计入增重组分
      entities.push({
        description: pe.rcsb_polymer_entity?.pdbx_description?.slice(0, 60) ?? 'polymer entity',
        lengthAa: len,
        uniprotIds: (pe.rcsb_polymer_entity_container_identifiers?.uniprot_ids ?? []).map(u => u.toUpperCase()),
      })
    }
    const assembly = e.assemblies?.find(a => (a.rcsb_assembly_info?.formula_weight ?? 0) > 0)
    out.set(pdbId, {
      pdbId,
      title: e.struct?.title ?? candidates.find(p => p.pdbId === pdbId)?.title ?? '',
      method: e.exptl?.[0]?.method ?? '',
      resolution: e.rcsb_entry_info?.resolution_combined?.[0] ?? candidates.find(p => p.pdbId === pdbId)?.resolution ?? null,
      entities,
      // formula_weight 单位为 kDa（RCSB 装配页同源字段）
      assemblyWeightKda: assembly?.rcsb_assembly_info?.formula_weight ?? null,
      oligomericDetails: assembly?.pdbx_struct_assembly?.oligomeric_details ?? null,
    })
  }
  return out
}

// ─── v1.27：同源复合物扩展检索（BLAST 命中 → RCSB 装配）─────────────────

/** 同源复合物检索结果条目（fetchHomologComplexInfo 产出 → buildMwAugmentAnalysis 消费） */
export interface HomologComplexInfo extends ComplexAssemblyInfo {
  /** BLAST 同源 identity（%） */
  identity: number
  /** 同源复合物自身装配总分子量（kDa；RCSB 装配权重缺失时为实体口径估计） */
  totalKda: number
  /** 估计口径：assembly = RCSB 生物装配；entity = 拷贝数×实体/去重实体 */
  basis: 'assembly' | 'entity'
  /** 按靶点单体换算的估计装配分子量（kDa） */
  estimatedKda: number
  /** 组分摘要（展示用） */
  componentSummary: string
  /** 是否同源寡聚装配（单一种类蛋白实体多拷贝） */
  isHomoOligomer: boolean
  /** 推断说明 */
  note: string
}

/** 同源检索的最小 identity（%）— 低于此值复合物形成倾向的推断不可靠 */
const HOMOLOG_MIN_IDENTITY = 25

/** 复合物/寡聚标题信号（候选优先级提升用） */
const COMPLEX_SIGNAL_RE = /\b(hetero(?:dimer|trimer|tetramer|pentamer|hexamer|oligomer|complex)|complex (?:with|of)|homo(?:dimer|trimer|tetramer|pentamer|hexamer|oligomer)|(?:^|\s)(?:di|tri|tetra|penta|hexa|hepta|octa)mer(?:ic|ic)?\b)/i

/** 寡聚计量词 → 拷贝数 */
const COPY_PREFIX: Record<string, number> = {
  di: 2, tri: 3, tetra: 4, penta: 5, hexa: 6, hepta: 7, octa: 8, nona: 9, deca: 10, undeca: 11, dodeca: 12,
}

/** 从 oligomeric_details 解析同源寡聚拷贝数（如 "homotetrameric" → 4） */
export function parseHomoCopies(details: string | null | undefined): number | null {
  if (!details) return null
  const d = details.toLowerCase()
  if (!d.includes('homo')) return null
  const mNum = d.match(/homo\s*(\d+)\s*-?\s*mer/)
  if (mNum) {
    const n = parseInt(mNum[1], 10)
    return n >= 2 && n <= 24 ? n : null
  }
  const mWord = d.match(/homo(di|tri|tetra|penta|hexa|hepta|octa|nona|deca|undeca|dodeca)mer/)
  if (mWord) return COPY_PREFIX[mWord[1]] ?? null
  return null // "homo-oligomeric" 等数量未知
}

/**
 * v1.27：经 BLAST 同源命中扩展检索大复合物（≥50 kDa 装配）。
 *
 * 触发条件（analyzeMwAugmentation 内判定）：小分子量靶点 且 直接路径
 * （已有复合物/自身寡聚/互作伙伴）装配均不足 50 kDa。
 *
 * 候选选择：identity 前 8 + 复合物/寡聚标题信号补充 8（去重后上限 16，GraphQL 12 id/批）。
 * 换算口径：同源亚基尺寸替换为靶点单体 —
 *  - 同源寡聚装配：估计 = 拷贝数 × 靶点单体
 *  - 同源异源复合物：估计 = 同源装配总 MW − 同源亚基（单拷贝）+ 靶点单体
 * 仅保留换算后 ≥50 kDa 的条目（按估计装配分子量降序，取前 6）。
 */
export async function fetchHomologComplexInfo(
  blastHits: BlastHit[],
  directPdbIds: Set<string>,
  sequenceLength: number,
  signal?: AbortSignal,
): Promise<{ searched: number; complexes: HomologComplexInfo[] }> {
  const seen = new Set<string>()
  const pool = blastHits.filter(b => {
    const id = b.pdbId.toUpperCase()
    if (seen.has(id)) return false
    seen.add(id)
    return b.identity >= HOMOLOG_MIN_IDENTITY && !directPdbIds.has(id)
  })
  if (!pool.length) return { searched: 0, complexes: [] }

  // 候选：高 identity 优先（推断力最强）+ 标题含复合物/寡聚信号的补充（更可能是大装配）
  const topByIdentity = [...pool].sort((a, b) => b.identity - a.identity).slice(0, 8)
  const topIn = new Set(topByIdentity.map(b => b.pdbId.toUpperCase()))
  const topBySignal = pool
    .filter(b => !topIn.has(b.pdbId.toUpperCase()) && COMPLEX_SIGNAL_RE.test(b.description))
    .sort((a, b) => b.identity - a.identity)
    .slice(0, 8)
  const candidates = [...topByIdentity, ...topBySignal].slice(0, 16)
  if (!candidates.length) return { searched: 0, complexes: [] }

  const hitById = new Map(candidates.map(b => [b.pdbId.toUpperCase(), b]))

  // GraphQL 批量拉取（12 id/批）
  const ids = candidates.map(b => b.pdbId.toUpperCase())
  let entries: GqlEntry[] = []
  const BATCH = 12
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH)
    let got = await gqlEntries(chunk, FULL_QUERY, signal)
    if (!got.length) got = await gqlEntries(chunk, MIN_QUERY, signal)
    if (got.length) entries = entries.concat(got)
    if (signal?.aborted) break
  }
  if (!entries.length) return { searched: 0, complexes: [] }

  const monomerKda = aaToKda(sequenceLength)
  const out: HomologComplexInfo[] = []

  for (const e of entries) {
    const pdbId = String(e.rcsb_id ?? '').toUpperCase()
    const hit = hitById.get(pdbId)
    if (!hit || !/^[0-9A-Z]{4}$/.test(pdbId)) continue

    // 蛋白实体（≥30 aa，排除核酸/短肽）→ 按种类去重（uniprot 或描述）
    const groups = new Map<string, { desc: string; len: number; uniprot: string }>()
    for (const pe of e.polymer_entities ?? []) {
      if (pe.entity_poly?.type != null && !/polypeptide/i.test(pe.entity_poly.type)) continue
      const len = (pe.entity_poly?.pdbx_seq_one_letter_code_can ?? '').replace(/\s+/g, '').length
      if (len < 30) continue
      const uniprot = (pe.rcsb_polymer_entity_container_identifiers?.uniprot_ids ?? [])[0]?.toUpperCase() ?? ''
      const desc = pe.rcsb_polymer_entity?.pdbx_description ?? 'polymer entity'
      const key = uniprot || desc.slice(0, 40)
      if (!groups.has(key)) groups.set(key, { desc, len, uniprot })
    }
    if (!groups.size) continue

    // 装配：取 formula_weight 最大的生物装配
    const bestAssembly = (e.assemblies ?? []).reduce<GqlAssembly | undefined>(
      (best, a) => ((a.rcsb_assembly_info?.formula_weight ?? 0) > (best?.rcsb_assembly_info?.formula_weight ?? 0) ? a : best),
      undefined,
    )
    const fw = bestAssembly?.rcsb_assembly_info?.formula_weight ?? null
    const details = bestAssembly?.pdbx_struct_assembly?.oligomeric_details ?? null
    const oligoCount = bestAssembly?.pdbx_struct_assembly?.oligomeric_count ?? null
    const instanceCount = bestAssembly?.rcsb_assembly_info?.polymer_entity_instance_count ?? null

    const list = [...groups.values()]
    let totalKda: number
    let basis: 'assembly' | 'entity'
    let estimatedKda: number
    let componentSummary: string
    let note: string
    let isHomoOligomer: boolean

    if (list.length === 1) {
      // ── 同源寡聚装配：估计 = 拷贝数 × 靶点单体 ──
      const sole = list[0]
      const entityKda = aaToKda(sole.len)
      const copies = oligoCount
        ?? parseHomoCopies(details)
        ?? (fw != null && fw > 0 && entityKda > 0 ? Math.max(2, Math.round(fw / entityKda)) : null)
        ?? (instanceCount != null && instanceCount >= 2 ? instanceCount : null)
      if (copies == null || copies < 2 || copies > 24) continue // 无法证明多聚装配 → 不构成增重路径
      totalKda = fw != null && fw > 0 ? Math.round(fw * 10) / 10 : Math.round(copies * entityKda)
      basis = fw != null && fw > 0 ? 'assembly' : 'entity'
      estimatedKda = Math.round(monomerKda * copies)
      componentSummary = `${copies} × 同源亚基（~${entityKda} kDa/链${sole.desc ? ` · ${sole.desc.slice(0, 26)}` : ''}）`
      isHomoOligomer = true
      note = `同源寡聚装配（${details ?? `${copies} 聚体`}）— 对称装配界面在同源家族内常保守（identity ${Math.round(hit.identity)}%），靶点寡聚化需 SEC-MALS 验证`
    } else {
      // ── 同源异源复合物：同源实体 = 长度最接近查询序列的种类；估计 = 总 MW − 同源亚基 + 靶点单体（单拷贝） ──
      const sorted = [...list].sort((a, b) => Math.abs(a.len - sequenceLength) - Math.abs(b.len - sequenceLength))
      const homologEntity = sorted[0]
      const partners = sorted.slice(1)
      const entitySumKda = aaToKda(list.reduce((s, g) => s + g.len, 0))
      totalKda = fw != null && fw > 0 ? Math.round(fw * 10) / 10 : entitySumKda
      basis = fw != null && fw > 0 ? 'assembly' : 'entity'
      const homologKda = aaToKda(homologEntity.len)
      // 同源亚基替换为靶点单体（按单拷贝估计；其余组分保持同源尺寸）
      estimatedKda = Math.round((totalKda - homologKda + monomerKda) * 10) / 10
      const hasArtificial = partners.some(p => ARTIFICIAL_RE.test(p.desc))
      componentSummary = `同源亚基（~${homologKda} kDa${homologEntity.desc ? ` · ${homologEntity.desc.slice(0, 24)}` : ''}）+ ${partners.map(p => `${p.desc.slice(0, 24)}（~${aaToKda(p.len)} kDa）`).join(' + ')}`
      isHomoOligomer = false
      note = hasArtificial
        ? `同源复合物含技术性组分（Fab/标签等）— 该家族已有伴侣增重先例；针对靶点的 Fab/标签需另行开发`
        : `同源异源复合物（identity ${Math.round(hit.identity)}%）— 靶点与对应伙伴的互作未经验证，共表达前建议 pull-down/SPR 确认`
    }

    if (estimatedKda < EM_MARGINAL_KDA) continue // 换算后仍不足 50 kDa → 不构成有效增重路径
    out.push({
      pdbId,
      title: e.struct?.title ?? hit.description ?? '',
      method: e.exptl?.[0]?.method ?? '',
      resolution: e.rcsb_entry_info?.resolution_combined?.[0] ?? hit.resolution ?? null,
      entities: list.map(g => ({ description: g.desc, lengthAa: g.len, uniprotIds: g.uniprot ? [g.uniprot] : [] })),
      assemblyWeightKda: fw,
      oligomericDetails: details,
      identity: hit.identity,
      totalKda,
      basis,
      estimatedKda,
      componentSummary,
      isHomoOligomer,
      note,
    })
  }

  out.sort((a, b) => b.estimatedKda - a.estimatedKda || b.identity - a.identity)
  return { searched: entries.length, complexes: out.slice(0, 6) }
}

// ─── 技术增重工具箱（小靶点场景；常量定义）──────────────────────────────

const TECH_OPTIONS: MwAugmentOption[] = [
  { name: 'Fab 抗体片段', addKda: '+~25 kDa/个', note: '经典结晶伴侣 + Cryo-EM 增重双用途；需先获得结合该靶点的 Fab（杂交瘤/合成文库，开发周期数月）；结合表位可能影响构象状态解读' },
  { name: 'Nanobody / VHH', addKda: '+~13-15 kDa/个', note: '体积小于 Fab、亲和力高、易表达；增重幅度有限，常需 2 价/多价串联使用；开发依赖免疫羊驼/合成文库' },
  { name: 'MBP 融合标签', addKda: '+~42 kDa', note: '表达增溶 + X-ray 载体结晶两用；柔性 linker 处异质性对 Cryo-EM 不利（Cryo-EM 场景建议刚性 linker 或蛋白酶切后复合）；结构解读需区分标签界面' },
  { name: '铁蛋白（ferritin）支架融合', addKda: '~480 kDa（24 聚体）', note: 'Cryo-EM 增重最强方案（支架对称性辅助对齐）；融合位点的几何约束可能扭曲靶点构象，不对称/变构状态研究不适用；已有商业化载体' },
]

// ─── 与客户目的的冲突分析（规则式）──────────────────────────────────────

/** 目的信号词 */
const GOAL_COMPLEX_RE = /复合物|complex|互作|相互作用|结合(机制|界面)?|binding|interaction|抑制剂|inhibitor|drug|药物|别构|alloster/i
const GOAL_MONOMER_RE = /单体|apo|游离(态|形式)?|本身(的)?(结构|构象)|独立(发挥|行)|单独(亚基|结构)|monomer/i
const GOAL_FUNCTION_RE = /活性(位点|中心)?|催化|酶(活|学|促)?|功能(位点|机制)|active site|catalyt|酶学/i
const GOAL_CONFORMATION_RE = /构象|状态(转变|转换)?|动态|别构|conformation|alloster/i

function buildConflicts(
  goalText: string,
  hasGoal: boolean,
  assemblyPath: MwAugmentAnalysis['assemblyPath'],
  assemblyKda: number | null,
  homologIdentity: number | null,
): MwConflictNote[] {
  const out: MwConflictNote[] = []
  if (!hasGoal) {
    out.push({ level: 'caution', text: '未提供明确客户目的 — 增重组分是否与研究目标冲突需与客户确认（尤其涉及生理伙伴/标签的方案）' })
    if (assemblyPath === 'homolog-complex') {
      out.push({ level: 'caution', text: `同源复合物为推断证据（identity ${homologIdentity ?? '—'}%）— 加入的伙伴/寡聚化是否改变研究对象状态，需先验证互作再评估目的兼容性` })
    }
    return out.slice(0, 4)
  }
  const wantComplex = GOAL_COMPLEX_RE.test(goalText)
  const wantMonomer = GOAL_MONOMER_RE.test(goalText)
  const wantFunction = GOAL_FUNCTION_RE.test(goalText)
  const wantConformation = GOAL_CONFORMATION_RE.test(goalText)

  if (assemblyPath === 'complex' || assemblyPath === 'partner') {
    if (wantComplex) {
      out.push({ level: 'aligned', text: '客户目的涉及复合物/相互作用 — 复合物形式的增重路径与研究目的契合（装配本身就是研究对象）' })
    } else if (wantMonomer) {
      out.push({
        level: 'conflict',
        text: '客户目的指向单体/游离态 — 引入结合伙伴会改变研究对象：结合可能锁定特定构象、遮蔽功能性界面；如确需增重，建议优先选用不产生生理结合界面的手段（融合标签/支架），并保留去标签样品的对照实验',
      })
    } else {
      out.push({ level: 'caution', text: '引入生理伙伴增重前需确认目的兼容性：若需 apo/游离态结构或定量结合数据，伙伴结合会改变样品状态（结合态 vs 游离态需分别评估）' })
    }
  } else if (assemblyPath === 'homolog-complex') {
    // v1.27：同源复合物推断 — 证据强度低于直接结构，且加入组分可能改变研究对象
    if (wantComplex) {
      out.push({ level: 'aligned', text: `客户目的涉及复合物/相互作用 — 同源复合物增重路径与目的方向契合（identity ${homologIdentity ?? '—'}%，装配形式在同一家族内常保守）；需先验证靶点与对应伙伴的互作` })
    } else if (wantMonomer) {
      out.push({
        level: 'conflict',
        text: '客户目的指向单体/游离态 — 同源复合物推断意味着靶点可能以复合物形式存在或被装配增重，会改变研究对象（锁定构象、遮蔽界面）；如确需增重，优先选不产生生理界面的技术组分（标签/支架），并保留对照实验',
      })
    } else {
      out.push({ level: 'caution', text: '同源复合物为推断证据（非靶点直接结构）— 伙伴互作与化学计量未经实验验证，共表达/体外组装前建议先做 pull-down/SPR 验证；若目的对样品状态敏感（apo/结合态），需分别评估' })
    }
    out.push({ level: 'caution', text: `同源推断的置信度取决于 identity（${homologIdentity ?? '—'}%）：≥40% 时寡聚界面通常保守，30-40% 为边缘，<30% 仅作参考 — 报告中需按实际 identity 说明验证优先级` })
  } else if (assemblyPath === 'oligomer') {
    out.push({ level: 'aligned', text: '自身寡聚增重（对称装配）一般不引入异源组分 — 与多数研究目的兼容；需注意寡聚化界面残基是研究对象时的构建边界保留' })
  }

  // 技术性组分（Fab/MBP/ferritin）与目的的通用冲突
  if (wantFunction) {
    out.push({ level: 'caution', text: '目的涉及自身活性位点/催化机制 — Fab/nanobody 一般不直接接触活性位点，但需评估结合表位的变构影响；MBP 融合可能干扰功能解读，建议结构解析后用切标签样品复验功能' })
  }
  if (wantConformation) {
    out.push({ level: 'caution', text: '目的涉及构象状态/动态 — 增重组分（Fab、融合标签、支架对称性）可能偏置构象平衡，解读结构时需标注引入组分的影响' })
  }
  if (!out.length) {
    out.push({ level: 'caution', text: '增重组分是否与目的冲突需结合具体科学问题评估：建议按「生理伙伴（复合物）— 技术组分（Fab/标签）」两档分别讨论，并与客户确认可接受度' })
  }
  return out.slice(0, 4)
}

// ─── 主分析 ─────────────────────────────────────────────────────────────

export interface MwAugmentInput {
  uniprot?: UniprotInfo | null
  /** 评分用序列长度（与 computeScores 一致：UniProt 全长或输入序列长度） */
  sequenceLength: number
  oligomer: OligomerAnalysis
  directPdbs: PdbEntry[]
  partners: PartnerMwInfo[]
  complexes: Map<string, ComplexAssemblyInfo>
  goal?: string
  goalHints?: string[]
  /** v1.27：BLAST 同源命中（直接路径装配 <50 kDa 时触发同源复合物扩展检索；analyzeMwAugmentation 消费） */
  blastHits?: BlastHit[]
  /** v1.27：同源复合物扩展检索结果（第二阶段填充 — fetchHomologComplexInfo 产出） */
  homologSearch?: { searched: number; complexes: HomologComplexInfo[] }
}

/** 单体分子量区间解读 */
function zoneOf(kda: number): { note: string } {
  if (kda < 15) {
    return { note: `单体 ~${kda} kDa 属极小蛋白区间：X-ray（结晶伴侣辅助）与 NMR 主场；Cryo-EM 单体成像极难，需装配/增重至 ≥100 kDa 才具常规可行性` }
  }
  if (kda < 30) {
    return { note: `单体 ~${kda} kDa：X-ray 优势区间、NMR 常规可行；Cryo-EM 单体颗粒（<30 kDa）对齐困难 — 数据采集需依赖装配/增重策略` }
  }
  return { note: `单体 ~${kda} kDa：X-ray 优势区间、NMR 偏大（可分段解析）；Cryo-EM 处于临界区 — 装配/增重后进入可行区间` }
}

/** 由输入（已含网络数据）构建分析结果（纯同步计算） */
export function buildMwAugmentAnalysis(input: MwAugmentInput): MwAugmentAnalysis {
  const seqLen = input.sequenceLength
  const monomerKda = aaToKda(seqLen)
  const applicable = monomerKda < SMALL_MONOMER_KDA

  if (!applicable) {
    return {
      applicable: false,
      monomerKda,
      zoneNote: `单体 ~${monomerKda} kDa ≥ ${SMALL_MONOMER_KDA} kDa，不属于小分子量场景 — 无需增重策略，Cryo-EM 分子量维度按聚集形式（寡聚态）分析评估`,
      assemblyKda: null,
      assemblyBasis: '',
      assemblyPath: null,
      complexes: [],
      partners: [],
      options: [],
      conflicts: [],
      notes: ['分子量维度不适用（非小分子量靶点）；聚集形式维度（寡聚态）继续单独生效'],
    }
  }

  const targetUniprot = input.uniprot?.uniprotId ?? ''
  const notes: string[] = []

  // ── 路径 1：已有复合物结构（RCSB 实体/装配）──
  const complexes: MwComplex[] = []
  for (const [, c] of input.complexes) {
    const nonTargetEntities = c.entities.filter(e => !targetUniprot || !e.uniprotIds.includes(targetUniprot))
    if (nonTargetEntities.length === 0) continue // 纯同源寡聚条目（由 oligomer 维度处理）
    const nonTargetKda = aaToKda(nonTargetEntities.reduce((s, e) => s + e.lengthAa, 0))
    if (nonTargetKda < 10) continue // 伙伴贡献过小（短肽为主）— 不构成增重路径

    const components: MwComponent[] = c.entities.map(e => ({
      name: e.description,
      uniprotId: e.uniprotIds[0],
      lengthAa: e.lengthAa,
      kda: aaToKda(e.lengthAa),
      isTarget: targetUniprot ? e.uniprotIds.includes(targetUniprot) : e.description === c.entities[0]?.description,
    }))

    const hasArtificial = nonTargetEntities.some(e => ARTIFICIAL_RE.test(e.description))
    // 装配总分子量：优先 RCSB 生物装配 formula_weight（kDa，含全部链/配体）；缺失时去重实体求和
    let totalKda: number
    let basis: MwComplex['basis']
    let note: string
    if (c.assemblyWeightKda != null && c.assemblyWeightKda > 0) {
      basis = 'assembly'
      totalKda = Math.round(c.assemblyWeightKda * 10) / 10
      note = `RCSB 生物装配口径（formula_weight ${totalKda} kDa${c.oligomericDetails ? ` · ${c.oligomericDetails}` : ''}）`
    } else {
      basis = 'entity'
      totalKda = aaToKda(c.entities.reduce((s, e) => s + e.lengthAa, 0))
      note = '去重实体口径（装配信息缺失，未计同源多拷贝 — 实际装配分子量 ≥ 此估计）'
    }
    if (hasArtificial) {
      note += '；含技术性组分（Fab/标签等）先例 — 说明伴侣/增重策略已被用于该靶点'
    }
    complexes.push({
      pdbId: c.pdbId,
      title: c.title,
      method: c.method,
      resolution: c.resolution,
      components,
      totalKda,
      basis,
      note,
    })
  }
  complexes.sort((a, b) => (a.resolution ?? 99) - (b.resolution ?? 99))

  // ── 路径 2：自身寡聚（拷贝数 × 单体）──
  const oligoCopies = input.oligomer.category === 'homo-oligomer'
    ? (input.oligomer.evidence.find(e => e.source === 'pdb-stoichiometry')?.state.copies
      ?? input.oligomer.evidence.find(e => e.state.copies != null)?.state.copies
      ?? null)
    : null
  const oligoAssemblyKda = oligoCopies != null && oligoCopies >= 2 ? Math.round(monomerKda * oligoCopies) : null

  // ── 路径 3：互作伙伴（1:1 二元装配估计）──
  const partners = input.partners.map(p => ({
    accession: p.accession,
    geneName: p.geneName,
    proteinName: p.proteinName,
    lengthAa: p.lengthAa,
    kda: p.lengthAa != null ? aaToKda(p.lengthAa) : undefined,
  }))
  const sizedPartners = partners.filter(p => p.kda != null && p.kda >= 10)
  const largestPartner = sizedPartners.reduce<typeof partners[number] | null>((best, p) => (!best || (p.kda ?? 0) > (best.kda ?? 0)) ? p : best, null)
  const partnerAssemblyKda = largestPartner?.kda != null ? Math.round(monomerKda + largestPartner.kda) : null

  // ── 装配路径择优（分子量最高者为有效装配）──
  let assemblyKda: number | null = null
  let assemblyPath: MwAugmentAnalysis['assemblyPath'] = null
  let assemblyBasis = ''
  const bestComplex = complexes[0]
  if (bestComplex && bestComplex.totalKda >= (oligoAssemblyKda ?? 0) && bestComplex.totalKda >= (partnerAssemblyKda ?? 0)) {
    assemblyKda = bestComplex.totalKda
    assemblyPath = 'complex'
    assemblyBasis = `已有复合物结构 ${bestComplex.pdbId}（${bestComplex.basis === 'assembly' ? '生物装配' : '去重实体'}口径：${bestComplex.components.length} 个蛋白组分，合计 ~${bestComplex.totalKda} kDa；分辨率 ${bestComplex.resolution ?? '—'}Å）`
  } else if (oligoAssemblyKda != null && oligoAssemblyKda >= (partnerAssemblyKda ?? 0)) {
    assemblyKda = oligoAssemblyKda
    assemblyPath = 'oligomer'
    assemblyBasis = `自身寡聚装配：${oligoCopies} × 单体（~${monomerKda} kDa）= ~${oligoAssemblyKda} kDa（聚集形式分析判定 ${input.oligomer.label ?? ''}）`
  } else if (partnerAssemblyKda != null) {
    assemblyKda = partnerAssemblyKda
    assemblyPath = 'partner'
    const p = largestPartner!
    assemblyBasis = `UniProt 互作伙伴推断：单体 + ${p.geneName ?? p.proteinName ?? p.accession}（${p.accession}，~${p.kda} kDa）按 1:1 估计 = ~${partnerAssemblyKda} kDa（无结构先例，实际化学计量需 SEC-MALS 验证）`
  }

  // ── v1.27 路径 4：同源复合物推断（BLAST 扩展检索 — 直接路径装配均不足 50 kDa 时接管）──
  const homologComplexes: MwHomologComplex[] = (input.homologSearch?.complexes ?? []).map(h => ({
    pdbId: h.pdbId,
    title: h.title,
    method: h.method,
    resolution: h.resolution,
    identity: h.identity,
    totalKda: h.totalKda,
    estimatedKda: h.estimatedKda,
    basis: h.basis,
    componentSummary: h.componentSummary,
    note: h.note,
  }))
  const bestHomolog = homologComplexes[0] ?? null
  if ((assemblyKda ?? 0) < EM_MARGINAL_KDA && bestHomolog && bestHomolog.estimatedKda >= EM_MARGINAL_KDA) {
    assemblyKda = bestHomolog.estimatedKda
    assemblyPath = 'homolog-complex'
    assemblyBasis = `同源复合物推断：BLAST 命中 ${bestHomolog.pdbId}（identity ${Math.round(bestHomolog.identity)}%）${bestHomolog.basis === 'assembly' ? '生物装配' : '实体估计'}口径 ~${bestHomolog.totalKda} kDa（${bestHomolog.componentSummary}），同源亚基按靶点单体（~${monomerKda} kDa）换算后 ≈ ~${bestHomolog.estimatedKda} kDa；寡聚状态/互作界面在同一家族内常保守，靶点能否形成同等装配需实验验证`
  }

  // ── v1.27：同源扩展检索说明（触发原因 + 检索范围 + 结果）──
  let homologSearchNote = ''
  if ((assemblyKda ?? 0) < EM_MARGINAL_KDA || assemblyPath === 'homolog-complex') {
    const directKdaText = assemblyPath === 'homolog-complex'
      ? `直接路径（寡聚/已有复合物/伙伴）装配均不足 ${EM_MARGINAL_KDA} kDa`
      : assemblyKda != null
        ? `直接路径装配仅 ~${assemblyKda} kDa（不足 ${EM_MARGINAL_KDA} kDa）`
        : '无生物装配路径'
    const hs = input.homologSearch
    if (hs != null && hs.searched > 0 && hs.complexes.length > 0) {
      const maxId = Math.max(...hs.complexes.map(c => Math.round(c.identity)))
      homologSearchNote = `${directKdaText} — 经 BLAST 同源结构扩展检索（检索 ${hs.searched} 个同源结构），发现 ${hs.complexes.length} 个形成 ≥${EM_MARGINAL_KDA} kDa 复合物的同源结构（最高 identity ${maxId}%，最大换算装配 ~${hs.complexes[0].estimatedKda} kDa）`
    } else if (hs != null && hs.searched > 0) {
      homologSearchNote = `${directKdaText} — 经 BLAST 同源结构扩展检索（检索 ${hs.searched} 个同源结构），未发现形成 ≥${EM_MARGINAL_KDA} kDa 复合物的同源结构：Cryo-EM 增重需依赖技术组分（Fab/ferritin 支架等，见工具箱）`
    } else if (hs != null) {
      homologSearchNote = `${directKdaText} — 无 identity ≥${HOMOLOG_MIN_IDENTITY}% 的 BLAST 同源候选（或同源结构装配信息不可用），同源扩展检索未获得可用证据`
    } else if ((input.blastHits?.length ?? 0) > 0) {
      homologSearchNote = `${directKdaText} — 同源扩展检索不可用（网络失败/中断），建议重跑评估或人工检索同源复合物`
    } else {
      homologSearchNote = `${directKdaText} — 无 BLAST 同源命中可扩展检索（同源检索跳过/失败或 0 命中），建议人工确认同源家族是否形成大复合物`
    }
  } else {
    homologSearchNote = `直接装配路径 ~${assemblyKda} kDa 已 ≥${EM_MARGINAL_KDA} kDa — 未触发同源扩展检索`
  }

  // ── 冲突分析 ──
  const goalText = [input.goal ?? '', ...(input.goalHints ?? [])].join(' ').trim()
  const hasGoal = goalText.length > 0
  const conflicts = buildConflicts(goalText, hasGoal, assemblyPath, assemblyKda, bestHomolog != null ? Math.round(bestHomolog.identity) : null)

  // ── 综合要点 ──
  notes.push(zoneOf(monomerKda).note)
  if (assemblyKda != null) {
    const zone = assemblyKda >= EM_ROUTINE_KDA
      ? `≥${EM_ROUTINE_KDA} kDa — 进入 Cryo-EM 常规可行区间`
      : assemblyKda >= EM_MARGINAL_KDA
        ? `${EM_MARGINAL_KDA}-${EM_ROUTINE_KDA} kDa 边缘区间 — 可行但需相位板（VPP）/优化玻璃化条件`
        : `<${EM_MARGINAL_KDA} kDa — 仍低于 Cryo-EM 常规门槛，颗粒对齐困难`
    const pathPrefix = assemblyPath === 'homolog-complex' ? '（同源推断 — 装配需实验验证）' : ''
    notes.push(`装配有效分子量 ~${assemblyKda} kDa${pathPrefix}（${assemblyBasis}）：${zone}`)
  } else {
    notes.push('无生物装配增重路径（无寡聚拷贝数、无复合物结构、无已注释伙伴）— Cryo-EM 可行性取决于技术增重策略（见下方工具箱），开发工作量与周期相应增加')
  }
  if (homologSearchNote) notes.push(homologSearchNote)
  if (complexes.length > 1) {
    notes.push(`共 ${complexes.length} 个已有复合物结构可作增重路径参考（${complexes.map(c => `${c.pdbId} ~${c.totalKda} kDa`).slice(0, 4).join('、')}）`)
  }
  if (homologComplexes.length > 1) {
    notes.push(`共 ${homologComplexes.length} 个同源结构形成 ≥${EM_MARGINAL_KDA} kDa 复合物可作增重路径参考（${homologComplexes.map(c => `${c.pdbId} ~${c.estimatedKda} kDa/identity ${Math.round(c.identity)}%`).slice(0, 4).join('、')}）— 同源证据按 identity 高低排序取舍，组装验证前置`)
  }
  notes.push('NMR 维度：增重对 NMR 无益（分子量越大越难）— 小分子量本身是 NMR 优势区间，装配分子量超出 ~50 kDa 后 NMR 需分段/截短策略')
  notes.push('X-ray 维度：分子量不是结晶瓶颈；Fab/MBP 等伴侣策略同时是助结晶手段（伴侣界面可主导晶格堆积）')

  return {
    applicable: true,
    monomerKda,
    zoneNote: zoneOf(monomerKda).note,
    assemblyKda,
    assemblyBasis,
    assemblyPath,
    complexes: complexes.slice(0, 6),
    homologComplexes,
    homologSearchNote,
    partners,
    options: TECH_OPTIONS,
    conflicts,
    notes,
  }
}

/**
 * 端到端分析（含网络数据获取）：
 * UniProt 伙伴长度 + RCSB 复合物装配（直接）+ 同源复合物扩展检索（v1.27，两阶段）+ 同步构建。
 * 网络失败自动降级（空数据继续），不抛异常。
 *
 * v1.27 第二阶段：小分子量靶点 且 直接路径（已有复合物/自身寡聚/互作伙伴）
 * 装配均不足 50 kDa 时，经 BLAST 同源命中扩展检索 RCSB 装配 —
 * 若同源结构形成 ≥50 kDa 复合物，则按同源亚基换算作为装配 MW 估计（homolog-complex 路径）。
 */
export async function analyzeMwAugmentation(
  input: Omit<MwAugmentInput, 'partners' | 'complexes'> & { signal?: AbortSignal },
): Promise<MwAugmentAnalysis> {
  const seqLen = input.sequenceLength
  // 快速路径：非小分子量靶点不发起任何网络请求
  if (aaToKda(seqLen) >= SMALL_MONOMER_KDA) {
    return buildMwAugmentAnalysis({
      ...input,
      partners: [],
      complexes: new Map(),
    })
  }
  const [partners, complexes] = await Promise.all([
    fetchPartnerLengths(input.uniprot).catch(() => [] as PartnerMwInfo[]),
    fetchComplexAssemblyInfo(input.directPdbs, input.signal).catch(() => new Map<string, ComplexAssemblyInfo>()),
  ])
  let analysis = buildMwAugmentAnalysis({ ...input, partners, complexes })

  // v1.27 阶段 2：直接路径装配不足 50 kDa 且有 BLAST 同源命中 → 扩展检索同源大复合物
  if (analysis.applicable && (analysis.assemblyKda ?? 0) < EM_MARGINAL_KDA && (input.blastHits?.length ?? 0) > 0 && !input.signal?.aborted) {
    const directIds = new Set(input.directPdbs.map(p => p.pdbId.toUpperCase()))
    const hs = await fetchHomologComplexInfo(input.blastHits ?? [], directIds, seqLen, input.signal).catch(() => null)
    if (hs != null) {
      analysis = buildMwAugmentAnalysis({ ...input, partners, complexes, homologSearch: hs })
    }
  }
  return analysis
}
