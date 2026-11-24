/**
 * 导入报告统计快照解析（v2.69 引入、v2.72 抽出为前后端共享模块）。
 *
 * 用途：导入既有报告时从报告 HTML 解析出单靶点统计快照（ImportedReportStats），
 * 供汇总报告构建与本次评估同权的完整统计行。v2.72 起服务端汇总生成链路也用
 * 同一解析器做**补解析回填**（backfillImportedStats）— 客户端解析失败/未运行
 * 的降级行（「报告打开正常但表格评分为空」）在服务端读留存原文前缀再解析一次，
 * 命中即升级为完整统计行。
 *
 * v2.72 解析增强（定位更稳）：
 *  - ⓪ 机器可读标记通道：v2.45+ 报告内嵌 <meta name="targeteval:target">（单靶点）
 *    / <meta name="targeteval:targets">（合并，与内嵌页同序）— seqSha（提交序列
 *    SHA-256 前 16 hex）/ seqLength（提交长度，区别于刊头的 UniProt 全长）/
 *    header / label 为服务端权威值，按区段对齐后附到各 section；
 *  - pickImportedStats 定位链：①SHA 精确（权威 — 已识别序列靶点的刊头长度是
 *    UniProt 全长，长度通道天然对不上）→ ②UniProt acc + 区间（原有）→ ③长度
 *    精确（原有）→ ④容差 ±3 aa（归属比对的少量 indel；唯一命中才取）→ ⑤同长
 *    歧义时按归一化标签（meta label/header vs 目标标签）消歧。
 *
 * 纯函数、无浏览器/Node 专属 API（前后端同构）；SHA 由调用方计算传入
 * （客户端 WebCrypto / 服务端 node:crypto）。
 */
import type { ImportedReportStats } from './types'

/** 解析前缀上限（与 ht-archive-import 的 IMPORT_SOURCE_MAX_CHARS 同口径） */
const PARSE_MAX_CHARS = 33_000_000

/** HTML 实体反转义（报告正文 esc 后的值还原 — 展示用） */
export function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

/** 去标签取纯文本（meta-grid 行值等 — 保留实体位置再反转义） */
export function stripTags(s: string): string {
  return unescapeHtml(s.replace(/<[^>]*>/g, ''))
}

/** 解析出的单区段统计（未消毒的原始形态 — 内部用） */
export interface ImportedStatsSection extends ImportedReportStats {
  /** 题目「残基 X-Y」无同源度后缀时的全同比对跨度（= 提交序列长度 — 区段定位用） */
  alignedSpan?: number
  /** v2.72：报告内嵌 meta 标记的提交序列 SHA（服务端权威 — SHA 定位通道） */
  seqSha?: string
  /** v2.72：meta 标记的提交序列长度（区别于刊头 — 已识别靶点的刊头是 UniProt 全长） */
  metaSeqLength?: number
  /** v2.72：meta 标记的构建标签头 / 运行侧标签（标签消歧通道） */
  metaHeader?: string
  metaLabel?: string
}

const H1_TITLE_RE = /<h1 class="rpt-title"[^>]*>([^<]+)<\/h1>/g

/** v2.72：区段标题内的 UniProt accession 语法（与 ht-archive-import 同源副本） */
const UNIPROT_ACC_RE = /(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9][A-Z][A-Z0-9]{2}[0-9])(?:[A-Z0-9]{3}[0-9])?(?:-[0-9]+)?/

/** v2.72：标签归一化（小写 + 去非字母数字 — 吸收空格折叠/「…」截断/「·」分隔） */
function normLabel(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** v2.45 机器可读靶点标记条目（服务端生成 — 权威证据；字段消毒后使用） */
interface TargetMetaEntry {
  uniprot?: string
  range?: [number, number]
  seqLength?: number
  seqSha?: string
  header?: string
  label?: string
}

/** HTML 属性反转义（esc 的逆 — meta 标记通道用） */
function unescapeAttr(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/** 解析 <meta name="..." content="..."> 的 JSON（损坏/缺省返回 null） */
function parseMetaJson<T>(html: string, name: string): T | null {
  const m = new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]*)"`, 'i').exec(html)
  if (!m) return null
  try {
    const parsed = JSON.parse(unescapeAttr(m[1]!)) as T
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** meta 条目消毒（畸形字段丢弃 — 服务端可信但防御性解析；全空返回 null） */
function sanitizeMetaEntry(e: Partial<TargetMetaEntry>): Partial<TargetMetaEntry> | null {
  if (!e || typeof e !== 'object') return null
  const out: Partial<TargetMetaEntry> = {}
  if (typeof e.uniprot === 'string' && UNIPROT_ACC_RE.test(e.uniprot)) out.uniprot = e.uniprot.toUpperCase()
  if (Array.isArray(e.range) && e.range.length === 2 && Number(e.range[0]) >= 1 && Number(e.range[1]) >= Number(e.range[0])) {
    out.range = [Number(e.range[0]), Number(e.range[1])]
  }
  if (typeof e.seqLength === 'number' && Number.isFinite(e.seqLength) && e.seqLength >= 10 && e.seqLength <= 100000) out.seqLength = Math.round(e.seqLength)
  if (typeof e.seqSha === 'string' && /^[0-9a-f]{16}$/i.test(e.seqSha)) out.seqSha = e.seqSha.toLowerCase()
  if (typeof e.header === 'string' && e.header.trim()) out.header = e.header.trim().slice(0, 80)
  if (typeof e.label === 'string' && e.label.trim()) out.label = e.label.trim().slice(0, 90)
  return Object.keys(out).length > 0 ? out : null
}

/**
 * v2.72：解析报告内嵌的机器可读靶点标记（targeteval:target 单靶点 /
 * targeteval:targets 合并数组 — 与内嵌页同序）。
 */
export function parseImportedTargetMeta(html: string): TargetMetaEntry[] {
  const metaArr = parseMetaJson<unknown>(html, 'targeteval:targets')
  const metaOne = parseMetaJson<unknown>(html, 'targeteval:target')
  const raw = metaArr && Array.isArray(metaArr)
    ? metaArr.slice(0, 60)
    : metaOne ? [metaOne] : []
  return raw
    .map((e) => sanitizeMetaEntry(e as Partial<TargetMetaEntry>))
    .filter((x): x is Partial<TargetMetaEntry> => x != null)
    .map((e) => e as TargetMetaEntry)
}

/** v2.72：区段标题里的 accession（已识别靶点 — meta 对齐校验/acc 通道用） */
function titleAcc(inner: string): string | undefined {
  const m = UNIPROT_ACC_RE.exec(inner)
  return m ? m[0].toUpperCase() : undefined
}

/**
 * v2.72：meta 条目 ↔ 解析区段对齐。
 *  - 数量一致时按索引对齐（合并报告的 meta 与内嵌页同序；单靶点报告各 1）；
 *    索引对齐先做 acc 一致性校验（meta.uniprot 与区段题目 acc 冲突 → 放弃对齐，
 *    防某区段解析失败造成的整体错位）；
 *  - 数量不一致（个别区段解析失败/封面区段被跳过）时退化为 acc 匹配对齐。
 */
function alignMetaToSections(sections: ImportedStatsSection[], meta: TargetMetaEntry[]): void {
  if (!meta.length || !sections.length) return
  const titleAccs = sections.map(s => (s.uniprotId ? String(s.uniprotId).toUpperCase() : undefined))
  const byIndex = meta.length === sections.length
  if (byIndex) {
    // acc 校验：双方已知的 acc 必须全部一致（任一冲突 = 索引错位 → 放弃）
    for (let i = 0; i < meta.length; i++) {
      const mu = meta[i]!.uniprot
      const su = titleAccs[i]
      if (mu && su && mu !== su) return
    }
    for (let i = 0; i < meta.length; i++) attachMeta(sections[i]!, meta[i]!)
    return
  }
  // acc 匹配对齐（无 acc 的区段不获 meta — 长度/SHA 通道兜底）
  const usedMeta = new Set<number>()
  for (const s of sections) {
    if (!s.uniprotId) continue
    const idx = meta.findIndex((m, i) => !usedMeta.has(i) && m.uniprot === String(s.uniprotId).toUpperCase())
    if (idx >= 0) {
      usedMeta.add(idx)
      attachMeta(s, meta[idx]!)
    }
  }
}

function attachMeta(s: ImportedStatsSection, m: TargetMetaEntry): void {
  if (m.seqSha) s.seqSha = m.seqSha
  if (m.seqLength != null) s.metaSeqLength = m.seqLength
  if (m.header) s.metaHeader = m.header
  if (m.label) s.metaLabel = m.label
}

/**
 * 解析一份报告 HTML 内全部靶点区段的统计快照。
 *
 * 报告由本系统生成，结构稳定：每个靶点子页一个 <h1 class="rpt-title"> 锚点，
 * 区段内含刊头 meta-grid（蛋白名称/物种/序列长度/结构证据）+ 核心结论速览
 * （glance-score 总分 + 已有结构/结构覆盖率 tile）+ 评分卡（X-ray/Cryo-EM/NMR
 * score-row）。合并报告的封面区段无评分卡 → 自然跳过；单靶点报告 = 唯一区段。
 *
 * 解析失败的区段（旧版报告结构变化/被改动）返回缺项 — 调用方降级为「载入」
 * 降级行，不影响导入匹配本身。v2.70：超长文本前缀解析（不再整单放弃）。
 * v2.72：附带 meta 标记对齐（见 alignMetaToSections）。
 */
export function extractImportedStatsSections(html: string): ImportedStatsSection[] {
  if (!html) return []
  const capped = html.length > PARSE_MAX_CHARS ? html.slice(0, PARSE_MAX_CHARS) : html
  const h1s: Array<{ title: string; at: number }> = []
  H1_TITLE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = H1_TITLE_RE.exec(capped))) h1s.push({ title: m[1].trim(), at: m.index })
  if (h1s.length === 0) return []
  const sections: ImportedStatsSection[] = []
  for (let i = 0; i < h1s.length; i++) {
    const from = h1s[i].at
    const to = i + 1 < h1s.length ? h1s[i + 1].at : Math.min(capped.length, from + 2_000_000)
    const sec = capped.slice(from, to)
    const s = parseStatsSection(h1s[i].title, sec)
    if (s) sections.push(s)
  }
  if (sections.length > 0) alignMetaToSections(sections, parseImportedTargetMeta(capped))
  return sections
}

/** 单区段解析（题目 + 区段 HTML → 统计快照；无任何评分证据 → null） */
function parseStatsSection(title: string, sec: string): ImportedStatsSection | null {
  // ── 身份：题目「NAME（P12345 · 残基 X-Y）」/「NAME（序列靶点 · …）」──
  const shape = /^([^（]+)（([^）]*)）$/.exec(title)
  const name = shape?.[1]?.trim()
  const inner = shape?.[2] ?? ''
  const accM = UNIPROT_ACC_RE.exec(inner)
  const uniprotId = accM ? accM[0].toUpperCase() : undefined
  const rangeM = /残基\s*(\d{1,5})\s*[-–]\s*(\d{1,5})/.exec(inner)
  const range = rangeM && Number(rangeM[1]) >= 1 && Number(rangeM[2]) >= Number(rangeM[1])
    ? [Number(rangeM[1]), Number(rangeM[2])] as [number, number]
    : undefined
  const hasIdentitySuffix = /(?:UniProt 匹配|nr 识别)\s*\d+(?:\.\d+)?\s*%/.test(inner)
  const alignedSpan = range && !hasIdentitySuffix ? range[1] - range[0] + 1 : undefined

  // ── 评分：glance 速览总分（v1.28+）+ 评分卡四行（X-ray 结晶 / Cryo-EM / NMR / 综合评估）──
  const glanceScore = /<div class="glance-score"[^>]*>\s*(\d+(?:\.\d+)?)\s*<span/.exec(sec)
  const rowRe = /<div class="score-row[^"]*">[\s\S]*?<div class="score-label">([^<]+)<\/div>[\s\S]*?<div class="score-num">(\d+(?:\.\d+)?)/g
  const methodScores: Partial<Record<'xray' | 'cryoem' | 'nmr' | 'overall', number>> = {}
  let rm: RegExpExecArray | null
  while ((rm = rowRe.exec(sec))) {
    const label = rm[1]!
    const val = Math.round(Number(rm[2]))
    if (!Number.isFinite(val) || val < 0 || val > 10) continue
    if (/X-ray/.test(label)) methodScores.xray = val
    else if (/Cryo/i.test(label)) methodScores.cryoem = val
    else if (/NMR/.test(label)) methodScores.nmr = val
    else if (/综合/.test(label)) methodScores.overall = val
  }
  const overall = glanceScore ? Math.round(Number(glanceScore[1])) : methodScores.overall
  if (overall == null || !Number.isFinite(overall)) return null // 封面/无评分区段（合并报告封面）

  // ── 刊头 meta-grid：蛋白名称 / 物种 / 序列长度 / 结构证据计数 ──
  const metaVal = (label: string): string | undefined => {
    // 注意：new RegExp 的模板串里 \\s 才是空白符（\s 会被字符串求值吞掉反斜杠）
    const mm = new RegExp(`<div><b>${label}<\\/b>([\\s\\S]*?)</div>`, 'i').exec(sec)
    return mm ? stripTags(mm[1]).trim() : undefined
  }
  const proteinName = metaVal('蛋白名称') || (name && name !== '序列靶点评估' ? name : undefined)
  const organism = metaVal('物种')
  const seqLenM = /序列长度<\/b>\s*(\d{2,5})\s*aa/.exec(sec)
  const seqLength = seqLenM ? Number(seqLenM[1]) : undefined
  const evidenceM = /结构证据<\/b>[\s\S]*?直接结构\s*(\d+)(?:\s*\/\s*检索命中\s*(\d+))?[\s\S]*?同源\s*(\d+)\s*个[\s\S]*?文献\s*(\d+)\s*篇/.exec(sec)
  const pdbCount = evidenceM ? Number(evidenceM[1]) : 0
  const blastHitCount = evidenceM ? Number(evidenceM[3]) : 0
  const literatureCount = evidenceM ? Number(evidenceM[4]) : 0

  // ── 速览 tile：已有结构（方法计数 + 最佳分辨率）+ 结构覆盖率 ──
  let methodXrayCount = 0
  let methodCryoemCount = 0
  let methodNmrCount = 0
  let bestResolution: number | null = null
  const structTileM = /<div class="gt-label">已有结构<\/div><div class="gt-value">([\s\S]*?)<\/div>(?:<div class="gt-sub">([\s\S]*?)<\/div>)?/.exec(sec)
  if (structTileM) {
    const sub = structTileM[2] ?? ''
    const xM = /X-ray\s*(\d+)/.exec(sub)
    const cM = /Cryo-EM\s*(\d+)/.exec(sub)
    const nM = /NMR\s*(\d+)/.exec(sub)
    if (xM) methodXrayCount = Number(xM[1])
    if (cM) methodCryoemCount = Number(cM[1])
    if (nM) methodNmrCount = Number(nM[1])
    const rM = /最佳\s*(\d+(?:\.\d+)?)\s*[ÅÅ]/.exec(sub)
    if (rM) bestResolution = Number(rM[1])
  }
  const covM = /<div class="gt-label">结构覆盖率<\/div><div class="gt-value">(\d+(?:\.\d+)?)%/.exec(sec)
  const coverage = covM ? Math.round(Number(covM[1])) : 0

  return {
    overall,
    xray: methodScores.xray ?? 0,
    cryoem: methodScores.cryoem ?? 0,
    nmr: methodScores.nmr ?? 0,
    pdbCount,
    blastHitCount,
    literatureCount,
    methodXrayCount,
    methodCryoemCount,
    methodNmrCount,
    bestResolution,
    coverage,
    ...(proteinName ? { proteinName: proteinName.slice(0, 80) } : {}),
    ...(organism && organism !== '—' ? { organism: organism.slice(0, 80) } : {}),
    ...(uniprotId ? { uniprotId } : {}),
    ...(range ? { range } : {}),
    ...(seqLength ? { seqLength } : {}),
    alignedSpan,
  }
}

/** 定位目标描述（pickImportedStats 入参 — 与 ImportEnrichItem 同构） */
export interface ImportedStatsPickTarget {
  acc?: string
  range?: [number, number]
  length?: number
  /** v2.72：提交序列 SHA-256 前 16 hex（权威定位通道 — 调用方计算） */
  seqSha?: string
  /** v2.72：运行侧标签（同长歧义时的标签消歧） */
  label?: string
}

/**
 * 区段 → 靶点定位（多靶点合并报告内选对子页；单区段直接命中）。
 * 规则与导入匹配同口径：UniProt accession +（区间已知时）严格相等；
 * 序列靶点按提交长度（含全同比对跨度）唯一命中 — 歧义时不解析（降级行）。
 * v2.72 定位链增强：①提交序列 SHA 精确（报告 meta 权威值 — 已识别序列靶点
 * 的刊头长度是 UniProt 全长，长度通道对不上）②容差 ±3 aa（归属比对少量
 * indel）③同长歧义时按归一化标签消歧（meta label/header vs 目标标签）。
 */
export function pickImportedStats(
  sections: ImportedStatsSection[],
  t: ImportedStatsPickTarget,
): ImportedStatsSection | undefined {
  if (sections.length === 0) return undefined
  if (sections.length === 1) return sections[0]
  // ① SHA 精确（v2.45+ 报告 meta 携带提交序列 SHA — 同序列即同靶点）
  if (t.seqSha) {
    const bySha = sections.filter(s => s.seqSha === t.seqSha)
    if (bySha.length >= 1) return bySha[0]
  }
  if (t.acc) {
    const byAcc = sections.filter((s) => s.uniprotId && s.uniprotId.toUpperCase() === t.acc!.toUpperCase())
    if (byAcc.length === 1) return byAcc[0]
    const byRange = byAcc.filter((s) => s.range && t.range && s.range[0] === t.range[0] && s.range[1] === t.range[1])
    return byRange.length >= 1 ? byRange[0] : undefined
  }
  // ③ 长度精确：候选 = meta 提交长度 > 刊头长度 > 全同跨度 > 区间跨度（全部并列
  //  考虑 — 与旧版「刊头或跨度任一相等即命中」同口径；已识别靶点刊头为 UniProt
  //  全长，meta 提交长度/区间跨度才是提交口径）
  const lenCands = (s: ImportedStatsSection): number[] => {
    const out: number[] = []
    if (s.metaSeqLength != null) out.push(s.metaSeqLength)
    if (s.seqLength != null) out.push(s.seqLength)
    if (s.alignedSpan != null) out.push(s.alignedSpan)
    if (s.range != null) out.push(s.range[1] - s.range[0] + 1)
    return out
  }
  const byLen = sections.filter((s) => t.length != null && lenCands(s).includes(t.length))
  if (byLen.length === 1) return byLen[0]
  // ④ 容差 ±3 aa（归属比对的少量 indel — 唯一命中才取）
  if (t.length != null) {
    const near = sections.filter((s) => lenCands(s).some(l => Math.abs(l - t.length!) <= 3))
    if (near.length === 1) return near[0]
  }
  // ⑤ 同长歧义 → 归一化标签消歧（meta label/header vs 目标标签/表头）
  if (byLen.length > 1) {
    const keys = [t.label].filter(Boolean).map(x => normLabel(String(x)))
    if (keys.length) {
      const byLab = byLen.filter(s => {
        const cands = [s.metaLabel, s.metaHeader].filter(Boolean).map(x => normLabel(String(x)))
        return cands.some(c => keys.some(k => k && (c === k || c.startsWith(k) || k.startsWith(c))))
      })
      if (byLab.length === 1) return byLab[0]
    }
  }
  return undefined
}

/** 剥离内部定位字段的干净快照（持久化/载荷用 — 只保留 ImportedReportStats 字段） */
export function toCleanImportedStats(s: ImportedStatsSection): ImportedReportStats {
  const { alignedSpan: _a, seqSha: _b, metaSeqLength: _c, metaHeader: _d, metaLabel: _e, ...clean } = s
  return clean
}
