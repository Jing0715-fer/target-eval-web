/**
 * 互作复合物证据分析（v1.29）— 无直接结构时的评估依据。
 *
 * 用户需求：如果搜不到结构（直接结构 + 同源结构均无），可参考 UniProt Interaction
 * 部分（IntAct binary 互作 + Complex viewer 复合物）评估打分；尤其是 Complex Portal
 * curated 复合物（CPX-xxxx，complex viewer 数据源）可靠 — 若复合物其他组分有结构，
 * 检索列出这些结构作为评估依据。
 *
 * 数据通道：
 *  - CPX 入口：UniProt 交叉引用（uniprot.ts 已解析 complexPortalIds，无需搜索接口）
 *  - 复合物详情：EBI intact complex-ws /complex/{CPX}（participants 含 UniProt accession、
 *    基因名、化学计量、interactorType）
 *  - 组分长度：UniProt REST 批量 search（与 mw-augment fetchPartnerLengths 同款）
 *  - 组分结构（v1.30）：每组分全量 PDB ID 列表 → 按「同一 PDB 含 ≥2 组分」判定共有
 *    结构（组装先例，详情按覆盖组分数/分辨率取优）与单独结构（次要，仅代表条目）
 *
 * 内存策略：每复合物组分 ≤6、binary 伙伴 ≤6、每组分代表结构 3 — 命中集恒小。
 */
import { fetchPdbEntries, fetchPdbIdsForUniprot } from './rcsb'
import { cachedJsonFetch } from './cache'
import type { InteractionAnalysis, InteractionBinaryInfo, InteractionComplexInfo, InteractionComponent, InteractionSharedPdb, PdbEntry, UniprotInfo } from './types'

const COMPLEX_WS = 'https://www.ebi.ac.uk/intact/complex-ws/complex'

/** 单复合物组分数上限（大复合物截断 — 评估证据不需要全部组分） */
const MAX_COMPONENTS = 6
/** curated 复合物数量上限 */
const MAX_COMPLEXES = 3
/** binary 伙伴中检索结构的数量上限（复合物之外的伙伴） */
const MAX_BINARY_FETCH = 6
/** binary 展示上限（有结构者） */
const MAX_BINARY_SHOW = 4

/** aa → kDa 估算（与 mw-augment AA_KDA 一致） */
const AA_KDA = 0.11

interface ComplexWsParticipant {
  interactorAC?: string
  identifier?: string
  name?: string
  description?: string
  stochiometry?: string
  interactorType?: string
}

interface ComplexWsRaw {
  complexAc?: string
  name?: string
  systematicName?: string
  complexAssemblies?: string[]
  species?: string
  participants?: ComplexWsParticipant[]
  predictedComplex?: boolean
}

/** 拉取一个 Complex Portal 复合物的组分（cachedJsonFetch：失败/超时返回 null） */
async function fetchComplex(cpx: string): Promise<ComplexWsRaw | null> {
  return cachedJsonFetch<ComplexWsRaw>(`${COMPLEX_WS}/${encodeURIComponent(cpx)}`, { timeoutMs: 15_000 })
}

/** 解析化学计量文本："minValue: 1, maxValue: 2" → 2（取上限做 MW 估算；失败 null） */
function parseStochMax(text: string | undefined): number | null {
  if (!text) return null
  const max = text.match(/maxValue:\s*(\d+)/)?.[1]
  if (max) return parseInt(max, 10)
  const min = text.match(/minValue:\s*(\d+)/)?.[1]
  if (min) return parseInt(min, 10)
  const single = text.match(/^\s*(\d+)\s*$/)?.[1]
  return single ? parseInt(single, 10) : null
}

/** 批量查组分长度（UniProt search；查不到的保留 null） */
async function fetchLengths(accessions: string[]): Promise<Map<string, { lengthAa?: number; proteinName?: string }>> {
  const out = new Map<string, { lengthAa?: number; proteinName?: string }>()
  if (!accessions.length) return out
  const query = `accession:(${[...new Set(accessions)].join(' OR ')})`
  const url = `https://rest.uniprot.org/uniprotkb/search?query=${encodeURIComponent(query)}&fields=accession,length,protein_name&format=json&size=${Math.min(25, accessions.length * 2)}`
  const raw = await cachedJsonFetch<{
    results?: Array<{ primaryAccession?: string; sequence?: { length?: number }; proteinDescription?: { recommendedName?: { fullName?: { value?: string } } } }>
  }>(url, { timeoutMs: 15_000 })
  for (const r of raw?.results ?? []) {
    if (!r.primaryAccession) continue
    out.set(r.primaryAccession, {
      lengthAa: r.sequence?.length,
      proteinName: r.proteinDescription?.recommendedName?.fullName?.value?.slice(0, 60),
    })
  }
  return out
}

/** 拉某蛋白的代表结构（按分辨率取优 ≤3 个） */
async function fetchRepresentativePdbs(accession: string, take: number, signal?: AbortSignal): Promise<{ count: number; entries: PdbEntry[] }> {
  try {
    const ids = await fetchPdbIdsForUniprot(accession, 100)
    if (!ids.length) return { count: 0, entries: [] }
    if (take <= 0) return { count: ids.length, entries: [] }
    const res = await fetchPdbEntries(ids.slice(0, Math.max(take, 5)), Math.max(take, 5), undefined, signal)
    const entries = [...res.entries]
      .sort((a, b) => (a.resolution ?? 99) - (b.resolution ?? 99))
      .slice(0, take)
    return { count: ids.length, entries }
  } catch {
    return { count: 0, entries: [] }
  }
}

/** 共有结构详情拉取上限（展示条数） */
const MAX_SHARED_SHOW = 10
/** 单独结构代表条数/组分 */
const SOLO_REPR_PER_COMPONENT = 3
/** 单独结构详情拉取条数/组分（排序后截取代表） */
const SOLO_FETCH_PER_COMPONENT = 8

/**
 * v1.30 组分结构分组检索：对每个组分拉全量 PDB ID 列表，按「同一 PDB 含 ≥2 个
 * 复合物组分」判定共有结构（组装先例，报告重点展示）；其余为单独结构（次要参考，
 * 报告默认折叠）。共有/单独分别取代表详情，representativePdbs 保留综合最优 ≤3。
 */
async function classifyComponentStructures(
  nonTarget: InteractionComponent[],
  signal?: AbortSignal,
): Promise<{ sharedPdbs: InteractionSharedPdb[]; sharedPdbTotal: number }> {
  // 每组分的 PDB ID 列表（200 上限 — 组分结构普遍 <100）
  const idsByAcc = new Map<string, string[]>()
  for (const c of nonTarget) {
    if (signal?.aborted) break
    try {
      const ids = await fetchPdbIdsForUniprot(c.accession, 200)
      idsByAcc.set(c.accession, ids)
      c.pdbCount = ids.length
    } catch {
      idsByAcc.set(c.accession, [])
      c.pdbCount = 0
    }
  }

  // PDB → 参与组分的归属计数：≥2 个组分共有的即「共有结构」
  const ownersByPdb = new Map<string, string[]>()
  for (const [acc, ids] of idsByAcc) {
    for (const id of new Set(ids)) {
      const arr = ownersByPdb.get(id)
      if (arr) arr.push(acc)
      else ownersByPdb.set(id, [acc])
    }
  }
  const sharedIds = [...ownersByPdb.entries()].filter(([, accs]) => accs.length >= 2).map(([id]) => id)
  const sharedSet = new Set(sharedIds)

  // 共有结构详情（按覆盖组分数降序 → 分辨率升序；拉前 12 条详情用于排序）
  let sharedEntries: PdbEntry[] = []
  if (sharedIds.length) {
    try {
      const res = await fetchPdbEntries(sharedIds.slice(0, MAX_SHARED_SHOW + 2), MAX_SHARED_SHOW + 2, undefined, signal)
      sharedEntries = [...res.entries]
    } catch { /* 详情失败 → 仅计数，不列详情 */ }
  }
  const sharedPdbs: InteractionSharedPdb[] = sharedEntries
    .map(e => {
      const accs = ownersByPdb.get(e.pdbId) ?? []
      const names = accs.map(acc => nonTarget.find(c => c.accession === acc)?.name ?? acc)
      return {
        pdbId: e.pdbId,
        componentNames: names,
        componentCount: accs.length,
        method: e.method,
        isXray: e.isXray,
        isCryoem: e.isCryoem,
        isNmr: e.isNmr,
        resolution: e.resolution,
        title: e.title,
      }
    })
    .sort((a, b) => b.componentCount - a.componentCount || (a.resolution ?? 99) - (b.resolution ?? 99))
    .slice(0, MAX_SHARED_SHOW)

  // 各组分：共有归属 + 单独结构代表
  for (const c of nonTarget) {
    const ids = idsByAcc.get(c.accession) ?? []
    c.sharedPdbIds = ids.filter(id => sharedSet.has(id))
    const soloIds = ids.filter(id => !sharedSet.has(id))
    c.soloPdbCount = soloIds.length
    c.soloRepresentativePdbs = []
    if (soloIds.length) {
      try {
        const res = await fetchPdbEntries(soloIds.slice(0, SOLO_FETCH_PER_COMPONENT), SOLO_FETCH_PER_COMPONENT, undefined, signal)
        c.soloRepresentativePdbs = [...res.entries]
          .sort((a, b) => (a.resolution ?? 99) - (b.resolution ?? 99))
          .slice(0, SOLO_REPR_PER_COMPONENT)
      } catch { /* 单独结构详情失败 → 仅计数 */ }
    }
    // representativePdbs：共有 + 单独综合最优 ≤3（兼容既有消费方）
    const sharedForComp = sharedEntries.filter(e => c.sharedPdbIds!.includes(e.pdbId))
    c.representativePdbs = [...sharedForComp, ...(c.soloRepresentativePdbs ?? [])]
      .sort((a, b) => (a.resolution ?? 99) - (b.resolution ?? 99))
      .slice(0, 3)
  }

  return { sharedPdbs, sharedPdbTotal: sharedIds.length }
}

export interface InteractionInput {
  uniprot: UniprotInfo | null
  signal?: AbortSignal
  onProgress?: (msg: string) => void
}

/**
 * 互作复合物证据分析（仅无直接结构场景调用；有直接结构时返回 applicable=false）。
 */
export async function analyzeInteractionEvidence(input: InteractionInput): Promise<InteractionAnalysis> {
  const { uniprot, signal, onProgress } = input
  const empty: InteractionAnalysis = {
    applicable: false,
    hasEvidence: false,
    complexes: [],
    binaryPartners: [],
    summary: '',
    notes: [],
  }
  if (!uniprot) return empty

  const targetAcc = uniprot.uniprotId
  const complexes: InteractionComplexInfo[] = []
  const cpxIds = (uniprot.complexPortalIds ?? []).slice(0, MAX_COMPLEXES)

  // ── curated 复合物（Complex Portal）──
  for (const cpx of cpxIds) {
    if (signal?.aborted) break
    onProgress?.(`拉取 Complex Portal 复合物 ${cpx}…`)
    const raw = await fetchComplex(cpx)
    if (!raw?.participants?.length) continue

    // 蛋白类组分（排除小分子/核酸等非蛋白 interactor）
    const proteinParticipants = raw.participants.filter(p => p.interactorType === 'protein' || /^[A-Z0-9]{6,10}$/.test(p.identifier ?? ''))
    const target = proteinParticipants.find(p => p.identifier === targetAcc)
    const others = proteinParticipants.filter(p => p.identifier !== targetAcc).slice(0, MAX_COMPONENTS)
    if (!target && others.length === 0) continue

    const components: InteractionComponent[] = []
    const seen = new Set<string>()
    for (const p of [target, ...others]) {
      if (!p || !p.identifier || seen.has(p.identifier)) continue
      seen.add(p.identifier)
      components.push({
        accession: p.identifier,
        name: (p.name ?? '').slice(0, 30) || p.identifier,
        description: (p.description ?? '').slice(0, 80),
        stoichiometryText: (p.stochiometry ?? '').trim(),
        stochMax: parseStochMax(p.stochiometry),
        isTarget: p.identifier === targetAcc,
        lengthAa: p.identifier === targetAcc ? uniprot.sequenceLength : null,
        kda: p.identifier === targetAcc ? Math.round(uniprot.sequenceLength * AA_KDA * 10) / 10 : null,
        pdbCount: 0,
        representativePdbs: [],
      })
    }
    if (!components.length) continue

    // 组分长度（非靶点）
    const nonTarget = components.filter(c => !c.isTarget)
    const lengths = await fetchLengths(nonTarget.map(c => c.accession))
    for (const c of nonTarget) {
      const l = lengths.get(c.accession)
      c.lengthAa = l?.lengthAa ?? null
      c.kda = c.lengthAa != null ? Math.round(c.lengthAa * AA_KDA * 10) / 10 : null
    }

    // 组分结构（v1.30：共有/单独分类检索；靶点自身跳过 — 无直接结构是本分析的前提）
    for (const c of nonTarget) {
      c.pdbCount = 0
      c.representativePdbs = []
      c.sharedPdbIds = []
      c.soloPdbCount = 0
      c.soloRepresentativePdbs = []
    }
    const { sharedPdbs, sharedPdbTotal } = nonTarget.length
      ? await classifyComponentStructures(nonTarget, signal)
      : { sharedPdbs: [] as InteractionSharedPdb[], sharedPdbTotal: 0 }

    const componentsWithStructure = nonTarget.filter(c => c.pdbCount > 0).length
    const totalPdb = nonTarget.reduce((s, c) => s + c.pdbCount, 0)
    const soloPdbTotal = nonTarget.reduce((s, c) => s + (c.soloPdbCount ?? 0), 0)
    const withLen = components.filter(c => c.lengthAa != null)
    const assemblyKda = withLen.length === components.length
      ? Math.round(withLen.reduce((s, c) => s + (c.lengthAa ?? 0) * AA_KDA * (c.stochMax ?? 1), 0) * 10) / 10
      : (withLen.length ? Math.round(withLen.reduce((s, c) => s + (c.lengthAa ?? 0) * AA_KDA * (c.stochMax ?? 1), 0) * 10) / 10 : null)

    complexes.push({
      complexAc: raw.complexAc ?? cpx,
      name: (raw.name ?? '').slice(0, 120),
      systematicName: raw.systematicName?.slice(0, 120),
      assembly: raw.complexAssemblies?.[0] ?? null,
      components,
      componentsWithStructure,
      totalPdb,
      assemblyKda,
      sharedPdbs,
      sharedPdbTotal,
      soloPdbTotal,
    })
    onProgress?.(`复合物 ${raw.complexAc ?? cpx}（${raw.name ?? ''}）：${components.length} 组分，${componentsWithStructure} 个有结构${sharedPdbTotal ? `（共有结构 ${sharedPdbTotal} 个）` : ''}`)
  }
  complexes.sort((a, b) => b.componentsWithStructure - a.componentsWithStructure || b.totalPdb - a.totalPdb)

  // ── binary 伙伴（IntAct，复合物之外的）──
  const complexAccs = new Set(complexes.flatMap(c => c.components.map(x => x.accession)))
  const binaries: InteractionBinaryInfo[] = []
  const binaryCandidates = (uniprot.interactions ?? [])
    .filter(i => !i.selfInteraction && i.accession !== targetAcc && !complexAccs.has(i.accession))
    .slice(0, MAX_BINARY_FETCH)
  if (binaryCandidates.length) {
    onProgress?.(`检索 ${binaryCandidates.length} 个 binary 互作伙伴的结构…`)
    for (const b of binaryCandidates) {
      if (signal?.aborted) break
      const { count, entries } = await fetchRepresentativePdbs(b.accession, 2, signal)
      if (count > 0) {
        binaries.push({ accession: b.accession, geneName: b.geneName, pdbCount: count, representativePdbs: entries })
      }
    }
    binaries.sort((a, b) => b.pdbCount - a.pdbCount)
  }

  // ── 汇总 ──
  const hasComplex = complexes.length > 0
  const hasEvidence = hasComplex || binaries.length > 0
  const best = complexes[0]
  const parts: string[] = []
  if (best) {
    parts.push(`Complex Portal curated 复合物 ${best.complexAc}（${best.name}）${best.assembly ? ` · ${best.assembly}` : ''}`)
    if (best.componentsWithStructure > 0) parts.push(`${best.componentsWithStructure}/${best.components.length - 1} 个其他组分有结构（共 ${best.totalPdb} 个 PDB${best.sharedPdbTotal ? `，其中共有结构 ${best.sharedPdbTotal} 个` : ''}）`)
    if (best.assemblyKda != null) parts.push(`装配总分子量 ~${best.assemblyKda} kDa`)
  }
  if (binaries.length) parts.push(`binary 互作伙伴 ${binaries.length} 个有结构（${binaries.slice(0, 3).map(b => `${b.geneName ?? b.accession} ${b.pdbCount} 结构`).join('、')}）`)
  const summary = hasEvidence
    ? `无直接结构 — 互作证据：${parts.join('；')}`
    : '无直接结构，且 UniProt 互作数据未提供可用证据（无 curated 复合物、伙伴无结构）'

  const notes: string[] = []
  if (hasComplex) {
    notes.push('Complex Portal 复合物为人工审核（curated）的装配证据 — 化学计量与组分构成可靠，可作为共表达/体外组装策略与复合物分子量估算的依据')
    if (best?.componentsWithStructure) {
      notes.push('复合物其他组分已有结构 — 组分结构可作构建设计参考（边界借鉴）与组装验证对照（SEC-MALS 化学计量比对），但靶点自身结构仍需从零解析')
    }
    if (best?.sharedPdbTotal) {
      notes.push(`复合物存在 ${best.sharedPdbTotal} 个共有结构（同一 PDB 含 ≥2 个组分）— 组分间共结晶/共组装已有直接先例，复合物路线的组装可行性最强的结构证据；各组分独立解析的单独结构仅作边界/构象参考`)
    }
    if (best?.assemblyKda != null && best.assemblyKda >= 100) {
      notes.push(`复合物装配 ~${best.assemblyKda} kDa（≥100 kDa）— 组装后进入 Cryo-EM 常规可行区间，复合物路线显著优于单体路线`)
    }
    notes.push('组装路线与客户目的需比对：若客户需要的是靶点单体/特定结构域结构，复合物路线为间接路径；若可接受复合物形式，应优先共表达组装')
  }
  if (binaries.length) {
    notes.push('binary 互作（IntAct 实验证据）伙伴有结构 — 互作界面建模与 pull-down/SPR 验证设计可参考，但非 curated 复合物，化学计量需实验确认')
  }

  return {
    applicable: true,
    hasEvidence,
    subunitNote: uniprot.subunitText?.slice(0, 300) || undefined,
    complexes: complexes.slice(0, MAX_COMPLEXES),
    binaryPartners: binaries.slice(0, MAX_BINARY_SHOW),
    summary,
    notes,
  }
}
