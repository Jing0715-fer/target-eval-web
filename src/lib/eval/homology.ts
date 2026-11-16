/**
 * 轻量同源检测（v1.10 同源靶点归并用）— 判断两条蛋白序列是否属于同一家族。
 *
 * 与 seq-compare.ts 的分工：
 *  - compareSequences：判定「同一靶点」（≥85% 一致性，构建边界分析）— 锚点需 ≥12aa 精确匹配
 *  - estimateHomology：判定「同一家族」（直系/旁系同源，35–85% 一致性区间）— 该区间内
 *    长精确锚点不存在、8-mer Jaccard 信号过弱，需要专门的种子-对角链算法
 *
 * 算法（minimap 思路的蛋白版，零依赖）：
 *  1) 4-mer 种子索引（k=4：40% 一致性时单种子存活率 2.6%，随机序列 ~0.3%，信噪比充分；
 *     重复种子（出现 >8 次）跳过，避免低复杂度区污染）
 *  2) 种子命中按对角线 d=i-j 分桶 — 真同源的命中聚集在同一对角带（±2 容忍小 indel），
 *     随机命中均匀散布
 *  3) 支持度 support = 命中带覆盖的 B 位点比例 ≈ identity^k（无 gap 近似）
 *  4) 一致性精修：贪心链锚点 → 相邻锚点间沿对角线逐位比较（锚点间对角差 = indel），
 *     matches/compared 得到真实一致性估计（不受锚点定义偏置 — 锚点本身也是真实比对位置）
 *
 * 内存：4-mer 索引 ≤ len(A) 条目、对角桶为 Map — 5000+ aa 毫秒级，无 DP 矩阵。
 */
import { compareSequences } from './seq-compare'
import { detectAntibody } from './antibody'
import type { BlastGroup, HomologPair, SequenceAttribution } from './types'

const K = 4
/** 单个 k-mer 在 A 中出现超过该次数视为重复，跳过（低复杂度区） */
const MAX_KMER_REPEAT = 8
/** 对角带半宽（容忍小 indel） */
const BAND = 2
/** 判定同源的支持度阈值（≈ 一致性 39%） */
const SUPPORT_THRESHOLD = 0.015
/** 判定同源的（精修后）一致性下限 */
const IDENTITY_THRESHOLD = 35
/** 家族归并的确定性阈值（≥ 此值直接合并，LLM 不可否决） */
export const HOMOLOG_MERGE_IDENTITY = 40

export interface HomologyEstimate {
  isHomolog: boolean
  /** 精修后的一致性估计（0-100；不足以精修时用 support^(1/k) 近似） */
  identity: number
  /** 种子带覆盖度（0-1） */
  support: number
  method: 'seed-diagonal' | 'same-target' | 'no-shared-seeds' | 'too-short'
}

/** 两条已清洗（大写无空格）蛋白序列的同源性估计 */
export function estimateHomology(a: string, b: string): HomologyEstimate {
  if (a.length < 40 || b.length < 40) return { isHomolog: false, identity: 0, support: 0, method: 'too-short' }

  // 0) 先走 compareSequences 的快路径：精确子串/锚定 ≥85% 即同一靶点（同源的特例）
  const cmp = compareSequences(a, b)
  if (cmp.sameTarget && cmp.identity >= 85) {
    return { isHomolog: true, identity: cmp.identity, support: 1, method: 'same-target' }
  }

  // 1) A 的 4-mer 索引（跳过高频重复种子）
  const idx = new Map<string, number[]>()
  for (let i = 0; i + K <= a.length; i++) {
    const k = a.slice(i, i + K)
    let arr = idx.get(k)
    if (!arr) {
      arr = []
      idx.set(k, arr)
    }
    arr.push(i)
  }

  // 2) 扫描 B，命中记入对角桶
  const diagCount = new Map<number, number>()
  const hits: Array<{ i: number; j: number }> = []
  for (let j = 0; j + K <= b.length; j++) {
    const arr = idx.get(b.slice(j, j + K))
    if (!arr || arr.length > MAX_KMER_REPEAT) continue
    for (const i of arr) {
      hits.push({ i, j })
      const d = i - j
      diagCount.set(d, (diagCount.get(d) ?? 0) + 1)
    }
  }
  if (!hits.length) return { isHomolog: false, identity: 0, support: 0, method: 'no-shared-seeds' }

  // 3) 最优对角带（±BAND 合并计分）
  let bestD = 0
  let bestScore = 0
  for (const d of diagCount.keys()) {
    let s = 0
    for (let dd = d - BAND; dd <= d + BAND; dd++) s += diagCount.get(dd) ?? 0
    if (s > bestScore) {
      bestScore = s
      bestD = d
    }
  }
  const bandHits = hits.filter(h => Math.abs(h.i - h.j - bestD) <= BAND).sort((x, y) => x.j - y.j)

  // 支持度：带内命中覆盖的 B 位点比例
  const covered = new Set<number>()
  for (const h of bandHits) for (let j = h.j; j < h.j + K; j++) covered.add(j)
  const support = covered.size / Math.min(a.length, b.length)
  // 种子数下限：随机序列期望仅 ~2 个 4-mer 命中（len²/20⁴），两条种子不足以
  // 支撑同源判定（短序列的 support^(1/4) 兜底估计会被偶发命中污染 — GFP 误判案例）
  if (bandHits.length < 4 || covered.size < 16) {
    return { isHomolog: false, identity: 0, support, method: 'seed-diagonal' }
  }

  // 4) 一致性精修：贪心链（j 与 i 同时递增）→ 锚点间沿对角线逐位比较
  const chain: Array<{ i: number; j: number }> = []
  let lastI = -1
  let lastJ = -1
  for (const h of bandHits) {
    if (h.j > lastJ && h.i > lastI) {
      chain.push(h)
      lastI = h.i
      lastJ = h.j
    }
  }
  let matches = 0
  let compared = 0
  const compareDiag = (j0: number, j1: number, d: number) => {
    for (let j = j0; j < j1; j++) {
      const i = j + d
      if (i < 0 || i >= a.length || j < 0 || j >= b.length) continue
      compared++
      if (a[i] === b[j]) matches++
    }
  }
  for (let c = 0; c < chain.length; c++) {
    const cur = chain[c]
    const next = chain[c + 1]
    // 锚点段本身（K 位，真实匹配位）计入 — 排除会系统性低估（锚点间插值对角
    // 在 indel 区失准，校准实测 60% 真实一致性仅报 44%，错过 40% 合并阈值）；
    // 计入的代价是保守区富集带来的 +2~11pp 高估（对「家族判定宁可合并」的
    // 决策语义更安全），展示时标注为估计值
    compareDiag(cur.j, cur.j + K, cur.i - cur.j)
    // 锚点间段：前半用当前对角、后半用下一锚点对角（线性过渡近似 indel）
    if (next) {
      const mid = Math.floor((cur.j + K + next.j) / 2)
      compareDiag(cur.j + K, mid, cur.i - cur.j)
      compareDiag(mid, next.j, next.i - next.j)
    }
  }
  const minLen = Math.min(a.length, b.length)
  const refined = compared >= minLen * 0.5 ? Math.round((matches / compared) * 100) : 0
  const fallbackEst = Math.round(Math.pow(support, 1 / K) * 100)
  const identity = refined > 0 ? refined : fallbackEst
  const isHomolog = support >= SUPPORT_THRESHOLD && identity >= IDENTITY_THRESHOLD
  return { isHomolog, identity, support, method: 'seed-diagonal' }
}

// ─── 家族聚类 ─────────────────────────────────────────────────────────────────

export interface HomologTarget {
  uniprotId: string
  sequence: string
}

/**
 * 多靶点两两同源比对 + 并查集聚类。
 * 返回：全部两两结果（含不同源对，identity=0 供矩阵展示）与按 ≥mergeIdentity 聚出的家族组。
 */
export function clusterHomologs(
  targets: HomologTarget[],
  mergeIdentity: number = HOMOLOG_MERGE_IDENTITY,
): { pairs: HomologPair[]; clusters: number[][] } {
  const n = targets.length
  const pairs: HomologPair[] = []
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])))
  const union = (x: number, y: number) => {
    const rx = find(x)
    const ry = find(y)
    if (rx !== ry) parent[rx] = ry
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const est = estimateHomology(targets[i].sequence, targets[j].sequence)
      pairs.push({ a: targets[i].uniprotId, b: targets[j].uniprotId, identity: est.identity, method: est.method })
      if (est.isHomolog && est.identity >= mergeIdentity) union(i, j)
    }
  }
  const groups = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    const r = find(i)
    const arr = groups.get(r) ?? []
    arr.push(i)
    groups.set(r, arr)
  }
  // 只保留 ≥2 成员的组（家族）
  const clusters = [...groups.values()].filter(g => g.length >= 2)
  return { pairs, clusters }
}

// ─── ≥90% 高一致组（v1.11 BLAST 委托）───────────────────────────────────────

/** 高一致组判据：两两一致性 ≥ 该值的靶点对视为「同一检索可共享」 */
export const HIGH_IDENTITY_GROUP = 90

/**
 * 从两两比对结果中提取 ≥90% 高一致组（连通分量）：
 * 组内成员序列高度一致（直系同源/同一蛋白不同物种），BLAST 同源结构几乎完全重合，
 * 仅需家族代表执行一次检索，其余成员共享结果（用户 v1.11 反馈：≥90% 不必每个都搜）。
 * minIdentity = 组内全部两两一致性的最小值（诚实下界；连通判据为相邻对 ≥ 阈值）。
 */
export function groupHighIdentity(
  pairs: HomologPair[],
  keyPrefix = 'hg',
  threshold: number = HIGH_IDENTITY_GROUP,
): BlastGroup[] {
  const strong = pairs.filter(p => p.identity >= threshold)
  if (!strong.length) return []
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    const p = parent.get(x)
    if (p === undefined || p === x) return x
    const r = find(p)
    parent.set(x, r)
    return r
  }
  const union = (x: string, y: string) => {
    const rx = find(x)
    const ry = find(y)
    if (rx !== ry) parent.set(rx, ry)
  }
  for (const p of strong) {
    if (!parent.has(p.a)) parent.set(p.a, p.a)
    if (!parent.has(p.b)) parent.set(p.b, p.b)
    union(p.a, p.b)
  }
  const groups = new Map<string, string[]>()
  for (const id of parent.keys()) {
    const r = find(id)
    const arr = groups.get(r) ?? []
    arr.push(id)
    groups.set(r, arr)
  }
  const out: BlastGroup[] = []
  let seq = 0
  for (const members of groups.values()) {
    if (members.length < 2) continue
    const mset = new Set(members)
    let min = 100
    for (const p of pairs) {
      if (mset.has(p.a) && mset.has(p.b) && p.identity > 0) min = Math.min(min, p.identity)
    }
    out.push({
      groupKey: `${keyPrefix}_${seq++}`,
      members: members.sort(),
      minIdentity: min,
    })
  }
  return out
}

// ─── 评估表序列归属（类型 SequenceAttribution / AttributionTarget 见 types.ts）──

/**
 * 评估表中的序列 → 靶点归属：
 *  - 抗体序列（基序检测）→ background，不参与归属
 *  - compareSequences ≥85%（同一靶点）→ construct：随该靶点作业提交（构建边界分析）
 *  - 35–85%（同一家族不同成员）→ homolog：报告中标注疑似家族成员/其他物种同源物
 *  - 其余 → unmatched
 */
export function attributeSequences(
  sequences: Array<{ header: string; seq: string; length: number }>,
  targets: Array<{ uniprotId: string; sequence: string }>,
): SequenceAttribution[] {
  const out: SequenceAttribution[] = []
  sequences.forEach((s, index) => {
    if (s.length < 30 || !s.seq) {
      out.push({ index, header: s.header, length: s.length, kind: 'unmatched', note: '序列过短（<30 aa），不参与归属' })
      return
    }
    if (detectAntibody(s.seq).isAntibody) {
      out.push({ index, header: s.header, length: s.length, kind: 'antibody', note: '检测为抗体序列 — 作为背景证据，不独立评估' })
      return
    }
    let best: { uniprotId: string; identity: number; sameTarget: boolean; start: number | null; end: number | null } | null = null
    for (const t of targets) {
      const cmp = compareSequences(s.seq, t.sequence)
      const hom = cmp.identity >= 85 ? cmp : estimateHomology(s.seq, t.sequence)
      const identity = Math.max(cmp.identity, hom.identity)
      if (!best || identity > best.identity) {
        best = {
          uniprotId: t.uniprotId,
          identity,
          sameTarget: cmp.sameTarget,
          start: cmp.start ?? null,
          end: cmp.end ?? null,
        }
      }
    }
    if (!best || !targets.length) {
      out.push({ index, header: s.header, length: s.length, kind: 'unmatched', note: '无已选靶点可比对' })
      return
    }
    if (best.sameTarget) {
      out.push({
        index,
        header: s.header,
        length: s.length,
        kind: 'construct',
        uniprotId: best.uniprotId,
        identity: best.identity,
        start: best.start,
        end: best.end,
        note: `与 ${best.uniprotId} 为同一靶点（一致性 ${best.identity}%）${best.start != null && best.end != null ? `，估计区间 ${best.start}-${best.end}` : ''} — 已作为该靶点的客户构建并入评估`,
      })
    } else if (best.identity >= IDENTITY_THRESHOLD) {
      out.push({
        index,
        header: s.header,
        length: s.length,
        kind: 'homolog',
        uniprotId: best.uniprotId,
        identity: best.identity,
        note: `与 ${best.uniprotId} 同源（一致性 ${best.identity}%）但非同一蛋白 — 疑似家族其他成员或其他物种同源物，结构证据可互相借鉴`,
      })
    } else {
      out.push({
        index,
        header: s.header,
        length: s.length,
        kind: 'unmatched',
        note: `与全部已选靶点一致性均 <${IDENTITY_THRESHOLD}%（最佳 ${best.uniprotId} ${best.identity}%）— 未匹配到本批次靶点`,
      })
    }
  })
  return out
}
