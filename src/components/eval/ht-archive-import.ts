'use client'

/**
 * 高通量运行报告 zip 导入（v2.38 → v2.42 严格匹配重设计）— 把「已完成的靶点报告」
 * 导入新运行或既有运行，匹配到的靶点直接跳过（不重复评估、不浪费配额）。
 *
 * v2.42 严格化（用户反馈「除了已有报告的 G01-16 外还有很多靶点被跳过」—
 * 旧版序列靶点文件名兜底用「归一化标签双向包含」，短标签如「原PDB」「序列1」
 * 归一化后变成 pdb / 1 这类短串，几乎任何报告文件名都包含它 → 大量误跳过）：
 *  - 只有 kind='job' 的单靶点报告参与匹配（merged 按组生成跨运行组结构不同，
 *    dashboard 是汇总件 — 都不能证明某个具体靶点已有报告）；
 *  - 序列靶点：①清单 seqSha 双侧精确等值（主通道）；②无 SHA 旧 zip 兜底改为
 *    「归一化标签严格相等 + 长度双方已知且相等」，并加歧义守卫：多个不同序列
 *    共享同一标签+长度时无法区分报告属于谁 → 一个都不跳（宁重跑不误跳）；
 *  - UniProt 靶点：accession + 区间严格相等（原有语义不变）；
 *  - 双向包含匹配彻底移除。
 *
 * v2.45（用户反馈「导入单文件匹配不到，文件名中 G73 之类的数字应该就能匹配」）：
 *  - 新增**组号通道**：HT 自动下载的报告文件名携带运行目录段（TargetEval_HT_日期_74g
 *    G74_组名.html — 浏览器把目录分隔符扁平化后 G{NN} 仍留在文件名里）。合并报告
 *    按组号 + 靶点数一致 + 总组数对齐 → 整组跳过；单靶点报告按组号只在运行侧
 *    该组恰好 1 个靶点时跳过（否则无法判定归属）；
 *  - 新增**机器可读标记通道**（v2.45 起生成的报告内嵌 <meta name="targeteval:target(s)">
 *    携带 uniprot/range/seqSha/header/label）— 序列靶点单文件导入可走 SHA 精确匹配，
 *    不再依赖 h1/题目文本启发式；
 *  - 序列靶点旧报告的题目尾标签是身份识别名（非运行侧标签）— 严格标签通道对不上
 *    属预期，由组号通道/标记通道兜底。
 *
 * 匹配计划由 planArchiveSkips 统一计算（新建运行与既有运行导入同一套规则）。
 */
import JSZip from 'jszip'

/** 导入的 zip/文件内一份可匹配的报告 */
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
  /** v2.45：源运行组号（1-based — 文件名 G{NN} 段 / zip 路径 G{NN}/ 前缀 / 清单 group 字段） */
  group?: number
  /** v2.45：源运行总组数（文件名 TargetEval_HT_日期_Ng 段 — 组号对齐校验） */
  totalGroups?: number
  /** v2.45：合并报告覆盖的靶点数（靶点数 K 个 / 清单同组 job 条目数 / 题目尾标签数） */
  targetCount?: number
}

/** 匹配的目标描述（新运行解析结果或既有运行的 item） */
export interface HtMatchTarget {
  /** 目标唯一键（计划结果的 Set 元素 — 调用方自定：`g:${i}:${j}` / item.key） */
  key: string
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
  /** v2.42：提交序列本体（歧义守卫 — 同标签同长度但不同序列时识别无法区分） */
  seq?: string
  /** v2.45：运行侧组序（0-based，UniProt 组在前序列组在后 — 与 G{NN} 组号对齐） */
  groupIndex?: number
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

/** v2.42 报告侧匹配键：去 zip 组目录前缀（G05_/）与去重尾缀（_2）后的归一化标签
 *  （长度尾巴单独比 —「· Naa」在双方标签里都存在时会自然吸收进等值比较） */
function reportLabelKey(stem: string): string {
  return normLabel(
    stem
      .replace(/^G\d{1,3}[_\s-]*/i, '')   // 组目录前缀（文件名含 G05_ 前缀）
      .replace(/_\d{1,3}$/, ''),            // 同名去重尾缀（_2/_3…）
  )
}

/** v2.42 目标侧匹配键（label / header 同口径归一化；截断标签「头22…尾7」在
 *  双方用同一截断函数生成时归一化结果一致） */
function targetLabelKey(t: HtMatchTarget): string {
  const cands = [t.label, t.header].filter(Boolean).map((x) => normLabel(String(x)))
  return cands[0] ?? ''
}

/** planArchiveSkips 可选项 */
export interface PlanArchiveSkipsOptions {
  /** v2.45：运行侧总组数（组号通道对齐校验 — 与报告侧 totalGroups 不一致时组号不可信） */
  totalGroups?: number
}

/** v2.42 统一匹配计划：返回可安全跳过的目标键集合。
 *  规则（见文件头）：
 *  - 只有单靶点 job 报告参与严格通道；
 *  - UniProt：acc + 区间严格相等；
 *  - 序列：SHA 精确等值；无 SHA 时「标签键严格相等 + 长度双方已知且相等」
 *    且无歧义（同标签键同长度的不同序列只计 1 个时才可判定归属）；
 *  - v2.45 组号通道：合并报告（组号 + 靶点数一致 + 总组数对齐）→ 整组跳过；
 *    单靶点报告组号仅在运行侧该组恰 1 个靶点时跳过；
 *  - 任一证据缺失 → 不跳（宁重跑不误跳 — 用户明确要求只跳过真正有报告的靶点）。 */
export function planArchiveSkips(reports: HtArchiveReport[], targets: HtMatchTarget[], opts?: PlanArchiveSkipsOptions): Set<string> {
  const jobReports = reports.filter((r) => r.kind === 'job')
  // v2.45：合并报告（组号通道）无 job 条目也要继续（如旧合并报告 h1 无全角括号时
  //  严格通道拿不到任何条目 — 组号通道是唯一可匹配路径）
  const mergedWithGroup = reports.filter((r) => r.kind === 'merged' && r.group != null)
  if ((jobReports.length === 0 && mergedWithGroup.length === 0) || targets.length === 0) return new Set()

  const skipped = new Set<string>()

  // ── UniProt 靶点：acc + 区间严格相等（无歧义 — accession+区间即身份）──
  const uniTargets = targets.filter((t) => t.acc)
  for (const t of uniTargets) {
    const hit = jobReports.some((rep) => {
      if (!rep.uniprot || rep.uniprot.toUpperCase() !== t.acc!.toUpperCase()) return false
      if (rep.range && t.range) return rep.range[0] === t.range[0] && rep.range[1] === t.range[1]
      return !rep.range && !t.range
    })
    if (hit) skipped.add(t.key)
  }

  // ── 序列靶点：①SHA 精确通道 ②严格标签+长度兜底（带歧义守卫）──
  const seqTargets = targets.filter((t) => !t.acc)

  // ① SHA 精确：报告有 seqSha 且目标有 seqSha → 等值即跳（同序列多行都算已有报告）
  const shaReports = jobReports.filter((r) => r.seqSha)
  for (const t of seqTargets) {
    if (!t.seqSha) continue
    if (shaReports.some((r) => r.seqSha === t.seqSha)) skipped.add(t.key)
  }

  // ② 无 SHA 兜底：标签键严格相等 + 长度双方已知且相等；
  //    歧义守卫：同（标签键，长度）下存在多个不同序列（SHA 或 seq 本体可区分）→ 全部不跳
  const fallbackReports = jobReports.filter((r) => !r.seqSha)
  if (fallbackReports.length > 0) {
    // 报告侧候选键：标签键 → 长度集合
    const repKeys = new Map<string, Set<number>>()
    for (const rep of fallbackReports) {
      const k = reportLabelKey(rep.stem)
      if (!k) continue
      if (rep.seqLength == null) continue // 报告侧长度未知 → 无法安全匹配
      if (!repKeys.has(k)) repKeys.set(k, new Set())
      repKeys.get(k)!.add(rep.seqLength)
    }
    // 目标侧分组：（标签键，长度）→ 不同序列数
    const ambiguous = new Set<string>()
    const groupSeqs = new Map<string, Set<string>>()
    for (const t of seqTargets) {
      const k = targetLabelKey(t)
      if (!k || t.length == null) continue
      const gk = `${k}|${t.length}`
      const identity = t.seqSha ?? t.seq ?? ''
      if (!identity) continue // 无法区分身份 → 保守不跳（不入组）
      if (!groupSeqs.has(gk)) groupSeqs.set(gk, new Set())
      groupSeqs.get(gk)!.add(identity)
    }
    for (const [gk, ids] of groupSeqs) {
      if (ids.size > 1) ambiguous.add(gk) // 同标签同长度不同序列 → 无法判定报告归属
    }
    for (const t of seqTargets) {
      if (skipped.has(t.key)) continue // SHA 通道已命中
      const k = targetLabelKey(t)
      if (!k || t.length == null) continue
      const gk = `${k}|${t.length}`
      if (ambiguous.has(gk)) continue
      const lens = repKeys.get(k)
      if (lens && lens.has(t.length)) skipped.add(t.key)
    }
  }

  // ── v2.45 组号通道：文件名/zip 路径/清单中的 G{NN}（用户诉求 — 报告文件名即携带组号）──
  //  对齐条件：①总组数双方已知且相等（清单可能被增删改过时组号已漂移，不可信）；
  //  ②合并报告的靶点数与运行侧该组靶点数一致；③单靶点报告仅当运行侧该组恰 1 个
  //  靶点（多靶点组无法判定报告归属谁）。任一不满足 → 退回上方严格通道的结果。
  const groupTargets = new Map<number, HtMatchTarget[]>()
  for (const t of targets) {
    if (t.groupIndex == null || t.groupIndex < 0) continue
    const arr = groupTargets.get(t.groupIndex)
    if (arr) arr.push(t)
    else groupTargets.set(t.groupIndex, [t])
  }
  if (groupTargets.size > 0) {
    const totalAligned = (rep: HtArchiveReport) =>
      rep.totalGroups == null || opts?.totalGroups == null || rep.totalGroups === opts.totalGroups
    for (const rep of reports) {
      if (rep.group == null || rep.group < 1) continue
      const gt = groupTargets.get(rep.group - 1)
      if (!gt || gt.length === 0) continue
      if (!totalAligned(rep)) continue
      if (rep.kind === 'merged') {
        // 合并报告覆盖整组：靶点数未知或与运行侧不一致 → 不可整组跳（宁重跑不误跳）
        if (rep.targetCount == null || rep.targetCount !== gt.length) continue
        for (const t of gt) skipped.add(t.key)
      } else if (rep.kind === 'job' && gt.length === 1) {
        // 单靶点报告 + 运行侧该组恰好 1 个靶点 → 报告必属该靶点
        skipped.add(gt[0]!.key)
      }
    }
  }

  return skipped
}

/** v2.42 保留的单报告↔单目标判定（供调试/单点调用；集合语义用 planArchiveSkips） */
export function matchReportToTarget(rep: HtArchiveReport, t: HtMatchTarget): boolean {
  return planArchiveSkips([rep], [t]).has(t.key)
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

// ── v2.45 文件名组号/总组数解析 ────────────────────────────────────────────

/** 文件名中的组号段：独立 G+数字 token（G74_ / G74 空格 / 目录残留 G74/）。
 *  要求 G 前是行首/空白/斜杠（EGFR_G12C 这类基因名中部 G 不会误中）且后随
 *  分隔符/结尾（G12C 的 C 会被拒）。取首个命中（目录段在标题前）。 */
const FILE_GROUP_RE = /(?:^|[\s\/])G(\d{1,3})(?=[\s\/_]|$)/
/** 文件名中的总组数段：TargetEval_HT_日期_Ng（数字后紧跟 g 结束 token） */
const FILE_TOTAL_GROUPS_RE = /(?:^|[\s_])(\d{1,3})g(?![a-z0-9])/

/** HTML 属性反转义（esc 的逆 — meta 标记通道用） */
function unescapeAttr(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/** v2.45 报告内嵌机器可读靶点标记条目（服务端生成 — 权威证据） */
interface TargetMetaEntry {
  uniprot?: string
  range?: [number, number]
  seqLength?: number
  seqSha?: string
  header?: string
  label?: string
}

/** 解析 <meta name="..." content="..."> 的 JSON（损坏返回 null） */
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

/** meta 条目消毒（畸形字段丢弃 — 服务端可信但防御性解析） */
function sanitizeMetaEntry(e: Partial<TargetMetaEntry>): Partial<TargetMetaEntry> | null {
  if (!e || typeof e !== 'object') return null
  const out: Partial<TargetMetaEntry> = {}
  if (typeof e.uniprot === 'string' && UNIPROT_ACC_RE.test(e.uniprot)) out.uniprot = e.uniprot.toUpperCase()
  if (Array.isArray(e.range) && e.range.length === 2 && Number(e.range[0]) >= 1 && Number(e.range[1]) >= Number(e.range[0])) {
    out.range = [Number(e.range[0]), Number(e.range[1])]
  }
  if (typeof e.seqLength === 'number' && e.seqLength >= 10 && e.seqLength <= 100000) out.seqLength = Math.round(e.seqLength)
  if (typeof e.seqSha === 'string' && /^[0-9a-f]{16}$/i.test(e.seqSha)) out.seqSha = e.seqSha.toLowerCase()
  if (typeof e.header === 'string' && e.header.trim()) out.header = e.header.trim().slice(0, 80)
  if (typeof e.label === 'string' && e.label.trim()) out.label = e.label.trim().slice(0, 90)
  return Object.keys(out).length > 0 ? out : null
}

/**
 * v2.44→v2.45：解析一份**单独的报告 HTML 文件**（单靶点报告 / 组合并报告 / 统计看板）。
 *
 * 用户诉求：除 zip 归档外，支持导入单个报告文件（如浏览器下载的
 * 「TargetEval_HT_2026-11-19_74g G74_TSLP受体轴三靶点独立评估.html」），
 * 且可多选批量导入。v2.45：文件名中的组号（G74）与总组数（74g）也参与匹配。
 *
 * 提取通道（无 manifest — 全部从 HTML 内容 + 文件名解析）：
 *  - 统计看板：题目含「高通量评估汇总报告」→ 单条 dashboard（不参与匹配，仅计数）；
 *  - v2.45 ⓪ 机器可读标记：<meta name="targeteval:targets">（合并）/ targeteval:target
 *    （单靶点）— v2.45 起生成的报告内嵌（uniprot/range/seqSha/header/label 权威字段）；
 *  - 合并报告（v2.13+ 各靶点内嵌完整单独评估页）：
 *    ① 题目尾部靶点标签清单「标题 · P123 + P456」（accession 形态直接可匹配）；
 *    ② 逐内嵌页扫描：<h1 class="rpt-title">NAME（P12345 · 残基 X-Y）</h1> 与就近
 *       「序列长度 N aa」配对 → 每靶点一条可匹配条目（accession / 区间 / 长度齐全）；
 *    ③ 「靶点数 K 个」meta 行 → 合并报告的组内靶点数（组号通道校验用）；
 *  - 单靶点报告：同一套 h1 + 序列长度扫描（自身即唯一内嵌页）。
 *
 * v2.45 文件级元数据：组号（G{NN} 段）+ 总组数（_Ng 段）从文件名解析，附着到
 * 各条目（合并报告另发一条 kind='merged' 的文件级条目 — 组号通道入口）。
 *
 * 序列靶点条目的 stem 按靶点标签格式「header · Naa」构造（normLabel 归一后与
 * 运行侧标签键严格相等 — planArchiveSkips 兜底通道）；证据不足时不产出
 * （宁重跑不误跳，与 v2.42 严格匹配口径一致）。
 */
export async function parseHtReportFile(file: File): Promise<HtArchiveReport[]> {
  let text: string
  try {
    text = await file.text()
  } catch {
    throw new Error(`无法读取文件 ${file.name}`)
  }
  // 防御上限（合并报告内嵌 3D 模型/图片可达十余 MB — 配对只需 h1 与序列长度行）
  const capped = text.length > 26_000_000 ? text.slice(0, 26_000_000) : text
  const stem = file.name.replace(/\.html?$/i, '')
  const title = /<title>([^<]*)<\/title>/i.exec(capped)?.[1] ?? ''

  // ① 统计看板（汇总件 — 不参与靶点匹配）
  if (title.includes('高通量评估汇总报告') || /^00_统计看板/.test(stem)) {
    return [{ kind: 'dashboard', path: file.name, stem }]
  }

  // ── v2.45 文件名组号/总组数（HT 自动下载目录段扁平化后残留在文件名里）──
  let group: number | undefined
  let totalGroups: number | undefined
  {
    const gM = FILE_GROUP_RE.exec(stem)
    const tM = FILE_TOTAL_GROUPS_RE.exec(stem)
    if (tM) {
      const n = Number(tM[1])
      if (n >= 1 && n <= 999) totalGroups = n
    }
    if (gM) {
      const n = Number(gM[1])
      // 组号越界（> 总组数）视为误判（标题里的 G token 等）丢弃
      if (n >= 1 && n <= 999 && (totalGroups == null || n <= totalGroups)) group = n
    }
  }

  const out: HtArchiveReport[] = []
  const seenEvidence = new Set<string>()

  // ⓪ v2.45 机器可读标记（服务端生成的权威字段 — 优先于文本启发式）
  const metaArr = parseMetaJson<Partial<TargetMetaEntry>[]>(capped, 'targeteval:targets')
  const metaOne = parseMetaJson<Partial<TargetMetaEntry>>(capped, 'targeteval:target')
  const metaEntries = metaArr && Array.isArray(metaArr)
    ? metaArr.slice(0, 60).map(sanitizeMetaEntry).filter((x): x is Partial<TargetMetaEntry> => x != null)
    : metaOne ? [sanitizeMetaEntry(metaOne)].filter((x): x is Partial<TargetMetaEntry> => x != null)
      : []

  // ② 合并报告题目尾部的靶点标签清单（「reportTitle · A + B + C」— label = accession
  //    或蛋白名；accession 形态可直接匹配 UniProt 靶点）
  const mergedTitleM = /^(.*) · (.+ \+ .+)$/.exec(title)
  // v2.45 合并报告的组内靶点数（组号通道校验）：靶点数行 > meta 条目数 > 题目尾标签数
  const cntM = /<b>靶点数<\/b>\s*(\d{1,3})\s*个/.exec(capped)
  const isMerged = metaArr != null || cntM != null || mergedTitleM != null
  let mergedTargetCount: number | undefined
  if (cntM) mergedTargetCount = Number(cntM[1])
  else if (metaEntries.length > 0 && metaArr != null) mergedTargetCount = metaEntries.length
  else if (mergedTitleM) mergedTargetCount = mergedTitleM[2].split(' + ').filter((s) => s.trim()).length

  // 合并文件级条目（组号通道入口 — kind='merged' 不参与严格通道，只按组号整组判定）
  if (isMerged) {
    out.push({
      kind: 'merged',
      path: file.name,
      stem,
      group,
      totalGroups,
      targetCount: mergedTargetCount,
    })
  }

  // ⓪ meta 条目 → 严格通道条目（seqSha/header 为服务端权威值 — SHA/标签精确匹配）
  //    合并文件不发（其 meta 面向整组，由组号通道处理 + h1/题目通道兜底单靶点形态）
  if (!isMerged) {
    for (const e of metaEntries) {
      const evidence = `meta:${e.uniprot ?? ''}|${e.seqSha ?? ''}|${e.header ?? ''}|${e.seqLength ?? ''}`
      if (seenEvidence.has(evidence)) continue
      seenEvidence.add(evidence)
      out.push({
        kind: 'job',
        path: `${file.name}::${e.label ?? e.uniprot ?? ''}`,
        uniprot: e.uniprot,
        range: e.range,
        seqSha: e.seqSha,
        seqLength: e.seqLength,
        sequenceHeader: e.header,
        stem: e.label ?? e.uniprot ?? stem,
        group,
        totalGroups,
      })
    }
  }

  if (mergedTitleM) {
    for (const rawLabel of mergedTitleM[2].split(' + ')) {
      const label = rawLabel.trim()
      if (!label) continue
      const accM = UNIPROT_ACC_RE.exec(label)
      const lenM = /(\d{2,5})\s*aa$/i.exec(label)
      const evidence = `title:${label}`
      if (seenEvidence.has(evidence)) continue
      seenEvidence.add(evidence)
      out.push({
        kind: 'job',
        path: `${file.name}::${label}`,
        uniprot: accM ? accM[0].toUpperCase() : undefined,
        seqLength: lenM ? Number(lenM[1]) : undefined,
        stem: label,
        // v2.45：非合并文件（题目尾形态不成立时不会进本分支 — 防御性保留）
      })
    }
  }

  // ③ 内嵌/独立单靶点报告页：h1 题目（NAME（P12345 · 残基 X-Y）/ NAME（序列靶点 · …））
  //    与其后、下一 h1 前的「序列长度 N aa」配对 → 每靶点一条可匹配条目
  const h1Re = /<h1 class="rpt-title"[^>]*>([^<]+)<\/h1>/g
  const lenRe = /序列长度<\/b>\s*(\d{2,5})\s*aa/g
  const h1s: Array<{ title: string; at: number }> = []
  let m: RegExpExecArray | null
  while ((m = h1Re.exec(capped))) h1s.push({ title: m[1].trim(), at: m.index })
  const lens: Array<{ len: number; at: number }> = []
  while ((m = lenRe.exec(capped))) lens.push({ len: Number(m[1]), at: m.index })

  for (let i = 0; i < h1s.length; i++) {
    const h = h1s[i]!
    // 单靶点页题目形态：「NAME（内层）」；合并报告首页/章节标题（无全角括号对）跳过
    const shape = /^([^（]+)（([^）]*)）$/.exec(h.title)
    if (!shape) continue
    const name = shape[1].trim()
    const inner = shape[2]
    const accM = UNIPROT_ACC_RE.exec(inner)
    const rangeM = /残基\s*(\d{1,5})\s*[-–]\s*(\d{1,5})/.exec(inner)
    const range: [number, number] | undefined = rangeM && Number(rangeM[1]) >= 1 && Number(rangeM[2]) >= Number(rangeM[1])
      ? [Number(rangeM[1]), Number(rangeM[2])]
      : undefined
    const nextH1 = h1s[i + 1]
    const lenHit = lens.find((x) => x.at > h.at && (nextH1 == null || x.at < nextH1.at))
    const seqLength = lenHit?.len
    // 防误判：非 accession 页须是序列靶点形态（合并报告 LLM 标题可能恰好含全角括号）
    const seqShape = inner.includes('序列靶点') || inner.includes('同源') || inner.includes('nr 识别') || inner.includes('UniProt 匹配')
    const evidence = `h1:${name}|${accM?.[0] ?? ''}|${range?.join('-') ?? ''}|${seqLength ?? ''}`
    if (seenEvidence.has(evidence)) continue

    if (accM) {
      seenEvidence.add(evidence)
      out.push({
        kind: 'job',
        path: `${file.name}::${name}`,
        uniprot: accM[0].toUpperCase(),
        range,
        seqLength,
        stem: name,
        // v2.45：单靶点报告文件携带组号（组内仅 1 靶点时可判定归属；合并文件的
        //  h1 条目不带组号 — 源组多靶点时无法证明归属谁）
        ...(isMerged ? {} : { group, totalGroups }),
      })
    } else if (seqShape) {
      seenEvidence.add(evidence)
      // stem 模拟运行侧序列靶点标签格式（header · Naa — 归一化后与标签键严格相等）
      out.push({
        kind: 'job',
        path: `${file.name}::${name}`,
        range,
        seqLength,
        stem: seqLength != null ? `${name} · ${seqLength}aa` : name,
        ...(isMerged ? {} : { group, totalGroups }),
      })
    }
  }
  return out
}

/**
 * v2.44：混合导入解析 — zip 归档与单独 HTML 报告统一入口（可多选批量）。
 * 非报告文件（扩展名不识别）跳过；全部不可识别时返回空数组（调用方提示）。
 */
export async function parseHtImportFiles(files: File[]): Promise<HtArchiveReport[]> {
  const out: HtArchiveReport[] = []
  for (const f of files.slice(0, MAX_ZIP_FILES)) {
    if (/\.zip$/i.test(f.name)) {
      out.push(...(await parseHtArchive(f)))
    } else if (/\.html?$/i.test(f.name)) {
      out.push(...(await parseHtReportFile(f)))
    }
  }
  return out
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
        const entries = raw.entries.filter((e) => e && e.kind && e.path)
        // v2.45：合并报告的组内靶点数 = 清单中同组的 job 条目数（组号通道校验用）
        const jobCountByGroup = new Map<number, number>()
        for (const e of entries) {
          if (e.kind === 'job' && e.group != null && e.group >= 1) {
            jobCountByGroup.set(e.group, (jobCountByGroup.get(e.group) ?? 0) + 1)
          }
        }
        return entries.map((e) => ({
          kind: e.kind,
          path: e.path,
          uniprot: e.uniprot,
          range: Array.isArray(e.range) && e.range.length === 2 ? [Number(e.range[0]), Number(e.range[1])] : undefined,
          seqSha: e.seqSha,
          seqLength: e.seqLength,
          sequenceHeader: e.sequenceHeader,
          stem: (e.path.split('/').pop() ?? e.path).replace(/\.html?$/i, ''),
          group: e.group != null && e.group >= 1 ? e.group : undefined,
          targetCount: e.kind === 'merged' && e.group != null ? jobCountByGroup.get(e.group) : undefined,
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
    // v2.45：zip 路径中的组目录前缀（G05/xxx.html）
    const dirGroupM = /^G(\d{1,3})\//.exec(name)
    if (dirGroupM) rep.group = Number(dirGroupM[1])
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
      // v2.45：题目尾标签清单「标题 · A + B + C」→ 合并报告（kind 修正 + 靶点数）
      const mergedTailM = /^(.*) · (.+ \+ .+)$/.exec(title)
      if (mergedTailM) {
        rep.kind = 'merged'
        rep.targetCount = mergedTailM[2].split(' + ').filter((s) => s.trim()).length
      }
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
