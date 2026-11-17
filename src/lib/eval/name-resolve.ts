/**
 * 蛋白名称 → UniProt accession 解析（v2.24 非标准评估表兼容）。
 *
 * 场景：评估表（Word）中只有靶点名称（基因符号 / 蛋白缩写 / 别名，如 TL1A、PD-L1、
 * c-Met）而没有 UniProt ID 与序列 —— 旧版直接「无法开始评估」。本模块把 LLM/规则
 * 提取出的靶点名称经 **UniProt REST 权威检索**（不靠 LLM 背诵 accession —— 防幻觉）
 * 解析为 accession，返回命中依据（匹配字段 / 基因名 / 物种 / Swiss-Prot 评审状态）。
 *
 * 解析策略（逐名称，最多 3 级查询，前者命中即止）：
 *  1. (gene:"N" OR protein_name:"N") AND organism_id:9606   —— 人源优先
 *  2. (gene:"N" OR protein_name:"N")                        —— 任意物种
 *  3. N（全文检索，仅限「基因样」名称 —— 大写字母/数字/连字符词）防止误命中散文
 * 命中评分：基因符号/别名精确匹配 > 蛋白名精确匹配 > 蛋白名包含；reviewed（Swiss-Prot）
 * 与人源加权。阈值过滤保证「弱命中不注入」（如把 SDS 解析成某条肽段）。
 *
 * 记忆策略：查询经 apiCache（LRU，幂等 GET）缓存 —— 同名重试/断流重连不打 UniProt。
 * 并发：名称级并行 + 总预算 race（超时取已完成部分，不阻塞响应）。
 */
import { cachedJsonFetch } from './cache'
import type { ResolvedUniprot } from './types'

/** 单次查询超时（cachedJsonFetch） */
const SEARCH_TIMEOUT_MS = 6_000
/** 名称解析总预算（超时取已完成部分） */
const DEFAULT_BUDGET_MS = 7_000
/** 最多解析的名称数（LLM 提取侧同样 ≤12） */
const MAX_NAMES = 12
/** 每级查询返回条目上限 */
const SEARCH_SIZE = 8

/** 实验噪音 / 非靶点 token 停用词（大写归一比较）——防止把试剂、方法、表单字段当靶点解析 */
const NAME_STOPWORDS = new Set([
  // 缓冲液/试剂/亲和标签
  'SDS', 'PAGE', 'SDS-PAGE', 'SEC', 'NTA', 'PBS', 'TBS', 'TBST', 'HEPES', 'TRIS', 'MOPS',
  'IPTG', 'DMSO', 'DNA', 'RNA', 'DNASE', 'RNASE', 'PCR', 'GST', 'MBP', 'TEV', 'BSA', 'DTT',
  'TCEP', 'EDTA', 'EGTA', 'PMSF', 'CHAPS', 'DDM', 'LMNG', 'GDN', 'DOPC', 'POPC', 'POPE',
  'POPS', 'CHS', 'CHOLESTEROL', 'PEG', 'ATP', 'ADP', 'GTP', 'GDP', 'FAD', 'NAD', 'NADP',
  'AMP', 'CMP', 'GMP', 'UDP', 'GDP-MANNOSE', 'HEPARIN', 'GFP', 'EGFP', 'YFP', 'RFP',
  'MCHERRY', 'FLAG', 'HA', 'MYC', 'HIS', 'HISTAG', 'SUMO', 'NUS', 'AVI', 'BIRAB',
  // 细胞系 / 宿主
  'HELA', 'CHO', 'HEK', 'HEK293', 'HEK293T', 'SF9', 'SF21', 'HIGH5', 'BL21', 'TOP10',
  'DH5A', 'XL1',
  // 仪器 / 方法 / 单位
  'HPLC', 'FPLC', 'ELISA', 'WB', 'SPR', 'ITC', 'MST', 'BLI', 'DSF', 'CD', 'DSC', 'EM',
  'Cryo-EM', 'NMR', 'TEM', 'UV', 'VIS', 'OD', 'A280', 'MW', 'KDA', 'RPM', 'PH', 'V0',
  'LC-MS', 'MS', 'LCMS', 'UPLC',
  // 表单 / 文档字段词（规则兜底提取的常见干扰）
  'NO', 'YES', 'OK', 'NOT', 'AND', 'OR', 'THE', 'FOR', 'FROM', 'WITH', 'NOTE', 'NAME',
  'DATE', 'VERSION', 'COMPANY', 'CONTACT', 'EMAIL', 'PHONE', 'ADDRESS', 'AMOUNT', 'TOTAL',
  'PRICE', 'COST', 'STATUS', 'TYPE', 'SIZE', 'BATCH', 'LOT', 'ORDER', 'NUMBER', 'QTY',
  'QUANTITY', 'VOLUME', 'WEIGHT', 'CONC', 'TEMP', 'TIME', 'BUFFER', 'SAMPLE', 'METHOD',
  'RESULT', 'DATA', 'FIG', 'TABLE', 'APPENDIX', 'REF', 'PMID', 'DOI', 'URL', 'HTTP',
  'HTTPS', 'WWW', 'PDF', 'DOC', 'DOCX', 'XLSX', 'CSV', 'TXT', 'POI', 'PROTEIN', 'TARGET',
  'GENE', 'ID', 'GO', 'ITEM', 'SUMMARY', 'DESCRIPTION', 'DETAIL', 'REMARK', 'COMMENT',
  'CLIENT', 'CUSTOMER', 'PROJECT', 'TITLE', 'AUTHOR', 'LAB', 'PI',
])

/** 罗马数字（I/II/III/IV/X…）与单双字母——条款编号而非靶点 */
const ROMAN_RE = /^(?:[IVXLCDM]{1,7}|[A-Z]|[A-Z]{2})$/

/**
 * 名称可解析性预检：拉丁字母词（≥2 字符），非停用词/罗马数字/纯数字。
 * 中文名（无拉丁字母）不可直接检索 —— LLM 提取侧已要求输出英文名/别名。
 */
export function isResolvableName(name: string): boolean {
  const n = name.trim()
  if (n.length < 2 || n.length > 40) return false
  if (!/[A-Za-z]/.test(n)) return false
  if (!/^[A-Za-z0-9][A-Za-z0-9\-/( )]*$/.test(n)) return false
  if (/^\d+$/.test(n)) return false
  if (NAME_STOPWORDS.has(n.toUpperCase())) return false
  if (ROMAN_RE.test(n)) return false
  return true
}

// ─── UniProt 检索 ───────────────────────────────────────────────────────────

interface SearchHit {
  primaryAccession: string
  uniProtkbId?: string
  entryType?: string
  proteinDescription?: {
    recommendedName?: { fullName?: { value?: string }; shortName?: Array<{ value?: string }> }
    submissionNames?: Array<{ fullName?: { value?: string } }>
    alternativeNames?: Array<{ fullName?: { value?: string }; shortName?: Array<{ value?: string }> }>
  }
  genes?: Array<{ geneName?: { value?: string }; synonyms?: Array<{ value?: string }> }>
  organism?: { scientificName?: string; commonName?: string }
  sequence?: { length?: number }
}

/** 基因样名称（大写字母/数字/连字符，如 TL1A、PD-L1、5-HT2B）—— 允许全文检索兜底 */
const GENE_LIKE_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/

async function searchUniprot(query: string): Promise<SearchHit[] | null> {
  const url =
    `https://rest.uniprot.org/uniprotkb/search?query=${encodeURIComponent(query)}` +
    `&fields=accession,id,protein_name,gene_names,organism_name,reviewed,length&format=json&size=${SEARCH_SIZE}`
  const raw = await cachedJsonFetch<{ results?: SearchHit[] }>(url, { timeoutMs: SEARCH_TIMEOUT_MS })
  return raw?.results ?? []
}

function hitGenes(hit: SearchHit): string[] {
  const out: string[] = []
  for (const g of hit.genes ?? []) {
    if (g.geneName?.value) out.push(g.geneName.value)
    for (const s of g.synonyms ?? []) if (s.value) out.push(s.value)
  }
  return [...new Set(out)]
}

function hitProteinNames(hit: SearchHit): string[] {
  const d = hit.proteinDescription ?? {}
  const out: string[] = []
  const rn = d.recommendedName
  if (rn?.fullName?.value) out.push(rn.fullName.value)
  for (const s of rn?.shortName ?? []) if (s.value) out.push(s.value)
  for (const a of d.alternativeNames ?? []) {
    if (a.fullName?.value) out.push(a.fullName.value)
    for (const s of a.shortName ?? []) if (s.value) out.push(s.value)
  }
  for (const s of d.submissionNames ?? []) if (s.fullName?.value) out.push(s.fullName.value)
  return out
}

function isReviewed(hit: SearchHit): boolean {
  return (hit.entryType ?? '').includes('reviewed')
}

function isHuman(hit: SearchHit): boolean {
  return /homo sapiens|human/i.test(hit.organism?.scientificName ?? '')
}

/** 命中评分：精确基因/别名 > 精确蛋白名 > 片段包含；reviewed 与人源加权 */
function scoreHit(hit: SearchHit, name: string): { score: number; matchedOn: 'gene' | 'protein' | 'text' } {
  const n = name.toLowerCase()
  const genes = hitGenes(hit).map(g => g.toLowerCase())
  const pnames = hitProteinNames(hit).map(p => p.toLowerCase())
  let score = 0
  let matchedOn: 'gene' | 'protein' | 'text' = 'text'
  if (genes.some(g => g === n)) {
    score += 50
    matchedOn = 'gene'
  } else if (genes.some(g => g.includes(n) || n.includes(g))) {
    score += 18
    if (matchedOn === 'text') matchedOn = 'gene'
  }
  if (pnames.some(p => p === n)) {
    score += 40
    if (matchedOn === 'text') matchedOn = 'protein'
  } else if (pnames.some(p => p.includes(` ${n} `) || p.includes(`(${n})`) || p === n || p.startsWith(`${n} `) || p.endsWith(` ${n}`))) {
    score += 20
    if (matchedOn === 'text') matchedOn = 'protein'
  }
  if (isReviewed(hit)) score += 25
  if (isHuman(hit)) score += 12
  return { score, matchedOn }
}

/** 单名称解析：3 级查询（人源 → 任意物种 → 全文兜底），返回最优命中 + 备选 */
async function resolveOneName(name: string): Promise<ResolvedUniprot | null> {
  const quoted = `"${name.replace(/"/g, '')}"`
  const attempts: Array<{ query: string; matchedOn: 'gene' | 'protein' | 'text' }> = [
    { query: `(gene:${quoted} OR protein_name:${quoted}) AND organism_id:9606`, matchedOn: 'gene' },
    { query: `(gene:${quoted} OR protein_name:${quoted})`, matchedOn: 'gene' },
  ]
  if (GENE_LIKE_RE.test(name)) {
    attempts.push({ query: name, matchedOn: 'text' })
  }

  for (const att of attempts) {
    const hits = await searchUniprot(att.query)
    if (!hits?.length) continue
    const scored = hits
      .filter(h => h.primaryAccession)
      .map(h => ({ hit: h, ...scoreHit(h, name) }))
      .sort((a, b) => b.score - a.score)
    if (!scored.length) continue
    const best = scored[0]
    // 注入阈值：精确基因/蛋白命中，或「reviewed + 人源 + 弱匹配」的高置信组合；
    // 全文兜底命中必须 reviewed 且人源（防把普通英文词解析成随机条目）
    const strong =
      best.matchedOn !== 'text' && best.score >= 40 ||
      (best.matchedOn === 'gene' && best.score >= 50) ||
      (isReviewed(best.hit) && isHuman(best.hit) && best.score >= 37)
    if (!strong) continue
    const h = best.hit
    const out: ResolvedUniprot = {
      name,
      accession: h.primaryAccession,
      entryName: h.uniProtkbId,
      proteinName: hitProteinNames(h)[0],
      geneNames: hitGenes(h).slice(0, 6),
      organism: h.organism?.scientificName ?? h.organism?.commonName,
      reviewed: isReviewed(h),
      matchedOn: best.matchedOn,
      seqLength: h.sequence?.length,
    }
    // 备选（不同 accession，最多 2 条：常见为近缘物种 / 未评审异构体）
    out.alternates = scored
      .slice(1)
      .filter(s => s.hit.primaryAccession !== h.primaryAccession)
      .slice(0, 2)
      .map(s => ({
        accession: s.hit.primaryAccession,
        proteinName: hitProteinNames(s.hit)[0],
        organism: s.hit.organism?.scientificName ?? s.hit.organism?.commonName,
        reviewed: isReviewed(s.hit),
      }))
    return out
  }
  return null
}

/** 批量解析入口：去重预检 → 名称级并行 → 总预算 race（超时取已完成部分） */
export async function resolveTargetNames(
  names: string[],
  opts: { budgetMs?: number; maxNames?: number } = {},
): Promise<{ resolved: ResolvedUniprot[]; unresolved: string[] }> {
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS
  const maxNames = opts.maxNames ?? MAX_NAMES
  const cleaned = [...new Set(names.map(n => n.trim()).filter(isResolvableName))].slice(0, maxNames)
  if (!cleaned.length) return { resolved: [], unresolved: [] }

  const resolved: ResolvedUniprot[] = []
  const unresolved: string[] = []
  const seen = new Set<string>()
  const work = (async () => {
    await Promise.all(
      cleaned.map(async (name) => {
        try {
          const r = await resolveOneName(name)
          if (r && !seen.has(r.accession)) {
            seen.add(r.accession)
            resolved.push(r)
          } else if (!r) {
            unresolved.push(name)
          }
        } catch {
          unresolved.push(name)
        }
      }),
    )
  })()
  await Promise.race([
    work,
    new Promise<void>((res) => setTimeout(res, budgetMs)),
  ])
  return { resolved, unresolved: unresolved.slice(0, 8) }
}
