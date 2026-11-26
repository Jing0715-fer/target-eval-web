/**
 * v2.96 身份识别序列比对（报告证据可视化）。
 *
 * 用户规则（2026-11-26）：靶点经序列匹配归属 UniProt 后，**非 100% 一致性**的
 * 归属需在报告中展示「提交序列 ↔ UniProt 条目」的双序列比对 — 样式美观、
 * 可读性强、悬停显示氨基酸残基号。比对数据与 EBI BLAST HSP 同语义：
 *
 *  - 局部比对（Smith-Waterman + Gotoh 仿射缺口）：最优同源区段两端自由截断 —
 *    与 BLAST HSP 口径一致（标签头/构建尾巴/远缘末端不在比对区内，不稀释
 *    一致率）；比 seq-compare.ts 的半全局比对更适合「展示同源证据」的场景
 *    （后者为构建边界推导设计，双端悬挂计入覆盖度口径）。
 *  - 计分：BLOSUM62（与 BLASTp 默认一致），缺口存在 -11 / 每残基延伸 -1。
 *  - 产出三行比对串（qseq/mseq/hseq，'-' 表缺口）+ 双侧 1-based 闭区间坐标
 *    （qFrom/qTo = 提交序列；hFrom/hTo = UniProt 条目编号）+ 一致率/正替代率
 *    （BLOSUM62 得分 >0 的替换列，BLAST「Positives」同口径）/缺口统计。
 *  - 内存护栏：全量 DP ≤ 6M 格（~12MB 方向矩阵 + 滚动得分行）；更大的条目
 *    （如 titin 3 万 aa）经 8-mer 种子对角线投票裁出同源窗口再比对 — 坐标
 *    按窗口偏移还原为条目编号。种子定位失败（无任何 8-mer 全同）返回 null，
 *    调用方静默跳过比对面板（best-effort 证据增强，不阻塞评估）。
 *
 * 纯 CPU（无网络），常规构建（≤1500 aa）毫秒级完成，超大序列 <1s。
 */
import type { IdentityAlignment } from './types'

/** BLOSUM62 残基序（24 字符 — 与矩阵行列一致） */
const AA_ORDER = 'ARNDCQEGHILKMFPSTWYVBZX*'
/** BLOSUM62 计分矩阵（24×24，行列表 = AA_ORDER；与 BLASTp 默认矩阵一致） */
const BLOSUM62 = [
  // A  R  N  D  C  Q  E  G  H  I  L  K  M  F  P  S  T  W  Y  V  B  Z  X  *
  [4, -1, -2, -2, 0, -1, -1, 0, -2, -1, -1, -1, -1, -2, -1, 1, 0, -3, -2, 0, -2, -1, 0, -4],
  [-1, 5, 0, -2, -3, 1, 0, -2, 0, -3, -2, 2, -1, -3, -2, -1, -1, -3, -2, -3, -1, 0, -1, -4],
  [-2, 0, 6, 1, -3, 0, 0, 0, 1, -3, -3, 0, -2, -3, -2, 1, 0, -4, -2, -3, 3, 0, -1, -4],
  [-2, -2, 1, 6, -3, 0, 2, -1, -1, -3, -4, -1, -3, -3, -1, 0, -1, -4, -3, -3, 4, 1, -1, -4],
  [0, -3, -3, -3, 9, -3, -4, -3, -3, -1, -1, -3, -1, -2, -3, -1, -1, -2, -2, -1, -3, -3, -2, -4],
  [-1, 1, 0, 0, -3, 5, 2, -2, 0, -3, -2, 1, 0, -3, -1, 0, -1, -2, -1, -2, 0, 3, -1, -4],
  [-1, 0, 0, 2, -4, 2, 5, -2, 0, -3, -3, 1, -2, -3, -1, 0, -1, -3, -2, -2, 1, 4, -1, -4],
  [0, -2, 0, -1, -3, -2, -2, 6, -2, -4, -4, -2, -3, -3, -2, 0, -2, -2, -3, -3, -1, -2, -1, -4],
  [-2, 0, 1, -1, -3, 0, 0, -2, 8, -3, -3, -1, -2, -1, -2, -1, -2, -2, 2, -3, 0, 0, -1, -4],
  [-1, -3, -3, -3, -1, -3, -3, -4, -3, 4, 2, -3, 1, 0, -3, -2, -1, -3, -1, 3, -3, -3, -1, -4],
  [-1, -2, -3, -4, -1, -2, -3, -4, -3, 2, 4, -2, 2, 0, -3, -2, -1, -2, -1, 1, -4, -3, -1, -4],
  [-1, 2, 0, -1, -3, 1, 1, -2, -1, -3, -2, 5, -1, -3, -1, 0, -1, -3, -2, -2, 0, 1, -1, -4],
  [-1, -1, -2, -3, -1, 0, -2, -3, -2, 1, 2, -1, 5, 0, -2, -1, -1, -1, -1, 1, -3, -1, -1, -4],
  [-2, -3, -3, -3, -2, -3, -3, -3, -1, 0, 0, -3, 0, 6, -4, -2, -2, 1, 3, -1, -3, -3, -1, -4],
  [-1, -2, -2, -1, -3, -1, -1, -2, -2, -3, -3, -1, -2, -4, 7, -1, -1, -4, -3, -2, -2, -1, -2, -4],
  [1, -1, 1, 0, -1, 0, 0, 0, -1, -2, -2, 0, -1, -2, -1, 4, 1, -3, -2, -2, 0, 0, 0, -4],
  [0, -1, 0, -1, -1, -1, -1, -2, -2, -1, -1, -1, -1, -2, -1, 1, 5, -2, -2, 0, -1, -1, 0, -4],
  [-3, -3, -4, -4, -2, -2, -3, -2, -2, -3, -2, -3, -1, 1, -4, -3, -2, 11, 2, -3, -4, -3, -2, -4],
  [-2, -2, -2, -3, -2, -1, -2, -3, 2, -1, -1, -2, -1, 3, -3, -2, -2, 2, 7, -1, -3, -2, -1, -4],
  [0, -3, -3, -3, -1, -2, -2, -3, -3, 3, 1, -2, 1, -1, -2, -2, 0, -3, -1, 4, -3, -2, -1, -4],
  [-2, -1, 3, 4, -3, 0, 1, -1, 0, -3, -4, 0, -3, -3, -2, 0, -1, -4, -3, -3, 4, 1, -1, -4],
  [-1, 0, 0, 1, -3, 3, 4, -2, 0, -3, -3, 1, -1, -3, -1, 0, -1, -3, -2, -2, 1, 4, -1, -4],
  [0, -1, -1, -1, -2, -1, -1, -1, -1, -1, -1, -1, -1, -1, -2, 0, 0, -2, -1, -1, -1, -1, -1, -4],
  [-4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, -4, 1],
]

/** 缺口存在罚分（BLASTp 默认 11） */
const GAP_OPEN = 11
/** 缺口延伸罚分（每残基，BLASTp 默认 1） */
const GAP_EXT = 1
/** 全量 DP 格数护栏（≈6M 格 = 12MB 方向矩阵；超过走种子窗口路径） */
const MAX_FULL_CELLS = 6_000_000
/** 窗口路径：种子长度（8-mer — 与 seq-compare 种子链同规格） */
const SEED_K = 8
/** 窗口路径：每个种子在条目侧最多登记的位置数（重复区保护） */
const MAX_POS_PER_KMER = 24
/** 窗口路径：同源区段外的条目侧余量（容纳末端缺口与少量越界） */
const WIN_PAD = 160
/** 窗口路径：窗口长度上限（提交长度 + 两侧余量；更长的窗口按中位种子居中裁剪） */
const WIN_MAX_OVER = 480
/** 比对列数上限（防御性 — 逾万列的展示已不可读，直接放弃面板） */
const MAX_ALIGN_COLS = 20_000

/** 残基 → BLOSUM62 行号（未知残基归 X 行） */
const AA_IDX = (() => {
  const m = new Int8Array(128).fill(23)
  for (let i = 0; i < AA_ORDER.length; i++) m[AA_ORDER.charCodeAt(i)] = i
  return m
})()

/** 序列清洗：大写化、去非法字符（未知残基保留原字母，计分按 X 行 — 与 BLAST 行为一致） */
function normalizeSeq(seq: string): string {
  return seq.replace(/[^A-Za-z]/g, '').toUpperCase()
}

/** 残基对计分（charCode 直查行号 — 无 Map/字符串查找开销） */
function scoreOf(a: number, b: number): number {
  return BLOSUM62[AA_IDX[a & 0x7f]][AA_IDX[b & 0x7f]]
}

/** 方向位标记（dir 字节：bits0-1=D 来源 / bits2-3=P 来源 / bits4-5=Q 来源）
 *  D 来源 3 = 重启起点（局部比对 fresh start — 回溯在 state=D 时遇 3 停止） */
const FROM_D = 0
const FROM_P = 1
const FROM_Q = 2
const FROM_RESTART = 3
const D_MASK = 3
const P_SHIFT = 2
const Q_SHIFT = 4

/** 局部比对核心（Smith-Waterman + Gotoh 仿射缺口）。
 *  a = 提交序列（查询），b = 条目序列（窗口内），hOffset = 窗口在条目中的 0-based 偏移。
 *  返回 null = 无法产出可用比对（格数超限 / 比对区过短）。 */
function alignLocal(
  a: string,
  b: string,
  hOffset: number,
): Omit<IdentityAlignment, 'acc' | 'entryName' | 'db' | 'blastIdentity' | 'method'> | null {
  const P = a.length
  const F = b.length
  if (P < 8 || F < 8 || P * F > MAX_FULL_CELLS) return null

  const W = F + 1
  // 滚动得分行（D/P/Q 三状态各「上一行 + 当前行」；Q 同行递推但仍需上一行供 D 转移读）
  // Int16 覆盖 |s| ≤ 2·min(P,F) 的得分域；NEG = 不可用（缺口状态不可从边界起步）
  const NEG = -30000
  const dPrev = new Int16Array(W)
  const dCur = new Int16Array(W)
  const pPrev = new Int16Array(W).fill(NEG)
  const pCur = new Int16Array(W)
  const qPrev = new Int16Array(W).fill(NEG)
  const qCur = new Int16Array(W)

  const dir = new Uint8Array((P + 1) * W)
  let bestScore = 0
  let bestI = 0
  let bestJ = 0

  for (let i = 1; i <= P; i++) {
    const ac = a.charCodeAt(i - 1)
    const row = i * W
    pCur[0] = NEG
    qCur[0] = NEG
    let dLeft = 0 // D[i][0] = 0（首列自由起点 — 局部比对重启边界）
    for (let j = 1; j <= F; j++) {
      const bc = b.charCodeAt(j - 1)
      // Q[i][j] = max(Q[i][j-1]-ext, D[i][j-1]-open-ext)（'-' 对 b[j-1]，同行递推）
      const qFromQ = qCur[j - 1] > NEG / 2 ? qCur[j - 1] - GAP_EXT : NEG
      const qFromD = dLeft - GAP_OPEN - GAP_EXT
      const q = qFromQ >= qFromD ? qFromQ : qFromD
      const qDir = qFromQ >= qFromD ? 1 : 0
      qCur[j] = q
      // P[i][j] = max(P[i-1][j]-ext, D[i-1][j]-open-ext)（a[i-1] 对 '-'，跨行递推）
      const pFromP = pPrev[j] > NEG / 2 ? pPrev[j] - GAP_EXT : NEG
      const pFromD = dPrev[j] - GAP_OPEN - GAP_EXT
      const p = pFromP >= pFromD ? pFromP : pFromD
      const pDir = pFromP >= pFromD ? 1 : 0
      pCur[j] = p
      // D[i][j] = max(D/P/Q[i-1][j-1] + S)，重启格恒为 0（局部比对可从任意格重新开始）
      let dSrc = dPrev[j - 1]
      let dDir = FROM_D
      if (pPrev[j - 1] > dSrc) { dSrc = pPrev[j - 1]; dDir = FROM_P }
      if (qPrev[j - 1] > dSrc) { dSrc = qPrev[j - 1]; dDir = FROM_Q }
      const d = dSrc + scoreOf(ac, bc)
      // 方向字节：D 来源（bits0-1，重启格恒 0 = 回溯停止信号）+ P/Q 来源（bits2-5，
      // 无论 D 是否重启都要写 — 本格 P/Q 状态仍可能在回溯路径上）
      const dirByte = (pDir << P_SHIFT) | (qDir << Q_SHIFT)
      if (d <= 0) {
        dCur[j] = 0
        dir[row + j] = FROM_RESTART | dirByte // D 位 = 3：重启起点（回溯在 state=D 时遇 3 停止）
      } else {
        dCur[j] = d
        dir[row + j] = dDir | dirByte
        if (d > bestScore) { bestScore = d; bestI = i; bestJ = j }
      }
      dLeft = dCur[j]
    }
    // 滚动行交换（内容拷贝 — dPrev/pPrev/qPrev 即下一轮的「上一行」）
    dPrev.set(dCur)
    pPrev.set(pCur)
    qPrev.set(qCur)
  }
  if (bestScore <= 0) return null

  // ── 回溯（从最优 D 格出发，遇重启起点/边界停止）──
  let i = bestI
  let j = bestJ
  let qTo = bestI // 1-based：最优格所在行列即比对区末位
  let hTo = bestJ + hOffset
  const qChars: number[] = []
  const hChars: number[] = []
  let matches = 0
  let positives = 0
  let gaps = 0
  let state: 0 | 1 | 2 = 0 // 0=D 1=P（查询残基对缺口） 2=Q（条目残基对缺口）
  while (i > 0 && j > 0) {
    const cell = dir[i * W + j]
    if (state === 0) {
      if ((cell & D_MASK) === FROM_RESTART) break // 局部重启起点 — 比对区在此开始
      qChars.push(a.charCodeAt(i - 1))
      hChars.push(b.charCodeAt(j - 1))
      const s = scoreOf(a.charCodeAt(i - 1), b.charCodeAt(j - 1))
      if (a[i - 1] === b[j - 1]) { matches++; positives++ }
      else if (s > 0) positives++
      i--
      j--
      state = (cell & D_MASK) === FROM_D ? 0 : (cell & D_MASK) === FROM_P ? 1 : 2
    } else if (state === 1) {
      // P：a[i-1] 对 '-'（条目侧缺口）
      qChars.push(a.charCodeAt(i - 1))
      hChars.push(45) // '-'
      gaps++
      const from = (dir[i * W + j] >> P_SHIFT) & 1
      i--
      state = from === 1 ? 1 : 0
    } else {
      // Q：'-' 对 b[j-1]（查询侧缺口）
      qChars.push(45)
      hChars.push(b.charCodeAt(j - 1))
      gaps++
      const from = (dir[i * W + j] >> Q_SHIFT) & 1
      j--
      state = from === 1 ? 2 : 0
    }
    if (qChars.length > MAX_ALIGN_COLS) return null // 防御性：超长比对放弃面板
  }
  if (qChars.length < 8) return null
  const qFrom = i + 1
  const hFrom = j + 1 + hOffset

  // 反转（回溯为逆序）
  qChars.reverse()
  hChars.reverse()
  const qSeq = String.fromCharCode(...qChars)
  const hSeq = String.fromCharCode(...hChars)
  // 中线：'|' 全同 / '+' 正替代（BLOSUM62 得分 >0）/ 其余空格
  const mChars: number[] = new Array(qChars.length)
  for (let k = 0; k < qChars.length; k++) {
    const qc = qChars[k]
    const hc = hChars[k]
    if (qc === 45 || hc === 45) { mChars[k] = 32; continue }
    if (qc === hc) { mChars[k] = 124; continue }
    mChars[k] = scoreOf(qc, hc) > 0 ? 43 : 32
  }
  const mSeq = String.fromCharCode(...mChars)

  const alignLen = qChars.length
  const identity = Math.round((matches / alignLen) * 1000) / 10
  const positivePct = Math.round((positives / alignLen) * 1000) / 10
  return { qFrom, qTo, hFrom, hTo, qSeq, mSeq, hSeq, identity, positives: positivePct, gaps, alignLen, qLen: P, hLen: F + hOffset }
}

/** 种子对角线投票 → 条目侧同源窗口（超大条目的全量 DP 替代路径）。
 *  返回 0-based [start, end) 窗口；null = 无法定位（无种子 / 区间异常）。 */
function seedWindow(query: string, subject: string): [number, number] | null {
  const P = query.length
  const F = subject.length
  if (P < SEED_K) return null
  // 条目侧 8-mer 位置索引
  const idx = new Map<string, number[]>()
  for (let j = 0; j + SEED_K <= F; j++) {
    const kmer = subject.slice(j, j + SEED_K)
    const arr = idx.get(kmer)
    if (arr == null) idx.set(kmer, [j])
    else if (arr.length < MAX_POS_PER_KMER) arr.push(j)
  }
  // 对角线（d = j - i）票数累计 + 带宽合并（±4）
  const diag = new Map<number, number>()
  const inBand: Array<{ i: number; j: number }> = []
  for (let i = 0; i + SEED_K <= P; i++) {
    const hits = idx.get(query.slice(i, i + SEED_K))
    if (!hits) continue
    for (const j of hits) {
      diag.set(j - i, (diag.get(j - i) ?? 0) + 1)
      inBand.push({ i, j })
    }
  }
  if (!inBand.length) return null
  let bestD = 0
  let bestW = -1
  for (const [d, w] of diag) {
    let band = w
    for (let o = 1; o <= 4; o++) {
      band += diag.get(d - o) ?? 0
      band += diag.get(d + o) ?? 0
    }
    if (band > bestW) { bestW = band; bestD = d }
  }
  const seeds = inBand.filter(s => Math.abs(s.j - s.i - bestD) <= 4)
  if (!seeds.length) return null
  let minJ = seeds[0].j
  let maxJ = seeds[0].j
  for (const s of seeds) {
    if (s.j < minJ) minJ = s.j
    if (s.j > maxJ) maxJ = s.j
  }
  let start = Math.max(0, minJ - WIN_PAD)
  let end = Math.min(F, maxJ + SEED_K + WIN_PAD)
  // 窗口长度护栏：超限时按中位种子居中裁剪（保留主同源区段）
  const winMax = P + WIN_PAD * 2 + WIN_MAX_OVER
  if (end - start > winMax) {
    const seeds2 = [...seeds].sort((x, y) => x.j - y.j)
    const mid = seeds2[Math.floor(seeds2.length / 2)].j
    start = Math.max(0, Math.min(start, mid - Math.floor(winMax / 2)))
    end = Math.min(F, start + winMax)
    start = Math.max(0, end - winMax)
  }
  if (end - start < 8) return null
  return [start, end]
}

export interface AlignForEvidenceOpts {
  /** 归属的 UniProt accession（展示/外链用） */
  acc: string
  entryName?: string
  /** 库类型（sp / tr / other — 徽标用） */
  db?: string
  /** BLAST 归属命中的一致性 %（与比对区一致率并列展示；缺省只展示比对统计） */
  blastIdentity?: number
}

/**
 * 提交序列 ↔ UniProt 条目序列的局部比对（报告「序列比对」面板数据源）。
 * best-effort：比对失败（超规模/无种子/防御性放弃）返回 null，调用方跳过面板。
 */
export function alignForIdentityEvidence(
  querySeq: string,
  subjectSeq: string,
  opts: AlignForEvidenceOpts,
): IdentityAlignment | null {
  const a = normalizeSeq(querySeq)
  const b = normalizeSeq(subjectSeq)
  if (a.length < 8 || b.length < 8) return null
  // 快路径：提交序列为条目子串（精确匹配口径）— 直接铺满比对（全 '| '，零 DP）
  const subIdx = b.indexOf(a)
  if (subIdx >= 0 && a.length <= MAX_ALIGN_COLS) {
    return {
      acc: opts.acc, entryName: opts.entryName, db: opts.db,
      blastIdentity: opts.blastIdentity,
      qFrom: 1, qTo: a.length, hFrom: subIdx + 1, hTo: subIdx + a.length,
      qSeq: a, mSeq: '|'.repeat(a.length), hSeq: a,
      identity: 100, positives: 100, gaps: 0, alignLen: a.length,
      qLen: a.length, hLen: b.length, method: 'exact-substring',
    }
  }
  const core = a.length * b.length <= MAX_FULL_CELLS
    ? alignLocal(a, b, 0)
    : (() => {
        const win = seedWindow(a, b)
        if (!win) return null
        // 窗口路径：hLen 需还原为条目全长（alignLocal 内 F = 窗口长度）
        const partial = alignLocal(a, b.slice(win[0], win[1]), win[0])
        return partial ? { ...partial, hLen: b.length } : null
      })()
  if (!core) return null
  return {
    acc: opts.acc, entryName: opts.entryName, db: opts.db,
    blastIdentity: opts.blastIdentity,
    ...core,
    method: 'local-sw-blosum62',
  }
}
