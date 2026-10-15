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
}

// ─── docx 解析 ────────────────────────────────────────────────────────────────

export interface ParsedSequence {
  header: string
  seq: string
  length: number
}

export interface ParsedImage {
  id: string
  kind: AssetKind
  caption: string
  mime: string
  sizeKB: number
}

export interface DocxParsed {
  uniprotIds: string[]
  sequences: ParsedSequence[]
  genes: string[]
  docTextSummary: string
  images: ParsedImage[]
  /** 提取出的客户目标/项目要求类文本（给 LLM） */
  goalHints: string[]
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

/** UniProt accession 正则（6位规范 / 10位 isoform） */
export const UNIPROT_RE = /[OPQ][0-9][A-Z0-9]{3}[0-9](?:-[0-9]+)?|[A-NR-Z][0-9]([A-Z][A-Z0-9]{2}[0-9])(?:-[0-9]+)?/g

export function isValidUniprotId(s: string): boolean {
  return /^[OPQ][0-9][A-Z0-9]{3}[0-9]$/.test(s) || /^[A-NR-Z][0-9][A-Z][A-Z0-9]{2}[0-9]$/.test(s)
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
