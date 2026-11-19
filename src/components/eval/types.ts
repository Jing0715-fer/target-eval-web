/**
 * 与后端 API 契约对应的 TypeScript 类型定义
 * 契约来源：worklog.md「API 契约（前后端共同遵守）」
 * 注意：后端并行开发中，字段可能缺失，所有可缺失字段均按可空处理。
 */

import type { BlastStatusInfo, TargetIdentityInfo } from '@/lib/eval/types'

export type { BlastStatusInfo, BlastStatusCode, TargetIdentityInfo } from '@/lib/eval/types'
export { MAX_PDB_UNLIMITED } from '@/lib/eval/types'

export type JobStatus = 'pending' | 'running' | 'done' | 'error' | 'canceled'

export type InputMode = 'uniprot' | 'sequence' | 'docx'

export type AssetKind = 'gel' | 'sec' | 'other'

export type StageState = 'done' | 'active' | 'pending'

/** POST /api/evaluate 请求体 */
export interface EvaluateOptions {
  skipBlast: boolean
  forceBlast: boolean
  maxPdb: number
  /** 报告模式：single = 独立报告（默认）；deferred = 数据并入合并报告（关联靶点批量） */
  reportMode?: 'single' | 'deferred'
  /** v1.23：评估范围限定（UniProt 残基编号，1-based 闭区间）；范围重叠结构优先展示，无重叠折叠保留（v2.29） */
  range?: [number, number]
  /** v2.29：结构域名提示（评估表不写区间而写域名时，如「胞外域」/「kinase domain」）—
   *  管线内与 UniProt domain 划分匹配推导评估区间 */
  rangeHint?: string
}

export interface EvaluateRequest {
  mode: InputMode
  /** mode=uniprot 必填 */
  uniprot?: string
  /** mode=sequence 必填（FASTA 或裸序列）；mode=uniprot 时为可选伴随序列（合并评估）；mode=docx 选择序列时也放在此字段 */
  sequence?: string
  /** v2.16：序列标签头（FASTA > 头 / 评估表序列标签 — 序列靶点命名证据；含 UniProt accession 时直接归属） */
  sequenceHeader?: string
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
  /** 批次关系说明（非关联批量：注入报告说明独立/复合物定位） */
  batchNote?: string
  /** ≥90% 高一致同源组委托（v1.11）：组内首个提交 BLAST 的作业为代表，其余共享结果 */
  homologBlast?: BlastGroup
  /** v2.0：配体输入（名称/分子式/三位 ID / 上传文件提取线索，≤8 条） */
  ligands?: Array<{ raw: string; source?: 'text' | 'file' | 'eval-table'; fileName?: string }>
  /** v2.4 无状态部署：评估表数据内联携带（全文/图片/要点；服务器磁盘不跨请求保留） */
  evalTable?: {
    fullText?: string
    goalHints?: string[]
    images?: Array<{
      id: string
      kind: AssetKind
      caption: string
      mime: string
      sizeKB: number
      vlmKind?: boolean
      dataUri?: string
    }>
    insights?: FormInsights
  }
  /** v2.19：用户本地引擎配置（浏览器 localStorage → 请求内联携带；服务端不落盘） */
  llm?: {
    providerKey: string
    baseUrl?: string
    apiKey?: string
    model: string
  }
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
  /** 直传（无状态兼容）模式下内联返回的图片数据（data URI）；优先于 /api/assets/{id} */
  dataUri?: string
}

export interface DocxParsed {
  uniprotIds: string[]
  sequences: ParsedSequence[]
  genes: string[]
  docTextSummary: string
  images: ParsedImage[]
  /** 无法提取的图片数（格式不支持/损坏/超限） */
  skippedImages?: number
  /** 直传（无状态）模式下随响应返回的目标提示（供后续 LLM 解析内联携带） */
  goalHints?: string[]
}

export interface UploadResponse {
  ok: boolean
  uploadId: string
  parsed: DocxParsed
  error?: string
  /** v2.3：直传（无状态回退）模式 — 服务器不保留会话，后续 insights 需内联携带全文 */
  stateless?: boolean
  /** v2.3：直传模式随响应返回全文（≤14KB，供 LLM 智能解析内联使用） */
  fullText?: string
}

// ─── 靶点关系判断（v1.8 批量评估）───────────────────────────

export type TargetRelationType = 'complex' | 'antibody-antigen' | 'fusion' | 'homologous' | 'pathway' | 'independent' | 'other'

/** 家族序列一致性证据（v1.10 服务端比对，随 judgment 返回） */
export interface HomologPair {
  a: string
  b: string
  identity: number
  method: string
}

/** ≥90% 高一致同源组（v1.11 BLAST 委托）：组内仅家族代表执行一次检索，其余共享结果 */
export interface BlastGroup {
  groupKey: string
  members: string[]
  minIdentity: number
}

/** 评估表序列归属（v1.10） */
export interface SequenceAttribution {
  index: number
  header: string
  length: number
  kind: 'construct' | 'homolog' | 'antibody' | 'unmatched'
  uniprotId?: string
  identity?: number
  start?: number | null
  end?: number | null
  note: string
}

export interface RelationJudgment {
  /** 是否建议合并为一份报告 */
  related: boolean
  relationType: TargetRelationType
  confidence: 'high' | 'medium' | 'low'
  /** 判断依据（≤300 字） */
  rationale: string
  /** 对结构解析策略的建议 */
  strategy: string
  /** 判断失败时的降级说明 */
  error?: string
  /** 家族序列一致性证据（v1.10） */
  homologPairs?: HomologPair[]
  /** ≥90% 高一致组（v1.11）：组内仅家族代表执行一次 BLAST，其余成员委托共享结果 */
  blastGroups?: BlastGroup[]
}

/** 关系类型 → 中文描述 + 图标语义（前端展示用） */
export function describeRelationType(t: TargetRelationType): string {
  switch (t) {
    case 'complex': return '复合物亚基（物理相互作用）'
    case 'antibody-antigen': return '抗体-抗原配对'
    case 'fusion': return '融合构建（多结构域串联）'
    case 'homologous': return '同源蛋白家族（直系/旁系同源）'
    case 'pathway': return '同通路/功能相关'
    case 'independent': return '相互独立'
    case 'other': return '其他关联'
  }
}

/** 合并报告各靶点结构化数据（v1.11 — PDB/同源结构/文献列表带 UniProt 归属） */
export interface MergedTargetLite {
  jobId: string
  uniprotId?: string
  proteinName: string
  /** v2.31：评估区间归属的 nsp 标注（聚合蛋白截短 — 展示名追加；历史报告缺省） */
  nspLabel?: string
  geneNames: string[]
  organism: string
  sequenceLength: number
  coveragePercent: number
  directPdbCount: number
  blastHitCount: number
  blastStatus?: BlastStatusInfo
  directPdbs: PdbEntry[]
  blastHits: BlastHit[]
  literature: LiteratureItem[]
  /** v1.24：聚集形式（寡聚态）分析；历史作业缺省 */
  oligomer?: OligomerAnalysis
  /** v1.26：分子量增重策略分析（仅 applicable 时有意义）；历史作业缺省 */
  mwAugment?: MwAugmentAnalysis | null
  /** v2.9：各靶点单独简报（与后端 MergedTargetLite 同步 — 历史报告缺省降级展示） */
  scores?: Scores
  methodStats?: MethodStats
  ligandCount?: number
  literatureCount?: number
  coverageText?: string
  gapText?: string
  construct?: ConstructInfo
  /** v2.29：评估区间 + 范围外结构（PdbTable/BlastTable 折叠区用；历史报告缺省） */
  range?: [number, number]
  rangeSource?: string
  rangeOutsidePdbs?: PdbEntry[]
  rangeOutsideBlastHits?: BlastHit[]
  /** v2.9：AlphaFold 预测结构元数据（交互 3D 视图见下载的 HTML 报告） */
  alphafold?: AlphafoldSummaryInfo
  /** v2.15：ESMFold 兜底预测元数据（AFDB 无收录时前端简报卡展示） */
  esmfold?: EsmfoldSummaryInfo | null
  /** v2.16：序列靶点身份识别（无 UniProt 归属靶点的命名证据链 — 分组头/简报卡展示） */
  targetIdentity?: TargetIdentityInfo | null
}

/** 合并评估报告（关联靶点批量生成） */
export interface BatchReportInfo {
  id: string
  jobIds: string[]
  relation: RelationJudgment
  /** 评估表序列归属（v1.10，历史报告可能缺失） */
  sequenceAttribution?: SequenceAttribution[] | null
  /** 共有结构（v1.22：同一 PDB 覆盖多个输入 UniProt；历史报告可能缺失） */
  sharedStructures?: SharedStructure[] | null
  /** v1.14：LLM 生成的描述性标题 */
  title?: string
  markdown: string
  llmOk?: boolean
  errors?: string[]
  createdAt?: string
  /** 各靶点结构化数据（v1.11；历史报告/作业被清理时为空） */
  targets?: MergedTargetLite[]
  /** 异步生成状态（v1.12：running = 后台生成中，前端轮询直到终态） */
  status?: 'running' | 'done' | 'error'
  /** 生成失败原因（status = error 时） */
  error?: string | null
  /** v2.37：本报告来自浏览器本地缓存副本（服务端实例已回收，仅回看兜底） */
  fromCache?: boolean
}

/** 合并报告历史列表项（v1.13：批量评估历史记录） */
export interface BatchReportListItem {
  id: string
  jobIds: string[]
  title: string
  status: 'running' | 'done' | 'error'
  hasContent: boolean
  createdAt: string
}

// ─── 评估表 LLM 智能解析 ──────────────────────────────────────

/** v2.24 非标准评估表兼容：蛋白名称 → UniProt accession 解析命中（UniProt REST 权威结果） */
export interface ResolvedUniprot {
  /** 输入名称（如 TL1A） */
  name: string
  accession: string
  entryName?: string
  proteinName?: string
  geneNames?: string[]
  organism?: string
  /** Swiss-Prot reviewed 条目 */
  reviewed: boolean
  /** 命中字段：gene / protein / text（全文兜底） */
  matchedOn: 'gene' | 'protein' | 'text'
  seqLength?: number
  /** 备选命中（最多 2 条：近缘物种 / 未评审异构体） */
  alternates?: Array<{ accession: string; proteinName?: string; organism?: string; reviewed: boolean }>
}

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
  /** v2.3：文档中提及的配体/化合物（LLM 提取，最多 8 条 — 自动填入配体输入） */
  ligands?: string[]
  /** v2.24：提取出的靶点名称（基因符号/别名，≤12 条） */
  targetNames?: string[]
  /** v2.24：名称→accession 解析命中（评估表无 UniProt/序列时由 UniProt REST 解析） */
  resolvedUniprots?: ResolvedUniprot[]
  /** v2.24：未能解析出 UniProt 的名称（提示手动补填） */
  unresolvedNames?: string[]
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
  /** v2.31：评估区间归属的 nsp 标注（聚合蛋白截短 — 展示名追加；历史作业缺省） */
  nspLabel?: string
  /** v2.31：PTM/Processing 加工条目（后端摘要携带 — 前端展示名计算用；历史作业缺省） */
  processingChains?: Array<{ name: string; begin: number; end: number }>
}

export interface ScoreItem {
  score: number
  maxScore: number
  rating: string
}

/** v1.25：聚集形式对三方法的调整明细（评分卡展示；历史作业缺省） */
export interface OligomerAdjustInfo {
  label: string
  stoichiometry: string
  confidence: 'high' | 'medium' | 'low'
  xray: number
  cryoem: number
  nmr: number
  note: string
}

export interface Scores {
  xray: ScoreItem
  cryoem: ScoreItem
  nmr: ScoreItem
  overall: ScoreItem
  /** v1.25：聚集形式调整明细 */
  oligomerAdjust?: OligomerAdjustInfo
  /** v1.26：分子量增重调整明细（小分子量靶点） */
  mwAugmentAdjust?: MwAugmentAdjustInfo
  /** v1.30：互作复合物证据调整明细（无直接结构时） */
  interactionAdjust?: InteractionAdjustInfo
  /** v2.18：LLM 智能复核调整明细（复核失败/跳过时缺省 — 系统规则分即终分） */
  llmAdjust?: LlmScoreAdjustInfo
}

/** v2.18：LLM 智能复核调整明细（score-llm.ts 产出并应用；评分卡展示） */
export interface LlmScoreAdjustInfo {
  /** AI 复核是否实际调整了分数（false = 复核确认维持系统分） */
  applied: boolean
  /** 三方法有效调整量（钳制后实际变化值；0 = 维持） */
  xray: number
  cryoem: number
  nmr: number
  /** 总体有效调整量（总体分由三方法最大值推导） */
  overall: number
  /** 复核置信度 */
  confidence: 'high' | 'medium' | 'low'
  /** 逐方法复核意见（一句话依据 — delta 为 0 时为「维持理由」） */
  notes: { xray: string; cryoem: string; nmr: string; overall: string }
  /** 复核引擎（页脚元数据展示） */
  engine?: string
  /** 复核耗时 ms */
  durationMs: number
}

export interface MethodStats {
  xrayCount: number
  cryoemCount: number
  nmrCount: number
  bestResolution: number | null
}

// ─── 互作复合物证据（v1.30，无直接结构时）──────────────────────────────────

/** 互作复合物（Complex Portal curated）中的一个组分 */
export interface InteractionComponent {
  accession: string
  name: string
  description: string
  stoichiometryText: string
  stochMax: number | null
  isTarget: boolean
  lengthAa?: number | null
  kda?: number | null
  pdbCount: number
  representativePdbs: PdbEntry[]
  /** 该组分参与的共有结构 PDB IDs（同一 PDB 含 ≥2 个复合物组分） */
  sharedPdbIds?: string[]
  /** 该组分的单独结构数（PDB 仅含本组分） */
  soloPdbCount?: number
  /** 单独结构代表（按分辨率 ≤3 个） */
  soloRepresentativePdbs?: PdbEntry[]
  /** v1.31 单独结构全量列表（按分辨率升序，折叠展开可见） */
  soloPdbs?: PdbEntry[]
  /** v1.31 soloPdbs 之外未拉取详情的单独结构数 */
  soloPdbOmitted?: number
}

/** 共有结构（同一 PDB 含 ≥2 个复合物组分 — 组装先例，最直接的结构证据） */
export interface InteractionSharedPdb {
  pdbId: string
  componentNames: string[]
  componentCount: number
  method: string
  isXray: boolean
  isCryoem: boolean
  isNmr: boolean
  resolution: number | null
  title: string
  /** v1.31 释放日期 */
  releaseDate?: string
  /** v1.31 主引文期刊缩写 */
  journal?: string
  /** v1.31 主引文 PubMed ID（空串表示无） */
  pubmedId?: string
  /** v1.31 该 PDB 中复合物组分之外的其他蛋白组分基因名（如 FBXO22） */
  extraComponents?: string[]
  /** v1.31 extraComponents 对应 UniProt accession（悬停提示） */
  extraAccessions?: string[]
}

/** Complex Portal curated 复合物 */
export interface InteractionComplexInfo {
  complexAc: string
  name: string
  systematicName?: string
  assembly: string | null
  components: InteractionComponent[]
  componentsWithStructure: number
  totalPdb: number
  assemblyKda: number | null
  sharedPdbs?: InteractionSharedPdb[]
  sharedPdbTotal?: number
  /** v1.31 sharedPdbs 之外未拉取详情的共有结构数 */
  sharedPdbOmitted?: number
  soloPdbTotal?: number
}

/** v2.33 binary 互作证据分级：complex = 复合物结构；homolog = 同源复合物结构；experimental = 仅实验互作证据（低可信） */
export type BinaryEvidenceLevel = 'complex' | 'homolog' | 'experimental'

/** binary 互作伙伴的结构证据（IntAct） */
export interface InteractionBinaryInfo {
  accession: string
  geneName?: string
  pdbCount: number
  representativePdbs: PdbEntry[]
  /** v2.33 互作可信度分级（历史作业缺省按 experimental 处理） */
  evidenceLevel?: BinaryEvidenceLevel
  /** 复合物/同源复合物证据结构代表（≤3 个；历史作业缺省） */
  evidencePdbs?: PdbEntry[]
  /** 证据结构总数（历史作业缺省 0） */
  evidencePdbCount?: number
  /** 证据说明（历史作业缺省） */
  evidenceNote?: string
}

/** 互作复合物证据分析（无直接结构时作为评估依据） */
export interface InteractionAnalysis {
  applicable: boolean
  hasEvidence: boolean
  subunitNote?: string
  complexes: InteractionComplexInfo[]
  binaryPartners: InteractionBinaryInfo[]
  summary: string
  notes: string[]
}

/** 互作复合物证据对三方法的调整明细 */
export interface InteractionAdjustInfo {
  complexAc: string
  complexName: string
  componentsWithStructure: number
  assemblyKda: number | null
  level: 'curated' | 'binary'
  xray: number
  cryoem: number
  nmr: number
  note: string
}

// ─── 聚集形式（寡聚态）分析（v1.24）────────────────────────────────────

export type OligomerCategory = 'monomer' | 'homo-oligomer' | 'hetero-complex' | 'unknown'

export interface OligomerEvidence {
  source: 'pdb-title' | 'pdb-stoichiometry' | 'blast-title' | 'uniprot-subunit' | 'uniprot-interaction' | 'literature'
  ref: string
  text: string
  state: { category: OligomerCategory; copies: number | null; term: string }
}

/** 蛋白聚集形式（寡聚态）分析结果（与后端 lib/eval/types.ts 契约一致） */
export interface OligomerAnalysis {
  /** v1.25：判定标签（如 "同源四聚体（homotetramer）"；历史作业缺省） */
  label?: string
  summary: string
  category: OligomerCategory
  stoichiometry: string
  confidence: 'high' | 'medium' | 'low'
  evidence: OligomerEvidence[]
  notes: string[]
}

// ─── 分子量增重策略分析（v1.26，小分子量靶点）────────────────────

export interface MwComponent {
  name: string
  uniprotId?: string
  lengthAa: number
  kda: number
  isTarget: boolean
}

export interface MwComplex {
  pdbId: string
  title: string
  method: string
  resolution: number | null
  components: MwComponent[]
  totalKda: number
  basis: 'assembly' | 'entity'
  note: string
}

export interface MwAugmentOption {
  name: string
  addKda: string
  note: string
}

export interface MwConflictNote {
  level: 'aligned' | 'caution' | 'conflict'
  text: string
}

/** v1.27：同源结构形成的大复合物（BLAST 扩展检索） */
export interface MwHomologComplex {
  pdbId: string
  title: string
  method: string
  resolution: number | null
  /** BLAST 同源 identity（%） */
  identity: number
  /** 同源复合物自身装配总分子量（kDa） */
  totalKda: number
  /** 按靶点单体换算的估计装配分子量（kDa） */
  estimatedKda: number
  basis: 'assembly' | 'entity'
  /** 组分摘要 */
  componentSummary: string
  /** 推断说明 */
  note: string
}

/** 分子量增重策略分析结果（与后端 lib/eval/types.ts 契约一致） */
export interface MwAugmentAnalysis {
  applicable: boolean
  monomerKda: number
  zoneNote: string
  assemblyKda: number | null
  assemblyBasis: string
  assemblyPath: 'oligomer' | 'complex' | 'homolog-complex' | 'partner' | null
  /** v2.33：partner 装配路径证据级别（历史作业缺省） */
  assemblyEvidence?: BinaryEvidenceLevel | null
  complexes: MwComplex[]
  /** v1.27：同源结构形成的大复合物（历史作业缺省） */
  homologComplexes?: MwHomologComplex[]
  /** v1.27：同源扩展检索说明（历史作业缺省） */
  homologSearchNote?: string
  partners: Array<{ accession: string; geneName?: string; proteinName?: string; lengthAa?: number; kda?: number; evidenceLevel?: BinaryEvidenceLevel; evidencePdbIds?: string[] }>
  options: MwAugmentOption[]
  conflicts: MwConflictNote[]
  notes: string[]
}

/** v1.26：分子量增重调整明细（评分卡展示） */
export interface MwAugmentAdjustInfo {
  monomerKda: number
  assemblyKda: number | null
  /** v1.27：装配路径（历史作业缺省） */
  assemblyPath?: 'oligomer' | 'complex' | 'homolog-complex' | 'partner' | null
  xray: number
  cryoem: number
  nmr: number
  note: string
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
  /** v2.27：实际生效的评估范围（UniProt 残基编号 — 手动或构建比对/表格区间推导；v2.29 域名匹配亦可；历史作业缺省） */
  range?: [number, number]
  /** v2.29：区间来源标签（手动指定 / 构建比对推导 / 结构域匹配（UniProt 注释）） */
  rangeSource?: string
  /** v2.29：与区间无链范围重叠的 PDB 结构（折叠保留展示 — 灰色行；上限 200） */
  rangeOutsidePdbs?: PdbEntry[]
  /** v2.29：与区间无重叠的 BLAST 同源命中（折叠保留展示；上限 100） */
  rangeOutsideBlastHits?: BlastHit[]
  construct?: ConstructInfo
  /** BLAST 执行状态（v1.7+） */
  blast?: BlastStatusInfo
  /** 聚集形式（寡聚态）分析（v1.24+；历史作业缺省） */
  oligomer?: OligomerAnalysis
  /** 分子量增重策略分析（v1.26+；历史作业缺省；后端存档含 applicable=false） */
  mwAugment?: MwAugmentAnalysis | null
  /** 互作复合物证据分析（v1.30+；无直接结构时有证据时展示） */
  interaction?: InteractionAnalysis
  /** LLM 报告生成是否至少部分成功（v1.7+） */
  /** v2.0：配体归一与研究数据（输入/评估表识别 → 三位 ID + 含该配体结构） */
  ligands?: LigandResolution[]
  /** v2.0：AlphaFold 预测信息（报告头图元数据） */
  alphafold?: AlphafoldSummaryInfo
  /** v2.15：ESMFold 公共 API 兜底预测信息（AFDB 无收录/纯序列输入时） */
  esmfold?: EsmfoldSummaryInfo
  reportLlmOk?: boolean
  /** 报告已延迟：数据并入合并评估报告，无独立报告（v1.8+） */
  reportDeferred?: boolean
  /** 批次关系说明（v1.8+ 非关联批量） */
  batchNote?: string
  /** v2.16：靶点身份识别证据链（序列输入无 UniProt 归属时；历史作业缺省） */
  targetIdentity?: TargetIdentityInfo
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
  /** 该结构覆盖的 UniProt 残基编号范围（如 "A=695-1022"；旧记录无此字段） */
  chainRanges?: string
}

// ─── 配体研究数据（v2.0；与后端 lib/eval/ligand.ts 契约一致）──────────────────

export interface LigandStructureLite {
  pdbId: string
  title: string
  method: string
  resolution: number | null
  releaseDate: string
  /** 同时是本靶点的直接结构（RCSB UniProt 检索交集） */
  alsoTarget: boolean
}

export interface LigandResolution {
  raw: string
  source: 'text' | 'file' | 'eval-table'
  fileName?: string
  ok: boolean
  compId: string
  name: string
  formula: string
  weight: number | null
  /** 归一策略（direct-id / alias / pdb-search / pubchem / llm / llm+pdb-search / llm+pubchem） */
  strategy: string
  error?: string
  /** 含该配体的结构总数 */
  totalStructures: number
  /** 展示用结构列表（≤12，按分辨率升序） */
  structures: LigandStructureLite[]
  /** v2.2：PubChem 识别详情（无 PDB 对应组分时仍能给出分子式/MW/名称/CID） */
  pubchem?: { cid: number; iupacName?: string; smiles?: string }
  /** v2.7：配体详情（PubChem 计算性质 + 2D 结构式 dataUri） */
  detail?: LigandDetail
}

/** v2.7：PubChem 计算性质 + 2D 化学结构式（服务端 enrichLigandDetail 产出） */
export interface LigandDetail {
  cid?: number
  iupacName?: string
  xlogp?: number
  tpsa?: number
  hBondDonor?: number
  hBondAcceptor?: number
  rotatableBonds?: number
  heavyAtoms?: number
  exactMass?: number
  charge?: number
  inchiKey?: string
  canonicalSmiles?: string
  /** 2D 化学结构式（PubChem PNG，data URI） */
  structure2d?: string
}

export interface AlphafoldSummaryInfo {
  available: boolean
  modelId?: string
  /** 平均 pLDDT（0-100） */
  globalPlddt?: number | null
  version?: number
  fracVeryHigh?: number | null
  note?: string
}

/** v2.15：ESMFold 公共 API 兜底预测元数据（前端镜像 — 与后端 types 同构） */
export interface EsmfoldSummaryInfo {
  available: boolean
  modelId?: string
  /** 平均 pLDDT（0-100，已从 0-1 标度归一） */
  globalPlddt?: number | null
  fracVeryHigh?: number | null
  /** 预测序列长度 */
  sequenceLength?: number
  note?: string
}

// ─── 共有结构（多靶点交集）──────────────────────────────────────────────────────

/** 共有结构对单个靶点的覆盖信息 */
export interface SharedStructureCoverage {
  uniprotId: string
  proteinName: string
  /** 该 PDB 覆盖此 UniProt 的链范围（如 "A=695-1022"） */
  chainRanges?: string
}

/** 共有结构 — 同一 PDB 条目覆盖 ≥2 个输入 UniProt 的结构（复合物/共结晶等） */
export interface SharedStructure {
  pdbId: string
  method: string
  resolution: number | null
  title: string
  releaseDate: string
  ligands: string[]
  journal: string
  pubmedId: string
  isXray: boolean
  isCryoem: boolean
  isNmr: boolean
  coverage: SharedStructureCoverage[]
  targetCount: number
}

export interface BlastHit {
  pdbId: string
  description: string
  identity: number
  evalue: number
  queryCoverage: number
  /** v1.23：BLAST 命中在查询序列上的起止残基位置（1-based，闭区间）；旧记录可能缺失 */
  queryFrom?: number
  queryTo?: number
  method: string
  resolution: number | null
  /** v1.31 主引文 PubMed ID（报告「文献」列直跳） */
  pubmedId?: string
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
  /** v2.4 无状态同步评估：图片 data URI 内联（优先于 /api/assets/{id}） */
  dataUri?: string
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
  /** v1.31 单靶点 HTML 报告是否已生成（web 端内嵌与下载同一份 HTML，保证样式一致） */
  reportAvailable?: boolean
  /** v2.4 无状态同步评估：HTML 报告内联返回（磁盘不跨请求保留，结果页 srcDoc 直接渲染/下载用 Blob） */
  reportHtml?: string | null
  /** v2.4：本作业由无状态同步评估产生（前端历史/下载走内联数据） */
  stateless?: boolean
  /** v2.36：本详情来自浏览器本地缓存副本（服务端实例已回收，仅回看兑底） */
  fromCache?: boolean
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
  /** v2.36：本地缓存回退条目（服务端实例已回收） */
  fromCache?: boolean
}

// ─── v2.22 高通量评估 ───────────────────────────────────────────────────────

/** v2.23.1：Excel 导入的序列靶点（行缺 UniProt ID 时按序列评估） */
export interface HtSeqTarget {
  /** 构建标签头（如「His-TEV-NTRC-83-548」；裸序列为空串） */
  header: string
  seq: string
  length: number
  /** v2.27 行内构建区间 · v2.37 起序列靶点不再填充（接口兼容保留）：序列靶点的
   *  评估区间由管线在 BLAST 归属后推导（构建比对 / BLAST nr HSP），不从 Excel 行文本配对 */
  range?: [number, number]
}

/** 高通量运行的一组内单个靶点（作业）状态 */
export interface HTGroupItemState {
  key: string
  /** 展示标签（UniProt ID 或序列构建头摘要） */
  label: string
  /** v2.27：该靶点的评估区间（UniProt 残基编号；提交时随 options.range — 截短构建感知） */
  range?: [number, number]
  /** v2.29：结构域名提示（如胞外域/kinase domain — 提交时随 options.rangeHint，
   *  管线内与 UniProt domain 划分匹配推导区间） */
  domainHint?: string
  /** v2.23.1 序列靶点：提交 mode=sequence 作业的原始序列（无则 UniProt 靶点） */
  sequence?: string
  /** v2.23.1 序列靶点：构建标签头（评估表/Excel 序列命名证据） */
  sequenceHeader?: string
  jobId?: string
  /** pending = 尚未提交作业（未进入并发窗口）；running = 已提交未终态；
   *  skipped = v2.38 用户选择跳过 / zip 导入既有报告（不评估，计入已处理） */
  status: 'pending' | 'running' | 'done' | 'error' | 'canceled' | 'skipped'
  error?: string
  /** v2.38：跳过原因备注（如「已导入 xxx.zip 的既有报告」；手动跳过时缺省） */
  skipNote?: string
}

/** 高通量运行的一组（组分隔符「;」切出的单元）：组内按复合物批量评估，单独出报告 */
export interface HTGroupState {
  /** 组序号（0-based，展示 +1） */
  index: number
  /** 组内 UniProt ID 列表（序列兜底组为空数组 — items 全为序列靶点） */
  targets: string[]
  /** v2.23.1 序列兜底组的序列靶点（恢复运行时重新提交未启动项所需） */
  seqTargets?: HtSeqTarget[]
  items: HTGroupItemState[]
  /** pending → judging → evaluating → merging → done；paused = 组间暂停标记；
   *  canceled = v2.38 手动停止时未开始的组（可恢复 — resume 重置为 pending） */
  status: 'pending' | 'judging' | 'evaluating' | 'merging' | 'done' | 'paused' | 'canceled'
  relation?: RelationJudgment | null
  relationError?: string
  /** 合并报告 id（组内 ≥2 靶点成功后生成；报告本体经 /api/evaluate/batch-report?id= 回看，不落 localStorage） */
  mergedReportId?: string
  mergedError?: string
  startedAt?: number
  finishedAt?: number
}

export type HTRunStatus = 'running' | 'paused' | 'done' | 'interrupted' | 'stopped'

/** 一次高通量运行（持久化到 localStorage te_ht_runs_v1，保留多份历史） */
export interface HTRunState {
  id: string
  createdAt: number
  goal?: string
  options: EvaluateOptions
  ligands?: EvaluateRequest['ligands']
  groups: HTGroupState[]
  /** 当前推进到的组下标（恢复运行的断点） */
  currentIndex: number
  status: HTRunStatus
  pausedReason?: string
  pausedAt?: number
  /** 手动重新开始次数（配额恢复后续跑） */
  resumedCount: number
  finishedAt?: number
  totalTargetCount: number
  /** v2.28：运行完成后的统计看板 id（评分统计 + AI 整体可行性报告；回看/zip 归档用） */
  dashboardId?: string
  /** v2.28：看板生成失败原因（null/undefined = 正常；「__done__」= 无可统计靶点已跳过） */
  dashboardError?: string
  /** v2.36：汇总报告生成中（完成横幅的「生成中」态 — 终态后由 dashboardId/dashboardError 接替） */
  dashboardPending?: boolean
  /** v2.36：原始 Excel 行快照（汇总报告「原表内容」列；导入时留存） */
  excelRows?: Array<{ label: string; text: string }>
  /** v2.38：zip 导入备注（导入了几份报告、跳过了几个靶点 — 结果页提示用） */
  importedNote?: string
}

/** 高通量评估启动载荷（InputPanel 高通量 Tab → startRun） */
export interface HTStartPayload {
  groups: string[][]
  /** v2.27：与 groups 逐组逐位对齐的评估区间（Excel 导入解析/手动「:起-止」后缀；无则不过滤） */
  groupRanges?: Array<Array<[number, number] | undefined>>
  /** v2.29：与 groups 逐组逐位对齐的结构域名提示（评估表不写区间而写域名时；
   *  管线内与 UniProt domain 划分匹配推导区间） */
  groupDomainHints?: Array<Array<string | undefined>>
  /** v2.23.1 序列兜底组（Excel 行缺 UniProt 但有构建序列；每行一组，逐序列独立评估） */
  seqGroups?: HtSeqTarget[][]
  /** v2.36：原始 Excel 行快照（汇总报告「原表内容」列；label+折叠文本） */
  excelRows?: Array<{ label: string; text: string }>
  /** v2.38：启动时的靶点选择（true = 跳过不评估；与 groups/seqGroups 逐组逐位对齐。
   *  未选中项仍入运行记录（status=skipped，可恢复评估），便于事后勾选补跑） */
  skipFlags?: { groups?: boolean[][]; seqGroups?: boolean[][] }
  goal?: string
  ligands?: EvaluateRequest['ligands']
  options: EvaluateOptions
}
