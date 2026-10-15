/**
 * UniProt REST 数据访问 — 元数据 + 序列 + 关键 features。
 * 内存策略：一次请求取回整个 JSON，提取小字段后即释放；apiCache 缓存。
 */
import { cachedJsonFetch } from './cache'
import type { UniprotInfo, UniprotFeature } from './types'
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
    [k: string]: unknown
  }>
  features?: Array<{ type?: string; description?: string; location?: { start?: { value?: number }; end?: { value?: number } } }>
  keywords?: Array<{ name?: string }>
  entryType?: string
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

  // features：结构域/跨膜/信号肽/活性位点/重复序列等关键类型
  const FEATURE_KEEP = new Set([
    'Domain', 'Signal', 'Transmembrane', 'Active site', 'Binding site',
    'Region', 'Repeat', 'Zinc finger', 'DNA-binding', 'Nucleotide binding',
    'Site', 'Modified residue', 'Disulfide bond', 'Calcium binding',
    'Motif', 'Compositionally biased region', 'Intramembrane',
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
  }

  const keywords = (raw.keywords ?? []).map(k => k.name ?? '').filter(Boolean).slice(0, 30)

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
    features,
    keywords,
  }
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
