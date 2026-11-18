/**
 * 构建区间解析（v2.27）— 从靶点表单元格文本中提取「截短构建的残基区间」。
 *
 * 用户诉求（第三批自研清单实测）：聚蛋白片段（P0DTD1 的 nsp12 4393-5324 / nsp2
 * 181-818）与截短构建（STAT1 M1-R683、NTRC 83-548、SLC30A1 M1-L507 等）此前
 * 被当作全长靶点评估：按 accession 检索会列出该 UniProt 名下所有 PDB（聚蛋白
 * 名下即全部新冠结构），大量与关注区间无关。本模块把区间从表格文本中解析出来，
 * 交给既有 range-filter（v1.23）完成「仅保留链范围（UniProt 编号）重叠的结构」。
 *
 * 区间来源分层（优先级从高到低）：
 *  ① UniProt 列括号注释（如「P0DTD1 (nsp12, 4393-5324)」）— UniProt 编号，权威；
 *  ② 构建/组分列与序列标签头中的「构建名-区间」对（如「His-TEV-NTRC-83-548」、
 *     「SLC30A1 (M1-L507 end)」）— 构建名与 UniProt 注释里的蛋白名配对；
 *  ③ 行内唯一靶点 + 存在构建区间 → 取首个（无注释可配时）；
 *  ④ 靶点数与区间数相等且全无区间 → 按出现顺序配对。
 *
 * v2.29 结构域名提示（domainHint）：评估表常不写区间而写域名（「P51685 (CCR8 胞外域)」
 * /「EGFR kinase domain」「跨膜区」）。本模块把域名 token 扫描出来随靶点携带，管线取得
 * UniProt features 后由 domain-range.ts 匹配推导区间（手动区间 > 构建比对 > 域名匹配
 * 三层级里墵垫底）。域名扫描与区间扫描同源同列（非 UniProt 单元格 ≤400 字符 + 括号注释），
 * 配对分层亦同构（括号注释 → 行内计数配对）；已有数值区间的靶点不再扫域名（区间证据更强）。
 *
 * 误配防护：区间形态边界守卫（区间首字符前不得是字母/数字、尾数后不得紧跟数字）
 * —— 防 accession 自带 isoform 段「P12345-12」被当成「45-12」，防标签/克隆号段
 * 「SLC10A1-3C」「CD1-H5243」中间夹的数字被当区间；仅数字-数字 / 字母前缀 / aa
 * 前缀三类形态；无区间证据的靶点不强行配（过滤缺省保留，宁缺勿错）。
 */
import type { ResidueRange } from './range-filter'

/** UniProt accession 语法（与 ht-excel.ts 同源副本 — 避免循环依赖） */
const UNIPROT_SOURCE =
  '(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9][A-Z][A-Z0-9]{2}[0-9])(?:[A-Z0-9]{3}[0-9])?(?:-[0-9]+)?'
const UNIPROT_ACC_G = new RegExp(UNIPROT_SOURCE, 'gi')

/** 单元格是否含 UniProt accession */
function cellHasUniprotId(cell: string): boolean {
  if (!cell) return false
  return new RegExp(UNIPROT_SOURCE, 'i').test(cell)
}

export interface HtRowTarget {
  acc: string
  /** 截短构建区间（UniProt 残基编号，1-based 闭区间；无则不过滤） */
  range?: ResidueRange
  /** v2.29：结构域名提示（如 ectodomain / 胞外域 / kinase domain — 管线内与
   * UniProt domain 划分匹配推导评估区间；已带数值区间时不扫域名） */
  domainHint?: string
}

export interface BuildRange {
  range: ResidueRange
  /** 构建名 token（区间紧邻前的蛋白名，如 NTRC / SLC30A1；用于与 UniProt 注释配对） */
  owner: string
}

export interface UniprotCellEntry {
  acc: string
  /** accession 后的括号注释（如「nsp12, 4393-5324」「NTRC, 烟草」） */
  note: string
}

// ─── 区间形态（三类；边界守卫见文件头）──────────────────────────────────────

function pickRange(m: RegExpExecArray, si: number, ei: number): ResidueRange | null {
  const s = Number(m[si])
  const e = Number(m[ei])
  if (!Number.isFinite(s) || !Number.isFinite(e)) return null
  if (s < 1 || e < s || e > 100000) return null
  return [s, e]
}

interface RangePattern {
  src: string
  flags: string
  /** 捕获组 → 区间（返回 null = 形态不合法） */
  pick: (m: RegExpExecArray) => ResidueRange | null
}

const RANGE_PATTERNS: RangePattern[] = [
  // aa64-742（SV2AΔ64 类 aa 前缀）
  { src: '(?:^|[^0-9A-Za-z])[aA][aA](\\d{1,5})\\s*[-–]\\s*(\\d{1,5})(?![0-9])', flags: '', pick: m => pickRange(m, 1, 2) },
  // S2-E748 / M1-L507 / R22-R421（字母前缀 author numbering）
  { src: '(?:^|[^0-9A-Za-z])([A-Za-z])(\\d{1,5})\\s*[-–]\\s*([A-Za-z])(\\d{1,5})(?![0-9])', flags: '', pick: m => pickRange(m, 2, 4) },
  // 83-548 / 4393-5324 / 23-234（纯数字）
  { src: '(?:^|[^0-9A-Za-z])(\\d{1,5})\\s*[-–]\\s*(\\d{1,5})(?![0-9])', flags: '', pick: m => pickRange(m, 1, 2) },
]

/** 从一段文本解析首个残基区间（无则 null） */
export function parseResidueRange(text: string): ResidueRange | null {
  if (!text) return null
  for (const p of RANGE_PATTERNS) {
    const m = new RegExp(p.src, p.flags).exec(text)
    if (m) {
      const r = p.pick(m)
      if (r) return r
    }
  }
  return null
}

/** 区间紧邻前的构建名 token（如「His-TEV-NTRC-83-548」→ ntrc；空 = 无法判定） */
function rangeOwner(text: string, index: number): string {
  const prefix = text.slice(0, index).replace(/[-–(（,，;；:、\s]+$/u, '')
  const m = /([A-Za-z0-9]+)$/.exec(prefix)
  return (m?.[1] ?? '').toLowerCase()
}

/** 扫描一段构建文本的全部区间 + 所属构建名（(owner, range) 去重） */
export function scanBuildRanges(text: string): BuildRange[] {
  const out: BuildRange[] = []
  if (!text) return out
  const seen = new Set<string>()
  for (const p of RANGE_PATTERNS) {
    const re = new RegExp(p.src, p.flags.includes('g') ? p.flags : p.flags + 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      const r = p.pick(m)
      if (r) {
        const owner = rangeOwner(text, m.index)
        const key = `${owner}|${r[0]}-${r[1]}`
        if (!seen.has(key)) {
          seen.add(key)
          out.push({ range: r, owner })
        }
      }
      if (m.index === re.lastIndex) re.lastIndex++ // 防零宽死循环（防御性）
    }
  }
  return out
}

// ─── v2.29 结构域名提示扫描 ───────────────────────────────────────────────

/** 域名提及模式：英文「X domain / X-domain」（X = 前缀词，如 TM/kinase/SH2）+
 *  无 domain 后缀的独立别名词（ectodomain/ECD/ICD）；中文「X结构域/X域/X区」
 * （token 剥掉后缀 — 别名匹配兼容裸词，见 domain-range.ts ALIAS_RULES） */
const DOMAIN_MENTION_PATTERNS: RegExp[] = [
  /\b([A-Za-z][A-Za-z0-9/-]{0,24}(?:\s+[A-Za-z][A-Za-z0-9/-]{0,24}){0,2})\s+domain\b/i,
  /\b([A-Za-z][A-Za-z0-9/-]{0,24})-domain\b/i,
  /\b(ectodomain|ecd|icd)\b/i,
  /([\u4e00-\u9fa5A-Za-z0-9]{1,16}?)(?:结构域|区域|域|区)/u,
]

/** 扫描文本中的结构域名 token（去重保序，≤4 个；返回原始 token） */
export function scanDomainMentions(text: string): string[] {
  if (!text) return []
  const out: string[] = []
  for (const re of DOMAIN_MENTION_PATTERNS) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
    let m: RegExpExecArray | null
    while ((m = g.exec(text))) {
      const tok = (m[1] ?? '').trim()
      if (tok && tok.length >= 2 && !out.includes(tok)) out.push(tok)
      if (out.length >= 4) return out
      if (m.index === g.lastIndex) g.lastIndex++
    }
  }
  return out
}

// ─── UniProt 列单元格解析 ─────────────────────────────────────────────────────

/** 括号注释首个内容（不含括号） */
function firstParenNote(text: string): string {
  const m = /[(（]([^)）]{0,120})[)）]/.exec(text)
  return m ? m[1].trim() : ''
}

/**
 * 解析 UniProt 列单元格 → accession + 括号注释列表。
 * 分段：分号/换行；段内多个 accession（「A / B」「A B」）共享段内首个括号注释。
 */
export function parseUniprotCell(cell: string): UniprotCellEntry[] {
  const out: UniprotCellEntry[] = []
  if (!cell) return out
  for (const part of cell.split(/[;；\n]+/)) {
    if (!part.trim()) continue
    const matches = [...part.matchAll(UNIPROT_ACC_G)]
    if (matches.length === 0) continue
    for (let i = 0; i < matches.length; i++) {
      const accEnd = (matches[i].index ?? 0) + matches[i][0].length
      const nextStart = i + 1 < matches.length ? (matches[i + 1].index ?? part.length) : part.length
      // 注释：本 accession 与下一个之间的括号 → 段尾的括号（斜杠组共享）
      const note = firstParenNote(part.slice(accEnd, nextStart)) || firstParenNote(part.slice(accEnd))
      out.push({ acc: matches[i][0].toUpperCase(), note })
    }
  }
  return out
}

/** 注释里的蛋白名 token（小写归一；滤纯数字）— 供构建名配对 */
function noteTokens(note: string): string[] {
  if (!note) return []
  const out: string[] = []
  for (const m of note.matchAll(/[A-Za-z0-9][A-Za-z0-9_-]{1,30}/g)) {
    const t = m[0]
    if (/^\d+$/.test(t.replace(/[^0-9]/g, '')) && /^\d[\d-]*$/.test(t)) continue
    out.push(t.toLowerCase())
  }
  return out
}

/** 归一 token（小写 + 去非字母数字） */
function normToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** 大单元格的 [标签头] 提取（序列列构段头 — 构建名/区间证据；不取序列本体） */
function bracketHeaders(cell: string): string[] {
  if (!cell.includes('[')) return []
  const out: string[] = []
  let m: RegExpExecArray | null
  const re = /\[([^\[\]]{1,120})\]/g
  while ((m = re.exec(cell))) out.push(m[1])
  return out
}

/** 构建列/标签头扫描的单元格长度上限（超过 = 序列本体，只扫其标签头） */
const BUILD_SCAN_CELL_MAX = 400

export interface RowScanResult {
  /** 行内 UniProt 靶点（含区间；序 = 单元格出现序；行内 acc|区间去重） */
  targets: HtRowTarget[]
  /** 行内全部构建区间（owner 去重后；供无 UniProt 行的序列靶点 1:1 配对） */
  seqRanges: ResidueRange[]
}

/**
 * 扫描一行靶点表 → 每个靶点的截短区间（分层配对见文件头）。
 * 输入行为「已剔除分组列单元格」的行（分组值不参与靶点/区间扫描）。
 */
export function scanRowTargets(row: string[]): RowScanResult {
  const entries: UniprotCellEntry[] = []
  for (const cell of row) {
    if (!cell || !cellHasUniprotId(cell)) continue
    entries.push(...parseUniprotCell(cell))
  }
  const buildRanges: BuildRange[] = []
  const seenBuild = new Set<string>()
  const addBuild = (text: string) => {
    for (const b of scanBuildRanges(text)) {
      const key = `${b.owner}|${b.range[0]}-${b.range[1]}`
      if (seenBuild.has(key)) continue
      seenBuild.add(key)
      buildRanges.push(b)
    }
  }
  for (const cell of row) {
    if (!cell || cellHasUniprotId(cell)) continue
    if (cell.length <= BUILD_SCAN_CELL_MAX) {
      addBuild(cell)
    } else {
      for (const h of bracketHeaders(cell)) addBuild(h)
    }
  }
  // v2.29：行内结构域名 token（与构建区间同列同源；供无区间靶点配对）
  const rowHints: string[] = []
  for (const cell of row) {
    if (!cell || cellHasUniprotId(cell)) continue
    const text = cell.length <= BUILD_SCAN_CELL_MAX ? cell : bracketHeaders(cell).join(' ')
    for (const h of scanDomainMentions(text)) {
      if (!rowHints.includes(h)) rowHints.push(h)
    }
  }
  // ① Tier 1：UniProt 注释区间（UniProt 编号，权威）
  const targets: HtRowTarget[] = entries.map(e => ({
    acc: e.acc,
    range: e.note ? parseResidueRange(e.note) ?? undefined : undefined,
  }))
  // ② Tier 2：构建名 ↔ 注释蛋白名配对
  const byOwnerNorm = new Map<string, BuildRange>()
  for (const b of buildRanges) {
    const k = normToken(b.owner)
    if (k && !byOwnerNorm.has(k)) byOwnerNorm.set(k, b)
  }
  for (let i = 0; i < targets.length; i++) {
    if (targets[i].range) continue
    const note = entries[i]?.note ?? ''
    for (const tok of noteTokens(note)) {
      const b = byOwnerNorm.get(normToken(tok))
      if (b) {
        targets[i].range = b.range
        break
      }
    }
  }
  // ③ Tier 3：行内唯一靶点 + 存在构建区间 → 取首个（无注释可配时）
  // ④ Tier 4：靶点数 = 区间数且全无区间 → 顺序配对（复合物多组分构建各带区间）
  const lacking = targets.filter(t => !t.range).length
  if (targets.length === 1 && lacking === 1 && buildRanges.length > 0) {
    targets[0].range = buildRanges[0].range
  } else if (lacking === targets.length && targets.length >= 2 && buildRanges.length === targets.length) {
    for (let i = 0; i < targets.length; i++) targets[i].range = buildRanges[i].range
  }
  // v2.29 结构域名提示配对（仅无区间靶点）：① 括号注释自带域名（如「P51685 (CCR8 胞外域)」）
  // → ② 行内唯一无区间靶点取首个 → ③ 靶点数 = 域名数且全无提示时顺序配对。
  // 已带数值区间的靶点不扫域名（区间证据更强 — 域名匹配仅在无区间时生效垫底）
  for (let i = 0; i < targets.length; i++) {
    if (targets[i].range) continue
    const noteHint = scanDomainMentions(entries[i]?.note ?? '')[0]
    if (noteHint) targets[i].domainHint = noteHint
  }
  const lackingHint = targets.filter(t => !t.range && !t.domainHint).length
  if (targets.length === 1 && lackingHint === 1 && rowHints.length > 0) {
    targets[0].domainHint = rowHints[0]
  } else if (lackingHint === targets.length && targets.length >= 2 && rowHints.length === targets.length) {
    for (let i = 0; i < targets.length; i++) targets[i].domainHint = rowHints[i]
  }
  // 行内去重（acc|区间 — 同格重复/注释与备注双写）
  const seen = new Set<string>()
  const uniq = targets.filter(t => {
    const key = t.range ? `${t.acc}|${t.range[0]}-${t.range[1]}` : t.acc
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return { targets: uniq, seqRanges: buildRanges.map(b => b.range) }
}
