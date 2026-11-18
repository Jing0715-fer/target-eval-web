/**
 * 轻量序列比对 — 判断「提供的序列」与「UniProt 全长序列」是否同一靶点，
 * 并估计构建边界（截短区间）。内存最优设计：
 *  - 精确子串 → indexOf（V8 高效）
 *  - 锚定比对 → 首尾锚点定位 + 位置对齐逐位比较（无 DP 矩阵）
 *  - 种子链比对（v2.30）→ 内部 8-mer 种子 + 对角线投票 + 容错双向延展
 *    （用户诉求：BLAST 定位 UniProt 后按提交序列确定条目内范围；首尾突变/
 *     标签头/种间同源时锚定法失效，内部保守片段仍可定位区间）
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

  // 2) 种子链比对（v2.30）：内部 k-mer 种子定位 + 容错延展边界。
  //    置于锚定之前：标签头场景锚定法起点偏移一个标签长（单锚 + 长度回推），
  //    内部 indel 场景锚定法逐位错配坍缩至 identity<85 — 种子链对两者均精确。
  //    无法定位（大型插入/覆盖率 <60%）时回落锚定法（末端完好仍可用）。
  const chained = seedChainAlign(provided, full)
  if (chained) return chained

  // 3) 锚定比对：首/尾锚点定位后逐位比较（不做 indel 对齐的轻量近似）
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

  // 4) k-mer Jaccard 兜底
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

// ─── v2.30 种子链比对 ────────────────────────────────────────────────────────

/** 种子长度（8-mer — 与 Jaccard 兜底同规格：点突变密度 15% 时平均每 ~9 aa 仍有一个完好种子） */
const SEED_K = 8
/** 每个种子在 full 侧最多登记的位置数（重复区保护 — 防对角线票被低复杂度重复刷爆） */
const MAX_POS_PER_KMER = 24
/** provided 侧种子采样上限（超长序列抽样投票 — 对角线投票与延展精度不受影响） */
const MAX_PROVIDED_SEEDS = 3000
/** 对角线合并带宽（±4 — 少量 indel 后种子落在邻近对角线，仍计入同一票仓） */
const DIAG_BAND = 4
/** 种子收集上限（防御性 — 重复区极端爆炸时的内存/票数闸门） */
const MAX_SEEDS = 8000
/** 延展停止游程（连续无匹配位数 — 越出同源区/进入标签头的停止信号） */
const WALK_STOP_RUN = 10
/** 缺口修复尝试宽度（错配游程 ≥3 时尝试单侧跳 1-3 位寻找重新对齐） */
const GAP_REPAIR_MAX = 3
/** 缺口修复确认长度（跳位后需连续匹配的位数 — 防随机单点匹配把延展引进无关区） */
const REPAIR_CONFIRM = 3
/** 滑窗密度停止（最近 16 个消费位中匹配 <40% → 已离开同源区，停止） */
const DENSITY_WINDOW = 16
const DENSITY_MIN = 0.4
/** 提供序列覆盖率下限（比对区段应覆盖大部分提交序列 — 标签头/尾巴之外的主体） */
const MIN_PROVIDED_COVERAGE = 0.6

/** 容错延展结果（i/j = 消费到的最远「已确认」位置，0-based；边界即最后一处匹配位） */
interface WalkResult {
  i: number
  j: number
  matches: number
  mismatches: number
  indels: number
}

/**
 * 从 (i0, j0) 沿 dir 方向容错延展（X-drop 简化版）：
 *  - 匹配 → 确认边界推进
 *  - 错配 → 游程计数（未确认 — 结束时回滚到最后一处匹配，不计入 identity）
 *  - 错配游程 ≥3 → 尝试单侧跳 1-3 位修复（indel 容忍），跳位后须连续 REPAIR_CONFIRM
 *    位匹配方确认修复（防随机单点匹配把延展漂移进标签/无关区）
 *  - 连续 WALK_STOP_RUN 位无匹配 / 滑窗匹配密度 <40% → 停止（越出同源区）
 */
function walkOutward(provided: string, full: string, i0: number, j0: number, dir: 1 | -1): WalkResult {
  const P = provided.length
  const F = full.length
  let i = i0
  let j = j0
  let matches = 0
  let mismatches = 0
  let indels = 0
  /** 自上次匹配以来消费的错配/缺口位（未确认 — 下次匹配时一并确认） */
  let pending = 0
  /** 连续无匹配游程（错配+未成修复的缺口；匹配或修复成功即清零） */
  let run = 0
  /** 连续匹配游程（含当前位）— ≥2 才确认边界（孤立的随机匹配不推进边界） */
  let streak = 0
  /** 滑窗密度（最近 DENSITY_WINDOW 个消费位的匹配数/总数 — 防随机匹配漂移） */
  let winMatch = 0
  let winTotal = 0
  const win: number[] = []
  /** 最后确认（匹配）到的位置 — 停止时回滚到此 */
  let goodI = i0 - dir
  let goodJ = j0 - dir
  const inBounds = () => (dir > 0 ? i < P && j < F : i >= 0 && j >= 0)
  /** 滑窗推进（1=匹配 0=未匹配）；密度过低 → true 表示应停止 */
  const pushWin = (m: boolean): boolean => {
    win.push(m ? 1 : 0)
    winMatch += m ? 1 : 0
    winTotal++
    if (win.length > DENSITY_WINDOW) {
      winMatch -= win.shift() ?? 0
      winTotal--
    }
    return winTotal >= DENSITY_WINDOW && winMatch / winTotal < DENSITY_MIN
  }
  /** 跳 g 位后是否连续 REPAIR_CONFIRM 位匹配（修复确认 — 走向正确才接受跳位） */
  const confirmShift = (si: number, sj: number): boolean => {
    for (let o = 0; o < REPAIR_CONFIRM; o++) {
      const ci = si + dir * o
      const cj = sj + dir * o
      if ((dir > 0 ? ci >= P || cj >= F : ci < 0 || cj < 0)) return false
      if (provided[ci] !== full[cj]) return false
    }
    return true
  }

  while (inBounds()) {
    if (provided[i] === full[j]) {
      matches++
      mismatches += pending
      pending = 0
      run = 0
      streak++
      // 边界确认门槛：连续 ≥2 位匹配（孤立随机匹配不把边界漂移进标签/无关区）
      if (streak >= 2) {
        goodI = i
        goodJ = j
      }
      if (pushWin(true)) break
      i += dir
      j += dir
      continue
    }
    // 缺口修复：错配游程达 3 时尝试单侧跳位（full 侧跳 = full 缺口；provided 侧跳 = provided 缺口）。
    // 跳位须确认：跳后连续 REPAIR_CONFIRM 位匹配（随机单点匹配不构成修复证据）
    if (run >= 3) {
      let repaired = false
      for (let g = 1; g <= GAP_REPAIR_MAX && !repaired; g++) {
        if ((dir > 0 ? j + g < F : j - g >= 0) && confirmShift(i, j + dir * g) && provided[i] === full[j + dir * g]) {
          j += dir * g
          indels += g
          repaired = true
        } else if ((dir > 0 ? i + g < P : i - g >= 0) && confirmShift(i + dir * g, j) && provided[i + dir * g] === full[j]) {
          i += dir * g
          indels += g
          repaired = true
        }
      }
      if (repaired) {
        run = 0
        continue
      }
    }
    pending++
    run++
    streak = 0
    if (run > WALK_STOP_RUN) break
    if (pushWin(false)) break
    i += dir
    j += dir
  }
  return { i: goodI, j: goodJ, matches, mismatches, indels }
}

/**
 * 种子链比对：内部种子定位对角线 → 带内中位种子双向容错延展 → 区间 + identity。
 * 返回 null = 无法定位（调用方回落 k-mer Jaccard）。
 */
function seedChainAlign(provided: string, full: string): SequenceComparison | null {
  const P = provided.length
  const F = full.length
  if (P < SEED_K * 2 || F < SEED_K) return null

  // 1) full 侧 k-mer 位置索引
  const idx = new Map<string, number[]>()
  for (let j = 0; j + SEED_K <= F; j++) {
    const kmer = full.slice(j, j + SEED_K)
    const arr = idx.get(kmer)
    if (arr == null) idx.set(kmer, [j])
    else if (arr.length < MAX_POS_PER_KMER) arr.push(j)
  }

  // 2) 种子收集 + 对角线（d = j - i）票数累计
  const stride = Math.max(1, Math.ceil((P - SEED_K + 1) / MAX_PROVIDED_SEEDS))
  const diag = new Map<number, number>()
  const seeds: Array<{ i: number; j: number }> = []
  for (let i = 0; i + SEED_K <= P; i += stride) {
    const hits = idx.get(provided.slice(i, i + SEED_K))
    if (!hits) continue
    for (const j of hits) {
      diag.set(j - i, (diag.get(j - i) ?? 0) + 1)
      if (seeds.length < MAX_SEEDS) seeds.push({ i, j })
    }
  }
  if (seeds.length === 0) return null

  // 3) 最佳对角线（±DIAG_BAND 带宽合并票数 — 容忍少量 indel 漂移）
  let bestD = 0
  let bestW = -1
  for (const [d, w] of diag) {
    let band = w
    for (let o = 1; o <= DIAG_BAND; o++) {
      band += diag.get(d - o) ?? 0
      band += diag.get(d + o) ?? 0
    }
    if (band > bestW) {
      bestW = band
      bestD = d
    }
  }

  // 4) 带内种子 → 延展起点（中位种子 — 避开末端标签区对起点的扰动）
  const inBand = seeds.filter(s => Math.abs(s.j - s.i - bestD) <= DIAG_BAND)
  if (inBand.length === 0) return null
  inBand.sort((a, b) => a.i - b.i)
  const anchor = inBand[Math.floor(inBand.length / 2)]

  // 5) 双向容错延展
  const right = walkOutward(provided, full, anchor.i + SEED_K, anchor.j + SEED_K, 1)
  const left = walkOutward(provided, full, anchor.i, anchor.j, -1)

  // 种子本身贡献 SEED_K 个匹配（左延展含种子首位 — 总账补 SEED_K-1）
  const matches = right.matches + left.matches + SEED_K - 1
  const mismatches = right.mismatches + left.mismatches
  const indels = right.indels + left.indels
  if (matches < SEED_K) return null

  // 6) 区间合成（1-based 闭区间；good 位置为最后一处匹配位，0-based）
  const start = left.j + 1
  const end = right.j + 1
  const provStart = left.i + 1
  const provEnd = right.i + 1
  if (end < start || end > F || start < 1) return null

  const spanLen = end - start + 1
  const covered = provEnd - provStart + 1
  // 区间合理性：覆盖提交序列主体（≥60%）；全长侧跨度不超提供序列 1.5 倍 + 30（容忍 indel）
  if (covered < Math.floor(P * MIN_PROVIDED_COVERAGE)) return null
  if (spanLen > Math.ceil(P * 1.5) + 30) return null

  const identity = Math.round((matches / (matches + mismatches + indels)) * 100)
  return {
    identity,
    sameTarget: identity >= 85,
    providedLength: P,
    fullLength: F,
    start,
    end,
    provStart,
    provEnd,
    method: 'seed-chain',
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
