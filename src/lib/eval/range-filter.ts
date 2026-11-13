/**
 * 范围过滤辅助（v1.23）— 用户指定 UniProt 残基编号区间 [start, end] 后，
 * 过滤 PDB/BLAST 命中为与该区间重叠的结构。
 *
 * 语义：仅当命中明确的范围信息与用户区间有重叠时保留；范围信息缺失的命中
 * 默认保留（不静默丢弃用户可能需要的结构）。
 */
import type { BlastHit, PdbEntry } from './types'

/** [start, end] 1-based 闭区间 */
export type ResidueRange = [number, number]

/** 解析 chainRanges 字符串（如 "A=695-1022"、"A/B=25-646"、"A=1-100,B=200-300"）为数值区间列表 */
export function parseChainRanges(r: string | undefined): Array<[number, number]> {
  if (!r) return []
  const out: Array<[number, number]> = []
  for (const part of r.split(',')) {
    const m = part.match(/=(\d+)-(\d+)/)
    if (m) {
      const s = Number(m[1]), e = Number(m[2])
      if (s > 0 && e >= s) out.push([s, e])
    }
  }
  return out
}

/** 两区间是否重叠（闭区间） */
function overlaps(a: [number, number], b: ResidueRange): boolean {
  return a[0] <= b[1] && a[1] >= b[0]
}

/** PDB 命中是否与用户区间重叠；chainRanges 缺失时默认保留（true） */
export function pdbInRange(p: PdbEntry, range: ResidueRange): boolean {
  const iv = parseChainRanges(p.chainRanges)
  if (iv.length === 0) return true // 范围未知 → 保留
  return iv.some(x => overlaps(x, range))
}

/** BLAST 命中是否与用户区间重叠；queryFrom/To 缺失时默认保留（true） */
export function blastInRange(h: BlastHit, range: ResidueRange): boolean {
  if (h.queryFrom == null || h.queryTo == null) return true
  if (h.queryFrom <= 0 || h.queryTo <= 0) return true
  return overlaps([h.queryFrom, h.queryTo], range)
}

/** 过滤 PDB 列表（range 未提供时原样返回） */
export function filterPdbsByRange(pdbs: PdbEntry[], range: ResidueRange | undefined): PdbEntry[] {
  if (!range) return pdbs
  return pdbs.filter(p => pdbInRange(p, range))
}

/** 过滤 BLAST 命中列表（range 未提供时原样返回） */
export function filterBlastByRange(hits: BlastHit[], range: ResidueRange | undefined): BlastHit[] {
  if (!range) return hits
  return hits.filter(h => blastInRange(h, range))
}

/** 格式化范围为展示字符串 "695-1022" 或 undefined */
export function formatRange(range: ResidueRange | undefined): string | undefined {
  if (!range) return undefined
  return `${range[0]}-${range[1]}`
}
