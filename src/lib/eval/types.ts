/**
 * 靶点评估 — 共享类型定义
 * 与前端 src/components/eval/types.ts 契约保持一致。
 */

export type JobStatus = 'pending' | 'running' | 'done' | 'error' | 'canceled'
export type InputMode = 'uniprot' | 'sequence' | 'docx'
export type AssetKind = 'gel' | 'sec' | 'other'

export interface EvaluationOptions {
  skipBlast: boolean
  forceBlast: boolean
  maxPdb: number
}

// ─── UniProt ──────────────────────────────────────────────────────────────────

export interface UniprotFeature {
  type: string        // Domain | Signal | Transmembrane | Region | Computed region ...
  description: string
  begin: number
  end: number
}

export interface UniprotInfo {
  uniprotId: string
  entryName: string
  proteinName: string
  geneNames: string[]
  organism: string
  sequenceLength: number
  sequence: string
  /** 功能注释（cc_function 第一段） */
  functionText?: string
  /** 亚细胞定位（行列表） */
  subcellularLocations?: string[]
  /** 关键特征：结构域/跨膜/信号肽/活性位点 */
  features: UniprotFeature[]
  keywords?: string[]
}

// ─── PDB（RCSB + PDBe 合并视角）───────────────────────────────────────────────

export interface PdbEntry {
  pdbId: string
  method: string
  resolution: number | null
  title: string
  releaseDate: string
  ligands: string[]
  journal: string
  doi: string
  pubmedId: string
  organisms: string[]
  isXray: boolean
  isCryoem: boolean
  isNmr: boolean
}

export interface PdbsResult {
  entries: PdbEntry[]
  /** 搜索总命中数（含未拉取详情的） */
  totalFound: number
}

// ─── PDBe ─────────────────────────────────────────────────────────────────────

export interface PdbeMapping {
  pdbId: string
  chainId: string
  unpStart: number
  unpEnd: number
  resolution: number | null
  experimentalMethod: string | null
}

export interface PdbeCoverageResult {
  /** 0-100 */
  coveragePercent: number
  mappings: PdbeMapping[]
  /** 合并后的覆盖区间 */
  coveredRanges: Array<[number, number]>
}

// ─── BLAST ────────────────────────────────────────────────────────────────────

export interface BlastHit {
  pdbId: string
  description: string
  identity: number
  evalue: number
  queryCoverage: number
  method: string
  resolution: number | null
  /** 原始 evalue 字符串（科学计数法） */
  evalueRaw: string
}

// ─── PubMed ───────────────────────────────────────────────────────────────────

export interface LiteratureItem {
  pmid: string
  title: string
  journal: string
  year: string
  doi: string
  /** 摘要前 ~400 字（给 LLM） */
  abstractExcerpt?: string
  /** 来源为 PDB 结构主引文（结构解析文献，与结构条目直接关联） */
  fromPdb?: boolean
}

// ─── 评分 ─────────────────────────────────────────────────────────────────────

export interface ScoreItem {
  score: number
  maxScore: number
  rating: string
}

export interface Scores {
  xray: ScoreItem
  cryoem: ScoreItem
  nmr: ScoreItem
  overall: ScoreItem
}

export interface MethodStats {
  xrayCount: number
  cryoemCount: number
  nmrCount: number
  bestResolution: number | null
}

// ─── 作业汇总（前端 JobSummary）──────────────────────────────────────────────

/** BLAST 执行状态（结果页空态说明 / 报告注记的数据源） */
export type BlastStatusCode =
  | 'ok'            // 已执行且有命中
  | 'no-hits'       // 已执行但 0 命中
  | 'skipped-covered'    // 结构覆盖充分自动跳过
  | 'skipped-disabled'   // 用户关闭 BLAST
  | 'skipped-antibody'   // 检测到抗体序列，自动跳过
  | 'failed'             // 执行失败（网络/NCBI 侧）

export interface BlastStatusInfo {
  status: BlastStatusCode
  /** 附注（失败原因 / 跳过依据） */
  note?: string
}

/** BLAST 状态 → 中文描述（结果页与报告共用） */
export function describeBlastStatus(info: BlastStatusInfo | undefined | null): string {
  if (!info) return '本作业未记录 BLAST 执行状态（可能为历史版本作业）'
  switch (info.status) {
    case 'ok':
      return `已完成同源检索${info.note ? `（${info.note}）` : ''}`
    case 'no-hits':
      return '已执行同源检索，未检索到显著同源结构（E ≤ 1e-5）'
    case 'skipped-covered':
      return '结构覆盖充分（直接结构 ≥5 个且覆盖率 ≥50%），无需同源检索'
    case 'skipped-disabled':
      return '已在高级选项中关闭 BLAST 同源检索'
    case 'skipped-antibody':
      return `检测到抗体序列，已跳过同源检索${info.note ? `（依据：${info.note}）` : ''} — 抗体结构库命中众多但参考价值低` 
    case 'failed':
      return `同源检索失败${info.note ? `：${info.note}` : ''} — 可重新评估并勾选「强制 BLAST」重试`
  }
}

export interface JobSummary {
  uniprot: {
    uniprotId: string
    entryName: string
    proteinName: string
    geneNames: string[]
    organism: string
    sequenceLength: number
  }
  directPdbCount: number
  blastHitCount: number
  coverage: number
  scores: Scores
  methodStats: MethodStats
  ligandCount: number
  literatureCount: number
  imageCount: number
  durationMs: number
  /** 合并评估（UniProt+序列同靶点）时的构建信息 */
  construct?: ConstructInfo
  /** BLAST 执行状态（v1.7+ 作业存在；历史作业缺省） */
  blast?: BlastStatusInfo
  /** LLM 报告生成是否至少部分成功（v1.7+） */
  reportLlmOk?: boolean
}

// ─── docx 解析 ────────────────────────────────────────────────────────────────

export interface ParsedSequence {
  header: string
  seq: string
  length: number
  /** 序列角色（v1.7+）：antibody = 检测为抗体序列（自动跳过 BLAST）；antigen = 靶点/构建序列 */
  role?: 'antibody' | 'antigen'
}

export interface ParsedImage {
  id: string
  kind: AssetKind
  caption: string
  mime: string
  sizeKB: number
  /** 类型由 VLM 视觉识别判定（false/缺省 = 关键词分类） */
  vlmKind?: boolean
}

export interface DocxParsed {
  uniprotIds: string[]
  sequences: ParsedSequence[]
  genes: string[]
  docTextSummary: string
  images: ParsedImage[]
  /** 无法提取的图片数（格式不支持/损坏/超限），仅在有跳过时存在 */
  skippedImages?: number
  /** 提取出的客户目标/项目要求类文本（给 LLM） */
  goalHints: string[]
  /** 文档标题（首个非空行猜测，≤80 字，仅入 parsed.json 不返回前端） */
  docTitle?: string
  /** 全文文本（截断 ≤14000 字，仅入 parsed.json 供 LLM 解析，不返回前端） */
  fullText?: string
}

// ─── 评估表 LLM 智能解析（FormInsights）───────────────────────────────────

/** LLM 从评估表内容中提取的结构化要点 */
export interface FormInsights {
  /** 靶点蛋白名（如“表皮生长因子受体”） */
  proteinName?: string
  geneNames?: string[]
  organism?: string
  /** 客户目标（项目目的/交付诉求） */
  goals: string[]
  /** 待解决的科学问题 */
  scientificQuestions: string[]
  /** 实验数据/样品状态要点（无图时的文本证据，如表达量、纯度描述） */
  experimentalSummary?: string
  /** 构建/序列说明（截短边界、突变、标签等） */
  sequenceNotes?: string
  /** 同源蛋白/参考蛋白信息 */
  homologs?: string
  /** 风险与关注点 */
  keyConcerns?: string[]
  /** 解析来源：llm = 大模型提取；regex = 规则兑底 */
  source: 'llm' | 'regex'
}

// ─── 同靶点 UniProt+序列合并评估（构建信息）─────────────────────────────────

/** 提供序列 vs UniProt 全长序列的比对结果 */
export interface SequenceComparison {
  /** 0-100 近似一致性 */
  identity: number
  /** 是否判定为同一靶点（identity ≥ 85 或完全子串） */
  sameTarget: boolean
  providedLength: number
  fullLength: number
  /** 估计对应全长 1-based 起始位（锚定失败为 null） */
  start: number | null
  /** 估计对应全长 1-based 结束位 */
  end: number | null
  method: 'exact-substring' | 'anchored' | 'kmer'
}

/** 作业汇总中的构建信息（合并评估时存在） */
export interface ConstructInfo {
  providedLength: number
  fullLength: number
  identity: number
  sameTarget: boolean
  start: number | null
  end: number | null
}

// ─── 进度 ─────────────────────────────────────────────────────────────────────

export interface StageInfo {
  key: string
  label: string
  state: 'done' | 'active' | 'pending'
  percent: number
}

export interface JobProgress {
  stage: string
  percent: number
  message: string
  stages: StageInfo[]
}

export const STAGE_DEFS: Array<{ key: string; label: string }> = [
  { key: 'input', label: '输入解析' },
  { key: 'uniprot', label: 'UniProt 元数据' },
  { key: 'rcsb', label: 'PDB 结构检索' },
  { key: 'pdbe', label: 'PDBe 覆盖率' },
  { key: 'blast', label: 'BLAST 同源检索' },
  { key: 'pubmed', label: '文献检索' },
  { key: 'score', label: '评分计算' },
  { key: 'report', label: 'LLM 报告生成' },
]

/** 各阶段的进度区间（起点/终点百分比） */
export const STAGE_RANGES: Record<string, [number, number]> = {
  input: [0, 5],
  uniprot: [5, 15],
  rcsb: [15, 45],
  pdbe: [45, 55],
  blast: [55, 70],
  pubmed: [70, 80],
  score: [80, 85],
  report: [85, 100],
}

/**
 * UniProt accession 正则：
 *  - 6 位规范：[OPQ][0-9][A-Z0-9]{3}[0-9] / [A-NR-Z][0-9][A-Z][A-Z0-9]{2}[0-9]
 *  - 10 位（TrEMBL/isoform 派生，如 A0A8G0KJC2）：6 位核心 + [A-Z0-9]{3}[0-9]
 *  - isoform 后缀 -N
 * 前后 guard（lookaround）防止匹配更长字母数字 token 的片段（如 "A0A8G0KJC2X" 整体不匹配）
 */
export const UNIPROT_RE =
  /(?<![A-Z0-9])(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9][A-Z][A-Z0-9]{2}[0-9])(?:[A-Z0-9]{3}[0-9])?(?:-[0-9]+)?(?![A-Z0-9])/g

export function isValidUniprotId(s: string): boolean {
  return /^(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9][A-Z][A-Z0-9]{2}[0-9])(?:[A-Z0-9]{3}[0-9])?(?:-[0-9]+)?$/i.test(s.trim())
}

/** 氨基酸序列清洗：仅保留标准 20 种 + 少数常见修饰字符 */
export function cleanSequence(input: string): { seq: string; header: string } {
  const lines = input.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const headerLines = lines.filter(l => l.startsWith('>'))
  let body = lines.filter(l => !l.startsWith('>')).join('')
  body = body.replace(/\s+/g, '').replace(/[^ACDEFGHIKLMNPQRSTVWYBXZJUO*-]/gi, '')
  return { seq: body.toUpperCase(), header: headerLines[0]?.slice(1) ?? '' }
}

export function looksLikeProteinSequence(s: string): boolean {
  const seq = cleanSequence(s).seq
  if (seq.length < 30) return false
  // 必须主要由标准氨基酸构成（排除 DNA：T 出现率过高且无 U 偏好）
  const valid = seq.replace(/[^ACDEFGHIKLMNPQRSTVWY]/g, '').length
  return valid / seq.length >= 0.9
}
