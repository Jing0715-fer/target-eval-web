/**
 * 高通量评估 — Excel/CSV 靶点表解析（v2.23）。
 *
 * 链路：workbook（SheetJS）→ 有界文本化（保留 sheet/行/列结构）→ LLM 语义提取
 * 「靶点分组」（组内多靶点 = 复合物批量评估；单靶点 = 独立评估）→ 校验消毒。
 * LLM 不可用 / 超时 / 输出不合法时回退规则提取：
 *  - 组号/分组/批次/复合物列识别（值分组，跨行合并同组）
 *  - 无分组列时同一数据行的靶点归为一组（逐行成组）
 * 内存有界：sheet/行/列/文本均设上限，输出 ≤ 40 组 × 30 靶点。
 */
import * as XLSX from 'xlsx'
import { llmChat } from './llm'

/** 上传文件体积上限（与前端 HighThroughputPanel 的客户端预校验一致） */
export const HT_EXCEL_MAX_BYTES = 10 * 1024 * 1024

/** 解析上限：sheet 数 / 每 sheet 行数 / 列数 / 文本化字符数 */
const MAX_SHEETS = 8
const MAX_ROWS_PER_SHEET = 400
const MAX_COLS_PER_ROW = 32
const MAX_TABLE_TEXT_CHARS = 60_000

/** 提取输出上限（前端单次运行另有 MAX_HT_* 运行上限，此处为响应体积防线） */
const MAX_GROUPS = 40
const MAX_TARGETS_PER_GROUP = 30

/** UniProt accession 语法（与 components/eval/format.ts 同源；服务端本地定义避免引客户端模块） */
const UNIPROT_SOURCE =
  '(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9][A-Z][A-Z0-9]{2}[0-9])(?:[A-Z0-9]{3}[0-9])?(?:-[0-9]+)?'

function isValidUniprotId(value: string): boolean {
  return new RegExp(`^${UNIPROT_SOURCE}$`, 'i').test(value.trim())
}

/** 单元格是否含 UniProt accession（无 lastIndex 状态污染的临时实例） */
function cellHasUniprotId(cell: string): boolean {
  if (!cell) return false
  return new RegExp(UNIPROT_SOURCE, 'i').test(cell)
}

/** 组语义列名识别（组号/组别/分组/批次/batch/group/complex/复合物）；排除靶点/ accession 列自身 */
const GROUP_COL_RE = /(组号|组别|组名|分组|批次|批号|batch|group|complex|复合物)/i
const GROUP_COL_EXCLUDE_RE = /(靶点|uniprot|accession|target|蛋白|序列|sequence)/i

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
  /** 全部 sheet 拼接的文本化表示（LLM 输入；行 = 换行，列 = 「|」） */
  text: string
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
    for (const row of rows) textParts.push(row.join(' | '))
  }

  let text = textParts.join('\n')
  if (text.length > MAX_TABLE_TEXT_CHARS) {
    text = text.slice(0, MAX_TABLE_TEXT_CHARS)
    truncated = true
  }
  return { sheets, sheetCount: sheetNames.length, rowCount, truncated, text }
}

export interface HtExtractedGroups {
  /** 分组结果：每组 = 一次复合物批量评估或单靶点独立评估 */
  groups: string[][]
  /** LLM 提取出但不符合 UniProt 编号规则的 token（前端提示用） */
  invalid: string[]
  source: 'llm' | 'regex'
  note?: string
}

const SYSTEM = `你是一位蛋白靶点评估平台的表格解析专家。用户给你一份从 Excel/CSV 靶点表提取的文本（保留 sheet、行、列结构，「|」分隔列），请提取「高通量评估」所需的靶点分组。
严格输出一个 JSON 对象，不要输出任何其他文字、解释或 Markdown 代码块标记：
{ "groups": [["P04637","P00533"], ["O14746"]] }
分组规则：
1. 靶点只认 UniProt accession：6 位（如 P04637、Q9Y6K9）或 10 位（如 A0A8G0KJC2），可带 isoform 后缀（如 P04637-2）；基因名、蛋白名称、物种、描述文字都不是靶点，一律忽略。
2. 一组 = 一次复合物批量评估：表中同一行内的多个靶点、或同一「组号/分组/批次/复合物」列值下的多个靶点，归为同一组；仅含一个靶点的组 = 单靶点独立评估。
3. 表内存在组号/批次/复合物类列时，以其列值分组（值相同的行合并为一组）；没有分组列时，同一数据行的靶点归为一组，逐行成组。
4. 同一 accession 只保留首次出现（严格去重）；禁止编造表中不存在的 ID；保持表中出现顺序。
5. 最多输出 40 组、每组 ≤ 30 个靶点（超出部分丢弃）。`

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

/**
 * 规则兜底分组（LLM 不可用 / 超时 / 输出不合法时）：
 *  - 表头行识别：首个无 accession 的非空行视为表头（无表头则从首行起全为数据）
 *  - 组列识别：表头匹配「组号/分组/批次/batch/group/complex/复合物」的列（排除靶点/accession 列）
 *  - 有组列 → 同值行合并一组；无组列 → 同一行内的靶点归一组（逐行成组）
 *  - 单元格内多 ID（P04637/P00533、分号、空格、加号分隔）均拆出
 */
export function fallbackHtGroups(sheets: HtSheetRows[]): { groups: string[][]; invalid: string[] } {
  const groups: string[][] = []
  const seen = new Set<string>()
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

    const byKey = new Map<string, string[]>()
    for (let r = dataStart; r < rows.length; r++) {
      const row = rows[r]
      const ids: string[] = []
      for (let c = 0; c < row.length; c++) {
        if (groupCol >= 0 && c === groupCol) continue
        const cell = row[c] ?? ''
        if (!cell) continue
        const tokens = cell.split(/[\s,，;；、/|+]+/).map((t) => t.trim().toUpperCase()).filter(Boolean)
        for (const t of tokens) {
          if (seen.has(t) || !isValidUniprotId(t)) continue
          seen.add(t)
          ids.push(t)
        }
      }
      if (ids.length === 0) continue
      const key = groupCol >= 0 ? ((row[groupCol] ?? '').trim() || `#${r}`) : `#${r}`
      const bucket = byKey.get(key)
      if (bucket) {
        for (const id of ids) if (!bucket.includes(id)) bucket.push(id)
      } else {
        byKey.set(key, ids.slice(0, MAX_TARGETS_PER_GROUP))
      }
    }
    for (const ids of byKey.values()) {
      if (groups.length >= MAX_GROUPS) break
      groups.push(ids)
    }
  }
  return { groups, invalid: [] }
}

/**
 * Excel 分组提取入口。quick=true 跳过 LLM 直接规则提取（回归/兜底通道）。
 * LLM 失败/超时（signal abort）/输出不合法均静默回退规则结果，不抛错。
 */
export async function extractHtGroups(
  wb: HtWorkbookText,
  opts: { quick?: boolean; signal?: AbortSignal } = {},
): Promise<HtExtractedGroups> {
  if (wb.rowCount === 0 || !wb.text.trim()) {
    return { groups: [], invalid: [], source: 'regex', note: '表格内容为空' }
  }
  if (opts.quick) {
    return { ...fallbackHtGroups(wb.sheets), source: 'regex', note: '已返回规则提取结果（快速兜底模式）' }
  }

  const prompt =
    `靶点表内容如下（Excel 提取文本，行 = 换行，列 = 「|」分隔）：\n\n` +
    `━━━━━━━━━━ 表格内容 ━━━━━━━━━━\n${wb.text.slice(0, MAX_TABLE_TEXT_CHARS)}\n━━━━━━━━━━ 内容结束 ━━━━━━━━━━\n\n` +
    `请按系统指令输出 JSON。`

  const r = await llmChat(prompt, SYSTEM, opts.signal)
  if (!r.ok) {
    return {
      ...fallbackHtGroups(wb.sheets),
      source: 'regex',
      note: r.error ? `LLM 不可用（${r.error}），已返回规则提取结果` : 'LLM 不可用，已返回规则提取结果',
    }
  }
  const obj = extractJson(r.text)
  if (!obj) {
    return { ...fallbackHtGroups(wb.sheets), source: 'regex', note: 'AI 输出无法解析为 JSON，已返回规则提取结果' }
  }
  const { groups, invalid, capped } = sanitizeGroups(obj)
  if (groups.length === 0) {
    return { ...fallbackHtGroups(wb.sheets), source: 'regex', note: 'AI 未识别到有效靶点，已返回规则提取结果' }
  }
  const out: HtExtractedGroups = { groups, invalid, source: 'llm' }
  if (capped) out.note = '提取结果已按上限截断（≤ 40 组 · 每组 ≤ 30 靶点）'
  return out
}
