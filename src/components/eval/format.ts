/** 展示格式化工具函数 */

/** 分辨率（Å），空值显示 — */
export function formatResolution(r: number | null | undefined): string {
  if (r == null || Number.isNaN(r)) return '—'
  return `${Number(r.toFixed(2))} Å`
}

/** E-value 科学计数法友好展示 */
export function formatEvalue(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '—'
  if (v === 0) return '0'
  if (v < 0.001 || v >= 10000) return v.toExponential(1).replace(/e([+-])(\d)$/, 'e$1$2')
  return String(Number(v.toPrecision(3)))
}

/** 百分比（0-100 或 0-1 自动识别） */
export function formatPercent(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '—'
  const pct = v > 0 && v <= 1 ? v * 100 : v
  return `${Math.round(pct)}%`
}

/** 评分颜色档位：≥7 emerald / 5-7 amber / <5 red */
export function scoreLevel(score: number | null | undefined): 'emerald' | 'amber' | 'red' {
  if (score == null || Number.isNaN(score)) return 'red'
  if (score >= 7) return 'emerald'
  if (score >= 5) return 'amber'
  return 'red'
}

/** 秒 → mm:ss 或 h:mm:ss */
export function formatDuration(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(sec).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`
}

/** ISO 时间 → 本地化日期时间 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('zh-CN', {
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** ISO 日期 → YYYY-MM-DD */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  return iso.slice(0, 10)
}

/** 日志行级别推断（后端日志为纯字符串） */
export function logLevel(line: string): 'info' | 'warn' | 'error' {
  if (/error|错误|失败|exception/i.test(line)) return 'error'
  if (/warn|警告|跳过|超时/i.test(line)) return 'warn'
  return 'info'
}

/**
 * UniProt accession 校验：6 位 / 10 位（TrEMBL，如 A0A8G0KJC2）/ isoform 后缀（-2）
 */
const UNIPROT_RE =
  /^(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9][A-Z][A-Z0-9]{2}[0-9])(?:[A-Z0-9]{3}[0-9])?(?:-[0-9]+)?$/i

export function isValidUniprotId(value: string): boolean {
  return UNIPROT_RE.test(value.trim())
}

/** 解析序列文本：去除 FASTA 头与非法字符，返回残基数 */
export function countResidues(text: string): { count: number; hasFastaHeader: boolean } {
  const lines = text.split('\n')
  const hasFastaHeader = lines.some((l) => l.trim().startsWith('>'))
  const joined = lines.filter((l) => !l.trim().startsWith('>')).join('')
  const residues = joined.toUpperCase().replace(/[^A-Z]/g, '')
  return { count: residues.length, hasFastaHeader }
}

/** 日志按行拆分（兼容后端传字符串数组） */
export function toLogLines(logs: string[] | null | undefined): string[] {
  if (!Array.isArray(logs)) return []
  return logs
}

/**
 * 解析多 UniProt ID 输入（v1.22）：支持逗号、空格、换行、分号分隔。
 * 返回去重保序的有效 ID 列表 + 无效 token（用于提示）。
 */
export function parseMultiUniprotIds(text: string): { valid: string[]; invalid: string[] } {
  const tokens = text
    .split(/[\s,;]+/)
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean)
  const valid: string[] = []
  const invalid: string[] = []
  const seen = new Set<string>()
  for (const t of tokens) {
    if (seen.has(t)) continue
    seen.add(t)
    if (isValidUniprotId(t)) valid.push(t)
    else invalid.push(t)
  }
  return { valid, invalid }
}

// ─── v2.22 高通量评估：分组解析 ─────────────────────────────────────────────

/**
 * 高通量运行的最大组数（每组一份独立报告）。v2.23.1：12 → 300 —
 * Excel 导入的百行级靶点清单（如 102 行 = 100 组）此前被 12 组上限
 * 压到超限 → 开始按钮被禁用，导入功能等于不可用。
 */
export const MAX_HT_GROUPS = 300
/** 单组（复合物批量）内靶点数上限 — 与批量评估上限一致 */
export const MAX_HT_TARGETS_PER_GROUP = 30
/**
 * 一次高通量运行的靶点总数上限（UniProt + 序列兜底靶点合计）。v2.23.1：30 → 600。
 * 实际推进节流由服务端守卫负责（每 IP 并发 2 + 24h 作业配额），配额用尽时
 * 高通量流程自动暂停、配额恢复后可从断点续跑（不在此处预拦）。
 */
export const MAX_HT_TARGETS_TOTAL = 600

/**
 * 解析高通量分组输入（v2.22）：
 *  - 「;」（半角/全角分号）分隔组：每组按复合物批量评估（关系判断 → 逐靶点 → 合并报告），单独出报告
 *  - 组内「,」（半角/全角逗号）或空白/换行分隔靶点
 *  - 组内仅一个靶点 = 独立评估（单作业独立报告）
 *  - v2.27 截短构建感知：靶点可带评估区间后缀「:起始-结束」（UniProt 残基编号，
 *    如「P0DTD1:4393-5324」= 聚蛋白 nsp12 片段）— Excel 导入自动填入，也可手输；
 *    范围重叠结构优先展示，无重叠折叠保留
 *  - v2.29 结构域名提示：靶点可带域名后缀「:域名」（如「P51685:胞外域」/
 *    「P00533:kinase」— 评估表不写区间而写域名时）→ groupDomainHints 对齐携带，
 *    管线内与 UniProt domain 划分匹配推导区间（数值区间优先）
 * 去重键 = accession|区间（全局保序去重；同 accession 不同区间 = 不同靶点 — 聚蛋白
 * 片段不再被合并为一次全长评估）；返回分组列表 + 对齐的区间/域名提示 + 无效 token + 跨组重复。
 */
export function parseGroupedUniprotIds(text: string): {
  groups: string[][]
  /** 与 groups 逐组逐位对齐的评估区间（undefined = 该靶点不过滤） */
  groupRanges: Array<Array<[number, number] | undefined>>
  /** v2.29：与 groups 逐组逐位对齐的结构域名提示（无则 undefined — 管线内匹配 UniProt domain 推导区间） */
  groupDomainHints: Array<Array<string | undefined>>
  invalid: string[]
  duplicates: string[]
} {
  const groups: string[][] = []
  const groupRanges: Array<Array<[number, number] | undefined>> = []
  const groupDomainHints: Array<Array<string | undefined>> = []
  const invalid: string[] = []
  const duplicates: string[] = []
  const seen = new Set<string>()
  for (const chunk of text.split(/[;；]+/)) {
    const tokens = chunk.split(/[\s,，]+/).map((t) => t.trim().toUpperCase()).filter(Boolean)
    if (tokens.length === 0) continue
    const ids: string[] = []
    const ranges: Array<[number, number] | undefined> = []
    const hints: Array<string | undefined> = []
    for (const t of tokens) {
      if (seen.has(t)) {
        if (!duplicates.includes(t)) duplicates.push(t)
        continue
      }
      seen.add(t)
      // v2.27 可选区间后缀「:起始-结束」（1 ≤ 起 ≤ 止）；v2.29 域名后缀「:域名」
      // （非纯数字 token — 数值区间优先，域名仅在无区间时生效）
      let id = t
      let range: [number, number] | undefined
      let hint: string | undefined
      const rm = t.match(/^([A-Z0-9-]+):(\d{1,5})-(\d{1,5})$/)
      if (rm) {
        id = rm[1]
        const s = Number(rm[2])
        const e = Number(rm[3])
        if (Number.isFinite(s) && Number.isFinite(e) && s >= 1 && e >= s && e <= 100000) {
          range = [s, e]
        } else {
          if (!invalid.includes(t)) invalid.push(t)
          continue
        }
      } else {
        const hm = t.match(/^([A-Z0-9-]+):([^0-9:;\s][^:;]{1,40})$/)
        if (hm) {
          id = hm[1]
          const h = hm[2].trim()
          // 域名 token 至少 2 字符且非纯数字/纯符号
          if (h.length >= 2 && !/^\d+$/.test(h) && !/^[-.\s]+$/.test(h)) {
            hint = h
          } else {
            if (!invalid.includes(t)) invalid.push(t)
            continue
          }
        }
      }
      if (isValidUniprotId(id)) {
        ids.push(id)
        ranges.push(range)
        hints.push(hint)
      } else if (!invalid.includes(t)) {
        invalid.push(t)
      }
    }
    if (ids.length > 0) {
      groups.push(ids)
      groupRanges.push(ranges)
      groupDomainHints.push(hints)
    }
  }
  return { groups, groupRanges, groupDomainHints, invalid, duplicates }
}

/** 单条 FASTA 序列（解析多 FASTA 用） */
export interface FastaEntry {
  header: string
  seq: string
  length: number
}

/**
 * 解析多 FASTA 序列（v1.22）：文本中含多个 `>` 标题段时拆成多条；
 * 无 `>` 头的裸序列作为单条返回。
 * 每条序列去除非法字符、转大写。
 */
export function parseMultiFasta(text: string): FastaEntry[] {
  const lines = text.split('\n').map((l) => l.trimEnd())
  const entries: FastaEntry[] = []
  let cur: FastaEntry | null = null
  for (const line of lines) {
    if (line.startsWith('>')) {
      if (cur && cur.seq) entries.push(cur)
      cur = { header: line.slice(1).trim(), seq: '', length: 0 }
    } else {
      const cleaned = line.toUpperCase().replace(/[^A-Z*]/g, '')
      if (cur && cleaned) {
        cur.seq += cleaned
        cur.length = cur.seq.length
      } else if (!cur && cleaned) {
        // 无 FASTA 头的裸序列
        cur = { header: '', seq: cleaned, length: cleaned.length }
      }
    }
  }
  if (cur && cur.seq) entries.push(cur)
  return entries
}
