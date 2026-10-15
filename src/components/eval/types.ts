/**
 * 与后端 API 契约对应的 TypeScript 类型定义
 * 契约来源：worklog.md「API 契约（前后端共同遵守）」
 * 注意：后端并行开发中，字段可能缺失，所有可缺失字段均按可空处理。
 */

import type { BlastStatusInfo } from '@/lib/eval/types'

export type { BlastStatusInfo, BlastStatusCode } from '@/lib/eval/types'

export type JobStatus = 'pending' | 'running' | 'done' | 'error' | 'canceled'

export type InputMode = 'uniprot' | 'sequence' | 'docx'

export type AssetKind = 'gel' | 'sec' | 'other'

export type StageState = 'done' | 'active' | 'pending'

/** POST /api/evaluate 请求体 */
export interface EvaluateOptions {
  skipBlast: boolean
  forceBlast: boolean
  maxPdb: number
}

export interface EvaluateRequest {
  mode: InputMode
  /** mode=uniprot 必填 */
  uniprot?: string
  /** mode=sequence 必填（FASTA 或裸序列）；mode=uniprot 时为可选伴随序列（合并评估）；mode=docx 选择序列时也放在此字段 */
  sequence?: string
  /** mode=docx：上传解析返回的 uploadId（契约字段名） */
  docxJobId?: string
  /** docxJobId 的兼容别名（后端并行开发可能采用此命名），与 docxJobId 同值 */
  uploadId?: string
  /** mode=docx：从评估表解析出的 UniProt */
  uniprotFromDocx?: string
  /** mode=docx：从评估表选择的序列（兼容别名），与 sequence 同值 */
  sequenceFromDocx?: string
  /** 客户目标/科学问题（可选） */
  goal?: string
  options: EvaluateOptions
}

/** POST /api/evaluate 响应 */
export interface EvaluateResponse {
  ok: boolean
  jobId: string
  error?: string
}

/** POST /api/evaluate/upload 响应中的解析结果 */
export interface ParsedSequence {
  header: string
  seq: string
  length: number
  /** 序列角色：antibody = 检测为抗体序列（自动跳过 BLAST） */
  role?: 'antibody' | 'antigen'
}

export interface ParsedImage {
  id: string
  kind: AssetKind
  caption: string
  mime: string
  sizeKB: number
  /** 类型由 VLM 视觉识别判定（缺省 = 关键词分类） */
  vlmKind?: boolean
}

export interface DocxParsed {
  uniprotIds: string[]
  sequences: ParsedSequence[]
  genes: string[]
  docTextSummary: string
  images: ParsedImage[]
  /** 无法提取的图片数（格式不支持/损坏/超限） */
  skippedImages?: number
}

export interface UploadResponse {
  ok: boolean
  uploadId: string
  parsed: DocxParsed
  error?: string
}

// ─── 评估表 LLM 智能解析 ──────────────────────────────────────

/** LLM 从评估表内容中提取的结构化要点 */
export interface FormInsights {
  proteinName?: string
  geneNames?: string[]
  organism?: string
  goals: string[]
  scientificQuestions: string[]
  experimentalSummary?: string
  sequenceNotes?: string
  homologs?: string
  keyConcerns?: string[]
  source: 'llm' | 'regex'
}

export interface InsightsResponse {
  ok: boolean
  insights?: FormInsights
  cached?: boolean
  /** 超时回退提示（规则提取结果，可重试获取 LLM 结果） */
  note?: string
  error?: string
}

// ─── LLM 引擎配置 ────────────────────────────────────────────

export interface LlmProviderLite {
  key: string
  label: string
  hint: string
  baseUrl: string
  needsKey: boolean
  defaultModel: string
  supportsModels: boolean
  modelsNote: string
}

export interface LlmConfigState {
  providerKey: string
  label: string
  baseUrl: string
  apiKeyMasked: string
  hasKey: boolean
  model: string
}

export interface LlmConfigResponse {
  ok: boolean
  active: LlmConfigState | null
  engineSummary: string
  providers: LlmProviderLite[]
}

export interface LlmModelInfo {
  id: string
  label?: string
}

export interface LlmModelsResponse {
  ok: boolean
  models?: LlmModelInfo[]
  error?: string
}

export interface LlmTestResponse {
  ok: boolean
  latencyMs?: number
  reply?: string
  error?: string
}

/** GET /api/jobs/[id] 作业详情 */
export interface StageInfo {
  key: string
  label: string
  state: StageState
  percent: number
}

export interface JobProgress {
  stage: string
  percent: number
  message: string
  stages: StageInfo[]
}

export interface UniprotInfo {
  uniprotId: string
  entryName: string
  proteinName: string
  geneNames: string[]
  organism: string
  sequenceLength: number
}

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

/** 合并评估（UniProt+序列同靶点）时的构建信息 */
export interface ConstructInfo {
  providedLength: number
  fullLength: number
  identity: number
  sameTarget: boolean
  start: number | null
  end: number | null
}

export interface JobSummary {
  uniprot: UniprotInfo
  directPdbCount: number
  blastHitCount: number
  coverage: number
  scores: Scores
  methodStats: MethodStats
  ligandCount: number
  literatureCount: number
  imageCount: number
  durationMs: number
  construct?: ConstructInfo
  /** BLAST 执行状态（v1.7+） */
  blast?: BlastStatusInfo
  /** LLM 报告生成是否至少部分成功（v1.7+） */
  reportLlmOk?: boolean
}

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

export interface BlastHit {
  pdbId: string
  description: string
  identity: number
  evalue: number
  queryCoverage: number
  method: string
  resolution: number | null
}

export interface LiteratureItem {
  pmid: string
  title: string
  journal: string
  year: string
  doi: string
  /** 来源为 PDB 结构主引文（结构解析文献，与结构条目直接关联） */
  fromPdb?: boolean
}

export interface AssetItem {
  id: string
  kind: AssetKind
  caption: string
  mime: string
  sizeKB: number
  /** 类型由 VLM 视觉识别判定（缺省 = 关键词分类） */
  vlmKind?: boolean
}

export interface JobDetail {
  id: string
  status: JobStatus
  mode: InputMode
  uniprotId: string | null
  goal: string | null
  progress: JobProgress | null
  logs: string[]
  /** 排队中：前方待执行作业数（全局串行队列位置） */
  queuePosition?: number
  summary: JobSummary | null
  pdbs: PdbEntry[] | null
  blastHits: BlastHit[] | null
  literature: LiteratureItem[] | null
  assets: AssetItem[] | null
  /** LLM 评估报告 markdown（v1.7+，结果页内联展示） */
  reportMarkdown?: string | null
  error: string | null
}

/** GET /api/jobs 列表项 */
export interface JobListItem {
  id: string
  status: JobStatus
  title: string
  uniprotId: string | null
  proteinName: string | null
  createdAt: string
  coverage: number | null
  pdbCount: number | null
  overallScore: number | null
}
