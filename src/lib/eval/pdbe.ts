/**
 * PDBe (EBI) 数据访问：
 *  - best_structures: UniProt → PDB 链映射（含分辨率/方法/覆盖区间），用于覆盖率计算
 *  - entry summary 兜底（RCSB 详情缺失时的轻量补充，当前主要用映射数据）
 * 内存策略：单次 JSON、立即归约为 PdbeMapping[]。
 */
import { cachedJsonFetch } from './cache'
import type { PdbeCoverageResult, PdbeMapping } from './types'

interface BestStructuresRaw {
  pdb_id?: string
  chain_id?: string
  unp_start?: number
  unp_end?: number
  resolution?: number | null
  experimental_method?: string
}
/** 覆盖区间合并 */
function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  if (ranges.length === 0) return []
  ranges.sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = [ranges[0]]
  for (let i = 1; i < ranges.length; i++) {
    const last = merged[merged.length - 1]
    if (ranges[i][0] <= last[1] + 1) last[1] = Math.max(last[1], ranges[i][1])
    else merged.push(ranges[i])
  }
  return merged
}

/**
 * PDBe best_structures — 返回覆盖率 + 映射明细。
 * 覆盖率 = 并集区间长度 / 序列长度（去重不同链对同一区域的重复覆盖）。
 * 注意：API 返回 { [accession]: [...] } 包装对象。
 * v2.28：新增 chainRangesByPdb（每 PDB 全部链的 SIFTS 范围字符串，如
 * "A=695-1024,B=25-646"）— 结构范围过滤回填用（UniProt 交叉引用 Chains
 * 缺失的条目由此补齐）；raw 上限 300 → 600（大靶点结构论文献覆盖更全）。
 */
export async function fetchPdbeCoverage(
  uniprotId: string,
  sequenceLength: number,
): Promise<PdbeCoverageResult> {
  const wrapped = await cachedJsonFetch<Record<string, BestStructuresRaw[]>>(
    `https://www.ebi.ac.uk/pdbe/api/mappings/best_structures/${encodeURIComponent(uniprotId)}`,
    { timeoutMs: 20_000 },
  )
  const raw = Array.isArray(wrapped)
    ? wrapped
    : (wrapped?.[uniprotId] ?? (wrapped ? Object.values(wrapped)[0] as BestStructuresRaw[] | undefined : undefined))
  if (!Array.isArray(raw) || raw.length === 0) {
    return { coveragePercent: 0, mappings: [], coveredRanges: [] }
  }

  const mappings: PdbeMapping[] = []
  const ranges: Array<[number, number]> = []
  const seenPdb = new Set<string>()
  // v2.28：每 PDB 全部链的 SIFTS 范围字符串（结构范围过滤回填 — 管线在 PDBe
  // 阶段用它把 UniProt xref Chains 缺失的直接结构补上链范围后再复滤）。
  // v2.28a 修订：回填遍历全量 raw（不去重行数 cap 处 break — EGFR 实测 best_structures
  // 行序与展示序不同，第 150 个不同 PDB 之后的新结构（行 275-509）曾被 break 跳过
  // → 回填漏检）；mappings 列表本身仍 cap 150（仅跳过 push，不 break）。
  const chainRangesByPdb = new Map<string, string[]>()
  for (const m of raw.slice(0, 600)) { // 上限 600 行防大靶点撑爆（v2.28：300 → 600）
    if (!m.pdb_id) continue
    const start = m.unp_start ?? 0
    const end = m.unp_end ?? 0
    if (start > 0 && end >= start) {
      ranges.push([start, end])
      const key = m.pdb_id.toUpperCase()
      if (m.chain_id) {
        const arr = chainRangesByPdb.get(key)
        const seg = `${m.chain_id}=${start}-${end}`
        if (arr) { if (!arr.includes(seg)) arr.push(seg) } else chainRangesByPdb.set(key, [seg])
      }
      // 每个 PDB 只保留一条最优映射（best_structures 已按质量排序；cap 150 — 跳过不 break）
      if (!seenPdb.has(key) && mappings.length < 150) {
        seenPdb.add(key)
        mappings.push({
          pdbId: key,
          chainId: m.chain_id ?? '',
          unpStart: start,
          unpEnd: end,
          resolution: typeof m.resolution === 'number' ? m.resolution : null,
          experimentalMethod: m.experimental_method ?? null,
        })
      }
    }
  }

  const coveredRanges = mergeRanges(ranges)
  const covered = coveredRanges.reduce((s, [a, b]) => s + (b - a + 1), 0)
  const coveragePercent = sequenceLength > 0
    ? Math.min(100, Math.round((covered / sequenceLength) * 1000) / 10)
    : 0

  return { coveragePercent, mappings, coveredRanges, chainRangesByPdb: Object.fromEntries([...chainRangesByPdb].map(([k, v]) => [k, v.join(',')])) }
}

/** 覆盖区间的文字描述（供 LLM prompt 使用） */
export function describeCoverage(ranges: Array<[number, number]>, seqLen: number): string {
  if (ranges.length === 0) return '无覆盖'
  const parts = ranges.slice(0, 12).map(([a, b]) => `${a}-${b} (${b - a + 1} aa)`)
  const rest = ranges.length > 12 ? ` …等 ${ranges.length} 段` : ''
  return `${parts.join(', ')}${rest}`
}

/**
 * v2.27：把覆盖率限定到评估区间（截短构建/聚蛋白片段口径）。
 * 覆盖率 = 区间内并集长度 / 区间长度；coveredRanges 裁剪为与区间相交的段
 * （仍为 UniProt 绝对编号 — 与 PDB 链范围同口径）。mappings 原样保留。
 */
export function restrictCoverageToRange(coverage: PdbeCoverageResult, range: [number, number]): PdbeCoverageResult {
  const clipped: Array<[number, number]> = []
  for (const [a, b] of coverage.coveredRanges) {
    const s = Math.max(a, range[0])
    const e = Math.min(b, range[1])
    if (e >= s) clipped.push([s, e])
  }
  const span = range[1] - range[0] + 1
  const covered = clipped.reduce((s, [a, b]) => s + (b - a + 1), 0)
  const coveragePercent = span > 0 ? Math.min(100, Math.round((covered / span) * 1000) / 10) : 0
  return { ...coverage, coveragePercent, coveredRanges: mergeRanges(clipped) }
}

/** v2.27：评估区间内的未覆盖段（uncoveredRanges 的区间限定版 — gap 坐标为 UniProt 绝对编号） */
export function uncoveredRangesWithin(ranges: Array<[number, number]>, range: [number, number]): Array<[number, number]> {
  const merged = mergeRanges(ranges.filter(r => r[1] > r[0]))
  const gaps: Array<[number, number]> = []
  let cursor = range[0]
  for (const [a, b] of merged) {
    if (a > cursor) gaps.push([cursor, Math.min(a - 1, range[1])])
    cursor = Math.max(cursor, b + 1)
    if (cursor > range[1]) break
  }
  if (cursor <= range[1]) gaps.push([cursor, range[1]])
  // 过滤掉 <20aa 的琐碎空隙（与 uncoveredRanges 同口径）
  return gaps.filter(([a, b]) => b - a + 1 >= 20)
}

/** 找出未覆盖区间（研究空白分析用） */
export function uncoveredRanges(ranges: Array<[number, number]>, seqLen: number): Array<[number, number]> {
  const merged = mergeRanges(ranges.filter(r => r[1] > r[0]))
  const gaps: Array<[number, number]> = []
  let cursor = 1
  for (const [a, b] of merged) {
    if (a > cursor) gaps.push([cursor, Math.min(a - 1, seqLen)])
    cursor = Math.max(cursor, b + 1)
  }
  if (cursor <= seqLen) gaps.push([cursor, seqLen])
  // 过滤掉 <20aa 的琐碎空隙
  return gaps.filter(([a, b]) => b - a + 1 >= 20)
}
