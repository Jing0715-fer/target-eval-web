/**
 * PubChem PUG REST + RCSB 化学检索（仅服务端，v2.2 配体归一第 4 策略）：
 *  - pubchemLookupName:   名称 → CID + 分子式 / MW / IUPAC 名 / SMILES（PUG REST，含同义词与品牌药名）
 *  - rcsbChemicalCandidates: SMILES → PDB 化学组分候选
 *      · 'exact'   graph-exact（原子/键/立体全等，score 1.0）
 *      · 'similar' fingerprint-similarity（TREE+MACCS，0-1）
 *    实体 ID（如 1IEP_3）经 RCSB nonpolymer_entity API 反查 nonpolymer_comp_id。
 *
 * 通道实测（2026-11）：
 *  - PUG REST name：Resmetirom → CID 15981237 · C17H12Cl2N6O4 · 435.2
 *  - RCSB chemical：imatinib ConnectivitySMILES + graph-exact → 29 实体 1.0 分（STI）
 *  - Resmetirom + fingerprint-similarity → A1H2J 0.946（类似物 ALG-055009，分子式不同 → 由上层硬校验拒绝）
 *  - 注意：SMILES 必须用 PubChem 直出的 ConnectivitySMILES，手写/芳香式变体可能检索不到。
 */
import { apiCache } from './cache'

const PUG_BASE = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug'
const RCSB_SEARCH = 'https://search.rcsb.org/rcsbsearch/v2/query'

export interface PubChemCompound {
  cid: number
  /** PubChem 首选名（如 Resmetirom；无 Title 时回退输入名） */
  title: string
  formula: string
  weight: number | null
  iupacName?: string
  /** 非立体异构 SMILES（用于 RCSB 化学检索） */
  smiles?: string
}

/** PubChem 名称检索（含同义词 / 品牌药名），未命中或网络失败返回 null。
 *  v2.5：仅确定性「无此名称」（404）或成功结果入缓存；网络/超时/5xx 不入缓存 ——
 *  原实现把瞬时失败缓存为永久 null，后续同批次同名解析长期命中坏缓存。 */
export async function pubchemLookupName(name: string, signal?: AbortSignal): Promise<PubChemCompound | null> {
  const q = name.trim().slice(0, 160)
  if (!q) return null
  const key = `pubchem:name:${q.toLowerCase()}`
  const hit = apiCache.get<PubChemCompound | null>(key)
  if (hit !== undefined) return hit
  let out: PubChemCompound | null = null
  let definitive = false // true = 结果可入缓存（成功或 HTTP 404 确认无此名称）
  try {
    const res = await fetch(
      `${PUG_BASE}/compound/name/${encodeURIComponent(q)}/property/MolecularFormula,MolecularWeight,IUPACName,ConnectivitySMILES,Title/JSON`,
      { headers: { Accept: 'application/json' }, signal: signal ?? AbortSignal.timeout(15_000) },
    )
    if (res.status === 404) definitive = true // PubChem 确认无此名称（确定性失败，可缓存）
    if (res.ok) {
      definitive = true
      const j = (await res.json()) as {
        PropertyTable?: { Properties?: Array<Record<string, unknown>> }
      }
      const p = j.PropertyTable?.Properties?.[0]
      const cid = Number(p?.CID)
      const formula = typeof p?.MolecularFormula === 'string' ? p.MolecularFormula.trim() : ''
      const weight = parseFloat(String(p?.MolecularWeight ?? ''))
      if (Number.isFinite(cid) && cid > 0 && formula) {
        out = {
          cid,
          title: typeof p?.Title === 'string' && p.Title.trim() ? p.Title.trim().slice(0, 60) : q,
          formula: formula.slice(0, 60),
          weight: Number.isFinite(weight) ? Math.round(weight * 10) / 10 : null,
          iupacName: typeof p?.IUPACName === 'string' && p.IUPACName.trim() ? p.IUPACName.trim().slice(0, 160) : undefined,
          smiles: typeof p?.ConnectivitySMILES === 'string' && p.ConnectivitySMILES.trim() ? p.ConnectivitySMILES.trim().slice(0, 400) : undefined,
        }
      }
    }
  } catch {
    out = null
  }
  if (definitive) apiCache.set(key, out) // 网络/超时/5xx 不入缓存，下次重试
  return out
}

// ─── v2.7 配体详情（性质 + 2D 结构式）─────────────────────────────────────────

/** PubChem 计算性质（报告配体卡扩展信息） */
export interface PubChemDetail {
  cid: number
  title: string
  formula: string
  weight: number | null
  iupacName?: string
  /** 计算性质（无值字段缺省 — PUG REST 未提供时省略） */
  xlogp?: number
  tpsa?: number
  hBondDonor?: number
  hBondAcceptor?: number
  rotatableBonds?: number
  heavyAtoms?: number
  exactMass?: number
  charge?: number
  inchiKey?: string
  canonicalSmiles?: string
}

const PC_PROPS = 'MolecularFormula,MolecularWeight,IUPACName,Title,XLogP,TPSA,HBondDonorCount,HBondAcceptorCount,RotatableBondCount,HeavyAtomCount,ExactMass,Charge,InChIKey,ConnectivitySMILES'

function parseDetail(p: Record<string, unknown> | undefined, fallbackTitle: string): PubChemDetail | null {
  if (!p) return null
  const cid = Number(p.CID)
  const formula = typeof p.MolecularFormula === 'string' ? p.MolecularFormula.trim() : ''
  if (!Number.isFinite(cid) || cid <= 0 || !formula) return null
  const num = (v: unknown): number | undefined => {
    const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : undefined
  }
  return {
    cid,
    title: typeof p.Title === 'string' && p.Title.trim() ? p.Title.trim().slice(0, 60) : fallbackTitle,
    formula: formula.slice(0, 60),
    weight: num(p.MolecularWeight) ?? null,
    iupacName: typeof p.IUPACName === 'string' && p.IUPACName.trim() ? p.IUPACName.trim().slice(0, 200) : undefined,
    xlogp: num(p.XLogP),
    tpsa: num(p.TPSA),
    hBondDonor: num(p.HBondDonorCount),
    hBondAcceptor: num(p.HBondAcceptorCount),
    rotatableBonds: num(p.RotatableBondCount),
    heavyAtoms: num(p.HeavyAtomCount),
    exactMass: num(p.ExactMass),
    charge: num(p.Charge),
    inchiKey: typeof p.InChIKey === 'string' && p.InChIKey.trim() ? p.InChIKey.trim().slice(0, 40) : undefined,
    canonicalSmiles: typeof p.ConnectivitySMILES === 'string' && p.ConnectivitySMILES.trim() ? p.ConnectivitySMILES.trim().slice(0, 400) : undefined,
  }
}

/** PubChem 计算性质（CID 或 InChIKey 输入命名空间共用；404/200 入缓存） */
async function fetchPubChemDetail(
  namespace: 'cid' | 'inchikey',
  term: string | number,
  signal?: AbortSignal,
): Promise<PubChemDetail | null> {
  const key = `pubchem:detail:${namespace}:${String(term).toLowerCase()}`
  const hit = apiCache.get<PubChemDetail | null>(key)
  if (hit !== undefined) return hit
  let out: PubChemDetail | null = null
  let definitive = false
  try {
    const res = await fetch(
      `${PUG_BASE}/compound/${namespace}/${encodeURIComponent(String(term))}/property/${PC_PROPS}/JSON`,
      { headers: { Accept: 'application/json' }, signal: signal ?? AbortSignal.timeout(12_000) },
    )
    if (res.status === 404) definitive = true
    if (res.ok) {
      definitive = true
      const j = (await res.json()) as { PropertyTable?: { Properties?: Array<Record<string, unknown>> } }
      out = parseDetail(j.PropertyTable?.Properties?.[0], String(term))
    }
  } catch {
    out = null
  }
  if (definitive) apiCache.set(key, out)
  return out
}

/** PubChem 计算性质（按 CID） */
export function pubchemDetailByCid(cid: number, signal?: AbortSignal): Promise<PubChemDetail | null> {
  return fetchPubChemDetail('cid', cid, signal)
}

/** PubChem 计算性质（按 InChIKey — RCSB 组分 → PubChem 匹配通道） */
export function pubchemDetailByInchiKey(inchiKey: string, signal?: AbortSignal): Promise<PubChemDetail | null> {
  return fetchPubChemDetail('inchikey', inchiKey.trim(), signal)
}

/**
 * PubChem 2D 结构式（CID → PNG → data URI；报告内嵌用）。
 * 磁盘缓存 db/cache/ligand2d/{cid}_{px}.png（化学结构不变 — 永久缓存；
 * 文件名带尺寸 — v2.7.5 点击放大将取图升到 600px，旧 300px 缓存不会被误用）。
 */
/** 取图像素（v2.7.5：300→600 — 报告缩略图 150px 外，点击放大需 2× 原生清晰度；PubChem 上限 1000px） */
const LIG2D_PX = 600
export async function pubchem2dStructure(
  cid: number,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (!Number.isFinite(cid) || cid <= 0) return undefined
  const cacheDir = `${process.cwd()}/db/cache/ligand2d`
  const file = `${cacheDir}/${cid}_${LIG2D_PX}.png`
  try {
    const cached = await import('node:fs/promises').then(fs => fs.readFile(file))
    if (cached.length > 300) return `data:image/png;base64,${cached.toString('base64')}`
  } catch { /* 未缓存 */ }
  try {
    const res = await fetch(
      `${PUG_BASE}/compound/cid/${cid}/PNG?image_size=${LIG2D_PX}x${LIG2D_PX}&record_type=2d`,
      { signal: signal ?? AbortSignal.timeout(15_000) },
    )
    if (!res.ok) return undefined
    const png = Buffer.from(await res.arrayBuffer())
    if (png.length < 300 || !png.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return undefined
    try {
      await import('node:fs/promises').then(fs => fs.mkdir(cacheDir, { recursive: true }).then(() => fs.writeFile(file, png)))
    } catch { /* 缓存失败不影响返回 */ }
    return `data:image/png;base64,${png.toString('base64')}`
  } catch {
    return undefined
  }
}

// ─── RCSB 化学检索（SMILES → 组分候选）───────────────────────────────────────

export interface ChemCandidate {
  compId: string
  /** 1.0 = graph-exact 全等；<1 = fingerprint 相似度 */
  score: number
}

interface RcsbSearchResponse {
  result_set?: Array<{ identifier?: string; score?: number }>
}

/** 实体 ID → 三位（或新式 4-5 位）化学组分 ID。
 *  v2.5：404（实体无配体）或成功入缓存；网络/超时不入缓存。 */
async function fetchEntityCompId(entry: string, entity: string, signal?: AbortSignal): Promise<string | null> {
  const key = `rcsb:npent:${entry}_${entity}`
  const hit = apiCache.get<string | null>(key)
  if (hit !== undefined) return hit
  let out: string | null = null
  let definitive = false
  try {
    const res = await fetch(`https://data.rcsb.org/rest/v1/core/nonpolymer_entity/${entry}/${entity}`, {
      headers: { Accept: 'application/json' },
      signal: signal ?? AbortSignal.timeout(12_000),
    })
    if (res.status === 404) definitive = true
    if (res.ok) {
      definitive = true
      const j = (await res.json()) as {
        rcsb_nonpolymer_entity_container_identifiers?: { nonpolymer_comp_id?: string }
      }
      const id = j.rcsb_nonpolymer_entity_container_identifiers?.nonpolymer_comp_id
      if (id && /^[A-Za-z0-9]{1,6}$/.test(id)) out = id.toUpperCase()
    }
  } catch {
    out = null
  }
  if (definitive) apiCache.set(key, out)
  return out
}

/**
 * SMILES → PDB 化学组分候选。
 * 'exact'   取前几个命中实体（score 1.0）反查组分 ID；
 * 'similar' fingerprint 相似，取前 12 实体反查组分 ID（保留各自最高相似度）。
 * 204（无命中）或任何失败 → 空数组（调用方继续后续策略）。
 * v2.5：仅确定性结果（200/204）入缓存，网络/超时失败不入缓存。
 */
export async function rcsbChemicalCandidates(
  smiles: string,
  mode: 'exact' | 'similar',
  signal?: AbortSignal,
): Promise<ChemCandidate[]> {
  const s = smiles.trim()
  if (!s) return []
  const key = `rcsb:chem:${mode}:${s}`
  const hit = apiCache.get<ChemCandidate[]>(key)
  if (hit !== undefined) return hit
  const out: ChemCandidate[] = []
  let definitive = false
  try {
    const res = await fetch(RCSB_SEARCH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        query: {
          type: 'terminal',
          service: 'chemical',
          parameters: {
            type: 'descriptor',
            value: s,
            descriptor_type: 'SMILES',
            match_type: mode === 'exact' ? 'graph-exact' : 'fingerprint-similarity',
          },
        },
        return_type: 'non_polymer_entity',
        request_options: { paginate: { start: 0, rows: mode === 'exact' ? 24 : 12 } },
      }),
      signal: signal ?? AbortSignal.timeout(25_000),
    })
    if (res.status === 204) definitive = true // RCSB 确认无匹配（可缓存）
    if (res.status !== 204 && res.ok) {
      definitive = true
      const j = (await res.json()) as RcsbSearchResponse
      const parsed: Array<{ entry: string; entity: string; score: number }> = []
      for (const r of j.result_set ?? []) {
        const m = (r.identifier ?? '').match(/^([0-9A-Z]{4})_(\d+)$/)
        if (m && typeof r.score === 'number') parsed.push({ entry: m[1], entity: m[2], score: r.score })
      }
      // 反查前 4 个不同实体的组分 ID（同一分子往往全部指向同一 comp id）
      const best = new Map<string, number>()
      for (const p of parsed.slice(0, 4)) {
        const compId = await fetchEntityCompId(p.entry, p.entity, signal)
        if (compId) best.set(compId, Math.max(best.get(compId) ?? 0, p.score))
      }
      for (const [compId, score] of best) out.push({ compId, score })
    }
  } catch {
    /* 失败 → 空 */
  }
  if (definitive) apiCache.set(key, out)
  return out
}
