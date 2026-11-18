/**
 * 评估主管线 — 阶段化数据收集 + 评分 + LLM 报告生成 + 持久化。
 * 全流程受 AbortSignal 控制；进度按 STAGE_RANGES 区间映射。
 *
 * v1.8 编排（用户反馈「BLAST 轮询 5 分钟超时 + 等待期间空转」）：
 *  - BLAST 提交前置：阶段 2 确定 BLAST 序列后立即提交（不阻塞），
 *    RCSB / PDBe / PubMed 在 NCBI 计算期间并行推进
 *  - BLAST 收集后置：文献检索完成后再收集结果 — 「仍在运行不判超时失败」，
 *    仅 NCBI FAILED / RID 过期 / 网络长期不可达才失败
 *  - deferred 报告模式：关联靶点批量评估时跳过单靶点 LLM 报告，
 *    数据并入批次合并报告（见 report-merged.ts）
 *
 * v2.6 可续跑分段执行（无状态网关部署 — 网关 ~90s 切断长连接）：
 *  - runPipelineSegment(input, cb, checkpoint?)：带 cb.deadline 时间预算执行；
 *    到点在阶段边界/子步骤交还 { done:false, checkpoint }，由调用方（同步路由）
 *    把 checkpoint 返回前端，前端立刻携 checkpoint 再发一段继续 —— 作业在
 *    多个 ≤60s 的短请求中推进，不再被网关切断。
 *  - 状态全部 JSON 可序列化（PipelineState）；实验图片 dataUri 不入 checkpoint
 *    （前端每段随 evalTable 重复携带，服务端每段开头重派生 deriveInput 恢复）。
 *  - BLAST 轮询跨段续跑（RID 在 NCBI 侧存活，pollState 随 checkpoint 往返）；
 *    PDB 详情拉取、配体归一、LLM 报告段均支持增量续跑。
 *  - runPipeline（无 deadline）：有状态部署/异步作业路径，一次跑完（行为与 v2.5 一致）。
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { db } from '@/lib/db'
import { fetchUniprotInfo, identifyUniprotBySequence, normalizeSequenceInput } from './uniprot'
import { fetchPdbEntries, fetchPdbIdsForUniprot } from './rcsb'
import { fetchPdbeCoverage, describeCoverage, uncoveredRanges, restrictCoverageToRange, uncoveredRangesWithin } from './pdbe'
import { submitBlastPdb, collectBlastPdbWithRescue, enrichBlastHits, runBlastWithRetry, submitBlastNr, collectBlastNr, type BlastPollState, type BlastNrHit } from './blast'
import { searchRcsbHomologs, fetchUniprotForEntryEntity } from './rcsb-search'
import { buildLiteratureQuery, searchPubmed, fetchPubmedByPmids } from './pubmed'
import { computeScores } from './score'
import { reviewScoresWithLlm, applyLlmScoreAdjust } from './score-llm'
import { analyzeOligomericState } from './oligomer'
import { analyzeInteractionEvidence } from './interaction'
import { analyzeMwAugmentation } from './mw-augment'
import { generateReportSections, REPORT_CHAPTERS, type ReportPart } from './report'
import { renderReportHtml } from './report-html'
import { compareSequences, describeComparison } from './seq-compare'
import { detectAntibody } from './antibody'
import { getEngineSummary } from './llm-provider'
import { splitPdbsByRange, splitBlastByRange, type ResidueRange } from './range-filter'
import { matchDomainHint } from './domain-range'
import { extractLigandsFromText, extractLigandCandidatesFromText, fetchLigandStructures, normalizeLigandRaw, resolveLigandInput, enrichLigandDetail, type LigandInput, type LigandResolution } from './ligand'
import { isBiologicMention, isLikelyCloneNumber } from './ligand-parse'
import { alphafoldStructureFor, alphafoldFigureCached, alphafoldMetaFor } from './alphafold'
import { cleanEsmfoldSequence, esmfoldStructureFor, esmfoldFailNote, loadCachedEsmfoldModel, ESMFOLD_MAX_AA, ESMFOLD_EMBED_MAX_BYTES } from './esmfold'
import { isValidUniprotId, MAX_PDB_UNLIMITED, describeTargetIdentitySource, type BlastGroup, type BlastHit, type BlastStatusInfo, type EvaluationOptions, type FormInsights, type InputMode, type InteractionAnalysis, type JobSummary, type LiteratureItem, type MwAugmentAnalysis, type OligomerAnalysis, type ParsedImage, type PdbEntry, type PdbeCoverageResult, type AlphafoldSummaryInfo, type EsmfoldSummaryInfo, type SequenceComparison, type TargetIdentityInfo, type UniprotInfo } from './types'

/** v2.4 无状态（函数计算）部署：评估表数据由前端内联携带（服务器磁盘不跨请求保留） */
export interface InlineEvalTable {
  fullText?: string
  goalHints?: string[]
  images?: ParsedImage[]
  insights?: FormInsights
}

export interface PipelineInput {
  jobId: string
  mode: InputMode
  uniprot?: string
  sequence?: string
  /** v2.16：序列标签头（FASTA > 头 / 评估表序列标签 — 靶点命名证据 + 头内 UniProt accession 提取） */
  sequenceHeader?: string
  uploadId?: string
  /** v2.4：内联评估表数据（无状态部署由前端随请求携带；磁盘 parsed.json/insights.json 缺失时回退使用） */
  evalTable?: InlineEvalTable
  goal?: string
  /** 批次关系说明（非关联批量时注入报告，LLM 在执行摘要中说明独立/复合物定位） */
  batchNote?: string
  /** ≥90% 高一致同源组（v1.11）：组内首个提交 BLAST 的作业为代表，其余跳过并共享结果 */
  homologBlast?: BlastGroup
  /** v2.0：配体输入（名称/分子式/三位 ID / 文件提取线索，≤8 条）；评估表识别在管线内自动补充 */
  ligands?: LigandInput[]
  options: EvaluationOptions
}

/** v2.4：评估完成时的最终数据（供同步评估路由直接返回，不依赖 DB 读回） */
export interface PipelineResult {
  summary: JobSummary
  directPdbs: PdbEntry[]
  blastHits: BlastHit[]
  /** v2.29：与评估区间无链范围重叠的结构（折叠保留展示 — 灰色行；DB 持久化在 summary 内） */
  rangeOutsidePdbs?: PdbEntry[]
  rangeOutsideBlastHits?: BlastHit[]
  literature: LiteratureItem[]
  reportPath: string | null
  reportMarkdown: string | null
}

export interface PipelineCallbacks {
  signal: AbortSignal
  report: (stageKey: string, message: string, subPercent?: number) => void
  log: (msg: string, level?: 'info' | 'warn' | 'error') => void
  /** v2.4 可选：评估成功完成时携带全部最终数据回调（同步评估模式使用） */
  onComplete?: (result: PipelineResult) => void
  /** v2.6 可选：分段预算（epoch ms）— 到点在阶段边界交还 checkpoint；缺省 = 不分段（一次跑完） */
  deadline?: number
}

// ─── v2.6 分段状态 ────────────────────────────────────────────────────────────

/** 阶段游标（顺序推进；断点续跑时从中断处继续） */
type Phase =
  | 'init' | 'uniprot' | 'blast-submit' | 'rcsb' | 'ligands' | 'pdbe'
  | 'pubmed' | 'blast' | 'gate' | 'analysis' | 'af2' | 'report' | 'render'

const PHASES: Phase[] = ['init', 'uniprot', 'blast-submit', 'rcsb', 'ligands', 'pdbe', 'pubmed', 'blast', 'gate', 'analysis', 'af2', 'report', 'render']

/** 评分结果类型（computeScores 返回值） */
type ScoresResult = ReturnType<typeof computeScores>

/** 管线状态（全部 JSON 可序列化；跨段随 checkpoint 往返） */
interface PipelineState {
  phase: Phase
  /** 作业开始时刻（跨段保留 — durationMs 连续累计） */
  t0: number
  // ── init 派生（每段重派生 — 图片 dataUri 由前端每段重复携带的 evalTable 恢复）──
  goal: string
  goalHints: string[]
  insights: FormInsights | null
  images: ParsedImage[]
  assetDir: string
  providedSequence: string
  uploadFullText: string
  comparison: SequenceComparison | null
  goalPersisted: boolean
  // ── 靶点 ──
  uniprotInfo: UniprotInfo | null
  sequence: string
  uniprotIdInput: string | null
  /** RCSB 检索到的 PDB ID 缓存（跨段保留，避免重查） */
  pdbIdsCached: string[] | null
  /** v2.16：序列标签头（FASTA > 头 / 评估表序列上方标签 — 靶点命名的证据之一） */
  sequenceHeader: string
  /** v2.16：序列靶点身份识别（评估表蛋白名 / BLAST 同源描述 / nr 识别的级联结果） */
  targetIdentity: TargetIdentityInfo | null
  // ── BLAST ──
  blastSubmitted: { rid: string; rtoe: number } | null
  /** 'ok' = 初始哨兵（尚未判定）；其余值 = 已终态判定 */
  blastStatus: BlastStatusInfo
  blastHits: BlastHit[]
  familyRep: boolean
  blastPoll: BlastPollState | null
  /** 收集完成（含 enrich/过滤；重入守卫） */
  blastCollected: boolean
  /** 序列模式回填 UniProt 的子步骤（重入守卫） */
  blastBackfillDone: boolean
  /** 提交失败时的 RCSB 兜底子步骤（重入守卫） */
  blastRescueDone: boolean
  /** v2.16：BLAST nr 靶点身份识别（提交的 RID；跨段保留） */
  nrBlast: { rid: string; rtoe: number } | null
  /** v2.16：nr 轮询续跑状态（段预算到点交还） */
  nrBlastPoll: BlastPollState | null
  /** v2.16：nr 检索完成（命中已存 nrHits；RID 不再重复轮询） */
  nrBlastDone: boolean
  /** v2.16：nr 收集的命中（≤20 条，随 checkpoint 续跑；供身份处理重入） */
  nrHits: BlastNrHit[] | null
  /** v2.16：nr 身份处理完成（回填/近似记录已落 targetIdentity — 重入守卫） */
  nrIdentityDone: boolean
  // ── RCSB PDB ──
  totalPdbFound: number
  directPdbs: PdbEntry[]
  pdbCompletedIds: string[]
  /** 排序+范围过滤+链区间回填已完成 */
  pdbFinalized: boolean
  /** v2.29：与评估区间无链范围重叠的直接结构（折叠保留展示 — 灰色行；不参与评分/覆盖口径，上限 200） */
  rangeOutsidePdbs: PdbEntry[]
  /** v2.29：与评估区间无重叠的 BLAST 同源命中（折叠保留展示；上限 100） */
  rangeOutsideBlastHits: BlastHit[]
  /** v2.29：结构域提示匹配出的评估区间（options.rangeHint → UniProt domain 划分；label 含命中描述） */
  domainRange: { start: number; end: number; label: string } | null
  /** 域名匹配已尝试（无 rangeHint 或无 UniProt 时为 true — 防止每段重复尝试） */
  domainRangeDone: boolean
  /** v2.30：BLAST nr 命中 HSP 推导的评估区间（提交序列 ↔ UniProt 条目主体比对坐标；
 *  构建比对（种子链/锚定）未产出区间时启用 — 非全长同样按截短口径分流） */
  blastRange: { start: number; end: number; queryFrom?: number; hitFrom?: number } | null
  // ── 配体 ──
  ligandUnique: LigandInput[]
  ligandResolved: LigandResolution[]
  ligandResolveDone: boolean
  ligandStructDone: boolean
  /** v2.7：配体详情（PubChem 性质 + 2D 结构式）充实进度 */
  ligandDetailDone: boolean
  ligandDetailCursor: number
  /** v2.6：配体结构检索进度游标（跨段保留 — 防重入重复拉取/死循环） */
  ligandStructCursor: number
  // ── PDBe / PubMed ──
  coverage: PdbeCoverageResult | null
  coverageText: string
  gapText: string
  literature: LiteratureItem[]
  /** v2.28：BLAST 同源命中的主引文已并入文献列表（重入守卫） */
  blastLitMerged: boolean
  // ── 守门 / 分析 ──
  blastRetryFailed: boolean
  /** last-resort 重试下一段待执行（gate 子步骤跨段） */
  blastRetryPending: boolean
  blastRetrySegments: number
  /** v2.6.3：BLAST 提交被段预算切断的累计次数（≥3 → 置 failed 走 RCSB 兜底，防无限重试） */
  blastSubmitCuts: number
  interaction: InteractionAnalysis | null
  oligomer: OligomerAnalysis | null
  mwAugment: MwAugmentAnalysis | null
  scores: ScoresResult | null
  /** v2.18：LLM 评分复核实际尝试次数（≥2 次后放弃，保留规则分；handoff 预算闸门不计入） */
  scoreLlmAttempts: number
  // ── AF2 / ESMFold / 报告 ──
  afFigure: { dataUri: string; modelId: string; globalPlddt: number | null; version: number; fracVeryHigh: number | null } | null
  afSummary: AlphafoldSummaryInfo | null
  /** v2.15：ESMFold 公共 API 兜底预测（AFDB 无收录/纯序列输入时）元数据 */
  esmSummary: EsmfoldSummaryInfo | null
  reportParts: ReportPart[]
  reportDone: boolean
  /** v2.6.3/v2.7：各报告章 LLM 失败累计（同键 ≥3 → 放弃重试接受缺章，防慢引擎无限段循环） */
  reportPartFails: Partial<Record<string, number>>
  /** 渲染产物 */
  reportPath: string | null
  reportMarkdown: string | null
}

export interface PipelineCheckpoint {
  version: 2
  state: PipelineState
}

export type PipelineSegmentResult =
  | { done: false; checkpoint: PipelineCheckpoint }
  | { done: true; result: PipelineResult }

function freshState(): PipelineState {
  return {
    phase: 'init',
    t0: Date.now(),
    goal: '',
    goalHints: [],
    insights: null,
    images: [],
    assetDir: '',
    providedSequence: '',
    uploadFullText: '',
    comparison: null,
    goalPersisted: false,
    uniprotInfo: null,
    sequence: '',
    uniprotIdInput: null,
    sequenceHeader: '',
    targetIdentity: null,
    pdbIdsCached: null,
    blastSubmitted: null,
    blastStatus: { status: 'ok' },
    blastHits: [],
    familyRep: false,
    blastPoll: null,
    blastCollected: false,
    blastBackfillDone: false,
    blastRescueDone: false,
    nrBlast: null,
    nrBlastPoll: null,
    nrBlastDone: false,
    nrHits: null,
    nrIdentityDone: false,
    totalPdbFound: 0,
    directPdbs: [],
    pdbCompletedIds: [],
    pdbFinalized: false,
    rangeOutsidePdbs: [],
    rangeOutsideBlastHits: [],
    domainRange: null,
    domainRangeDone: false,
    blastRange: null,
    ligandUnique: [],
    ligandResolved: [],
    ligandResolveDone: false,
    ligandStructDone: false,
    ligandDetailDone: false,
    ligandDetailCursor: 0,
    ligandStructCursor: 0,
    coverage: null,
    coverageText: '',
    gapText: '',
    literature: [],
    blastLitMerged: false,
    blastRetryFailed: false,
    blastRetryPending: false,
    blastRetrySegments: 0,
    blastSubmitCuts: 0,
    interaction: null,
    oligomer: null,
    mwAugment: null,
    scores: null,
    scoreLlmAttempts: 0,
    afFigure: null,
    afSummary: null,
    esmSummary: null,
    reportParts: [],
    reportDone: false,
    reportPartFails: {},
    reportPath: null,
    reportMarkdown: null,
  }
}

/** checkpoint 序列化：图片 dataUri 不入 checkpoint（前端每段随 evalTable 重携带，段首重派生恢复） */
function serializeState(st: PipelineState): PipelineState {
  return { ...st, images: st.images.map(im => ({ ...im, dataUri: undefined })) }
}

/** 把 UniProt 交叉引用的残基范围（Chains，UniProt 编号）回填到 PDB 结构列表 */
function backfillChainRanges(pdbs: PdbEntry[], info: UniprotInfo | null | undefined): void {
  const ranges = info?.pdbChainRanges
  if (!ranges) return
  for (const p of pdbs) {
    const r = ranges[p.pdbId]
    if (r) p.chainRanges = r
  }
}

/** 上传解析结果持久化文件 */
async function readUploadParsed(uploadId: string): Promise<{ goalHints: string[]; images?: ParsedImage[]; fullText?: string } | null> {
  try {
    const raw = await fs.readFile(path.join(process.cwd(), 'db', 'reports', uploadId, 'parsed.json'), 'utf-8')
    return JSON.parse(raw) as { goalHints: string[]; images?: ParsedImage[]; fullText?: string }
  } catch {
    return null
  }
}

/** 读取 LLM 智能解析结果（insights.json，可能不存在） */
async function readUploadInsights(uploadId: string): Promise<FormInsights | null> {
  try {
    const raw = await fs.readFile(path.join(process.cwd(), 'db', 'reports', uploadId, 'insights.json'), 'utf-8')
    const data = JSON.parse(raw) as FormInsights
    return Array.isArray(data.goals) ? data : null
  } catch {
    return null
  }
}

/** 从 BLAST 命中描述中解析 UniProt accession（sp|P04637|P53_HUMAN / tr|A0A8G0KJC2|...）
 *  v2.16 修复：10 位 accession 的 4 位扩展段收进捕获组（原只捕到前 6 位，如 A0A8G0KJC2 → A0A8G0） */
function uniprotFromBlastDesc(desc: string): string | null {
  const m = desc.match(/(?:sp|tr)\|((?:[A-NR-Z][0-9][A-Z][A-Z0-9]{2}[0-9]|[OPQ][0-9][A-Z0-9]{3}[0-9])(?:[A-Z0-9]{3}[0-9])?)\|/)
  return m ? m[1] : null
}

// ─── v2.16 序列靶点身份识别（评估表名 → BLAST 同源 → nr 兜底）────────────────

/** 从 FASTA 头 / 序列标签中解析 UniProt accession（sp|P00533|EGFR_HUMAN / tr|... / 裸 P00533） */
export function uniprotFromSequenceHeader(header: string): string | null {
  const h = header.trim()
  if (!h) return null
  const tagged = h.match(/(?:sp|tr)\|((?:[A-NR-Z][0-9][A-Z][A-Z0-9]{2}[0-9]|[OPQ][0-9][A-Z0-9]{3}[0-9])(?:[A-Z0-9]{3}[0-9])?)\|/)
  if (tagged) return tagged[1]
  // 裸 accession 形态（>P00533 / P00533_HUMAN 首段）— 仅在头很短时采信（长句里出现
  // 6 位 token 大概率不是 accession，防误判）；10 位扩展段收进捕获组（同 uniprotFromBlastDesc）
  const bare = h.match(/^((?:[A-NR-Z][0-9][A-Z][A-Z0-9]{2}[0-9]|[OPQ][0-9][A-Z0-9]{3}[0-9])(?:[A-Z0-9]{3}[0-9])?)(?:[_\s]|$)/)
  if (bare && h.replace(/^[^A-Za-z0-9]+/, '').length <= 24) return bare[1]
  return null
}

/** PDB BLAST 命中描述清洗：去「Chain A,」/「Chain A|」前缀与构建描述尾巴，得到可读蛋白名 */
export function cleanHomologDescription(desc: string): string {
  let s = desc.replace(/\s+/g, ' ').trim()
  s = s.replace(/^(?:Chain\s+[A-Za-z0-9]+(?:\/[A-Za-z0-9]+)*\s*[,|]\s*)+/, '')
  s = s.replace(/^(?:>?\s*(?:sp|tr|pdb|gb|ref)\|[^|]*\|)/, '')
  // 截去第二个链/结构段（「Chain A, XXX | Chain B, XXX」取第一段）
  s = s.split(/\s*\|\s*(?=Chain\s)/)[0].trim()
  // 去常见构建尾巴（「 apo form」「（residues 1-200）」等保留主体名即可；
  //  apo/holo form 换成 apo 与 holo —— 「Insulin receptor apo form」无逗号衔接亦可清理）
  s = s.replace(/[,，;；]?\s*(?:apo|holo)\s+form\s*$/i, '')
  s = s.replace(/[,，;；]\s*(?:mutant(?:\s+\S+)?|resid?ues?\s+\d+[-–]\d+|del(?:etion)?\s+\S+|truncated?|apo|holo)\s*$/i, '')
  return s.slice(0, 90).trim()
}

/** 评估表来源的靶点身份（LLM 提取的蛋白名优先，序列标签头兜底） */
function buildEvalTableIdentity(insights: FormInsights | null, sequenceHeader: string): TargetIdentityInfo | null {
  const proteinName = insights?.proteinName?.trim() || ''
  const genes = insights?.geneNames ?? []
  const organism = insights?.organism?.trim() || ''
  const header = sequenceHeader.trim()
  if (!proteinName && !header) return null
  // 展示名：评估表蛋白名 > 序列标签头（标签头常为构建名如「GPΔMuc 33-308」— 仍好于「未知靶点」）
  const name = proteinName || header
  // 来源细分：评估表蛋白名（LLM 提取）vs 序列标签（FASTA 头/评估表标签行 — 顺带的命名证据）
  const fromHeader = !proteinName
  const noteParts: string[] = []
  if (proteinName && header && header !== proteinName) noteParts.push(`序列标签「${header.slice(0, 40)}」`)
  if (genes.length) noteParts.push(`基因 ${genes.slice(0, 3).join('/')}`)
  if (organism) noteParts.push(organism)
  return {
    name: name.slice(0, 100),
    source: 'eval-table',
    sourceLabel: fromHeader ? '序列标签' : describeTargetIdentitySource('eval-table'),
    geneName: genes[0],
    organism: organism || undefined,
    note: fromHeader
      ? '来自序列标签（FASTA 头 / 评估表序列标签行）'
      : `来自客户评估表${noteParts.length ? `（${noteParts.join('；')}）` : ''}`,
  }
}

/** nr 命中 → 靶点身份（未达回填阈值时的近似条目记录） */
function buildNrIdentity(best: BlastNrHit): TargetIdentityInfo {
  return {
    name: best.description.slice(0, 100),
    source: 'blast-nr',
    sourceLabel: describeTargetIdentitySource('blast-nr'),
    identity: best.identity,
    uniprotId: best.db === 'other' ? undefined : best.accession,
    uniprotEntry: best.entryName,
    organism: best.organism,
    geneName: best.geneName,
    note: `BLAST nr 最佳命中${best.db !== 'other' ? `（UniProt ${best.accession}${best.entryName ? ` ${best.entryName}` : ''}）` : ''}，一致性 ${best.identity}%`,
  }
}

/** PDB 同源命中 → 靶点身份（同源推断 — 描述能看出大概是什么蛋白） */
function buildHomologIdentity(best: BlastHit): TargetIdentityInfo {
  const name = cleanHomologDescription(best.description)
  return {
    name: (name || best.description).slice(0, 100),
    source: 'blast-homolog',
    sourceLabel: describeTargetIdentitySource('blast-homolog'),
    identity: best.identity,
    note: `PDB 同源结构 ${best.pdbId}（一致性 ${best.identity}%）描述推断 — 未达 UniProt 回填阈值（85%）`,
  }
}

// ─── v1.11 同源家族 BLAST 委托（≥90% 高一致组共享一次检索）────────────────

interface BlastFamilyClaim {
  jobId: string
  uniprotId: string
  at: number
}

/** 声明有效期：过期后同组新批次可重新选代表（防止残留声明永久压制后续评估） */
const CLAIM_TTL_MS = 30 * 60 * 1000

const blastFamilyG = globalThis as unknown as {
  __blastFamilyClaims?: Map<string, BlastFamilyClaim>
}
const blastFamilyClaims: Map<string, BlastFamilyClaim> = (blastFamilyG.__blastFamilyClaims ??= new Map())

/** 尝试认领：组未被有效占用 → 本作业成为代表（返回 null）；已被占用 → 返回持有者 */
function claimBlastFamily(groupKey: string, jobId: string, uniprotId: string): BlastFamilyClaim | null {
  const existing = blastFamilyClaims.get(groupKey)
  if (existing && existing.jobId !== jobId && Date.now() - existing.at < CLAIM_TTL_MS) return existing
  blastFamilyClaims.set(groupKey, { jobId, uniprotId, at: Date.now() })
  return null
}

/** 提交失败时释放声明（让组内后续作业有机会接管代表角色） */
function releaseBlastFamily(groupKey: string, jobId: string): void {
  const existing = blastFamilyClaims.get(groupKey)
  if (existing && existing.jobId === jobId) blastFamilyClaims.delete(groupKey)
}

// ─── 主入口 ──────────────────────────────────────────────────────────────────

/** 兼容入口（异步作业路径 — 无分段预算，一次跑完；行为与 v2.5 一致） */
export async function runPipeline(input: PipelineInput, cb: PipelineCallbacks): Promise<void> {
  const r = await runPipelineSegment(input, cb)
  if (!r.done) {
    // 无 deadline 不会走到这里；防御性兜底（理论上不可达）
    throw new Error('管线被分段中断（未预期 — 异步路径无预算）')
  }
}

/** v2.6：客户端回传 checkpoint 的消毒校验（防伪造 state 注入 — phase 枚举 + RID/PDB ID 形态）。 */
const PHASE_SET = new Set<string>(PHASES)
const PDB_ID_RE = /^[0-9A-Za-z]{4}$/
const RID_RE = /^[A-Za-z0-9]{4,16}$/

export function sanitizeCheckpoint(raw: unknown): PipelineCheckpoint | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as { version?: unknown; state?: unknown }
  if (o.version !== 2 || !o.state || typeof o.state !== 'object') return null
  const st = o.state as Record<string, unknown>
  if (typeof st.phase !== 'string' || !PHASE_SET.has(st.phase)) return null
  if (st.blastPoll != null) {
    if (typeof st.blastPoll !== 'object') return null
    const bp = st.blastPoll as Record<string, unknown>
    if (typeof bp.rid !== 'string' || !RID_RE.test(bp.rid)) return null
  }
  // v2.16：nr 识别轮询/提交状态消毒（与 blastPoll 同口径 — 防伪造 RID 注入异常轮询）
  if (st.nrBlast != null) {
    if (typeof st.nrBlast !== 'object' || Array.isArray(st.nrBlast)) return null
    const nb = st.nrBlast as Record<string, unknown>
    if (typeof nb.rid !== 'string' || !RID_RE.test(nb.rid)) return null
  }
  if (st.nrBlastPoll != null) {
    if (typeof st.nrBlastPoll !== 'object') return null
    const np = st.nrBlastPoll as Record<string, unknown>
    if (typeof np.rid !== 'string' || !RID_RE.test(np.rid)) return null
  }
  if (st.nrBlastDone != null && typeof st.nrBlastDone !== 'boolean') return null
  if (st.nrIdentityDone != null && typeof st.nrIdentityDone !== 'boolean') return null
  if (st.nrHits != null) {
    if (!Array.isArray(st.nrHits) || st.nrHits.length > 20) return null
    for (const h of st.nrHits) {
      if (!h || typeof h !== 'object' || typeof (h as { accession?: unknown }).accession !== 'string') return null
    }
  }
  if (st.targetIdentity != null) {
    if (typeof st.targetIdentity !== 'object' || Array.isArray(st.targetIdentity)) return null
    const ti = st.targetIdentity as Record<string, unknown>
    if (typeof ti.name !== 'string' || ti.name.length < 1 || ti.name.length > 120) return null
    if (ti.source != null && !['eval-table', 'blast-nr', 'blast-homolog'].includes(String(ti.source))) return null
  }
  if (st.sequenceHeader != null && (typeof st.sequenceHeader !== 'string' || st.sequenceHeader.length > 80)) return null
  if (st.pdbIdsCached != null && !Array.isArray(st.pdbIdsCached)) return null
  if (Array.isArray(st.pdbIdsCached) && st.pdbIdsCached.some(x => typeof x !== 'string' || !PDB_ID_RE.test(x))) return null
  if (st.pdbCompletedIds != null && !Array.isArray(st.pdbCompletedIds)) return null
  if (Array.isArray(st.pdbCompletedIds) && st.pdbCompletedIds.some(x => typeof x !== 'string' || !PDB_ID_RE.test(x))) return null
  if (st.reportParts != null && !Array.isArray(st.reportParts)) return null
  // v2.6.3：新增跨段计数器消毒（数值有界 — 防伪造 state 注入异常值）
  if (st.blastSubmitCuts != null && (typeof st.blastSubmitCuts !== 'number' || st.blastSubmitCuts < 0 || st.blastSubmitCuts > 10)) return null
  // v2.18.1（代码审查 P2-1）：AI 复核尝试次数 + llmAdjust 明细消毒 —
  // 伪造 checkpoint 不得注入字符串型 delta（评分卡 title 属性/合并徽标的插值面）
  if (st.scoreLlmAttempts != null && (typeof st.scoreLlmAttempts !== 'number' || st.scoreLlmAttempts < 0 || st.scoreLlmAttempts > 2)) return null
  if (st.scores != null) {
    if (typeof st.scores !== 'object' || Array.isArray(st.scores)) return null
    const la = (st.scores as Record<string, unknown>).llmAdjust
    if (la != null) {
      if (typeof la !== 'object' || Array.isArray(la)) return null
      const a = la as Record<string, unknown>
      for (const k of ['xray', 'cryoem', 'nmr', 'overall']) {
        if (a[k] != null && (typeof a[k] !== 'number' || !Number.isInteger(a[k]) || Math.abs(a[k] as number) > 2)) return null
      }
      const nt = a.notes as Record<string, unknown> | undefined
      if (nt != null) {
        if (typeof nt !== 'object' || Array.isArray(nt)) return null
        for (const v of Object.values(nt)) {
          if (typeof v !== 'string' || v.length > 400) return null
        }
      }
      if (a.confidence != null && !['high', 'medium', 'low'].includes(String(a.confidence))) return null
      if (a.engine != null && (typeof a.engine !== 'string' || a.engine.length > 120)) return null
      if (a.durationMs != null && (typeof a.durationMs !== 'number' || a.durationMs < 0 || a.durationMs > 600_000)) return null
    }
  }
  if (st.reportPartFails != null) {
    if (typeof st.reportPartFails !== 'object' || Array.isArray(st.reportPartFails)) return null
    for (const v of Object.values(st.reportPartFails)) {
      if (typeof v !== 'number' || v < 0 || v > 10) return null
    }
  }
  return { version: 2, state: st as unknown as PipelineState }
}

/**
 * v2.6 分段执行：带 cb.deadline 时到点交还 checkpoint；无 deadline 一次跑完。
 * checkpoint 由调用方保存并随下一段请求带回（同步路由 → 前端 → 下一段 POST）。
 */
export async function runPipelineSegment(
  input: PipelineInput,
  cb: PipelineCallbacks,
  checkpoint?: PipelineCheckpoint,
): Promise<PipelineSegmentResult> {
  const st: PipelineState = checkpoint?.state ?? freshState()
  // v2.29 防御性回填：旧版本 checkpoint 无范围外分流字段（undefined 数组调用 .length 会抛错）
  if (!st.rangeOutsidePdbs) st.rangeOutsidePdbs = []
  if (!st.rangeOutsideBlastHits) st.rangeOutsideBlastHits = []
  if (st.domainRangeDone == null) st.domainRangeDone = false
  if (!st.blastRange) st.blastRange = null // v2.30 防御性回填：旧 checkpoint 无此字段
  const seg = new SegmentRunner(input, cb, st)
  return seg.run()
}

/** 分段预算剩余量（无预算 = Infinity） */
function budgetLeft(cb: PipelineCallbacks): number {
  return cb.deadline != null && cb.deadline > 0 ? cb.deadline - Date.now() : Infinity
}

/** 调整值格式化（+1 / -2 / ±0 — 日志用） */
function fmtAdj(n: number): string {
  return n > 0 ? `+${n}` : n < 0 ? `${n}` : '±0'
}

// ─── 分段执行器 ──────────────────────────────────────────────────────────────

class SegmentRunner {
  private st: PipelineState
  private input: PipelineInput
  private cb: PipelineCallbacks
  private maxPdb: number
  /** v2.6.3：段总预算（构造时快照）— 闸门随段预算等比伸缩（小段部署网关环境） */
  private segBudgetMs: number

  constructor(input: PipelineInput, cb: PipelineCallbacks, st: PipelineState) {
    this.input = input
    this.cb = cb
    this.st = st
    this.segBudgetMs = budgetLeft(cb)
    // v2.5：MAX_PDB_UNLIMITED（10000）= 不限（由 RCSB 检索分页上限封顶）；普通值 20-300
    this.maxPdb = input.options.maxPdb === MAX_PDB_UNLIMITED ? MAX_PDB_UNLIMITED : Math.min(300, Math.max(20, input.options.maxPdb || 150))
  }

  private get signal(): AbortSignal { return this.cb.signal }
  private get report() { return this.cb.report }
  private get log() { return this.cb.log }

  /** v2.6.3：绑定段截止的调用信号 — in-flight 调用不越过段边界（checkpoint 事件不迟到）。
   * 无预算（异步作业路径）退化为 cb.signal。 */
  private deadlineSignal(): AbortSignal {
    const dl = this.cb.deadline
    if (dl == null || dl <= 0) return this.signal
    return AbortSignal.any([this.signal, AbortSignal.timeout(Math.max(1_000, dl - Date.now()))])
  }

  /** 阶段推进 */
  private advance(next: Phase): void {
    this.st.phase = next
  }

  /** 到点交还 checkpoint */
  private handoff(): PipelineSegmentResult {
    return { done: false, checkpoint: { version: 2, state: serializeState(this.st) } }
  }

  /** 靶点标识/伴随序列是否尚未派生（仅首段派生 — uniprot 阶段会覆写 st.sequence） */
  private get firstRun(): boolean {
    return this.st.uniprotIdInput == null && this.st.sequence === ''
  }

  async run(): Promise<PipelineSegmentResult> {
    const startPhase = this.st.phase
    // 每段先做输入派生（幂等）：恢复图片 dataUri（前端每段重发 evalTable）、
    // 全文/要点/目标（同输入同值）。靶点标识仅首段派生（firstRun 守卫）。
    await this.deriveInput()
    if (startPhase === 'init') this.advance('uniprot')
    for (let i = PHASES.indexOf(this.st.phase); i < PHASES.length; i++) {
      if (i < 0) break
      const phase = PHASES[i]
      this.st.phase = phase
      const out = await this.runPhase(phase)
      if (out) return out
      if (phase === 'render') continue // render 已返回终态（上面 out 为真）；防御
      // 阶段边界预算检查：到点交还（下一段从下一相位继续）
      if (budgetLeft(this.cb) <= 0 && i < PHASES.length - 1) {
        this.advance(PHASES[i + 1])
        return this.handoff()
      }
    }
    throw new Error('管线执行结束但未产出终态结果（未预期）')
  }

  private async runPhase(phase: Phase): Promise<PipelineSegmentResult | null> {
    switch (phase) {
      case 'init': return null // 已在 run() 派生
      case 'uniprot': return await this.phaseUniprot()
      case 'blast-submit': return await this.phaseBlastSubmit()
      case 'rcsb': return await this.phaseRcsb()
      case 'ligands': return await this.phaseLigands()
      case 'pdbe': await this.phasePdbe(); return null
      case 'pubmed': await this.phasePubmed(); return null
      case 'blast': return await this.phaseBlast()
      case 'gate': return await this.phaseGate()
      case 'analysis': return await this.phaseAnalysis()
      case 'af2': return await this.phaseAf2()
      case 'report': return await this.phaseReport()
      case 'render': return await this.phaseRender()
    }
  }

  // ─── 输入派生（每段幂等重跑） ──────────────────────────────────────────────

  private async deriveInput(): Promise<void> {
    const st = this.st
    if (st.phase === 'init') this.report('input', '解析输入…', 0.3) // 仅首段报告（续段不刷屏）
    const fromDisk = this.input.uploadId ? await readUploadParsed(this.input.uploadId) : null
    if (this.input.uploadId) {
      if (fromDisk) {
        if (fromDisk.goalHints?.length) st.goalHints = fromDisk.goalHints
        st.images = fromDisk.images ?? []
        if (fromDisk.fullText) st.uploadFullText = fromDisk.fullText
      } else if (this.input.evalTable) {
        // v2.4 无状态部署：磁盘无 parsed.json（实例不保留状态）→ 使用前端内联携带的评估表数据
        if (this.input.evalTable.goalHints?.length) st.goalHints = this.input.evalTable.goalHints
        st.images = this.input.evalTable.images ?? []
        if (this.input.evalTable.fullText) st.uploadFullText = this.input.evalTable.fullText
        if (st.phase === 'init') this.log('评估表数据以内联模式提供（无状态部署），实验图片与目标提示可用')
      } else if (st.phase === 'init') {
        this.log('评估表解析数据缺失（上传目录可能已过期清理），胶图/SEC 图片与目标提示不可用，建议重新上传评估表', 'warn')
      }
      st.insights = await readUploadInsights(this.input.uploadId)
      if (!st.insights && this.input.evalTable?.insights) st.insights = this.input.evalTable.insights
      // 用户未显式填目标时，自动采用 LLM 解析出的客户目标
      if (!st.goal && st.insights?.goals?.length) {
        st.goal = st.insights.goals.slice(0, 3).join('；')
        if (st.phase === 'init') this.log(`已自动采用评估表解析出的客户目标（${st.insights.goals.length} 条）`)
        // 持久化到作业记录（结果页刊头展示）— 仅首段做一次
        if (!st.goalPersisted) {
          st.goalPersisted = true
          void db.evaluationJob.update({
            where: { id: this.input.jobId },
            data: { goal: st.goal.slice(0, 2000) },
          }).catch(() => undefined)
        }
      }
      if (st.insights?.goals?.length) st.goalHints = [...new Set([...st.insights.goals, ...st.goalHints])]
    } else if (this.input.evalTable) {
      // v2.4：无 uploadId 但携带了内联评估表数据（如无状态模式下未传 uploadId）
      if (this.input.evalTable.goalHints?.length) st.goalHints = this.input.evalTable.goalHints
      st.images = this.input.evalTable.images ?? []
      if (this.input.evalTable.fullText) st.uploadFullText = this.input.evalTable.fullText
      st.insights = this.input.evalTable.insights ?? null
      if (!st.goal && st.insights?.goals?.length) {
        st.goal = st.insights.goals.slice(0, 3).join('；')
        if (st.phase === 'init') this.log(`已自动采用评估表解析出的客户目标（${st.insights.goals.length} 条）`)
      }
      if (st.insights?.goals?.length) st.goalHints = [...new Set([...st.insights.goals, ...st.goalHints])]
    }
    // 显式 goal 优先（每段重设 — 同输入幂等）
    if (this.input.goal?.trim()) st.goal = this.input.goal.trim()

    // 靶点标识派生（仅首段 — uniprot 阶段会覆写 st.sequence，续段不可重置）
    if (this.firstRun) {
      if (this.input.mode === 'uniprot') {
        const id = (this.input.uniprot ?? '').trim().toUpperCase()
        if (!isValidUniprotId(id)) throw new Error(`UniProt ID 格式无效：${id}（应为 6 或 10 位 accession，如 P00533 / A0A8G0KJC2）`)
        st.uniprotIdInput = id
        // 伴随序列（可选）：同一靶点时合并为一次评估，避免重复评估
        if (this.input.sequence?.trim()) {
          const norm = normalizeSequenceInput(this.input.sequence)
          if (norm.ok) {
            st.providedSequence = norm.seq
            this.report('input', `UniProt ${id} + 伴随序列 ${norm.length} aa → 合并为单次评估（以 UniProt 为主）`, 0.9)
          } else {
            this.log(`伴随序列无效（识别到 ${norm.length} 个残基，需 ≥30），已忽略`, 'warn')
            this.report('input', `输入 UniProt ID：${id}`, 0.8)
          }
        } else {
          this.report('input', `输入 UniProt ID：${id}`, 0.8)
        }
      } else if (this.input.mode === 'docx') {
        // docx：优先用解析出的 UniProt（序列用于构建比对）；否则用评估表中的序列
        const id = (this.input.uniprot ?? '').trim().toUpperCase()
        if (id && isValidUniprotId(id)) {
          st.uniprotIdInput = id
          if (this.input.sequence?.trim()) {
            const norm = normalizeSequenceInput(this.input.sequence)
            if (norm.ok) {
              st.providedSequence = norm.seq
              this.report('input', `评估表：UniProt ${id} + 序列 ${norm.length} aa → 合并单次评估`, 0.9)
            } else {
              this.report('input', `评估表解析出 UniProt ID：${id}`, 0.8)
            }
          } else {
            this.report('input', `评估表解析出 UniProt ID：${id}`, 0.8)
          }
        } else if (this.input.sequence) {
          const norm = normalizeSequenceInput(this.input.sequence)
          if (!norm.ok) throw new Error(`评估表中的序列无效：识别到 ${norm.length} 个残基（需 ≥30）`)
          st.sequence = norm.seq
          // v2.16：评估表序列标签（解析出的 header 或前端携带的标签头）→ 靶点命名证据
          st.sequenceHeader = (this.input.sequenceHeader?.trim() || norm.header).slice(0, 80)
          this.report('input', `评估表解析出序列：${norm.length} aa${st.sequenceHeader ? `（${st.sequenceHeader.slice(0, 40)}）` : ''}`, 0.8)
        } else {
          throw new Error('docx 模式需要评估表中解析出的 uniprot 或 sequence')
        }
      } else {
        // 纯序列输入
        const norm = normalizeSequenceInput(this.input.sequence ?? '')
        if (!norm.ok) throw new Error(`序列无效：识别到 ${norm.length} 个残基（需 ≥30 且为蛋白氨基酸序列）`)
        st.sequence = norm.seq
        // v2.16：FASTA 头（多 FASTA 每条各自的头由前端随作业携带）/ 前端标签 → 命名证据 + 头内 UniProt 提取
        st.sequenceHeader = (this.input.sequenceHeader?.trim() || norm.header).slice(0, 80)
        this.report('input', `输入序列：${norm.length} aa${st.sequenceHeader ? `（${st.sequenceHeader.slice(0, 40)}）` : ''}`, 0.8)
      }
    }
    // 图片资产目录定位（每段重派生）
    if (this.input.uploadId) {
      st.assetDir = path.join(process.cwd(), 'db', 'reports', this.input.uploadId, 'assets')
    }
    if (st.phase === 'init') this.report('input', '输入解析完成', 1)
  }

  // ─── v2.27/v2.29/v2.30 有效评估范围（截短构建感知 + 结构域匹配 + BLAST 比对）───
  // 优先级：手动 options.range > 构建比对推导（同靶点序列 → compareSequences
  // 定位的全长区间；v2.30 种子链比对覆盖首尾突变/标签头场景）> BLAST nr HSP 比对
  // 坐标（提交序列 ↔ UniProt 主体区间 — v2.30）> 结构域名提示（options.rangeHint
  // → UniProt domain 划分匹配）。无区间 = 不过滤。v2.29 口径：区间不再丢弃无重叠
  // 结构，而是「重叠者优先展示，无重叠折叠保留（灰色行）」— rangeOutsidePdbs /
  // rangeOutsideBlastHits。v2.30 全长守卫：区间覆盖 ≥99% 且两端贴边（±2）→ 视为
  // 全长提交，不按截短分流（用户口径：非全长才按截短对待）。

  /** v2.30 全长守卫：区间是否覆盖几乎全长（两端贴边 ±2）→ true = 非截短 */
  private isTruncatedRange(r: ResidueRange): boolean {
    const n = this.st.uniprotInfo?.sequenceLength ?? 0
    if (n <= 0) return true
    return !(r[0] <= 2 && r[1] >= n - 2)
  }

  /** v2.29：结构域提示 → UniProt domain 区间（一次性解析缓存；无提示/无 UniProt/未命中 → null） */
  private resolveDomainRange(): { start: number; end: number; label: string } | null {
    const st = this.st
    if (st.domainRangeDone) return st.domainRange
    if (!st.uniprotInfo) return null // 尚未归属 UniProt — 待归属后再试（domainRangeDone 仍为 false）
    st.domainRangeDone = true
    const hint = this.input.options.rangeHint?.trim()
    if (hint) {
      const m = matchDomainHint(hint, st.uniprotInfo.features, st.uniprotInfo.sequenceLength)
      if (m) {
        st.domainRange = {
          start: m.range[0],
          end: m.range[1],
          label: `结构域匹配：${m.term} → UniProt ${m.featureType}「${m.matched}」${m.segments > 1 ? `（${m.segments} 个区段并集）` : ''}`,
        }
        this.log(`评估表结构域提示「${hint}」与 UniProt domain 划分匹配：${m.featureType}「${m.matched}」→ 评估区间 ${m.range[0]}-${m.range[1]}（该区段结构优先展示，无重叠结构折叠保留）`)
      } else {
        this.log(`评估表结构域提示「${hint}」未匹配到 UniProt domain/拓扑域注释 — 按无区间评估（结构列表不分流）`, 'warn')
      }
    }
    return st.domainRange
  }

  /** 有效评估范围（UniProt 残基编号，1-based 闭区间；undefined = 不过滤） */
  private effectiveRange(): ResidueRange | undefined {
    if (this.input.options.range) return this.input.options.range
    const st = this.st
    const c = st.comparison
    if (c?.sameTarget && c.start != null && c.end != null && c.start >= 1 && c.end >= c.start && this.isTruncatedRange([c.start, c.end])) {
      return [c.start, c.end]
    }
    // v2.30：BLAST nr HSP 比对坐标（构建比对未产出区间时 — 提交序列在 UniProt 条目内的覆盖区间）
    const br = st.blastRange
    if (br && br.start >= 1 && br.end >= br.start && this.isTruncatedRange([br.start, br.end])) {
      return [br.start, br.end]
    }
    const dr = this.resolveDomainRange()
    if (dr) return [dr.start, dr.end]
    return undefined
  }

  /** 区间来源标签（日志/摘要说明用） */
  private rangeSourceLabel(): string {
    if (this.input.options.range) return '手动指定'
    const c = this.st.comparison
    if (c?.sameTarget && c.start != null && c.end != null) return '构建比对推导'
    if (this.st.blastRange) return 'BLAST nr 比对推导'
    if (this.st.domainRange) return '结构域匹配（UniProt 注释）'
    return '—'
  }

  /** v2.29：直接结构区间分流 — 主列表仅保留链范围重叠（或范围未知）结构；无重叠者折叠保留 */
  private applyPdbRangeSplit(): void {
    const st = this.st
    const er = this.effectiveRange()
    if (!er) return
    const before = st.directPdbs.length
    const split = splitPdbsByRange(st.directPdbs, er)
    st.directPdbs = split.kept
    let merged = 0
    const seen = new Set(st.rangeOutsidePdbs.map(p => p.pdbId))
    for (const p of split.outside) {
      if (seen.has(p.pdbId) || st.rangeOutsidePdbs.length >= 200) continue
      seen.add(p.pdbId)
      st.rangeOutsidePdbs.push(p)
      merged++
    }
    if (before !== st.directPdbs.length || merged > 0) {
      this.log(`PDB 范围分流：${st.directPdbs.length} 条与区间 ${er[0]}-${er[1]}（${this.rangeSourceLabel()}）重叠优先展示；新增折叠保留 ${merged} 条（累计 ${st.rangeOutsidePdbs.length} 条无重叠 — 灰色行）`)
    }
  }

  /** v2.29：BLAST 同源命中区间分流（构建坐标换算 — 语义同上） */
  private applyBlastRangeSplit(): void {
    const st = this.st
    const bq = this.blastQueryRange()
    if (!bq) return
    const before = st.blastHits.length
    const split = splitBlastByRange(st.blastHits, bq)
    st.blastHits = split.kept
    let merged = 0
    const seen = new Set(st.rangeOutsideBlastHits.map(h => h.pdbId))
    for (const h of split.outside) {
      if (seen.has(h.pdbId) || st.rangeOutsideBlastHits.length >= 100) continue
      seen.add(h.pdbId)
      st.rangeOutsideBlastHits.push(h)
      merged++
    }
    if (before !== st.blastHits.length || merged > 0) {
      this.log(`同源命中范围分流：${st.blastHits.length} 条与查询区间重叠优先；新增折叠保留 ${merged} 条（累计 ${st.rangeOutsideBlastHits.length} 条无重叠）`)
    }
  }

  /**
   * BLAST 命中过滤用的查询坐标区间：queryFrom/To 以「本次提交 BLAST 的序列」编号 —
   * 查询序列 = 全长时即 UniProt 编号，直接用；查询序列 = 构建序列（同靶点伴随/
   * 序列模式）时为构建坐标 → 按比对起点平移（标签头导致的 ± 少许残基误差由
   * 「重叠」语义吸收）。构建坐标无法换算（k-mer 兜底/区间在构建外）→ 不过滤。
   * v2.30：种子链比对携带提供序列覆盖区段（provStart — 标签头不计入平移量）；
   * 构建比对无区间时用 BLAST nr HSP 的查询↔主体平移量（hitFrom - queryFrom）。
   */
  private blastQueryRange(): ResidueRange | undefined {
    const r = this.effectiveRange()
    if (!r) return undefined
    const full = this.st.uniprotInfo?.sequence
    if (!full) return undefined // 未归属 UniProt：无直接结构，同源命中不做区间过滤
    if (this.st.sequence === full) return r
    const c = this.st.comparison
    if (c?.sameTarget && c.start != null) {
      const provStart = c.provStart ?? 1
      const off = c.start - provStart
      const s = r[0] - off
      const e = r[1] - off
      if (e < 1) return undefined
      return [Math.max(1, s), Math.max(1, e)]
    }
    // v2.30：BLAST nr HSP 平移量（查询位置 q ↔ 主体位置 q + hitFrom - queryFrom）
    const br = this.st.blastRange
    if (br && br.hitFrom != null && br.queryFrom != null) {
      const off = br.hitFrom - br.queryFrom
      const s = r[0] - off
      const e = r[1] - off
      if (e < 1) return undefined
      return [Math.max(1, s), Math.max(1, e)]
    }
    return undefined
  }

  // ─── 阶段 2：UniProt 元数据 ────────────────────────────────────────────────

  private async phaseUniprot(): Promise<PipelineSegmentResult | null> {
    const st = this.st
    const uniprotIdToFetch = st.uniprotIdInput ?? null
    if (uniprotIdToFetch) {
      this.report('uniprot', `获取 UniProt ${uniprotIdToFetch} 元数据…`, 0.4)
      const info = await fetchUniprotInfo(uniprotIdToFetch)
      if (!info) throw new Error(`UniProt ${uniprotIdToFetch} 查询失败（ID 不存在或网络错误）`)
      st.uniprotInfo = info
      if (st.providedSequence) {
        // 合并评估：提供的序列 vs 全长序列 → 同靶点判定 + 构建边界估计
        st.comparison = compareSequences(st.providedSequence, info.sequence)
        if (st.comparison.sameTarget) {
          this.log(`序列比对：${describeComparison(st.comparison)} → 判定同一靶点，合并评估（以 UniProt ${info.uniprotId} 为主，序列用于构建分析）`)
          st.sequence = st.providedSequence // BLAST 与构建分析使用客户构建序列
        } else {
          this.log(`序列比对：相似度 ${st.comparison.identity}% 低于同靶点阈值（85%）→ 按 UniProt ${info.uniprotId} 评估；提供序列可能为不同靶点/同源蛋白或抗体，已避免重复评估`, 'warn')
          st.sequence = info.sequence // 提供序列疑似不同靶点（如抗原靶点 + 抗体序列）：BLAST 回退用 UniProt 全长
        }
      } else if (!st.sequence) {
        st.sequence = info.sequence
      }
      this.log(`UniProt 元数据完成：${info.entryName}（${info.proteinName}，${info.sequenceLength} aa，${info.organism}）`)
    } else {
      // 纯序列输入：快速尝试精确肽段识别（失败则等 BLAST 兜底）
      this.report('uniprot', '尝试识别序列对应的 UniProt 条目…', 0.5)
      // v2.16：序列标签头携带的 UniProt accession（sp|P00533|EGFR_HUMAN / >P00533）优先 —
      // 比肽段精确检索更直接；查不到条目则回退（防过期/伪造 token）
      let acc = uniprotFromSequenceHeader(st.sequenceHeader)
      if (acc) {
        const info = await fetchUniprotInfo(acc)
        if (info) {
          st.uniprotInfo = info
          this.log(`序列标签携带 UniProt ${acc}（${info.proteinName}）— 直接归属`)
        } else {
          acc = null
        }
      }
      if (!st.uniprotInfo) {
        const peptideAcc = await identifyUniprotBySequence(st.sequence)
        if (peptideAcc) {
          const info = await fetchUniprotInfo(peptideAcc)
          if (info) {
            st.uniprotInfo = info
            this.log(`序列识别命中 UniProt ${peptideAcc}（${info.proteinName}）`)
          }
        }
      }
      // v2.27：纯序列输入归属 UniProt 后同样做构建比对（构建区间推导 + construct 摘要；
      // 同靶点时区间用于结构范围过滤与覆盖率口径 — 与 UniProt/docx 伴随序列路径同口径）
      // v2.30：种子链比对 — 首尾突变/标签头/种间同源时锚定失效，内部种子仍可定位区间
      if (st.uniprotInfo && st.sequence && st.sequence !== st.uniprotInfo.sequence && !st.comparison) {
        st.comparison = compareSequences(st.sequence, st.uniprotInfo.sequence)
        if (st.comparison.sameTarget) {
          this.log(`序列比对：${describeComparison(st.comparison)} → 判定同一靶点${st.comparison.start != null ? `（区间 ${st.comparison.start}-${st.comparison.end} 用于结构范围过滤与覆盖率口径）` : '（锚定与种子链均未定位区间 — 范围不过滤）'}`)
        }
      }
      if (!st.uniprotInfo) {
        // v2.16 身份识别级联第一级：评估表蛋白名/序列标签（零网络 — 报告立即可用命名）
        const tableId = buildEvalTableIdentity(st.insights, st.sequenceHeader)
        if (tableId) {
          st.targetIdentity = tableId
          this.log(`靶点命名采用${tableId.sourceLabel}：「${tableId.name}」— 报告题目/摘要使用（UniProt 归属仍将由 BLAST 同源/nr 检索定位）`)
        } else {
          this.log('序列未能直接匹配 UniProt — 将由 BLAST 同源描述 / nr 检索推断靶点身份', 'warn')
        }
      }
    }
    this.advance('blast-submit')
    return null
  }

  // ─── 阶段 2.5：BLAST 提前提交（非阻塞 — 等待期先做其他数据检索）───────────

  private async phaseBlastSubmit(): Promise<PipelineSegmentResult | null> {
    const st = this.st
    // 重入守卫：已提交或已终态判定（skipped-* / failed 均为已判定）→ 跳过
    if (st.blastSubmitted || st.blastStatus.status !== 'ok') {
      this.advance('rcsb')
      return null
    }
    const abVerdict = detectAntibody(st.sequence)
    const blastDisabledByOption = Boolean(this.input.options.skipBlast)
    const blastDisabledByAntibody = abVerdict.isAntibody && !this.input.options.forceBlast
    if (blastDisabledByOption) {
      st.blastStatus = { status: 'skipped-disabled' }
      this.log('跳过 BLAST：已在高级选项中关闭')
    } else if (blastDisabledByAntibody) {
      // 抗体序列：BLAST pdbaa 会命中海量抗体恒定区结构，对靶点可行性评估无增量价值
      st.blastStatus = { status: 'skipped-antibody', note: abVerdict.evidence.slice(0, 2).join('；') }
      this.log(`跳过 BLAST：检测到抗体序列（${abVerdict.evidence.join('；')}）— 抗体结构库命中众多但参考价值低`)
    } else if (st.sequence.length >= 30) {
      // v2.6.3 闸门随段预算伸缩：部署网关转发窗 ~24-28s → 段预算 14s，不再要求
      // 45s 提交预算 —— 提交尝试绑定段截止（见 deadlineSignal），预算不足 ~5s
      // 时交还下一段提交（开了必被切断，无意义）。
      const submitGateMs = Math.min(45_000, Math.max(5_000, this.segBudgetMs * 0.35))
      if (budgetLeft(this.cb) < submitGateMs) {
        return this.handoff()
      }
      // v1.11 同源家族委托：组内首个到达此处的作业认领代表并提交；其余成员跳过检索，
      // 合并报告时共享代表结果（用户反馈：≥90% 一致性不必每个都搜）
      if (this.input.homologBlast && !this.input.options.forceBlast) {
        const hb = this.input.homologBlast
        const holder = claimBlastFamily(hb.groupKey, this.input.jobId, st.uniprotIdInput ?? this.input.jobId.slice(0, 8))
        if (holder) {
          st.blastStatus = {
            status: 'skipped-homolog',
            note: `家族代表 ${holder.uniprotId} 已提交同源检索（组内序列一致性 ≥${hb.minIdentity}%），结果将共享给本靶点`,
          }
          this.log(`跳过 BLAST：同源家族（一致性 ≥${hb.minIdentity}%）已委托代表 ${holder.uniprotId} 统一检索，结果合并时共享 — 不重复检索`)
          this.report('uniprot', `同源家族 ≥${hb.minIdentity}%：由代表 ${holder.uniprotId} 统一检索，本靶点共享结果`, 1)
          this.advance('rcsb')
          return null
        }
        st.familyRep = true
        this.log(`本靶点担任同源组（一致性 ≥${hb.minIdentity}%，${hb.members.length} 成员）的 BLAST 家族代表 — 结果将共享给其他成员`)
      }
      try {
        this.report('uniprot', 'BLAST 已提前提交，等待期间先进行其他数据检索…', 1)
        // v2.6.3：提交绑定段截止 — in-flight 尝试不越过段边界（checkpoint 不迟到）；
        // 切断不算 NCBI 真实失败，交还下一段重试提交。
        const submitSignal = this.deadlineSignal()
        const submitted = await submitBlastPdb(st.sequence, msg => this.log(msg), submitSignal)
        st.blastSubmitted = { rid: submitted.rid, rtoe: submitted.rtoe }
        this.log(`BLAST 提前提交完成（RID=${submitted.rid}，预计 ${submitted.rtoe}s）— 文献/结构检索与 NCBI 计算并行进行`)
      } catch (e) {
        if (this.signal.aborted) throw e
        const msg = e instanceof Error ? e.message : String(e)
        if (this.cb.deadline != null && this.cb.deadline > 0 && Date.now() >= this.cb.deadline - 2_000) {
          // v2.6.3：段预算切断（非 NCBI 拒收）— 不置 failed：下一段重试提交；
          // 连续 3 段都未在预算内提交成功 → 置 failed 走 RCSB 序列检索兜底（防无限循环）
          st.blastSubmitCuts++
          if (st.blastSubmitCuts < 3) {
            this.log(`BLAST 提交被段预算切断（第 ${st.blastSubmitCuts}/3 次）— 下一段继续提交`, 'warn')
            return this.handoff()
          }
          st.blastStatus = { status: 'failed', note: `提交持续超段预算（NCBI 响应过慢）：${msg.slice(0, 100)}` }
          if (st.familyRep && this.input.homologBlast) releaseBlastFamily(this.input.homologBlast.groupKey, this.input.jobId)
          this.log(`BLAST 提交连续 ${st.blastSubmitCuts} 段未在预算内完成 — 置为失败，稍后走 RCSB 序列检索兜底`, 'warn')
        } else {
          st.blastStatus = { status: 'failed', note: `提交失败：${msg.slice(0, 100)}` }
          if (st.familyRep && this.input.homologBlast) releaseBlastFamily(this.input.homologBlast.groupKey, this.input.jobId)
          this.log(`BLAST 提交失败：${msg}（稍后阶段将尝试 RCSB 序列检索兜底）`, 'warn')
        }
      }
    }
    this.advance('rcsb')
    return null
  }

  // ─── 阶段 3：RCSB PDB 检索 ────────────────────────────────────────────────

  private async phaseRcsb(): Promise<PipelineSegmentResult | null> {
    const st = this.st
    if (!st.uniprotInfo) {
      this.report('rcsb', '无 UniProt ID，跳过直接检索（BLAST 阶段识别结构）', 1)
      this.log('跳过 RCSB 直接检索：暂无 UniProt ID')
      this.advance('ligands')
      return null
    }
    if (!st.pdbIdsCached) {
      this.report('rcsb', 'RCSB 检索关联 PDB 结构…', 0.05)
      // v2.5：不限模式拉满检索分页（1000 条/靶点）；普通模式维持 500 条检索窗口
      const pdbIds = await fetchPdbIdsForUniprot(st.uniprotInfo.uniprotId, this.maxPdb >= MAX_PDB_UNLIMITED ? 1000 : 500)
      st.totalPdbFound = pdbIds.length
      st.pdbIdsCached = pdbIds
      this.log(`RCSB 检索到 ${pdbIds.length} 个关联 PDB`)
    }
    const pdbIds = st.pdbIdsCached ?? []
    if (pdbIds.length > 0 && !st.pdbFinalized) {
      const result = await fetchPdbEntries(
        pdbIds,
        this.maxPdb,
        (done, total) => this.report('rcsb', `拉取 PDB 详情 ${done}/${total}`, total > 0 ? done / total : 0),
        this.signal,
        {
          deadline: this.cb.deadline,
          completedIds: st.pdbCompletedIds,
          priorEntries: st.directPdbs,
        },
      )
      st.directPdbs = result.entries
      st.pdbCompletedIds = result.entries.map(e => e.pdbId)
      if (result.partial) {
        // v2.6：预算到点 — 部分详情已拉取，交还续跑（下一段继续剩余 ID）
        return this.handoff()
      }
      backfillChainRanges(st.directPdbs, st.uniprotInfo)
      // v2.29：有效评估范围（手动 > 构建比对 > 结构域匹配）— 链范围重叠者优先展示，
      // 无重叠结构折叠保留（rangeOutsidePdbs，灰色行）
      this.applyPdbRangeSplit()
      const ligCount = st.directPdbs.filter(p => p.ligands.length > 0).length
      this.log(`PDB 详情完成：${st.directPdbs.length} 个结构（含配体 ${ligCount} 个）`)
      st.pdbFinalized = true
    }
    this.report('rcsb', `PDB 结构检索完成（${st.directPdbs.length} 个）`, 1)
    this.advance('ligands')
    return null
  }

  // ─── 阶段 3.5：配体归一与研究检索（v2.0；置于 RCSB 后、与 BLAST 等待期重叠）────────

  private async phaseLigands(): Promise<PipelineSegmentResult | null> {
    const st = this.st
    // 候选构建（幂等 — 每段重算后去重）
    const candidates: LigandInput[] = [...(this.input.ligands ?? [])]
    // 评估表识别（v2.5 三通道）：字典扫描（保守长 key）+ 模式提名（「与 X 配体」等行文）
    // + LLM/规则提取结果（insights.ligands，若有）。有 uploadId 或内联 evalTable 全文均可。
    // v2.8：抗体/蛋白类试剂（"027 scFv" 抗体克隆等）在进入归一链前先行剔除 —
    // 既是解析准确度修复，也避免归一链浪费外部调用。
    const biologicBlocked = new Set<string>()
    const isBlockedMention = (raw: string): boolean => {
      const v = raw.trim()
      if (!v) return false
      if (isBiologicMention(v) || isLikelyCloneNumber(v)) {
        biologicBlocked.add(v)
        return true
      }
      return false
    }
    if (st.uploadFullText) {
      for (const m of extractLigandsFromText(st.uploadFullText)) {
        candidates.push({ raw: m.compId, source: 'eval-table' })
      }
      for (const name of extractLigandCandidatesFromText(st.uploadFullText)) {
        if (!isBlockedMention(name)) candidates.push({ raw: name, source: 'eval-table' })
      }
    }
    for (const name of st.insights?.ligands ?? []) {
      if (!name.trim()) continue
      if (!isBlockedMention(name)) candidates.push({ raw: name.trim().slice(0, 160), source: 'eval-table' })
    }
    if (biologicBlocked.size) {
      this.log(`排除非小分子配体提名 ${biologicBlocked.size} 项（抗体/蛋白类试剂：${[...biologicBlocked].slice(0, 6).join('、')}）— 抗体序列按背景证据处理，不进入配体归一`, 'warn')
    }
    // 归一去重（同 raw 不重复解析；同批次多靶点由 LRU 缓存共享外部调用）
    const seen = new Map<string, LigandInput>()
    for (const c of candidates) {
      const key = normalizeLigandRaw(c.raw).replace(/[\s-]/g, '')
      if (!key || seen.has(key)) continue
      seen.set(key, c)
    }
    st.ligandUnique = [...seen.values()].slice(0, 8)
    if (st.ligandUnique.length > 0) {
      this.report('rcsb', `归一配体输入 ${st.ligandUnique.length} 项（ID/别名/PDBe 检索/AI 多策略）…`, 0.96)
      if (!st.ligandResolveDone) {
        const resolved: LigandResolution[] = [...st.ligandResolved]
        let cursor = resolved.length
        const worker = async () => {
          while (cursor < st.ligandUnique.length) {
            if (this.signal.aborted) return
            // v2.6：预算到点 — 已归一部分保留，交还续跑
            if (budgetLeft(this.cb) <= 0) return
            const item = st.ligandUnique[cursor++]
            try {
              resolved.push(await resolveLigandInput(item, this.signal))
            } catch (e) {
              if (this.signal.aborted) throw e
              resolved.push({
                raw: item.raw, source: item.source, fileName: item.fileName, ok: false,
                compId: '', name: '', formula: '', weight: null, strategy: '',
                totalStructures: 0, structures: [], error: '解析异常',
              })
            }
          }
        }
        await Promise.all(Array.from({ length: Math.min(3, st.ligandUnique.length) }, () => worker()))
        st.ligandResolved = resolved
        if (resolved.length < st.ligandUnique.length) {
          // 预算到点：部分归一完成 — 交还续跑
          return this.handoff()
        }
        st.ligandResolveDone = true
      }
      // 已识别配体 → 检索含该配体的结构列表
      if (!st.ligandStructDone) {
        const directSet = new Set(st.directPdbs.map(p => p.pdbId))
        // v2.5：结构列表检索并发化（原串行 for 循环最坏 8×15s ≈ 2 分钟；与归一阶段同款 3-worker 池）
        const targets = st.ligandResolved.filter(r => r.ok && r.compId)
        // v2.6：游标持久化（ligandStructCursor）— 重入续跑从上次进度继续，防死循环
        let structCursor = Math.min(st.ligandStructCursor, targets.length)
        st.ligandStructCursor = structCursor
        const structWorker = async () => {
          while (structCursor < targets.length) {
            if (this.signal.aborted) return
            if (budgetLeft(this.cb) <= 0) return
            const r = targets[structCursor++]
            st.ligandStructCursor = structCursor
            try {
              const s = await fetchLigandStructures(r.compId, directSet, this.signal)
              r.totalStructures = s.total
              r.structures = s.structures.slice(0, 12)
            } catch { /* 检索失败不影响归一结果 */ }
          }
        }
        await Promise.all(Array.from({ length: Math.min(3, targets.length) }, () => structWorker()))
        if (st.ligandStructCursor < targets.length) {
          return this.handoff() // 预算到点 — 剩余配体结构检索下一段继续
        }
        st.ligandStructDone = true
      }
      // v2.7：配体详情充实（PubChem 计算性质 + 2D 结构式 — 报告配体卡展示）
      // 已有 detail 的项幂等跳过；游标持久化防重入死循环
      if (!st.ligandDetailDone) {
        const detailTargets = st.ligandResolved.filter(r => r.ok)
        let detailCursor = Math.min(st.ligandDetailCursor, detailTargets.length)
        st.ligandDetailCursor = detailCursor
        const detailWorker = async () => {
          while (detailCursor < detailTargets.length) {
            if (this.signal.aborted) return
            if (budgetLeft(this.cb) <= 0) return
            const r = detailTargets[detailCursor++]
            st.ligandDetailCursor = detailCursor
            try {
              await enrichLigandDetail(r, this.signal)
            } catch { /* 详情失败不影响主链路 */ }
          }
        }
        await Promise.all(Array.from({ length: Math.min(3, detailTargets.length) }, () => detailWorker()))
        if (st.ligandDetailCursor < detailTargets.length) {
          return this.handoff() // 预算到点 — 剩余详情下一段继续
        }
        st.ligandDetailDone = true
      }
      const resolved = st.ligandResolved
      const okList = resolved.filter(r => r.ok)
      if (resolved.length && st.phase !== 'ligands') {
        // 已推进过（重入段）不重复刷日志
      } else if (resolved.length) {
        this.log(`配体归一完成：${okList.length}/${resolved.length} 项识别${okList.length ? `（${okList.map(r => `${r.raw} → ${r.compId || `PubChem CID ${r.pubchem?.cid ?? '?'}`}·${r.strategy}·${r.totalStructures} 结构`).join('；').slice(0, 400)}）` : ''}`)
        for (const r of resolved.filter(x => !x.ok)) {
          this.log(`配体未识别：「${r.raw}」— ${r.error ?? '未知原因'}`, 'warn')
        }
      }
      this.report('rcsb', `配体归一完成（${okList.length}/${resolved.length} 项识别）`, 1)
    }
    this.advance('pdbe')
    return null
  }

  // ─── 阶段 4：PDBe 覆盖率 ──────────────────────────────────────────────────

  private async phasePdbe(): Promise<void> {
    const st = this.st
    if (st.uniprotInfo) {
      this.report('pdbe', 'PDBe 计算结构覆盖率…', 0.5)
      try {
        st.coverage = await fetchPdbeCoverage(st.uniprotInfo.uniprotId, st.uniprotInfo.sequenceLength)
        // v2.28：SIFTS 链范围回填 — UniProt 交叉引用 Chains 缺失的直接结构补上
        // 链范围（用户反馈：手动范围下部分结构无范围信息而未被过滤）→ 回填后复滤
        const erBackfill = this.effectiveRange()
        if (erBackfill && st.coverage.chainRangesByPdb) {
          let filled = 0
          for (const p of st.directPdbs) {
            if (p.chainRanges) continue
            const r = st.coverage.chainRangesByPdb[p.pdbId]
            if (r) { p.chainRanges = r; filled++ }
          }
          if (filled > 0) {
            const before = st.directPdbs.length
            // v2.29：SIFTS 回填后的复分流 — 新判定的无重叠结构折叠保留
            this.applyPdbRangeSplit()
            st.pdbCompletedIds = st.directPdbs.map(e => e.pdbId)
            this.log(`SIFTS 链范围回填 ${filled} 个结构后复分流：${before} → ${st.directPdbs.length}（限定 ${erBackfill[0]}-${erBackfill[1]}，范围外累计 ${st.rangeOutsidePdbs.length} 条）`)
          }
        }
        // v2.27：限定评估范围时覆盖率/未覆盖区间改为「区间内」口径（截短构建/聚蛋白片段）
        const erPdbe = this.effectiveRange()
        if (erPdbe) {
          st.coverage = restrictCoverageToRange(st.coverage, erPdbe)
          st.coverageText = describeCoverage(st.coverage.coveredRanges, erPdbe[1] - erPdbe[0] + 1)
          const gaps = uncoveredRangesWithin(st.coverage.coveredRanges, erPdbe)
          st.gapText = gaps.map(([a, b]) => `${a}-${b} (${b - a + 1} aa)`).join(', ')
          this.log(`PDBe 覆盖率（限定 ${erPdbe[0]}-${erPdbe[1]}）：${st.coverage.coveragePercent}%${st.gapText ? `，区间内未覆盖：${st.gapText.slice(0, 200)}` : ''}`)
        } else {
          st.coverageText = describeCoverage(st.coverage.coveredRanges, st.uniprotInfo.sequenceLength)
          const gaps = uncoveredRanges(st.coverage.coveredRanges, st.uniprotInfo.sequenceLength)
          st.gapText = gaps.map(([a, b]) => `${a}-${b} (${b - a + 1} aa)`).join(', ')
          this.log(`PDBe 覆盖率：${st.coverage.coveragePercent}%${st.gapText ? `，未覆盖区间：${st.gapText.slice(0, 200)}` : ''}`)
        }
      } catch (e) {
        this.log(`PDBe 覆盖率计算失败：${e instanceof Error ? e.message : e}`, 'warn')
      }
      this.report('pdbe', st.coverage ? `覆盖率 ${st.coverage.coveragePercent}%` : '覆盖率不可用', 1)
    } else {
      this.report('pdbe', '跳过（无 UniProt）', 1)
    }
    this.advance('pubmed')
  }

  // ─── 阶段 5：PubMed 文献（先于 BLAST 收集 — 利用 NCBI 计算等待期）─────────

  private async phasePubmed(): Promise<void> {
    const st = this.st
    this.report('pubmed', '检索 PubMed 结构生物学文献…', 0.3)
    try {
      const geneNames = st.uniprotInfo?.geneNames ?? []
      const proteinName = st.uniprotInfo?.proteinName ?? ''
      const organism = st.uniprotInfo?.organism ?? ''
      const query = buildLiteratureQuery(geneNames, proteinName, organism)
      if (query) {
        st.literature = await searchPubmed(query, 15)
        this.log(`PubMed 检索完成：${st.literature.length} 篇相关文献`)
      } else {
        this.log('无法构造文献检索式（缺基因/蛋白名）', 'warn')
      }
    } catch (e) {
      this.log(`PubMed 检索失败：${e instanceof Error ? e.message : e}`, 'warn')
    }

    // PDB 主引文（结构解析论文）并入文献列表，建立 PDB ↔ 文献关联
    // v2.28：上限 20 → 120（用户反馈「很多 PDB 结构的文献没有列在列表中」—
    // 大靶点百余结构携带的不同 PMID 远超旧 20 上限）；efetch 批次同步加大（20 → 50）
    const structPmids: string[] = []
    const seenPmid = new Set<string>(st.literature.map(l => String(l.pmid)))
    for (const p of st.directPdbs) {
      const pid = (p.pubmedId ?? '').trim()
      if (pid && !seenPmid.has(pid)) {
        seenPmid.add(pid)
        structPmids.push(pid)
      }
      if (structPmids.length >= 120) break
    }
    if (structPmids.length > 0) {
      this.report('pubmed', `拉取 ${structPmids.length} 篇 PDB 主引文文献详情…`, 0.7)
      try {
        const structLits = (await fetchPubmedByPmids(structPmids))
          .map(l => ({ ...l, fromPdb: true as const }))
          .filter(l => !st.literature.some(x => String(x.pmid) === String(l.pmid)))
        // 结构解析文献置前（与结构条目直接关联），按年份降序
        structLits.sort((a, b) => Number(b.year || 0) - Number(a.year || 0))
        st.literature = [...structLits, ...st.literature]
        this.log(`PDB 主引文并入：${structLits.length} 篇结构解析文献（与结构条目直接关联）`)
      } catch (e) {
        this.log(`PDB 主引文拉取失败：${e instanceof Error ? e.message : e}`, 'warn')
      }
    }
    this.report('pubmed', `文献检索完成（${st.literature.length} 篇）`, 1)
    this.advance('blast')
  }

  // ─── 阶段 6：BLAST 结果收集（仍在运行不判超时失败；NCBI 拥堵/失败 → RCSB 兜底）──

  private async phaseBlast(): Promise<PipelineSegmentResult | null> {
    const st = this.st
    const coveragePct = st.coverage?.coveragePercent ?? 0
    const coverageSufficient = st.uniprotInfo && st.directPdbs.length >= 5 && coveragePct >= 50
    if (st.blastStatus.status === 'skipped-disabled') {
      this.report('blast', '已按选项跳过 BLAST', 1)
    } else if (st.blastStatus.status === 'skipped-antibody') {
      this.report('blast', '抗体序列 — 已跳过 BLAST 同源检索', 1)
    } else if (st.blastStatus.status === 'skipped-homolog') {
      // v1.11：家族委托成员 — 本身不检索；代表的命中在合并报告阶段传播过来（排除自身直接结构后入库）
      this.report('blast', '同源家族已委托代表检索（结果将在合并时共享给本靶点）', 1)
    } else if (coverageSufficient && !this.input.options.forceBlast && !st.familyRep) {
      // 结构证据已充分：不再收集已提交的 BLAST 结果（避免低价值噪声）。
      // 例外（v1.11）：家族代表不弃用 — 组内 ≥90% 成员还等着共享这份检索结果
      st.blastStatus = { status: 'skipped-covered' }
      this.report('blast', '结构覆盖充分，无需同源检索结果', 1)
      this.log(`跳过 BLAST 收集：直接结构 ${st.directPdbs.length} 个且覆盖率 ${coveragePct}%，结构证据已充分（已提交的 NCBI 任务弃用）`)
    } else if (st.blastSubmitted) {
      if (!st.blastCollected) {
        this.report('blast', `收集 BLAST 结果（RID=${st.blastSubmitted.rid}，等待期间已完成结构/文献检索）…`, 0.2)
        const outcome = await collectBlastPdbWithRescue(
          st.blastSubmitted.rid,
          st.blastSubmitted.rtoe,
          st.sequence,
          msg => this.report('blast', msg, 0.5),
          this.signal,
          {},
          { deadline: this.cb.deadline, resume: st.blastPoll ?? undefined },
        )
        if ('stillRunning' in outcome) {
          // v2.6：预算到点 — 保存轮询状态，下一段继续轮询同一 RID
          st.blastPoll = outcome.pollState
          return this.handoff()
        }
        st.blastPoll = null
        st.blastCollected = true
        const rawHits = outcome.hits
        const viaRescue = outcome.provider === 'rcsb'
        const directSet = new Set(st.directPdbs.map(p => p.pdbId))
        const filtered = rawHits.filter(h => h.pdbId && !directSet.has(h.pdbId))
        st.blastHits = await enrichBlastHits(filtered, directSet)
        // v2.29：有效区间分流（构建坐标换算 — 查询区间重叠者优先展示，无重叠命中折叠保留）
        this.applyBlastRangeSplit()
        st.blastStatus = {
          status: st.blastHits.length > 0 ? 'ok' : 'no-hits',
          note: st.blastHits.length > 0 ? `${st.blastHits.length} 个同源命中${st.familyRep ? `（家族代表检索：结果将共享给 ≥${this.input.homologBlast?.minIdentity ?? 90}% 一致性的同源成员）` : ''}` : undefined,
          provider: outcome.provider,
        }
        this.log(
          viaRescue
            ? `同源检索经 RCSB 序列检索兜底完成（${outcome.rescueNote}）：${rawHits.length} 个命中，去重/排除直接命中后 ${st.blastHits.length} 个 — 已提交的 NCBI 任务弃用`
            : `BLAST 完成：${rawHits.length} 个命中，去重/排除直接命中后 ${st.blastHits.length} 个`,
        )
      }

      // 序列模式且尚未识别 UniProt：从最佳命中回填（blastBackfillDone 重入守卫）
      if (!st.uniprotInfo && st.blastHits.length > 0 && !st.blastBackfillDone) {
        // v2.6.3：闸门随段预算伸缩（原绝对 20s 在小段下永远交还会死锁）
        const backfillGateMs = Math.min(20_000, Math.max(4_000, this.segBudgetMs * 0.5))
        if (budgetLeft(this.cb) < backfillGateMs) {
          return this.handoff() // 回填是多步网络调用 — 预算不足时下一段再做
        }
        const best = st.blastHits[0]
        // v2.16：RCSB 提供方命中用命中实体序号定位 UniProt（复合物结构中实体 1 可能是
        //  伙伴链 — 曾实测 p53 片段命中复合物被归属到 MDM2 的教训）；NCBI pdbaa 命中
        //  描述无实体信息，仍取主实体
        const acc = (st.blastStatus.provider ?? 'ncbi') === 'rcsb'
          ? await fetchUniprotForEntryEntity(best.pdbId, best.entityId ?? 1)
          : uniprotFromBlastDesc(best.description)
        if (acc && best.identity >= 85) {
          this.log(`从同源命中识别 UniProt ${acc}（identity ${best.identity}%），回填元数据…`)
          const info = await fetchUniprotInfo(acc)
          if (info) {
            st.uniprotInfo = info
            await this.rebuildStructureDataAfterBackfill(info)
          }
        }
        st.blastBackfillDone = true
      }

      // ── v2.28：BLAST 同源命中的主引文并入文献列表（用户反馈文献列表不全 —
      // 同源命中经 RCSB GraphQL enrich 已携带 PMID，此前未纳入；结构解析文献块
      // 按年份降序与直接结构引文合并，重入守卫 blastLitMerged）──
      if (st.blastHits.length > 0 && !st.blastLitMerged) {
        st.blastLitMerged = true
        const seen = new Set(st.literature.map(l => String(l.pmid)))
        const blastPmids: string[] = []
        for (const h of st.blastHits) {
          const pid = (h.pubmedId ?? '').trim()
          if (pid && !seen.has(pid)) {
            seen.add(pid)
            blastPmids.push(pid)
          }
          if (blastPmids.length >= 40) break
        }
        if (blastPmids.length > 0) {
          try {
            const blastLits = (await fetchPubmedByPmids(blastPmids))
              .map(l => ({ ...l, fromPdb: true as const }))
              .filter(l => !st.literature.some(x => String(x.pmid) === String(l.pmid)))
            if (blastLits.length) {
              // 结构解析文献块（fromPdb）按年份降序置前，检索文献块在后 — 与既有排序口径一致
              const pdbBlock = [...st.literature.filter(l => l.fromPdb), ...blastLits]
                .sort((a, b) => Number(b.year || 0) - Number(a.year || 0))
              st.literature = [...pdbBlock, ...st.literature.filter(l => !l.fromPdb)]
              this.log(`同源结构主引文并入：${blastLits.length} 篇（文献列表合计 ${st.literature.length} 篇）`)
            }
          } catch { /* 增量并入失败不影响主链路 */ }
        }
      }
      this.report('blast', `BLAST 完成（${st.blastHits.length} 个同源结构）`, 1)
    } else if (st.blastStatus.status === 'failed' && st.sequence.length >= 30 && !st.blastRescueDone) {
      // 提交阶段失败（网络/NCBI 拒收）→ 直接 RCSB 序列检索兜底（v1.9）
      const submitErr = st.blastStatus.note ?? '提交失败'
      this.report('blast', `NCBI 提交失败（${submitErr.slice(0, 60)}）— 尝试 RCSB 序列检索获得同源结构…`, 0.4)
      try {
        const rawHits = await searchRcsbHomologs(st.sequence, { signal: this.signal })
        const directSet = new Set(st.directPdbs.map(p => p.pdbId))
        const filtered = rawHits.filter(h => h.pdbId && !directSet.has(h.pdbId))
        st.blastHits = await enrichBlastHits(filtered, directSet)
        // v2.29：有效区间分流（构建坐标换算）
        this.applyBlastRangeSplit()
        st.blastStatus = {
          status: st.blastHits.length > 0 ? 'ok' : 'no-hits',
          note: st.blastHits.length > 0 ? `${st.blastHits.length} 个同源命中` : undefined,
          provider: 'rcsb',
        }
        st.blastCollected = true
        this.log(`RCSB 序列检索兜底完成：${rawHits.length} 个命中，去重/排除直接命中后 ${st.blastHits.length} 个（NCBI 提交失败：${submitErr}）`)
        this.report('blast', `同源检索完成（RCSB 兜底，${st.blastHits.length} 个同源结构）`, 1)
      } catch (e2) {
        if (this.signal.aborted) throw e2
        const msg2 = e2 instanceof Error ? e2.message : String(e2)
        if (st.familyRep && this.input.homologBlast) releaseBlastFamily(this.input.homologBlast.groupKey, this.input.jobId)
        st.blastStatus = { status: 'failed', note: `NCBI 提交失败：${submitErr.slice(0, 60)}；RCSB 兜底亦失败：${msg2.slice(0, 60)}` }
        this.log(`RCSB 兜底亦失败：${msg2}（继续后续阶段；家族成员将在合并时自行兜底检索）`, 'warn')
        this.report('blast', '同源检索不可用（已跳过）', 1)
      }
      st.blastRescueDone = true
    } else {
      // 序列过短（<30 aa）未提交等剩余情形
      if (st.blastStatus.status === 'ok') st.blastStatus = { status: 'skipped-covered', note: '序列过短（<30 aa），未提交同源检索' }
      this.report('blast', '未运行同源检索', 1)
      this.log(`BLAST 阶段跳过：${st.blastStatus.note ?? '未提交'}`)
    }

    // ── v2.16 靶点身份识别级联（纯序列输入且尚无 UniProt 归属时）──────────
    //  级联顺序（用户语义）：评估表蛋白名（phaseUniprot 已派生）→ PDB 同源描述推断
    //  → BLAST nr 兜底（定位真实蛋白身份；sp|ACC| 命中 ≥85% 时回填 UniProt 全量元数据）
    if (!st.uniprotInfo && st.sequence.length >= 30 && (!st.nrBlastDone || !st.nrIdentityDone)
      && st.blastStatus.status !== 'skipped-disabled' && st.blastStatus.status !== 'skipped-antibody'
      && st.blastStatus.status !== 'failed') {
      // a) 同源推断命名（零网络 — 评估表无蛋白名时，用 PDB 同源最佳命中描述命名）
      if (!st.targetIdentity && st.blastHits.length > 0 && st.blastHits[0].identity >= 40) {
        st.targetIdentity = buildHomologIdentity(st.blastHits[0])
        this.log(`靶点身份由 PDB 同源推断：「${st.targetIdentity.name}」（${st.blastHits[0].pdbId}，一致性 ${st.blastHits[0].identity}%）`)
      }
      // b) BLAST nr 识别（多步网络调用 — 段预算闸门 + RID 跨段续跑；全程 best-effort：
      //    失败仅记 warn，靶点身份保持已有证据，评估不因此中止）
      //    重入结构：nrBlastDone（检索终态，RID 不再重复轮询）→ nrHits 随 checkpoint
      //    续跑 → nrIdentityDone（身份处理幂等重入 — 段切断后下一段接着做）
      if (!st.nrBlastDone) {
        const nrGateMs = Math.min(20_000, Math.max(4_000, this.segBudgetMs * 0.35))
        if (budgetLeft(this.cb) < nrGateMs) {
          return this.handoff()
        }
        try {
          this.report('blast', st.nrBlast
            ? 'BLAST nr 靶点识别检索中（等待 NCBI 计算）…'
            : '靶点身份尚未确定 — 提交 BLAST nr 检索定位真实蛋白…', 0.9)
          if (!st.nrBlast) {
            const submitted = await submitBlastNr(st.sequence, msg => this.report('blast', msg, 0.9), this.deadlineSignal())
            st.nrBlast = { rid: submitted.rid, rtoe: submitted.rtoe }
          }
          const outcome = await collectBlastNr(
            st.nrBlast.rid,
            st.nrBlast.rtoe,
            msg => this.report('blast', msg, 0.9),
            this.signal,
            {
              deadline: this.cb.deadline,
              resume: st.nrBlastPoll ?? undefined,
              // 同源检索已走 RCSB 兜底 = NCBI 队列当日患病 → nr 只做 90s 短预算尝试
              //（正常 10 分钟墙钟在拥堵日会拖垮批量队列；RCSB 兜底命中时身份亦可由
              //  最佳 PDB 命中描述/UniProt 映射回填，非唯一依赖 nr）
              maxWallMs: (st.blastStatus.provider ?? 'ncbi') === 'rcsb' ? 90_000 : undefined,
            },
          )
          if ('stillRunning' in outcome) {
            // v2.6：预算到点 — 保存 nr 轮询状态，下一段继续轮询同一 RID
            st.nrBlastPoll = outcome.pollState
            return this.handoff()
          }
          st.nrBlastPoll = null
          st.nrHits = outcome.hits
          this.log(outcome.hits.length
            ? `BLAST nr 检索完成：${outcome.hits.length} 个命中，最佳一致性 ${Math.max(...outcome.hits.map(h => h.identity))}%`
            : 'BLAST nr 检索完成 — 无命中（全新/人工构建序列）')
        } catch (e) {
          if (this.signal.aborted) throw e
          const msg = e instanceof Error ? e.message : String(e)
          // v2.6.3：段预算切断提交（非 NCBI 拒收）— 不置 done：下一段重新提交
          // （与 pdbaa 提交的 blastSubmitCuts 同语义；poll 有 pollState 续跑，提交无状态重提）
          const deadlineCut = this.cb.deadline != null && this.cb.deadline > 0 && Date.now() >= this.cb.deadline - 2_000
          if (deadlineCut && !st.nrBlast) {
            this.log(`BLAST nr 提交被段预算切断（${msg.slice(0, 80)}）— 下一段继续提交`, 'warn')
            return this.handoff()
          }
          this.log(`BLAST nr 识别失败（${msg}）— 靶点身份保持现有证据（评估表/同源描述），评估继续`, 'warn')
        }
        st.nrBlastDone = true
      }

      // c) 身份处理（检索已完成的命中 — 预算闸门后尽力跑完；段切断由 nrIdentityDone 重入）
      if (st.nrHits && !st.nrIdentityDone) {
        const idGateMs = Math.min(20_000, Math.max(4_000, this.segBudgetMs * 0.35))
        if (budgetLeft(this.cb) < idGateMs) {
          return this.handoff()
        }
        const nrHits = st.nrHits
        // UniProt 形态命中优先（sp/tr 描述携带真实蛋白名 + accession）
        const best = nrHits.find(h => h.db !== 'other') ?? nrHits[0]
        if (best && best.identity >= 85 && best.db !== 'other') {
          this.log(`BLAST nr 识别命中 UniProt ${best.accession}（${best.description.slice(0, 60)}，一致性 ${best.identity}%）— 回填元数据…`)
          const info = await fetchUniprotInfo(best.accession)
          if (info) {
            st.uniprotInfo = info
            st.targetIdentity = {
              ...buildNrIdentity(best),
              note: `BLAST nr 识别（一致性 ${best.identity}%）→ 已归属 UniProt ${best.accession}`,
            }
            // v2.30：nr HSP 比对坐标 → 提交序列在 UniProt 条目内的覆盖区间（在重建结构数据前
            // 落位 — 优先级低于构建比对，但两者都进入 effectiveRange 口径：非全长按截短对待）
            if (best.hitFrom != null && best.hitTo != null && best.hitFrom > 0 && best.hitTo >= best.hitFrom) {
              const s = Math.max(1, best.hitFrom)
              const e = Math.min(info.sequenceLength, best.hitTo)
              if (e >= s) {
                st.blastRange = { start: s, end: e, queryFrom: best.queryFrom, hitFrom: best.hitFrom }
                const queryNote = best.queryFrom != null && best.queryTo != null && (best.queryFrom > 1 || best.queryTo < st.sequence.length)
                  ? `（查询序列 ${best.queryFrom}-${best.queryTo} 段比对 — 端部标签/未匹配段不计入）`
                  : ''
                this.log(`BLAST nr 比对坐标：提交序列 ↔ ${best.accession} 主体 ${best.hitFrom}-${best.hitTo} → 评估区间 ${s}-${e}${queryNote}（构建比对未产出区间时采用；非全长按截短口径分流）`)
              }
            }
            await this.rebuildStructureDataAfterBackfill(info)
          } else {
            // accession 查询失败（网络）→ 仍记录近似身份（有 accession 与描述）
            st.targetIdentity = st.targetIdentity?.source === 'eval-table' ? st.targetIdentity : buildNrIdentity(best)
            this.log(`BLAST nr 识别到 ${best.accession}，但 UniProt 元数据获取失败 — 记录近似身份（${best.description.slice(0, 60)}，${best.identity}%）`, 'warn')
          }
        } else if (best && best.identity >= 40) {
          // 未达 85% 回填阈值 / 非 UniProt 形态 → 近似身份记录
          // 命名优先级：评估表 > nr 识别 > PDB 同源推断（nr 覆盖全蛋白空间，强于 PDB 描述）
          if (!st.targetIdentity || st.targetIdentity.source === 'blast-homolog') {
            st.targetIdentity = buildNrIdentity(best)
            this.log(`BLAST nr 最佳命中：「${best.description.slice(0, 60)}」（${best.accession}，一致性 ${best.identity}%）— 未达 85% 回填阈值，记录为近似身份（题目采用 nr 识别名）`)
          } else {
            this.log(`BLAST nr 最佳命中：「${best.description.slice(0, 60)}」（一致性 ${best.identity}%）— 未达 85% 回填阈值；评估表命名优先保留`, 'info')
          }
        } else {
          this.log(`BLAST nr 检索完成 — 无显著命中（${nrHits.length} 个命中均低于阈值）— 全新/人工构建序列，靶点身份保持现有证据`, 'warn')
        }
        st.nrIdentityDone = true
      }
    }
    this.advance('gate')
    return null
  }

  /** v2.16：UniProt 归属回填后补做结构数据（RCSB PDB + PDBe 覆盖率 + BLAST 去重）。
   *  PDB BLAST 回填与 nr 回填共用（原 PDB 路径的回填体抽出为方法）。 */
  private async rebuildStructureDataAfterBackfill(info: UniprotInfo): Promise<void> {
    const st = this.st
    // v2.27：序列模式回填归属后补做构建比对（构建区间推导 + construct 摘要 — 与主路径同口径）
    // v2.30：种子链比对 — 首尾突变/标签头/种间同源时锚定失效，内部种子仍可定位区间
    if (st.sequence && st.sequence !== info.sequence && !st.comparison) {
      st.comparison = compareSequences(st.sequence, info.sequence)
      if (st.comparison.sameTarget) {
        this.log(`序列比对：${describeComparison(st.comparison)} → 判定同一靶点${st.comparison.start != null ? `（区间 ${st.comparison.start}-${st.comparison.end} 已用于结构范围过滤与覆盖率口径）` : '（锚定与种子链均未定位区间 — 范围不过滤）'}`)
      }
    }
    // 回填后补做 RCSB + PDBe（一次性，不再展开子进度）
    this.report('rcsb', '回填 UniProt 后补检索 PDB…', 0.5)
    // v2.5：不限模式同样拉满检索分页（与主路径一致），普通模式维持 500 检索窗口
    const pdbIds = await fetchPdbIdsForUniprot(info.uniprotId, this.maxPdb >= MAX_PDB_UNLIMITED ? 1000 : 500)
    st.totalPdbFound = pdbIds.length
    if (pdbIds.length) {
      const r = await fetchPdbEntries(pdbIds, this.maxPdb, (d, t) => this.report('rcsb', `补拉 PDB 详情 ${d}/${t}`, t > 0 ? d / t : 0), this.signal)
      st.directPdbs = r.entries
      st.pdbCompletedIds = r.entries.map(e => e.pdbId)
      st.pdbFinalized = true
      backfillChainRanges(st.directPdbs, info)
      // v2.29：有效区间分流（回填路径同主路径口径 — 重叠优先，无重叠折叠保留）
      this.applyPdbRangeSplit()
      const directSet2 = new Set(st.directPdbs.map(p => p.pdbId))
      st.blastHits = (await enrichBlastHits(st.blastHits.filter(h => !directSet2.has(h.pdbId)), directSet2))
      this.applyBlastRangeSplit()
    }
    this.report('pdbe', '补算 PDBe 覆盖率…', 0.5)
    try {
      st.coverage = await fetchPdbeCoverage(info.uniprotId, info.sequenceLength)
      // v2.30：限定评估范围时覆盖率/未覆盖区间改为「区间内」口径（与 phasePdbe 同口径 —
      // 序列模式回填归属的截短构建此前按全长口径计算，覆盖率被区间外区段稀释）
      const erBackfill = this.effectiveRange()
      if (erBackfill) {
        st.coverage = restrictCoverageToRange(st.coverage, erBackfill)
        st.coverageText = describeCoverage(st.coverage.coveredRanges, erBackfill[1] - erBackfill[0] + 1)
        const gaps = uncoveredRangesWithin(st.coverage.coveredRanges, erBackfill)
        st.gapText = gaps.map(([a, b]) => `${a}-${b} (${b - a + 1} aa)`).join(', ')
        this.log(`PDBe 覆盖率（限定 ${erBackfill[0]}-${erBackfill[1]}，${this.rangeSourceLabel()}）：${st.coverage.coveragePercent}%${st.gapText ? `，区间内未覆盖：${st.gapText.slice(0, 200)}` : ''}`)
      } else {
        st.coverageText = describeCoverage(st.coverage.coveredRanges, info.sequenceLength)
        const gaps = uncoveredRanges(st.coverage.coveredRanges, info.sequenceLength)
        st.gapText = gaps.map(([a, b]) => `${a}-${b} (${b - a + 1} aa)`).join(', ')
      }
    } catch { /* 忽略 */ }
  }

  // ─── 阶段 6.5：结构证据守门 + 互作复合物证据 ──────────────────────────────

  private async phaseGate(): Promise<PipelineSegmentResult | null> {
    const st = this.st
    // v1.29 守门条件（幂等重算）
    if (
      st.blastStatus.status === 'failed'   // 仅拦截真失败（no-hits 是有效科学结论；skipped-* 均为设计内跳过）
      && st.directPdbs.length === 0
      && st.blastHits.length === 0
      && st.sequence.length >= 20
    ) {
      if (st.blastRetryPending || st.blastRetrySegments === 0) {
        const failNote = st.blastStatus.note ?? '未知原因'
        this.report('blast', `无直接结构且同源检索失败 — 启动最后一道整周期重试（避免生成缺乏结构证据的报告）…`, 0.5)
        this.log(`结构证据守门：直接结构 0 个 + 同源检索失败（${failNote}）→ 启动 last-resort 整周期重试（RCSB 直连 + NCBI 完整周期，最多 2 轮）`, 'warn')
        // v2.6 分段模式：每段做一轮有界重试（attemptWallMs 随剩余预算收紧），
        // 多段累计后放弃（blastRetrySegments ≥ 4 ≈ 4 分钟）；无预算模式维持原整轮语义
        // v2.6.3：attemptWall 收紧到剩余预算内（原 max(20s, budget-15s) 在 14s 段下超出边界）
        const segMode = this.cb.deadline != null && this.cb.deadline > 0
        const attemptWall = segMode ? Math.max(8_000, budgetLeft(this.cb) - 2_000) : undefined
        try {
          const rescue = await runBlastWithRetry(
            st.sequence,
            msg => this.report('blast', msg, 0.7),
            this.signal,
            attemptWall != null ? { attempts: 1, attemptWallMs: attemptWall, backoffMs: 0 } : undefined,
          )
          const directSet = new Set(st.directPdbs.map(p => p.pdbId))
          const filtered = rescue.hits.filter(h => h.pdbId && !directSet.has(h.pdbId))
          st.blastHits = await enrichBlastHits(filtered, directSet)
          // v2.29：有效区间分流（构建坐标换算 — 无重叠命中折叠保留）
          this.applyBlastRangeSplit()
          st.blastStatus = {
            status: st.blastHits.length > 0 ? 'ok' : 'no-hits',
            note: st.blastHits.length > 0
              ? `${st.blastHits.length} 个同源命中（last-resort 重试：${rescue.note}）`
              : `检索完成但无同源命中（last-resort 重试：${rescue.note}）— 全新靶点，结构证据以文献为准`,
            provider: rescue.provider,
          }
          st.blastRetryPending = false
          this.log(`last-resort 重试成功：${rescue.note}，去重后 ${st.blastHits.length} 个同源命中 — 结构证据已获取，继续生成报告`)
          this.report('blast', `同源检索重试成功（${st.blastHits.length} 个同源结构）`, 1)
        } catch (e) {
          if (this.signal.aborted) throw e
          const msg = e instanceof Error ? e.message : String(e)
          st.blastRetrySegments++
          if (segMode && st.blastRetrySegments < 4) {
            // 分段模式：本轮预算内未成功 — 下一段继续重试（累计上限 4 段）
            st.blastRetryPending = true
            this.log(`last-resort 重试本轮未完成（${msg.slice(0, 120)}）— 下一段继续重试（${st.blastRetrySegments}/4）`, 'warn')
            return this.handoff()
          }
          st.blastRetryFailed = true
          st.blastRetryPending = false
          this.log(`last-resort 重试仍失败：${msg} — 将检查互作复合物证据（Complex Portal/IntAct）后再裁决是否中止`, 'warn')
          this.report('blast', '同源检索重试失败 — 转向互作复合物证据检索…', 0.9)
        }
      }
    }

    // ─── 阶段 6.6：互作复合物证据（v1.29，无直接结构时）────────────────────
    if (st.uniprotInfo && st.directPdbs.length === 0 && !st.interaction) {
      this.report('blast', '无直接结构 — 检索 UniProt 互作复合物证据（Complex Portal curated 复合物 + IntAct binary 伙伴）…', 0.92)
      st.interaction = await analyzeInteractionEvidence({
        uniprot: st.uniprotInfo,
        signal: this.signal,
        onProgress: msg => this.log(msg),
      })
      if (st.interaction.hasEvidence) {
        this.log(`互作复合物证据：${st.interaction.summary}${st.interaction.complexes.length ? `；组分结构已列出（复合物 ${st.interaction.complexes.length} 个）` : ''}`)
      } else {
        this.log('互作复合物证据：无可用证据（无 curated 复合物、binary 伙伴无结构）', 'warn')
      }
      this.report('blast', `互作证据检索完成${st.interaction.hasEvidence ? '（有可用证据）' : '（无可用证据）'}`, 1)
    }

    // ── 守门裁决（v1.29 后置）：BLAST 重试失败 且 互作也无证据 → 中止报告 ──
    if (st.blastRetryFailed && (!st.interaction || !st.interaction.hasEvidence)) {
      this.log('结构证据守门：同源检索重试失败且互作复合物无可用证据 — 中止报告生成（避免生成缺乏结构证据、可能误导决策的报告）', 'error')
      throw new Error(
        `结构证据不足，已中止报告生成：该靶点无直接关联 PDB 结构，同源结构检索通道（NCBI BLAST / RCSB 序列检索，含多轮自动重试）与互作复合物通道（Complex Portal / IntAct）均未获得可用证据。` +
        `为避免生成缺乏结构证据、可能误导决策的评估报告，本次评估已中止 — 请稍后点击「重试评估」重新发起；若持续失败可尝试在高级选项中关闭 BLAST（报告将仅基于直接结构证据）。`,
      )
    }
    if (st.blastRetryFailed && st.interaction?.hasEvidence) {
      this.log(`结构证据守门：同源检索失败，但互作复合物证据可用 — 继续生成报告（评分纳入互作证据调整）`)
    }
    this.advance('analysis')
    return null
  }

  // ─── 阶段 7：聚集形式（寡聚态）分析 + 评分 + LLM 复核 ──────────────────────
  //
  // v2.18：phaseAnalysis 改为幂等可重入（子步骤守卫）并新增 LLM 评分复核子步骤 —
  // 预算闸门（<12s）在复核前 handoff，下一段从守卫处继续（不再重算寡聚/分子量/
  // 规则分）；复核失败/超时不阻塞评估（规则分即终分），尝试 ≥2 次后放弃。

  private async phaseAnalysis(): Promise<PipelineSegmentResult | null> {
    const st = this.st
    if (!st.oligomer) {
      this.report('score', '分析蛋白聚集形式（寡聚态）…', 0.2)
      st.oligomer = analyzeOligomericState({
        uniprot: st.uniprotInfo,
        directPdbs: st.directPdbs,
        blastHits: st.blastHits,
        literature: st.literature,
      })
      this.log(`聚集形式分析：${st.oligomer.summary}（证据 ${st.oligomer.evidence.length} 条，置信度${st.oligomer.confidence === 'high' ? '高' : st.oligomer.confidence === 'medium' ? '中' : '低'}）`)
    }

    // v1.26/v1.27：分子量增重策略（小分子量靶点）— UniProt 伙伴长度 + RCSB 复合物装配
    // + 冲突分析；直接路径装配不足 50 kDa 时经 BLAST 同源命中扩展检索大复合物（v1.27）
    if (!st.mwAugment) {
      this.report('score', '分析分子量与增重策略（小分子量靶点）…', 0.35)
      st.mwAugment = await analyzeMwAugmentation({
        uniprot: st.uniprotInfo,
        sequenceLength: st.uniprotInfo?.sequenceLength ?? st.sequence.length,
        oligomer: st.oligomer,
        directPdbs: st.directPdbs,
        blastHits: st.blastHits,
        goal: st.goal || undefined,
        goalHints: st.goalHints,
        signal: this.signal,
      })
      this.log(st.mwAugment.applicable
        ? `分子量增重分析：单体 ~${st.mwAugment.monomerKda} kDa${st.mwAugment.assemblyKda != null ? ` → 装配 ~${st.mwAugment.assemblyKda} kDa（${st.mwAugment.assemblyPath}；复合物结构 ${st.mwAugment.complexes.length} 个；同源复合物 ${(st.mwAugment.homologComplexes ?? []).length} 个；伙伴 ${st.mwAugment.partners.filter(p => p.kda != null).length} 个）` : '，无装配增重路径'}（冲突分析 ${st.mwAugment.conflicts.length} 条）`
        : `分子量增重分析：不适用（单体 ~${st.mwAugment.monomerKda} kDa ≥ 50 kDa）`)
    }

    if (!st.scores) {
      this.report('score', '计算可行性评分…', 0.5)
      st.scores = computeScores({
        sequenceLength: st.uniprotInfo?.sequenceLength ?? st.sequence.length,
        features: st.uniprotInfo?.features ?? [],
        directPdbs: st.directPdbs,
        blastHits: st.blastHits,
        coveragePercent: st.coverage?.coveragePercent ?? 0,
        oligomer: st.oligomer,
        mwAugment: st.mwAugment,
        interaction: st.interaction,
      })
      this.log(`评分完成：X-ray ${st.scores.xray.score}/10 · Cryo-EM ${st.scores.cryoem.score}/10 · NMR ${st.scores.nmr.score}/10 · 总体 ${st.scores.overall.score}/10${st.scores.interactionAdjust ? `（含互作复合物调整：${st.scores.interactionAdjust.level === 'curated' ? st.scores.interactionAdjust.complexAc : 'binary 伙伴'}）` : ''}`)
    }

    // ── v2.18：LLM 智能复核（规则分之上的专家修正层；失败不阻塞） ──
    if (!st.scores.llmAdjust && st.scoreLlmAttempts < 2) {
      // 段预算闸门：复核是单次 LLM 调用（含供应商层重试），预留预算才开启；
      // 不足则 handoff（守卫使下一段零成本重入，不重算上游分析）。
      // v2.18.1（代码审查 P2-2）：闸门随段预算伸缩（min(12s, segBudget×0.85)，下限 6s）—
      // 小段部署（EVAL_SYNC_SEGMENT_MS 可低至 ~10s）下固定 12s 会造成无限 handoff 乒乓。
      const needMs = Math.min(12_000, Math.max(6_000, Math.trunc(this.segBudgetMs * 0.85)))
      const budget = budgetLeft(this.cb)
      if (budget < needMs) {
        this.report('score', '等待 AI 复核评分（下一段继续）…', 0.75)
        return this.handoff()
      }
      const timeoutMs = Math.max(6_000, Math.min(30_000, budget - 1_500))
      this.report('score', 'AI 复核评分（LLM 专家修正，±2 以内）…', 0.75)
      const out = await reviewScoresWithLlm({
        sequenceLength: st.uniprotInfo?.sequenceLength ?? st.sequence.length,
        features: st.uniprotInfo?.features ?? [],
        directPdbs: st.directPdbs,
        blastHits: st.blastHits,
        coveragePercent: st.coverage?.coveragePercent ?? 0,
        oligomer: st.oligomer,
        mwAugment: st.mwAugment,
        interaction: st.interaction,
        targetName: st.uniprotInfo?.proteinName ?? st.targetIdentity?.name,
        uniprotId: st.uniprotInfo?.uniprotId,
        goal: st.goal || undefined,
        gapText: st.gapText || undefined,
        ligandCount: new Set(st.directPdbs.flatMap(p => p.ligands.map(l => l.split('(')[0].trim()))).size || undefined,
        literatureCount: st.literature.length,
      }, st.scores, AbortSignal.any([this.signal, AbortSignal.timeout(timeoutMs)]))
      st.scoreLlmAttempts += 1
      // v2.18.1（代码审查 P1-2）：用户取消必须传播（与管线其他阶段同口径 —
      // 路由据此标 canceled）；仅复核超时/失败才软降级保留规则分。
      if (this.signal.aborted) throw new Error('评估已取消（AI 复核评分阶段）')
      if (out.ok && out.proposal) {
        const engine = await getEngineSummary()
        const applied = applyLlmScoreAdjust(st.scores, out.proposal, { engine, durationMs: out.durationMs })
        st.scores = applied.scores
        const adj = applied.info
        if (adj.applied) {
          this.log(`AI 复核调分：X-ray ${fmtAdj(adj.xray)} · Cryo-EM ${fmtAdj(adj.cryoem)} · NMR ${fmtAdj(adj.nmr)} → 总体 ${fmtAdj(adj.overall)}（置信度${adj.confidence === 'high' ? '高' : adj.confidence === 'medium' ? '中' : '低'}，${(out.durationMs / 1000).toFixed(1)}s）— ${adj.notes.overall || '三方法复核意见综合'}`)
        } else {
          this.log(`AI 复核维持系统评分（X-ray/Cryo-EM/NMR 均 ±0，置信度${adj.confidence === 'high' ? '高' : adj.confidence === 'medium' ? '中' : '低'}）— ${adj.notes.overall || '规则评分与证据一致'}`)
        }
      } else {
        // v2.18.1（代码审查 P1-1）：失败重试真实可达 — 分段模式交还 checkpoint，
        // 下一段零成本重入重试（attempts 已 +1，上限 2 次天然有界）；异步路径/
        // 二次失败放弃，保留规则分。
        const retryable = st.scoreLlmAttempts < 2 && this.cb.deadline != null && this.cb.deadline > 0
        this.log(`AI 复核评分未生效（${out.error ?? '未知原因'}）— 本次保留系统规则评分${retryable ? '（交还下段重试一次）' : '（已放弃，规则分即终分）'}`, 'warn')
        if (retryable) return this.handoff()
      }
    }
    this.report('score', '评分完成', 1)
    this.advance('af2')
    return null
  }

  // ─── 阶段 7.5：AlphaFold 预测结构（v2.0 报告头图）────────────────────────

  private async phaseAf2(): Promise<PipelineSegmentResult | null> {
    const st = this.st
    if (st.uniprotInfo && !st.afSummary) {
      try {
        this.report('report', '获取 AlphaFold 预测结构…', 0.06)
        // v2.7.2：af2 相位只取元数据（秒级命中，稳落段预算）；PDB 模型
        // 文本挪到 render 相位按需下载（磁盘缓存 + 12s 上限 + 预算闸门）。旧实现
        // 在此调 alphafoldFigureFor 做无头 Chromium 截图 —— 冷启动 15-40s 且不可
        // 中断，远超 14s 段预算与网关 ~24s 转发窗；多实例负载均衡下每次重试都落在
        // 冷实例重付启动成本，部署节点上图片永远渲染不完（报告缺图的根因）。报告
        // 内嵌 3Dmol 交互式 3D 视图后，服务端不再依赖任何浏览器。
        // v2.7.4：元数据改走 alphafoldMetaFor 磁盘优先（sidecar 7 天新鲜窗口
        // 零网络；断网回退本地）— 部署节点断网时已评估过的靶点仍能出完整区块。
        const meta = await alphafoldMetaFor(st.uniprotInfo.uniprotId)
        if (meta) {
          const figCached = await alphafoldFigureCached(st.uniprotInfo.uniprotId)
          if (figCached) {
            st.afFigure = {
              dataUri: 'data:image/png;base64,' + figCached.png.toString('base64'),
              modelId: figCached.meta.modelId,
              globalPlddt: figCached.meta.globalPlddt,
              version: figCached.meta.latestVersion,
              fracVeryHigh: figCached.meta.fracVeryHigh,
            }
          }
          st.afSummary = {
            available: true, modelId: meta.modelId, globalPlddt: meta.globalPlddt,
            version: meta.latestVersion, fracVeryHigh: meta.fracVeryHigh,
          }
          this.log(`AlphaFold 预测获取成功：${meta.modelId}（平均 pLDDT ${meta.globalPlddt ?? '—'}，v${meta.latestVersion}）— 报告将内嵌可交互 3D 视图（拖拽旋转/滚轮缩放/pLDDT 着色）`)
        } else {
          st.afSummary = { available: false, note: '该靶点在 AlphaFold DB 无预测' }
          this.log('AlphaFold 预测结构：该靶点在 AlphaFold DB 无预测，报告将以无图呈现')
        }
      } catch {
        st.afSummary = { available: false, note: 'AlphaFold 预测获取失败' }
      }
    }
    // ── v2.15：ESMFold 公共 API 兜底 ──
    // 仅在 AFDB 无可用预测时执行（含两类：纯序列输入无 UniProt 归属 / UniProt
    // 在 AFDB 无模型或获取失败）— 有 AFDB 模型的靶点不浪费公共服务配额（AF2
    // 有 MSA 精度也更优）。通道实测：健康时短序列（≤80 aa）~3.5s；中长序列
    // 高峰期常被他们网关 504 切断（~30s 上限）— 失败如实记入摘要，本次作业不
    // 重试；磁盘缓存（db/cache/esmfold/{sha1}.pdb）保证重新评估时零成本命中。
    if (!st.esmSummary) {
      const afOk = st.afSummary?.available === true
      if (!afOk && st.sequence) {
        const clean = cleanEsmfoldSequence(st.sequence)
        if (clean.length === 0) {
          st.esmSummary = { available: false, note: '序列无效（无标准氨基酸字符）— 未执行 ESMFold 预测' }
        } else if (clean.length > ESMFOLD_MAX_AA) {
          st.esmSummary = { available: false, sequenceLength: clean.length, note: `序列 ${clean.length} aa 超过 ESMFold 公共接口上限（${ESMFOLD_MAX_AA} aa）— 如需计算预测建议改用需登录的 ColabFold 或 AlphaFold Server` }
          this.log(`ESMFold 兜底未执行：序列 ${clean.length} aa 超过公共接口上限（${ESMFOLD_MAX_AA} aa）`, 'warn')
        } else {
          this.report('report', '该靶点无 AlphaFold DB 预测 — 获取 ESMFold 公共预测结构…', 0.08)
          // 段预算闸门：预算不足 8s 时交还下段重入（磁盘缓存使重入零成本）；
          // 超时钳到段内（min 6s / max 预算-1.5s）— 不越过段边界/checkpoint 纪律
          const budget = budgetLeft(this.cb)
          if (budget < 8_000) return this.handoff()
          const timeoutMs = Math.max(6_000, Math.min(35_000, budget - 1_500))
          const out = await esmfoldStructureFor(st.sequence, { timeoutMs })
          if (out.ok) {
            st.esmSummary = {
              available: true, modelId: 'ESMFold v1',
              globalPlddt: out.stats.meanPlddt, fracVeryHigh: out.stats.fracVeryHigh,
              sequenceLength: out.stats.length, cacheKey: out.cacheKey,
            }
            this.log(`ESMFold 预测获取成功：${out.stats.length} aa · 平均 pLDDT ${out.stats.meanPlddt}${out.fromCache ? '（磁盘缓存命中）' : '（ESM Atlas 公共 API — 免登录）'}— 报告将内嵌可交互 3D 视图（pLDDT 着色）`)
          } else {
            st.esmSummary = { available: false, sequenceLength: clean.length, note: esmfoldFailNote(out) }
            this.log(`ESMFold 预测未获取：${esmfoldFailNote(out)}`, 'warn')
          }
        }
      } else if (!afOk && !st.sequence) {
        st.esmSummary = { available: false, note: '无可用序列 — 未执行 ESMFold 预测' }
      }
    }
    this.advance('report')
    return null
  }

  // ─── 阶段 8：LLM 报告 ────────────────────────────────────────────────────

  /** 报告上下文（report / render 两阶段共用） */
  private reportContext() {
    const st = this.st
    return {
      uniprot: st.uniprotInfo,
      sequence: st.sequence,
      sequenceHeader: st.sequenceHeader || undefined,
      goal: st.goal || undefined,
      goalHints: st.goalHints,
      insights: st.insights ?? undefined,
      /** v2.16：序列靶点身份（评估表名 / 同源推断 / nr 识别 — 无 UniProt 归属时的命名证据链） */
      targetIdentity: st.targetIdentity ?? undefined,
      batchNote: this.input.batchNote,
      providedSequence: st.providedSequence && st.comparison
        ? { sequence: st.providedSequence, comparison: st.comparison }
        : undefined,
      range: this.effectiveRange(), // v2.27：手动 > 构建比对推导；v2.29：结构域匹配垫底（摘要/报告题目「残基 X-Y」）
      rangeSource: this.rangeSourceLabel(), // v2.29：区间来源标签（结果页/折叠区文案）
      rangeOutsidePdbs: st.rangeOutsidePdbs.length ? st.rangeOutsidePdbs : undefined, // v2.29：无重叠结构（折叠保留展示）
      rangeOutsideBlastHits: st.rangeOutsideBlastHits.length ? st.rangeOutsideBlastHits : undefined,
      directPdbs: st.directPdbs,
      blastHits: st.blastHits,
      blastStatus: st.blastStatus,
      coverage: st.coverage,
      coverageText: st.coverageText,
      gapText: st.gapText,
      literature: st.literature,
      images: st.images,
      scores: st.scores!,
      oligomer: st.oligomer!,
      ligands: st.ligandResolved.length ? st.ligandResolved : undefined,
      alphafold: st.afSummary ?? undefined,
      esmfold: st.esmSummary ?? undefined,
      mwAugment: st.mwAugment!,
      interaction: st.interaction ?? undefined,
    }
  }

  private async phaseReport(): Promise<PipelineSegmentResult | null> {
    const st = this.st
    const deferReport = this.input.options.reportMode === 'deferred'
    if (deferReport) {
      // v2.13：批次各靶点不再因「复合物组分」跳过单独评估 — 按单靶点流程生成
      // 完整独立 LLM 报告（章节与单独评估完全一致），由合并报告的各靶点单独
      // 评估页内嵌全文（reportMarkdown 持久化）；本作业的 HTML 不单独落盘
      // （展示并入合并报告，避免同一批次两份报告文件）。
      this.report('report', '生成该靶点的单独评估报告（并入合并报告的靶点单独评估页展示）…', 0.05)
      this.log('批次评估：本靶点按单靶点流程生成完整独立报告 — 展示于合并报告的单独评估页')
    }
    // v2.16 迟到绑定：blast 阶段被跳过/失败但 gate last-resort 事后补回同源命中的
    // 作业（phaseBlast 已过 — 级联不会再跑），报告前兜底派生同源推断命名（幂等）
    if (!st.uniprotInfo && !st.targetIdentity && st.blastHits.length > 0 && st.blastHits[0].identity >= 40) {
      st.targetIdentity = buildHomologIdentity(st.blastHits[0])
      this.log(`靶点身份由 PDB 同源推断：「${st.targetIdentity.name}」（${st.blastHits[0].pdbId}，一致性 ${st.blastHits[0].identity}%）— 命中来自同源检索重试`)
    }
    if (!st.reportDone) {
      this.report('report', '整理数据上下文…', 0.05)
      // v2.6 分段模式：单章 LLM 调用超时收紧到段预算内（慢引擎不至于超出网关
      // 切断时长；超时章 llmOk=false 且不视为已完成 — 下一段自动重试）。
      // v2.6.3：a) 超时钳制随段预算（原 25-70s 钳制下限在 14s 段下超界）；
      // b) 同键连续 3 次失败 → 放弃该章 LLM 重试（接受缺章）— 防慢引擎
      // 无限段循环（每段都超时重试永远到不了终态）。
      // v2.7：三段式拆为 10 章节级调用（200-800 字/章）— 单章时长可控地落在段预算内。
      const segMode = this.cb.deadline != null && this.cb.deadline > 0
      const partTimeoutMs = segMode ? Math.max(8_000, Math.min(70_000, budgetLeft(this.cb) - 1_000)) : undefined
      const fails: Partial<Record<string, number>> = { ...(st.reportPartFails ?? {}) }
      const giveUpKeys = Object.keys(fails).filter(k => (fails[k] ?? 0) >= 3)
      const prevKeys = new Set(st.reportParts.map(p => p.key))
      const gen = await generateReportSections(this.reportContext(), this.signal, {
        deadline: this.cb.deadline,
        completedParts: st.reportParts.length ? st.reportParts : undefined,
        partTimeoutMs,
        giveUpKeys,
      })
      // v2.6.3：逐章 LLM 失败累计（连续语义 — 成功即清零；同键 ≥3 → giveUp 接受缺章）
      for (const p of gen.parts) {
        if (!p.llmOk) fails[p.key] = (fails[p.key] ?? 0) + 1
        else delete fails[p.key]
      }
      st.reportPartFails = fails
      // v2.7：按章节表顺序保留（失败章重试后同 key 覆盖 — 保留最新一条）
      const byKey = new Map<string, ReportPart>()
      for (const p of gen.parts) byKey.set(p.key, p)
      st.reportParts = REPORT_CHAPTERS.map(c => byKey.get(c.key)).filter((p): p is ReportPart => Boolean(p))
      const doneCount = REPORT_CHAPTERS.filter(c => byKey.has(c.key)).length
      for (const p of gen.parts) {
        if (prevKeys.has(p.key) && p.llmOk) continue // 上段已成功的章不重复刷日志
        this.report('report', `LLM 章节「${p.label}」${p.llmOk ? `完成（${p.markdown.length} 字）` : `失败：${p.error}`}`, Math.min(0.95, doneCount / REPORT_CHAPTERS.length))
        this.log(`LLM 报告章节 ${p.key}「${p.label}」 ${p.llmOk ? `完成（${p.markdown.length} 字）` : `失败：${p.error}`}`, p.llmOk ? 'info' : 'warn')
      }
      if (gen.partial) {
        // v2.6：预算到点 — 已完成章保留，交还续跑（下一段生成缺失章）
        return this.handoff()
      }
      st.reportDone = true
    }
    // v2.13：独立报告全文持久化（deferred 批次同样生成 — 合并报告各靶点单独
    // 评估页内嵌该全文；旧批次无此字段的报告回退合并综述）
    st.reportMarkdown = st.reportParts.map(p => p.markdown.trim()).filter(Boolean).join('\n\n') || null
    this.advance('render')
    return null
  }

  // ─── 阶段 9：HTML 渲染 + 落盘 + 持久化 + onComplete ───────────────────────

  private async phaseRender(): Promise<PipelineSegmentResult | null> {
    const st = this.st
    const deferReport = this.input.options.reportMode === 'deferred'
    if (!deferReport && !st.reportPath) {
      this.report('report', '组装 HTML 报告…', 0.95)
      const engineSummary = await getEngineSummary()
      const parts = st.reportParts
      const generatedFullMarkdown = parts.map(p => p.markdown.trim()).filter(Boolean).join('\n\n')
      const generatedOk = parts.some(p => p.llmOk)
      const generatedErrors = parts.filter(p => !p.llmOk).map(p => `${p.label}（${p.key}）: ${p.error}`)
      // v2.7.2：AlphaFold 交互视图 — render 相位按需取模型 PDB（磁盘缓存优先；
      // 预算闸门：剩余 <12s 交还下一段再试，防下载越过网关转发窗导致流被切）。
      // 获取失败/超预算不影响报告生成（视图降级为统计信息，永不阻塞）。
      let alphafoldStructure: { pdbText: string; uniprotId: string; modelId: string; globalPlddt: number | null; version: number; fracVeryHigh: number | null } | undefined
      if (st.afSummary?.available && st.uniprotInfo) {
        if (budgetLeft(this.cb) < 12_000) return this.handoff()
        try {
          const struct = await alphafoldStructureFor(st.uniprotInfo.uniprotId)
          if (struct?.embeddable) {
            alphafoldStructure = {
              pdbText: struct.pdbText, uniprotId: struct.uniprotId, modelId: struct.meta.modelId,
              globalPlddt: struct.meta.globalPlddt, version: struct.meta.latestVersion, fracVeryHigh: struct.meta.fracVeryHigh,
            }
          } else if (struct) {
            this.log(`AlphaFold 模型过大（${Math.round(struct.pdbText.length / 1024)}KB > 内嵌预算 2560KB）— 报告仅展示结构统计信息`, 'warn')
          } else {
            this.log('AlphaFold 模型 PDB 获取失败（下载超时/网络）— 报告仅展示结构统计信息', 'warn')
          }
        } catch { /* 视图降级，不阻塞报告 */ }
      }
      // v2.15：ESMFold 交互视图 — af2 相位已把模型写入磁盘缓存，此处直读（毫秒级，
      // 零网络）；缓存丢失（跨实例/清缓存等极端情形）且预算充裕时才重取一次，
      // 同 AF 模式降级永不阻塞报告。
      let esmfoldStructure: { pdbText: string; modelId: string; globalPlddt: number | null; fracVeryHigh: number | null; sequenceLength: number } | undefined
      if (st.esmSummary?.available && st.esmSummary.cacheKey && !st.afSummary?.available) {
        try {
          const cached = await loadCachedEsmfoldModel(st.esmSummary.cacheKey)
          if (cached && cached.pdbText.length <= ESMFOLD_EMBED_MAX_BYTES) {
            esmfoldStructure = {
              pdbText: cached.pdbText, modelId: 'ESMFold v1',
              globalPlddt: st.esmSummary.globalPlddt ?? null,
              fracVeryHigh: st.esmSummary.fracVeryHigh ?? null,
              sequenceLength: st.esmSummary.sequenceLength ?? cached.meta.sequenceLength,
            }
          } else if (cached) {
            this.log(`ESMFold 模型过大（${Math.round(cached.pdbText.length / 1024)}KB > 内嵌预算 2560KB）— 报告仅展示结构统计信息`, 'warn')
          } else {
            if (budgetLeft(this.cb) < 12_000) return this.handoff()
            const out = await esmfoldStructureFor(st.sequence, { timeoutMs: 12_000 })
            if (out.ok && out.embeddable) {
              esmfoldStructure = {
                pdbText: out.pdbText, modelId: 'ESMFold v1',
                globalPlddt: out.stats.meanPlddt, fracVeryHigh: out.stats.fracVeryHigh, sequenceLength: out.stats.length,
              }
            } else if (!out.ok) {
              this.log(`ESMFold 模型 PDB 获取失败：${esmfoldFailNote(out)} — 报告仅展示结构统计信息`, 'warn')
            }
          }
        } catch { /* 视图降级，不阻塞报告 */ }
      }
      const html = await renderReportHtml({
        ctx: this.reportContext(),
        methodStats: st.scores!.methodStats,
        llmMarkdown: generatedFullMarkdown,
        llmOk: generatedOk,
        llmErrors: generatedErrors,
        jobId: this.input.jobId,
        durationMs: Date.now() - st.t0,
        totalPdbFound: st.totalPdbFound,
        engineSummary,
        alphafoldFigure: st.afFigure ?? undefined,
        alphafoldStructure,
        esmfoldStructure,
        resolveImagePath: (meta) => {
          const ext = meta.mime.includes('png') ? 'png' : meta.mime.includes('gif') ? 'gif' : meta.mime.includes('webp') ? 'webp' : 'jpg'
          // turbopackIgnore：st.assetDir 为运行时上传目录（db/reports/<id>/assets），
          // 静态追踪会把整个项目根收进 standalone 产物导致部署超体积失败。
          return path.join(/*turbopackIgnore: true*/ st.assetDir, `${meta.id}.${ext}`)
        },
      })
      const reportDir = path.join(process.cwd(), 'db', 'reports', this.input.jobId)
      await fs.mkdir(reportDir, { recursive: true })
      st.reportPath = path.join(reportDir, 'report.html')
      await fs.writeFile(st.reportPath, html, 'utf-8')
      st.reportMarkdown = generatedFullMarkdown || null
    }
    const reportPath = st.reportPath

    // ─── 持久化 ──────────────────────────────────────────────────────────────
    const durationMs = Date.now() - st.t0
    const summary: JobSummary = {
      uniprot: {
        uniprotId: st.uniprotInfo?.uniprotId ?? '',
        entryName: st.uniprotInfo?.entryName ?? '',
        // v2.16：无 UniProt 归属时用靶点身份识别名（评估表蛋白名/nr 识别/同源推断）—
        // 不再落回「未知靶点（序列输入）」
        proteinName: st.uniprotInfo?.proteinName ?? st.targetIdentity?.name ?? '未知靶点（序列输入）',
        geneNames: st.uniprotInfo?.geneNames ?? st.insights?.geneNames ?? [],
        organism: st.uniprotInfo?.organism ?? st.targetIdentity?.organism ?? st.insights?.organism ?? '',
        sequenceLength: st.uniprotInfo?.sequenceLength ?? st.sequence.length,
      },
      directPdbCount: st.directPdbs.length,
      blastHitCount: st.blastHits.length,
      coverage: st.coverage?.coveragePercent ?? 0,
      scores: {
        xray: st.scores!.xray, cryoem: st.scores!.cryoem, nmr: st.scores!.nmr, overall: st.scores!.overall,
        /** v1.25：聚集形式调整明细（评分卡展示；无分析时缺省） */
        oligomerAdjust: st.scores!.oligomerAdjust,
        /** v1.26：分子量增重调整明细（评分卡展示；不适用时缺省） */
        mwAugmentAdjust: st.scores!.mwAugmentAdjust,
        /** v1.29：互作复合物证据调整明细（无直接结构且有证据时） */
        interactionAdjust: st.scores!.interactionAdjust,
        /** v2.18：LLM 智能复核调整明细（复核失败/跳过时缺省 — 规则分即终分） */
        llmAdjust: st.scores!.llmAdjust,
      },
      methodStats: st.scores!.methodStats,
      ligandCount: new Set(st.directPdbs.flatMap(p => p.ligands.map(l => l.split('(')[0].trim()))).size,
      literatureCount: st.literature.length,
      imageCount: st.images.length,
      durationMs,
      /** v2.27：实际生效的评估范围（手动指定或构建比对/表格区间推导；v2.29 域名匹配亦可；无则缺省） */
      range: this.effectiveRange(),
      /** v2.29：区间来源标签（手动指定 / 构建比对推导 / 结构域匹配（UniProt 注释）） */
      rangeSource: this.rangeSourceLabel() || undefined,
      /** v2.29：与区间无链范围重叠的结构（折叠保留展示 — 前端灰色行；上限 200/100） */
      rangeOutsidePdbs: st.rangeOutsidePdbs.length ? st.rangeOutsidePdbs.slice(0, 200) : undefined,
      rangeOutsideBlastHits: st.rangeOutsideBlastHits.length ? st.rangeOutsideBlastHits.slice(0, 100) : undefined,
      blast: st.blastStatus,
      coverageText: st.coverageText || undefined,
      gapText: st.gapText || undefined,
      /** v2.13：覆盖区间（合并报告各靶点单独评估页的覆盖率区段图用） */
      coveredRanges: st.coverage?.coveredRanges,
      oligomer: st.oligomer!,
      ligands: st.ligandResolved.length ? st.ligandResolved : undefined,
      alphafold: st.afSummary ?? undefined,
      /** v2.15：ESMFold 公共 API 兜底预测元数据（AFDB 无收录/纯序列输入时；
       *  模型文本存 db/cache/esmfold/{cacheKey}.pdb，合并报告据此直读） */
      esmfold: st.esmSummary ?? undefined,
      /** v1.29：互作复合物证据分析（无直接结构时；无证据时 hasEvidence=false 亦存档） */
      interaction: st.interaction ?? undefined,
      /** v1.26：分子量增重策略分析（小分子量靶点；applicable=false 时亦存档） */
      mwAugment: st.mwAugment!,
      /** v2.13：deferred 批次同样生成完整独立报告 — 状态如实记录（合并报告各靶点页引用） */
      reportLlmOk: st.reportParts.some(p => p.llmOk) || undefined,
      reportDeferred: deferReport || undefined,
      batchNote: this.input.batchNote,
      /** v2.16：靶点身份识别证据链（识别来源/一致性/近似 UniProt — 合并报告与前端展示） */
      targetIdentity: st.targetIdentity ?? undefined,
      construct: st.comparison
        ? {
            providedLength: st.comparison.providedLength,
            fullLength: st.comparison.fullLength,
            identity: st.comparison.identity,
            sameTarget: st.comparison.sameTarget,
            start: st.comparison.start,
            end: st.comparison.end,
          }
        : undefined,
    }

    // v2.4：终态持久化失败不视为评估失败（无状态部署磁盘/DB 可能不可写；
    // 同步评估模式下结果由调用方直接从内存/响应返回）
    try {
      await db.evaluationJob.update({
        where: { id: this.input.jobId },
        data: {
          status: 'done',
          title: summary.uniprot.proteinName,
          uniprotId: st.uniprotInfo?.uniprotId ?? null,
          summary: JSON.stringify(summary),
          pdbs: JSON.stringify(st.directPdbs),
          blastHits: JSON.stringify(st.blastHits),
          literature: JSON.stringify(st.literature),
          reportPath,
          // v2.13：deferred 批次也持久化独立报告全文（合并报告靶点单独评估页内嵌）
          reportMarkdown: st.reportMarkdown || null,
          error: null,
          updatedAt: new Date(),
        },
      })
    } catch { /* 无状态部署：DB 不可用不阻塞（同步路由从内存快照返回结果） */ }

    // 图片资产登记（供 /api/assets 访问）
    // v1.11 修复：同一上传的多靶点批次此前共用 meta.id 做 upsert — 后完成的作业把
    // 资产行「抢」到自己名下（update jobId），导致客户实验数据只出现在最后一个
    // UniProt 的结果页。现改为每个作业登记自己的行（复合 id，路径仍指向上传目录的
    // 同一文件），全部靶点页面共享完整实验数据。
    if (st.images.length) {
      for (let i = 0; i < st.images.length; i++) {
        const meta = st.images[i]
        const ext = meta.mime.includes('png') ? 'png' : meta.mime.includes('gif') ? 'gif' : meta.mime.includes('webp') ? 'webp' : 'jpg'
        const rowId = `${meta.id}__${this.input.jobId}`.slice(0, 64)
        await db.reportAsset.upsert({
          where: { id: rowId },
          create: { id: rowId, jobId: this.input.jobId, kind: meta.kind, caption: meta.caption, mime: meta.mime, size: meta.sizeKB * 1024, path: path.join(/*turbopackIgnore: true*/ st.assetDir, `${meta.id}.${ext}`), order: i, vlm: meta.vlmKind ?? false },
          update: { order: i, vlm: meta.vlmKind ?? false },
        }).catch(() => undefined)
      }
    }

    this.log(`评估完成：总耗时 ${(durationMs / 1000).toFixed(1)}s${deferReport ? '（单独评估报告已生成 — 展示并入合并评估报告的靶点单独评估页）' : '，报告已生成'}`)

    // v2.4：同步评估模式 — 直接把最终数据交给调用方（不依赖 DB 读回）
    const result: PipelineResult = {
      summary,
      directPdbs: st.directPdbs,
      blastHits: st.blastHits,
      /** v2.29：与评估区间无重叠的结构（同步评估模式随结果返回 — 折叠保留展示） */
      rangeOutsidePdbs: st.rangeOutsidePdbs.length ? st.rangeOutsidePdbs.slice(0, 200) : undefined,
      rangeOutsideBlastHits: st.rangeOutsideBlastHits.length ? st.rangeOutsideBlastHits.slice(0, 100) : undefined,
      literature: st.literature,
      reportPath,
      reportMarkdown: !deferReport && st.reportMarkdown ? st.reportMarkdown : null,
    }
    this.cb.onComplete?.(result)
    return { done: true, result }
  }
}
