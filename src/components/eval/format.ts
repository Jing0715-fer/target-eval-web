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
