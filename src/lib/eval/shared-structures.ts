/**
 * 共有结构计算 — 纯函数，前后端共用。
 *
 * 数据来源：各靶点的 directPdbs（RCSB 按 UniProt accession exact_match 检索得到的 PDB
 * 列表）。一个 PDB 条目同时出现在多个靶点的 directPdbs 中，意味着该 PDB 的 polymer
 * entity 引用了多个输入 UniProt —— 即复合物/共结晶/融合构建等"共有结构"。
 *
 * 交集计算无需额外网络请求；按覆盖靶点数降序、分辨率升序排列。
 */
import type { PdbEntry, SharedStructure, SharedStructureCoverage } from './types'

/** computeSharedStructures 接受的靶点最小形状 */
export interface SharedStructureTarget {
  uniprotId?: string
  proteinName: string
  directPdbs: PdbEntry[]
}

/**
 * 计算多靶点共有的 PDB 结构。
 * @param targets 各靶点（需有 uniprotId 与 directPdbs；无 uniprotId 的靶点不参与）
 * @returns 共有结构列表（覆盖 ≥2 个靶点），按覆盖靶点数降序、分辨率升序排列
 */
export function computeSharedStructures<T extends SharedStructureTarget>(targets: T[]): SharedStructure[] {
  if (targets.length < 2) return []

  // pdbId → (targetIndex → PdbEntry)，只收录有 uniprotId 的靶点
  const pdbIndex = new Map<string, Map<number, PdbEntry>>()
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]
    if (!t.uniprotId) continue
    for (const p of t.directPdbs) {
      let m = pdbIndex.get(p.pdbId)
      if (!m) {
        m = new Map()
        pdbIndex.set(p.pdbId, m)
      }
      m.set(i, p)
    }
  }

  const shared: SharedStructure[] = []
  for (const [pdbId, entries] of pdbIndex) {
    if (entries.size < 2) continue // 仅保留覆盖 ≥2 个靶点的 PDB
    const baseEntry = entries.values().next().value!
    const coverage: SharedStructureCoverage[] = []
    for (const [idx, entry] of entries) {
      const t = targets[idx]
      coverage.push({
        uniprotId: t.uniprotId!,
        proteinName: t.proteinName,
        chainRanges: entry.chainRanges,
      })
    }
    shared.push({
      pdbId,
      method: baseEntry.method,
      resolution: baseEntry.resolution,
      title: baseEntry.title,
      releaseDate: baseEntry.releaseDate,
      ligands: baseEntry.ligands,
      journal: baseEntry.journal,
      pubmedId: baseEntry.pubmedId,
      isXray: baseEntry.isXray,
      isCryoem: baseEntry.isCryoem,
      isNmr: baseEntry.isNmr,
      coverage,
      targetCount: coverage.length,
    })
  }

  shared.sort((a, b) => {
    if (b.targetCount !== a.targetCount) return b.targetCount - a.targetCount
    if (a.resolution == null && b.resolution == null) return a.pdbId.localeCompare(b.pdbId)
    if (a.resolution == null) return 1
    if (b.resolution == null) return -1
    return a.resolution - b.resolution
  })
  return shared
}
