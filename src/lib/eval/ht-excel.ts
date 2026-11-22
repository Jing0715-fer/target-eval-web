/**
 * 高通量评估 — Excel/CSV 靶点表解析（v2.23 → v2.34）。
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
 *
 * v2.34 结构交付清单行级语义（用户实测 179 行清单只识别 127 序列的根因修订）：
 *  - 根因：旧兜底把整行序列单元格当「一条序列」且跨行全局去重 — 同序列的
 *    .cif/.pdb 双行、复测行整行蒸发（179 → 127）；同源多聚体的多拷贝链与
 *    Fab 的 VH/VL 链也全部计入。
 *  - 新口径（仅序列兜底分支；UniProt 分组行为不变）：
 *    ① 逐行成组：每个数据行 = 1 个靶点组（同一行的多个靶点作为同一组），
 *       不再跨行去重 — 179 行 → 179 组（除非该行无任何可评估靶点序列）；
 *    ② FASTA 链级解析：「>chain A\nSEQ;>chain B\nSEQ…」结构交付表序列列
 *       按链拆分（≥40 aa；短肽/标签段丢弃），每条独立链 = 组内一个靶点；
 *    ③ 抗体链忽略：链级 detectAntibody（v2.34 强化基序 — Fab/VHH 可变域
 *       片段也能识别）命中的链不计入靶点（不参与计数与评估）；
 *    ④ 同源多聚体只计 1 条：行内 6-mer 包含度 ≥0.55 的链视为同一蛋白的
 *       不同拷贝/可及区（保留最长），IL17A vs IL17F 等异源同族不受影响；
 *    ⑤ 行标签命名：取行内首个非序列单元格（结构交付表 = 文件路径）剥目录与
 *       扩展名作为靶点名（多靶点行附「·链N」），报告/预览可读。
 *  - 纯抗体行（全部链均为抗体，如 Fab+短肽抗原交付）无可评估靶点 → 跳过并在
 *    note 中列明行号与原因（不静默丢行）。
 *
 * v2.35 跨行去重（用户诉求：跨行如果所有链都是相同的或高度同源的序列 >95%，
 *  应并为一组 — 同一样本的 .cif/.pdb 双格式、复测、重命名、重精修交付不重复计数）：
 *  - 行链组 vs 已保留代表组：链数相等 + 每条链都能以 ≥95% 一致率配对（贪心
 *    完美匹配）→ 并入代表组，不再另成组、不占字符预算；首个交付行为代表；
 *  - 链级判定三闸门：长度比 ≥0.85（片段 vs 全长不算重复 — 截短构建语义保留）
 *    → 8-mer 包含度 ≥0.45 预滤 → 半全局比对（seq-compare.pairwiseChainIdentity，
 *    v2.35 新增精确 NW — compareSequences 锚定/k-mer 兜底对同长近同源链对失准：
 *    实测 WT/Delta 棘突 ~99% 一致被估为 76）一致率 ≥95 且双链对齐覆盖 ≥0.8
 *    （防共享结构域/融合蛋白假合并）；
 *  - 实测 179 行清单：176 可评估行 → 91 行为重复交付（并入），85 个去重组；
 *    WT/Delta 棘突家族（96.5%）合并，Omicron 家族（与 Delta 91.8% <95）独立；
 *  - 统计与 note 携带跨行合并数与并入明细（行号 + 标签 → 代表组）。
 *
 * v2.37 序列靶点区间改由 BLAST 后推导（用户实测：很多序列被错误附上「2022-2024」
 *  评估区间 — 行内年份写法「2022-2024 流行株」被数字-数字形态扫成残基区间，
 *  又按 v2.27 的「行内区间数 = 序列数时 1:1 配对」附到序列靶点，作为最高优先级
 *  的「手动区间」压过了管线内构建比对/BLAST nr 推导，作业按 3 残基截短分流）：
 *  - 序列兜底靶点不再携带 Excel 行文本扫描出的区间（1:1 配对逻辑移除）—
 *    区间一律由作业管线在 UniProt 归属/BLAST 后推导（构建比对种子链锚定 →
 *    BLAST nr HSP 比对坐标，见 pipeline effectiveRange 层级）；
 *  - construct-range.ts 同步增加年份区间守卫（两端均在 1900-2099 且跨度 ≤60 的
 *    纯数字区间不作为残基区间 — UniProt 注释/构建列各层一并设防）。
 */
import * as XLSX from 'xlsx'
import { llmChat } from './llm'
import { scanRowTargets, type HtRowTarget } from './construct-range'
import { detectAntibody } from './antibody'
import { pairwiseChainIdentity } from './seq-compare'
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
/** v2.34：FASTA 链段最小长度（结构交付表「>chain」段为显式链，可信度高；
 *  40 aa 兼容小蛋白结构域（Gγ ≈ 65 aa、IL17F 可及区 87 aa 等），滤除短肽/标签段 */
const FASTA_CHAIN_MIN_AA = 40
/** v2.34：行内同源合并阈值 — 短链 6-mer 出现在长链中的比例 ≥ 此值视为同一蛋白
 *  的不同拷贝/可及区（保留最长）。异源同族蛋白（IL17A vs IL17F ≈ 50% 一致）
 *  的 6-mer 包含度通常 < 0.1，不会误合并。 */
const HOMOLOG_KMER = 6
const HOMOLOG_CONTAINMENT = 0.55
/** v2.35 跨行去重闸门 — 链长比（短/长）：构建边界差异（253/283 RBD 等）可容，
 *  片段 vs 全长（RBD vs 全长棘突 ≈0.23）不算重复（截短构建语义保留） */
const CROSS_ROW_MIN_LEN_RATIO = 0.85
/** v2.35 跨行去重闸门 — 对齐一致率 ≥95%（用户口径「相同或高度同源 >95%」） */
const CROSS_ROW_MIN_IDENTITY = 95
/** v2.35 跨行去重闸门 — 双链参与对齐残基比例（防共享结构域/融合蛋白假合并） */
const CROSS_ROW_MIN_COVERAGE = 0.8
/** v2.35 预滤：8-mer 包含度（≥95% 同源的同长链对 ≈0.6+；0.45 留 indel/边界差余量） */
const CROSS_ROW_KMER = 8
const CROSS_ROW_PREFILTER = 0.45
/** v2.35 半全局比对总单元预算（实测 179 行清单 368 对 295M 单元 ≈1.8s；超出后
 *  剩余链对按不可比处理 = 保守不并组，防极端大表拖死导入） */
const CROSS_ROW_ALIGN_CELL_BUDGET = 400_000_000
/** v2.35 note 明细记录上限（防超大表 note 膨胀；计数不受限） */
const CROSS_ROW_NOTE_ROWS = 30
/** 序列兜底：全部序列靶点总字符上限（响应体积 + localStorage 运行历史防膨胀；
 *  v2.34 行级语义下不再跨行去重，240K → 400K 实测 179 行清单 ≈ 95K） */
const MAX_SEQ_TOTAL_CHARS = 400_000

// ─── v2.36 原始表内容（汇总报告 master 表格的「原 Excel 行」列）────────────────

/** 原始行的紧凑快照（序列折叠为长度标记；标签 = 行首非序列单元格） */
export interface HtExcelRowSnapshot {
  /** 行标签（与 deriveRowLabel 同源 — 结构交付表 = 文件名；用于与评估条目 label 前缀匹配） */
  label: string
  /** 折叠后的行文本（非空单元格「|」连接；每格 ≤72 字符；序列格 → [序列 N aa]） */
  text: string
}

/** v2.65：序列样单元格判定 — 去空白后 ≥40 字符且 ≥95% 为氨基酸字母（含 U/X/B/Z）。
 *  汇总报告主表不再显示序列文本 — 序列格在提取端折叠为「[序列 N aa]」长度标记。 */
function isSequenceCell(t: string): boolean {
  const s = t.replace(/\s+/g, '')
  if (s.length < 40) return false
  let aa = 0
  for (let i = 0; i < s.length; i++) if ('ACDEFGHIKLMNPQRSTVWYBXZJU'.includes(s[i])) aa++
  return aa / s.length >= 0.95
}

/** v2.36：全部数据行 → 紧凑快照（汇总报告展示原始表内容；≤600 行、每行 ≤400 字符） */
export function buildExcelRowSnapshots(sheets: HtSheetRows[]): HtExcelRowSnapshot[] {
  const out: HtExcelRowSnapshot[] = []
  const snap = (cell: string): string => {
    const t = cell.trim()
    // v2.65：序列单元格折叠为长度标记（主表不显示序列 — 渲染端另有旧快照兜底折叠）
    if (isSequenceCell(t)) return `[序列 ${t.replace(/\s+/g, '').length} aa]`
    if (t.length <= 72) return t
    return `${t.slice(0, 56)}…[${t.length}]`
  }
  for (const sheet of sheets) {
    const rows = sheet.rows
    if (rows.length === 0) continue
    let dataStart = 0
    const first = rows[0]
    const firstIsHeader = first.some((c) => c !== '') && !first.some((c) => cellHasUniprotId(c))
    if (firstIsHeader) dataStart = 1
    for (let r = dataStart; r < rows.length; r++) {
      const row = rows[r]
      if (row.every((c) => !c)) continue
      const label = deriveRowLabel(row) || (row.find((c) => c) ?? '').slice(0, 40)
      const text = row.filter((c) => c).map(snap).join(' | ').slice(0, 400)
      if (text) out.push({ label, text })
      if (out.length >= 600) return out
    }
  }
  return out
}


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
  /** 构建标签头（如「His-TEV-NTRC-83-548」；v2.34 结构交付行为行标签「文件名·链N」） */
  header: string
  /** 清洗后的氨基酸序列（大写、去非字母） */
  seq: string
  length: number
  /** v2.27 行内构建区间 · v2.37 起不再填充（前端/接口兼容保留字段）：序列靶点的
   *  评估区间改由管线在 BLAST 归属后推导（构建比对 / BLAST nr HSP），不从
   *  Excel 行文本扫描配对 — 年份等噪音数字不再误入 options.range */
  range?: ResidueRange
}

/** v2.34：序列兜底统计（note / meta 展示「行→组」口径） */
export interface HtSeqFallbackInfo {
  /** 序列组数（v2.35：跨行去重后的去重组数；有效数据行数 = 组数 + crossRowMerged） */
  groups: number
  /** 被忽略的抗体链数 */
  antibodyChains: number
  /** 行内同源合并掉的链数（同源多聚体多拷贝） */
  homologMerged: number
  /** v2.35：跨行去重并入已保留组的行数（所有链 ≥95% 同源的重复交付行） */
  crossRowMerged: number
  /** v2.35：跨行去重并入明细（首 30 行 — note 展示；dupOf = 并入的代表组标签） */
  crossRowDupRows: Array<{ sheet: string; row: number; label: string; dupOf: string }>
  /** 无可评估靶点序列而被跳过的行（纯抗体 / 短肽行），sheet 内行号从 1 计 */
  skippedRows: Array<{ sheet: string; row: number; label: string; reason: 'antibody' | 'none' }>
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
  /** 序列兜底组：行内无 UniProt 但有构建序列 → v2.34 每行一组（组内 = 该行的
   *  非抗体、去同源合并后的靶点链），组内每条序列独立评估 */
  seqGroups: HtSeqTarget[][]
  /** v2.34：序列兜底统计（行→组、抗体忽略、同源合并、跳过行） */
  seqInfo?: HtSeqFallbackInfo
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

// ─── v2.34 序列兜底：链级提取（FASTA / 构基 / 裸文本）+ 抗体过滤 + 行内同源合并 ───

/** 拆「>chain A\nSEQ;>chain B\nSEQ …」FASTA 风格链段（结构交付表的序列列） */
function splitFastaChains(cell: string): Array<{ header: string; body: string }> {
  const segs: Array<{ header: string; body: string }> = []
  for (const part of cell.split(/(?=>)/)) {
    const m = part.match(/^>([^\n]*)\n?([\s\S]*)$/)
    if (!m) continue
    if (m[2].trim()) segs.push({ header: m[1].trim().slice(0, 40), body: m[2] })
  }
  return segs
}

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

function cleanAa(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z]/g, '')
}

interface RowChain {
  header: string
  seq: string
  origin: 'fasta' | 'bracket' | 'bare'
}

/**
 * 行内链收集（v2.34 链级化）：
 *  - 「>…」开头的 FASTA 链段单元格：逐链提取（≥40 aa — 显式链可信度高，兼容小结构域）
 *  - 「[标签头] SEQ」构段：逐构段提取（≥90 aa，标签头作为命名证据）
 *  - 裸序列单元格：字母占比 ≥ 0.7 且 ≥90 aa 才收（滤除载体名/编号/描述文本）
 */
function collectRowChains(row: string[]): RowChain[] {
  const out: RowChain[] = []
  for (const cell of row) {
    if (!cell) continue
    if (cell.trimStart().startsWith('>')) {
      for (const seg of splitFastaChains(cell)) {
        const seq = cleanAa(seg.body)
        if (seq.length >= FASTA_CHAIN_MIN_AA) out.push({ header: seg.header, seq, origin: 'fasta' })
      }
      continue
    }
    if (cell.length < MIN_SEQ_AA) continue
    if (cell.includes('[') && cell.includes(']')) {
      for (const seg of splitBracketSegments(cell)) {
        const seq = cleanAa(seg.body)
        if (seq.length >= MIN_SEQ_AA) out.push({ header: seg.header, seq, origin: 'bracket' })
      }
    } else {
      const letters = cell.replace(/[^A-Za-z]/g, '').length
      const nonSpace = cell.replace(/\s/g, '').length
      if (letters >= MIN_SEQ_AA && nonSpace > 0 && letters / nonSpace >= 0.7) {
        out.push({ header: '', seq: cleanAa(cell), origin: 'bare' })
      }
    }
  }
  return out
}

/** 序列 6-mer 集合（行内同源判定用） */
function seqKmers(seq: string, k = HOMOLOG_KMER): Set<string> {
  const s = new Set<string>()
  for (let i = 0; i + k <= seq.length; i++) s.add(seq.slice(i, i + k))
  return s
}

/** 包含度：short 的 k-mer 出现在 long 中的比例 */
function kmerContainment(short: Set<string>, long: Set<string>): number {
  if (short.size === 0) return 0
  let hit = 0
  for (const k of short) if (long.has(k)) hit++
  return hit / short.size
}

/** v2.34：行标签 — 行内首个非序列单元格（结构交付表 = 文件路径），剥目录与扩展名 */
function deriveRowLabel(row: string[]): string {
  for (const cell of row) {
    if (!cell || cell.trimStart().startsWith('>')) continue
    const letters = cell.replace(/[^A-Za-z]/g, '').length
    const nonSpace = cell.replace(/\s/g, '').length
    if (nonSpace > 0 && cell.length >= 80 && letters / nonSpace >= 0.7) continue // 序列样文本
    const base = cell.replace(/[\\/]+/g, '/').split('/').pop() ?? ''
    const label = base.replace(/\.(pdb|cif|mmcif|ent|csv|txt|fa|fasta)$/i, '').trim()
    if (label) return label.slice(0, 60)
  }
  return ''
}

/**
 * 行 → 序列靶点组（v2.34 行级语义）：
 *  ① 链级收集（FASTA ≥40 aa / 构基与裸序列 ≥90 aa）
 *  ② 抗体链忽略（detectAntibody — Fab/VHH 可变域也识别）
 *  ③ 行内同源合并（同源多聚体只计 1 条，保留最长 = 可及区最完整）
 *  ④ 命名：FASTA/裸序列 → 行标签（多靶点附「·链N」）；构基标签头保留原语义
 */
function extractRowSeqTargets(
  row: string[],
  rowLabel: string,
  stats: HtSeqFallbackInfo,
): HtSeqTarget[] {
  const chains = collectRowChains(row)
  const targets = chains.filter((c) => {
    if (detectAntibody(c.seq, c.header).isAntibody) {
      stats.antibodyChains += 1
      return false
    }
    return true
  })
  if (targets.length === 0) return []
  const sorted = [...targets].sort((a, b) => b.seq.length - a.seq.length)
  const kept: Array<RowChain & { kmers: Set<string> }> = []
  for (const t of sorted) {
    const kmers = seqKmers(t.seq)
    if (kept.some((k) => kmerContainment(kmers, k.kmers) >= HOMOLOG_CONTAINMENT)) {
      stats.homologMerged += 1
      continue
    }
    kept.push({ ...t, kmers })
  }
  return kept.map((k, i) => ({
    header:
      k.origin === 'bracket' && k.header
        ? k.header
        : rowLabel
          ? kept.length > 1
            ? `${rowLabel}·链${i + 1}`
            : rowLabel
          : k.header || `序列${i + 1}`,
    seq: k.seq,
    length: k.seq.length,
  }))
}

/** 行内靶点（含区间）→ 分组去重键（accession|区间；v2.27：聚蛋白不同片段不再合并） */
function rowTargetKey(t: HtRowTarget): string {
  return t.range ? `${t.acc}|${t.range[0]}-${t.range[1]}` : t.acc
}

/**
 * v2.35 跨行去重器：行链组与已保留代表组的「完全同源」判定。
 *
 * 用户口径：同一行的多个靶点 = 同一组（v2.34）；跨行如果所有链都是相同的或
 * 高度同源（>95%）的序列 → 同一靶点组（同一样本的 .cif/.pdb 双格式、复测、
 * 重命名、重精修交付不再重复计数）。判定 = 链数相等 + 贪心完美匹配（每条链
 * 都能与代表组的一条未用链以 ≥95% 一致率配对）。
 *
 * 链级三闸门（见文件头 v2.35 说明）：长度比 ≥0.85 → 8-mer 包含度 ≥0.45 预滤
 * → 半全局比对一致率 ≥95 且双链覆盖 ≥0.8。结果按链对（去重序列注册 ID）
 * 全局缓存；比对单元总量超预算后保守不并组。
 */
class CrossRowDedup {
  private reps: Array<{ label: string; chains: string[] }> = []
  private chainKmers = new Map<string, Set<string>>()
  private chainIds = new Map<string, number>()
  private pairCache = new Map<number, number | null>()
  private cellsUsed = 0

  /** 行链组与某已保留组完全同源 → 返回并入的代表组标签；否则 null（新组） */
  matchRow(chains: string[]): string | null {
    if (this.reps.length === 0 || chains.length === 0) return null
    // 长链优先贪心配对：长链候选少、限制强，先锁死可降低后续链的误配风险
    const ordered = [...chains].sort((x, y) => y.length - x.length)
    for (const rep of this.reps) {
      if (rep.chains.length !== ordered.length) continue
      const used = new Array(rep.chains.length).fill(false)
      let matched = true
      for (const c of ordered) {
        let best = -1
        let bestId = -1
        for (let j = 0; j < rep.chains.length; j++) {
          if (used[j]) continue
          const id = this.chainIdentity(c, rep.chains[j]!)
          if (id != null && id > bestId) {
            bestId = id
            best = j
          }
        }
        if (best < 0 || bestId < CROSS_ROW_MIN_IDENTITY) {
          matched = false
          break
        }
        used[best] = true
      }
      if (matched) return rep.label
    }
    return null
  }

  /** 登记新代表组（仅实际产出评估组的行 — 去重口径与评估内容一致） */
  addRep(chains: string[], label: string) {
    if (this.reps.length >= MAX_GROUPS) return
    this.reps.push({ label, chains: chains.slice() })
  }

  /** 链对可比一致率（0-100；null = 长度比/预滤/覆盖/预算不过 — 不可并组） */
  private chainIdentity(a: string, b: string): number | null {
    if (a === b) return 100
    const key = this.pairKey(a, b)
    const cached = this.pairCache.get(key)
    if (cached !== undefined) return cached
    const ka = this.kmersOf(a)
    const kb = this.kmersOf(b)
    const value = this.computeIdentity(a, b, ka, kb)
    this.pairCache.set(key, value)
    return value
  }

  /** 链对缓存键（无序对 → 注册 ID 小大组合；序列 ID < 100 万） */
  private pairKey(a: string, b: string): number {
    const ia = this.registerId(a)
    const ib = this.registerId(b)
    return ia < ib ? ia * 1_000_000 + ib : ib * 1_000_000 + ia
  }

  private registerId(seq: string): number {
    let id = this.chainIds.get(seq)
    if (id == null) {
      id = this.chainIds.size
      this.chainIds.set(seq, id)
    }
    return id
  }

  private kmersOf(seq: string): Set<string> {
    let k = this.chainKmers.get(seq)
    if (!k) {
      k = seqKmers(seq, CROSS_ROW_KMER)
      this.chainKmers.set(seq, k)
    }
    return k
  }

  private computeIdentity(a: string, b: string, ka: Set<string>, kb: Set<string>): number | null {
    const [short, long, ks, kl] = a.length <= b.length ? [a, b, ka, kb] : [b, a, kb, ka]
    // 闸门一：长度比（片段 vs 全长不算重复）
    if (short.length / long.length < CROSS_ROW_MIN_LEN_RATIO) return null
    // 闸门二：8-mer 包含度预滤（快拒绝大多数无关对，免 DP）
    let hit = 0
    for (const k of ks) if (kl.has(k)) hit++
    if (ks.size === 0 || hit / ks.size < CROSS_ROW_PREFILTER) return null
    // 闸门三：半全局比对精确一致率（预算内才计算）
    const cells = short.length * long.length
    if (this.cellsUsed + cells > CROSS_ROW_ALIGN_CELL_BUDGET) return null
    this.cellsUsed += cells
    const r = pairwiseChainIdentity(short, long)
    if (!r) return null
    if (r.coverageA < CROSS_ROW_MIN_COVERAGE || r.coverageB < CROSS_ROW_MIN_COVERAGE) return null
    return r.identity
  }
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
 *  - v2.23.1 序列兜底 → v2.34 行级语义：行内无 UniProt 但有可评估序列 → 该行归入
 *    seqGroups（每行一组；组内 = 非抗体、同源合并后的靶点链，逐序列独立评估；
 *    v2.35 起跨行完全同源（所有链 ≥95%）的行并入代表组，不再重复成组）
 *  - v2.27：去重键 accession|区间；v2.37：序列靶点不再从行文本配对区间（改由管线
 *    BLAST 归属后推导 — 见文件头 v2.37 说明）
 */
export function fallbackHtGroups(sheets: HtSheetRows[]): {
  groups: string[][]
  groupRanges: Array<Array<ResidueRange | undefined>>
  groupDomainHints: Array<Array<string | undefined>>
  seqGroups: HtSeqTarget[][]
  seqInfo: HtSeqFallbackInfo
} {
  const groups: string[][] = []
  const groupRanges: Array<Array<ResidueRange | undefined>> = []
  const groupDomainHints: Array<Array<string | undefined>> = []
  const seqGroups: HtSeqTarget[][] = []
  const seqInfo: HtSeqFallbackInfo = {
    groups: 0,
    antibodyChains: 0,
    homologMerged: 0,
    crossRowMerged: 0,
    crossRowDupRows: [],
    skippedRows: [],
  }
  const crossRow = new CrossRowDedup()
  const seenKeys = new Set<string>()
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
      // v2.34 序列兜底：本行无任何 UniProt ID → 逐行成组（行 = 靶点组）。
      //  链级收集 + 抗体链忽略 + 行内同源合并（同源多聚体只计 1 条）+ 行标签命名。
      const rowLabel = deriveRowLabel(scanRow)
      const seqs = extractRowSeqTargets(scanRow, rowLabel, seqInfo)
      // v2.37：不再把行文本扫描出的数字区间配给序列靶点（原「区间数 = 序列数时
      //  1:1 附 range」— 年份写法「2022-2024 流行株」等被当成残基区间，作为最高
      //  优先级「手动区间」压过 BLAST 推导）。序列靶点的评估区间一律由作业管线在
      //  UniProt 归属/BLAST 后推导（构建比对种子链锚定 → BLAST nr HSP 比对坐标）。
      if (seqs.length > 0) {
        if (seqGroups.length < MAX_GROUPS) {
          const budget = MAX_SEQ_TOTAL_CHARS - seqChars
          if (budget > FASTA_CHAIN_MIN_AA) {
            // v2.35 跨行去重：所有链与某已保留组 ≥95% 同源（同一样本的 .cif/.pdb
            //  双格式 / 复测 / 重命名 / 重精修交付）→ 并入代表组，不另成组、不占字符预算
            const dupOf = crossRow.matchRow(seqs.map((s) => s.seq))
            if (dupOf != null) {
              seqInfo.crossRowMerged += 1
              if (seqInfo.crossRowDupRows.length < CROSS_ROW_NOTE_ROWS) {
                seqInfo.crossRowDupRows.push({
                  sheet: sheet.name,
                  row: r + 1,
                  label: rowLabel || seqs[0]!.header.slice(0, 40),
                  dupOf,
                })
              }
            } else {
              const capped: HtSeqTarget[] = []
              for (const s of seqs) {
                if (seqChars + s.length > MAX_SEQ_TOTAL_CHARS || capped.length >= MAX_TARGETS_PER_GROUP) break
                capped.push(s)
                seqChars += s.length
              }
              if (capped.length > 0) {
                crossRow.addRep(capped.map((s) => s.seq), rowLabel || capped[0]!.header.slice(0, 40) || '组')
                seqGroups.push(capped)
                seqInfo.groups += 1
              }
            }
          }
        }
      } else if (chainsPresentInRow(scanRow)) {
        // 有链但无可评估靶点（纯抗体行）→ 记录跳过原因，不静默丢行
        seqInfo.skippedRows.push({
          sheet: sheet.name,
          row: r + 1,
          label: rowLabel || `第 ${r + 1} 行`,
          reason: 'antibody',
        })
      }
    }
    for (const bucket of byKey.values()) {
      if (groups.length >= MAX_GROUPS) break
      groups.push(bucket.ids)
      groupRanges.push(bucket.ranges)
      groupDomainHints.push(bucket.hints)
    }
  }
  return { groups, groupRanges, groupDomainHints, seqGroups, seqInfo }
}

/** 行内是否存在（被长度阈值收进来过的）链段 — 区分「纯抗体行」与「本就无序列的行」 */
function chainsPresentInRow(row: string[]): boolean {
  return collectRowChains(row).length > 0
}

/** v2.34/v2.35：序列兜底统计 → note 文案（行→组口径、抗体忽略、同源合并、跨行去重、跳过行） */
function seqInfoNote(info: HtSeqFallbackInfo): string {
  const parts: string[] = []
  const evaluableRows = info.groups + info.crossRowMerged
  parts.push(
    info.crossRowMerged > 0
      ? `可评估序列行 ${evaluableRows} 行 → 跨行去重后 ${info.groups} 组`
      : `序列行 ${info.groups} 组（行=组）`,
  )
  if (info.antibodyChains > 0) parts.push(`抗体链已忽略 ${info.antibodyChains} 条`)
  if (info.homologMerged > 0) parts.push(`同源多聚体合并 ${info.homologMerged} 条`)
  if (info.crossRowMerged > 0) {
    const listed = info.crossRowDupRows
      .slice(0, 3)
      .map((d) => `第${d.row}行「${d.label.slice(0, 24)}」并入「${d.dupOf.slice(0, 24)}」`)
      .join('、')
    const more = info.crossRowMerged > 3 ? ` 等 ${info.crossRowMerged} 行` : ''
    parts.push(`跨行去重 ${info.crossRowMerged} 行（所有链与已保留组 ≥95% 同源：${listed}${more}）`)
  }
  if (info.skippedRows.length > 0) {
    const listed = info.skippedRows
      .slice(0, 8)
      .map((s) => `${s.sheet}第${s.row}行（${s.label}${s.reason === 'antibody' ? '·纯抗体链' : '·无序列'}）`)
      .join('、')
    const more = info.skippedRows.length > 8 ? ` 等 ${info.skippedRows.length} 行` : ''
    parts.push(`跳过无可评估靶点的行：${listed}${more}`)
  }
  return parts.join('；')
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
      seqInfo: fb.seqInfo,
      invalid: [],
      source: 'regex',
      note: fb.seqGroups.length > 0 ? `已返回规则提取结果（快速兜底模式）— ${seqInfoNote(fb.seqInfo)}` : '已返回规则提取结果（快速兜底模式）',
    }
  }

  const prompt =
    `靶点表内容如下（Excel 提取文本，行 = 换行，列 = 「|」分隔；长单元格已折叠）：\n\n` +
    `━━━━━━━━━━ 表格内容 ━━━━━━━━━━\n${wb.text.slice(0, MAX_TABLE_TEXT_CHARS)}\n━━━━━━━━━━ 内容结束 ━━━━━━━━━━\n\n` +
    `请按系统指令输出 JSON。`

  const fb = fallbackHtGroups(wb.sheets)
  const seqNote = fb.seqGroups.length > 0 ? seqInfoNote(fb.seqInfo) : ''
  const r = await llmChat(prompt, SYSTEM, opts.signal)
  if (!r.ok) {
    return {
      groups: fb.groups,
      groupRanges: fb.groupRanges,
      groupDomainHints: fb.groupDomainHints,
      seqGroups: fb.seqGroups,
      seqInfo: fb.seqInfo,
      invalid: [],
      source: 'regex',
      note: r.error
        ? `LLM 不可用（${r.error}），已返回规则提取结果${seqNote ? ` — ${seqNote}` : ''}`
        : 'LLM 不可用，已返回规则提取结果',
    }
  }
  const obj = extractJson(r.text)
  if (!obj) {
    return {
      groups: fb.groups,
      groupRanges: fb.groupRanges,
      groupDomainHints: fb.groupDomainHints,
      seqGroups: fb.seqGroups,
      seqInfo: fb.seqInfo,
      invalid: [],
      source: 'regex',
      note: `AI 输出无法解析为 JSON，已返回规则提取结果${seqNote ? ` — ${seqNote}` : ''}`,
    }
  }
  const { groups, invalid, capped } = sanitizeGroups(obj)
  if (groups.length === 0) {
    return {
      groups: fb.groups,
      groupRanges: fb.groupRanges,
      groupDomainHints: fb.groupDomainHints,
      seqGroups: fb.seqGroups,
      seqInfo: fb.seqInfo,
      invalid,
      source: 'regex',
      note: `AI 未识别到有效靶点，已返回规则提取结果${seqNote ? ` — ${seqNote}` : ''}`,
    }
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
    seqGroups: fb.seqGroups,
    seqInfo: fb.seqInfo,
    source: 'llm',
  }
  const notes: string[] = []
  if (capped) notes.push('提取结果已按上限截断（≤ 300 组 · 每组 ≤ 30 靶点）')
  if (appended > 0) notes.push(`已按行内区间补充 ${appended} 个被全局去重合并的靶点实例（如聚蛋白不同片段）`)
  if (seqNote) notes.push(seqNote)
  if (notes.length > 0) out.note = notes.join('；')
  return out
}
