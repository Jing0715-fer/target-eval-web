/**
 * 配体归一与研究数据查询（仅服务端）。
 *
 * 「非标准输入 → RCSB 化学组分 ID」多策略解析链（v2.2 配体功能）：
 *  1. direct-id   输入即 1-5 位化学组分 ID（如 ATP / STU / A1H2J）→ RCSB chemcomp API 校验
 *  2. alias       别名表命中（中英文名，均经 RCSB 官方 chemcomp 名称核实）
 *  3. pdb-search  PDBe Solr 全文检索（英文）→ 命中条目 bound_compound_id 反推
 *                 候选 ID，必须通过 chemcomp 名称词面验证（防共结晶噪声如
 *                 "glucose"→ZN）
 *  4. pubchem     PubChem 名称检索（含品牌药名/同义词）→ 分子式/MW/IUPAC/SMILES；
 *                 再用 SMILES 经 RCSB 化学检索（graph-exact / fingerprint）映射回
 *                 PDB 组分 ID（分子式硬校验）— 无 PDB 对应时仍以 PubChem 详情成卡
 *  5. llm         AI 兜底（中文俗名/分子式/描述性输入）：给出候选 ID、标准英文名
 *                 与分子式 → 候选经 chemcomp 分子式硬校验（防幻觉错配，如
 *                 阿司匹林→ASP 冬氨酸、C9H8O4→ASA 门冬醛）；英文名回灌 PubChem 复核；
 *                 绝不直接采信
 *
 * 结构列表：PDBe Solr 字段化检索 bound_compound_id:"XXX"（含该配体的 PDB 条目）。
 * 数据通道均已实测可用（2026-11 探测）：
 *  - RCSB  https://data.rcsb.org/rest/v1/core/chemcomp/{id}
 *  - PDBe  https://www.ebi.ac.uk/pdbe/search/pdb/select?q=...
 *  - PubChem PUG REST（pubchem.ts）+ RCSB chemical search（graph-exact 实测 1.0 分）
 */
import { llmChat } from './llm'
import { apiCache } from './cache'
import { LIGAND_JUNK_IDS } from './ligand-parse'
import { cutFormTemplateTail } from './types'
import { pubchemLookupName, rcsbChemicalCandidates, type PubChemCompound } from './pubchem'

// ─── 类型 ─────────────────────────────────────────────────────────────────────

export type LigandInputSource = 'text' | 'file' | 'eval-table'

export interface LigandInput {
  /** 原始输入（名称 / 分子式 / 三位 ID / 文件提取线索） */
  raw: string
  source: LigandInputSource
  fileName?: string
}

export interface LigandStructureLite {
  pdbId: string
  title: string
  method: string
  resolution: number | null
  releaseDate: string
  /** 同时是本靶点的直接结构（RCSB UniProt 检索交集） */
  alsoTarget: boolean
}

export interface LigandResolution {
  raw: string
  source: LigandInputSource
  fileName?: string
  ok: boolean
  compId: string
  name: string
  formula: string
  weight: number | null
  /** 归一策略（direct-id / alias / pdb-search / pubchem / llm / llm+pdb-search / llm+pubchem） */
  strategy: string
  error?: string
  /** 含此配体的结构总数（Solr 命中数） */
  totalStructures: number
  /** 展示用结构列表（按分辨率升序，cap 12） */
  structures: LigandStructureLite[]
  /** v2.2：PubChem 识别详情（无 PDB 对应时仍能给出分子式/MW/名称/CID） */
  pubchem?: { cid: number; iupacName?: string; smiles?: string }
}

// ─── 别名表（id 与名称均经 RCSB chemcomp 官方核实，2026-11）────────────────

interface AliasEntry { id: string; name: string; keys: string[] }

const LIGAND_ALIASES: AliasEntry[] = [
  { id: 'ATP', name: 'Adenosine-5′-triphosphate', keys: ['atp', 'adenosine triphosphate', '三磷酸腺苷', '腺苷三磷酸'] },
  { id: 'GTP', name: 'Guanosine-5′-triphosphate', keys: ['gtp', 'guanosine triphosphate', '三磷酸鸟苷', '鸟苷三磷酸'] },
  { id: 'CTP', name: 'Cytidine-5′-triphosphate', keys: ['ctp', 'cytidine triphosphate', '三磷酸胞苷', '胞苷三磷酸'] },
  { id: 'UTP', name: 'Uridine 5′-triphosphate', keys: ['utp', 'uridine triphosphate', '三磷酸尿苷', '尿苷三磷酸'] },
  { id: 'TTP', name: 'Thymidine-5′-triphosphate', keys: ['ttp', 'thymidine triphosphate', '三磷酸胸苷', '胸苷三磷酸'] },
  { id: 'ADP', name: 'Adenosine-5′-diphosphate', keys: ['adp', 'adenosine diphosphate', '二磷酸腺苷', '腺苷二磷酸'] },
  { id: 'GDP', name: 'Guanosine-5′-diphosphate', keys: ['gdp', 'guanosine diphosphate', '二磷酸鸟苷', '鸟苷二磷酸'] },
  { id: 'FAD', name: 'Flavin-adenine dinucleotide', keys: ['fad', 'flavin adenine dinucleotide', '黄素腺嘌呤二核苷酸'] },
  { id: 'FMN', name: 'Flavin mononucleotide', keys: ['fmn', 'flavin mononucleotide', '黄素单核苷酸'] },
  { id: 'NAD', name: 'Nicotinamide-adenine dinucleotide', keys: ['nad', 'nicotinamide adenine dinucleotide', '烟酰胺腺嘌呤二核苷酸'] },
  { id: 'NAP', name: 'NADP (nicotinamide-adenine-dinucleotide phosphate)', keys: ['nadp', 'nicotinamide adenine dinucleotide phosphate', '烟酰胺腺嘌呤二核苷酸磷酸'] },
  { id: 'COA', name: 'Coenzyme A', keys: ['coa', 'coenzyme a', '辅酶a'] },
  { id: 'ACO', name: 'Acetyl coenzyme A', keys: ['acetyl-coa', 'acetyl coa', 'acetyl coenzyme a', '乙酰辅酶a'] },
  { id: 'PLP', name: 'Pyridoxal-5′-phosphate', keys: ['plp', 'pyridoxal phosphate', '磷酸吡哆醛'] },
  { id: 'SAM', name: 'S-adenosylmethionine', keys: ['sam', 's-adenosylmethionine', 's-腺苷甲硫氨酸'] },
  { id: 'SAH', name: 'S-adenosyl-L-homocysteine', keys: ['sah', 's-adenosylhomocysteine', 's-腺苷同型半胱氨酸'] },
  { id: 'RET', name: 'Retinal', keys: ['retinal', '视黄醛'] },
  { id: 'CLR', name: 'Cholesterol', keys: ['cholesterol', '胆固醇'] },
  { id: 'GSH', name: 'Glutathione', keys: ['gsh', 'glutathione', '谷胱甘肽'] },
  { id: 'FOL', name: 'Folic acid', keys: ['fol', 'folic acid', '叶酸'] },
  { id: 'MTX', name: 'Methotrexate', keys: ['mtx', 'methotrexate', '甲氨蝶呤'] },
  { id: 'BTN', name: 'Biotin', keys: ['biotin', '生物素'] },
  { id: 'HEM', name: 'Heme (protoporphyrin IX containing Fe)', keys: ['hem', 'heme', 'hemin', '血红素', '氯化血红素'] },
  { id: 'HEC', name: 'Heme C', keys: ['heme c', '血红素c'] },
  { id: 'STU', name: 'Staurosporine', keys: ['staurosporine', '星形孢菌素', '星孢菌素'] },
  { id: 'STI', name: 'Imatinib', keys: ['imatinib', 'gleevec', '伊马替尼', '格列卫'] },
]

/** 拉丁字母短 key（≤3 字符）不参与评估表全文扫描（避免 SAM 结构域等误报），仅用于输入归一 */
function isTextScanSafe(key: string): boolean {
  if (/[^\x00-\x7f]/.test(key)) return key.length >= 2 // CJK key
  return key.replace(/[^a-z]/gi, '').length >= 4
}

const ALIAS_LOOKUP = new Map<string, AliasEntry>()
for (const a of LIGAND_ALIASES) {
  ALIAS_LOOKUP.set(a.id.toLowerCase(), a)
  for (const k of a.keys) ALIAS_LOOKUP.set(k.toLowerCase(), a)
}

// ─── 归一化工具 ───────────────────────────────────────────────────────────────

/** 输入归一：小写、去中间点/连字符变体、折叠空白（保留 CJK） */
export function normalizeLigandRaw(s: string): string {
  return s
    .toLowerCase()
    .replace(/[·・•．]/g, '')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
}

/** PDBe Solr 查询消毒：去掉查询语法字符，保留词与 CJK */
function solrSanitize(s: string): string {
  return s
    .replace(/[+\-&|!(){}\[\]^"~*?:\\\/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 疑似分子式（≥2 种元素、含数字，如 C9H8O4 / C17H19N3O9S） */
function looksLikeFormula(s: string): boolean {
  const t = s.replace(/\s+/g, '')
  if (!/^[A-Za-z0-9]+$/.test(t)) return false
  if (!/\d/.test(t)) return false
  const els = t.match(/[A-Za-z]+/g) ?? []
  if (els.length < 2) return false
  return true
}

const CJK_RE = /[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/

/** LLM 候选过滤黑名单：20 种标准氨基酸 + DNA 核苷酸三位码（聚合物组件，
 *  作为「配体研究兴趣」几乎必为 LLM 幻觉，如 阿司匹林→ASP） */
const LLM_JUNK_IDS = new Set([
  'ALA', 'ARG', 'ASN', 'ASP', 'CYS', 'GLN', 'GLU', 'GLY', 'HIS', 'ILE',
  'LEU', 'LYS', 'MET', 'PHE', 'PRO', 'SER', 'THR', 'TRP', 'TYR', 'VAL',
  'DA', 'DC', 'DG', 'DT', 'MSE', 'SEC', 'PYL',
])

// ─── 外部通道 ─────────────────────────────────────────────────────────────────

export interface ChemCompInfo {
  id: string
  name: string
  formula: string
  weight: number | null
}

/** RCSB 化学组分信息（含名称/分子式/分子量），缓存 15 分钟内存 LRU */
export async function fetchChemComp(id: string): Promise<ChemCompInfo | null> {
  const key = `ligand:chem:${id.toUpperCase()}`
  const hit = apiCache.get<ChemCompInfo>(key)
  if (hit !== undefined) return hit
  try {
    const res = await fetch(`https://data.rcsb.org/rest/v1/core/chemcomp/${encodeURIComponent(id.toUpperCase())}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(12_000),
    })
    if (!res.ok) return null
    const j = (await res.json()) as {
      chem_comp?: { id?: string; name?: string; formula?: string; formula_weight?: number }
    }
    const c = j.chem_comp
    if (!c?.id) return null
    const info: ChemCompInfo = {
      id: c.id.toUpperCase(),
      name: (c.name ?? '').toLowerCase().replace(/(^|\s)\S/g, x => x.toUpperCase()).slice(0, 80),
      formula: (c.formula ?? '').replace(/\s+/g, ' ').trim(),
      weight: typeof c.formula_weight === 'number' ? c.formula_weight : null,
    }
    apiCache.set(key, info)
    return info
  } catch {
    return null
  }
}

interface SolrDoc {
  pdb_id?: string
  title?: string
  resolution?: number | Array<number | null | undefined>
  experimental_method?: string[]
  release_date?: string
  bound_compound_id?: string[]
  interacting_ligands?: string[]
}

interface SolrResult {
  numFound: number
  docs: SolrDoc[]
}

const SOLR_BASE = 'https://www.ebi.ac.uk/pdbe/search/pdb/select'

async function solrQuery(q: string, rows: number, signal?: AbortSignal): Promise<SolrResult | null> {
  const cacheKey = `ligand:solr:${q}:${rows}`
  const hit = apiCache.get<SolrResult>(cacheKey)
  if (hit !== undefined) return hit
  const url = `${SOLR_BASE}?q=${encodeURIComponent(q)}&wt=json&rows=${Math.min(200, Math.max(1, rows))}`
    + `&fl=pdb_id,title,resolution,experimental_method,release_date,bound_compound_id,interacting_ligands`
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: signal ?? AbortSignal.timeout(15_000),
    })
    if (!res.ok) return null
    const j = (await res.json()) as { response?: { numFound?: number; docs?: SolrDoc[] } }
    const out: SolrResult = { numFound: j.response?.numFound ?? 0, docs: j.response?.docs ?? [] }
    apiCache.set(cacheKey, out)
    return out
  } catch {
    return null
  }
}

function firstResolution(d: SolrDoc): number | null {
  const r = d.resolution
  if (typeof r === 'number') return r
  if (Array.isArray(r)) {
    const v = r.find(x => typeof x === 'number') as number | undefined
    return v ?? null
  }
  return null
}

/** Solr 全文检索 → 候选三位 ID 计数（interacting_ligands "ID : NAME" 命中 +3，bound_compound +1） */
async function solrCandidates(q: string, rows: number, signal?: AbortSignal): Promise<Map<string, number>> {
  const r = await solrQuery(q, rows, signal)
  const tally = new Map<string, number>()
  if (!r) return tally
  const ql = q.toLowerCase()
  for (const d of r.docs) {
    for (const il of d.interacting_ligands ?? []) {
      const m = il.match(/^([A-Z0-9]{1,3})\s*:\s*(.+)$/)
      if (m) {
        const cid = m[1].toUpperCase()
        const cname = m[2].toLowerCase()
        if (!LIGAND_JUNK_IDS.has(cid) && (cname.includes(ql) || ql.includes(cname))) {
          tally.set(cid, (tally.get(cid) ?? 0) + 3)
        }
      }
    }
    for (const cid of d.bound_compound_id ?? []) {
      const c = (cid ?? '').toUpperCase()
      if (c && !LIGAND_JUNK_IDS.has(c)) tally.set(c, (tally.get(c) ?? 0) + 1)
    }
  }
  return tally
}

// ─── 分子式一致性 ─────────────────────────────────────────────────────────────

const EL_RE = /^(H|He|Li|Be|B|C|N|O|F|Ne|Na|Mg|Al|Si|P|S|Cl|Ar|K|Ca|Sc|Ti|V|Cr|Mn|Fe|Co|Ni|Cu|Zn|Ga|Ge|As|Se|Br|Rb|Sr|Y|Zr|Nb|Mo|Tc|Ru|Rh|Pd|Ag|Cd|In|Sn|Sb|Te|I|Xe|Cs|Ba|La|Hf|Ta|W|Re|Os|Ir|Pt|Au|Hg|Tl|Pb|Bi|Th|Pa|U)$/

/** 分子式 → 元素计数多重集（"C9 H8 O4" / "C9H8O4"） */
export function parseFormulaCounts(f: string): Map<string, number> | null {
  const out = new Map<string, number>()
  const re = /([A-Z][a-z]?)(\d*)/g
  let m: RegExpExecArray | null
  let any = false
  while ((m = re.exec(f.replace(/\s+/g, '')))) {
    if (!EL_RE.test(m[1])) continue
    out.set(m[1], (out.get(m[1]) ?? 0) + (m[2] ? parseInt(m[2], 10) : 1))
    any = true
  }
  return any ? out : null
}

/** 两个分子式是否为同一化合物（元素计数完全一致；同分异构体不区分） */
export function formulaMatches(a: string, b: string): boolean {
  const fa = parseFormulaCounts(a)
  const fb = parseFormulaCounts(b)
  if (!fa || !fb) return false
  if (fa.size !== fb.size) return false
  for (const [el, n] of fa) {
    if (fb.get(el) !== n) return false
  }
  return true
}

// ─── LLM 兜底 ─────────────────────────────────────────────────────────────────

const LIGAND_LLM_SYSTEM = `你是 PDB 化学组分（配体）归一专家。PDB 用 1-3 位化学组分 ID（chemical component ID，如 ATP、STU=星形孢菌素、STI=伊马替尼、HEM=血红素、AIN=阿司匹林）登记配体。
用户给出一段非标准配体描述（可能是中文俗名、分子式、品牌药名、化学描述、或上传文件提取的线索）。请将其映射到最可能的 PDB 化学组分。
严格输出一个 JSON 对象，不要任何其他文字：
{"id": "三位 ID（非常有把握时给出，否则 null）", "name": "标准英文名（如 aspirin；分子式输入必须给出对应物质的英文名）", "formula": "分子式（如 C9H8O4；不确定则 null）", "confidence": 0, "note": "一句话依据（中文）"}
规则：
- 三位 ID 极易与氨基酸码混淆（如 ASP=冬氨酸），没有把握就给 null，靠 name/formula 兜底
- 分子式输入（如 C9H8O4）：给出该物质的英文名与分子式，如 {"name":"aspirin","formula":"C9H8O4"}
- 辅因子/药物类（ATP/GTP/FAD/NAD/血红素/伊马替尼等）的中文俗名应给出对应英文与分子式
- formula 为 Hill 顺序或无空格形式均可；confidence 为 0-100 整数`

interface LlmLigandVerdict {
  id: string | null
  name: string | null
  formula: string | null
  confidence: number
  note: string
}

async function llmResolveLigand(raw: string, isFormula: boolean, signal?: AbortSignal): Promise<LlmLigandVerdict | null> {
  const hint = isFormula ? '（输入疑似分子式）' : ''
  const r = await llmChat(
    `配体描述：${raw}${hint}\n请按系统指令输出 JSON。`,
    LIGAND_LLM_SYSTEM,
    signal,
  )
  if (!r.ok || !r.text.trim()) return null
  const cleaned = r.text.replace(/```json/gi, '```').replace(/```/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const o = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>
    const id = typeof o.id === 'string' && /^[A-Za-z0-9]{1,3}$/.test(o.id) ? o.id.toUpperCase() : null
    const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 60) : null
    const formula = typeof o.formula === 'string' && o.formula.trim() ? o.formula.trim().slice(0, 60) : null
    if (!id && !name) return null
    return {
      id,
      name,
      formula,
      confidence: Math.max(0, Math.min(100, Number(o.confidence) || 0)),
      note: typeof o.note === 'string' ? o.note.slice(0, 120) : '',
    }
  } catch {
    return null
  }
}

// ─── 解析主链 ─────────────────────────────────────────────────────────────────

const ID_RE = /^[A-Za-z0-9]{1,5}$/ // PDB 组分 ID：历史 1-3 位 + 新式 4-5 位（如 A1H2J）

// ─── PubChem → PDB 组分映射（v2.2）──────────────────────────────────────────

/**
 * PubChem 化合物（SMILES）→ PDB 化学组分：
 *  a) graph-exact（score 1.0 = 原子/键级/立体全等）+ 分子式硬校验；
 *  b) fingerprint 相似 ≥0.9 且分子式一致（同分异构同物兜底）。
 * 均不满足返回 null（调用方按「PubChem 已识别但 PDB 无对应」成卡）。
 */
async function mapPubChemToPdbComp(
  pc: PubChemCompound,
  signal?: AbortSignal,
): Promise<{ info: ChemCompInfo; strategy: string } | null> {
  if (!pc.smiles) return null
  const exact = await rcsbChemicalCandidates(pc.smiles, 'exact', signal)
  for (const c of exact) {
    if (c.score < 0.999) continue
    const info = await fetchChemComp(c.compId)
    if (info && formulaMatches(pc.formula, info.formula)) return { info, strategy: 'pubchem' }
  }
  const sim = await rcsbChemicalCandidates(pc.smiles, 'similar', signal)
  for (const c of sim) {
    if (c.score < 0.9) continue
    const info = await fetchChemComp(c.compId)
    if (info && formulaMatches(pc.formula, info.formula)) return { info, strategy: 'pubchem+similar' }
  }
  return null
}

/**
 * 单条配体输入 → 化学组分 ID（多策略，全失败时 ok=false）。
 * 结果整体进 LRU 缓存（同批次多靶点共享，不重复外呼）。
 */
export async function resolveLigandInput(input: LigandInput, signal?: AbortSignal): Promise<LigandResolution> {
  const raw = input.raw.trim().slice(0, 160)
  const base: LigandResolution = {
    raw: input.raw.trim().slice(0, 160),
    source: input.source,
    fileName: input.fileName,
    ok: false,
    compId: '',
    name: '',
    formula: '',
    weight: null,
    strategy: '',
    totalStructures: 0,
    structures: [],
  }
  if (!raw) return { ...base, error: '空输入' }

  const norm = normalizeLigandRaw(raw)

  // 1) 直接 ID（1-5 位，历史三位 + 新式更长 ID）
  if (ID_RE.test(norm) && /[a-z0-9]/i.test(norm) && norm.length <= 5) {
    const upper = norm.toUpperCase()
    if (!LIGAND_JUNK_IDS.has(upper)) {
      const info = await fetchChemComp(upper)
      if (info) {
        return {
          ...base, ok: true, compId: info.id, name: info.name,
          formula: info.formula, weight: info.weight, strategy: 'direct-id',
        }
      }
    }
  }

  // 2) 别名表
  const alias = ALIAS_LOOKUP.get(norm) ?? ALIAS_LOOKUP.get(norm.replace(/[\s-]/g, ''))
  if (alias) {
    const info = await fetchChemComp(alias.id)
    if (info) {
      return {
        ...base, ok: true, compId: info.id, name: info.name || alias.name,
        formula: info.formula, weight: info.weight, strategy: 'alias',
      }
    }
  }

  const isFormula = looksLikeFormula(norm)
  const hasCJK = CJK_RE.test(raw)
  const queryText = solrSanitize(norm)

  // 3) PDBe Solr 全文（英文输入；候选必须通过 chemcomp 名称词面验证，防共结晶噪声）
  if (!hasCJK && !isFormula && queryText.length >= 4) {
    const tally = await solrCandidates(queryText, 12, signal)
    const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
    for (const [cid, score] of ranked) {
      if (score < 4) break
      const info = await fetchChemComp(cid)
      if (!info) continue
      // 名称词面验证：chemcomp 官方名包含查询词（如 "glucose" ⊂ "beta-D-glucose"）
      if (info.name.toLowerCase().includes(queryText.toLowerCase())) {
        return {
          ...base, ok: true, compId: info.id, name: info.name || raw,
          formula: info.formula, weight: info.weight, strategy: 'pdb-search',
        }
      }
    }
  }

  // 4) PubChem 名称检索（v2.2：品牌药名/同义词 → 分子式/MW/IUPAC/SMILES；SMILES 回映射 PDB 组分）
  if (!isFormula && !hasCJK && queryText.length >= 3) {
    const pc = await pubchemLookupName(raw, signal)
    if (pc) {
      const mapped = await mapPubChemToPdbComp(pc, signal)
      if (mapped) {
        return {
          ...base, ok: true, compId: mapped.info.id, name: mapped.info.name || pc.title,
          formula: mapped.info.formula, weight: mapped.info.weight, strategy: mapped.strategy,
          pubchem: { cid: pc.cid, iupacName: pc.iupacName, smiles: pc.smiles },
        }
      }
      // PDB 无对应组分：PubChem 自身即为识别结果（分子式/MW/IUPAC 供研究参考）
      return {
        ...base, ok: true, compId: '', name: pc.title, formula: pc.formula, weight: pc.weight,
        strategy: 'pubchem', pubchem: { cid: pc.cid, iupacName: pc.iupacName, smiles: pc.smiles },
      }
    }
  }

  // 5) LLM 兜底（中文俗名 / 分子式 / 品牌名 / 文件线索）
  const verdict = await llmResolveLigand(raw, isFormula, signal)
  if (verdict) {
    // 候选池：LLM ID（黑名单过滤）→ Solr(LLM 英文名) → Solr(原英文输入)
    const candidates: string[] = []
    if (verdict.id && !LIGAND_JUNK_IDS.has(verdict.id) && !LLM_JUNK_IDS.has(verdict.id)) candidates.push(verdict.id)
    if (verdict.name) {
      const nm = solrSanitize(verdict.name)
      if (nm.length >= 4) {
        const t1 = await solrCandidates(nm, 12, signal)
        for (const [cid] of [...t1.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)) {
          if (t1.get(cid)! >= 4) candidates.push(cid)
        }
      }
    }
    if (!hasCJK && !isFormula && queryText.length >= 4 && !verdict.name) {
      const t0 = await solrCandidates(queryText, 12, signal)
      for (const [cid] of [...t0.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)) {
        if (t0.get(cid)! >= 4) candidates.push(cid)
      }
    }
    // 化学一致性校验：优先 LLM 给出的分子式；其次（分子式输入）用输入本身
    const refFormula = verdict.formula ?? (isFormula ? norm : null)
    for (const cid of [...new Set(candidates)]) {
      if (LIGAND_JUNK_IDS.has(cid) || LLM_JUNK_IDS.has(cid)) continue
      const info = await fetchChemComp(cid)
      if (!info) continue
      const formulaOk = refFormula ? formulaMatches(refFormula, info.formula) : true
      if (!formulaOk) continue
      return {
        ...base, ok: true, compId: info.id, name: info.name || verdict.name || raw,
        formula: info.formula, weight: info.weight,
        strategy: verdict.id === info.id.toUpperCase() ? 'llm' : 'llm+pdb-search',
      }
    }
    // v2.2：LLM 英文名回灌 PubChem（中文俗名/品牌名翻译后的确定性复核）
    if (verdict.name) {
      const pc = await pubchemLookupName(verdict.name, signal)
      if (pc) {
        const mapped = await mapPubChemToPdbComp(pc, signal)
        if (mapped) {
          return {
            ...base, ok: true, compId: mapped.info.id, name: mapped.info.name || pc.title,
            formula: mapped.info.formula, weight: mapped.info.weight, strategy: 'llm+pubchem',
            pubchem: { cid: pc.cid, iupacName: pc.iupacName, smiles: pc.smiles },
          }
        }
        return {
          ...base, ok: true, compId: '', name: pc.title, formula: pc.formula, weight: pc.weight,
          strategy: 'llm+pubchem', pubchem: { cid: pc.cid, iupacName: pc.iupacName, smiles: pc.smiles },
        }
      }
    }
  }

  return { ...base, error: isFormula ? '分子式未能映射到已知化合物（PDB / PubChem）' : '未能在 PDB 化学组分字典与 PubChem 中定位该输入' }
}

/** 含某配体的结构列表（Solr 字段化检索，去重排序） */
export async function fetchLigandStructures(
  compId: string,
  directSet: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<{ total: number; structures: LigandStructureLite[] }> {
  const r = await solrQuery(`bound_compound_id:${JSON.stringify(compId.toUpperCase())}`, 150, signal)
  if (!r) return { total: 0, structures: [] }
  const seen = new Map<string, LigandStructureLite>()
  for (const d of r.docs) {
    const pid = (d.pdb_id ?? '').toUpperCase()
    if (!/^[0-9A-Z]{4}$/.test(pid) || seen.has(pid)) continue
    const methods = d.experimental_method ?? []
    seen.set(pid, {
      pdbId: pid,
      title: (d.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 110),
      method: methods[0] ?? '',
      resolution: firstResolution(d),
      releaseDate: (d.release_date ?? '').slice(0, 10),
      alsoTarget: directSet.has(pid),
    })
  }
  const list = [...seen.values()].sort((a, b) => {
    if (a.resolution == null && b.resolution == null) return a.pdbId.localeCompare(b.pdbId)
    if (a.resolution == null) return 1
    if (b.resolution == null) return -1
    return a.resolution - b.resolution
  })
  return { total: r.numFound, structures: list }
}

// ─── 评估表配体识别（字典扫描；LLM 提取由 docx-llm 负责）──────────────────

export interface LigandMention {
  /** 文中命中的原文 */
  matched: string
  compId: string
  name: string
}

/** 从评估表全文扫描已知配体名（保守策略：长 key 才参与扫描，防误报） */
export function extractLigandsFromText(text: string): LigandMention[] {
  const lower = text.toLowerCase()
  const out: LigandMention[] = []
  const seen = new Set<string>()
  for (const a of LIGAND_ALIASES) {
    const allKeys = [a.id.toLowerCase(), ...a.keys]
    for (const k of allKeys) {
      if (!isTextScanSafe(k)) continue
      if (lower.includes(k)) {
        if (seen.has(a.id)) break
        seen.add(a.id)
        out.push({ matched: k, compId: a.id, name: a.name })
        break
      }
    }
  }
  return out.slice(0, 8)
}

/** 别名表展示名（报告/前端「已识别配体」徽标用） */
export function ligandDisplayName(res: LigandResolution): string {
  return res.name || res.compId || res.raw
}

// ─── 评估表配体候选的模式提取（v2.5）──────────────────────────────────────

/**
 * 模式提名黑名单：结构生物学语境中「紧邻配体关键词」的高频非配体拉丁词
 * （技术名词 / 蛋白域名 / 细胞系 / 数据库名等）。全小写比较。
 */
const LIGAND_MENTION_JUNK = new Set([
  'alphafold', 'blast', 'uniprot', 'pdb', 'rcsb', 'pdbe', 'pubmed', 'pubchem',
  'cryo', 'cryoem', 'cryo-em', 'x-ray', 'xray', 'nmr', 'spr', 'bli', 'itc',
  'skp', 'skp1', 'scf', 'apo', 'gel', 'sec', 'sds', 'page', 'akta',
  'his', 'gst', 'gfp', 'mbp', 'bsa', 'dna', 'rna', 'cdna', 'hek', 'cho',
  'ecoli', 'coli', 'fasta', 'bsl', 'bsl-1', 'bsl-2', 'vlp', 'idt', 'map',
  // 注意：GDP/ATP 等是真实配体（在别名表），不列入黑名单
])

/** 纯拉丁配体名（字母开头，允许连字符/数字/空格词组） */
const LATIN_NAME_RE = /^[A-Za-z][A-Za-z0-9\-']{1,29}(?:\s+[A-Za-z][A-Za-z0-9\-']{0,29}){0,2}$/

/** 剥掉值末尾的中文标点/句读 */
function trimMentionTail(v: string): string {
  return v.replace(/[.,;、，。；：:）)\s]+$/, '').trim()
}

function isJunkMention(v: string, acronymOk = false): boolean {
  const key = v.toLowerCase()
  if (LIGAND_MENTION_JUNK.has(key)) return true
  // 纯大写短缩写（≤4 位）多为技术缩写而非配体名：NAD/FAD 等已在别名表精确处理；
  // 但「配体：」字段值里显式写出的 ATP/GTP 是真实配体 → acronymOk 放行
  if (!acronymOk && /^[A-Z]{1,4}$/.test(v)) return true
  // 疑似 PDB ID（4 位字母数字混合）或 UniProt accession（字母+数字长串）
  if (/^[0-9A-Za-z]{4}$/.test(v) && /\d/.test(v)) return true
  if (/^[A-Za-z]\d[\dA-Za-z]{4,}$/.test(v) || /^\d[A-Za-z][\dA-Za-z]{3,}$/.test(v)) return true
  return false
}

/**
 * 从评估表全文提取配体候选名称（规则提取，LLM 不可用时的兜底路径）：
 *  1. 字段式：「配体：/化合物：/药物名称：…」后的值（支持顿号/逗号列表；
 *     拉丁名直接收，中文名需命中别名表）
 *  2. 邻接式：「与 Resmetirom 配体结合模式」「蛋白与 XX 抑制剂复合物」——
 *     中文评估表里最常见的提名写法
 *  3. 后缀式：「XX 配体 / XX 抑制剂 / XX 底物」
 *  4. 别名表字典扫描（ATP / 伊马替尼 / 血红素……精确已知配体）
 *  候选仅是「原始名称」，后续仍经 resolveLigandInput 多策略归一（RCSB / PDBe / PubChem）。
 *  保守策略：表尾「填写范例说明」模板段不参与扫描；黑名单过滤技术名词。
 */
export function extractLigandCandidatesFromText(text: string): string[] {
  const body = cutFormTemplateTail(text)
  const found: string[] = []
  const seen = new Set<string>()

  const push = (v: string, acronymOk = false): void => {
    const name = trimMentionTail(v)
    if (!name || name.length < 3 || name.length > 60) return
    const key = name.toLowerCase()
    if (seen.has(key)) return
    if (isJunkMention(name, acronymOk)) return
    seen.add(key)
    found.push(name)
    if (found.length >= 8) return
  }

  // 1) 字段式：值可为列表（顿号/逗号/分号分隔），也可为单个名称
  const fieldRe = /(?:配体|化合物|小分子|药物|抑制剂|激动剂|拮抗剂|底物|辅因子|共晶配体)\s*(?:名称|信息|列表)?\s*[：:]\s*([^\n]{2,120})/gi
  let m: RegExpExecArray | null
  while ((m = fieldRe.exec(body))) {
    const value = m[1] ?? ''
    // 列表式：顿号分隔的多个名称；句子式取首个句读前的头段
    const items = value.includes('、') ? value.split('、') : [value.split(/[,，。；;（(]/)[0] ?? '']
    for (const item of items) {
      const v = trimMentionTail(item)
      if (!v) continue
      if (LATIN_NAME_RE.test(v)) push(v, true) // 字段值里显式写出的 ATP/GTP 等缩写是真实配体
      else if (/[\u4e00-\u9fff]/.test(v) && v.length >= 2 && v.length <= 12 && ALIAS_LOOKUP.get(normalizeLigandRaw(v))) {
        push(v) // 中文名必须命中别名表（伊马替尼/血红素……），防「见附件/同上」类噪音
      }
    }
    if (found.length >= 8) break
  }

  // 1b) 标签独占一行（表格单元格拆行，如「配体」\n「Resmetirom」）→ 下一行拉丁名
  const lines = body.split(/\r?\n/).map(l => l.trim())
  for (let i = 0; i < lines.length - 1 && found.length < 8; i++) {
    if (/^(?:配体|化合物|小分子|药物|抑制剂|底物|辅因子|配体名称|化合物名称|配体\/化合物)$/.test(lines[i])) {
      const nxt = lines[i + 1]
      if (nxt && LATIN_NAME_RE.test(nxt)) push(nxt)
    }
  }

  // 2) 邻接式：与 X 配体/化合物/抑制剂…（中文评估表最常见写法）
  const adjRe = /(?:与|和|同)\s*([A-Za-z][A-Za-z0-9\-']{1,29}(?:\s+[A-Za-z][A-Za-z0-9\-']{1,29}){0,2})\s*(?:的)?\s*(?:配体|化合物|小分子|抑制剂|激动剂|拮抗剂|底物|辅因子|变构剂|调节剂)/g
  while ((m = adjRe.exec(body)) && found.length < 8) {
    push(m[1] ?? '')
  }

  // 3) 后缀式：X 配体 / X 抑制剂（英文行文 / 「加入 ATP 底物」等）
  const sufRe = /\b([A-Za-z][A-Za-z0-9\-']{2,29})\s+(?:配体|抑制剂|激动剂|拮抗剂|底物|辅因子|ligand|inhibitor|agonist|antagonist|substrate|cofactor)\b/g
  while ((m = sufRe.exec(body)) && found.length < 8) {
    push(m[1] ?? '')
  }

  // 4) 别名表字典扫描（已知配体精确命中；长 key 保守策略防误报）
  for (const dict of extractLigandsFromText(body)) {
    if (found.length >= 8) break
    push(dict.matched.length <= 4 ? dict.matched.toUpperCase() : dict.matched)
  }

  return found.slice(0, 8)
}
