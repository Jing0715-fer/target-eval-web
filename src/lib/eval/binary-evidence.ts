/**
 * Binary 互作可信度评估（v2.33）— 用户需求：
 * Binary interactions 中的互作蛋白可信度需谨慎评估，不要完全相信 — 只有存在
 * 复合物结构（靶点与伙伴出现在同一 PDB 条目）或同源结构（靶点同源链与伙伴/
 * 伙伴同源基因出现在同一 PDB 条目）时才可完全信任；否则不应过度相信这些互作
 * 可用于增大蛋白分子量做 Cryo-EM 结构解析。
 *
 * 证据分级（BinaryEvidenceLevel）：
 *  - complex       直接复合物结构：同一 PDB 同时含靶点直接结构与伙伴（最强）
 *  - homolog       同源复合物结构：靶点 BLAST 同源命中的 PDB 中含伙伴本身，
 *                  或含伙伴同源基因的蛋白（UniProt gene_exact 跨物种检索 →
 *                  accession 与该 PDB 的 UniProt 映射求交集）
 *  - experimental  仅实验互作证据（IntAct 等）：无任何复合物/同源结构支持 —
 *                  低可信，不可据此推断「可用于增大分子量做 Cryo-EM」
 *
 * 数据通道（全部防御式降级，失败按 experimental 处理，不抛异常）：
 *  - 伙伴 PDB 列表：RCSB UniProt → PDB ID（rcsb.fetchPdbIdsForUniprot，结果缓存）
 *  - 同源 PDB 元数据：RCSB GraphQL 批量（uniprotAccs）
 *  - 伙伴同源基因 accession：UniProt REST gene_exact 批量检索（cachedJsonFetch）
 *
 * 结果缓存：interaction.ts（无直接结构场景）与 mw-augment.ts（小分子量场景）
 * 在同一作业内会以相同输入各调一次 — 按「靶点 + 伙伴集 + 直接结构集 + 同源集」
 * 键缓存评估结果（TTL 10 分钟），第二次零网络请求。
 */
import { cachedJsonFetch } from './cache'
import { entryMetaToPdbEntry, fetchEntriesMetaBatch, fetchPdbIdsForUniprot } from './rcsb'
import type { BinaryEvidenceLevel } from './types'
import type { BlastHit, PdbEntry } from './types'

export interface BinaryEvidence {
  /** 证据级别（见模块注释） */
  level: BinaryEvidenceLevel
  /** 复合物/同源复合物证据结构 PDB IDs（experimental 为空） */
  evidencePdbIds: string[]
  /** 证据结构代表条目（≤3 个，含标题/方法/分辨率） */
  representativePdbs: PdbEntry[]
  /** 伙伴自身结构总数（RCSB UniProt 映射） */
  partnerPdbCount: number
  /** 伙伴自身代表结构（≤2 个，按分辨率；互作界面参考用） */
  partnerReprPdbs: PdbEntry[]
  /** 证据说明（同源 identity / 同源基因 accession 等） */
  note?: string
}

export interface BinaryEvidenceInput {
  targetAcc: string
  /** 待评估伙伴（accession + 基因名） */
  partners: Array<{ accession: string; geneName?: string }>
  /** 靶点直接结构 PDB IDs（无直接结构场景为空数组） */
  directPdbIds?: string[]
  /** 靶点 BLAST 同源命中（同源复合物证据检索） */
  blastHits?: BlastHit[]
  signal?: AbortSignal
  onProgress?: (msg: string) => void
}

/** 参与同源复合物检索的 BLAST 命中上限（identity 降序取前 N） */
const MAX_HOMOLOG_PDBS = 60
/** 每伙伴证据结构代表条数 */
const MAX_EVIDENCE_REPR = 3
/** 无证据伙伴的自身代表结构条数（互作界面参考） */
const MAX_PARTNER_REPR = 2
/** 伙伴自身代表结构详情拉取上限（取前 N 个按分辨率挑优） */
const PARTNER_REPR_FETCH = 5
/** UniProt gene 检索返回上限（跨物种同源 accession） */
const GENE_SEARCH_SIZE = 300
/** 评估结果缓存 TTL */
const RESULT_TTL_MS = 600_000
const resultCache = new Map<string, { t: number; value: Map<string, BinaryEvidence> }>()

/** 伙伴基因名合法性（UniProt gene_exact 查询安全） */
function safeGeneName(g: string | undefined): string | undefined {
  if (!g) return undefined
  const t = g.trim()
  return /^[A-Za-z0-9][A-Za-z0-9._@-]{0,31}$/.test(t) ? t : undefined
}

/** 批量检索基因（跨物种 reviewed）→ 该基因的全部 UniProt accession */
async function fetchOrthologAccs(geneNames: string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>()
  const genes = [...new Set(geneNames.map(g => safeGeneName(g)).filter((g): g is string => Boolean(g)))].slice(0, 12)
  if (!genes.length) return out
  const query = `(${genes.map(g => `gene_exact:"${g}"`).join(' OR ')}) AND (reviewed:true)`
  const url = `https://rest.uniprot.org/uniprotkb/search?query=${encodeURIComponent(query)}&fields=accession,gene_names&format=json&size=${GENE_SEARCH_SIZE}`
  const raw = await cachedJsonFetch<{
    results?: Array<{ primaryAccession?: string; genes?: Array<{ geneName?: { value?: string } }> }>
  }>(url, { timeoutMs: 15_000 })
  const lowerToGene = new Map(genes.map(g => [g.toLowerCase(), g]))
  for (const r of raw?.results ?? []) {
    const acc = r.primaryAccession?.toUpperCase()
    if (!acc) continue
    for (const g of r.genes ?? []) {
      const gn = g.geneName?.value
      if (!gn) continue
      const key = lowerToGene.get(gn.toLowerCase())
      if (!key) continue
      if (!out.has(key)) out.set(key, new Set())
      out.get(key)!.add(acc)
    }
  }
  return out
}

/**
 * 评估 binary 互作伙伴的可信度（复合物结构 / 同源复合物结构 / 仅实验证据）。
 * 永不抛异常：单个数据通道失败时按低证据处理，返回全部伙伴的分级结果。
 */
export async function evaluateBinaryEvidence(input: BinaryEvidenceInput): Promise<Map<string, BinaryEvidence>> {
  const partners = [...new Map(input.partners.filter(p => p.accession).map(p => [p.accession, p])).values()]
  const empty = new Map<string, BinaryEvidence>()
  if (!partners.length) return empty

  // ── 结果缓存键（靶点 + 伙伴集 + 直接/同源结构集 — 同作业内两消费方幂等） ──
  const directSet = new Set((input.directPdbIds ?? []).map(id => id.toUpperCase()))
  const identityByPdb = new Map<string, number>()
  for (const h of [...(input.blastHits ?? [])].sort((a, b) => b.identity - a.identity)) {
    const id = h.pdbId?.toUpperCase()
    if (!id || identityByPdb.has(id)) continue
    identityByPdb.set(id, h.identity)
    if (identityByPdb.size >= MAX_HOMOLOG_PDBS) break
  }
  const cacheKey = [
    input.targetAcc.toUpperCase(),
    partners.map(p => p.accession).sort().join(','),
    [...directSet].sort().join(','),
    [...identityByPdb.keys()].sort().join(','),
  ].join('|')
  const hit = resultCache.get(cacheKey)
  if (hit && Date.now() - hit.t < RESULT_TTL_MS) return hit.value

  input.onProgress?.(`检索 ${partners.length} 个 binary 互作伙伴的复合物/同源结构证据…`)

  // ── 伙伴 PDB 列表（并行拉取；失败按空列表 → experimental） ──
  const idsByPartner = new Map<string, string[]>()
  await Promise.all(partners.map(async p => {
    try {
      const ids = await fetchPdbIdsForPartner(p.accession)
      idsByPartner.set(p.accession, ids)
    } catch {
      idsByPartner.set(p.accession, [])
    }
  }))

  // ── 同源 PDB 的 UniProt 实体映射（GraphQL 批量；同源基因匹配需要） ──
  const homologIds = [...identityByPdb.keys()]
  let accsByHomologPdb = new Map<string, string[]>()
  if (homologIds.length && partners.some(p => safeGeneName(p.geneName))) {
    try {
      const metas = await fetchEntriesMetaBatch(homologIds, input.signal)
      for (const [id, m] of metas) {
        accsByHomologPdb.set(id.toUpperCase(), m.uniprotAccs.map(a => a.toUpperCase()))
      }
    } catch { /* 元数据失败 → 跳过同源基因匹配 */ }
  }

  // ── 逐伙伴分级 ──
  const results = new Map<string, BinaryEvidence>()
  let needOrtho = false
  for (const p of partners) {
    const ids = (idsByPartner.get(p.accession) ?? []).map(i => i.toUpperCase())
    let level: BinaryEvidenceLevel = 'experimental'
    let evidenceIds: string[] = []
    let note: string | undefined

    // 1) 直接复合物结构：靶点直接结构 ∩ 伙伴结构
    const directHit = ids.filter(id => directSet.has(id))
    if (directHit.length) {
      level = 'complex'
      evidenceIds = directHit
      note = `复合物结构支持：靶点与该伙伴出现在同一 PDB 条目（${directHit.slice(0, 3).join('、')}${directHit.length > 3 ? ` 等 ${directHit.length} 个` : ''}）`
    }

    // 2) 同源复合物结构（伙伴本身）：靶点 BLAST 同源命中 PDB ∩ 伙伴结构
    if (level === 'experimental') {
      const selfHit = ids.filter(id => identityByPdb.has(id))
      if (selfHit.length) {
        level = 'homolog'
        evidenceIds = selfHit
        const best = Math.max(...selfHit.map(id => identityByPdb.get(id) ?? 0))
        note = `同源复合物结构支持：靶点同源链（BLAST 命中，最高 identity ${Math.round(best)}%）与该伙伴共结构（${selfHit.slice(0, 3).join('、')}${selfHit.length > 3 ? ` 等 ${selfHit.length} 个` : ''}）`
      }
    }

    if (level === 'experimental' && safeGeneName(p.geneName)) needOrtho = true
    results.set(p.accession, {
      level,
      evidencePdbIds: evidenceIds,
      representativePdbs: [],
      partnerPdbCount: ids.length,
      partnerReprPdbs: [],
      note,
    })
  }

  // ── 伙伴同源基因 → 跨物种 accession（仅还有 experimental 伙伴时才检索） ──
  let orthoByGene = new Map<string, Set<string>>()
  if (needOrtho && homologIds.length) {
    const pending = partners.filter(p => results.get(p.accession)?.level === 'experimental' && safeGeneName(p.geneName))
    try {
      orthoByGene = await fetchOrthologAccs(pending.map(p => p.geneName!))
    } catch { orthoByGene = new Map() }
    for (const p of pending) {
      const ortho = orthoByGene.get(safeGeneName(p.geneName)!)
      if (!ortho?.size) continue
      const hitIds: string[] = []
      let hitAcc = ''
      for (const [pdbId, accs] of accsByHomologPdb) {
        const m = accs.find(a => ortho.has(a))
        if (m) {
          hitIds.push(pdbId)
          if (!hitAcc) hitAcc = m
        }
      }
      if (!hitIds.length) continue
      const best = Math.max(...hitIds.map(id => identityByPdb.get(id) ?? 0))
      const ev = results.get(p.accession)!
      ev.level = 'homolog'
      ev.evidencePdbIds = hitIds
      ev.note = `同源复合物结构支持：靶点同源链（BLAST 命中，最高 identity ${Math.round(best)}%）与该伙伴的同源基因蛋白（${hitAcc}）共结构（${hitIds.slice(0, 3).join('、')}${hitIds.length > 3 ? ` 等 ${hitIds.length} 个` : ''}）`
    }
  }

  // ── 代表结构详情（证据结构优先；无证据伙伴补自身代表作界面参考） ──
  const detailIds = new Set<string>()
  for (const p of partners) {
    const ev = results.get(p.accession)!
    if (ev.evidencePdbIds.length) {
      for (const id of ev.evidencePdbIds.slice(0, MAX_EVIDENCE_REPR)) detailIds.add(id)
    } else if (ev.partnerPdbCount > 0) {
      for (const id of (idsByPartner.get(p.accession) ?? []).slice(0, PARTNER_REPR_FETCH)) detailIds.add(id.toUpperCase())
    }
  }
  if (detailIds.size) {
    try {
      const metas = await fetchEntriesMetaBatch([...detailIds], input.signal)
      for (const p of partners) {
        const ev = results.get(p.accession)!
        if (ev.evidencePdbIds.length) {
          ev.representativePdbs = ev.evidencePdbIds
            .slice(0, MAX_EVIDENCE_REPR)
            .map(id => metas.get(id))
            .filter((m): m is NonNullable<typeof m> => Boolean(m))
            .map(entryMetaToPdbEntry)
        } else if (ev.partnerPdbCount > 0) {
          ev.partnerReprPdbs = (idsByPartner.get(p.accession) ?? [])
            .slice(0, PARTNER_REPR_FETCH)
            .map(id => metas.get(id.toUpperCase()))
            .filter((m): m is NonNullable<typeof m> => Boolean(m))
            .map(entryMetaToPdbEntry)
            .sort((a, b) => (a.resolution ?? 99) - (b.resolution ?? 99))
            .slice(0, MAX_PARTNER_REPR)
        }
      }
    } catch { /* 详情失败 → 保留 ID 列表，代表条目为空 */ }
  }

  resultCache.set(cacheKey, { t: Date.now(), value: results })
  return results
}

/** fetchPdbIdsForUniprot 的简单包装（统一异常口径；200 上限 — 证据检索够用） */
async function fetchPdbIdsForPartner(accession: string): Promise<string[]> {
  return fetchPdbIdsForUniprot(accession, 200)
}
