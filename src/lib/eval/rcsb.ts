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

/** 按 UniProt accession 检索关联 PDB ID 列表（去重）。 */
export async function fetchPdbIdsForUniprot(uniprotId: string, max = 500): Promise<string[]> {
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
      paginate: { start: 0, rows: Math.min(500, max) },
      sort: [{ sort_by: 'rcsb_accession_info.initial_release_date', direction: 'desc' }],
    },
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20_000)
    try {
      const res = await fetch(SEARCH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (res.ok) {
        const data = await res.json() as { result_set?: Array<{ identifier?: string }> }
        const ids = (data.result_set ?? [])
          .map(r => (r.identifier ?? '').toUpperCase())
          .filter(id => /^[0-9A-Z]{4}$/.test(id))
        return [...new Set(ids)]
      }
      if (res.status < 500 && res.status !== 429) return []
    } catch {
      /* 重试一次 */
    } finally {
      clearTimeout(timer)
    }
    if (attempt === 0) await new Promise(r => setTimeout(r, 1200))
  }
  return []
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
    const res = await fetch(`${DATA_URL}/${pdbId}`, {
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
 * 拉取 PDB 条目详情（含配体回填）。
 * @param ids 全量 PDB ID
 * @param maxDetail 拉取详情的上限（默认 150）
 * @param onProgress (done, total)
 */
export async function fetchPdbEntries(
  ids: string[],
  maxDetail: number,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<PdbsResult> {
  const total = ids.length
  const detailIds = ids.slice(0, Math.max(1, maxDetail))
  const entries: PdbEntry[] = []
  const CONCURRENCY = 5
  let next = 0
  let done = 0

  async function worker() {
    while (next < detailIds.length && !signal?.aborted) {
      const i = next++
      const pdbId = detailIds[i]
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
