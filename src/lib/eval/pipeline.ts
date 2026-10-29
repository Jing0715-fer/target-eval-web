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
import { submitBlastPdb, collectBlastPdbWithRescue, enrichBlastHits } from './blast'
import { searchRcsbHomologs, fetchUniprotForEntryEntity } from './rcsb-search'
import { buildLiteratureQuery, searchPubmed, fetchPubmedByPmids } from './pubmed'
import { computeScores } from './score'
import { generateReportSections, type ReportContext } from './report'
import { renderReportHtml } from './report-html'
import { compareSequences, describeComparison } from './seq-compare'
import { detectAntibody } from './antibody'
import { getEngineSummary } from './llm-provider'
import { filterPdbsByRange, filterBlastByRange } from './range-filter'
import { isValidUniprotId, type BlastGroup, type BlastHit, type BlastStatusInfo, type EvaluationOptions, type FormInsights, type InputMode, type JobSummary, type LiteratureItem, type ParsedImage, type PdbEntry, type PdbeCoverageResult, type SequenceComparison, type UniprotInfo } from './types'

export interface PipelineInput {
  jobId: string
  mode: InputMode
  uniprot?: string
  sequence?: string
  uploadId?: string
  goal?: string
  /** 批次关系说明（非关联批量时注入报告，LLM 在执行摘要中说明独立/复合物定位） */
  batchNote?: string
  /** ≥90% 高一致同源组（v1.11）：组内首个提交 BLAST 的作业为代表，其余跳过并共享结果 */
  homologBlast?: BlastGroup
  options: EvaluationOptions
}

export interface PipelineCallbacks {
  signal: AbortSignal
  report: (stageKey: string, message: string, subPercent?: number) => void
  log: (msg: string, level?: 'info' | 'warn' | 'error') => void
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
async function readUploadParsed(uploadId: string): Promise<{ goalHints: string[]; images?: ParsedImage[] } | null> {
  try {
    const raw = await fs.readFile(path.join(process.cwd(), 'db', 'reports', uploadId, 'parsed.json'), 'utf-8')
    return JSON.parse(raw) as { goalHints: string[]; images?: ParsedImage[] }
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
  let comparison: SequenceComparison | null = null

  if (input.uploadId) {
    const parsed = await readUploadParsed(input.uploadId)
    if (parsed) {
      if (parsed.goalHints?.length) goalHints = parsed.goalHints
      images = parsed.images ?? []
    } else {
      log('评估表解析数据缺失（上传目录可能已过期清理），胶图/SEC 图片与目标提示不可用，建议重新上传评估表', 'warn')
    }
    insights = await readUploadInsights(input.uploadId)
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

  // ─── 阶段 7：评分 ────────────────────────────────────────────────────────
  report('score', '计算可行性评分…', 0.5)
  const scores = computeScores({
    sequenceLength: uniprotInfo?.sequenceLength ?? sequence.length,
    features: uniprotInfo?.features ?? [],
    directPdbs,
    blastHits,
    coveragePercent: coverage?.coveragePercent ?? 0,
  })
  log(`评分完成：X-ray ${scores.xray.score}/10 · Cryo-EM ${scores.cryoem.score}/10 · NMR ${scores.nmr.score}/10 · 总体 ${scores.overall.score}/10`)
  report('score', '评分完成', 1)

  // ─── 阶段 8：LLM 报告 ────────────────────────────────────────────────────
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
      },
      methodStats: scores.methodStats,
      llmMarkdown: generated.fullMarkdown,
      llmOk: generated.ok,
      llmErrors: generated.errors,
      jobId: input.jobId,
      durationMs: Date.now() - t0,
      totalPdbFound,
      engineSummary,
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
    },
    methodStats: scores.methodStats,
    ligandCount: new Set(directPdbs.flatMap(p => p.ligands.map(l => l.split('(')[0].trim()))).size,
    literatureCount: literature.length,
    imageCount: images.length,
    durationMs,
    blast: blastStatus,
    coverageText: coverageText || undefined,
    gapText: gapText || undefined,
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
