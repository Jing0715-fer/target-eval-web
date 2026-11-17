/**
 * RCSB PDB 数据访问：
 *  - fetchPdbIdsForUniprot: polymer_entity 检索（UniProt accession 精确匹配）
 *  - fetchPdbEntries: entry 详情分批拉取（并发 5，防 OOM/限流）+ GraphQL 配体批量回填
 * 内存策略：分批处理，详情立即映射为精简 PdbEntry 后丢弃原始 JSON。
 */
import type { PdbEntry, PdbsResult } from './types'

const SEARCH_URL = 'https://search.rcsb.org/rcsbsearch/v2/query'
const DATA_URL = 'https://data.rcsb.org/rest/v1/core/entry'
const GRAPHQL_URL = 'https://data.rcsb.org/graphql'

/** 结晶学添加剂/溶剂黑名单 — 无药理学信息量 */
const LIGAND_JUNK = new Set([
  'HOH', 'SO4', 'GOL', 'EDO', 'ACT', 'ACY', 'CL', 'NA', 'K', 'CA', 'TRS', 'MES',
  'EPE', 'CIT', 'PO4', 'PEG', 'DTT', 'IMD', 'NO3', 'NHE', 'FLC', 'IOD', 'BR',
  'FMT', 'ETH', 'EOH', 'MPD', '2PE', '1PE', 'P4G', 'PG4', 'PE4', 'TLA', 'MPO',
  'UNL', 'UNX',
])

/** 单页检索（fetchPdbIdsForUniprot / fetchAllPdbIdsForUniprot 共用 — 失败返回 []） */
async function requestPdbIdPage(uniprotId: string, start: number, rows: number, signal?: AbortSignal): Promise<string[]> {
  const body = {
    query: {
      type: 'terminal',
      service: 'text',
      parameters: {
        attribute: 'rcsb_polymer_entity_container_identifiers.reference_sequence_identifiers.database_accession',
        operator: 'exact_match',
        value: uniprotId,
      },
    },
    return_type: 'entry',
    request_options: {
      paginate: { start, rows },
      sort: [{ sort_by: 'rcsb_accession_info.initial_release_date', direction: 'desc' }],
    },
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal?.aborted) return []
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20_000)
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const res = await fetch(SEARCH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (res.ok) {
        const data = await res.json() as { result_set?: Array<{ identifier?: string }> }
        return (data.result_set ?? [])
          .map(r => (r.identifier ?? '').toUpperCase())
          .filter(id => /^[0-9A-Z]{4}$/.test(id))
      }
      if (res.status < 500 && res.status !== 429) return []
    } catch {
      /* 重试一次 */
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    if (attempt === 0) await new Promise(r => setTimeout(r, 1200))
  }
  return []
}

/** 按 UniProt accession 检索关联 PDB ID 列表（去重）。
 *  v2.5：rows 上限 1000（RCSB search v2 分页限制内），适配「不限」详情拉取模式。 */
export async function fetchPdbIdsForUniprot(uniprotId: string, max = 500): Promise<string[]> {
  const ids = await requestPdbIdPage(uniprotId, 0, Math.min(1000, max))
  return [...new Set(ids)]
}

/** 全量 ID 分页硬上限（每页 1000 × 3 页；ID 列表极轻，防爆护栏） */
const ALL_IDS_HARD_CAP = 3000

/** v2.26 全量 ID 进程内缓存（TTL 10 分钟，容量 64 — augment 在「生成→渲染」两次
 *  调用间幂等重入，第二次零网络请求直达 added=0 分支） */
const allIdsCache = new Map<string, { t: number; ids: string[] }>()

/**
 * v2.26 共有结构覆盖补齐：按 UniProt accession 分页拉取**全量**关联 PDB ID。
 * 背景（用户实测 3 靶点复合物共有结构未检出的根因）：fetchPdbIdsForUniprot 默认
 * max=500 且按 release_date 降序截断 — 高频共用组分（Gβ GNB1 实测 1345 条、
 * 8KFX 排第 765）落库 directPdbs 缺条目 → 多靶点交集为空。
 */
export async function fetchAllPdbIdsForUniprot(uniprotId: string, signal?: AbortSignal): Promise<string[]> {
  const key = uniprotId.trim().toUpperCase()
  const hit = allIdsCache.get(key)
  if (hit && Date.now() - hit.t < 600_000) return hit.ids
  const out: string[] = []
  for (let start = 0; start < ALL_IDS_HARD_CAP; start += 1000) {
    if (signal?.aborted) break
    const page = await requestPdbIdPage(uniprotId, start, 1000, signal)
    if (!page.length) break
    out.push(...page)
    if (page.length < 1000) break // total 不足一页 → 已拉全
  }
  const ids = [...new Set(out)]
  if (ids.length) {
    if (allIdsCache.size >= 64) {
      // 淘汰最旧条目（Map 迭代序 = 插入序）
      const oldest = allIdsCache.keys().next().value
      if (oldest) allIdsCache.delete(oldest)
    }
    allIdsCache.set(key, { t: Date.now(), ids })
  }
  return ids
}

interface EntryDetail {
  rcsb_entry_container_identifiers?: { entry_id?: string }
  exptl?: Array<{ method?: string }>
  rcsb_entry_info?: { resolution_combined?: number[]; experimental_method?: string[] }
  struct?: { title?: string }
  rcsb_accession_info?: { initial_release_date?: string }
  rcsb_primary_citation?: {
    rcsb_journal_abbrev?: string
    pdbx_database_id_DOI?: string
    pdbx_database_id_PubMed?: number | string
    rcsb_authors?: string[]
  }
  rcsb_entity_source_organism?: Array<{ ncbi_scientific_name?: string }>
}

async function fetchEntryDetail(pdbId: string, signal?: AbortSignal): Promise<EntryDetail | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12_000)
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const res = await fetch(`${DATA_URL}/${encodeURIComponent(pdbId)}`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!res.ok) return null
    return (await res.json()) as EntryDetail
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** GraphQL 批量拉取非聚合物配体（25/批），返回 pdbId → "ID (Name); ..." */
export async function fetchPdbLigandsBatch(pdbIds: string[], signal?: AbortSignal): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const ids = [...new Set(pdbIds.filter(i => /^[0-9A-Z]{4}$/.test(i)))]
  const CHUNK = 25
  const query = 'query($ids:[String!]!){ entries(entry_ids:$ids){ rcsb_id nonpolymer_entities { nonpolymer_comp { rcsb_id chem_comp { name } } } } }'
  for (let i = 0; i < ids.length; i += CHUNK) {
    if (signal?.aborted) return out
    const chunk = ids.slice(i, i + CHUNK)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    try {
      const resp = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { ids: chunk } }),
        signal: controller.signal,
      })
      if (!resp.ok) continue
      const data = await resp.json() as {
        data?: { entries?: Array<{ rcsb_id?: string; nonpolymer_entities?: Array<{ nonpolymer_comp?: { rcsb_id?: string; chem_comp?: { name?: string } } }> }> }
      }
      for (const e of data.data?.entries ?? []) {
        const id = String(e.rcsb_id || '').toUpperCase()
        if (!id) continue
        const comps = new Set<string>()
        for (const np of e.nonpolymer_entities ?? []) {
          const cid = String(np.nonpolymer_comp?.rcsb_id || '').toUpperCase()
          if (!cid || LIGAND_JUNK.has(cid)) continue
          const name = String(np.nonpolymer_comp?.chem_comp?.name || '').trim()
          comps.add(name ? `${cid} (${name.slice(0, 40)})` : cid)
        }
        if (comps.size > 0) out.set(id, [...comps].slice(0, 5).join('; '))
      }
    } catch { /* 本批失败 → 配体缺失，不阻塞 */ } finally {
      clearTimeout(timer)
    }
  }
  return out
}

/**
 * v1.31 GraphQL 批量条目元数据（50/批）：
 *  - 方法/分辨率/标题/释放日期 + 主引文（期刊 · DOI · PubMed）+ 全部 UniProt 组分
 *  - 用于互作复合物共有/单独结构全量列表（含文献跳转）与「额外组分」标注
 *    （同一 PDB 中复合物组分之外的其他蛋白，如 SCF 骨架结构中的 FBXO22/SKP2）
 */
export interface EntryMeta {
  pdbId: string
  method: string
  resolution: number | null
  title: string
  releaseDate: string
  journal: string
  doi: string
  pubmedId: string
  isXray: boolean
  isCryoem: boolean
  isNmr: boolean
  /** 该 PDB 条目全部蛋白实体的 UniProt accession（去重大写） */
  uniprotAccs: string[]
}

interface GqlEntryNode {
  rcsb_id?: string
  exptl?: Array<{ method?: unknown }>
  rcsb_entry_info?: { resolution_combined?: unknown }
  struct?: { title?: unknown }
  rcsb_accession_info?: { initial_release_date?: unknown }
  citation?: Array<{
    id?: unknown
    rcsb_is_primary?: unknown
    pdbx_database_id_PubMed?: unknown
    pdbx_database_id_DOI?: unknown
    rcsb_journal_abbrev?: unknown
  }>
  polymer_entities?: Array<{
    rcsb_polymer_entity_container_identifiers?: { uniprot_ids?: unknown }
  }>
}

/** EntryMeta → 精简 PdbEntry（配体为空 — 批量通道不拉配体，报告侧该列显示 —） */
export function entryMetaToPdbEntry(m: EntryMeta): PdbEntry {
  return {
    pdbId: m.pdbId,
    method: m.method,
    resolution: m.resolution,
    title: m.title,
    releaseDate: m.releaseDate,
    ligands: [],
    journal: m.journal,
    doi: m.doi,
    pubmedId: m.pubmedId,
    organisms: [],
    isXray: m.isXray,
    isCryoem: m.isCryoem,
    isNmr: m.isNmr,
  }
}

export async function fetchEntriesMetaBatch(pdbIds: string[], signal?: AbortSignal): Promise<Map<string, EntryMeta>> {
  const out = new Map<string, EntryMeta>()
  const ids = [...new Set(pdbIds.filter(i => /^[0-9A-Z]{4}$/.test(i)))]
  const CHUNK = 50
  const query = `query($ids:[String!]!){
    entries(entry_ids:$ids){
      rcsb_id
      exptl { method }
      rcsb_entry_info { resolution_combined }
      struct { title }
      rcsb_accession_info { initial_release_date }
      citation { id rcsb_is_primary pdbx_database_id_PubMed pdbx_database_id_DOI rcsb_journal_abbrev }
      polymer_entities { rcsb_polymer_entity_container_identifiers { uniprot_ids } }
    }
  }`
  for (let i = 0; i < ids.length; i += CHUNK) {
    if (signal?.aborted) return out
    const chunk = ids.slice(i, i + CHUNK)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20_000)
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const res = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { ids: chunk } }),
        signal: controller.signal,
      })
      if (!res.ok) continue
      const data = (await res.json()) as { data?: { entries?: GqlEntryNode[] } }
      for (const e of data.data?.entries ?? []) {
        const id = String(e.rcsb_id ?? '').toUpperCase()
        if (!id || out.has(id)) continue
        const method = typeof e.exptl?.[0]?.method === 'string' ? e.exptl[0].method : ''
        const resArr = Array.isArray(e.rcsb_entry_info?.resolution_combined) ? e.rcsb_entry_info.resolution_combined : []
        const primary = (e.citation ?? []).find(c => c.rcsb_is_primary === 'Y' || c.id === 'primary')
          ?? (e.citation ?? [])[0]
        const pmid = primary?.pdbx_database_id_PubMed
        const uniprots = new Set<string>()
        for (const pe of e.polymer_entities ?? []) {
          const arr = pe.rcsb_polymer_entity_container_identifiers?.uniprot_ids
          if (Array.isArray(arr)) {
            for (const a of arr) {
              if (typeof a === 'string' && /^[A-Z0-9]{6,10}$/.test(a)) uniprots.add(a.toUpperCase())
            }
          }
        }
        out.set(id, {
          pdbId: id,
          method,
          resolution: typeof resArr[0] === 'number' ? resArr[0] : null,
          title: typeof e.struct?.title === 'string' ? e.struct.title : '',
          releaseDate: typeof e.rcsb_accession_info?.initial_release_date === 'string'
            ? e.rcsb_accession_info.initial_release_date.slice(0, 10) : '',
          journal: typeof primary?.rcsb_journal_abbrev === 'string' ? primary.rcsb_journal_abbrev : '',
          doi: typeof primary?.pdbx_database_id_DOI === 'string' ? primary.pdbx_database_id_DOI : '',
          pubmedId: pmid != null && pmid !== '' ? String(pmid) : '',
          isXray: /x-ray/i.test(method),
          isCryoem: /electron microscopy|cryo/i.test(method),
          isNmr: /nmr|nuclear magnetic/i.test(method),
          uniprotAccs: [...uniprots],
        })
      }
    } catch { /* 本批失败 → 跳过（调用方仅丢失该批详情，计数不受影响） */ } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }
  return out
}

/**
 * 拉取 PDB 条目详情（含配体回填）。
 * @param ids 全量 PDB ID
 * @param maxDetail 拉取详情的上限（默认 150）
 * @param onProgress (done, total)
 * v2.6 分段续跑：deadline 到点 → 返回已完成的 entries（partial=true，排序与配体回填延至完成段）；
 * 调用方保存 entries + completedIds，下一段经 priorEntries/completedIds 续跑。
 */
export interface FetchPdbEntriesOpts {
  signal?: AbortSignal
  /** 分段预算（epoch ms）：到点返回 partial 结果 */
  deadline?: number
  /** 上段已完成的 PDB ID（跳过，不重复拉取） */
  completedIds?: string[]
  /** 上段已拉到的 entries（合并入返回值；配体回填在完成段统一做） */
  priorEntries?: PdbEntry[]
}

export async function fetchPdbEntries(
  ids: string[],
  maxDetail: number,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
  opts: FetchPdbEntriesOpts = {},
): Promise<PdbsResult> {
  const total = ids.length
  const detailIds = ids.slice(0, Math.max(1, maxDetail))
  const priorEntries = opts.priorEntries ?? []
  const doneSet = new Set((opts.completedIds ?? []).map(x => x.toUpperCase()))
  const entries: PdbEntry[] = [...priorEntries]
  const CONCURRENCY = 5
  let next = 0
  let done = 0

  async function worker() {
    while (next < detailIds.length && !signal?.aborted) {
      // v2.6 分段预算：到点停止拉取（已完成的 entries 增量保存，下一段续跑）
      if (opts.deadline != null && opts.deadline > 0 && Date.now() > opts.deadline) return
      const i = next++
      const pdbId = detailIds[i]
      if (doneSet.has(pdbId.toUpperCase())) { done++; continue }
      const d = await fetchEntryDetail(pdbId, signal)
      done++
      if (d) {
        const entryId = (d.rcsb_entry_container_identifiers?.entry_id ?? pdbId).toUpperCase()
        const method = d.exptl?.[0]?.method ?? d.rcsb_entry_info?.experimental_method?.[0] ?? ''
        const resArr = d.rcsb_entry_info?.resolution_combined ?? []
        const resolution = typeof resArr[0] === 'number' ? resArr[0] : null
        const cit = d.rcsb_primary_citation ?? {}
        const organisms = [...new Set(
          (d.rcsb_entity_source_organism ?? [])
            .map(o => o.ncbi_scientific_name ?? '')
            .filter(Boolean),
        )].slice(0, 3)
        const isXray = /x-ray/i.test(method)
        const isCryoem = /electron microscopy|cryo/i.test(method)
        const isNmr = /nmr|nuclear magnetic/i.test(method)
        entries.push({
          pdbId: entryId,
          method,
          resolution,
          title: d.struct?.title ?? '',
          releaseDate: (d.rcsb_accession_info?.initial_release_date ?? '').slice(0, 10),
          ligands: [],
          journal: cit.rcsb_journal_abbrev ?? '',
          doi: cit.pdbx_database_id_DOI ?? '',
          pubmedId: cit.pdbx_database_id_PubMed != null ? String(cit.pdbx_database_id_PubMed) : '',
          organisms,
          isXray, isCryoem, isNmr,
        })
      }
      if (onProgress) {
        try { onProgress(done, detailIds.length) } catch { /* ignore */ }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, detailIds.length) }, () => worker()))
  if (signal?.aborted) return { entries: [], totalFound: total }

  // v2.6 分段预算：未拉完 → 增量返回（partial；排序与配体回填在完成段统一做）
  const finishedAll = doneSet.size + done >= detailIds.length
  if (!finishedAll) {
    return { entries, totalFound: total, partial: true }
  }

  // 排序：分辨率优先（null 靠后）
  entries.sort((a, b) => {
    if (a.resolution == null && b.resolution == null) return a.pdbId.localeCompare(b.pdbId)
    if (a.resolution == null) return 1
    if (b.resolution == null) return -1
    return a.resolution - b.resolution
  })

  // 配体批量回填（只对已拉到的 entries）
  if (entries.length > 0) {
    const ligandsMap = await fetchPdbLigandsBatch(entries.map(e => e.pdbId), signal)
    for (const e of entries) {
      const l = ligandsMap.get(e.pdbId)
      if (l) e.ligands = l.split(';').map(s => s.trim()).filter(Boolean)
    }
  }

  return { entries, totalFound: total }
}

// ─── v2.26 共有结构覆盖补齐（合并报告渲染/生成前在线执行 — 新旧作业通吃）─────────

/** augmentTargetsForSharedPdbCoverage 接受的靶点最小形状 */
export interface SharedPdbAugmentTarget {
  uniprotId?: string
  proteinName: string
  directPdbs: PdbEntry[]
}

/** 补齐详情的候选条目上限（交集物理上远小；护栏防极端大表） */
const AUGMENT_MAX_NEW_ENTRIES = 100
/** 补齐整体墙钟预算（分页 ID 检索 + GraphQL 详情；超时/失败静默返回原 targets） */
const AUGMENT_BUDGET_MS = 45_000

/**
 * v2.26 多靶点共有结构覆盖补齐。
 * 现状根因：评估作业落库的 directPdbs 上限 500 条（fetchPdbIdsForUniprot 默认），
 * 高频共用组分（Gβ/Gα 等）在 PDB 有 1000+ 条目 → 复合物共有结构若排位 >500 即
 * 缺失 → 共有结构交集为空（用户 CCR8+GNAI1+GNB1 批次：8KFX 等 5 个复合物全丢）。
 *
 * 本函数在合并报告生成/渲染前执行（旧报告 GET 升级重渲染同样经过）：
 *  1. 每个输入 UniProt 分页拉取全量 PDB ID（≤3000/acc；ID 列表极轻）
 *  2. 求覆盖 ≥2 个输入 UniProt 的候选共有条目（全量口径交集 — 免重跑评估即修复）
 *  3. 各 target.directPdbs 缺失的候选 → GraphQL 批量详情（50/批）→ 精简 PdbEntry
 *  4. 按条目实体 UniProt 注记（uniprotAccs）归属并入对应 target 的 directPdbs
 *     （合并后按分辨率升序重排 — 与评估管线落库顺序一致）
 * 网络失败/超时静默返回原 targets（行为同修复前，永不阻塞报告生成）。
 * 只补交集内缺失条目 — 不把全量 1000+ 条灌进 directPdbs（单靶点明细列表体积不受影响）。
 */
export async function augmentTargetsForSharedPdbCoverage<T extends SharedPdbAugmentTarget>(
  targets: T[],
  signal?: AbortSignal,
): Promise<{ targets: T[]; added: number }> {
  const accs = [...new Set(targets.map(t => t.uniprotId).filter((a): a is string => !!a))]
  if (accs.length < 2) return { targets, added: 0 }

  const budgetCtrl = new AbortController()
  const budgetTimer = setTimeout(() => budgetCtrl.abort(), AUGMENT_BUDGET_MS)
  const onOuterAbort = () => budgetCtrl.abort()
  signal?.addEventListener('abort', onOuterAbort, { once: true })
  try {
    // 1) 全量 ID（并发；单 acc 失败 → 退回该靶点现有 directPdbs 的 ID 集，不倒退）
    const idsByAcc = new Map<string, Set<string>>()
    await Promise.all(accs.map(async acc => {
      try {
        const ids = await fetchAllPdbIdsForUniprot(acc, budgetCtrl.signal)
        idsByAcc.set(acc, new Set(ids))
      } catch { /* 单 acc 失败仅跳过（下方兜底回填） */ }
    }))
    for (const t of targets) {
      if (!t.uniprotId || idsByAcc.has(t.uniprotId)) continue
      const s = new Set<string>()
      for (const p of t.directPdbs) s.add(p.pdbId.toUpperCase())
      idsByAcc.set(t.uniprotId, s)
    }
    if (budgetCtrl.signal.aborted) return { targets, added: 0 }

    // 2) 候选共有条目（覆盖 ≥2 个输入 UniProt）
    const cover = new Map<string, Set<string>>()
    for (const [acc, ids] of idsByAcc) {
      for (const id of ids) {
        const s = cover.get(id)
        if (s) s.add(acc)
        else cover.set(id, new Set([acc]))
      }
    }
    const candidates = [...cover.entries()].filter(([, accSet]) => accSet.size >= 2).map(([id]) => id)
    if (!candidates.length) return { targets, added: 0 }
    // 覆盖数降序（3 靶点复合物优先于 2 靶点对）——详情拉取上限内保最重要的先补
    const candidateRank = new Map(candidates.map(id => [id, cover.get(id)!.size]))
    candidates.sort((a, b) => (candidateRank.get(b)! - candidateRank.get(a)!) || a.localeCompare(b))

    // 3) 候选条目来源：已有详情（任一 target 持有 → 直接复制并入缺失 target — 同一条 PDB
    //    的详情全等，无需重拉）+ 全无详情的（GraphQL 批量拉取，≤100 条护栏）
    const existingById = new Map<string, PdbEntry>()
    for (const t of targets) for (const p of t.directPdbs) existingById.set(p.pdbId.toUpperCase(), p)
    const needFetch = candidates.filter(id => !existingById.has(id)).slice(0, AUGMENT_MAX_NEW_ENTRIES)
    const metas = needFetch.length ? await fetchEntriesMetaBatch(needFetch, budgetCtrl.signal) : new Map<string, EntryMeta>()
    if (budgetCtrl.signal.aborted) return { targets, added: 0 }

    // 4) 归属并入：每个候选条目 → 其覆盖的全部输入 UniProt 对应 target 的 directPdbs
    //    （copy：已有 entry 引用复制；fetch：uniprotAccs 权威校验 ≥2 输入 acc）
    const addByAcc = new Map<string, PdbEntry[]>()
    let added = 0
    for (const id of candidates) {
      const covAccs = [...cover.get(id)!]
      const entry = existingById.get(id)
      if (entry) {
        // 已有详情（任一 target 持有）→ 复制并入其它覆盖 target（同 PDB 详情全等）
        for (const a of covAccs) {
          const arr = addByAcc.get(a)
          if (arr) arr.push(entry)
          else addByAcc.set(a, [entry])
        }
        added++
        continue
      }
      const m = metas.get(id)
      if (!m) continue
      const hitAccs = m.uniprotAccs.filter(a => (accs as string[]).includes(a))
      if (hitAccs.length < 2) continue
      const fetched = entryMetaToPdbEntry(m)
      for (const a of hitAccs) {
        const arr = addByAcc.get(a)
        if (arr) arr.push(fetched)
        else addByAcc.set(a, [fetched])
      }
      added++
    }
    if (!added) return { targets, added: 0 }

    const out = targets.map(t => {
      const add = t.uniprotId ? addByAcc.get(t.uniprotId) : undefined
      if (!add?.length) return t
      const have = new Set(t.directPdbs.map(p => p.pdbId.toUpperCase()))
      const merged = [...t.directPdbs, ...add.filter(e => !have.has(e.pdbId.toUpperCase()))]
      merged.sort((a, b) => {
        if (a.resolution == null && b.resolution == null) return a.pdbId.localeCompare(b.pdbId)
        if (a.resolution == null) return 1
        if (b.resolution == null) return -1
        return a.resolution - b.resolution
      })
      return { ...t, directPdbs: merged }
    })
    return { targets: out, added }
  } catch {
    return { targets, added: 0 } // 永不阻塞：任何异常退回原数据
  } finally {
    clearTimeout(budgetTimer)
    signal?.removeEventListener('abort', onOuterAbort)
  }
}
