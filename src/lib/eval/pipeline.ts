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
import { fetchPdbeCoverage, describeCoverage, uncoveredRanges } from './pdbe'
import { submitBlastPdb, collectBlastPdbWithRescue, enrichBlastHits, runBlastWithRetry, type BlastPollState } from './blast'
import { searchRcsbHomologs, fetchUniprotForEntryEntity } from './rcsb-search'
import { buildLiteratureQuery, searchPubmed, fetchPubmedByPmids } from './pubmed'
import { computeScores } from './score'
import { analyzeOligomericState } from './oligomer'
import { analyzeInteractionEvidence } from './interaction'
import { analyzeMwAugmentation } from './mw-augment'
import { generateReportSections, type ReportPart } from './report'
import { renderReportHtml } from './report-html'
import { compareSequences, describeComparison } from './seq-compare'
import { detectAntibody } from './antibody'
import { getEngineSummary } from './llm-provider'
import { filterPdbsByRange, filterBlastByRange } from './range-filter'
import { extractLigandsFromText, extractLigandCandidatesFromText, fetchLigandStructures, normalizeLigandRaw, resolveLigandInput, type LigandInput, type LigandResolution } from './ligand'
import { alphafoldFigureFor } from './alphafold'
import { isValidUniprotId, MAX_PDB_UNLIMITED, type BlastGroup, type BlastHit, type BlastStatusInfo, type EvaluationOptions, type FormInsights, type InputMode, type InteractionAnalysis, type JobSummary, type LiteratureItem, type MwAugmentAnalysis, type OligomerAnalysis, type ParsedImage, type PdbEntry, type PdbeCoverageResult, type AlphafoldSummaryInfo, type SequenceComparison, type UniprotInfo } from './types'

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
  // ── RCSB PDB ──
  totalPdbFound: number
  directPdbs: PdbEntry[]
  pdbCompletedIds: string[]
  /** 排序+范围过滤+链区间回填已完成 */
  pdbFinalized: boolean
  // ── 配体 ──
  ligandUnique: LigandInput[]
  ligandResolved: LigandResolution[]
  ligandResolveDone: boolean
  ligandStructDone: boolean
  /** v2.6：配体结构检索进度游标（跨段保留 — 防重入重复拉取/死循环） */
  ligandStructCursor: number
  // ── PDBe / PubMed ──
  coverage: PdbeCoverageResult | null
  coverageText: string
  gapText: string
  literature: LiteratureItem[]
  // ── 守门 / 分析 ──
  blastRetryFailed: boolean
  /** last-resort 重试下一段待执行（gate 子步骤跨段） */
  blastRetryPending: boolean
  blastRetrySegments: number
  interaction: InteractionAnalysis | null
  oligomer: OligomerAnalysis | null
  mwAugment: MwAugmentAnalysis | null
  scores: ScoresResult | null
  // ── AF2 / 报告 ──
  afFigure: { dataUri: string; modelId: string; globalPlddt: number | null; version: number; fracVeryHigh: number | null } | null
  afSummary: AlphafoldSummaryInfo | null
  reportParts: ReportPart[]
  reportDone: boolean
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
    pdbIdsCached: null,
    blastSubmitted: null,
    blastStatus: { status: 'ok' },
    blastHits: [],
    familyRep: false,
    blastPoll: null,
    blastCollected: false,
    blastBackfillDone: false,
    blastRescueDone: false,
    totalPdbFound: 0,
    directPdbs: [],
    pdbCompletedIds: [],
    pdbFinalized: false,
    ligandUnique: [],
    ligandResolved: [],
    ligandResolveDone: false,
    ligandStructDone: false,
    ligandStructCursor: 0,
    coverage: null,
    coverageText: '',
    gapText: '',
    literature: [],
    blastRetryFailed: false,
    blastRetryPending: false,
    blastRetrySegments: 0,
    interaction: null,
    oligomer: null,
    mwAugment: null,
    scores: null,
    afFigure: null,
    afSummary: null,
    reportParts: [],
    reportDone: false,
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

/** 从 BLAST 命中描述中解析 UniProt accession（sp|P04637|P53_HUMAN / tr|A0A8G0KJC2|...） */
function uniprotFromBlastDesc(desc: string): string | null {
  const m = desc.match(/(?:sp|tr)\|([A-NR-Z][0-9][A-Z][A-Z0-9]{2}[0-9]|[OPQ][0-9][A-Z0-9]{3}[0-9])(?:[A-Z0-9]{3}[0-9])?\|/)
  return m ? m[1] : null
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
  if (st.pdbIdsCached != null && !Array.isArray(st.pdbIdsCached)) return null
  if (Array.isArray(st.pdbIdsCached) && st.pdbIdsCached.some(x => typeof x !== 'string' || !PDB_ID_RE.test(x))) return null
  if (st.pdbCompletedIds != null && !Array.isArray(st.pdbCompletedIds)) return null
  if (Array.isArray(st.pdbCompletedIds) && st.pdbCompletedIds.some(x => typeof x !== 'string' || !PDB_ID_RE.test(x))) return null
  if (st.reportParts != null && !Array.isArray(st.reportParts)) return null
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
  const seg = new SegmentRunner(input, cb, st)
  return seg.run()
}

/** 分段预算剩余量（无预算 = Infinity） */
function budgetLeft(cb: PipelineCallbacks): number {
  return cb.deadline != null && cb.deadline > 0 ? cb.deadline - Date.now() : Infinity
}

// ─── 分段执行器 ──────────────────────────────────────────────────────────────

class SegmentRunner {
  private st: PipelineState
  private input: PipelineInput
  private cb: PipelineCallbacks
  private maxPdb: number

  constructor(input: PipelineInput, cb: PipelineCallbacks, st: PipelineState) {
    this.input = input
    this.cb = cb
    this.st = st
    // v2.5：MAX_PDB_UNLIMITED（10000）= 不限（由 RCSB 检索分页上限封顶）；普通值 20-300
    this.maxPdb = input.options.maxPdb === MAX_PDB_UNLIMITED ? MAX_PDB_UNLIMITED : Math.min(300, Math.max(20, input.options.maxPdb || 150))
  }

  private get signal(): AbortSignal { return this.cb.signal }
  private get report() { return this.cb.report }
  private get log() { return this.cb.log }

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
      case 'analysis': await this.phaseAnalysis(); return null
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
          this.report('input', `评估表解析出序列：${norm.length} aa`, 0.8)
        } else {
          throw new Error('docx 模式需要评估表中解析出的 uniprot 或 sequence')
        }
      } else {
        // 纯序列输入
        const norm = normalizeSequenceInput(this.input.sequence ?? '')
        if (!norm.ok) throw new Error(`序列无效：识别到 ${norm.length} 个残基（需 ≥30 且为蛋白氨基酸序列）`)
        st.sequence = norm.seq
        this.report('input', `输入序列：${norm.length} aa${norm.header ? `（${norm.header.slice(0, 60)}）` : ''}`, 0.8)
      }
    }
    // 图片资产目录定位（每段重派生）
    if (this.input.uploadId) {
      st.assetDir = path.join(process.cwd(), 'db', 'reports', this.input.uploadId, 'assets')
    }
    if (st.phase === 'init') this.report('input', '输入解析完成', 1)
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
      const acc = await identifyUniprotBySequence(st.sequence)
      if (acc) {
        const info = await fetchUniprotInfo(acc)
        if (info) {
          st.uniprotInfo = info
          this.log(`序列识别命中 UniProt ${acc}（${info.proteinName}）`)
        }
      } else {
        this.log('序列未能直接匹配 UniProt，将由 BLAST 兜底识别', 'warn')
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
      // v2.6 分段预算闸门：提交含 3 次重试（最坏 ~99s）超出网关切断时长 —
      // 预算不足 45s 时交还下一段提交（防段内超限）
      if (budgetLeft(this.cb) < 45_000) {
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
        const submitted = await submitBlastPdb(st.sequence, msg => this.log(msg), this.signal)
        st.blastSubmitted = { rid: submitted.rid, rtoe: submitted.rtoe }
        this.log(`BLAST 提前提交完成（RID=${submitted.rid}，预计 ${submitted.rtoe}s）— 文献/结构检索与 NCBI 计算并行进行`)
      } catch (e) {
        if (this.signal.aborted) throw e
        const msg = e instanceof Error ? e.message : String(e)
        st.blastStatus = { status: 'failed', note: `提交失败：${msg.slice(0, 100)}` }
        if (st.familyRep && this.input.homologBlast) releaseBlastFamily(this.input.homologBlast.groupKey, this.input.jobId)
        this.log(`BLAST 提交失败：${msg}（稍后阶段将尝试 RCSB 序列检索兜底）`, 'warn')
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
      if (this.input.options.range) {
        const before = st.directPdbs.length
        st.directPdbs = filterPdbsByRange(st.directPdbs, this.input.options.range)
        if (before !== st.directPdbs.length) this.log(`PDB 范围过滤：${before} → ${st.directPdbs.length}（限定 ${this.input.options.range[0]}-${this.input.options.range[1]}）`)
      }
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
    if (st.uploadFullText) {
      for (const m of extractLigandsFromText(st.uploadFullText)) {
        candidates.push({ raw: m.compId, source: 'eval-table' })
      }
      for (const name of extractLigandCandidatesFromText(st.uploadFullText)) {
        candidates.push({ raw: name, source: 'eval-table' })
      }
    }
    for (const name of st.insights?.ligands ?? []) {
      if (name.trim()) candidates.push({ raw: name.trim().slice(0, 160), source: 'eval-table' })
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
        st.coverageText = describeCoverage(st.coverage.coveredRanges, st.uniprotInfo.sequenceLength)
        const gaps = uncoveredRanges(st.coverage.coveredRanges, st.uniprotInfo.sequenceLength)
        st.gapText = gaps.map(([a, b]) => `${a}-${b} (${b - a + 1} aa)`).join(', ')
        this.log(`PDBe 覆盖率：${st.coverage.coveragePercent}%${st.gapText ? `，未覆盖区间：${st.gapText.slice(0, 200)}` : ''}`)
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
    const structPmids: string[] = []
    const seenPmid = new Set<string>(st.literature.map(l => String(l.pmid)))
    for (const p of st.directPdbs) {
      const pid = (p.pubmedId ?? '').trim()
      if (pid && !seenPmid.has(pid)) {
        seenPmid.add(pid)
        structPmids.push(pid)
      }
      if (structPmids.length >= 20) break
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
        if (this.input.options.range) st.blastHits = filterBlastByRange(st.blastHits, this.input.options.range)
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
        if (budgetLeft(this.cb) < 20_000) {
          return this.handoff() // 回填是多步网络调用 — 不足 20s 预算时下一段再做
        }
        const best = st.blastHits[0]
        const acc = (st.blastStatus.provider ?? 'ncbi') === 'rcsb'
          ? await fetchUniprotForEntryEntity(best.pdbId)
          : uniprotFromBlastDesc(best.description)
        if (acc && best.identity >= 85) {
          this.log(`从同源命中识别 UniProt ${acc}（identity ${best.identity}%），回填元数据…`)
          const info = await fetchUniprotInfo(acc)
          if (info) {
            st.uniprotInfo = info
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
              if (this.input.options.range) st.directPdbs = filterPdbsByRange(st.directPdbs, this.input.options.range)
              const directSet2 = new Set(st.directPdbs.map(p => p.pdbId))
              st.blastHits = (await enrichBlastHits(st.blastHits.filter(h => !directSet2.has(h.pdbId)), directSet2))
              if (this.input.options.range) st.blastHits = filterBlastByRange(st.blastHits, this.input.options.range)
            }
            this.report('pdbe', '补算 PDBe 覆盖率…', 0.5)
            try {
              st.coverage = await fetchPdbeCoverage(info.uniprotId, info.sequenceLength)
              st.coverageText = describeCoverage(st.coverage.coveredRanges, info.sequenceLength)
              const gaps = uncoveredRanges(st.coverage.coveredRanges, info.sequenceLength)
              st.gapText = gaps.map(([a, b]) => `${a}-${b} (${b - a + 1} aa)`).join(', ')
            } catch { /* 忽略 */ }
          }
        }
        st.blastBackfillDone = true
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
        if (this.input.options.range) st.blastHits = filterBlastByRange(st.blastHits, this.input.options.range)
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
    this.advance('gate')
    return null
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
        const segMode = this.cb.deadline != null && this.cb.deadline > 0
        const attemptWall = segMode ? Math.max(20_000, budgetLeft(this.cb) - 15_000) : undefined
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
          if (this.input.options.range) st.blastHits = filterBlastByRange(st.blastHits, this.input.options.range)
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

  // ─── 阶段 7：聚集形式（寡聚态）分析 + 评分 ──────────────────────────────

  private async phaseAnalysis(): Promise<void> {
    const st = this.st
    this.report('score', '分析蛋白聚集形式（寡聚态）…', 0.3)
    st.oligomer = analyzeOligomericState({
      uniprot: st.uniprotInfo,
      directPdbs: st.directPdbs,
      blastHits: st.blastHits,
      literature: st.literature,
    })
    this.log(`聚集形式分析：${st.oligomer.summary}（证据 ${st.oligomer.evidence.length} 条，置信度${st.oligomer.confidence === 'high' ? '高' : st.oligomer.confidence === 'medium' ? '中' : '低'}）`)

    // v1.26/v1.27：分子量增重策略（小分子量靶点）— UniProt 伙伴长度 + RCSB 复合物装配
    // + 冲突分析；直接路径装配不足 50 kDa 时经 BLAST 同源命中扩展检索大复合物（v1.27）
    this.report('score', '分析分子量与增重策略（小分子量靶点）…', 0.4)
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
    this.report('score', '评分完成', 1)
    this.advance('af2')
  }

  // ─── 阶段 7.5：AlphaFold 预测结构（v2.0 报告头图）────────────────────────

  private async phaseAf2(): Promise<PipelineSegmentResult | null> {
    const st = this.st
    if (st.uniprotInfo && !st.afSummary) {
      try {
        this.report('report', '获取 AlphaFold 预测结构…', 0.06)
        const fig = await alphafoldFigureFor(st.uniprotInfo.uniprotId)
        if (fig) {
          st.afFigure = {
            dataUri: 'data:image/png;base64,' + fig.png.toString('base64'),
            modelId: fig.meta.modelId,
            globalPlddt: fig.meta.globalPlddt,
            version: fig.meta.latestVersion,
            fracVeryHigh: fig.meta.fracVeryHigh,
          }
          st.afSummary = {
            available: true, modelId: fig.meta.modelId, globalPlddt: fig.meta.globalPlddt,
            version: fig.meta.latestVersion, fracVeryHigh: fig.meta.fracVeryHigh,
          }
          this.log(`AlphaFold 预测获取成功：${fig.meta.modelId}（平均 pLDDT ${fig.meta.globalPlddt ?? '—'}，v${fig.meta.latestVersion}）— pLDDT 着色结构图已渲染`)
        } else {
          st.afSummary = { available: false, note: '该靶点在 AlphaFold DB 无预测或渲染失败' }
          this.log('AlphaFold 预测结构：不可用（无预测/渲染失败），报告将以无图呈现')
        }
      } catch {
        st.afSummary = { available: false, note: 'AlphaFold 预测获取失败' }
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
      goal: st.goal || undefined,
      goalHints: st.goalHints,
      insights: st.insights ?? undefined,
      batchNote: this.input.batchNote,
      providedSequence: st.providedSequence && st.comparison
        ? { sequence: st.providedSequence, comparison: st.comparison }
        : undefined,
      range: this.input.options.range,
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
      mwAugment: st.mwAugment!,
      interaction: st.interaction ?? undefined,
    }
  }

  private async phaseReport(): Promise<PipelineSegmentResult | null> {
    const st = this.st
    const deferReport = this.input.options.reportMode === 'deferred'
    if (deferReport) {
      // 关联靶点批量：跳过单靶点报告 — 全部靶点完成后由合并报告统一生成
      this.report('report', '报告并入合并评估报告（本靶点数据已就绪）…', 1)
      this.log('跳过单靶点 LLM 报告：本批次判定为关联靶点，将合并生成一份含关系分析的报告')
      st.reportDone = true
      this.advance('render')
      return null
    }
    if (!st.reportDone) {
      this.report('report', '整理数据上下文…', 0.05)
      // v2.6 分段模式：单段 LLM 调用超时收紧到段预算内（慢引擎不至于超出网关
      // 切断时长；超时段 llmOk=false 且不视为已完成 — 下一段自动重试）
      const segMode = this.cb.deadline != null && this.cb.deadline > 0
      const partTimeoutMs = segMode ? Math.max(25_000, Math.min(70_000, budgetLeft(this.cb))) : undefined
      const gen = await generateReportSections(this.reportContext(), this.signal, {
        deadline: this.cb.deadline,
        completedParts: st.reportParts.length ? st.reportParts : undefined,
        partTimeoutMs,
      })
      // v2.6：失败段下一段重试后可能同 key 重复 — 保留最新一条（成功覆盖失败）
      const byKey = new Map<string, ReportPart>()
      for (const p of gen.parts) byKey.set(p.key, p)
      st.reportParts = ['A', 'B', 'C'].map(k => byKey.get(k)).filter((p): p is ReportPart => Boolean(p))
      const labels = ['摘要与背景', '结构研究全景', '可行性与策略']
      for (let i = 0; i < gen.parts.length; i++) {
        const p = gen.parts[i]
        this.report('report', `LLM 第 ${i + 1}/3 段（${labels[i] ?? p.key}）${p.llmOk ? '完成' : '失败'}${p.llmOk ? `（${p.markdown.length} 字）` : `：${p.error}`}`, (i + 1) / 3)
        this.log(`LLM 报告段 ${p.key} ${p.llmOk ? `完成（${p.markdown.length} 字）` : `失败：${p.error}`}`, p.llmOk ? 'info' : 'warn')
      }
      if (gen.partial) {
        // v2.6：预算到点 — 已完成段保留，交还续跑（下一段生成缺失段）
        return this.handoff()
      }
      st.reportDone = true
    }
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
      const generatedErrors = parts.filter(p => !p.llmOk).map(p => `段${p.key}: ${p.error}`)
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
        resolveImagePath: (meta) => {
          const ext = meta.mime.includes('png') ? 'png' : meta.mime.includes('gif') ? 'gif' : meta.mime.includes('webp') ? 'webp' : 'jpg'
          return path.join(st.assetDir, `${meta.id}.${ext}`)
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
        proteinName: st.uniprotInfo?.proteinName ?? '未知靶点（序列输入）',
        geneNames: st.uniprotInfo?.geneNames ?? [],
        organism: st.uniprotInfo?.organism ?? '',
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
      },
      methodStats: st.scores!.methodStats,
      ligandCount: new Set(st.directPdbs.flatMap(p => p.ligands.map(l => l.split('(')[0].trim()))).size,
      literatureCount: st.literature.length,
      imageCount: st.images.length,
      durationMs,
      blast: st.blastStatus,
      coverageText: st.coverageText || undefined,
      gapText: st.gapText || undefined,
      oligomer: st.oligomer!,
      ligands: st.ligandResolved.length ? st.ligandResolved : undefined,
      alphafold: st.afSummary ?? undefined,
      /** v1.29：互作复合物证据分析（无直接结构时；无证据时 hasEvidence=false 亦存档） */
      interaction: st.interaction ?? undefined,
      /** v1.26：分子量增重策略分析（小分子量靶点；applicable=false 时亦存档） */
      mwAugment: st.mwAugment!,
      reportLlmOk: deferReport ? undefined : st.reportParts.some(p => p.llmOk),
      reportDeferred: deferReport || undefined,
      batchNote: this.input.batchNote,
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
          reportMarkdown: !deferReport && st.reportMarkdown ? st.reportMarkdown : null,
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
          create: { id: rowId, jobId: this.input.jobId, kind: meta.kind, caption: meta.caption, mime: meta.mime, size: meta.sizeKB * 1024, path: path.join(st.assetDir, `${meta.id}.${ext}`), order: i, vlm: meta.vlmKind ?? false },
          update: { order: i, vlm: meta.vlmKind ?? false },
        }).catch(() => undefined)
      }
    }

    this.log(`评估完成：总耗时 ${(durationMs / 1000).toFixed(1)}s${deferReport ? '（报告已并入合并评估报告）' : '，报告已生成'}`)

    // v2.4：同步评估模式 — 直接把最终数据交给调用方（不依赖 DB 读回）
    const result: PipelineResult = {
      summary,
      directPdbs: st.directPdbs,
      blastHits: st.blastHits,
      literature: st.literature,
      reportPath,
      reportMarkdown: !deferReport && st.reportMarkdown ? st.reportMarkdown : null,
    }
    this.cb.onComplete?.(result)
    return { done: true, result }
  }
}
