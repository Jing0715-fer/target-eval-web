/**
 * 轻量序列比对 — 判断「提供的序列」与「UniProt 全长序列」是否同一靶点，
 * 并估计构建边界（截短区间）。内存最优设计：
 *  - 精确子串 → indexOf（V8 高效）
 *  - 锚定比对 → 首尾锚点定位 + 位置对齐逐位比较（无 DP 矩阵）
 *  - 兜底 → 8-mer Jaccard 集合相似度（集合 ≤ 数千条目）
 * 不引入外部依赖，5000+ aa 序列毫秒级完成。
 */
import type { SequenceComparison } from './types'

const ANCHOR_CANDIDATES = [24, 18, 14, 12]
const KMER_LEN = 8

function kmerSet(seq: string, k: number): Set<string> {
  const set = new Set<string>()
  for (let i = 0; i + k <= seq.length; i++) set.add(seq.slice(i, i + k))
  return set
}

/** 在 full 中查找锚（返回 1-based 起始位与实际锚长；未命中返回 null） */
function findAnchor(full: string, anchor: (len: number) => string): { pos: number; len: number } | null {
  for (const len of ANCHOR_CANDIDATES) {
    const sub = anchor(len)
    if (sub.length < len) continue
    const idx = full.indexOf(sub)
    if (idx >= 0) return { pos: idx + 1, len }
  }
  return null
}

export function compareSequences(provided: string, full: string): SequenceComparison {
  const providedLength = provided.length
  const fullLength = full.length

  // 1) 精确子串（最常见：构建序列完全取自全长）
  const subIdx = providedLength >= 8 ? full.indexOf(provided) : -1
  if (subIdx >= 0) {
    return {
      identity: 100, sameTarget: true, providedLength, fullLength,
      start: subIdx + 1, end: subIdx + providedLength, method: 'exact-substring',
    }
  }

  // 2) 锚定比对：首/尾锚点定位后逐位比较（不做 indel 对齐的轻量近似）
  if (providedLength >= ANCHOR_CANDIDATES[0] * 2 && fullLength >= ANCHOR_CANDIDATES[0]) {
    const head = findAnchor(full, len => provided.slice(0, len))
    const tail = findAnchor(full, len => provided.slice(providedLength - len))

    if (head || tail) {
      let estStart: number
      let estEnd: number
      if (head && tail) {
        // 双锚点：首锚定起点、尾锚定终点（容忍少量 indel）
        estStart = head.pos
        estEnd = tail.pos + tail.len - 1
      } else if (head) {
        estStart = head.pos
        estEnd = Math.min(fullLength, head.pos - 1 + providedLength)
      } else if (tail) {
        estEnd = tail.pos + tail.len - 1
        estStart = Math.max(1, estEnd - providedLength + 1)
      } else {
        estStart = 1
        estEnd = fullLength
      }
      // 区间合理性：长度应接近提供序列（70%-130%），且不越界
      const spanLen = estEnd - estStart + 1
      if (estEnd <= fullLength && estStart >= 1 && spanLen >= Math.floor(providedLength * 0.7) && spanLen <= Math.ceil(providedLength * 1.3)) {
        let matches = 0
        let compared = 0
        for (let i = 0; i < providedLength; i++) {
          const fi = estStart - 1 + i
          if (fi >= fullLength) break
          compared++
          if (provided[i] === full[fi]) matches++
        }
        const identity = compared > 0 ? Math.round((matches / compared) * 100) : 0
        return {
          identity, sameTarget: identity >= 85, providedLength, fullLength,
          start: estStart, end: estEnd, method: 'anchored',
        }
      }
    }
  }

  // 3) k-mer Jaccard 兜底
  const a = kmerSet(provided, KMER_LEN)
  const b = kmerSet(full, KMER_LEN)
  let inter = 0
  for (const k of a) if (b.has(k)) inter++
  const union = a.size + b.size - inter
  const sim = union > 0 ? inter / union : 0
  // Jaccard 对点突变敏感度低于逐位 identity，阈值放宽
  const identity = Math.round(sim * 100)
  return {
    identity, sameTarget: sim >= 0.8, providedLength, fullLength,
    start: null, end: null, method: 'kmer',
  }
}

/** 构建信息可读描述（日志/报告用） */
export function describeComparison(c: SequenceComparison): string {
  const pct = Math.round((c.providedLength / c.fullLength) * 100)
  if (c.method === 'exact-substring') {
    return `完全匹配全长 ${c.start}-${c.end} 位（构建长度占全长 ${pct}%）`
  }
  if (c.start != null && c.end != null) {
    const spanPct = Math.round(((c.end - c.start + 1) / c.fullLength) * 100)
    return `一致性 ${c.identity}%，估计对应全长 ${c.start}-${c.end} 位（占全长 ${spanPct}%）`
  }
  return `k-mer 相似度 ${c.identity}%${c.sameTarget ? '（判定为同一靶点）' : '（可能为不同靶点或同源蛋白）'}`
}
