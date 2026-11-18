/**
 * 高通量评估 — Excel/CSV 靶点表解析（v2.23；v2.23.1 修订）。
 *
 * 链路：workbook（SheetJS）→ 有界文本化（保留 sheet/行/列结构）→ LLM 语义提取
 * 「靶点分组」（组内多靶点 = 复合物批量评估；单靶点 = 独立评估）→ 校验消毒。
 * LLM 不可用 / 超时 / 输出不合法时回退规则提取：
 *  - 组号/分组/批次/复合物列识别（值分组，跨行合并同组）
 *  - 无分组列时同一数据行的靶点归为一组（逐行成组）
 *
 * v2.23.1 修订（用户实测 102 行清单只识别 40 组 · 50 靶点的三处根因）：
 *  ① 提取输出组上限 40 → 300（用户百行级清单全量识别）
 *  ② LLM 文本化新增「长单元格折叠」— 序列列动辄数 KB，旧实现 60KB 文本预算
 *    被序列撑爆后 LLM 只能看到前十几行；现 >200 字符单元格折叠为
 *    「前 60 字符 + [已折叠 N 字符]」，102 行全量可见
 *  ③ 序列兜底（新增）：行内无任何 UniProt ID 但存在序列（≥90 aa 构建序列，
 *     支持 [标签头] SEQ 多构段与裸序列）→ seqGroups 按序列评估（独立作业）
 *
 * 内存有界：sheet/行/列/文本均设上限，输出 ≤ 300 组 × 30 靶点 + 序列靶点
 * 总字符 ≤ 240KB（localStorage 运行历史防膨胀）。
 *
 * v2.27 截短构建感知：
 *  - 行内解析「构建区间」（UniProt 列括号注释「P0DTD1 (nsp12, 4393-5324)」/
 *    构建列「SLC30A1 (M1-L507 end)」/标签头「His-TEV-NTRC-83-548」）→
 *    groupRanges（与 groups 对齐）；HtSeqTarget 附 range。区间交给作业的
 *    options.range（v1.23 过滤链路 — 仅保留链范围重叠的结构）。
 *  - 去重键 accession → accession|区间：聚蛋白片段（P0DTD1 的 nsp12/nsp2）
 *    此前被全局去重合并为一；现各自成独立靶点。
 *  - LLM 路径：区间由规则扫描确定性回填（按表内出现顺序出队）；LLM 全局去重
 *    合掉的「带区间」实例补为独立单靶点组（防漏检）。
 *
 * v2.29 结构域名提示：评估表不写区间而写域名（「P51685 (CCR8 胞外域)」/
 *  「EGFR kinase domain」/「跨膜区」）→ groupDomainHints（与 groups 逐位对齐）；
 * 作业携带 options.rangeHint，管线取得 UniProt features 后由 domain-range.ts
 * 匹配 domain 划分推导评估区间（层级：手动区间 > 构建比对 > 域名匹配）。已带数值
 * 区间的靶点不扫域名（区间证据更强）。LLM 路径域名同样由规则扫描确定性回填。
 */
import * as XLSX from 'xlsx'
import { llmChat } from './llm'
import { scanRowTargets, type HtRowTarget } from './construct-range'
import type { ResidueRange } from './range-filter'

/** 上传文件体积上限（与前端 HighThroughputPanel 的客户端预校验一致） */
export const HT_EXCEL_MAX_BYTES = 10 * 1024 * 1024

/** 解析上限：sheet 数 / 每 sheet 行数 / 列数 / 文本化字符数 */
const MAX_SHEETS = 8
const MAX_ROWS_PER_SHEET = 400
const MAX_COLS_PER_ROW = 32
const MAX_TABLE_TEXT_CHARS = 80_000

/** v2.23.1：提取输出上限（40 → 300 — 百行级靶点清单全量识别） */
const MAX_GROUPS = 300
const MAX_TARGETS_PER_GROUP = 30
/** 序列兜底：行内序列识别最小长度（aa）— 构建序列均远超此值，可滤除载体名/编号等噪音 */
const MIN_SEQ_AA = 90
/** 序列兜底：全部序列靶点总字符上限（响应体积 + localStorage 运行历史防膨胀） */
const MAX_SEQ_TOTAL_CHARS = 240_000

/** UniProt accession 语法（与 components/eval/format.ts 同源；服务端本地定义避免引客户端模块） */
const UNIPROT_SOURCE =
  '(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9][A-Z][A-Z0-9]{2}[0-9])(?:[A-Z0-9]{3}[0-9])?(?:-[0-9]+)?'

function isValidUniprotId(value: string): boolean {
  return new RegExp(`^${UNIPROT_SOURCE}$`, 'i').test(value.trim())
}

/** 单元格是否含 UniProt accession */
function cellHasUniprotId(cell: string): boolean {
  if (!cell) return false
  return new RegExp(UNIPROT_SOURCE, 'i').test(cell)
}

/** 组语义列名识别（组号/组别/分组/批次/batch/group/complex/复合物）；排除靶点/ accession 列自身。
 *  v2.27 修订：排除「构建/组分」列（表头「构建 / 组分（复合物同行）」含「复合物」曾
 *  被误判为分组列 → 构建列被跳过扫描、区间丢失；首行为表头的表此前就会漏掉构建列内的 accession）。 */
const GROUP_COL_RE = /(组号|组别|组名|分组|批次|批号|batch|group|complex|复合物)/i
const GROUP_COL_EXCLUDE_RE = /(靶点|uniprot|accession|target|蛋白|序列|sequence|构建|组分|construct|build)/i

export interface HtSheetRows {
  name: string
  rows: string[][]
}

export interface HtWorkbookText {
  sheets: HtSheetRows[]
  sheetCount: number
  /** 保留进结构的非空行总数（含表头行） */
  rowCount: number
  /** 任一上限触顶（sheet/行/列/文本）为 true — 提示用户内容过大 */
  truncated: boolean
  /** 全部 sheet 拼接的文本化表示（LLM 输入；行 = 换行，列 = 「|」；长单元格已折叠） */
  text: string
}

/** v2.23.1：长单元格折叠 — 序列列动辄数 KB，直接进文本会撑爆 LLM 预算 */
const CELL_ELIDE_THRESHOLD = 200
const CELL_ELIDE_KEEP = 60
function elideCell(cell: string): string {
  if (cell.length <= CELL_ELIDE_THRESHOLD) return cell
  return `${cell.slice(0, CELL_ELIDE_KEEP)}…[已折叠${cell.length}字符]`
}

/**
 * workbook → 结构化行 + 文本化。损坏文件抛错（路由层转 422 人话提示）。
 */
export function parseHtWorkbook(buffer: Buffer): HtWorkbookText {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false })
  const sheetNames = wb.SheetNames ?? []
  const sheets: HtSheetRows[] = []
  let truncated = sheetNames.length > MAX_SHEETS
  let rowCount = 0
  const textParts: string[] = []

  for (const name of sheetNames.slice(0, MAX_SHEETS)) {
    const ws = wb.Sheets[name]
    if (!ws) continue
    const aoa = (XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' }) as unknown[][]) ?? []
    const rows: string[][] = []
    let sheetTruncated = aoa.length > MAX_ROWS_PER_SHEET
    for (let i = 0; i < aoa.length && rows.length < MAX_ROWS_PER_SHEET; i++) {
      const raw = Array.isArray(aoa[i]) ? aoa[i] : []
      if (raw.length > MAX_COLS_PER_ROW) sheetTruncated = true
      const cells = raw.slice(0, MAX_COLS_PER_ROW).map((c) => (c == null ? '' : String(c).trim()))
      if (cells.every((c) => c === '')) continue
      rows.push(cells)
    }
    if (rows.length === 0) continue
    rowCount += rows.length
    truncated = truncated || sheetTruncated
    sheets.push({ name, rows })
    textParts.push(`【Sheet：${name}】`)
    for (const row of rows) textParts.push(row.map(elideCell).join(' | '))
  }

  let text = textParts.join('\n')
  if (text.length > MAX_TABLE_TEXT_CHARS) {
    text = text.slice(0, MAX_TABLE_TEXT_CHARS)
    truncated = true
  }
  return { sheets, sheetCount: sheetNames.length, rowCount, truncated, text }
}

/** 序列兜底靶点（Excel 行缺 UniProt ID 时按序列评估） */
export interface HtSeqTarget {
  /** 构建标签头（如「His-TEV-NTRC-83-548」；裸序列为空串） */
  header: string
  /** 清洗后的氨基酸序列（大写、去非字母） */
  seq: string
  length: number
  /** v2.27：行内构建区间（UniProt 编号；序列靶点 UniProt 归属后用于结构范围过滤） */
  range?: ResidueRange
}

export interface HtExtractedGroups {
  /** 分组结果：每组 = 一次复合物批量评估或单靶点独立评估（UniProt 靶点） */
  groups: string[][]
  /** v2.27：与 groups 逐组逐位对齐的评估区间（无则 undefined = 不过滤；
   *  来自 UniProt 列括号注释 / 构建列 / 序列标签头的截短区间） */
  groupRanges: Array<Array<ResidueRange | undefined>>
  /** v2.29：与 groups 逐组逐位对齐的结构域名提示（如「胞外域」/「kinase domain」；
   *  无则 undefined — 管线内与 UniProt domain 划分匹配推导区间；仅无数值区间的靶点携带） */
  groupDomainHints: Array<Array<string | undefined>>
  /** 序列兜底组：行内无 UniProt 但有构建序列 → 每行一组，组内每条序列独立评估 */
  seqGroups: HtSeqTarget[][]
  /** LLM 提取出但不符合 UniProt 编号规则的 token（前端提示用） */
  invalid: string[]
  source: 'llm' | 'regex'
  note?: string
}

const SYSTEM = `你是一位蛋白靶点评估平台的表格解析专家。用户给你一份从 Excel/CSV 靶点表提取的文本（保留 sheet、行、列结构，「|」分隔列；过长的单元格已被折叠为「前缀…[已折叠N字符]」），请提取「高通量评估」所需的靶点分组。
严格输出一个 JSON 对象，不要输出任何其他文字、解释或 Markdown 代码块标记：
{ "groups": [["P04637","P00533"], ["O14746"]] }
分组规则：
1. 靶点只认 UniProt accession：6 位（如 P04637、Q9Y6K9）或 10 位（如 A0A8G0KJC2），可带 isoform 后缀（如 P04637-2）；基因名、蛋白名称、物种、PDB ID、描述文字都不是靶点，一律忽略（UniProt ID 列常见形如「P51685 (CCR8); P62873 (GNB1)」— 括号注释内的基因名不要提取）。
2. 一组 = 一次复合物批量评估：表中同一行内的多个靶点、或同一「组号/分组/批次/复合物」列值下的多个靶点，归为同一组；仅含一个靶点的组 = 单靶点独立评估。
3. 表内存在组号/批次/复合物类列时，以其列值分组（值相同的行合并为一组）；没有分组列时，同一数据行的靶点归为一组，逐行成组。
4. 同一 accession 只保留首次出现（严格去重）；禁止编造表中不存在的 ID；保持表中出现顺序。
5. 最多输出 300 组、每组 ≤ 30 个靶点（超出部分丢弃，不要为保持数量而拆分或合并）。`

/** 解析容错：抽取首个 JSON 对象（容忍 ```json 包裹与前后杂讯） */
function extractJson(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```json/gi, '```').replace(/```/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return null
  }
}

/** LLM 输出消毒：跨组去重保序 + accession 校验（不合规 token 归 invalid）+ 上限截断 */
function sanitizeGroups(v: unknown): { groups: string[][]; invalid: string[]; capped: boolean } {
  const groups: string[][] = []
  const invalid: string[] = []
  const seen = new Set<string>()
  let capped = false
  if (!v || typeof v !== 'object' || !Array.isArray((v as { groups?: unknown }).groups)) {
    return { groups, invalid, capped }
  }
  for (const g of (v as { groups: unknown[] }).groups) {
    if (!Array.isArray(g)) continue
    if (groups.length >= MAX_GROUPS) {
      capped = true
      break
    }
    const ids: string[] = []
    for (const t of g) {
      if (typeof t !== 'string') continue
      const id = t.trim().toUpperCase()
      if (!id) continue
      if (seen.has(id)) continue
      seen.add(id)
      if (isValidUniprotId(id)) {
        if (ids.length >= MAX_TARGETS_PER_GROUP) {
          capped = true
          break
        }
        ids.push(id)
      } else if (!invalid.includes(id)) {
        invalid.push(id.slice(0, 40))
      }
    }
    if (ids.length > 0) groups.push(ids)
  }
  return { groups, invalid, capped }
}

// ─── v2.23.1 序列兜底：行内构建序列提取 ─────────────────────────────────────

/** 拆「[标签头] 序列 [标签头] 序列 …」构段；无括号的裸文本返回单段（header=''） */
function splitBracketSegments(cell: string): Array<{ header: string; body: string }> {
  const segs: Array<{ header: string; body: string }> = []
  let header: string | null = null // null = 首个「[」之前（无归属，忽略）
  let cursor = 0
  for (;;) {
    const open = cell.indexOf('[', cursor)
    if (open < 0) {
      const body = cell.slice(cursor)
      if (header !== null && body.trim()) segs.push({ header, body })
      break
    }
    const body = cell.slice(cursor, open)
    if (header !== null && body.trim()) segs.push({ header, body })
    const close = cell.indexOf(']', open + 1)
    if (close < 0) break // 不成对括号：其后内容无法归属，放弃
    header = cell.slice(open + 1, close).trim().slice(0, 120)
    cursor = close + 1
  }
  return segs
}

/**
 * 从一行单元格中提取构建序列（≥ MIN_SEQ_AA aa）：
 *  - 含「[标签头]」结构：逐构段提取（标签头作为 sequenceHeader 命名证据）
 *  - 裸序列单元格：字母占比 ≥ 0.7 且长度达标才收（滤除载体名/编号/描述文本）
 */
function extractRowSequences(row: string[], seen: Set<string>): HtSeqTarget[] {
  const out: HtSeqTarget[] = []
  const push = (header: string, raw: string) => {
    const seq = raw.toUpperCase().replace(/[^A-Z]/g, '')
    if (seq.length < MIN_SEQ_AA || seen.has(seq)) return
    seen.add(seq)
    out.push({ header: header.trim().slice(0, 120), seq, length: seq.length })
  }
  for (const cell of row) {
    if (!cell || cell.length < MIN_SEQ_AA) continue
    if (cell.includes('[') && cell.includes(']')) {
      for (const seg of splitBracketSegments(cell)) push(seg.header, seg.body)
    } else {
      const letters = cell.replace(/[^A-Za-z]/g, '').length
      const nonSpace = cell.replace(/\s/g, '').length
      if (letters >= MIN_SEQ_AA && nonSpace > 0 && letters / nonSpace >= 0.7) push('', cell)
    }
  }
  return out
}

/** 行内靶点（含区间）→ 分组去重键（accession|区间；v2.27：聚蛋白不同片段不再合并） */
function rowTargetKey(t: HtRowTarget): string {
  return t.range ? `${t.acc}|${t.range[0]}-${t.range[1]}` : t.acc
}

/** v2.27：全表确定性靶点实例扫描（行序；acc|区间 去重）— LLM 分组的区间/域名回填 + 漏检补充 */
function scanSheetInstances(sheets: HtSheetRows[]): HtRowTarget[] {
  const out: HtRowTarget[] = []
  const seen = new Set<string>()
  for (const sheet of sheets) {
    const rows = sheet.rows
    if (rows.length === 0) continue
    let dataStart = 0
    const first = rows[0]
    if (first.some((c) => c !== '') && !first.some((c) => cellHasUniprotId(c))) dataStart = 1
    for (let r = dataStart; r < rows.length; r++) {
      for (const t of scanRowTargets(rows[r]).targets) {
        const key = rowTargetKey(t)
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ acc: t.acc, range: t.range, domainHint: t.domainHint })
      }
    }
  }
  return out
}

/**
 * 规则兜底分组（LLM 不可用 / 超时 / 输出不合法时）：
 *  - 表头行识别：首个无 accession 的非空行视为表头（无表头则从首行起全为数据）
 *  - 组列识别：表头匹配「组号/分组/批次/batch/group/complex/复合物」的列（排除靶点/accession 列）
 *  - 有组列 → 同值行合并一组；无组列 → 同一行内的靶点归一组（逐行成组）
 *  - 单元格内多 ID（P04637/P00533、分号、空格、加号分隔）均拆出（v2.27：结构化解析 — 括号注释里的区间保留）
 *  - v2.23.1 序列兜底：行内无 UniProt 但有构建序列 → 该行归入 seqGroups（每行一组）
 *  - v2.27：去重键 accession|区间；行内区间数与序列数一致时 1:1 附到序列靶点
 */
export function fallbackHtGroups(sheets: HtSheetRows[]): {
  groups: string[][]
  groupRanges: Array<Array<ResidueRange | undefined>>
  groupDomainHints: Array<Array<string | undefined>>
  seqGroups: HtSeqTarget[][]
} {
  const groups: string[][] = []
  const groupRanges: Array<Array<ResidueRange | undefined>> = []
  const groupDomainHints: Array<Array<string | undefined>> = []
  const seqGroups: HtSeqTarget[][] = []
  const seenKeys = new Set<string>()
  const seenSeqs = new Set<string>()
  let seqChars = 0
  for (const sheet of sheets) {
    const rows = sheet.rows
    if (rows.length === 0) continue

    let dataStart = 0
    const first = rows[0]
    const firstIsHeader = first.some((c) => c !== '') && !first.some((c) => cellHasUniprotId(c))
    if (firstIsHeader) dataStart = 1

    let groupCol = -1
    if (firstIsHeader) {
      for (let i = 0; i < first.length; i++) {
        const h = first[i] ?? ''
        if (h && GROUP_COL_RE.test(h) && !GROUP_COL_EXCLUDE_RE.test(h)) {
          groupCol = i
          break
        }
      }
    }

    const byKey = new Map<string, { ids: string[]; ranges: Array<ResidueRange | undefined>; hints: Array<string | undefined> }>()
    for (let r = dataStart; r < rows.length; r++) {
      const row = rows[r]
      // v2.27：分组列单元格不参与靶点/区间扫描（沿用原口径）
      const scanRow = groupCol >= 0 ? row.map((c, ci) => (ci === groupCol ? '' : c)) : row
      const scan = scanRowTargets(scanRow)
      const ids: string[] = []
      const ranges: Array<ResidueRange | undefined> = []
      const hints: Array<string | undefined> = []
      for (const t of scan.targets) {
        const key = rowTargetKey(t)
        if (seenKeys.has(key)) continue
        seenKeys.add(key)
        ids.push(t.acc)
        ranges.push(t.range)
        hints.push(t.domainHint)
      }
      if (ids.length > 0) {
        const key = groupCol >= 0 ? ((row[groupCol] ?? '').trim() || `#${r}`) : `#${r}`
        const bucket = byKey.get(key)
        if (bucket) {
          for (let i = 0; i < ids.length; i++) {
            bucket.ids.push(ids[i])
            bucket.ranges.push(ranges[i])
            bucket.hints.push(hints[i])
          }
        } else {
          byKey.set(key, {
            ids: ids.slice(0, MAX_TARGETS_PER_GROUP),
            ranges: ranges.slice(0, MAX_TARGETS_PER_GROUP),
            hints: hints.slice(0, MAX_TARGETS_PER_GROUP),
          })
        }
        continue
      }
      // 序列兜底：本行无任何 UniProt ID — 尝试提取构建序列（≥90 aa）
      const seqs = extractRowSequences(row, seenSeqs)
      // v2.27：行内构建区间与序列数一致时 1:1 附到序列靶点（UniProt 归属后区间过滤）
      if (seqs.length > 0 && scan.seqRanges.length === seqs.length) {
        for (let i = 0; i < seqs.length; i++) seqs[i].range = scan.seqRanges[i]
      }
      if (seqs.length > 0 && seqGroups.length < MAX_GROUPS) {
        const budget = MAX_SEQ_TOTAL_CHARS - seqChars
        if (budget > MIN_SEQ_AA) {
          const capped: HtSeqTarget[] = []
          for (const s of seqs) {
            if (seqChars + s.length > MAX_SEQ_TOTAL_CHARS || capped.length >= MAX_TARGETS_PER_GROUP) break
            capped.push(s)
            seqChars += s.length
          }
          if (capped.length > 0) seqGroups.push(capped)
        }
      }
    }
    for (const bucket of byKey.values()) {
      if (groups.length >= MAX_GROUPS) break
      groups.push(bucket.ids)
      groupRanges.push(bucket.ranges)
      groupDomainHints.push(bucket.hints)
    }
  }
  return { groups, groupRanges, groupDomainHints, seqGroups }
}

/**
 * Excel 分组提取入口。quick=true 跳过 LLM 直接规则提取（回归/兜底通道）。
 * LLM 失败/超时（signal abort）/输出不合法均静默回退规则结果，不抛错。
 * seqGroups（行缺 UniProt 的序列兜底）始终由规则确定提取 — 与 LLM 分组正交
 * （无 accession 的行不会出现在 LLM 分组里，两边无冲突）。
 *
 * v2.27：LLM 分组的区间由规则扫描确定性回填 —
 *  - 每组内 accession 按表内出现顺序从「acc → 实例队列」出队取区间；
 *  - LLM 全局去重（同 accession 只留首次）合掉的「带区间」实例（如聚蛋白
 *    nsp12/nsp2 两个 P0DTD1 片段）补为独立单靶点组 — 不依赖 LLM 遵守新规则。
 */
export async function extractHtGroups(
  wb: HtWorkbookText,
  opts: { quick?: boolean; signal?: AbortSignal } = {},
): Promise<HtExtractedGroups> {
  if (wb.rowCount === 0 || !wb.text.trim()) {
    return { groups: [], groupRanges: [], groupDomainHints: [], seqGroups: [], invalid: [], source: 'regex', note: '表格内容为空' }
  }
  if (opts.quick) {
    const fb = fallbackHtGroups(wb.sheets)
    return {
      groups: fb.groups,
      groupRanges: fb.groupRanges,
      groupDomainHints: fb.groupDomainHints,
      seqGroups: fb.seqGroups,
      invalid: [],
      source: 'regex',
      note: '已返回规则提取结果（快速兜底模式）',
    }
  }

  const prompt =
    `靶点表内容如下（Excel 提取文本，行 = 换行，列 = 「|」分隔；长单元格已折叠）：\n\n` +
    `━━━━━━━━━━ 表格内容 ━━━━━━━━━━\n${wb.text.slice(0, MAX_TABLE_TEXT_CHARS)}\n━━━━━━━━━━ 内容结束 ━━━━━━━━━━\n\n` +
    `请按系统指令输出 JSON。`

  const r = await llmChat(prompt, SYSTEM, opts.signal)
  if (!r.ok) {
    const fb = fallbackHtGroups(wb.sheets)
    return {
      groups: fb.groups,
      groupRanges: fb.groupRanges,
      groupDomainHints: fb.groupDomainHints,
      seqGroups: fb.seqGroups,
      invalid: [],
      source: 'regex',
      note: r.error ? `LLM 不可用（${r.error}），已返回规则提取结果` : 'LLM 不可用，已返回规则提取结果',
    }
  }
  const obj = extractJson(r.text)
  if (!obj) {
    const fb = fallbackHtGroups(wb.sheets)
    return {
      groups: fb.groups,
      groupRanges: fb.groupRanges,
      groupDomainHints: fb.groupDomainHints,
      seqGroups: fb.seqGroups,
      invalid: [],
      source: 'regex',
      note: 'AI 输出无法解析为 JSON，已返回规则提取结果',
    }
  }
  const { groups, invalid, capped } = sanitizeGroups(obj)
  if (groups.length === 0) {
    const fb = fallbackHtGroups(wb.sheets)
    return { groups: fb.groups, groupRanges: fb.groupRanges, groupDomainHints: fb.groupDomainHints, seqGroups: fb.seqGroups, invalid, source: 'regex', note: 'AI 未识别到有效靶点，已返回规则提取结果' }
  }

  // ── v2.27/v2.29 区间/域名确定性回填：acc → 行序实例队列；LLM 组内出现序出队。
  // 区间与域名从同一实例一次读出（两次独立出队会把第 2 个实例的提示错配给第 1 组）──
  const instances = scanSheetInstances(wb.sheets)
  const byAcc = new Map<string, HtRowTarget[]>()
  for (const inst of instances) {
    const q = byAcc.get(inst.acc)
    if (q) q.push(inst)
    else byAcc.set(inst.acc, [inst])
  }
  const consumed = new Set<HtRowTarget>()
  const groupRanges: Array<Array<ResidueRange | undefined>> = []
  const groupDomainHints: Array<Array<string | undefined>> = []
  for (const g of groups) {
    const ranges: Array<ResidueRange | undefined> = []
    const hints: Array<string | undefined> = []
    for (const acc of g) {
      const q = byAcc.get(acc)
      const inst = q && q.length > 0 ? q.shift() : undefined
      if (inst) consumed.add(inst)
      ranges.push(inst?.range)
      hints.push(inst?.domainHint)
    }
    groupRanges.push(ranges)
    groupDomainHints.push(hints)
  }
  // LLM 全局去重合掉的「带区间」实例（聚蛋白片段等）→ 补为独立单靶点组
  let appended = 0
  for (const inst of instances) {
    if (consumed.has(inst) || !inst.range) continue
    if (groups.length >= MAX_GROUPS) break
    groups.push([inst.acc])
    groupRanges.push([inst.range])
    groupDomainHints.push([inst.domainHint])
    appended++
  }

  const out: HtExtractedGroups = {
    groups,
    invalid,
    groupRanges,
    groupDomainHints,
    seqGroups: fallbackHtGroups(wb.sheets).seqGroups,
    source: 'llm',
  }
  const notes: string[] = []
  if (capped) notes.push('提取结果已按上限截断（≤ 300 组 · 每组 ≤ 30 靶点）')
  if (appended > 0) notes.push(`已按行内区间补充 ${appended} 个被全局去重合并的靶点实例（如聚蛋白不同片段）`)
  if (notes.length > 0) out.note = notes.join('；')
  return out
}
