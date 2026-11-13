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
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { db } from '@/lib/db'
import { fetchUniprotInfo, identifyUniprotBySequence, normalizeSequenceInput } from './uniprot'
import { fetchPdbEntries, fetchPdbIdsForUniprot } from './rcsb'
import { fetchPdbeCoverage, describeCoverage, uncoveredRanges } from './pdbe'
import { submitBlastPdb, collectBlastPdbWithRescue, enrichBlastHits, runBlastWithRetry } from './blast'
import { searchRcsbHomologs, fetchUniprotForEntryEntity } from './rcsb-search'
import { buildLiteratureQuery, searchPubmed, fetchPubmedByPmids } from './pubmed'
import { computeScores } from './score'
import { analyzeOligomericState } from './oligomer'
import { analyzeInteractionEvidence } from './interaction'
import { analyzeMwAugmentation } from './mw-augment'
import { generateReportSections, type ReportContext } from './report'
import { renderReportHtml } from './report-html'
import { compareSequences, describeComparison } from './seq-compare'
import { detectAntibody } from './antibody'
import { getEngineSummary } from './llm-provider'
import { filterPdbsByRange, filterBlastByRange } from './range-filter'
import { extractLigandsFromText, fetchLigandStructures, normalizeLigandRaw, resolveLigandInput, type LigandInput, type LigandResolution } from './ligand'
import { alphafoldFigureFor } from './alphafold'
import { isValidUniprotId, type BlastGroup, type BlastHit, type BlastStatusInfo, type EvaluationOptions, type FormInsights, type InputMode, type InteractionAnalysis, type JobSummary, type LiteratureItem, type MwAugmentAnalysis, type OligomerAnalysis, type ParsedImage, type PdbEntry, type PdbeCoverageResult, type AlphafoldSummaryInfo, type SequenceComparison, type UniprotInfo } from './types'

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

/** 组声明（首个到达 BLAST 提交阶段的作业 = 家族代表） */
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

export async function runPipeline(input: PipelineInput, cb: PipelineCallbacks): Promise<void> {
  const t0 = Date.now()
  const { signal, report, log } = cb
  const maxPdb = Math.min(300, Math.max(20, input.options.maxPdb || 150))

  // ─── 阶段 1：输入解析 ──────────────────────────────────────────────────────
  report('input', '解析输入…', 0.3)
  let goal = input.goal?.trim() || ''
  let goalHints: string[] = []
  let insights: FormInsights | null = null
  let images: ParsedImage[] = []
  let assetDir = ''
  let providedSequence = '' // 客户提供的伴随序列（合并评估：UniProt 为主 + 序列做构建边界分析）
  let uploadFullText = ''
  let comparison: SequenceComparison | null = null

  if (input.uploadId) {
    const parsed = await readUploadParsed(input.uploadId)
    if (parsed) {
      if (parsed.goalHints?.length) goalHints = parsed.goalHints
      images = parsed.images ?? []
      if (parsed.fullText) uploadFullText = parsed.fullText
    } else if (input.evalTable) {
      // v2.4 无状态部署：磁盘无 parsed.json（实例不保留状态）→ 使用前端内联携带的评估表数据
      if (input.evalTable.goalHints?.length) goalHints = input.evalTable.goalHints
      images = input.evalTable.images ?? []
      if (input.evalTable.fullText) uploadFullText = input.evalTable.fullText
      log('评估表数据以内联模式提供（无状态部署），实验图片与目标提示可用')
    } else {
      log('评估表解析数据缺失（上传目录可能已过期清理），胶图/SEC 图片与目标提示不可用，建议重新上传评估表', 'warn')
    }
    insights = await readUploadInsights(input.uploadId)
    if (!insights && input.evalTable?.insights) insights = input.evalTable.insights
    // 用户未显式填目标时，自动采用 LLM 解析出的客户目标
    if (!goal && insights?.goals?.length) {
      goal = insights.goals.slice(0, 3).join('；')
      log(`已自动采用评估表解析出的客户目标（${insights.goals.length} 条）`)
      // 持久化到作业记录（结果页刊头展示）
      void db.evaluationJob.update({
        where: { id: input.jobId },
        data: { goal: goal.slice(0, 2000) },
      }).catch(() => undefined)
    }
    if (insights?.goals?.length) goalHints = [...new Set([...insights.goals, ...goalHints])]
  } else if (input.evalTable) {
    // v2.4：无 uploadId 但携带了内联评估表数据（如无状态模式下未传 uploadId）
    if (input.evalTable.goalHints?.length) goalHints = input.evalTable.goalHints
    images = input.evalTable.images ?? []
    if (input.evalTable.fullText) uploadFullText = input.evalTable.fullText
    insights = input.evalTable.insights ?? null
    if (!goal && insights?.goals?.length) {
      goal = insights.goals.slice(0, 3).join('；')
      log(`已自动采用评估表解析出的客户目标（${insights.goals.length} 条）`)
    }
    if (insights?.goals?.length) goalHints = [...new Set([...insights.goals, ...goalHints])]
  }

  let uniprotInfo: UniprotInfo | null = null
  let sequence = ''
  let uniprotIdInput: string | null = null

  if (input.mode === 'uniprot') {
    const id = (input.uniprot ?? '').trim().toUpperCase()
    if (!isValidUniprotId(id)) throw new Error(`UniProt ID 格式无效：${id}（应为 6 或 10 位 accession，如 P00533 / A0A8G0KJC2）`)
    uniprotIdInput = id
    // 伴随序列（可选）：同一靶点时合并为一次评估，避免重复评估
    if (input.sequence?.trim()) {
      const norm = normalizeSequenceInput(input.sequence)
      if (norm.ok) {
        providedSequence = norm.seq
        report('input', `UniProt ${id} + 伴随序列 ${norm.length} aa → 合并为单次评估（以 UniProt 为主）`, 0.9)
      } else {
        log(`伴随序列无效（识别到 ${norm.length} 个残基，需 ≥30），已忽略`, 'warn')
        report('input', `输入 UniProt ID：${id}`, 0.8)
      }
    } else {
      report('input', `输入 UniProt ID：${id}`, 0.8)
    }
  } else if (input.mode === 'docx') {
    // docx：优先用解析出的 UniProt（序列用于构建比对）；否则用评估表中的序列
    const id = (input.uniprot ?? '').trim().toUpperCase()
    if (id && isValidUniprotId(id)) {
      uniprotIdInput = id
      if (input.sequence?.trim()) {
        const norm = normalizeSequenceInput(input.sequence)
        if (norm.ok) {
          providedSequence = norm.seq
          report('input', `评估表：UniProt ${id} + 序列 ${norm.length} aa → 合并单次评估`, 0.9)
        } else {
          report('input', `评估表解析出 UniProt ID：${id}`, 0.8)
        }
      } else {
        report('input', `评估表解析出 UniProt ID：${id}`, 0.8)
      }
    } else if (input.sequence) {
      const norm = normalizeSequenceInput(input.sequence)
      if (!norm.ok) throw new Error(`评估表中的序列无效：识别到 ${norm.length} 个残基（需 ≥30）`)
      sequence = norm.seq
      report('input', `评估表解析出序列：${norm.length} aa`, 0.8)
    } else {
      throw new Error('docx 模式需要评估表中解析出的 uniprot 或 sequence')
    }
  } else {
    // 纯序列输入
    const norm = normalizeSequenceInput(input.sequence ?? '')
    if (!norm.ok) throw new Error(`序列无效：识别到 ${norm.length} 个残基（需 ≥30 且为蛋白氨基酸序列）`)
    sequence = norm.seq
    report('input', `输入序列：${norm.length} aa${norm.header ? `（${norm.header.slice(0, 60)}）` : ''}`, 0.8)
  }
  report('input', '输入解析完成', 1)

  // ─── 阶段 2：UniProt 元数据 ────────────────────────────────────────────────
  const uniprotIdToFetch = uniprotIdInput ?? null
  if (uniprotIdToFetch) {
    report('uniprot', `获取 UniProt ${uniprotIdToFetch} 元数据…`, 0.4)
    const info = await fetchUniprotInfo(uniprotIdToFetch)
    if (!info) throw new Error(`UniProt ${uniprotIdToFetch} 查询失败（ID 不存在或网络错误）`)
    uniprotInfo = info
    if (providedSequence) {
      // 合并评估：提供的序列 vs 全长序列 → 同靶点判定 + 构建边界估计
      comparison = compareSequences(providedSequence, info.sequence)
      if (comparison.sameTarget) {
        log(`序列比对：${describeComparison(comparison)} → 判定同一靶点，合并评估（以 UniProt ${info.uniprotId} 为主，序列用于构建分析）`)
        sequence = providedSequence // BLAST 与构建分析使用客户构建序列
      } else {
        log(`序列比对：相似度 ${comparison.identity}% 低于同靶点阈值（85%）→ 按 UniProt ${info.uniprotId} 评估；提供序列可能为不同靶点/同源蛋白或抗体，已避免重复评估`, 'warn')
        sequence = info.sequence // 提供序列疑似不同靶点（如抗原靶点 + 抗体序列）：BLAST 回退用 UniProt 全长
      }
    } else if (!sequence) {
      sequence = info.sequence
    }
    log(`UniProt 元数据完成：${info.entryName}（${info.proteinName}，${info.sequenceLength} aa，${info.organism}）`)
  } else {
    // 纯序列输入：快速尝试精确肽段识别（失败则等 BLAST 兜底）
    report('uniprot', '尝试识别序列对应的 UniProt 条目…', 0.5)
    const acc = await identifyUniprotBySequence(sequence)
    if (acc) {
      const info = await fetchUniprotInfo(acc)
      if (info) {
        uniprotInfo = info
        log(`序列识别命中 UniProt ${acc}（${info.proteinName}）`)
      }
    } else {
      log('序列未能直接匹配 UniProt，将由 BLAST 兜底识别', 'warn')
    }
  }

  // ─── 阶段 2.5：BLAST 提前提交（非阻塞 — 等待期先做其他数据检索）───────────
  let blastHits: BlastHit[] = []
  let blastStatus: BlastStatusInfo = { status: 'ok' }
  let blastSubmitted: { rid: string; rtoe: number } | null = null
  const abVerdict = detectAntibody(sequence)
  const blastDisabledByOption = Boolean(input.options.skipBlast)
  const blastDisabledByAntibody = abVerdict.isAntibody && !input.options.forceBlast
  /** v1.11：本作业是否为 ≥90% 高一致组的家族代表（唯一提交 BLAST 者） */
  let familyRep = false

  if (blastDisabledByOption) {
    blastStatus = { status: 'skipped-disabled' }
    log('跳过 BLAST：已在高级选项中关闭')
  } else if (blastDisabledByAntibody) {
    // 抗体序列：BLAST pdbaa 会命中海量抗体恒定区结构，对靶点可行性评估无增量价值
    blastStatus = { status: 'skipped-antibody', note: abVerdict.evidence.slice(0, 2).join('；') }
    log(`跳过 BLAST：检测到抗体序列（${abVerdict.evidence.join('；')}）— 抗体结构库命中众多但参考价值低`)
  } else if (sequence.length >= 30) {
    // v1.11 同源家族委托：组内首个到达此处的作业认领代表并提交；其余成员跳过检索，
    // 合并报告时共享代表结果（用户反馈：≥90% 一致性不必每个都搜）
    if (input.homologBlast && !input.options.forceBlast) {
      const hb = input.homologBlast
      const holder = claimBlastFamily(hb.groupKey, input.jobId, uniprotIdInput ?? input.jobId.slice(0, 8))
      if (holder) {
        blastStatus = {
          status: 'skipped-homolog',
          note: `家族代表 ${holder.uniprotId} 已提交同源检索（组内序列一致性 ≥${hb.minIdentity}%），结果将共享给本靶点`,
        }
        log(`跳过 BLAST：同源家族（一致性 ≥${hb.minIdentity}%）已委托代表 ${holder.uniprotId} 统一检索，结果合并时共享 — 不重复检索`)
        report('uniprot', `同源家族 ≥${hb.minIdentity}%：由代表 ${holder.uniprotId} 统一检索，本靶点共享结果`, 1)
      } else {
        familyRep = true
        log(`本靶点担任同源组（一致性 ≥${hb.minIdentity}%，${hb.members.length} 成员）的 BLAST 家族代表 — 结果将共享给其他成员`)
      }
    }
    if (blastStatus.status !== 'skipped-homolog') {
      try {
        report('uniprot', 'BLAST 已提前提交，等待期间先进行其他数据检索…', 1)
        blastSubmitted = await submitBlastPdb(sequence, msg => log(msg), signal)
        log(`BLAST 提前提交完成（RID=${blastSubmitted.rid}，预计 ${blastSubmitted.rtoe}s）— 文献/结构检索与 NCBI 计算并行进行`)
      } catch (e) {
        if (signal.aborted) throw e
        const msg = e instanceof Error ? e.message : String(e)
        blastStatus = { status: 'failed', note: `提交失败：${msg.slice(0, 100)}` }
        if (familyRep && input.homologBlast) releaseBlastFamily(input.homologBlast.groupKey, input.jobId)
        log(`BLAST 提交失败：${msg}（稍后阶段将尝试 RCSB 序列检索兜底）`, 'warn')
      }
    }
  }

  // ─── 阶段 3：RCSB PDB 检索 ────────────────────────────────────────────────
  let directPdbs: PdbEntry[] = []
  let totalPdbFound = 0
  if (uniprotInfo) {
    report('rcsb', 'RCSB 检索关联 PDB 结构…', 0.05)
    const pdbIds = await fetchPdbIdsForUniprot(uniprotInfo.uniprotId, 500)
    totalPdbFound = pdbIds.length
    log(`RCSB 检索到 ${pdbIds.length} 个关联 PDB`)
    if (pdbIds.length > 0) {
      const result = await fetchPdbEntries(
        pdbIds,
        maxPdb,
        (done, total) => report('rcsb', `拉取 PDB 详情 ${done}/${total}`, done / total),
        signal,
      )
      directPdbs = result.entries
      backfillChainRanges(directPdbs, uniprotInfo)
      if (input.options.range) {
        const before = directPdbs.length
        directPdbs = filterPdbsByRange(directPdbs, input.options.range)
        if (before !== directPdbs.length) log(`PDB 范围过滤：${before} → ${directPdbs.length}（限定 ${input.options.range[0]}-${input.options.range[1]}）`)
      }
      const ligCount = directPdbs.filter(p => p.ligands.length > 0).length
      log(`PDB 详情完成：${directPdbs.length} 个结构（含配体 ${ligCount} 个）`)
    }
    report('rcsb', `PDB 结构检索完成（${directPdbs.length} 个）`, 1)
  } else {
    report('rcsb', '无 UniProt ID，跳过直接检索（BLAST 阶段识别结构）', 1)
    log('跳过 RCSB 直接检索：暂无 UniProt ID')
  }

  // ─── 阶段 3.5：配体归一与研究检索（v2.0；置于 RCSB 后、与 BLAST 等待期重叠）────────
  let ligandResults: LigandResolution[] = []
  {
    const candidates: LigandInput[] = [...(input.ligands ?? [])]
    // 评估表识别：字典扫描（保守长 key）+ LLM 提取（insights.ligands，若有）
    if (input.uploadId) {
      for (const m of extractLigandsFromText(uploadFullText)) {
        candidates.push({ raw: m.compId, source: 'eval-table' })
      }
      for (const name of insights?.ligands ?? []) {
        if (name.trim()) candidates.push({ raw: name.trim().slice(0, 160), source: 'eval-table' })
      }
    }
    // 归一去重（同 raw 不重复解析；同批次多靶点由 LRU 缓存共享外部调用）
    const seen = new Map<string, LigandInput>()
    for (const c of candidates) {
      const key = normalizeLigandRaw(c.raw).replace(/[\s-]/g, '')
      if (!key || seen.has(key)) continue
      seen.set(key, c)
    }
    const unique = [...seen.values()].slice(0, 8)
    if (unique.length > 0) {
      report('rcsb', `归一配体输入 ${unique.length} 项（ID/别名/PDBe 检索/AI 多策略）…`, 0.96)
      const resolved: LigandResolution[] = []
      let cursor = 0
      const worker = async () => {
        while (cursor < unique.length) {
          if (signal.aborted) return
          const item = unique[cursor++]
          try {
            resolved.push(await resolveLigandInput(item, signal))
          } catch (e) {
            if (signal.aborted) throw e
            resolved.push({
              raw: item.raw, source: item.source, fileName: item.fileName, ok: false,
              compId: '', name: '', formula: '', weight: null, strategy: '',
              totalStructures: 0, structures: [], error: '解析异常',
            })
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(3, unique.length) }, () => worker()))
      // 已识别配体 → 检索含该配体的结构列表
      const directSet = new Set(directPdbs.map(p => p.pdbId))
      for (const r of resolved) {
        if (!r.ok || !r.compId) continue
        try {
          const s = await fetchLigandStructures(r.compId, directSet, signal)
          r.totalStructures = s.total
          r.structures = s.structures.slice(0, 12)
        } catch { /* 检索失败不影响归一结果 */ }
      }
      ligandResults = resolved
      const okList = resolved.filter(r => r.ok)
      if (resolved.length) {
        log(`配体归一完成：${okList.length}/${resolved.length} 项识别${okList.length ? `（${okList.map(r => `${r.raw} → ${r.compId || `PubChem CID ${r.pubchem?.cid ?? '?'}`}·${r.strategy}·${r.totalStructures} 结构`).join('；').slice(0, 400)}）` : ''}`)
        for (const r of resolved.filter(x => !x.ok)) {
          log(`配体未识别：「${r.raw}」— ${r.error ?? '未知原因'}`, 'warn')
        }
        report('rcsb', `配体归一完成（${okList.length}/${resolved.length} 项识别）`, 1)
      }
    }
  }

  // ─── 阶段 4：PDBe 覆盖率 ──────────────────────────────────────────────────
  let coverage: PdbeCoverageResult | null = null
  let coverageText = ''
  let gapText = ''
  if (uniprotInfo) {
    report('pdbe', 'PDBe 计算结构覆盖率…', 0.5)
    try {
      coverage = await fetchPdbeCoverage(uniprotInfo.uniprotId, uniprotInfo.sequenceLength)
      coverageText = describeCoverage(coverage.coveredRanges, uniprotInfo.sequenceLength)
      const gaps = uncoveredRanges(coverage.coveredRanges, uniprotInfo.sequenceLength)
      gapText = gaps.map(([a, b]) => `${a}-${b} (${b - a + 1} aa)`).join(', ')
      log(`PDBe 覆盖率：${coverage.coveragePercent}%${gapText ? `，未覆盖区间：${gapText.slice(0, 200)}` : ''}`)
    } catch (e) {
      log(`PDBe 覆盖率计算失败：${e instanceof Error ? e.message : e}`, 'warn')
    }
    report('pdbe', coverage ? `覆盖率 ${coverage.coveragePercent}%` : '覆盖率不可用', 1)
  } else {
    report('pdbe', '跳过（无 UniProt）', 1)
  }

  // ─── 阶段 5：PubMed 文献（先于 BLAST 收集 — 利用 NCBI 计算等待期）─────────
  let literature: LiteratureItem[] = []
  report('pubmed', '检索 PubMed 结构生物学文献…', 0.3)
  try {
    const geneNames = uniprotInfo?.geneNames ?? []
    const proteinName = uniprotInfo?.proteinName ?? ''
    const organism = uniprotInfo?.organism ?? ''
    const query = buildLiteratureQuery(geneNames, proteinName, organism)
    if (query) {
      literature = await searchPubmed(query, 15)
      log(`PubMed 检索完成：${literature.length} 篇相关文献`)
    } else {
      log('无法构造文献检索式（缺基因/蛋白名）', 'warn')
    }
  } catch (e) {
    log(`PubMed 检索失败：${e instanceof Error ? e.message : e}`, 'warn')
  }

  // PDB 主引文（结构解析论文）并入文献列表，建立 PDB ↔ 文献关联
  const structPmids: string[] = []
  const seenPmid = new Set<string>(literature.map(l => String(l.pmid)))
  for (const p of directPdbs) {
    const pid = (p.pubmedId ?? '').trim()
    if (pid && !seenPmid.has(pid)) {
      seenPmid.add(pid)
      structPmids.push(pid)
    }
    if (structPmids.length >= 20) break
  }
  if (structPmids.length > 0) {
    report('pubmed', `拉取 ${structPmids.length} 篇 PDB 主引文文献详情…`, 0.7)
    try {
      const structLits = (await fetchPubmedByPmids(structPmids))
        .map(l => ({ ...l, fromPdb: true as const }))
        .filter(l => !literature.some(x => String(x.pmid) === String(l.pmid)))
      // 结构解析文献置前（与结构条目直接关联），按年份降序
      structLits.sort((a, b) => Number(b.year || 0) - Number(a.year || 0))
      literature = [...structLits, ...literature]
      log(`PDB 主引文并入：${structLits.length} 篇结构解析文献（与结构条目直接关联）`)
    } catch (e) {
      log(`PDB 主引文拉取失败：${e instanceof Error ? e.message : e}`, 'warn')
    }
  }
  report('pubmed', `文献检索完成（${literature.length} 篇）`, 1)

  // ─── 阶段 6：BLAST 结果收集（仍在运行不判超时失败；NCBI 拥堵/失败 → RCSB 兜底）──
  const coveragePct = coverage?.coveragePercent ?? 0
  const coverageSufficient = uniprotInfo && directPdbs.length >= 5 && coveragePct >= 50
  if (blastStatus.status === 'skipped-disabled') {
    report('blast', '已按选项跳过 BLAST', 1)
  } else if (blastStatus.status === 'skipped-antibody') {
    report('blast', '抗体序列 — 已跳过 BLAST 同源检索', 1)
  } else if (blastStatus.status === 'skipped-homolog') {
    // v1.11：家族委托成员 — 本身不检索；代表的命中在合并报告阶段传播过来（排除自身直接结构后入库）
    report('blast', '同源家族已委托代表检索（结果将在合并时共享给本靶点）', 1)
  } else if (coverageSufficient && !input.options.forceBlast && !familyRep) {
    // 结构证据已充分：不再收集已提交的 BLAST 结果（避免低价值噪声）。
    // 例外（v1.11）：家族代表不弃用 — 组内 ≥90% 成员还等着共享这份检索结果
    blastStatus = { status: 'skipped-covered' }
    report('blast', '结构覆盖充分，无需同源检索结果', 1)
    log(`跳过 BLAST 收集：直接结构 ${directPdbs.length} 个且覆盖率 ${coveragePct}%，结构证据已充分（已提交的 NCBI 任务弃用）`)
  } else if (blastSubmitted) {
    report('blast', `收集 BLAST 结果（RID=${blastSubmitted.rid}，等待期间已完成结构/文献检索）…`, 0.2)
    try {
      const outcome = await collectBlastPdbWithRescue(
        blastSubmitted.rid,
        blastSubmitted.rtoe,
        sequence,
        msg => report('blast', msg, 0.5),
        signal,
      )
      const rawHits = outcome.hits
      const viaRescue = outcome.provider === 'rcsb'
      const directSet = new Set(directPdbs.map(p => p.pdbId))
      const filtered = rawHits.filter(h => h.pdbId && !directSet.has(h.pdbId))
      blastHits = await enrichBlastHits(filtered, directSet)
      if (input.options.range) blastHits = filterBlastByRange(blastHits, input.options.range)
      blastStatus = {
        status: blastHits.length > 0 ? 'ok' : 'no-hits',
        note: blastHits.length > 0 ? `${blastHits.length} 个同源命中${familyRep ? `（家族代表检索：结果将共享给 ≥${input.homologBlast?.minIdentity ?? 90}% 一致性的同源成员）` : ''}` : undefined,
        provider: outcome.provider,
      }
      log(
        viaRescue
          ? `同源检索经 RCSB 序列检索兜底完成（${outcome.rescueNote}）：${rawHits.length} 个命中，去重/排除直接命中后 ${blastHits.length} 个 — 已提交的 NCBI 任务弃用`
          : `BLAST 完成：${rawHits.length} 个命中，去重/排除直接命中后 ${blastHits.length} 个`,
      )
      // 序列模式且尚未识别 UniProt：从最佳命中回填
      if (!uniprotInfo && blastHits.length > 0) {
        const best = rawHits[0]
        const acc = viaRescue
          ? await fetchUniprotForEntryEntity(best.pdbId)
          : uniprotFromBlastDesc(best.description)
        if (acc && best.identity >= 85) {
          log(`从同源命中识别 UniProt ${acc}（identity ${best.identity}%），回填元数据…`)
          const info = await fetchUniprotInfo(acc)
          if (info) {
            uniprotInfo = info
            // 回填后补做 RCSB + PDBe（一次性，不再展开子进度）
            report('rcsb', '回填 UniProt 后补检索 PDB…', 0.5)
            const pdbIds = await fetchPdbIdsForUniprot(info.uniprotId, 500)
            totalPdbFound = pdbIds.length
            if (pdbIds.length) {
              const r = await fetchPdbEntries(pdbIds, maxPdb, (d, t) => report('rcsb', `补拉 PDB 详情 ${d}/${t}`, d / t), signal)
              directPdbs = r.entries
              backfillChainRanges(directPdbs, info)
              if (input.options.range) directPdbs = filterPdbsByRange(directPdbs, input.options.range)
              const directSet2 = new Set(directPdbs.map(p => p.pdbId))
              blastHits = (await enrichBlastHits(filtered, directSet2)).filter(h => !directSet2.has(h.pdbId))
              if (input.options.range) blastHits = filterBlastByRange(blastHits, input.options.range)
              blastStatus = {
                status: blastHits.length > 0 ? 'ok' : 'no-hits',
                note: blastHits.length > 0 ? `${blastHits.length} 个同源命中` : undefined,
                provider: outcome.provider,
              }
            }
            report('pdbe', '补算 PDBe 覆盖率…', 0.5)
            try {
              coverage = await fetchPdbeCoverage(info.uniprotId, info.sequenceLength)
              coverageText = describeCoverage(coverage.coveredRanges, info.sequenceLength)
              const gaps = uncoveredRanges(coverage.coveredRanges, info.sequenceLength)
              gapText = gaps.map(([a, b]) => `${a}-${b} (${b - a + 1} aa)`).join(', ')
            } catch { /* 忽略 */ }
          }
        }
      }
      report(
        'blast',
        viaRescue
          ? `同源检索完成（RCSB 兜底，${blastHits.length} 个同源结构）`
          : `BLAST 完成（${blastHits.length} 个同源结构）`,
        1,
      )
    } catch (e) {
      if (signal.aborted) throw e
      const msg = e instanceof Error ? e.message : String(e)
      blastStatus = { status: 'failed', note: msg.slice(0, 120) }
      if (familyRep && input.homologBlast) releaseBlastFamily(input.homologBlast.groupKey, input.jobId)
      log(`BLAST 失败：${msg}（继续后续阶段；家族成员将在合并时自行兜底检索）`, 'warn')
      report('blast', 'BLAST 不可用（已跳过）', 1)
    }
  } else if (blastStatus.status === 'failed' && sequence.length >= 30) {
    // 提交阶段失败（网络/NCBI 拒收）→ 直接 RCSB 序列检索兜底（v1.9）
    const submitErr = blastStatus.note ?? '提交失败'
    report('blast', `NCBI 提交失败（${submitErr.slice(0, 60)}）— 尝试 RCSB 序列检索获得同源结构…`, 0.4)
    try {
      const rawHits = await searchRcsbHomologs(sequence, { signal })
      const directSet = new Set(directPdbs.map(p => p.pdbId))
      const filtered = rawHits.filter(h => h.pdbId && !directSet.has(h.pdbId))
      blastHits = await enrichBlastHits(filtered, directSet)
      if (input.options.range) blastHits = filterBlastByRange(blastHits, input.options.range)
      blastStatus = {
        status: blastHits.length > 0 ? 'ok' : 'no-hits',
        note: blastHits.length > 0 ? `${blastHits.length} 个同源命中` : undefined,
        provider: 'rcsb',
      }
      log(`RCSB 序列检索兜底完成：${rawHits.length} 个命中，去重/排除直接命中后 ${blastHits.length} 个（NCBI 提交失败：${submitErr}）`)
      report('blast', `同源检索完成（RCSB 兜底，${blastHits.length} 个同源结构）`, 1)
    } catch (e2) {
      if (signal.aborted) throw e2
      const msg2 = e2 instanceof Error ? e2.message : String(e2)
      if (familyRep && input.homologBlast) releaseBlastFamily(input.homologBlast.groupKey, input.jobId)
      blastStatus = { status: 'failed', note: `NCBI 提交失败：${submitErr.slice(0, 60)}；RCSB 兜底亦失败：${msg2.slice(0, 60)}` }
      log(`RCSB 兜底亦失败：${msg2}（继续后续阶段；家族成员将在合并时自行兜底检索）`, 'warn')
      report('blast', '同源检索不可用（已跳过）', 1)
    }
  } else {
    // 序列过短（<30 aa）未提交等剩余情形
    if (blastStatus.status === 'ok') blastStatus = { status: 'skipped-covered', note: '序列过短（<30 aa），未提交同源检索' }
    report('blast', '未运行同源检索', 1)
    log(`BLAST 阶段跳过：${blastStatus.note ?? '未提交'}`)
  }

  // ─── 阶段 6.5：结构证据守门（v1.28，用户反馈「无结构且 BLAST 失败时不要贸然生成报告」）──
  // 无直接结构 + 同源检索失败 = 结构证据缺位，此时生成的评分与建议缺乏依据、
  // 可能误导决策 → 先给检索一次 last-resort 整周期重试机会；
  // v1.29：重试仍失败不立即中止 — 互作复合物证据（阶段 6.6）可作为替代评估依据，
  // 互作也无证据才中止（裁决后置到 6.6 之后）
  let blastRetryFailed = false
  if (
    blastStatus.status === 'failed'   // 仅拦截真失败（no-hits 是有效科学结论；skipped-* 均为设计内跳过）
    && directPdbs.length === 0
    && blastHits.length === 0
    && sequence.length >= 20
  ) {
    const failNote = blastStatus.note ?? '未知原因'
    report('blast', `无直接结构且同源检索失败 — 启动最后一道整周期重试（避免生成缺乏结构证据的报告）…`, 0.5)
    log(`结构证据守门：直接结构 0 个 + 同源检索失败（${failNote}）→ 启动 last-resort 整周期重试（RCSB 直连 + NCBI 完整周期，最多 2 轮）`, 'warn')
    try {
      const rescue = await runBlastWithRetry(
        sequence,
        msg => report('blast', msg, 0.7),
        signal,
      )
      const directSet = new Set(directPdbs.map(p => p.pdbId))
      const filtered = rescue.hits.filter(h => h.pdbId && !directSet.has(h.pdbId))
      blastHits = await enrichBlastHits(filtered, directSet)
      if (input.options.range) blastHits = filterBlastByRange(blastHits, input.options.range)
      blastStatus = {
        status: blastHits.length > 0 ? 'ok' : 'no-hits',
        note: blastHits.length > 0
          ? `${blastHits.length} 个同源命中（last-resort 重试：${rescue.note}）`
          : `检索完成但无同源命中（last-resort 重试：${rescue.note}）— 全新靶点，结构证据以文献为准`,
        provider: rescue.provider,
      }
      log(`last-resort 重试成功：${rescue.note}，去重后 ${blastHits.length} 个同源命中 — 结构证据已获取，继续生成报告`)
      report('blast', `同源检索重试成功（${blastHits.length} 个同源结构）`, 1)
    } catch (e) {
      if (signal.aborted) throw e
      const msg = e instanceof Error ? e.message : String(e)
      blastRetryFailed = true
      log(`last-resort 重试仍失败：${msg} — 将检查互作复合物证据（Complex Portal/IntAct）后再裁决是否中止`, 'warn')
      report('blast', '同源检索重试失败 — 转向互作复合物证据检索…', 0.9)
    }
  }

  // ─── 阶段 6.6：互作复合物证据（v1.29，无直接结构时）────────────────────
  // 用户需求：搜不到结构时参考 UniProt Interaction（IntAct binary + Complex viewer
  // 复合物）评估打分；curated 复合物其他组分有结构 → 检索列出作为评估依据
  let interaction: InteractionAnalysis | null = null
  if (uniprotInfo && directPdbs.length === 0) {
    report('blast', '无直接结构 — 检索 UniProt 互作复合物证据（Complex Portal curated 复合物 + IntAct binary 伙伴）…', 0.92)
    interaction = await analyzeInteractionEvidence({
      uniprot: uniprotInfo,
      signal,
      onProgress: msg => log(msg),
    })
    if (interaction.hasEvidence) {
      log(`互作复合物证据：${interaction.summary}${interaction.complexes.length ? `；组分结构已列出（复合物 ${interaction.complexes.length} 个）` : ''}`)
    } else {
      log('互作复合物证据：无可用证据（无 curated 复合物、binary 伙伴无结构）', 'warn')
    }
    report('blast', `互作证据检索完成${interaction.hasEvidence ? '（有可用证据）' : '（无可用证据）'}`, 1)
  }

  // ── 守门裁决（v1.29 后置）：BLAST 重试失败 且 互作也无证据 → 中止报告 ──
  if (blastRetryFailed && (!interaction || !interaction.hasEvidence)) {
    log('结构证据守门：同源检索重试失败且互作复合物无可用证据 — 中止报告生成（避免生成缺乏结构证据、可能误导决策的报告）', 'error')
    throw new Error(
      `结构证据不足，已中止报告生成：该靶点无直接关联 PDB 结构，同源结构检索通道（NCBI BLAST / RCSB 序列检索，含多轮自动重试）与互作复合物通道（Complex Portal / IntAct）均未获得可用证据。` +
      `为避免生成缺乏结构证据、可能误导决策的评估报告，本次评估已中止 — 请稍后点击「重试评估」重新发起；若持续失败可尝试在高级选项中关闭 BLAST（报告将仅基于直接结构证据）。`,
    )
  }
  if (blastRetryFailed && interaction?.hasEvidence) {
    log(`结构证据守门：同源检索失败，但互作复合物证据可用 — 继续生成报告（评分纳入互作证据调整）`)
  }

  // ─── 阶段 7：聚集形式（寡聚态）分析 + 评分 ──────────────────────────────
  report('score', '分析蛋白聚集形式（寡聚态）…', 0.3)
  const oligomer: OligomerAnalysis = analyzeOligomericState({
    uniprot: uniprotInfo,
    directPdbs,
    blastHits,
    literature,
  })
  log(`聚集形式分析：${oligomer.summary}（证据 ${oligomer.evidence.length} 条，置信度${oligomer.confidence === 'high' ? '高' : oligomer.confidence === 'medium' ? '中' : '低'}）`)

  // v1.26/v1.27：分子量增重策略（小分子量靶点）— UniProt 伙伴长度 + RCSB 复合物装配
  // + 冲突分析；直接路径装配不足 50 kDa 时经 BLAST 同源命中扩展检索大复合物（v1.27）
  report('score', '分析分子量与增重策略（小分子量靶点）…', 0.4)
  const mwAugment: MwAugmentAnalysis = await analyzeMwAugmentation({
    uniprot: uniprotInfo,
    sequenceLength: uniprotInfo?.sequenceLength ?? sequence.length,
    oligomer,
    directPdbs,
    blastHits,
    goal: goal || undefined,
    goalHints,
    signal,
  })
  log(mwAugment.applicable
    ? `分子量增重分析：单体 ~${mwAugment.monomerKda} kDa${mwAugment.assemblyKda != null ? ` → 装配 ~${mwAugment.assemblyKda} kDa（${mwAugment.assemblyPath}；复合物结构 ${mwAugment.complexes.length} 个；同源复合物 ${(mwAugment.homologComplexes ?? []).length} 个；伙伴 ${mwAugment.partners.filter(p => p.kda != null).length} 个）` : '，无装配增重路径'}（冲突分析 ${mwAugment.conflicts.length} 条）`
    : `分子量增重分析：不适用（单体 ~${mwAugment.monomerKda} kDa ≥ 50 kDa）`)

  report('score', '计算可行性评分…', 0.5)
  const scores = computeScores({
    sequenceLength: uniprotInfo?.sequenceLength ?? sequence.length,
    features: uniprotInfo?.features ?? [],
    directPdbs,
    blastHits,
    coveragePercent: coverage?.coveragePercent ?? 0,
    oligomer,
    mwAugment,
    interaction,
  })
  log(`评分完成：X-ray ${scores.xray.score}/10 · Cryo-EM ${scores.cryoem.score}/10 · NMR ${scores.nmr.score}/10 · 总体 ${scores.overall.score}/10${scores.interactionAdjust ? `（含互作复合物调整：${scores.interactionAdjust.level === 'curated' ? scores.interactionAdjust.complexAc : 'binary 伙伴'}）` : ''}`)
  report('score', '评分完成', 1)

  // ─── 阶段 8：LLM 报告 ────────────────────────────────────────────────────
  // ─── 阶段 7.5：AlphaFold 预测结构（v2.0 报告头图）────────────────────────────
  let afFigure: { dataUri: string; modelId: string; globalPlddt: number | null; version: number; fracVeryHigh: number | null } | undefined
  let afSummary: AlphafoldSummaryInfo | undefined
  if (uniprotInfo) {
    try {
      report('report', '获取 AlphaFold 预测结构…', 0.06)
      const fig = await alphafoldFigureFor(uniprotInfo.uniprotId)
      if (fig) {
        afFigure = {
          dataUri: 'data:image/png;base64,' + fig.png.toString('base64'),
          modelId: fig.meta.modelId,
          globalPlddt: fig.meta.globalPlddt,
          version: fig.meta.latestVersion,
          fracVeryHigh: fig.meta.fracVeryHigh,
        }
        afSummary = {
          available: true, modelId: fig.meta.modelId, globalPlddt: fig.meta.globalPlddt,
          version: fig.meta.latestVersion, fracVeryHigh: fig.meta.fracVeryHigh,
        }
        log(`AlphaFold 预测获取成功：${fig.meta.modelId}（平均 pLDDT ${fig.meta.globalPlddt ?? '—'}，v${fig.meta.latestVersion}）— pLDDT 着色结构图已渲染`)
      } else {
        afSummary = { available: false, note: '该靶点在 AlphaFold DB 无预测或渲染失败' }
        log('AlphaFold 预测结构：不可用（无预测/渲染失败），报告将以无图呈现')
      }
    } catch {
      afSummary = { available: false, note: 'AlphaFold 预测获取失败' }
    }
  }

  // 图片元数据已在阶段 1 从 parsed.json 读取；这里仅定位资产目录
  if (input.uploadId) {
    assetDir = path.join(process.cwd(), 'db', 'reports', input.uploadId, 'assets')
  }

  const deferReport = input.options.reportMode === 'deferred'
  let generated: { fullMarkdown: string; ok: boolean; errors: string[] } = { fullMarkdown: '', ok: false, errors: [] }

  if (deferReport) {
    // 关联靶点批量：跳过单靶点报告 — 全部靶点完成后由合并报告统一生成
    report('report', '报告并入合并评估报告（本靶点数据已就绪）…', 1)
    log('跳过单靶点 LLM 报告：本批次判定为关联靶点，将合并生成一份含关系分析的报告')
  } else {
    report('report', '整理数据上下文…', 0.05)
    const reportCtx: ReportContext = {
      uniprot: uniprotInfo,
      sequence,
      goal: goal || undefined,
      goalHints,
      insights: insights ?? undefined,
      batchNote: input.batchNote,
      providedSequence: providedSequence && comparison
        ? { sequence: providedSequence, comparison }
        : undefined,
      range: input.options.range,
      directPdbs,
      blastHits,
      blastStatus,
      coverage,
      coverageText,
      gapText,
      literature,
      images,
      scores,
      oligomer,
      ligands: ligandResults.length ? ligandResults : undefined,
      alphafold: afSummary,
      mwAugment,
      interaction: interaction ?? undefined,
    }

    report('report', 'LLM 生成评估分析（第 1/3 段：摘要与背景）…', 0.15)
    const gen = await generateReportSections(reportCtx, signal)
    generated = gen
    for (let i = 0; i < gen.parts.length; i++) {
      const p = gen.parts[i]
      report('report', `LLM 第 ${['1', '2', '3'][i]}/3 段（${['摘要与背景', '结构研究全景', '可行性与策略'][i]}）${p.llmOk ? '完成' : '失败'}${p.llmOk ? `（${p.markdown.length} 字）` : `：${p.error}`}`, (i + 1) / 3)
      log(`LLM 报告段 ${p.key} ${p.llmOk ? `完成（${p.markdown.length} 字）` : `失败：${p.error}`}`, p.llmOk ? 'info' : 'warn')
    }
  }

  // HTML 渲染 + 落盘（deferred 模式不生成单靶点 HTML）
  let reportPath: string | null = null
  if (!deferReport) {
    report('report', '组装 HTML 报告…', 0.95)
    const engineSummary = await getEngineSummary()
    const html = await renderReportHtml({
      ctx: {
        uniprot: uniprotInfo,
        sequence,
        goal: goal || undefined,
        goalHints,
        insights: insights ?? undefined,
        batchNote: input.batchNote,
        providedSequence: providedSequence && comparison
          ? { sequence: providedSequence, comparison }
          : undefined,
        range: input.options.range,
        directPdbs,
        blastHits,
        blastStatus,
        coverage,
        coverageText,
        gapText,
        literature,
        images,
        scores,
        oligomer,
        ligands: ligandResults.length ? ligandResults : undefined,
        alphafold: afSummary,
        mwAugment,
        interaction: interaction ?? undefined,
      },
      methodStats: scores.methodStats,
      llmMarkdown: generated.fullMarkdown,
      llmOk: generated.ok,
      llmErrors: generated.errors,
      jobId: input.jobId,
      durationMs: Date.now() - t0,
      totalPdbFound,
      engineSummary,
      alphafoldFigure: afFigure,
      resolveImagePath: (meta) => {
        const ext = meta.mime.includes('png') ? 'png' : meta.mime.includes('gif') ? 'gif' : meta.mime.includes('webp') ? 'webp' : 'jpg'
        return path.join(assetDir, `${meta.id}.${ext}`)
      },
    })
    const reportDir = path.join(process.cwd(), 'db', 'reports', input.jobId)
    await fs.mkdir(reportDir, { recursive: true })
    reportPath = path.join(reportDir, 'report.html')
    await fs.writeFile(reportPath, html, 'utf-8')
  }

  // ─── 持久化 ──────────────────────────────────────────────────────────────
  const durationMs = Date.now() - t0
  const summary: JobSummary = {
    uniprot: {
      uniprotId: uniprotInfo?.uniprotId ?? '',
      entryName: uniprotInfo?.entryName ?? '',
      proteinName: uniprotInfo?.proteinName ?? '未知靶点（序列输入）',
      geneNames: uniprotInfo?.geneNames ?? [],
      organism: uniprotInfo?.organism ?? '',
      sequenceLength: uniprotInfo?.sequenceLength ?? sequence.length,
    },
    directPdbCount: directPdbs.length,
    blastHitCount: blastHits.length,
    coverage: coverage?.coveragePercent ?? 0,
    scores: {
      xray: scores.xray, cryoem: scores.cryoem, nmr: scores.nmr, overall: scores.overall,
      /** v1.25：聚集形式调整明细（评分卡展示；无分析时缺省） */
      oligomerAdjust: scores.oligomerAdjust,
      /** v1.26：分子量增重调整明细（评分卡展示；不适用时缺省） */
      mwAugmentAdjust: scores.mwAugmentAdjust,
      /** v1.29：互作复合物证据调整明细（无直接结构且有证据时） */
      interactionAdjust: scores.interactionAdjust,
    },
    methodStats: scores.methodStats,
    ligandCount: new Set(directPdbs.flatMap(p => p.ligands.map(l => l.split('(')[0].trim()))).size,
    literatureCount: literature.length,
    imageCount: images.length,
    durationMs,
    blast: blastStatus,
    coverageText: coverageText || undefined,
    gapText: gapText || undefined,
    oligomer,
    ligands: ligandResults.length ? ligandResults : undefined,
    alphafold: afSummary,
    /** v1.29：互作复合物证据分析（无直接结构时；无证据时 hasEvidence=false 亦存档） */
    interaction: interaction ?? undefined,
    /** v1.26：分子量增重策略分析（小分子量靶点；applicable=false 时亦存档） */
    mwAugment,
    reportLlmOk: deferReport ? undefined : generated.ok,
    reportDeferred: deferReport || undefined,
    batchNote: input.batchNote,
    construct: comparison
      ? {
          providedLength: comparison.providedLength,
          fullLength: comparison.fullLength,
          identity: comparison.identity,
          sameTarget: comparison.sameTarget,
          start: comparison.start,
          end: comparison.end,
        }
      : undefined,
  }

  // v2.4：终态持久化失败不视为评估失败（无状态部署磁盘/DB 可能不可写；
  // 同步评估模式下结果由调用方直接从内存/响应返回）
  try {
    await db.evaluationJob.update({
      where: { id: input.jobId },
      data: {
        status: 'done',
        title: summary.uniprot.proteinName,
        uniprotId: uniprotInfo?.uniprotId ?? null,
        summary: JSON.stringify(summary),
        pdbs: JSON.stringify(directPdbs),
        blastHits: JSON.stringify(blastHits),
        literature: JSON.stringify(literature),
        reportPath,
        reportMarkdown: !deferReport && generated.fullMarkdown?.trim() ? generated.fullMarkdown : null,
        error: null,
        updatedAt: new Date(),
      },
    })
  } catch { /* 无状态部署：DB 不可用不阻塞（同步路由从内存快照返回结果） */ }

  // v2.4：同步评估模式 — 直接把最终数据交给调用方（不依赖 DB 读回）
  cb.onComplete?.({
    summary,
    directPdbs,
    blastHits,
    literature,
    reportPath,
    reportMarkdown: !deferReport && generated.fullMarkdown?.trim() ? generated.fullMarkdown : null,
  })

  // 图片资产登记（供 /api/assets 访问）
  // v1.11 修复：同一上传的多靶点批次此前共用 meta.id 做 upsert — 后完成的作业把
  // 资产行「抢」到自己名下（update jobId），导致客户实验数据只出现在最后一个
  // UniProt 的结果页。现改为每个作业登记自己的行（复合 id，路径仍指向上传目录的
  // 同一文件），全部靶点页面共享完整实验数据。
  if (images.length) {
    for (let i = 0; i < images.length; i++) {
      const meta = images[i]
      const ext = meta.mime.includes('png') ? 'png' : meta.mime.includes('gif') ? 'gif' : meta.mime.includes('webp') ? 'webp' : 'jpg'
      const rowId = `${meta.id}__${input.jobId}`.slice(0, 64)
      await db.reportAsset.upsert({
        where: { id: rowId },
        create: { id: rowId, jobId: input.jobId, kind: meta.kind, caption: meta.caption, mime: meta.mime, size: meta.sizeKB * 1024, path: path.join(assetDir, `${meta.id}.${ext}`), order: i, vlm: meta.vlmKind ?? false },
        update: { order: i, vlm: meta.vlmKind ?? false },
      }).catch(() => undefined)
    }
  }

  log(`评估完成：总耗时 ${(durationMs / 1000).toFixed(1)}s${deferReport ? '（报告已并入合并评估报告）' : '，报告已生成'}`)
}
