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
  for (const m of raw.slice(0, 300)) { // 上限 300 条防大靶点撑爆
    if (!m.pdb_id) continue
    const start = m.unp_start ?? 0
    const end = m.unp_end ?? 0
    if (start > 0 && end >= start) ranges.push([start, end])
    // 每个 PDB 只保留一条最优映射（best_structures 已按质量排序）
    if (!seenPdb.has(m.pdb_id.toUpperCase())) {
      seenPdb.add(m.pdb_id.toUpperCase())
      mappings.push({
        pdbId: m.pdb_id.toUpperCase(),
        chainId: m.chain_id ?? '',
        unpStart: start,
        unpEnd: end,
        resolution: typeof m.resolution === 'number' ? m.resolution : null,
        experimentalMethod: m.experimental_method ?? null,
      })
    }
    if (mappings.length >= 150) break
  }

  const coveredRanges = mergeRanges(ranges)
  const covered = coveredRanges.reduce((s, [a, b]) => s + (b - a + 1), 0)
  const coveragePercent = sequenceLength > 0
    ? Math.min(100, Math.round((covered / sequenceLength) * 1000) / 10)
    : 0

  return { coveragePercent, mappings, coveredRanges }
}

/** 覆盖区间的文字描述（供 LLM prompt 使用） */
export function describeCoverage(ranges: Array<[number, number]>, seqLen: number): string {
  if (ranges.length === 0) return '无覆盖'
  const parts = ranges.slice(0, 12).map(([a, b]) => `${a}-${b} (${b - a + 1} aa)`)
  const rest = ranges.length > 12 ? ` …等 ${ranges.length} 段` : ''
  return `${parts.join(', ')}${rest}`
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
