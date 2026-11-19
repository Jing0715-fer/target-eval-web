'use client'

/**
 * 高通量运行报告 zip 导入（v2.38）— 把「已完成的靶点报告」导入新运行或既有运行，
 * 匹配到的靶点直接跳过（不重复评估、不浪费配额）。
 *
 * 两种匹配通道：
 *  ① 清单优先（v2.38 起打包的 zip）：包内 _TargetEval_manifest.json 携带每个报告的
 *     结构化元数据（uniprot / range / seqSha / seqLength / sequenceHeader / zip 路径），
 *     匹配精确（序列靶点按提交序列 SHA-256 前 16 hex 精确等值）；
 *  ② 旧 zip 兜底（无清单）：扫 *.html 文件名 + <title>：
 *     - UniProt 靶点：文件名 / 题目中的 accession（题目格式「蛋白名（P0DTC2 · 残基 16-1273）」）；
 *       双方都带区间时要求相等（不同截短构建视为不同靶点），仅一方带区间不匹配；
 *     - 序列靶点：文件名归一化包含匹配（标签头 + 「· Naa」长度段需一致；长标签的
 *       「…」截断按去符号归一化吸收）。
 * 看板（00_统计看板）/ _README / 合并报告不参与靶点匹配（合并报告按组生成，
 * 跨运行组结构不同，无法可靠对应 — 只用单靶点报告判定跳过）。
 */
import JSZip from 'jszip'

/** 导入的 zip 内一份可匹配的报告 */
export interface HtArchiveReport {
  kind: 'job' | 'merged' | 'dashboard'
  /** zip 内相对路径（提示用） */
  path: string
  /** UniProt accession（清单 / 文件名 / 题目解析） */
  uniprot?: string
  /** 评估区间（清单 / 题目「残基 X-Y」解析） */
  range?: [number, number]
  /** 序列靶点：提交序列 SHA-256 前 16 hex（仅清单通道） */
  seqSha?: string
  /** 序列靶点：长度 aa（清单 / 文件名「· Naa」解析） */
  seqLength?: number
  /** 序列靶点：构建标签头（仅清单通道） */
  sequenceHeader?: string
  /** 文件名去扩展名（旧 zip 标签匹配用） */
  stem: string
}

/** 匹配的目标描述（新运行解析结果或既有运行的 item） */
export interface HtMatchTarget {
  /** UniProt accession（UniProt 靶点；序列靶点缺省） */
  acc?: string
  /** 评估区间（UniProt 残基编号；无则缺省） */
  range?: [number, number]
  /** 序列靶点：构建标签头 */
  header?: string
  /** 序列靶点：展示标签（可能含「…」截断与「· Naa」） */
  label?: string
  /** 序列靶点：长度 aa */
  length?: number
  /** 序列靶点：提交序列 SHA-256 前 16 hex（精确匹配通道） */
  seqSha?: string
}

/** zip 内文件数上限（对齐高通量 MAX_HT_TARGETS_TOTAL + 冗余） */
const MAX_ZIP_FILES = 800
/** 单文件读取上限（题目解析只需头部片段 — 防超大文件拖垮内存） */
const MAX_HTML_HEAD_CHARS = 20_000

/** UniProt accession 语法（与 construct-range.ts 同源副本 — 避免循环依赖） */
const UNIPROT_ACC_RE = /(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9][A-Z][A-Z0-9]{2}[0-9])(?:[A-Z0-9]{3}[0-9])?/

/** 序列 SHA-256 前 16 hex（WebCrypto；https 环境与 localhost 可用） */
export async function sha256Hex16(seq: string): Promise<string | undefined> {
  try {
    if (typeof crypto === 'undefined' || !crypto.subtle) return undefined
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seq))
    return Array.from(new Uint8Array(buf.slice(0, 8)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  } catch {
    return undefined
  }
}

/** 标签归一化：小写 + 去非字母数字（吸收 safeName 空格折叠 / 「…」截断 / 「·」分隔） */
function normLabel(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** 报告 ↔ 目标匹配（规则见文件头；一份报告可匹配多个同名目标 — 调用方自行去重） */
export function matchReportToTarget(rep: HtArchiveReport, t: HtMatchTarget): boolean {
  // ── UniProt 靶点 ──
  if (t.acc) {
    if (!rep.uniprot || rep.uniprot.toUpperCase() !== t.acc.toUpperCase()) return false
    // 双方都带区间 → 必须相等（不同截短构建 = 不同靶点）；仅一方带 → 不匹配
    if (rep.range && t.range) return rep.range[0] === t.range[0] && rep.range[1] === t.range[1]
    return !rep.range && !t.range
  }
  // ── 序列靶点 ──
  if (rep.seqSha && t.seqSha) return rep.seqSha === t.seqSha
  // 旧 zip：文件名标签匹配（归一化包含 + 长度一致）
  const stemN = normLabel(rep.stem)
  if (!stemN) return false
  const lenOk = rep.seqLength == null || t.length == null || rep.seqLength === t.length
  if (!lenOk) return false
  const cands = [t.label, t.header].filter(Boolean).map((x) => normLabel(String(x)))
  // 去掉「· Naa」长度尾巴后再比（长度已单独校验）
  const stripped = cands.map((c) => c.replace(/\d+aa$/, ''))
  const repStripped = stemN.replace(/\d+aa$/, '')
  return stripped.some((c) => {
    if (!c) return false
    return repStripped.includes(c) || c.includes(repStripped)
  })
}

/** 清单 JSON 条目（与服务端 ht-archive 写入口径一致） */
interface ManifestEntry {
  kind: 'job' | 'merged' | 'dashboard'
  path: string
  jobId?: string
  mergedId?: string
  group?: number
  label?: string
  uniprot?: string
  range?: [number, number]
  seqSha?: string
  seqLength?: number
  sequenceHeader?: string
}

/**
 * 解析一份报告 zip → 可匹配报告列表。
 * 失败（非 zip / 损坏 / 空）抛错（调用方 toast）。
 */
export async function parseHtArchive(file: File): Promise<HtArchiveReport[]> {
  const zip = await JSZip.loadAsync(file).catch(() => {
    throw new Error('无法读取该 zip 文件（可能不是有效的 zip 归档）')
  })
  const names = Object.keys(zip.files).filter((n) => !zip.files[n]?.dir).slice(0, MAX_ZIP_FILES)

  // ── ① 清单通道 ──
  const manifestFile = zip.file('_TargetEval_manifest.json')
  if (manifestFile) {
    try {
      const raw = JSON.parse(await manifestFile.async('text')) as { version?: number; entries?: ManifestEntry[] }
      if (Array.isArray(raw.entries)) {
        return raw.entries
          .filter((e) => e && e.kind && e.path)
          .map((e) => ({
            kind: e.kind,
            path: e.path,
            uniprot: e.uniprot,
            range: Array.isArray(e.range) && e.range.length === 2 ? [Number(e.range[0]), Number(e.range[1])] : undefined,
            seqSha: e.seqSha,
            seqLength: e.seqLength,
            sequenceHeader: e.sequenceHeader,
            stem: (e.path.split('/').pop() ?? e.path).replace(/\.html?$/i, ''),
          }))
      }
    } catch {
      // 清单损坏 → 走旧 zip 兜底
    }
  }

  // ── ② 旧 zip 兜底：文件名 + <title> 解析 ──
  const out: HtArchiveReport[] = []
  for (const name of names) {
    if (!/\.html?$/i.test(name)) continue
    const base = name.split('/').pop() ?? name
    if (base.startsWith('00_统计看板') || base.startsWith('_README')) continue
    const stem = base.replace(/\.html?$/i, '')
    const rep: HtArchiveReport = { kind: 'job', path: name, stem }
    // 文件名中的 accession（UniProt 靶点的文件名 = label = accession）
    const accM = UNIPROT_ACC_RE.exec(stem)
    if (accM) rep.uniprot = accM[0].toUpperCase()
    // 文件名中的长度段（序列靶点「· 305aa」）
    const lenM = /(\d{2,5})\s*aa$/i.exec(stem)
    if (lenM) rep.seqLength = Number(lenM[1])
    // 题目补充（「蛋白名（P0DTC2 · 残基 16-1273）」— 区间证据；文件名无 acc 时兜底）
    try {
      const head = (await zip.files[name].async('text')).slice(0, MAX_HTML_HEAD_CHARS)
      const titleM = /<title>([^<]*)<\/title>/i.exec(head)
      const title = titleM?.[1] ?? ''
      if (!rep.uniprot) {
        const tAcc = UNIPROT_ACC_RE.exec(title)
        if (tAcc) rep.uniprot = tAcc[0].toUpperCase()
      }
      const rangeM = /残基\s*(\d{1,5})\s*[-–]\s*(\d{1,5})/.exec(title)
      if (rangeM) {
        const s = Number(rangeM[1])
        const e = Number(rangeM[2])
        if (s >= 1 && e >= s) rep.range = [s, e]
      }
      if (!rep.seqLength) {
        const tLen = /(\d{2,5})\s*(?:个氨基酸残基|aa)/i.exec(title)
        if (tLen) rep.seqLength = Number(tLen[1])
      }
    } catch {
      // 单文件读取失败 → 保留文件名证据继续
    }
    out.push(rep)
  }
  return out
}
