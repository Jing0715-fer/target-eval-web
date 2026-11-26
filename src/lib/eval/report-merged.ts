/**
 * 合并评估报告（v1.8 关联靶点批量）：
 *  - 关系判断为 related 的批次：各靶点作业以 deferred 模式完成数据收集后，
 *    由本模块加载全部作业数据，LLM 生成一份合并报告
 *  - 核心新增章节「靶点关系分析」：关系类型/证据/生物学意义/对结构解析策略的影响
 *    （复合物共表达、抗体-抗原复合物组装、融合构建边界等）
 *  - 三段式生成（摘要+关系 / 各靶点综述 / 整合策略），确定性数据由模板直出
 *  - v2.10 ②：段D「客户评估表问题回应」— 对评估表目标/待解决科学问题逐条回应，
 *    渲染时内嵌到「客户评估表要点」章节对应条目下方（此前只列问题不回答）
 *  - v2.11 格式对齐单独评估（报告阅读体验）：①新增「批次核心结论速览」glance
 *    （与单靶点报告同款 At a Glance 版式）；②共有结构提前至合并分析之后直出，
 *    绿色突出面板重制（空态常驻 — 批次有无共同结构同样关键）；③各靶点 PDB/
 *    同源/文献明细默认折叠（共有 PDB 带 ◈ 徽标互证，打印自动展开）；④章节
 *    CSS 与单靶点报告统一（h2 双线底、版心配色）
 *  - v2.12 报告结构分层（复合物/单独评估分离）：①「各靶点结构可行性综述」从
 *    合并分析章节拆出，按靶点归入其单独报告页（综述 + 基本信息 + 预测结构 +
 *    该靶点 PDB/同源/文献同页聚合 — 单独评估与单独结构放在一起）；②每个靶点
 *    一个独立视图页：刊头靶点卡片/目录靶点速览点击进入，「返回报告首页」随时
 *    回到复合物评估（hash 深链 #view-…，打印时全部视图依序输出、靶点页另起一页）；
 *    ③首页（复合物评估）文献列表只列共有结构文献（PMID 去重 + 关联 PDB）；
 *    ④序列一致性矩阵改为居中对齐 + 行标正文化（修复表头与内容错位观感）
 *  - v2.13 批量报告完全对齐单独评估：①首页（复合物评估）标题/字体/版式同步单靶点
 *    报告（SINGLE_REPORT_CSS 同源同版 — meta-grid 刊头 / JetBrains Mono / 章节
 *    样式）；②每靶点单独评估页退役「简报卡」，直接渲染完整单靶点报告主体
 *    （renderSingleReportBody：header + glance + 目录 + 评估分析 + 可行性评分 +
 *    PDB 结构清单 + 配体 + 同源 + 文献 + 客户实验数据 — 格式与单靶点评估一模一样）；
 *    ③PDB 结构与文献全量展开（不再默认折叠）；④批次各靶点不再因复合物组分跳过
 *    单独评估 — pipeline 按单靶点流程生成完整独立报告并持久化（旧批次回退综述）
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { db } from '@/lib/db'
import { llmChat } from './llm'
import { elideSequenceRuns } from './seq-elide'
import { esc, renderMarkdown, strategyZh, ligDetailProps, ligStructFig, ligIdentFold, RESPONSIVE_PAGE_CSS, LIGHTBOX_CSS, LIGHTBOX_JS, TABLE_FILTER_JS, ALIGN_TIP_JS, ALIGN_LAYOUT_JS, PRINT_PAGE_CSS, UX_PAGE_CSS, UX_PAGE_JS, SINGLE_REPORT_CSS, renderSingleReportBody, type SingleBodyCtx } from './report-html'
import { describeRelationType, describeBlastStatus, type AfDomainRange, type AlphafoldSummaryInfo, type EsmfoldSummaryInfo, type BlastHit, type BlastNrHit, type BlastStatusInfo, type ConstructInfo, type FormInsights, type HomologPair, type IdentityAlignment, type LiteratureItem, type MethodStats, type MwAugmentAnalysis, type OligomerAnalysis, type ParsedImage, type PdbEntry, type PdbeCoverageResult, type InteractionAnalysis, type RelationJudgment, type Scores, type SequenceAttribution, type SequenceComparison, type SharedStructure, type TargetIdentityInfo, type UniprotProcessingChain } from './types'
import { describeEvidenceSource, describeOligoConfidence } from './oligomer'
import { ensureLigand2dVector, type LigandResolution } from './ligand'
import { computeSharedStructures } from './shared-structures'
import { augmentTargetsForSharedPdbCoverage } from './rcsb'
import { synthesizeScoreRationale } from './score'
import { alphafoldStructureFor, alphafoldMetaFor, ensure3DmolBundle, plddtStyleApplyJs, afToolbarJs } from './alphafold'
import { loadCachedEsmfoldModel } from './esmfold'
import { splitQaChapter, parseInsightQa, QA_CHAPTER_TITLE } from './qa-chapter'
import { alignmentForLegacyJob } from './report-upgrade'

// ─── 数据结构 ─────────────────────────────────────────────────────────────────

/** 单个靶点的合并报告数据（从 EvaluationJob 加载） */
export interface MergedTargetData {
  jobId: string
  label: string
  uniprotId?: string
  proteinName: string
  /** v2.31：PTM/Processing 加工条目（聚合蛋白 nsp 归属 — 各靶点单独评估页题目/刊头用；历史作业缺省） */
  processingChains?: UniprotProcessingChain[]
  /** v2.31：评估区间归属的 nsp 标注（如 "nsp12"；展示名追加 — 同名截短靶点可区分；历史作业缺省） */
  nspLabel?: string
  geneNames: string[]
  organism: string
  sequenceLength: number
  scores: Scores & { rationale: { xray: string; cryoem: string; nmr: string; overall: string } }
  methodStats: MethodStats
  directPdbs: PdbEntry[]
  blastHits: BlastHit[]
  blastStatus?: BlastStatusInfo
  coveragePercent: number
  /** 覆盖区间描述（v1.11 起新作业入库；历史作业缺省） */
  coverageText?: string
  /** 未覆盖区间描述（同上） */
  gapText?: string
  literature: LiteratureItem[]
  literatureCount: number
  ligandCount: number
  construct?: ConstructInfo
  durationMs: number
  /** v2.29：实际生效评估区间（作业 summary.range — 手动/比对/域名匹配；历史作业缺省） */
  range?: [number, number]
  /** v2.29：区间来源标签；历史作业缺省 */
  rangeSource?: string
  /** v2.29：与区间无重叠的直接结构（折叠保留展示 — 灰色行；上限 200） */
  rangeOutsidePdbs?: PdbEntry[]
  /** v2.29：与区间无重叠的 BLAST 同源命中（折叠保留展示；上限 100） */
  rangeOutsideBlastHits?: BlastHit[]
  /** v2.59：BLAST nr 全库检索命中（nr 级联实际执行且有命中时存档，≤20 条；
   *  单独评估页报告主体展示前 5 条 + 折叠；nr 未执行/历史作业缺省） */
  blastNrHits?: BlastNrHit[]
  /** v2.95：nr 命中实际检索通道：'ebi' = EBI UniProtKB 全库兜底（NCBI nr 失败后
   *  的替补 — 前端表头/单独评估页如实标注；历史作业缺省 = NCBI） */
  blastNrProvider?: 'ncbi' | 'ebi'
  /** v2.82：EBI UniProt 库（Swiss-Prot）序列匹配命中（身份级联 v2.44 通道实际
   *  执行且有命中时存档，≤20 条；单独评估页/前端展示；历史作业缺省） */
  uniprotBlastHits?: BlastNrHit[]
  /** v2.96：身份识别序列比对（非 100% 一致性归属 — 单独评估页「序列比对」
   *  面板；历史作业缺省） */
  identityAlignment?: IdentityAlignment
  /** v1.24：聚集形式（寡聚态）分析（v1.24+ 作业存在；历史作业缺省） */
  oligomer?: OligomerAnalysis
  ligands?: LigandResolution[]
  /** v1.26：分子量增重策略分析（v1.26+ 作业存在；历史作业缺省） */
  mwAugment?: MwAugmentAnalysis | null
  /** v2.9：AlphaFold 预测结构信息（v2.0+ 作业存于摘要；旧作业在渲染时按需补齐） */
  alphafold?: AlphafoldSummaryInfo
  /** v2.15：ESMFold 公共 API 兜底预测信息（AFDB 无收录/纯序列输入靶点；
   *  模型文本按 cacheKey 从 db/cache/esmfold 直读入公共 MODELS 池） */
  esmfold?: EsmfoldSummaryInfo | null
  /** v2.13：该靶点独立 LLM 报告全文（批次评估时按单靶点流程生成并持久化；
   *  旧批次作业无此字段 — 单独评估页回退合并报告的各靶点综述） */
  reportMarkdown?: string | null
  /** v2.13：结构覆盖率完整结果（含覆盖区间 — 单独评估页覆盖率区段图用；旧作业缺省） */
  coverage?: PdbeCoverageResult | null
  /** v2.13：互作复合物证据分析（无直接结构靶点的单独评估页互作结构清单用） */
  interaction?: InteractionAnalysis | null
  /** UniProt 条目名（单独评估页 meta-grid 展示） */
  entryName?: string
  /** v2.16：序列靶点身份识别（无 UniProt 归属靶点的命名证据链 — 单独评估页题目/刊头消费） */
  targetIdentity?: TargetIdentityInfo | null
  /** v2.45：序列靶点原始提交标签头（报告导入精确匹配 — meta 标记携带；历史作业缺省） */
  sequenceHeader?: string
  /** v2.45：提交序列 SHA-256 前 16 hex（报告导入 SHA 精确匹配；历史作业缺省） */
  seqSha?: string
  /** v2.46：UniProt DOMAIN 结构域区间（各靶点单独评估页预测结构视图「按域着色」用；
   *  仅 AFDB 引擎靶点有值；历史作业/无 DOMAIN 注释缺省 → 选项禁用） */
  afDomains?: AfDomainRange[]
}

/** 前端展示用的轻量靶点数据（合并报告响应携带 — PDB/BLAST/文献列表带 UniProt 归属）
 *  v2.9：补齐各靶点单独简报所需字段（scores/methodStats/alphafold/construct/覆盖区间） */
export interface MergedTargetLite {
  jobId: string
  uniprotId?: string
  proteinName: string
  /** v2.31：评估区间归属的 nsp 标注（聚合蛋白截短 — 前端展示名追加；历史报告缺省） */
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
  /** v1.24：聚集形式（寡聚态）分析 */
  oligomer?: OligomerAnalysis
  ligands?: LigandResolution[]
  /** v1.26：分子量增重策略分析（仅 applicable 时携带） */
  mwAugment?: MwAugmentAnalysis | null
  /** v2.9：各靶点单独简报 — 评分/方法统计/配体与文献计数/覆盖区间/构建信息 */
  scores?: Scores
  methodStats?: MethodStats
  ligandCount?: number
  literatureCount?: number
  coverageText?: string
  gapText?: string
  construct?: ConstructInfo
  /** v2.29：评估区间 + 来源标签 + 范围外结构（前端 PdbTable/BlastTable 折叠区用；历史报告缺省） */
  range?: [number, number]
  rangeSource?: string
  rangeOutsidePdbs?: PdbEntry[]
  rangeOutsideBlastHits?: BlastHit[]
  /** v2.59：BLAST nr 全库检索命中（前端 BlastNrTable 展示；历史报告缺省） */
  blastNrHits?: BlastNrHit[]
  /** v2.95：nr 命中实际检索通道（ebi = EBI UniProtKB 全库兜底 — 表头标注；历史缺省 = NCBI） */
  blastNrProvider?: 'ncbi' | 'ebi'
  /** v2.82：EBI UniProt 库序列匹配命中（前端/单独评估页展示；历史报告缺省） */
  uniprotBlastHits?: BlastNrHit[]
  /** v2.96：身份识别序列比对（非 100% 一致性归属的证据可视化 — 单独评估页
   *  「序列比对」面板；历史作业缺省） */
  identityAlignment?: IdentityAlignment
  /** v2.9：AlphaFold 预测结构元数据（前端简报卡展示；交互 3D 视图见 HTML 报告） */
  alphafold?: AlphafoldSummaryInfo
  /** v2.15：ESMFold 兜底预测元数据（AFDB 无收录时前端简报卡展示） */
  esmfold?: EsmfoldSummaryInfo | null
  /** v2.16：序列靶点身份识别（无 UniProt 归属靶点的命名证据链 — 分组头/简报卡展示） */
  targetIdentity?: TargetIdentityInfo | null
}

/** 轻量化：网页合并视图（v1.24 起全部携带 — PDB/BLAST/文献不再截断，全部展示） */
export function toMergedTargetLite(t: MergedTargetData): MergedTargetLite {
  return {
    jobId: t.jobId,
    uniprotId: t.uniprotId,
    proteinName: t.proteinName,
    // v2.31：nsp 标注（聚合蛋白截短靶点区分）
    nspLabel: t.nspLabel,
    geneNames: t.geneNames,
    organism: t.organism,
    sequenceLength: t.sequenceLength,
    coveragePercent: t.coveragePercent,
    directPdbCount: t.directPdbs.length,
    blastHitCount: t.blastHits.length,
    blastStatus: t.blastStatus,
    directPdbs: t.directPdbs,
    blastHits: t.blastHits,
    literature: t.literature,
    oligomer: t.oligomer,
    mwAugment: t.mwAugment ?? null,
    scores: t.scores,
    methodStats: t.methodStats,
    ligandCount: t.ligandCount,
    literatureCount: t.literatureCount,
    coverageText: t.coverageText,
    gapText: t.gapText,
    construct: t.construct,
    // v2.29：评估区间 + 范围外结构（前端 PdbTable/BlastTable 折叠区用）
    range: t.range,
    rangeSource: t.rangeSource,
    rangeOutsidePdbs: t.rangeOutsidePdbs,
    rangeOutsideBlastHits: t.rangeOutsideBlastHits,
    // v2.59：nr 全库检索命中（前端 BlastNrTable 展示）
    blastNrHits: t.blastNrHits,
    // v2.95：nr 命中实际检索通道（ebi = EBI UniProtKB 全库兜底 — 表头标注）
    blastNrProvider: t.blastNrProvider,
    // v2.82：UniProt 库序列匹配命中（前端/单独评估页展示）
    uniprotBlastHits: t.uniprotBlastHits,
    // v2.96：身份识别序列比对（单独评估页「序列比对」面板）
    identityAlignment: t.identityAlignment,
    alphafold: t.alphafold,
    esmfold: t.esmfold ?? null,
    // v2.16：靶点身份（前端展示与单独评估页题目用）
    targetIdentity: t.targetIdentity ?? null,
  }
}

/** 从 DB 加载一批已完成作业为合并报告数据（不校验归属，调用方负责） */
export async function loadMergedTargets(jobIds: string[]): Promise<MergedTargetData[]> {
  const targets: MergedTargetData[] = []
  for (const id of jobIds) {
    const job = await db.evaluationJob.findUnique({ where: { id } })
    if (!job || job.status !== 'done') continue
    let summary: {
      uniprot?: { uniprotId: string; entryName?: string; proteinName: string; geneNames: string[]; organism: string; sequenceLength: number; processingChains?: UniprotProcessingChain[]; nspLabel?: string }
      scores?: Scores & { rationale: { xray: string; cryoem: string; nmr: string; overall: string } }
      methodStats?: MethodStats; coverage?: number; ligandCount?: number; literatureCount?: number
      blast?: BlastStatusInfo; construct?: ConstructInfo; durationMs?: number; coverageText?: string; gapText?: string
      oligomer?: OligomerAnalysis
      ligands?: LigandResolution[]
      mwAugment?: MwAugmentAnalysis | null
      alphafold?: AlphafoldSummaryInfo
      esmfold?: EsmfoldSummaryInfo
      interaction?: InteractionAnalysis | null
      coveredRanges?: Array<[number, number]>
      targetIdentity?: TargetIdentityInfo
      /** v2.29：评估区间/来源/范围外结构（新作业存在；历史作业缺省） */
      range?: [number, number]
      rangeSource?: string
      rangeOutsidePdbs?: PdbEntry[]
      rangeOutsideBlastHits?: BlastHit[]
      /** v2.59：BLAST nr 全库检索命中（单独评估页/前端展示；历史作业缺省） */
      blastNrHits?: BlastNrHit[]
      /** v2.95：nr 命中实际检索通道（ebi = EBI UniProtKB 全库兜底；历史作业缺省 = NCBI） */
      blastNrProvider?: 'ncbi' | 'ebi'
      /** v2.82：EBI UniProt 库序列匹配命中（单独评估页/前端展示；历史作业缺省） */
      uniprotBlastHits?: BlastNrHit[]
      /** v2.96：身份识别序列比对（单独评估页「序列比对」面板；历史作业缺省） */
      identityAlignment?: IdentityAlignment
      /** v2.45：序列靶点原始标签头 + 提交序列 SHA-256 前 16 hex（报告导入匹配用） */
      sequenceHeader?: string
      seqSha?: string
      /** v2.46：UniProt DOMAIN 结构域区间（预测结构视图「按域着色」用） */
      afDomains?: AfDomainRange[]
    } | null = null
    let pdbs: PdbEntry[] = []
    let blastHits: BlastHit[] = []
    let literature: LiteratureItem[] = []
    try { summary = job.summary ? JSON.parse(job.summary) : null } catch { /* ignore */ }
    try { pdbs = job.pdbs ? JSON.parse(job.pdbs) : [] } catch { /* ignore */ }
    try { blastHits = job.blastHits ? JSON.parse(job.blastHits) : [] } catch { /* ignore */ }
    try { literature = job.literature ? JSON.parse(job.literature) : [] } catch { /* ignore */ }
    if (!summary?.scores) continue
    // v2.99：旧作业（v2.96 前 summary 无 identityAlignment）比对面板回填 —
    //  从作业 llm-ctx 快照按管线同口径现算（纯本地比对）；新作业有值零开销，
    //  快照缺失/规则不满足 → undefined（单独评估页无面板，与原行为一致）
    const identityAlignment = summary.identityAlignment ?? (await alignmentForLegacyJob(job.id)) ?? undefined
    // v2.13：历史作业（v2.9 前摘要未持久化 rationale）评分依据合成 — 各靶点单独
    // 评估页评分卡需要；从留存的确定性数据重建，不虚构缺失信号
    const legacyScores = summary.scores as Scores & { rationale?: { xray: string; cryoem: string; nmr: string; overall: string } }
    const scoresNorm: Scores & { rationale: { xray: string; cryoem: string; nmr: string; overall: string } } = {
      ...legacyScores,
      rationale: legacyScores.rationale ?? synthesizeScoreRationale({
        sequenceLength: summary.uniprot?.sequenceLength ?? 0,
        methodStats: summary.methodStats ?? { xrayCount: 0, cryoemCount: 0, nmrCount: 0, bestResolution: null },
        directPdbCount: pdbs.length,
        coveragePercent: summary.coverage ?? 0,
        bestIdentity: blastHits.length ? Math.max(...blastHits.map(h => h.identity)) : null,
        scores: legacyScores,
      }),
    }
    targets.push({
      jobId: job.id,
      label: job.uniprotId ?? summary.uniprot?.proteinName ?? '未知靶点',
      uniprotId: job.uniprotId ?? undefined,
      proteinName: summary.uniprot?.proteinName || job.uniprotId || '未知靶点',
      // v2.31：聚合蛋白加工归属（nsp 标注 — 题目/卡片/矩阵区分同名截短靶点）
      processingChains: summary.uniprot?.processingChains,
      nspLabel: summary.uniprot?.nspLabel,
      geneNames: summary.uniprot?.geneNames ?? [],
      organism: summary.uniprot?.organism ?? '',
      sequenceLength: summary.uniprot?.sequenceLength ?? 0,
      scores: scoresNorm,
      methodStats: summary.methodStats ?? { xrayCount: 0, cryoemCount: 0, nmrCount: 0, bestResolution: null },
      directPdbs: pdbs,
      blastHits,
      blastStatus: summary.blast,
      coveragePercent: summary.coverage ?? 0,
      coverageText: summary.coverageText,
      gapText: summary.gapText,
      literature,
      literatureCount: summary.literatureCount ?? literature.length,
      ligandCount: summary.ligandCount ?? 0,
      construct: summary.construct,
      durationMs: summary.durationMs ?? 0,
      // v2.29：评估区间 + 范围外结构（单独评估页报告主体 — 重叠优先/折叠保留口径）
      range: summary.range,
      rangeSource: summary.rangeSource,
      rangeOutsidePdbs: summary.rangeOutsidePdbs,
      rangeOutsideBlastHits: summary.rangeOutsideBlastHits,
      // v2.59：nr 全库检索命中（单独评估页报告主体 BLAST 章节展示）
      blastNrHits: summary.blastNrHits,
      // v2.95：nr 命中实际检索通道（ebi = EBI UniProtKB 全库兜底）
      blastNrProvider: summary.blastNrProvider,
      // v2.82：UniProt 库序列匹配命中（单独评估页报告主体 BLAST 章节展示）
      uniprotBlastHits: summary.uniprotBlastHits,
      // v2.96：身份识别序列比对（单独评估页报告主体 BLAST 章节「序列比对」面板；
      //  v2.99 旧作业经快照回填，见上方 identityAlignment）
      identityAlignment,
      oligomer: summary.oligomer,
      ligands: summary.ligands,
      mwAugment: summary.mwAugment ?? null,
      alphafold: summary.alphafold,
      // v2.15：ESMFold 兜底预测（AFDB 无收录/纯序列输入靶点）
      esmfold: summary.esmfold ?? null,
      // v2.13：单独评估页所需 — 独立 LLM 报告 / 覆盖区间 / 互作证据 / 条目名
      reportMarkdown: job.reportMarkdown,
      coverage: summary.coveredRanges
        ? { coveragePercent: summary.coverage ?? 0, coveredRanges: summary.coveredRanges, mappings: [] }
        : null,
      interaction: summary.interaction ?? null,
      entryName: summary.uniprot?.entryName,
      // v2.16：序列靶点身份识别链（题目/刊头不再「未知靶点」）
      targetIdentity: summary.targetIdentity ?? null,
      // v2.45：序列靶点导入匹配证据（原始标签头 + 序列 SHA — meta 标记携带）
      sequenceHeader: summary.sequenceHeader,
      seqSha: summary.seqSha,
      // v2.46：UniProt DOMAIN 区间（单独评估页预测结构「按域着色」）
      afDomains: summary.afDomains,
    })
  }
  return targets
}

// ─── LLM 三段式生成 ───────────────────────────────────────────────────────────

// ─── v2.26 GPCR 受体主导复合物识别（确定性规则 — 基因名/蛋白名，不经 LLM）──────────
// GPCR 类项目以受体为主：下游 G 蛋白是信号转导组分，非独立结构解析对象。识别
// 「恰 1 个非 G 蛋白靶点 + ≥1 个 G 蛋白组分」的复合物批次 → 合并报告首页切换为
// 受体完整单独评估页（用户需求：主页只显示受体的评估页面），G 蛋白降级为伴侣
// （chips 卡片进单独页），并新增「受体 × 该 G 蛋白类型复合物结构存在性」标注与分析。

/** 人源异三聚体 G 蛋白组分基因（Gα 全家族 + Gβ1-5 + Gγ1-12） */
const G_PROTEIN_GENE_RE = /^(GNAS|GNAL|GNAI[1-3]?|GNAO|GNAT[1-3]?|GNAQ|GNA11|GNA12|GNA13|GNAZ|GNA15|GNB[1-5]|GNG[1-9]|GNG1[0-2])$/i

/** 该靶点是否为 G 蛋白异三聚体组分（基因名精确匹配或蛋白名特征词） */
export function isGProteinComponent(t: { geneNames?: string[]; proteinName?: string }): boolean {
  const genes = (t.geneNames ?? []).map(g => g.trim()).filter(Boolean)
  if (genes.some(g => G_PROTEIN_GENE_RE.test(g))) return true
  const name = (t.proteinName ?? '').toLowerCase()
  return name.includes('guanine nucleotide-binding protein')
    || (/\bg protein\b/.test(name) && /subunit|alpha|beta|gamma/.test(name))
}

/** G 蛋白基因 → 展示名（GNAI1 → Gαi1；GNB1 → Gβ1；GNG2 → Gγ2） */
function gGeneDisplay(gene: string): string {
  const g = gene.trim().toUpperCase()
  if (g.startsWith('GNA')) return `Gα${g.slice(3).replace(/^/, '').toLowerCase()}`
  if (g.startsWith('GNB')) return `Gβ${g.slice(3)}`
  if (g.startsWith('GNG')) return `Gγ${g.slice(3)}`
  return g
}

/** G 蛋白组分集合 → 偶联类型标签（按 Gα 家族归类；无 Gα 时标注 Gβ/Gγ 亚基） */
function gCouplingLabel(gproteins: Array<{ geneNames?: string[] }>): string {
  const genes = gproteins.flatMap(t => (t.geneNames ?? []).map(g => g.trim().toUpperCase()).filter(g => G_PROTEIN_GENE_RE.test(g)))
  if (!genes.length) return 'G 蛋白伴侣'
  const types = new Set<string>()
  const parts: string[] = []
  for (const g of genes) {
    if (/^GNAS$|^GNAL$/.test(g)) types.add('Gs')
    else if (/^GNAI[1-3]?$|^GNAO$|^GNAZ$|^GNAT[1-3]?$/.test(g)) types.add('Gi/o')
    else if (/^GNAQ$|^GNA11$/.test(g)) types.add('Gq/11')
    else if (/^GNA12$|^GNA13$/.test(g)) types.add('G12/13')
    parts.push(gGeneDisplay(g))
  }
  const typeStr = types.size ? [...types].join('/') : 'Gβγ'
  return `${typeStr} 型（${parts.slice(0, 4).join(' · ')}${parts.length > 4 ? ' …' : ''}）`
}

export interface ReceptorGproteinBatch {
  /** 受体（本报告的主要评估对象 — GPCR 类项目的主体） */
  receptor: MergedTargetData
  /** G 蛋白伴侣（信号转导组分 — 复合物组装证据，非独立结构解析对象） */
  gproteins: MergedTargetData[]
  /** 偶联类型标签（如「Gi 型（Gαi1 · Gβ1）」） */
  couplingLabel: string
}

/** 识别「受体主导型复合物」批次：恰 1 个非 G 蛋白靶点 + ≥1 个 G 蛋白组分。
 *  不硬判 GPCR 家族（避免误判）— 结构性判定对受体–信号转导伴侣组合同样适用；
 *  G 蛋白组分本身判定是确定性的（GNA、GNB、GNG 前缀基因名精确匹配）。 */
export function detectReceptorGproteinBatch(targets: MergedTargetData[]): ReceptorGproteinBatch | null {
  if (targets.length < 2) return null
  const gproteins = targets.filter(t => isGProteinComponent(t))
  const others = targets.filter(t => !isGProteinComponent(t))
  if (gproteins.length < 1 || others.length !== 1) return null
  return { receptor: others[0], gproteins, couplingLabel: gCouplingLabel(gproteins) }
}

/** 受体 × G 蛋白复合物结构（共有结构中同时覆盖受体与任一 G 蛋白组分的条目） */
export function receptorGproteinStructures(
  shared: SharedStructure[],
  batch: ReceptorGproteinBatch,
): SharedStructure[] {
  const gAccs = new Set(batch.gproteins.map(g => g.uniprotId).filter(Boolean))
  const rAcc = batch.receptor.uniprotId
  if (!rAcc) return []
  return shared.filter(s =>
    s.coverage.some(c => c.uniprotId === rAcc) && s.coverage.some(c => gAccs.has(c.uniprotId)),
  )
}

const SYSTEM = `你是一位资深结构生物学专家（CRO 结构解析项目负责人视角），为客户撰写多靶点合并评估报告。写作要求：
- 全文使用简体中文（专业术语可保留英文），正式书面语，不使用表情符号
- 结论先行：每章开头直接给结论，再展开论据
- 严格基于给定的数据上下文，禁止编造不存在的 PDB ID、PMID、分辨率或文献
- 数据里没有的信息，用"（本次数据未覆盖）"或"暂无可靠数据"明确说明
- 输出为 Markdown 子集：# 标题（仅首行使用一次，作为整份报告的描述性标题）/ ## / ### 标题、**加粗**、- 列表、|表格|、> 引用，不使用图片链接和代码块
- 数字引用必须与数据上下文一致`

function targetDigest(t: MergedTargetData): string {
  const lines: string[] = []
  // v2.31：展示名追加 nsp 标注（聚合蛋白截短 — 同名靶点可区分）
  const dispName = t.nspLabel ? `${t.proteinName} ${t.nspLabel}` : t.proteinName
  lines.push(`### ${t.label}${dispName && dispName !== t.label ? `（${dispName}）` : ''}`)
  // v2.16：序列靶点身份证据（无 UniProt 归属时 — LLM 用识别名称呼靶点并注明推断性质）
  if (!t.uniprotId && t.targetIdentity) {
    const ti = t.targetIdentity
    lines.push(`靶点身份（${ti.sourceLabel}${ti.identity != null ? ` · 一致性 ${Math.round(ti.identity)}%` : ''}${ti.uniprotId ? ` · 最近条目 ${ti.uniprotId}` : ''}）: ${ti.name}${ti.note ? `（${ti.note.slice(0, 90)}）` : ''} — 用该名称称呼靶点并标注「序列靶点」；推断身份须注明依据，不得当作已确认 UniProt 条目`)
  }
  if (t.geneNames.length) lines.push(`基因: ${t.geneNames.slice(0, 5).join(', ')} · 物种: ${t.organism || '—'} · 长度: ${t.sequenceLength} aa`)
  lines.push(`评分: X-ray ${t.scores.xray.score}/10 · Cryo-EM ${t.scores.cryoem.score}/10 · NMR ${t.scores.nmr.score}/10 · 总体 ${t.scores.overall.score}/10（${t.scores.overall.rating}）`)
  // v2.18：AI 复核（LLM 智能调分）— 各靶点小节的必写维度
  const llmA = t.scores.llmAdjust
  if (llmA) {
    const fmt = (v: number) => (v > 0 ? `+${v}` : v < 0 ? `${v}` : '±0')
    lines.push(`AI 复核: ${llmA.applied ? '已微调系统评分' : '确认维持系统评分'}（X-ray ${fmt(llmA.xray)} / Cryo-EM ${fmt(llmA.cryoem)} / NMR ${fmt(llmA.nmr)}；置信度${llmA.confidence === 'high' ? '高' : llmA.confidence === 'medium' ? '中' : '低'}）— ${llmA.notes.overall || '三方法复核意见综合'}；逐方法意见：X-ray ${llmA.notes.xray || '维持'}；Cryo-EM ${llmA.notes.cryoem || '维持'}；NMR ${llmA.notes.nmr || '维持'}（调整已计入上述分值，报告一律使用调整后分值）`)
  }
  const ms = t.methodStats
  lines.push(`PDB 结构: ${t.directPdbs.length} 个（X-ray ${ms.xrayCount} / Cryo-EM ${ms.cryoemCount} / NMR ${ms.nmrCount}）${ms.bestResolution != null ? `，最佳 ${ms.bestResolution}Å` : ''} · 覆盖率 ${t.coveragePercent}%${t.coverageText ? `（已覆盖: ${t.coverageText.slice(0, 160)}）` : ''}${t.gapText ? ` · 未覆盖区间: ${t.gapText.slice(0, 160)}` : ''} · 配体 ${t.ligandCount} 种 · 文献 ${t.literatureCount} 篇`)
  // v2.14：方法先例分布 — Cryo-EM 占主导时显性提示（小靶点的已有 EM 结构必然为复合物/增重形式，
  // 推荐方法不得仅因单体分子量小而排除 Cryo-EM）
  if (t.directPdbs.length > 0 && ms.cryoemCount > 0 && ms.cryoemCount >= ms.xrayCount + ms.nmrCount) {
    lines.push(`方法先例: ${ms.cryoemCount}/${t.directPdbs.length} 个已有结构为 Cryo-EM${ms.cryoemCount === t.directPdbs.length ? '（全部）' : ''} — 该靶点以复合物/装配形式被 Cryo-EM 解析已有直接先例，方法推荐应以此为主要依据（不得仅因单体分子量小而将 Cryo-EM 排除或降为末选）`)
  }
  // v2.0：配体归一数据（批次内共享 — 输入相同，结果一致）
  if (t.ligands?.length) {
    const okLig = t.ligands.filter(l => l.ok)
    if (okLig.length) {
      lines.push(`配体: ${okLig.map(l => `${l.raw} → ${l.compId}（含该配体结构 ${l.totalStructures} 个${l.structures.some(s => s.alsoTarget) ? `，${l.structures.filter(s => s.alsoTarget).map(s => s.pdbId).slice(0, 4).join('、')} 为本靶点直接结构` : ''}`).join('；').slice(0, 320)}`)
    }
    for (const l of t.ligands.filter(x => !x.ok)) lines.push(`配体未识别: ${l.raw}（${l.error ?? '未知原因'}）`)
  }
  if (t.construct) {
    lines.push(`客户构建: ${t.construct.providedLength} aa（与全长一致性 ${t.construct.identity}%${t.construct.start != null && t.construct.end != null ? `，估计区间 ${t.construct.start}-${t.construct.end}` : ''}）`)
  }
  // v1.24：聚集形式（寡聚态）— 各靶点小节的必写维度（v1.25：含评分调整值）
  if (t.oligomer) {
    lines.push(`聚集形式: ${t.oligomer.label || t.oligomer.summary}｜化学计量: ${t.oligomer.stoichiometry || '未知'}｜置信度: ${describeOligoConfidence(t.oligomer.confidence)}`)
    const adj = t.scores.oligomerAdjust
    if (adj) lines.push(`评分调整（已计入三方法分数）: X-ray ${adj.xray > 0 ? '+' : ''}${adj.xray} / Cryo-EM ${adj.cryoem > 0 ? '+' : ''}${adj.cryoem} / NMR ${adj.nmr > 0 ? '+' : ''}${adj.nmr} — ${adj.note}`)
    if (t.oligomer.evidence.length) {
      lines.push(`寡聚态证据: ${t.oligomer.evidence.map(e => `[${describeEvidenceSource(e.source)}] ${e.ref}`).join('；')}`)
    }
    if (t.oligomer.notes.length) lines.push(`寡聚态影响要点: ${t.oligomer.notes.join('；')}`)
  }
  // v1.26/v1.27：分子量增重策略（小分子量靶点）— 融入各靶点小节（不另立小节）
  if (t.mwAugment?.applicable) {
    const mw = t.mwAugment
    const mwAdj = t.scores.mwAugmentAdjust
    const pathZh = mw.assemblyPath === 'complex' ? '已有复合物结构' : mw.assemblyPath === 'oligomer' ? '自身寡聚' : mw.assemblyPath === 'homolog-complex' ? '同源复合物推断（BLAST，需实验验证）' : mw.assemblyPath === 'partner' ? (mw.assemblyEvidence === 'complex' ? '互作伙伴推断（复合物结构支持）' : mw.assemblyEvidence === 'homolog' ? '互作伙伴推断（同源复合物结构支持）' : '互作伙伴推断（无结构支持，低可信）') : '互作伙伴推断'
    lines.push(`分子量: 单体 ~${mw.monomerKda} kDa${mw.assemblyKda != null ? ` → 装配 ~${mw.assemblyKda} kDa（${pathZh}）` : '（无生物装配增重路径）'}`)
    if (mw.homologSearchNote) lines.push(`同源扩展检索: ${mw.homologSearchNote}`)
    if (mw.complexes.length) {
      lines.push(`已有复合物结构（组分总分子量）: ${mw.complexes.map(c => `${c.pdbId} = ${c.components.length} 组分合计 ~${c.totalKda} kDa（${c.basis === 'assembly' ? '生物装配口径' : '去重实体口径'}）`).join('；')}`)
    }
    const homologs = mw.homologComplexes ?? []
    if (homologs.length) {
      lines.push(`同源结构形成的大复合物（BLAST 扩展检索，同源亚基按靶点换算）: ${homologs.map(h => `${h.pdbId}（identity ${Math.round(h.identity)}%）同源装配 ~${h.totalKda} kDa → 靶点换算 ~${h.estimatedKda} kDa`).join('；')}`)
    }
    if (mwAdj) lines.push(`分子量维度评分调整（已计入 Cryo-EM 分数）: ${mwAdj.cryoem > 0 ? '+' : ''}${mwAdj.cryoem} — ${mwAdj.note}`)
    if (mw.conflicts.length) {
      lines.push(`增重与目的比对: ${mw.conflicts.map(c => `[${c.level === 'aligned' ? '契合' : c.level === 'caution' ? '需注意' : '冲突'}] ${c.text}`).join('；')}`)
    }
  }
  // v2.9：AlphaFold 预测结构（各靶点简报维度 — pLDDT 置信水平影响无实验结构区间的可用性判断）
  if (t.alphafold?.available) {
    lines.push(`AlphaFold 预测: ${t.alphafold.modelId ?? 'AF 模型'}（v${t.alphafold.version ?? '?'}）平均 pLDDT ${t.alphafold.globalPlddt ?? '—'}${t.alphafold.fracVeryHigh != null ? `，pLDDT ≥90 区段占 ${Math.round(t.alphafold.fracVeryHigh * 100)}%` : ''} — 交互 3D 视图见各靶点单独报告章节`)
  } else if (t.alphafold?.note) {
    lines.push(`AlphaFold 预测: 不可用（${t.alphafold.note}）`)
  }
  if (t.directPdbs.length) {
    // 代表性结构表（方法/分辨率/主要配体/年份 — 与单靶点报告 digest 同等粒度）
    lines.push('代表性结构（前 10）:')
    lines.push('| PDB | 方法 | 分辨率 | 主要配体 | 年份 |')
    lines.push('|-----|------|--------|----------|------|')
    lines.push(t.directPdbs.slice(0, 10).map(p =>
      `| ${p.pdbId} | ${p.isXray ? 'X-ray' : p.isCryoem ? 'Cryo-EM' : p.isNmr ? 'NMR' : p.method.slice(0, 10)} | ${p.resolution != null ? p.resolution + 'Å' : '-'} | ${p.ligands.length ? p.ligands.slice(0, 3).join(', ') : '-'} | ${p.releaseDate.slice(0, 4)} |`,
    ).join('\n'))
    lines.push('结构标题（前 6）:')
    lines.push(t.directPdbs.slice(0, 6).map(p => `- ${p.pdbId}: ${p.title.slice(0, 80)}`).join('\n'))
    // 高频配体词频（研究状态/成药性证据）
    const topLig = new Map<string, number>()
    for (const p of t.directPdbs) for (const l of p.ligands) {
      const k = l.split('(')[0].trim(); topLig.set(k, (topLig.get(k) ?? 0) + 1)
    }
    const ligs = [...topLig.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, c]) => `${k}×${c}`).join('、')
    if (ligs) lines.push(`高频配体: ${ligs}`)
    // 年份分布（研究热度时间线）
    const yearHist = new Map<string, number>()
    for (const p of t.directPdbs) {
      const y = p.releaseDate.slice(0, 4)
      if (/^\d{4}$/.test(y)) yearHist.set(y, (yearHist.get(y) ?? 0) + 1)
    }
    const timeline = [...yearHist.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([y, c]) => `${y}:${c}`).join('、')
    if (timeline) lines.push(`结构释放年份分布: ${timeline}`)
  } else {
    lines.push('（该 UniProt 无直接关联 PDB 结构）')
  }
  if (t.blastHits.length) {
    lines.push(`同源结构命中（前 6，排除直接命中后）:`)
    lines.push('| PDB | 描述 | Identity |')
    lines.push('|-----|------|----------|')
    lines.push(t.blastHits.slice(0, 6).map(h => `| ${h.pdbId || '-'} | ${h.description.slice(0, 70)} | ${h.identity}% |`).join('\n'))
    if (t.blastStatus?.note) lines.push(`（同源检索说明: ${t.blastStatus.note}）`)
  } else if (t.blastStatus) {
    lines.push(`BLAST: ${describeBlastStatus(t.blastStatus)}（报告中如实说明，不要虚构同源结构）`)
  }
  if (t.literature.length) {
    lines.push('代表性文献（前 6）:')
    lines.push('| PMID | 标题 | 期刊·年份 |')
    lines.push('|------|------|-----------|')
    lines.push(t.literature.slice(0, 6).map(l =>
      `| ${l.pmid} | ${l.title.slice(0, 80)}${l.fromPdb ? '（结构解析文献）' : ''} | ${l.journal} ${l.year} |`,
    ).join('\n'))
  }
  return lines.join('\n')
}

export interface MergedReportInput {
  targets: MergedTargetData[]
  relation: RelationJudgment
  goal?: string
  insights?: FormInsights | null
  images: ParsedImage[]
  /** 评估表序列归属（v1.10：构建序列随靶点评估、同源/未匹配序列显性呈现） */
  sequenceAttribution?: SequenceAttribution[]
}

export interface GeneratedMergedReport {
  fullMarkdown: string
  /** v1.14：LLM 生成的描述性标题（从 partA 首行 # 提取） */
  title: string
  ok: boolean
  errors: string[]
}

/** 数据上下文（供 LLM 各段共用的确定性摘要）— v2.10 ②从 generateMergedReport 抽出，供单独生成段D 复用 */
function buildMergedDigest(input: MergedReportInput): string {
  const { targets, relation } = input
  const relName = describeRelationType(relation.relationType)
  const digestLines: string[] = []
  digestLines.push('【批次与关系判定】')
  digestLines.push(`靶点数: ${targets.length} 个（${targets.map(t => t.label).join('、')}）`)
  digestLines.push(`关系判定: ${relName}（置信度 ${relation.confidence}）`)
  digestLines.push(`判定依据: ${relation.rationale}`)
  digestLines.push(`策略要点: ${relation.strategy}`)
  const pairs = relation.homologPairs?.filter(p => p.identity > 0) ?? []
  if (relation.relationType === 'homologous' || pairs.length) {
    digestLines.push('')
    digestLines.push('【家族序列一致性（系统全长序列两两比对 — 确定性证据，≥40% 判为家族级同源）】')
    digestLines.push(pairs.length
      ? pairs.map(p => `${p.a} ↔ ${p.b}: ${p.identity}%${p.identity >= 40 ? '（家族级同源）' : p.identity >= 30 ? '（弱同源信号）' : '（非同源）'}`).join('\n')
      : '（未获得可比对的序列数据）')
  }
  if (input.sequenceAttribution?.length) {
    digestLines.push('')
    digestLines.push('【评估表序列归属（系统比对 — 每条序列的去向，无遗漏）】')
    digestLines.push(input.sequenceAttribution.map((a, i) => {
      const tag = a.kind === 'construct' ? '客户构建' : a.kind === 'homolog' ? '同源家族成员' : a.kind === 'antibody' ? '抗体序列' : '未匹配'
      return `${i + 1}. ${a.length} aa${a.header ? `（${a.header.slice(0, 50)}）` : ''} → ${tag}${a.uniprotId ? ` ${a.uniprotId}` : ''}${a.identity != null ? `，一致性 ${a.identity}%` : ''}${a.kind === 'construct' && a.start != null && a.end != null ? `，对应区间 ${a.start}-${a.end}` : ''}`
    }).join('\n'))
  }
  digestLines.push('')
  digestLines.push('【客户目标】')
  digestLines.push(input.goal?.trim() || input.insights?.goals?.slice(0, 3).map(elideSequenceRuns).join('；') || '（未提供明确目标 — 按通用结构解析可行性评估）')
  const ins = input.insights
  if (ins?.scientificQuestions?.length) {
    digestLines.push('')
    digestLines.push('【待解决的科学问题（评估表提取）】')
    digestLines.push(ins.scientificQuestions.slice(0, 6).map((q, i) => `${i + 1}. ${elideSequenceRuns(q)}`).join('\n'))
  }
  if (ins?.sequenceNotes) digestLines.push(`【构建/序列说明】${elideSequenceRuns(ins.sequenceNotes)}`)
  if (ins?.homologs) digestLines.push(`【同源/参考信息】${elideSequenceRuns(ins.homologs)}`)
  if (ins?.experimentalSummary) digestLines.push(`【实验数据要点】${elideSequenceRuns(ins.experimentalSummary)}`)
  if (ins?.keyConcerns?.length) digestLines.push(`【风险关注点】${ins.keyConcerns.slice(0, 5).map(elideSequenceRuns).join('；')}`)
  if (input.images.length) {
    digestLines.push('')
    digestLines.push('【客户实验数据（评估表图片，各靶点共享）】')
    digestLines.push(input.images.map(im => {
      const tag = im.kind === 'gel' ? '[SDS-PAGE 胶图]' : im.kind === 'sec' ? '[SEC 色谱图]' : '[其他实验图]'
      return `- ${tag} ${im.caption}`
    }).join('\n'))
  }
  digestLines.push('')
  digestLines.push('【各靶点数据摘要】')
  digestLines.push(targets.map(targetDigest).join('\n\n'))

  // 共有结构（v1.22）：同一 PDB 覆盖多个输入 UniProt —— 复合物/共结晶等物理关联证据
  const sharedStructures = computeSharedStructures(targets)
  if (sharedStructures.length > 0) {
    digestLines.push('')
    digestLines.push(`【共有结构（同一 PDB 覆盖多个输入 UniProt — 复合物/共结晶/融合构建，${sharedStructures.length} 个）】`)
    digestLines.push(sharedStructures.slice(0, 30).map(s => {
      const cov = s.coverage.map(c => `${c.uniprotId}${c.chainRanges ? `（${c.chainRanges}）` : ''}`).join('、')
      return `- ${s.pdbId} [${s.method}${s.resolution != null ? ` ${s.resolution.toFixed(2)}Å` : ''}] 覆盖 ${s.targetCount} 个靶点：${cov} — ${s.title.slice(0, 80)}`
    }).join('\n'))
  }
  // v2.26：GPCR 受体主导复合物批次 — 撰写视角要求（以受体为主对象，G 蛋白为伴侣）
  const gpcrBatch = detectReceptorGproteinBatch(targets)
  if (gpcrBatch) {
    const rxCx = receptorGproteinStructures(sharedStructures, gpcrBatch)
    digestLines.push('')
    digestLines.push(`【批次形态：受体主导复合物（GPCR 类 — 以受体为主对象撰写）】`)
    digestLines.push(`受体（本报告主要对象）：${gpcrBatch.receptor.label}${gpcrBatch.receptor.proteinName && gpcrBatch.receptor.proteinName !== gpcrBatch.receptor.label ? `（${gpcrBatch.receptor.proteinName}）` : ''}；G 蛋白伴侣（信号转导组分，非独立结构解析对象）：${gpcrBatch.couplingLabel}`)
    digestLines.push(rxCx.length
      ? `受体 × G 蛋白复合物结构 ${rxCx.length} 个（同一 PDB 同时覆盖受体与 G 蛋白组分 — 共组装直接先例）：${rxCx.slice(0, 12).map(s => `${s.pdbId} [${s.method}${s.resolution != null ? ` ${s.resolution.toFixed(2)}Å` : ''}]`).join('、')}`
      : '受体 × G 蛋白复合物结构：无先例（受体与该 G 蛋白类型的复合物组装需从共表达/体外组装验证起步）')
    digestLines.push('撰写要求：以受体为主要评估对象（受体小节详细展开）；G 蛋白定位为复合物组装的伴侣/证据（在关系分析与整合实验方案中论述「复合物结构先例存在与否」及其对组装路线的指导意义），不作为独立结构解析项目展开。')
  }
  return digestLines.join('\n')
}

/** v2.10 ②：段D 指令（客户评估表目标/问题逐条回应 — 严格 G/Q 编号格式供渲染端逐条内嵌） */
function insightQaInstruction(qaGoals: string[], qaQuestions: string[]): string {
  const goalList = qaGoals.map((g, i) => `G${i + 1}：${g}`).join('\n')
  const qList = qaQuestions.map((q, i) => `Q${i + 1}：${q}`).join('\n')
  return `撰写「${QA_CHAPTER_TITLE}」章节（以 ## 开头）— 客户最关心的部分：对评估表提取的目标与问题逐条回应。客户原话如下（编号一一对应，回应时原文逐字复制，不得改写或省略）：

【客户目标】
${goalList}

【待解决的科学问题】
${qList}

回应要求：
- G 条（目标回应）：先一句话判断该目标在本批次数据下能否达成（能/部分能/取决于××/数据不足），再用 2-3 句给依据与建议路径（引用具体数字：PDB 数量/分辨率/覆盖率/同源命中/寡聚态/分子量）
- Q 条（问题回答）：先给明确结论（能/不能/部分能/取决于××），再用 2-4 句给依据（PDB ID / 共有结构 / 同源命中 / 寡聚态 / 分子量 / 文献 PMID）；数据未覆盖处如实标注「（本次数据未覆盖）」，并给建议的实验验证路径
- 严格按以下格式输出（### 标记，冒号后为条目原文；按 G1…Gn、Q1…Qn 顺序逐条全部输出，不得遗漏、不得新增条目、不要输出其他章节）：

## ${QA_CHAPTER_TITLE}
### G1：{G1 目标原文}
**回应**：{…}

### Q1：{Q1 问题原文}
**回答**：{…}

- 篇幅：每条 80-180 字`
}

/** v2.10 ②：单独生成「客户评估表问题回应」章节 — 旧合并报告补答升级用
 * （旧记录 markdown 无段D 时追加该章节并重渲染 HTML，即可在客户端看到逐条回答）。
 * 返回 markdown 含 `## 客户评估表问题回应` 章节；无 goals/questions 时返回空。 */
export async function generateInsightQa(input: MergedReportInput, signal?: AbortSignal): Promise<{ markdown: string; ok: boolean; error?: string }> {
  const qaGoals = (input.insights?.goals ?? []).slice(0, 6).map(elideSequenceRuns).filter(Boolean)
  const qaQuestions = (input.insights?.scientificQuestions ?? []).slice(0, 6).map(elideSequenceRuns).filter(Boolean)
  if (qaGoals.length + qaQuestions.length === 0) return { markdown: '', ok: true, error: '（评估表无目标/待解决问题 — 无需回应）' }
  const digest = buildMergedDigest(input)
  const r = await llmChat(`${digest}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n基于以上数据上下文，${insightQaInstruction(qaGoals, qaQuestions)}`, SYSTEM, signal)
  return { markdown: r.ok ? r.text.trim() : '', ok: r.ok, error: r.error }
}

export async function generateMergedReport(input: MergedReportInput, signal?: AbortSignal): Promise<GeneratedMergedReport> {
  const { targets, relation } = input
  const relName = describeRelationType(relation.relationType)
  const ins = input.insights
  const pairs = relation.homologPairs?.filter(p => p.identity > 0) ?? []

  const digest = buildMergedDigest(input)

  const callPart = async (name: string, instruction: string): Promise<{ key: string; markdown: string; llmOk: boolean; error?: string }> => {
    const r = await llmChat(`${digest}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n基于以上数据上下文，${instruction}`, SYSTEM, signal)
    return { key: name, markdown: r.ok ? r.text : '', llmOk: r.ok, error: r.error }
  }

  const partA = await callPart('A', `撰写合并报告的标题与首两章。首行输出 # 开头的描述性报告标题（一行，≤30 字，不要副标题，不要包含"报告"二字、日期、编号），高度概括本批次靶点与关系类型${detectReceptorGproteinBatch(input.targets) ? '（受体主导复合物批次 — 标题以受体为主体命名，如「CCR8 与 Gi 异三聚体复合物结构解析评估」，G 蛋白组分定位为伴侣而非并列主体）' : ''}，例如「EGFR 与 p53 抗体-抗原复合物合并评估」「MAPK 家族三成员合并结构可行性评估」「血红蛋白 α/β 异源二聚体复合物评估」。然后顺序输出以下两章（以 ## 开头，不要输出其他章节）：

## 执行摘要
- 3-4 段：第一段给出批次总体结论（这些靶点作为整体项目的结构解析可行性、推荐技术路线${relation.relationType === 'homologous' ? '；同源家族批次需说明家族级结论（任一成员的结构证据对整个家族的指导意义）' : ''}）；第二段逐个靶点一句话概括其结构研究现状（引用具体数字）；第三段概括客户目标的达成路径与整体风险；第四段一句话给出下一步建议
- 篇幅 400-600 字

### 可行性结论（${relation.relationType === 'homologous' ? '家族级' : '批次级'}）
- **结论分级**：直接给出高/中/低分级，并用一段话说明判断依据（引用具体数字：结构总数/最佳分辨率/覆盖率/同源命中/文献；若各靶点存在寡聚态差异，说明对整体可行性的影响）
- **关键依据**：3-5 条列表，每条注明来源靶点（哪个 UniProt 的证据）
- **主要风险**：2-4 条列表（构象柔性/覆盖空白/表达纯化难度/家族成员间差异/寡聚体组装均一性与异源复合物组装策略等，基于数据判断）

## 靶点关系分析
本报告的核心章节 — 客户需要理解这些靶点为什么合并评估：
- ### 关系判定与证据：明确说明判定为「${relName}」的依据${pairs.length ? '（引用系统序列一致性比对的具体数字 + 蛋白名/基因/物种证据）' : '（引用数据上下文中的具体证据：蛋白名/功能注释/客户目标/序列信息）'}${relation.blastGroups?.length ? '；说明 ≥90% 高一致成员共享同源检索结果的策略（哪些靶点未单独检索而共享了代表的命中）' : ''}
- ### 生物学意义：${relation.relationType === 'homologous' ? '同源家族的生物学背景：直系/旁系同源关系的判定依据（一致性水平/物种分布/基因名）、家族保守区域（催化残基/结构域）与变异区域的分布、物种差异对结构与功能的影响（基于注释，禁止编造）' : '这种关系的生物学背景（复合物的组装方式/抗体-抗原结合模式/融合构建的设计意图等，基于注释与文献，禁止编造）'}
- ### 对结构解析策略的影响：${relation.relationType === 'complex' ? '复合物亚基的共表达/共纯化策略、化学计量比、组装验证' : relation.relationType === 'antibody-antigen' ? '抗体（Fab/scFv）与抗原的复合物组装、抗体辅助结晶或 Cryo-EM 配对策略' : relation.relationType === 'fusion' ? '融合构建的边界设计、linker 选择、各结构域的折叠独立性' : relation.relationType === 'homologous' ? '家族证据互用原则：任一成员已有结构可直接指导其他成员的构建边界设计与结晶条件借鉴；建议优先解析的家族成员（结构数据最丰富/表达最成熟者先行）；家族保守区与可变区的构建边界策略；如有序列归属中的同源序列，说明其与已选靶点的家族关系' : '关联项目协同推进的要点'}
- 篇幅 600-900 字`)

  // v1.16：3 段调用之间加 5s 间隔，避免连续触发 Z.ai 内置引擎限流（429）
  await new Promise(r => setTimeout(r, 5000))

  const partB = await callPart('B', `撰写报告的以下章节（以 ## 开头，顺序输出，不要输出其他章节，不要再输出 # 标题）：

## 各靶点结构可行性综述
对批次中每个靶点输出一个小节（### 靶点名），每节包含（详细程度不低于独立单靶点报告）：
- **一句话结论**：该靶点结构解析可行性如何、推荐方法（方法先例行为「Cryo-EM 占主导/全部」时，推荐方法必须优先论证沿已有 Cryo-EM 复合物/装配路线 — 禁止仅因单体分子量小而推荐 X-ray/NMR 并将 Cryo-EM 降为末选；引用具体 PDB 与分辨率作先例依据）
- **已有结构研究概况**：引用 PDB 数量/方法分布/最佳分辨率/覆盖率（含覆盖区间与空白区间）/高频配体/结构释放年份分布（研究热度变化）
- **同源结构证据**：BLAST/序列检索命中概况（最高一致性/命中数）；命中为共享自家族代表时必须如实说明（未单独检索、共享来源），不得虚构
- **文献证据**：引用 1-2 篇代表性文献（PMID + 一句话贡献，优先结构解析文献）
- **${relation.relationType === 'homologous' ? '家族内定位' : '主要风险与注意点'}**：${relation.relationType === 'homologous' ? '与其他成员的一致性水平、在家族中的结构研究成熟度、可从哪些成员借鉴构建经验与结晶条件' : '构象柔性/覆盖空白/构建边界问题，基于数据判断'}
- **聚集形式（寡聚态）**：引用「聚集形式」行（判定/化学计量/置信度/证据）说明该靶点以何种装配形式发挥功能与被解析；对构建边界（保留寡聚化界面）、表达纯化（组装验证 SEC-MALS）、方法选择（寡聚体有效分子量对 Cryo-EM/NMR 的影响；异源复合物需共表达/体外组装）给出结合寡聚态的具体建议；无数据时如实说明
- **风险与切入建议**：主要风险 1-2 条 + 最可行的切入点（构建边界/表达系统/方法选择，需考虑聚集形式）
- 篇幅每靶点 500-700 字

要求：各靶点篇幅均衡；数据引用与数据摘要一致（PDB ID/PMID/分辨率/一致性数字必须来自数据上下文，禁止编造）；BLAST 跳过/失败/共享的靶点如实说明${input.sequenceAttribution?.some(a => a.kind === 'construct') ? '；已归属为客户构建的序列（见序列归属）在对应靶点小节中说明构建边界与全长区间的对应关系' : ''}`)

  await new Promise(r => setTimeout(r, 5000))

  const partC = await callPart('C', `撰写报告的以下两章（以 ## 开头，顺序输出，不要输出其他章节，不要再输出 # 标题）：

## 整合可行性与实验策略
- ### 跨靶点对比矩阵：用 Markdown 表格对比各靶点（行：靶点/PDB 数量/最佳分辨率/覆盖率/总体评分/推荐方法/主要风险）
- ### 整合实验方案：${relation.relationType === 'complex' ? '复合物共表达与组装策略（共表达比例/纯化顺序/组装验证 SEC-MALS）、备选方案（分开表达后体外组装）' : relation.relationType === 'antibody-antigen' ? '抗体-抗原复合物制备（Fab 酶切/亲和纯化/复合物组装与纯化）、抗体辅助结晶 vs Cryo-EM 的选择' : relation.relationType === 'fusion' ? '融合构建表达纯化要点与各结构域独立对照实验的必要性' : relation.relationType === 'homologous' ? '家族实验策略：优先表达/解析哪个家族成员（结构数据最丰富、覆盖最完整者先行作模板）、其余成员的构建边界借鉴方案（保守核心 + 可变区处理）、物种选择建议（表达系统兼容性与序列一致性的权衡）、若需全部解析则给优先级排序' : '各靶点独立推进的资源配置与优先级排序建议'}；聚集形式考量：结合各靶点寡聚态判定（同源寡聚体/异源复合物/单体）给出差异化的组装验证与构建边界策略（寡聚体保留组装界面、异源依赖复合物需共表达/体外组装的分阶段方案）
- ### 时间规划：Markdown 表格（阶段/预计时间/关键里程碑/风险点）
- 篇幅 500-800 字

## 总结
- 3 段以内：批次核心结论重申 + 给客户的 3 条最重要建议 + 明确的 go/no-go 倾向性意见
- 篇幅 200-300 字`)

  // ── v2.10 ②：段D「客户评估表问题回应」— 客户评估表要点中的目标与待解决科学问题逐条回应。
  // 仅有评估表提取数据时生成（无 goals/questions 时跳过 — 无问题可答）；输出为独立
  // 章节（## 客户评估表问题回应），渲染时拆出并内嵌到「客户评估表要点」章节条目下方。
  const qaGoals = (ins?.goals ?? []).slice(0, 6).map(elideSequenceRuns).filter(Boolean)
  const qaQuestions = (ins?.scientificQuestions ?? []).slice(0, 6).map(elideSequenceRuns).filter(Boolean)
  let partD: { key: string; markdown: string; llmOk: boolean; error?: string } | null = null
  if (qaGoals.length + qaQuestions.length > 0) {
    await new Promise(r => setTimeout(r, 5000))
    partD = await callPart('D', insightQaInstruction(qaGoals, qaQuestions))
  }

  const parts = [partA, partB, partC, ...(partD ? [partD] : [])]
  const fullMarkdown = parts.map(p => p.markdown.trim()).filter(Boolean).join('\n\n')
  const errors = parts.filter(p => !p.llmOk).map(p => `段${p.key}: ${p.error}`)
  // v1.14：从 partA 首行提取 LLM 生成的描述性标题（# 开头）
  const titleMatch = partA.markdown.match(/^#\s+(.+)$/m)
  const title = titleMatch?.[1]?.trim() || ''
  return { fullMarkdown, title, ok: parts.some(p => p.llmOk), errors }
}

// ─── 合并报告 HTML 渲染（期刊风，与单靶点报告同一设计语言）──────────────────


/**
 * v2.12：拆出 markdown 中的「各靶点结构可行性综述」章节 — 各 ### 小节按
 * UniProt ID / 标签 / 蛋白名 / 基因名归属到对应靶点（渲染进该靶点的单独报告页，
 * 综述与基本信息/预测结构/单独结构同页）。归属失败的小节留在首页合并分析章节
 * （降级不丢内容 — LLM 小节标题偏离预期时不影响报告完整性）。
 * 渲染时拆分（而非生成时）：旧报告无需重新评估，重渲染即获得新结构。
 */
export function splitTargetReview(md: string, targets: MergedTargetData[]): { homeMd: string; reviewByTarget: Map<string, string> } {
  const reviewByTarget = new Map<string, string>()
  if (!md) return { homeMd: md, reviewByTarget }
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const startIdx = lines.findIndex(l => /^##\s*各靶点(结构可行性)?综述\s*$/.test(l.trim()))
  if (startIdx === -1) return { homeMd: md, reviewByTarget }
  let endIdx = lines.length
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i].trim())) { endIdx = i; break }
  }
  const sectionLines = lines.slice(startIdx + 1, endIdx)
  // ### 小节切分；小节前的导语（罕见）与无法归属的小节回首页
  const subsections: Array<{ heading: string; body: string[] }> = []
  const preamble: string[] = []
  let cur: { heading: string; body: string[] } | null = null
  for (const l of sectionLines) {
    const m = l.match(/^###\s+(.+)$/)
    if (m) { cur = { heading: m[1].trim(), body: [] }; subsections.push(cur) }
    else if (cur) cur.body.push(l)
    else preamble.push(l)
  }
  const matchTarget = (heading: string): MergedTargetData | undefined => targets.find(t =>
    (t.uniprotId && heading.includes(t.uniprotId)) ||
    (t.label && t.label.length >= 3 && heading.includes(t.label)) ||
    (t.proteinName && t.proteinName.length >= 4 && heading.includes(t.proteinName)) ||
    ((t.geneNames ?? []).some(g => g && g.length >= 4 && heading.includes(g)))
  )
  const leftover: string[] = []
  if (preamble.some(l => l.trim())) leftover.push(...preamble)
  for (const s of subsections) {
    const t = matchTarget(s.heading)
    const body = s.body.join('\n').trim()
    if (t && body) reviewByTarget.set(t.uniprotId ?? t.label, body)
    else leftover.push(`### ${s.heading}`, ...s.body)
  }
  const rest = [...lines.slice(0, startIdx), ...lines.slice(endIdx)]
  const homeLines = leftover.length
    ? [...rest.slice(0, startIdx), '## 各靶点结构可行性综述（以下小节未能归属到单独报告页）', ...leftover, ...rest.slice(startIdx)]
    : rest
  return { homeMd: homeLines.join('\n'), reviewByTarget }
}

export interface MergedHtmlInput {
  targets: MergedTargetData[]
  relation: RelationJudgment
  goal?: string
  markdown: string
  /** v1.14：LLM 生成的描述性标题（HTML <h1> 与 <title> 用） */
  title?: string
  llmOk: boolean
  llmErrors: string[]
  images: ParsedImage[]
  assetDir: string
  batchReportId: string
  engineSummary: string
  /** 评估表序列归属（v1.10） */
  sequenceAttribution?: SequenceAttribution[]
  /** v1.15：评估表 AI 解析要点（LLM 失败时作为兜底证据展示） */
  insights?: FormInsights | null
  /** v1.22：共有结构（同一 PDB 覆盖多个输入 UniProt）；v2.26 起渲染层一律从补齐后
   *  的 targets 重算（旧落库值基于 500 条截断的交集 — 不可信），仅保留字段兼容旧调用方 */
  sharedStructures?: SharedStructure[]
}

/** 图片内嵌（预算：≤6 张、总 ≤4MB，gel/sec 优先） */
async function embedImages(images: ParsedImage[], assetDir: string): Promise<Array<{ meta: ParsedImage; dataUri: string }>> {
  const budget = 4 * 1024 * 1024
  const ordered = [...images].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'other' ? 1 : b.kind === 'other' ? -1 : 0)).slice(0, 6)
  const out: Array<{ meta: ParsedImage; dataUri: string }> = []
  let used = 0
  for (const meta of ordered) {
    const ext = meta.mime.includes('png') ? 'png' : meta.mime.includes('gif') ? 'gif' : meta.mime.includes('webp') ? 'webp' : 'jpg'
    try {
      // turbopackIgnore：assetDir 为运行时上传产物目录（db/reports/<id>/assets），
      // 构建期不可静态确定；若不忽略，Turbopack 会把整个项目根（含 node_modules 全量、
      // skills/、docs/ 等 ~295MB）追踪进 standalone 产物，触发部署平台体积上限导致部署失败。
      const buf = await fs.readFile(path.join(/*turbopackIgnore: true*/ assetDir, `${meta.id}.${ext}`))
      if (used + buf.length > budget) continue
      used += buf.length
      out.push({ meta, dataUri: `data:${meta.mime};base64,${buf.toString('base64')}` })
    } catch { /* 缺图跳过 */ }
  }
  return out
}

export async function renderMergedReportHtml(input: MergedHtmlInput): Promise<string> {
  const relation = input.relation
  // ── v2.26 ①：共有结构覆盖补齐（全量 ID 交集在线执行 — 新旧作业通吃；与生成路径
  //    的先前补齐经 ID 缓存幂等重入，零网络直达 added=0 分支；任何异常静默退回原数据）
  const augmented = await augmentTargetsForSharedPdbCoverage(input.targets)
  const targets = augmented.targets
  const sharedAdded = augmented.added
  const relName = describeRelationType(relation.relationType)
  // v1.14：LLM 生成的描述性标题（fallback 通用标题）
  const reportTitle = input.title?.trim() || '多靶点合并评估报告'
  // 剥离 markdown 首行 # 标题（已用作 HTML <h1>，避免重复渲染）；
  // v2.10 ②：拆出「客户评估表问题回应」章节 — 不在合并分析章节渲染，而是逐条内嵌到
  // 「客户评估表要点」章节对应目标/问题条目下方（回答紧跟问题，客户可逐条阅读）
  const mdNoTitle = input.markdown ? input.markdown.replace(/^#\s+.+\r?\n?/, '') : ''
  const { qaMd, rest: llmMarkdown } = splitQaChapter(mdNoTitle)
  // v2.12 ①：「各靶点结构可行性综述」拆出 — 各靶点小节归入其单独报告页，
  // 首页合并分析章节只保留复合物级内容（摘要/关系/整合策略/总结）
  const { homeMd: llmHomeMd, reviewByTarget } = splitTargetReview(llmMarkdown, targets)
  const qa = parseInsightQa(qaMd)
  const qaTotal = (input.insights?.goals?.length ?? 0) + (input.insights?.scientificQuestions?.length ?? 0)
  // 段D 生成了但逐条解析失败（LLM 偏离格式）→ 整块降级渲染；未生成（失败/无评估表）→ 提示行
  const qaRawFallback = qaMd && qa.parsedCount === 0 ? qaMd : ''
  const qaMissingNote = qaTotal > 0 && qa.parsedCount === 0 ? (qaMd
    ? '（评估表逐条回应解析失败 — 已整块呈现于下方）'
    : '（逐条回应本次生成失败 — 相关策略论述见合并评估分析章节）') : ''
  const dateStr = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
  const embedded = await embedImages(input.images, input.assetDir)

  // ── v2.11 报告格式优化（对齐单独评估）────────────────────────────
  // ① 统一动态章节编号：按目录顺序全量连续编号的编号方块风格（与单靶点报告同一
  //   设计语言）。存在性先判定、依展示顺序取号。
  // ② v2.12 章节顺序（首页 = 复合物评估）：合并分析 → 共有结构（含共有文献）→
  //   评估表要点 → 配体 → 矩阵/一致性/归属 → 客户实验数据；各靶点综述/单独报告/
  //   单独结构（PDB/同源/文献）全部移入每靶点独立视图页（单独评估与单独结构同页）。
  const isHomologousBatch = relation.relationType === 'homologous'
  const hasIdentityMatrix = (isHomologousBatch || relation.homologPairs?.some(p => p.identity > 0)) && targets.length >= 2
  const hasAttribution = (input.sequenceAttribution?.length ?? 0) > 0
  // v2.26 ②：共有结构一律从补齐后的 targets 重算 — 旧落库值基于 500 条截断的
  // directPdbs（3 靶点复合物批次交集为空的根因），重渲染即修复；不再信任透传值。
  const sharedStructures = computeSharedStructures(targets)
  /** 受体 × G 蛋白复合物结构（v2.26 GPCR 受体主导批次 — 存在性标注与分析） */
  const gpcrBatch = detectReceptorGproteinBatch(targets)
  const receptorGComplex = gpcrBatch ? receptorGproteinStructures(sharedStructures, gpcrBatch) : []
  /** 共有结构 PDB ID 集（各靶点明细表内行加 ◈ 徽标互证） */
  const sharedIds = new Set(sharedStructures.map(s => s.pdbId))
  const litTotal = targets.reduce((s, t) => s + t.literature.length, 0)
  const hasAssets = embedded.length > 0
  const hasLigands = targets.some(t => (t.ligands?.length ?? 0) > 0)
  const insightsSecInput = input.insights
  const hasInsightsSec = !!(insightsSecInput && (insightsSecInput.goals?.length || insightsSecInput.scientificQuestions?.length || insightsSecInput.experimentalSummary || insightsSecInput.sequenceNotes || insightsSecInput.homologs || insightsSecInput.keyConcerns?.length))
  let noSeq = 0
  const nextNo = () => { noSeq += 1; return String(noSeq).padStart(2, '0') }
  const noLlm = nextNo()
  // v2.11：共有结构提前 — 合并分析后第一个数据章节（批次级共同结构证据，重点阅读）
  const noShared = nextNo()
  const noInsights = hasInsightsSec ? nextNo() : ''
  const noLigands = hasLigands ? nextNo() : ''
  const noMatrix = nextNo()
  const noIdentity = hasIdentityMatrix ? nextNo() : ''
  const noAttribution = hasAttribution ? nextNo() : ''
  const noAssets = hasAssets ? nextNo() : ''
  /** v2.8 章节头：编号方块 + 标题 + 英文标签（与单靶点报告同构） */
  const secHead = (no: string, title: string, en: string) =>
    `<span class="sec-no">${no}</span><span class="sec-title">${esc(title)}</span><span class="sec-en">${esc(en)}</span>`
  // v2.13：各靶点 PDB/同源/文献明细不再以折叠块形式集中首页 — 单独评估页内
  // 按单靶点报告格式全量展开（expandAll）。

  // ── v2.9：各靶点单独报告 — AlphaFold 预测结构数据源（每靶点交互 3D 视图）────
  // 磁盘优先（db/cache/alphafold — sidecar 7 天新鲜窗口零网络，断网回退本地缓存）；
  // 单模型 ≤2.5MB（与单靶点报告一致）、批次总预算 12MB：超限/无模型的靶点降级为
  // 统计信息呈现（元数据 + AFDB 链接），获取失败永不阻塞报告生成。
  // 旧作业（summary 无 alphafold 字段）经 alphafoldMetaFor 补齐元数据。
  const AF_MINI_BATCH_BUDGET = 12 * 1024 * 1024
  interface AfMiniView { pdbText: string; modelId: string; version: number; globalPlddt: number | null; fracVeryHigh: number | null }
  const afViews = new Map<string, AfMiniView>()
  const afMetaFill = new Map<string, AlphafoldSummaryInfo>()
  let afBudgetLeft = AF_MINI_BATCH_BUDGET
  await Promise.all(targets.map(async t => {
    if (!t.uniprotId) return
    if (!t.alphafold) {
      try {
        const m = await alphafoldMetaFor(t.uniprotId)
        if (m) afMetaFill.set(t.uniprotId, { available: true, modelId: m.modelId, globalPlddt: m.globalPlddt, version: m.latestVersion, fracVeryHigh: m.fracVeryHigh })
      } catch { /* 元数据降级 */ }
    }
    try {
      const st = await alphafoldStructureFor(t.uniprotId)
      if (!st) return
      if (!st.embeddable) return
      if (st.pdbText.length > afBudgetLeft) return
      afViews.set(t.uniprotId, { pdbText: st.pdbText, modelId: st.meta.modelId, version: st.meta.latestVersion, globalPlddt: st.meta.globalPlddt, fracVeryHigh: st.meta.fracVeryHigh })
      afBudgetLeft -= st.pdbText.length
    } catch { /* 视图降级 — 统计信息 */ }
  }))
  // v2.15：ESMFold 兜底模型入公共 MODELS 池（键 esm:{cacheKey} — 与 AF 模型键空间
  // 不碰撞）。AFDB 有模型的靶点不会有 esmfold 摘要（管线引擎互斥），此处仅对
  // 无 AFDB 收录的靶点补充。纯磁盘直读（毫秒级 — 单独评估作业 af2 相位已写缓存），
  // 超出批次预算/缓存缺失时降级统计卡。不联网重取（合并报告生成走低频后台任务，
  // 公共服务配额宝贵；重新评估该靶点即可回填）。
  interface EsmMiniView { pdbText: string; sequenceLength: number; globalPlddt: number | null; fracVeryHigh: number | null }
  const esmViews = new Map<string, EsmMiniView>()
  await Promise.all(targets.map(async t => {
    if (t.alphafold?.available || !t.esmfold?.available || !t.esmfold.cacheKey) return
    try {
      const cached = await loadCachedEsmfoldModel(t.esmfold.cacheKey)
      if (!cached) return
      if (cached.pdbText.length > afBudgetLeft) return
      esmViews.set(t.esmfold.cacheKey, { pdbText: cached.pdbText, sequenceLength: cached.meta.sequenceLength, globalPlddt: t.esmfold.globalPlddt ?? cached.meta.meanPlddt, fracVeryHigh: t.esmfold.fracVeryHigh ?? cached.meta.fracVeryHigh })
      afBudgetLeft -= cached.pdbText.length
    } catch { /* 视图降级 — 统计信息 */ }
  }))
  const af3dBundle = afViews.size > 0 || esmViews.size > 0 ? await ensure3DmolBundle() : null

  // ── v2.13：各靶点单独评估页 — 直接渲染完整单靶点报告主体 ───────────────
  // v2.9「简报卡」退役：每靶点页复用 renderSingleReportBody（单靶点报告同款
  // header/glance/目录/评估分析/评分卡/PDB 结构/同源/文献/客户实验数据），
  // PDB 结构与文献全量展开（expandAll）；AF 视图走公共 MODELS 池，图片走首页池。
  const targetKeyOf = (t: MergedTargetData) => (t.uniprotId ?? t.label).replace(/[^A-Za-z0-9]/g, '')

  // v2.48.1：重复靶点（同 UniProt/同 label 二次评估合并）key 唯一化 — 视图 id /
  // data-goto 卡片导航 / #view-target- 深链 / 内嵌 section id 前缀（含表格筛选分组
  // 作用域）全部引用同一 key；此前重复 key 致两靶点视图与章节锚点全部冲突（筛选
  // 控制器跨靶点并组、卡片恒进第一视图）。后缀 -2/-3… 与纯字母数字基 key 不碰撞。
  const keyByTarget = new Map<MergedTargetData, string>()
  {
    const seen = new Map<string, number>()
    for (const t of targets) {
      const base = targetKeyOf(t)
      const n = (seen.get(base) ?? 0) + 1
      seen.set(base, n)
      keyByTarget.set(t, n === 1 ? base : `${base}-${n}`)
    }
  }
  const keyOf = (t: MergedTargetData) => keyByTarget.get(t) ?? targetKeyOf(t)

  // 3Dmol bundle 一次内嵌 + 多视图初始化（所有 data-maf 阶段共用同一实现与 pLDDT 着色）
  // 无可内嵌模型（全部靶点无预测/超预算）时整段省略 — 报告不携带死脚本
  // MODELS 映射为 UniProt → 模型 PDB 文本（纯字符串 — plddtStyleApplyJs 直接消费）
  // v2.12：懒初始化 — 只初始化「当前可见视图」内的阶段（隐藏视图的 canvas 尺寸
  // 为 0，盲初始化会渲染出空白）；视图切换时补初始化，打印前全量初始化（海报补齐）
  // v2.15：ESMFold 模型并入同一 MODELS 池（键 esm:{cacheKey} — 与 AF 模型键空间
  // 不碰撞；值统一为 PDB 文本字符串，mtrViewerJs 的 addModel(pdb,'pdb') 直接消费）
  const afModelEntries: Array<[string, string]> = [
    ...[...afViews].map(([k, v]) => [k, v.pdbText] as [string, string]),
    ...[...esmViews].map(([k, v]) => [`esm:${k}`, v.pdbText] as [string, string]),
  ]
  const afModelsJson = JSON.stringify(Object.fromEntries(afModelEntries)).replace(/<\//g, '<\\/')
  const mtrViewerJs = afViews.size > 0 || esmViews.size > 0 ? `
    ${af3dBundle ? `<script>${af3dBundle.replace(/<\/script/gi, '<\\/script')}</script>` : ''}
    <script>${afToolbarJs()}</script>
    <script>
    (function () {
      var MODELS = ${afModelsJson};
      function initStage(stage) {
        if (stage.getAttribute('data-init')) return;
        // 3Dmol 未就绪（CDN 加载中）— 直接返回待重试，不标记失败（加载失败由
        // onerror → failAll 统一降级；视图切换/加载完成会再次触发 initPending）
        if (!window.$3Dmol) return;
        stage.setAttribute('data-init', '1');
        var key = stage.getAttribute('data-maf');
        var cv = stage.querySelector('.af-canvas');
        var poster = stage.querySelector('.af-poster');
        var pdb = MODELS[key];
        if (!pdb || !cv) { if (stage) stage.className = 'af-stage af-fail'; return; }
        try {
          if (!window.$3Dmol) throw new Error('3Dmol unavailable');
          var viewer = $3Dmol.createViewer(cv, { defaultcolors: $3Dmol.rasmolElementColors });
          viewer.setBackgroundColor(0xffffff);
          viewer.addModel(pdb, 'pdb');
          ${plddtStyleApplyJs()}
          viewer.zoomTo();
          viewer.zoom(1.2);
          viewer.render();
          stage.className = 'af-stage af-live';
          try {
            var uri = viewer.pngURI ? viewer.pngURI() : null;
            if (uri && poster) poster.src = uri;
          } catch (e) { /* 打印海报生成失败不影响交互 */ }
          // v2.46：挂载「下载 PDB + 着色切换」工具条（域区间从 stage data-domains
          // 读 — renderSingleReportBody 序列化；AFDB 模型才携带，ESMFold 编号不对齐不带）
          try {
            if (window.__afTb && window.__afTb.mount) {
              var afn = stage.getAttribute('data-afn') || 'model.pdb';
              var domAttr = stage.getAttribute('data-domains');
              var doms = null;
              if (domAttr) { try { doms = JSON.parse(domAttr); } catch (er) { doms = null; } }
              window.__afTb.mount(stage, viewer, pdb, { fileName: afn, domains: doms });
            }
          } catch (e) { /* 工具条失败不影响视图 */ }
        } catch (e) { stage.className = 'af-stage af-fail'; try { stage.setAttribute('data-maf-err', String((e && e.message) || e).slice(0, 200)); } catch (er) { /* ignore */ } }
      }
      function visibleStages() {
        var all = document.querySelectorAll('.af-stage[data-maf]:not([data-init])');
        var out = [];
        for (var i = 0; i < all.length; i++) {
          var v = all[i].closest ? all[i].closest('.rpt-view') : null;
          if (!v || v.classList.contains('rpt-view-on')) out.push(all[i]);
        }
        return out;
      }
      function initPending() { visibleStages().forEach(initStage); }
      function initAll() {
        Array.prototype.forEach.call(document.querySelectorAll('.af-stage[data-maf]:not([data-init])'), initStage);
      }
      function failAll() {
        Array.prototype.forEach.call(document.querySelectorAll('.af-stage[data-maf]:not([data-init])'), function (st) { st.className = 'af-stage af-fail'; });
      }
      window.__rptInitPendingStages = initPending;
      window.addEventListener('beforeprint', initAll);
      if (window.$3Dmol) initPending();
      else {
        var s = document.createElement('script');
        s.src = 'https://3Dmol.org/build/3Dmol-min.js';
        s.onload = initPending; s.onerror = failAll;
        (document.head || document.documentElement).appendChild(s);
      }
    })();
    </script>` : ''

  // v1.10 同源证据：一致性矩阵（下三角）与序列归属表（确定性数据，模板直出）
  // v2.12 ④：矩阵对齐修复 — 表头列/行标/数值统一居中（此前行标沿用 th 表头样式：
  // uppercase/字距/粗底边，数值右对齐 → 表头与内容错位观感）；行标改用正文风格，
  // 对角线单元格淡底标记，角格给出阅读方向提示
  const pairMap = new Map<string, number>()
  for (const p of relation.homologPairs ?? []) pairMap.set(`${p.a}|${p.b}`, p.identity)
  const getPair = (a: string, b: string) => pairMap.get(`${a}|${b}`) ?? pairMap.get(`${b}|${a}`)
  const matrixHtml = hasIdentityMatrix ? `
  <section class="sec" id="homolog">
    <h2>${secHead(noIdentity, isHomologousBatch ? '家族序列一致性矩阵' : '序列一致性', 'Pairwise Identity')}</h2>
    <p class="note">系统对全部靶点全长序列两两比对（种子-对角链算法）得到的确定性一致性估计；≥40% 判为家族级同源，任一成员的已有结构可直接指导其他成员的构建设计。行与列为同一组靶点（读法：行靶点 与 列靶点 的一致性，对角线为自身）。</p>
    <div class="tbl-wrap"><table class="idm">
      <thead><tr><th class="idm-corner">一致性 ↘</th>${targets.map(t => `<th>${esc(t.uniprotId ?? t.label)}</th>`).join('')}</tr></thead>
      <tbody>${targets.map((row, i) => `<tr><th class="idm-rowhead">${esc(row.uniprotId ?? row.label)}</th>${targets.map((col, j) => {
        if (i === j) return '<td class="num idm-diag">—</td>'
        if (j < i) {
          const v = getPair(row.uniprotId ?? row.label, col.uniprotId ?? col.label)
          return `<td class="num idm-val">${v != null ? v + '%' : '—'}</td>`
        }
        return '<td class="num" style="color:#d6d3d1">·</td>'
      }).join('')}</tr>`).join('')}</tbody>
    </table></div>
  </section>` : ''

  const attrKindText: Record<SequenceAttribution['kind'], string> = {
    construct: '客户构建（已并入评估）',
    homolog: '同源家族成员',
    antibody: '抗体序列（背景证据）',
    unmatched: '未匹配',
  }
  const attrRows = (input.sequenceAttribution ?? []).map((a, i) => `
      <tr>
        <td class="num">${i + 1}</td>
        <td class="t-title">${esc(a.header ? a.header.slice(0, 60) : '（未命名序列）')}</td>
        <td class="num">${a.length}</td>
        <td>${a.uniprotId ? `<a href="https://www.uniprot.org/uniprotkb/${a.uniprotId}" target="_blank" rel="noopener">${a.uniprotId}</a>` : '—'}</td>
        <td class="num">${a.identity != null ? a.identity + '%' : '—'}</td>
        <td>${esc(attrKindText[a.kind])}${a.kind === 'construct' && a.start != null && a.end != null ? `（全长 ${a.start}-${a.end}）` : ''}</td>
      </tr>`).join('')
  const attributionHtml = input.sequenceAttribution?.length ? `
  <section class="sec" id="attribution">
    <h2>${secHead(noAttribution, '评估表序列归属', 'Sequence Attribution')}</h2>
    <p class="note">评估表中每条序列经系统比对后的去向：同一靶点（一致性 ≥85%）的序列已作为客户构建并入对应靶点的评估（构建边界分析）；同源（35–85%）标注为家族成员；抗体序列作为背景证据；其余为未匹配。</p>
    <div class="tbl-wrap"><table>
      <thead><tr><th>#</th><th>序列</th><th>长度(aa)</th><th>最佳匹配</th><th>一致性</th><th>归属</th></tr></thead>
      <tbody>${attrRows}</tbody>
    </table></div>
  </section>` : ''

  // v1.22 共有结构（同一 PDB 覆盖多个输入 UniProt — 复合物/共结晶/融合构建）
  // v2.11：章节重制 — 提前至合并分析之后直出（批次级核心结构证据），绿色突出面板
  // （与单独评估互作复合物「共有结构」同一设计语言：◈ 徽标 + 覆盖靶点计数 + 全量表）；
  // 批次无共有时为空态说明（callout 琥珀块 — 有无共同 PDB 条目同样是关键证据）。
  const SHARED_PDB_COLGROUP = `<colgroup>
    <col style="width:74px"><col style="width:62px"><col style="width:64px"><col style="width:172px"><col><col style="width:86px"><col style="width:72px">
  </colgroup>`
  // v1.24：全部展示（移除前 60 截断）；v2.53 行携带 data-m/-res/-date/-id +
  // 表标 data-tbl="shared"（TABLE_FILTER_JS 消费 — pdb 类排序：分辨率/日期/PDB ID + 方法/阈值筛选）
  const sharedRows = sharedStructures.map(s => {
    const covChips = s.coverage.map(c =>
      `<span class="cov-chip" title="${esc(c.proteinName)}">${esc(c.uniprotId)}${c.chainRanges ? `<span class="cov-rng">${esc(c.chainRanges)}</span>` : ''}</span>`,
    ).join(' ')
    const lit = s.pubmedId
      ? `<a href="https://pubmed.ncbi.nlm.nih.gov/${s.pubmedId}/" target="_blank" rel="noopener">${s.pubmedId}</a>`
      : '—'
    const mKey = s.isXray ? 'xray' : s.isCryoem ? 'cryoem' : s.isNmr ? 'nmr' : 'other'
    return `
    <tr data-m="${mKey}" data-res="${s.resolution ?? ''}" data-date="${esc(s.releaseDate.slice(0, 10))}" data-id="${s.pdbId}">
      <td class="td-id"><a href="https://www.rcsb.org/structure/${s.pdbId}" target="_blank" rel="noopener">${s.pdbId}</a></td>
      <td><span class="mth mth-${s.isXray ? 'xray' : s.isCryoem ? 'cryoem' : s.isNmr ? 'nmr' : 'other'}">${s.isXray ? 'X-ray' : s.isCryoem ? 'Cryo-EM' : s.isNmr ? 'NMR' : esc(s.method.slice(0, 8))}</span></td>
      <td class="num">${s.resolution != null ? s.resolution.toFixed(2) : '—'}</td>
      <td class="cov-cells"><span class="sh-cnt" title="该 PDB 覆盖 ${s.targetCount} 个输入靶点">×${s.targetCount}</span>${covChips}</td>
      <td class="t-title" title="${esc(s.title)}">${esc(s.title.slice(0, 70))}</td>
      <td class="num">${esc(s.releaseDate.slice(0, 10))}</td>
      <td class="td-id">${lit}</td>
    </tr>`
  }).join('')
  // 各靶点被共有结构覆盖的计数（批次关联证据面 — chips 直读）
  const sharedCountByUniprot = new Map<string, number>()
  for (const s of sharedStructures) for (const c of s.coverage) sharedCountByUniprot.set(c.uniprotId, (sharedCountByUniprot.get(c.uniprotId) ?? 0) + 1)
  const sharedMaxTargets = sharedStructures.length ? sharedStructures[0].targetCount : 0
  const sharedCovSumChips = targets
    .filter(t => t.uniprotId && sharedCountByUniprot.has(t.uniprotId))
    .map(t => `<span class="sh-cov-chip" title="${esc(t.proteinName)}">${esc(t.uniprotId!)}<i>${sharedCountByUniprot.get(t.uniprotId!)}</i></span>`)
    .join('')
  const sharedEmptyHint = relation.relationType === 'complex' || relation.relationType === 'antibody-antigen'
    ? '复合物/抗体-抗原类批次缺少共结晶先例 — 组装路线需从共表达或体外组装验证开始（见合并评估分析的整合实验方案）。'
    : relation.relationType === 'homologous'
      ? '同源家族批次通常以单一成员独立解析为主，属正常情况（家族证据互用见合并评估分析）。'
      : '各靶点结构解析相互独立，无共同结构先例可借用。'
  // ── v2.12 ③：复合物评估文献列表 = 共有结构文献（PMID 去重 + 关联 PDB）────
  // 首页（复合物评估）只呈现共有结构的文献 — 复合物级证据与复合物级文献同章节；
  // 各靶点自身的文献明细已移至其单独报告页。元数据取自各靶点文献检索命中
  // （PDB 主引文），未命中者以 PDB 条目行呈现（标题/期刊未知 — 如实标注）。
  const sharedLitByPmid = new Map<string, { meta?: LiteratureItem; structures: SharedStructure[] }>()
  for (const s of sharedStructures) {
    if (!s.pubmedId) continue
    const key = String(s.pubmedId)
    const entry = sharedLitByPmid.get(key) ?? { structures: [] }
    entry.structures.push(s)
    sharedLitByPmid.set(key, entry)
  }
  for (const t of targets) {
    for (const l of t.literature) {
      if (!l.pmid) continue
      const key = String(l.pmid)
      const entry = sharedLitByPmid.get(key)
      if (entry && !entry.meta) entry.meta = l
    }
  }
  const sharedLitRows = [...sharedLitByPmid.entries()]
    .sort((a, b) => (Number(b[1].meta?.year ?? 0) || 0) - (Number(a[1].meta?.year ?? 0) || 0) || Number(b[0]) - Number(a[0]))
    .map(([pmid, { meta, structures }]) => `
    <tr>
      <td class="td-id"><a href="https://pubmed.ncbi.nlm.nih.gov/${pmid}/" target="_blank" rel="noopener">${esc(pmid)}</a></td>
      <td class="t-title">${meta ? esc(meta.title.slice(0, 110)) : '（未检索到该文献元数据 — 详见关联 PDB 条目主引文）'}</td>
      <td class="t-title">${meta ? esc(meta.journal.slice(0, 30)) : '—'}</td>
      <td class="num">${meta ? esc(String(meta.year || '—')) : '—'}</td>
      <td class="cov-cells">${structures.map(s => `<a class="cov-chip" style="text-decoration:none" href="https://www.rcsb.org/structure/${s.pdbId}" target="_blank" rel="noopener" title="${esc(s.title)}">${s.pdbId}</a>`).join(' ')}</td>
    </tr>`).join('')
  const sharedLitHtml = sharedLitByPmid.size ? `
    <h3>共有结构文献（${sharedLitByPmid.size} 篇 · PMID 去重）</h3>
    <p class="note">复合物评估引用的文献清单 — 仅列共有结构（同一 PDB 覆盖 ≥2 个输入靶点）的主引文，按年份降序；「关联共有结构」列给出该文献对应的 PDB 条目。各靶点自身的文献明细见其单独报告页。</p>
    <div class="tbl-wrap"><table>
      <colgroup><col style="width:76px"><col><col style="width:150px"><col style="width:52px"><col style="width:190px"></colgroup>
      <thead><tr><th>PMID</th><th>标题</th><th>期刊</th><th>年份</th><th>关联共有结构</th></tr></thead>
      <tbody>${sharedLitRows}</tbody>
    </table></div>` : ''
  const sharedStructuresHtml = `
  <section class="sec" id="shared-pdbs">
    <h2>${secHead(noShared, `共有结构（${sharedStructures.length}）`, 'Shared Structures')}</h2>
    ${sharedStructures.length ? `
    <div class="sh-hero">
      <div class="sh-hero-head"><span class="sh-ico" aria-hidden="true">◈</span>共有结构 <b>${sharedStructures.length}</b> 个<span class="sh-hero-sub">同一 PDB 条目覆盖 ≥2 个输入靶点 — 复合物亚基共结晶 / 抗体-抗原复合物 / 融合构建等物理关联的直接结构证据；单条最多覆盖 <b>${sharedMaxTargets}</b> 个靶点</span></div>
      ${sharedCovSumChips ? `<div class="sh-cov-sum">${sharedCovSumChips}</div>` : ''}
    </div>
    <p class="note">按覆盖靶点数降序、分辨率升序排列；「覆盖靶点」列按输入顺序列出该 PDB 引用的各 UniProt 及其链范围（UniProt 残基编号），×N 为覆盖靶点数。各靶点单独报告页中的同一 PDB 亦带 ◈ 徽标，可互相印证。</p>
    <div class="tbl-wrap"><table class="tbl-data" data-tbl="shared">
      ${SHARED_PDB_COLGROUP}
      <thead><tr><th>PDB ID</th><th>方法</th><th class="num">分辨率 (Å)</th><th>覆盖靶点</th><th>标题</th><th class="num">释放日期</th><th>文献</th></tr></thead>
      <tbody>${sharedRows}</tbody>
    </table></div>
    ${sharedLitHtml}` : `
    <div class="callout callout-amber"><b>批次内无共有结构 — 各靶点没有共同 PDB 条目</b>本批次各输入靶点未出现同一 PDB 条目同时覆盖多个 UniProt 的情况，即没有复合物共结晶 / 共组装的既有结构先例，复合物评估亦无共有文献可引。${esc(sharedEmptyHint)}各靶点独立的 PDB 结构明细见其单独报告页（刊头靶点卡片进入）。</div>`}
  </section>`

  // v1.25：聚集形式（寡聚态）— 不再单独成章：徽标融入刊头各靶点卡片，证据链以折叠形式挂在对比矩阵下方
  const oligoTargets = targets.filter(t => t.oligomer)
  const oligoBadgeOf = (c: string) => c === 'monomer' ? '#047857' : c === 'hetero-complex' ? '#b45309' : c === 'homo-oligomer' ? '#065f46' : '#78716c'
  const oligoCatOf = (c: string) => c === 'monomer' ? '单体' : c === 'homo-oligomer' ? '同源寡聚体' : c === 'hetero-complex' ? '异源复合物' : '未知'
  const oligoFoldHtml = oligoTargets.length ? `
    <details class="fold">
      <summary>各靶点聚集形式判定与证据链（${oligoTargets.length} 个靶点 · 判定已计入各靶点评分，分析见合并评估分析章节）</summary>
      ${oligoTargets.map(t => {
      const o = t.oligomer!
      return `
      <div class="oligo-card">
        <div class="oligo-head">
          <span class="tgt-inline">${esc(t.nspLabel ? `${t.proteinName} ${t.nspLabel}` : t.proteinName)}${t.uniprotId ? `（${t.uniprotId}）` : ''}</span>
          <span class="oligo-badge" style="background:${oligoBadgeOf(o.category)}">${esc(oligoCatOf(o.category))}</span>
          ${o.stoichiometry ? `<span class="oligo-stoich">${esc(o.stoichiometry)}</span>` : ''}
          <span class="oligo-conf">置信度：${esc(describeOligoConfidence(o.confidence))}</span>
        </div>
        <p class="oligo-summary">${esc(o.summary)}</p>
        ${t.scores.oligomerAdjust ? `<p class="oligo-summary" style="font-size:12px">评分调整：X-ray ${t.scores.oligomerAdjust.xray > 0 ? '+' : ''}${t.scores.oligomerAdjust.xray} / Cryo-EM ${t.scores.oligomerAdjust.cryoem > 0 ? '+' : ''}${t.scores.oligomerAdjust.cryoem} / NMR ${t.scores.oligomerAdjust.nmr > 0 ? '+' : ''}${t.scores.oligomerAdjust.nmr} — ${esc(t.scores.oligomerAdjust.note)}</p>` : ''}
        ${t.mwAugment?.applicable ? `<p class="oligo-summary" style="font-size:12px">分子量增重：单体 ~${t.mwAugment.monomerKda} kDa${t.mwAugment.assemblyKda != null ? ` → 装配 ~${t.mwAugment.assemblyKda} kDa（${t.mwAugment.assemblyPath === 'complex' ? '已有复合物结构' : t.mwAugment.assemblyPath === 'oligomer' ? '自身寡聚' : t.mwAugment.assemblyPath === 'homolog-complex' ? '同源复合物推断（BLAST）' : t.mwAugment.assemblyPath === 'partner' ? (t.mwAugment.assemblyEvidence === 'complex' ? '互作伙伴推断（复合物结构支持）' : t.mwAugment.assemblyEvidence === 'homolog' ? '互作伙伴推断（同源复合物结构支持）' : '互作伙伴推断（无结构支持，低可信）') : '互作伙伴推断'}）` : '（无生物装配路径）'}${t.scores.mwAugmentAdjust ? `；Cryo-EM 调整 ${t.scores.mwAugmentAdjust.cryoem > 0 ? '+' : ''}${t.scores.mwAugmentAdjust.cryoem} — ${esc(t.scores.mwAugmentAdjust.note)}` : ''}${(t.mwAugment.homologComplexes ?? []).length ? `<br>同源复合物：${(t.mwAugment.homologComplexes ?? []).map(h => `${h.pdbId}（identity ${Math.round(h.identity)}%，靶点换算 ~${h.estimatedKda} kDa）`).join('、')}` : (t.mwAugment.homologSearchNote ? `<br>${esc(t.mwAugment.homologSearchNote)}` : '')}</p>` : ''}
        ${o.evidence.length ? `<div class="oligo-ev">${o.evidence.map(e => `<div class="oligo-ev-line"><span class="oligo-ev-src">${esc(describeEvidenceSource(e.source))}</span><span class="oligo-ev-ref">${esc(e.ref)}</span><span class="oligo-ev-text">${esc(e.text)}</span></div>`).join('')}</div>` : ''}
      </div>`
      }).join('')}
    </details>` : ''

  // v2.8 报告格式优化：靶点卡 → mini 仪表盘（补结构/覆盖率/同源/文献关键数字，
  // 多靶点批次可不经对比矩阵直接在刊头扫读各靶点研究现状）
  // v2.12：靶点卡整体可点 — 点击进入该靶点的单独报告页（综述/简报/单独结构同页；
  // 卡内 UniProt 链接除外 — 点击仍跳 UniProt）；卡底「单独报告 →」为明确入口提示
  // v2.26：GPCR 受体主导批次 — 首页卡片仅列 G 蛋白伴侣（受体即首页主体，不再出卡片）；
  // 其余批次保持全靶点卡片
  const targetMeta = (gpcrBatch ? gpcrBatch.gproteins : targets).map(t => {
    const o = t.oligomer
    const ms = t.methodStats
    return `
    <div class="tgt-card" data-goto="target-${keyOf(t)}" title="查看 ${esc(t.nspLabel ? `${t.proteinName} ${t.nspLabel}` : t.proteinName)} 的单独报告页（综述 / 基本信息 / 预测结构 / PDB / 同源 / 文献）">
      <div class="tgt-name">${esc(t.nspLabel ? `${t.proteinName} ${t.nspLabel}` : t.proteinName)}${t.uniprotId ? ` <a href="https://www.uniprot.org/uniprotkb/${t.uniprotId}" target="_blank" rel="noopener">${t.uniprotId}</a>` : t.targetIdentity ? ` <span class="tgt-idsrc" title="${esc(t.targetIdentity.note ?? t.targetIdentity.sourceLabel)}">${esc(t.targetIdentity.sourceLabel)}${t.targetIdentity.identity != null ? ` ${Math.round(t.targetIdentity.identity)}%` : ''}</span>` : ''}</div>
      <div class="tgt-meta">${esc(t.geneNames.slice(0, 3).join('/') || '—')} · ${esc(t.organism || '—')} · ${t.sequenceLength} aa</div>
      ${o ? `<div class="tgt-oligo"><span class="oligo-badge" style="background:${oligoBadgeOf(o.category)}">${esc(oligoCatOf(o.category))}</span>${o.stoichiometry ? `<span class="oligo-stoich">${esc(o.stoichiometry)}</span>` : ''}<span class="tgt-oligo-conf">置信度${esc(describeOligoConfidence(o.confidence))}</span></div>` : ''}
      <div class="tgt-score">总体 <b>${t.scores.overall.score}</b>/10 · ${esc(t.scores.overall.rating)}${t.scores.llmAdjust ? `<span class="tgt-ai-adj${t.scores.llmAdjust.applied ? '' : ' keep'}" title="${esc(t.scores.llmAdjust.notes.overall || 'AI 复核意见')}">AI 复核${t.scores.llmAdjust.applied ? (() => { const d = Math.trunc(Number(t.scores.llmAdjust!.overall)) || 0; return d > 0 ? ` +${d}` : d < 0 ? ` −${Math.abs(d)}` : '' })() : '维持'}</span>` : ''}${t.scores.oligomerAdjust ? '<span class="tgt-oligo-adj">含聚集形式调整</span>' : ''}</div>
      <div class="tgt-stats">
        <span>PDB <b>${t.directPdbs.length}</b></span>
        <span>${ms.bestResolution != null ? `最佳 <b>${ms.bestResolution.toFixed(2)}Å</b>` : '无直接结构'}</span>
        <span>覆盖 <b>${t.coveragePercent}%</b></span>
        <span>同源 <b>${t.blastHits.length}</b></span>
        <span>文献 <b>${t.literature.length}</b></span>
      </div>
      <div class="tgt-open">单独报告页 →</div>
    </div>`
  }).join('')

  // ── v2.11：批次核心结论速览（At a Glance）— 与单靶点报告同款版式（glance-hero
  // 大数字 + glance-tiles 关键指标卡 + glance-foot 阅读路径），多靶点批次同样开卷
  // 即得批次级结论；hero 取各靶点总体评分均值（副行标注区间 — 批次短板一目了然）。
  const overallScores = targets.map(t => t.scores.overall.score)
  const avgScore = overallScores.reduce((s, v) => s + v, 0) / Math.max(1, overallScores.length)
  const minScore = Math.min(...overallScores)
  const maxScore = Math.max(...overallScores)
  const avgScoreColor = (v: number) => (v >= 7 ? '#047857' : v >= 4 ? '#b45309' : '#92400e')
  const ratingOf = (v: number) => v >= 9 ? 'Excellent·优秀' : v >= 7 ? 'Good·良好' : v >= 5 ? 'Fair·中等' : 'Poor·困难'
  const pdbTotal = targets.reduce((s, t) => s + t.directPdbs.length, 0)
  const msAgg = targets.reduce((acc, t) => ({
    xray: acc.xray + t.methodStats.xrayCount, cryoem: acc.cryoem + t.methodStats.cryoemCount, nmr: acc.nmr + t.methodStats.nmrCount,
  }), { xray: 0, cryoem: 0, nmr: 0 })
  const bestResAll = targets.map(t => t.methodStats.bestResolution).filter((v): v is number => v != null)
  const bestRes = bestResAll.length ? Math.min(...bestResAll) : null
  const blastTotal = targets.reduce((s, t) => s + t.blastHits.length, 0)
  const litFromPdb = targets.reduce((s, t) => s + t.literature.filter(l => l.fromPdb).length, 0)
  const oligoDist = (() => {
    const m = new Map<string, number>()
    for (const t of targets) if (t.oligomer) m.set(oligoCatOf(t.oligomer.category), (m.get(oligoCatOf(t.oligomer.category)) ?? 0) + 1)
    return [...m.entries()].map(([k, c]) => `${k} ${c}`).join(' · ')
  })()
  const relConfZh = relation.confidence === 'high' ? '高' : relation.confidence === 'medium' ? '中' : '低'
  const glanceHtml = `
  <section class="glance" id="glance" aria-label="批次核心结论速览">
    <div class="glance-kicker">Key Findings · 批次核心结论速览</div>
    <div class="glance-grid">
      <div class="glance-hero">
        <div class="glance-score" style="color:${avgScoreColor(avgScore)}">${avgScore.toFixed(1)}<span>/10</span></div>
        <div class="glance-hero-label">批次平均可行性 · ${esc(ratingOf(avgScore))}</div>
        <span class="glance-rating" style="background:${avgScoreColor(avgScore)}">各靶点区间 ${minScore}–${maxScore}</span>
      </div>
      <div class="glance-tiles">
        <div class="glance-tile"><div class="gt-label">靶点关系</div><div class="gt-value">${esc(relName)}</div><div class="gt-sub">置信度 ${relConfZh} · ${targets.length} 个靶点合并评估 · 判定依据见分析章节</div></div>
        <div class="glance-tile ${sharedStructures.length === 0 ? 'gt-warn' : 'gt-shared'}"><div class="gt-label">共有结构</div><div class="gt-value">${sharedStructures.length} 个</div><div class="gt-sub">${sharedStructures.length ? `同一 PDB 覆盖 ≥2 个靶点 — 复合物/共结晶证据（详见共有结构章节）` : '批次内无共同 PDB 条目 — 无共组装先例'}</div></div>
        <div class="glance-tile ${pdbTotal === 0 ? 'gt-warn' : ''}"><div class="gt-label">PDB 结构合计</div><div class="gt-value">${pdbTotal} 个</div><div class="gt-sub">${pdbTotal ? `X-ray ${msAgg.xray} · Cryo-EM ${msAgg.cryoem} · NMR ${msAgg.nmr}${bestRes != null ? ` · 最佳 ${bestRes.toFixed(2)}Å` : ''}` : '全部靶点均无直接结构'}</div></div>
        <div class="glance-tile ${blastTotal === 0 ? 'gt-warn' : ''}"><div class="gt-label">同源参考</div><div class="gt-value">${blastTotal} 个</div><div class="gt-sub">${blastTotal ? 'BLAST/序列检索命中 — 无直接结构靶点的先例参考' : '无同源命中 — 结构先例证据缺位'}</div></div>
        <div class="glance-tile"><div class="gt-label">关键文献</div><div class="gt-value">${litTotal} 篇</div><div class="gt-sub">各靶点分检${litFromPdb ? ` · 含结构解析文献 ${litFromPdb} 篇` : ''}</div></div>
        ${oligoDist ? `<div class="glance-tile"><div class="gt-label">聚集形式</div><div class="gt-value">${esc(oligoDist)}</div><div class="gt-sub">判定已计入各靶点评分 · 证据链见矩阵下折叠</div></div>` : ''}
      </div>
    </div>
    <div class="glance-foot">阅读路径：本页（复合物评估）先读「${noLlm} 合并评估分析」与「${noShared} 共有结构」（复合物级结论与共同结构证据/文献）→ 点击刊头靶点卡片或目录「靶点单独报告」进入各靶点单独评估报告页（与单靶点评估报告同格式：评估分析 / 可行性评分 / PDB 结构与文献全量展开 / 同源 / 客户实验数据），页内「← 返回报告首页」随时回到本页；打印时全部页面依序输出。</div>
  </section>`

  // v2.8 报告格式优化：对比矩阵扩列（同源结构/文献/寡聚态）+ 总体分附评级 —
  // 多靶点批次的一张表即可横向比较全部关键可行性指标
  const matrixRows = targets.map(t => `
    <tr>
      <td class="td-id">${t.uniprotId ? `<a href="https://www.uniprot.org/uniprotkb/${t.uniprotId}" target="_blank" rel="noopener">${t.uniprotId}</a>` : '—'}</td>
      <td class="t-title">${esc(t.nspLabel ? `${t.proteinName} ${t.nspLabel}` : t.proteinName)}</td>
      <td class="num">${t.directPdbs.length}</td>
      <td class="num">${t.methodStats.bestResolution != null ? t.methodStats.bestResolution.toFixed(2) + 'Å' : '—'}</td>
      <td class="num">${t.coveragePercent}%</td>
      <td>${t.oligomer ? `<span class="oligo-badge" style="background:${oligoBadgeOf(t.oligomer.category)}">${esc(oligoCatOf(t.oligomer.category))}</span>` : '<span class="mtx-dash">—</span>'}</td>
      <td class="num">${t.blastHits.length}</td>
      <td class="num">${t.literature.length}</td>
      <td class="num">${t.scores.xray.score}</td>
      <td class="num">${t.scores.cryoem.score}</td>
      <td class="num">${t.scores.nmr.score}</td>
      <td class="num"><b>${t.scores.overall.score}</b><span class="mtx-rating">${esc(t.scores.overall.rating)}</span></td>
    </tr>`).join('')

  // v2.13：客户实验数据分组展示（与单靶点报告同版 — gel/sec/other 分组）；图片带
  // data-fig 池索引，各靶点单独评估页的同章节经水合脚本复用同一份内嵌数据。
  const figGroupDefs: Array<{ kind: 'gel' | 'sec' | 'other'; title: string; en: string }> = [
    { kind: 'gel', title: 'SDS-PAGE 胶图', en: 'SDS-PAGE' },
    { kind: 'sec', title: 'SEC 分子筛色谱图', en: 'SEC Profile' },
    { kind: 'other', title: '其他实验图', en: 'Others' },
  ]
  const vlmCount = embedded.filter(e => e.meta.vlmKind).length
  const figIdxOf = new Map(embedded.map((e, i) => [e, i]))
  const figGroups = figGroupDefs
    .map(g => ({ ...g, items: embedded.filter(e => e.meta.kind === g.kind) }))
    .filter(g => g.items.length > 0)
  let homeFigNo = 0
  const figHtml = embedded.length ? `
  <section class="sec" id="assets">
    <h2>${secHead(noAssets, `客户实验数据（${embedded.length} 张）`, `${figGroups.map(g => `${g.en} × ${g.items.length}`).join(' · ')}${vlmCount ? ' · AI 识别' : ''}`)}</h2>
    ${figGroups.map(g => `
    <h3 class="fig-group">${g.title}<span class="fig-group-count">${g.items.length} 张</span></h3>
    <div class="fig-grid">
    ${g.items.map((item) => {
      const { meta, dataUri } = item
      homeFigNo += 1
      const figIdx = figIdxOf.get(item) ?? -1
      return `
      <figure class="fig" data-fig="${figIdx}">
        ${dataUri ? `<img src="${dataUri}" alt="${esc(meta.caption)}" loading="lazy">` : `<div class="fig-missing">图片体积超出内嵌预算，请通过系统查看</div>`}
        <figcaption><span class="fig-tag fig-${meta.kind}">${meta.kind === 'gel' ? 'SDS-PAGE' : meta.kind === 'sec' ? 'SEC' : '图'}</span>${meta.vlmKind ? '<span class="fig-tag fig-ai">AI 视觉识别</span>' : ''}图 ${homeFigNo}：${esc(meta.caption)}</figcaption>
      </figure>`
    }).join('')}
    </div>`).join('')}
    <p class="note">客户实验数据为批次共享 — 各靶点单独评估页的「客户实验数据」章节展示同一组图（图片池复用，全批次只内嵌一次）。</p>
  </section>` : ''

  // v1.15：评估表 AI 解析要点（LLM 失败时作为兜底证据；正常时作为可溯源原始要点）
  // v2.0：配体研究数据（批次共享，取首个有数据的靶点）
  const batchLigands = targets.find(t => (t.ligands?.length ?? 0) > 0)?.ligands ?? []
  // v2.7.6 ⑤：配体卡补 2D 结构式 —— 渲染前兜底充实（v2.7 前旧作业 detail 缺失补全；
  // PNG-only 详情回补 SVG 矢量版，磁盘缓存命中零网络开销）
  // v2.13：各靶点单独评估页均渲染各自配体章节 — 兜底充实覆盖全部靶点的配体
  // （同一批次输入一致，缓存命中时零网络开销）
  await Promise.all(targets.flatMap(t => (t.ligands ?? []).filter(l => l.ok)).map(async l => {
    try { await ensureLigand2dVector(l) } catch { /* 充实失败不阻塞渲染（保留既有字段） */ }
  }))
  const ligandCard = (l: LigandResolution): string => {
    if (!l.ok) return `
    <div class="lig-card lig-fail">
      <div class="lig-head"><span class="lig-id lig-id-fail">?</span><span class="lig-name">${esc(l.raw.length > 40 ? l.raw.slice(0, 39) + '…' : l.raw)}</span></div>
      <div class="lig-meta"><span>未能归一 — ${esc(l.error ?? '未知原因')}</span></div>
    </div>`
    const d = l.detail
    const structFig = ligStructFig(l)
    const propsHtml = d ? ligDetailProps(d) : ''
    const identFold = ligIdentFold(l)
    const best = l.structures.find(s => s.resolution != null)?.resolution
    // v2.7.6：PubChem 已识别但 PDB 无对应组分 → CID 详情卡（与单靶点报告同版：2D 结构式 + 性质 + 标识符折叠）
    if (!l.compId) {
      const pc = l.pubchem
      const cid = d?.cid ?? pc?.cid
      return `
      <div class="lig-card">
        <div class="lig-main">
        ${structFig}
        <div class="lig-info">
        <div class="lig-head">
          ${cid
            ? `<a class="lig-id lig-id-pc" href="https://pubchem.ncbi.nlm.nih.gov/compound/${cid}" target="_blank" rel="noopener" title="在 PubChem 查看化合物详情">CID ${cid}</a>`
            : `<span class="lig-id lig-id-pc">已识别</span>`}
          <span class="lig-name">${esc(l.name || l.raw)}</span>
          <span class="lig-src">输入「${esc(l.raw.length > 24 ? l.raw.slice(0, 23) + '…' : l.raw)}」· ${esc(strategyZh(l.strategy))}${l.source === 'eval-table' ? ' · 评估表' : l.source === 'file' ? ' · 文件' : ''}</span>
        </div>
        <div class="lig-meta">
          <span>分子式 <b>${esc(l.formula || '—')}</b></span>
          ${l.weight != null ? `<span>MW <b>${l.weight.toFixed(1)}</b></span>` : ''}
        </div>
        ${propsHtml ? `<div class="lig-props">${propsHtml}</div>` : ''}
        ${(d?.iupacName ?? pc?.iupacName) ? `<div class="lig-iupac">IUPAC 名 ${esc((d?.iupacName ?? pc?.iupacName) ?? '')}</div>` : ''}
        ${identFold}
        </div>
        </div>
        <div class="lig-pdbs lig-none">PDB 化学组分库无对应条目 — 已通过 PubChem 识别，点击 CID 查看化合物详情</div>
      </div>`
    }
    return `
    <div class="lig-card">
      <div class="lig-main">
      ${structFig}
      <div class="lig-info">
      <div class="lig-head">
        <span class="lig-id">${esc(l.compId)}</span>
        <span class="lig-name">${esc(l.name || l.raw)}</span>
        <span class="lig-src">输入「${esc(l.raw.length > 24 ? l.raw.slice(0, 23) + '…' : l.raw)}」· ${esc(strategyZh(l.strategy))}${l.source === 'eval-table' ? ' · 评估表' : l.source === 'file' ? ' · 文件' : ''}</span>
      </div>
      <div class="lig-meta">
        <span>分子式 <b>${esc(l.formula || '—')}</b></span>
        ${l.weight != null ? `<span>MW <b>${l.weight.toFixed(1)}</b></span>` : ''}
        <span>含该配体结构 <b>${l.totalStructures}</b> 个</span>
        ${best != null ? `<span>最佳分辨率 <b>${best.toFixed(2)} Å</b></span>` : ''}
      </div>
      ${propsHtml ? `<div class="lig-props">${propsHtml}</div>` : ''}
      ${(d?.iupacName ?? l.pubchem?.iupacName) ? `<div class="lig-iupac">IUPAC 名 ${esc((d?.iupacName ?? l.pubchem?.iupacName) ?? '')}</div>` : ''}
      ${identFold}
      </div>
      </div>
      ${l.structures.length ? `
      <div class="lig-pdbs">${l.structures.slice(0, 12).map(s => `<a class="${s.alsoTarget ? 'lig-also' : ''}" href="https://www.rcsb.org/structure/${s.pdbId}" target="_blank" rel="noopener" title="${esc(s.title)}${s.resolution != null ? ` · ${s.resolution}Å` : ''}${s.alsoTarget ? ' · 本靶点直接结构' : ''}">${s.pdbId}${s.resolution != null ? ` <i>${s.resolution.toFixed(1)}</i>` : ''}</a>`).join('')}${l.totalStructures > 12 ? `<span class="lig-more">+${l.totalStructures - 12}</span>` : ''}</div>` : `<div class="lig-pdbs lig-none">暂无含该配体的 PDB 结构记录</div>`}
    </div>`
  }
  const ligandsHtml = batchLigands.length ? `
  <section class="sec" id="ligands">
    <h2>${secHead(noLigands, `配体研究数据（${batchLigands.filter(l => l.ok).length}/${batchLigands.length}）`, 'Ligands')}</h2>
    <p class="note">非标准配体输入经多策略归一（直接 ID / 别名表 / PDBe Solr 检索 / PubChem / AI 兜底）映射为 RCSB 化学组分 ID；结构列表来自 PDBe 字段化检索（含该配体的 PDB 条目，按分辨率排序），绿底标记同时为批次内靶点直接结构的条目；计算性质与 2D 化学结构式来自 PubChem（SVG 矢量优先，点击可放大）。抗体/蛋白类试剂（scFv、Fab、抗体克隆等）不属于小分子配体，已在识别阶段排除。</p>
    <div class="lig-grid">${batchLigands.map(ligandCard).join('')}
    </div>
  </section>` : ''

  const ins = input.insights
  const insightsHtml = ins && (ins.goals?.length || ins.scientificQuestions?.length || ins.experimentalSummary || ins.sequenceNotes || ins.homologs || ins.keyConcerns?.length) ? `
  <section class="sec" id="insights">
    <h2>${secHead(noInsights, '客户评估表要点与回应', 'Form Insights &amp; Q/A')}</h2>
    <p class="note">由 AI 从上传的评估表中结构化提取的关键要点（忠实原文），并由 LLM 基于批次数据逐条回应 — 客户目标逐条附「评估回应」，待解决科学问题逐条附「评估回答」。</p>
    ${ins.goals?.length ? `<h3>客户目标（含评估回应）</h3><ul>${ins.goals.map((g, i) => {
      const a = qa.goals[i + 1]
      return `<li>${esc(g)}${a ? `<div class="qa-ans"><span class="qa-tag">评估回应</span>${renderMarkdown(a, 2)}</div>` : ''}</li>`
    }).join('')}</ul>` : ''}
    ${ins.scientificQuestions?.length ? `<h3>待解决科学问题（含评估回答）</h3><ol>${ins.scientificQuestions.map((q, i) => {
      const a = qa.questions[i + 1]
      return `<li>${esc(q)}${a ? `<div class="qa-ans"><span class="qa-tag qa-tag-q">评估回答</span>${renderMarkdown(a, 2)}</div>` : ''}</li>`
    }).join('')}</ol>${qaMissingNote ? `<p class="note">${esc(qaMissingNote)}</p>` : ''}` : ''}
    ${qaRawFallback ? `<h3>评估表问题回应</h3>${renderMarkdown(qaRawFallback, 1)}` : ''}
    ${ins.experimentalSummary ? `<h3>实验数据要点</h3><blockquote>${esc(ins.experimentalSummary)}</blockquote>` : ''}
    ${ins.sequenceNotes ? `<h3>构建 / 序列说明</h3><blockquote>${esc(ins.sequenceNotes)}</blockquote>` : ''}
    ${ins.homologs ? `<h3>同源 / 参考信息</h3><blockquote>${esc(ins.homologs)}</blockquote>` : ''}
    ${ins.keyConcerns?.length ? `<h3>风险关注点</h3><ul>${ins.keyConcerns.map(c => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
  </section>` : ''

  // ── v2.13 ②：各靶点单独评估报告视图页 ─────────────────────────────────────
  // 每个靶点一个完整「单独评估报告」页：直接复用 renderSingleReportBody（单靶点报告
  // 同款 header + glance + 目录 + 评估分析/评分/配体/PDB/同源/文献/客户实验数据），
  // PDB 结构与文献全量展开（expandAll）；页首「← 返回报告首页」+ 页脚上一/下一靶点
  // 导航；hash 深链 #view-target-<ID> 直达；打印时所有视图依序输出、靶点页另起一页。
  // LLM 章节来源：v2.13 起批次各靶点按单靶点流程生成完整独立报告（reportMarkdown，
  // pipeline 不再因复合物组分跳过单独评估）；旧批次回退合并报告的各靶点综述。
  const engineStr = input.engineSummary || '—'
  // v2.26 GPCR 受体主导批次：受体不出独立视图（其完整评估报告即报告首页主体 —
  // 用户需求「主页只显示受体的评估页面」）；G 蛋白伴侣保留独立视图（chips 卡片进入）。
  // 受体导航 chip 指向 home（报告首页即受体页）。
  const targetViewList = await Promise.all(targets.map(async (t, i) => {
    const key = keyOf(t)
    const prev = i > 0 ? targets[i - 1] : null
    const next = i < targets.length - 1 ? targets[i + 1] : null
    const isReceptor = !!gpcrBatch && t === gpcrBatch.receptor
    // AF 交互视图（公共 MODELS 池）：本次获取的可内嵌模型 > 作业摘要元数据（降级统计卡）
    // v2.15：AFDB 无收录的靶点（esmfold 摘要 available）→ ESMFold 兜底视图（池键
    // esm:{cacheKey}，engine='esmfold' — 卡片标注/外链切换 ESM Atlas 口径）；
    // 缓存缺失/超预算时降级统计卡（元数据 + esmatlas 链接）。
    const view = t.uniprotId ? afViews.get(t.uniprotId) : undefined
    const esmView = t.esmfold?.cacheKey ? esmViews.get(t.esmfold.cacheKey) : undefined
    const afSummary = (t.alphafold?.available ? t.alphafold : (t.uniprotId ? afMetaFill.get(t.uniprotId) : undefined)) ?? t.alphafold
    const afPooled = view && t.uniprotId
      ? { mafKey: t.uniprotId, modelId: view.modelId, version: view.version, globalPlddt: view.globalPlddt, fracVeryHigh: view.fracVeryHigh, pdbKb: Math.max(1, Math.round(view.pdbText.length / 1024)), domains: t.afDomains }
      : afSummary?.available && t.uniprotId
        ? { mafKey: t.uniprotId, modelId: afSummary.modelId ?? 'AF 模型', version: afSummary.version ?? 1, globalPlddt: afSummary.globalPlddt ?? null, fracVeryHigh: afSummary.fracVeryHigh ?? null, pdbKb: 0, metaOnly: true }
        : esmView && t.esmfold?.available && t.esmfold.cacheKey
          ? { mafKey: `esm:${t.esmfold.cacheKey}`, modelId: 'ESMFold v1', version: 1, globalPlddt: esmView.globalPlddt, fracVeryHigh: esmView.fracVeryHigh, pdbKb: Math.max(1, Math.round(esmView.pdbText.length / 1024)), engine: 'esmfold' as const, sequenceLength: esmView.sequenceLength }
          : t.esmfold?.available
            ? { mafKey: `esm:${t.esmfold.cacheKey ?? ''}`, modelId: 'ESMFold v1', version: 1, globalPlddt: t.esmfold.globalPlddt ?? null, fracVeryHigh: t.esmfold.fracVeryHigh ?? null, pdbKb: 0, metaOnly: true, engine: 'esmfold' as const, sequenceLength: t.esmfold.sequenceLength }
            : undefined
    // LLM 章节来源：独立报告（新批次）→ 合并综述（旧批次回退）→ 说明占位
    const ownMd = t.reportMarkdown?.trim() || ''
    const reviewMd = reviewByTarget.get(t.uniprotId ?? t.label) || ''
    const legacyNote = ownMd
      ? undefined
      : reviewMd
        ? '本页由历史批次数据重渲染：该批次评估时各靶点报告并入合并评估（当时未按单靶点流程生成独立报告）— 以下「评估分析」为合并报告中的该靶点综述，其余章节为该靶点确定性数据；如需完整独立评估报告可对该批次重新评估。'
        : input.llmOk
          ? '该靶点的评估分析章节未能生成或归属（LLM 小节缺失）— 批次级完整分析见报告首页「合并评估分析」章节。'
          : 'LLM 分析生成失败 — 以下为系统收集的确定性数据区块（评分 / PDB / 同源 / 文献 / 客户实验数据）。'
    // 单靶点报告上下文（该靶点作业数据 + 批次共享评估表/图片/关系说明）
    const ctx: SingleBodyCtx = {
      uniprot: t.uniprotId ? {
        uniprotId: t.uniprotId, entryName: t.entryName ?? '', proteinName: t.proteinName,
        geneNames: t.geneNames, organism: t.organism, sequenceLength: t.sequenceLength,
        // v2.31：加工条目（聚合蛋白 nsp 归属 — 单独评估页题目标注与刊头「加工归属」行）
        processingChains: t.processingChains,
      } : null,
      sequence: '',
      // v2.16：序列靶点身份（题目/刊头用识别名，不再「序列靶点评估」笼统命名）
      targetIdentity: t.targetIdentity ?? undefined,
      goal: input.goal,
      goalHints: [],
      insights: input.insights ?? undefined,
      batchNote: isReceptor
        ? `受体主导复合物批次 · ${relName}（置信度${relConfZh}）— 本页即该受体（主要评估对象）的完整评估报告；G 蛋白伴侣（${gpcrBatch!.couplingLabel}）与「受体 × G 蛋白复合物结构」证据见页顶标注，批次级补充分析（合并评估/共有结构/对比矩阵）见页底折叠`
        : gpcrBatch
          ? `受体主导复合物批次 · ${relName}（置信度${relConfZh}）— 本靶点为 G 蛋白伴侣（${gpcrBatch.couplingLabel}，信号转导组分），非批次主要评估对象；受体（${gpcrBatch.receptor.uniprotId ?? gpcrBatch.receptor.label}）的完整评估即报告首页`
          : `关联靶点批次 · ${relName}（置信度${relConfZh}）— 本页为该靶点的单独评估报告，批次级分析与共有结构见报告首页`,
      providedSequence: t.construct ? { sequence: '', comparison: t.construct as unknown as SequenceComparison } : undefined,
      range: t.range,
      rangeSource: t.rangeSource,
      rangeOutsidePdbs: t.rangeOutsidePdbs,
      rangeOutsideBlastHits: t.rangeOutsideBlastHits,
      // v2.59：nr 全库检索命中（报告 BLAST 章节展示前 5 条 + 折叠）
      blastNrHits: t.blastNrHits,
      // v2.95：nr 命中实际检索通道（面板标题/说明如实标注 — ebi = EBI 全库兜底）
      blastNrProvider: t.blastNrProvider,
      // v2.82：UniProt 库序列匹配命中（报告 BLAST 章节单独面板展示）
      uniprotBlastHits: t.uniprotBlastHits,
      // v2.96：身份识别序列比对（报告 BLAST 章节「序列比对」面板 — 悬停显示双侧残基号）
      identityAlignment: t.identityAlignment,
      directPdbs: t.directPdbs,
      blastHits: t.blastHits,
      blastStatus: t.blastStatus,
      coverage: t.coverage ?? null,
      coverageText: t.coverageText ?? '',
      gapText: t.gapText ?? '',
      literature: t.literature,
      images: input.images,
      scores: t.scores,
      oligomer: t.oligomer,
      ligands: t.ligands,
      alphafold: t.alphafold,
      esmfold: t.esmfold ?? undefined,
      mwAugment: t.mwAugment ?? undefined,
      interaction: t.interaction ?? undefined,
    }
    const body = await renderSingleReportBody({
      ctx,
      methodStats: t.methodStats,
      llmMarkdown: ownMd || reviewMd,
      llmOk: Boolean(ownMd || reviewMd) || input.llmOk,
      llmErrors: (ownMd || reviewMd) ? [] : input.llmErrors,
      jobId: t.jobId,
      durationMs: t.durationMs,
      totalPdbFound: t.directPdbs.length,
      engineSummary: engineStr,
      embeddedImages: embedded,
      embed: { idPrefix: key, expandAll: true, afPooled, pooledImages: true, legacyNote },
    })
    const navChip = (tgt: MergedTargetData | null, dir: 'prev' | 'next') => tgt
      ? (gpcrBatch && tgt === gpcrBatch.receptor
          ? `<a class="tgt-nav-chip" data-goto="home" href="#top" title="${esc(tgt.proteinName)}（${esc(tgt.uniprotId ?? tgt.label)}）— 报告首页即该受体的完整评估报告">${dir === 'prev' ? '← ' : ''}${esc(tgt.uniprotId ?? tgt.label)}（首页）${dir === 'next' ? ' →' : ''}</a>`
          : `<a class="tgt-nav-chip" data-goto="target-${keyOf(tgt)}" href="#view-target-${keyOf(tgt)}" title="${esc(tgt.proteinName)}（${esc(tgt.uniprotId ?? tgt.label)}）">${dir === 'prev' ? '← ' : ''}${esc(tgt.uniprotId ?? tgt.label)}${dir === 'next' ? ' →' : ''}</a>`)
      : ''
    if (isReceptor) {
      // v2.26：受体完整评估报告直接作为报告首页主体 — 不再包独立视图（避免双份大体积）
      return { t, i, key, body, viewHtml: '' }
    }
    const viewHtml = `
  <div class="rpt-view" id="view-target-${key}">
    <div class="tgt-topbar">
      <button type="button" class="tgt-back" data-goto="home">← 返回报告首页</button>
      <span class="tgt-topbar-tag">TargetEval · Per-Target Report · 靶点单独报告 ${i + 1}/${targets.length}</span>
    </div>
${body}
    <div class="tgt-page-foot">
      <button type="button" class="tgt-back" data-goto="home">← 返回报告首页</button>
      <div class="tgt-page-nav">
        ${navChip(prev, 'prev')}
        <span class="tgt-nav-pos">${i + 1} / ${targets.length}</span>
        ${navChip(next, 'next')}
      </div>
    </div>
  </div>`
    return { t, i, key, body, viewHtml }
  }))
  const targetViews = targetViewList.filter(v => v.viewHtml).map(v => v.viewHtml).join('')
  /** v2.26 GPCR 模式：受体的完整单独评估报告主体（首页用 — renderSingleReportBody 输出） */
  const receptorBodyHtml = gpcrBatch ? (targetViewList.find(v => v.t === gpcrBatch.receptor)?.body ?? '') : ''

  // ── v2.26 GPCR 受体主导复合物批次首页组件（受体主导刊头 + 复合物结构标注面板）──
  const receptorShort = (t: MergedTargetData) => t.geneNames?.[0] || t.proteinName.replace(/\s*\(.*?\)\s*/g, '').trim() || t.label
  /** 受体×G蛋白复合物结构的最佳分辨率（空集安全） */
  const rxCxBestRes = receptorGComplex.map(s => s.resolution).filter((v): v is number => v != null)
  const gpcrHeadHtml = gpcrBatch ? `
  <header class="rpt-head">
    <div class="rpt-eyebrow">TargetEval · Receptor-Centric Merged Report · 受体主导复合物评估</div>
    <h1 class="rpt-title">${esc(gpcrBatch.receptor.proteinName)} 结构解析评估</h1>
    <div class="rpt-subtitle">受体主导复合物批次 — G 蛋白伴侣（${esc(gpcrBatch.couplingLabel)}）为信号转导组分，非独立结构解析对象</div>
    <div class="meta-grid">
      <div><b>主要对象</b> ${esc(gpcrBatch.receptor.proteinName)}${gpcrBatch.receptor.uniprotId ? `（<a href="https://www.uniprot.org/uniprotkb/${gpcrBatch.receptor.uniprotId}" target="_blank" rel="noopener">${gpcrBatch.receptor.uniprotId}</a>）` : ''}</div>
      <div><b>G 蛋白伴侣</b> ${esc(gpcrBatch.couplingLabel)}</div>
      <div><b>受体×G蛋白复合物结构</b> ${receptorGComplex.length} 个${rxCxBestRes.length ? ` · 最佳 ${Math.min(...rxCxBestRes).toFixed(2)}Å` : ''}</div>
      <div><b>PDB 结构合计</b> ${pdbTotal} 个${bestRes != null ? ` · 最佳 ${bestRes.toFixed(2)}Å` : ''}（X-ray ${msAgg.xray} · Cryo-EM ${msAgg.cryoem} · NMR ${msAgg.nmr}）</div>
      <div><b>共有结构</b> ${sharedStructures.length} 个（同一 PDB 覆盖 ≥2 个靶点${sharedAdded ? ` · 含评估后补齐 ${sharedAdded} 条` : ''}）</div>
      <div><b>分析引擎</b> ${esc(input.engineSummary || '—')}</div>
      <div><b>报告日期</b> ${dateStr} · 编号 ${esc(input.batchReportId.slice(0, 10))}</div>
      ${input.goal ? `<div><b>客户目标</b> <span style="color:#92400e">${esc(input.goal.length > 120 ? input.goal.slice(0, 119) + '…' : input.goal)}</span></div>` : ''}
    </div>
    <div class="rpt-badges">
      <span class="badge">${esc(relName)} · 受体主导</span>
      <span class="badge">G 蛋白伴侣：${esc(gpcrBatch.couplingLabel)}</span>
      <span class="badge ${receptorGComplex.length ? '' : 'amber'}">受体×G 蛋白复合物结构：${receptorGComplex.length ? receptorGComplex.length + ' 个' : '无先例'}</span>
      <span class="badge">数据源：UniProt · RCSB · PDBe${targets.some(t => t.blastHits.length > 0) ? (targets.some(t => t.blastStatus?.provider === 'rcsb') ? ' · 序列检索（RCSB 兜底）' : ' · BLAST') : ''}${litTotal ? ' · PubMed' : ''}</span>
      ${input.llmOk ? '<span class="badge">LLM 分析：已完成</span>' : '<span class="badge amber">LLM 分析：失败（见补充分析）</span>'}
    </div>
    <div class="rel-box">
      <b>靶点关系：${esc(relName)}（受体 ${esc(receptorShort(gpcrBatch.receptor))} + G 蛋白伴侣）</b>（置信度：${relation.confidence === 'high' ? '高' : relation.confidence === 'medium' ? '中' : '低'}）<br>
      ${esc(relation.rationale)}<br>
      <b>策略要点：</b>${esc(relation.strategy)}
    </div>
    ${targetMeta ? `<div class="tgt-grid">${targetMeta}</div>` : ''}
  </header>` : ''

  // v2.26：受体 × G 蛋白类型复合物结构存在性标注与分析（用户需求核心面板）
  const rxCxRows = receptorGComplex.map(s => {
    const covChips = s.coverage.map(c => {
      const isReceptor = c.uniprotId === gpcrBatch?.receptor.uniprotId
      return `<span class="cov-chip${isReceptor ? ' cx-chip-shared' : ''}" title="${esc(c.proteinName)}${isReceptor ? ' — 受体' : ' — G 蛋白伴侣'}">${esc(c.uniprotId)}${c.chainRanges ? `<span class="cov-rng">${esc(c.chainRanges)}</span>` : ''}</span>`
    }).join(' ')
    const lit = s.pubmedId
      ? `<a href="https://pubmed.ncbi.nlm.nih.gov/${s.pubmedId}/" target="_blank" rel="noopener">${s.pubmedId}</a>`
      : '—'
    return `
    <tr data-m="${s.isXray ? 'xray' : s.isCryoem ? 'cryoem' : s.isNmr ? 'nmr' : 'other'}" data-res="${s.resolution ?? ''}" data-date="${esc(s.releaseDate.slice(0, 10))}" data-id="${s.pdbId}">
      <td class="td-id"><a href="https://www.rcsb.org/structure/${s.pdbId}" target="_blank" rel="noopener">${s.pdbId}</a></td>
      <td><span class="mth mth-${s.isXray ? 'xray' : s.isCryoem ? 'cryoem' : s.isNmr ? 'nmr' : 'other'}">${s.isXray ? 'X-ray' : s.isCryoem ? 'Cryo-EM' : s.isNmr ? 'NMR' : esc(s.method.slice(0, 8))}</span></td>
      <td class="num">${s.resolution != null ? s.resolution.toFixed(2) : '—'}</td>
      <td class="cov-cells"><span class="sh-cnt" title="该 PDB 覆盖 ${s.targetCount} 个输入靶点">×${s.targetCount}</span>${covChips}</td>
      <td class="t-title" title="${esc(s.title)}">${esc(s.title.slice(0, 70))}</td>
      <td class="num">${esc(s.releaseDate.slice(0, 10))}</td>
      <td class="td-id">${lit}</td>
    </tr>`
  }).join('')
  const receptorComplexHtml = gpcrBatch ? `
  <section class="sec" id="receptor-gcomplex">
    <h2><span class="sec-no">◈</span><span class="sec-title">${esc(receptorShort(gpcrBatch.receptor))} × ${esc(gpcrBatch.couplingLabel.split(' 型')[0])} 复合物结构（${receptorGComplex.length}）</span><span class="sec-en">Receptor × G-Protein Complexes</span></h2>
    ${receptorGComplex.length ? `
    <div class="sh-hero">
      <div class="sh-hero-head"><span class="sh-ico" aria-hidden="true">◈</span>受体 × G 蛋白复合物结构 <b>${receptorGComplex.length}</b> 个<span class="sh-hero-sub">同一 PDB 条目同时覆盖受体与 G 蛋白组分 — <b>${esc(receptorShort(gpcrBatch.receptor))} 与该 G 蛋白类型共组装的直接结构先例</b>；最佳分辨率 <b>${rxCxBestRes.length ? Math.min(...rxCxBestRes).toFixed(2) + 'Å' : '—'}</b>${rxCxBestRes.length ? `（${receptorGComplex.find(s => s.resolution === Math.min(...rxCxBestRes))?.isCryoem ? 'Cryo-EM' : 'X-ray'}` : ''}${rxCxBestRes.length ? '）' : ''}；深绿底 = 受体实体</span></div>
      <div class="sh-cov-sum">${gpcrBatch.receptor.uniprotId ? `<span class="sh-cov-chip">${esc(gpcrBatch.receptor.uniprotId)}<i>${receptorGComplex.length}</i></span>` : ''}${gpcrBatch.gproteins.map(g => g.uniprotId ? `<span class="sh-cov-chip" title="${esc(g.proteinName)} — G 蛋白伴侣">${esc(g.uniprotId)}<i>${receptorGComplex.filter(s => s.coverage.some(c => c.uniprotId === g.uniprotId)).length}</i></span>` : '').join('')}</div>
    </div>
    <p class="note">这些条目证实「${esc(receptorShort(gpcrBatch.receptor))}–G 蛋白复合物」已有直接解析先例：共表达 / 体外组装路线可借鉴其组分构成与化学计量（覆盖列 ×N 为该 PDB 覆盖的输入靶点数，深绿底为受体、浅底为 G 蛋白伴侣实体）；复合物的有效分子量与 Cryo-EM 适用性应结合下方受体的完整评估综合判断。全部批内共有结构（含仅覆盖 G 蛋白组分之间的条目）见页底「批次级补充分析」折叠。</p>
    <div class="tbl-wrap"><table class="tbl-data" data-tbl="shared">
      ${SHARED_PDB_COLGROUP}
      <thead><tr><th>PDB ID</th><th>方法</th><th class="num">分辨率 (Å)</th><th>覆盖组分</th><th>标题</th><th class="num">释放日期</th><th>文献</th></tr></thead>
      <tbody>${rxCxRows}</tbody>
    </table></div>` : `
    <div class="callout callout-amber"><b>无 ${esc(receptorShort(gpcrBatch.receptor))} × ${esc(gpcrBatch.couplingLabel.split(' 型')[0])} 复合物结构先例</b>现有 PDB 中未检索到同时覆盖该受体与本批次 G 蛋白类型（${esc(gpcrBatch.couplingLabel)}）的复合物条目 — 受体与该 G 蛋白的复合物组装需从共表达或体外组装验证起步，无既有构建参数（化学计量 / 界面突变）可借鉴；可参照其他 GPCR–G 蛋白复合物结构的通用组装策略（亲和共纯化、scFv / mini-G 稳定化等）设计验证路线。受体的单独结构可行性见下方其完整评估报告。</div>`}
  </section>` : ''

  // v2.26：批次级补充分析区块（合并评估分析 / 共有结构 / 评估表要点 / 配体 / 对比矩阵 /
  // 序列一致性 / 序列归属 / 客户实验数据）— 普通 batch 作为首页章节流；GPCR 受体主导
  // 批次收纳为首页底部折叠（主报告 = 受体完整评估），打印时自动展开（既有打印逻辑）
  const batchSupplementHtml = `
  ${input.llmOk ? '' : `<div class="warn-box">LLM 分析生成失败（${esc(input.llmErrors.join('；')) || '未知原因'}）。以下为系统收集的确定性数据与评估表 AI 解析要点。</div>`}

  <section class="sec sec-llm" id="llm">
    <h2>${secHead(noLlm, '合并评估分析', 'Merged Analysis')}</h2>
    ${renderMarkdown(llmHomeMd || '（LLM 分析不可用 — 请参考下方数据区块与评估表要点）', 1)}
  </section>

  ${sharedStructuresHtml}${sharedAdded ? `<p class="note" style="margin-top:-6px">v2.26：共有结构基于全量 PDB ID 交集在线补齐（新增 ${sharedAdded} 条）— 高频共用组分（G 蛋白等）在 PDB 有 1000+ 条目，评估时落库的 500 条截断曾致复合物共有结构漏检。</p>` : ''}

  ${insightsHtml}
  ${ligandsHtml}

  <section class="sec" id="matrix">
    <h2>${secHead(noMatrix, `跨靶点对比矩阵（${targets.length} 个靶点）`, 'Comparison Matrix')}</h2>
    <div class="tbl-wrap"><table>
      <thead><tr><th>UniProt</th><th>靶点</th><th class="num">PDB</th><th class="num">最佳分辨率</th><th class="num">覆盖率</th><th>寡聚态</th><th class="num">同源结构</th><th class="num">文献</th><th class="num">X-ray</th><th class="num">Cryo-EM</th><th class="num">NMR</th><th class="num">总体</th></tr></thead>
      <tbody>${matrixRows}</tbody>
    </table></div>
    ${oligoTargets.length ? `<p class="note">各靶点评分已包含蛋白聚集形式（寡聚态）调整（判定徽标见刊头靶点卡片与矩阵寡聚态列，调整明细与证据链见下方折叠；各靶点结合寡聚态的具体建议已融入其单独报告页的结构可行性综述）。</p>${oligoFoldHtml}` : ''}
  </section>

  ${matrixHtml}
  ${attributionHtml}

  ${figHtml}`

  // v2.12：视图切换脚本（首页 ↔ 各靶点单独报告页）— hash 深链 + 打印全展开；
  // 点击卡片内普通链接（UniProt 等）不触发视图切换（仍走默认链接行为）；
  // 切换后滚动复位：独立文件滚回文档顶；自动高度内嵌（无内部滚动条）时联动
  // 宿主页面把报告顶部带回视口；固定高度内嵌（Dialog 预览，有内部滚动条）时
  // 仅滚 iframe 内部
  const viewSwitchJs = `
<script>
// v2.12：视图切换 — 复合物评估首页与各靶点单独报告页分层阅读
(function () {
  function resetScroll() {
    try {
      var internal = document.documentElement.scrollHeight > window.innerHeight + 4;
      window.scrollTo(0, 0);
      if (!internal && window.parent && window.parent !== window && window.frameElement) {
        var rect = window.frameElement.getBoundingClientRect();
        var pv = window.parent.innerHeight || 800;
        if (rect.top < -8 || rect.top > pv - 120) window.parent.scrollBy({ top: rect.top - 12 });
      }
    } catch (e) { /* ignore */ }
  }
  function show(id, scroll) {
    var el = document.getElementById('view-' + id);
    if (!el) return;
    var views = document.querySelectorAll('.rpt-view');
    for (var i = 0; i < views.length; i++) views[i].classList.toggle('rpt-view-on', views[i] === el);
    if (scroll !== false) resetScroll();
    try { history.replaceState(null, '', '#view-' + id); } catch (e) { /* ignore */ }
    if (window.__rptInitPendingStages) { try { window.__rptInitPendingStages(); } catch (e) { /* ignore */ } }
  }
  window.__rptShowView = show;
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var gotoEl = t.closest('[data-goto]');
    if (!gotoEl) return;
    var a = t.closest('a[href]');
    if (a && a !== gotoEl) return;
    if (gotoEl.tagName === 'A') e.preventDefault();
    show(gotoEl.getAttribute('data-goto'));
  });
  window.addEventListener('hashchange', function () {
    var h = (location.hash || '').replace(/^#/, '');
    if (/^view-/.test(h)) show(h.slice(5), false);
  });
  var initial = (location.hash || '').replace(/^#/, '');
  if (/^view-/.test(initial)) show(initial.slice(5), false);
})();
</script>`

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<!-- mrg-fmt-v2.26 合并报告格式版本标记：旧版落盘 HTML 无此标记时由报告路由自动升级重渲染（v2.26：共有结构全量 ID 交集补齐 — 3 靶点复合物结构漏检修复 + 受体–G 蛋白复合物批次切换为受体主导首页（受体完整评估 + 受体×G 蛋白复合物结构标注分析）+ 每靶点完整单独评估报告页 + PDB/文献全量展开） -->
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;600;700;900&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;0,8..60,700;1,8..60,400&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<title>${esc(reportTitle)} · ${esc(targets.map(t => t.label).join(' + '))}</title>
<!-- v2.45 机器可读靶点标记（报告导入精确匹配用 — uniprot/range/seqLength/header/seqSha/label） -->
<meta name="targeteval:targets" content="${esc(JSON.stringify(targets.map(t => ({
  uniprot: t.uniprotId,
  range: t.range,
  seqLength: t.sequenceLength || undefined,
  header: t.sequenceHeader,
  seqSha: t.seqSha,
  label: t.label,
}))))}">
<style>
${SINGLE_REPORT_CSS}

  /* ── v2.13 合并报告附加（基础样式 = 单靶点报告 SINGLE_REPORT_CSS 同源同版：
        字体/标题/章节/表格/评分卡/文献/配体卡全部与单独评估一模一样）──────── */
  /* 视图分层（首页 = 复合物评估；每靶点单独评估页独立视图） */
  .rpt-view { display:none; }
  .rpt-view.rpt-view-on { display:block; }
  @media print {
    .rpt-view { display:block !important; }
    .rpt-view + .rpt-view { break-before:page; }
    .tgt-back, .tgt-open, .tgt-page-nav, .tgt-nav-pos, .tgt-topbar { display:none !important; }
  }
  .rpt-print-all .rpt-view { display:block !important; }
  /* 关系说明盒 + 靶点卡片网格（批次附加 — 点击进入该靶点单独评估页） */
  .rel-box { background:#ecfdf5; border:1px solid #a7f3d0; border-left:4px solid var(--accent); border-radius:5px; padding:14px 18px; margin:14px 0 4px; font-size:13px; color:#064e3b; line-height:1.9; }
  .rel-box b { color:#064e3b; }
  .tgt-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); gap:10px; margin:14px 0; }
  .tgt-card { border:1px solid var(--line); border-radius:5px; padding:12px 14px; background:#fff; cursor:pointer; transition:border-color .15s, box-shadow .15s; }
  .tgt-card:hover { border-color:#a7f3d0; box-shadow:0 2px 10px rgba(4,120,87,.10); }
  .tgt-name { font-weight:600; font-size:14px; color:var(--ink); } .tgt-name a { color:var(--accent-2); text-decoration:none; } .tgt-idsrc { font-size:10.5px; font-weight:500; color:#92400e; background:#fef3c7; border-radius:3px; padding:1px 6px; margin-left:4px; vertical-align:1px; }
  .tgt-meta { font-size:11.5px; color:var(--sub); margin-top:3px; }
  .tgt-score { font-size:12px; color:var(--accent-2); margin-top:5px; }
  .tgt-open { margin-top:7px; padding-top:7px; border-top:1px dashed var(--line); font-family:var(--mono); font-size:10.5px; font-weight:600; letter-spacing:.5px; color:var(--accent-2); }
  .tgt-card:hover .tgt-open { color:#047857; }
  .tgt-stats { display:flex; flex-wrap:wrap; gap:4px 12px; margin-top:6px; padding-top:6px; border-top:1px dashed var(--line); font-size:10.5px; color:var(--sub); font-variant-numeric:tabular-nums; }
  .tgt-stats b { color:var(--ink); font-weight:600; }
  .tgt-oligo { display:flex; flex-wrap:wrap; align-items:center; gap:6px; margin-top:5px; }
  .tgt-oligo .oligo-badge { font-size:10px; padding:1px 8px; }
  .tgt-oligo .oligo-stoich { font-size:10px; padding:0 7px; }
  .tgt-oligo-conf { font-size:10.5px; color:var(--sub); }
  .tgt-oligo-adj { margin-left:6px; font-size:10px; color:#047857; border:1px solid #a7f3d0; border-radius:99px; padding:0 7px; background:#ecfdf5; white-space:nowrap; }
  /* v2.18：AI 复核徽标（LLM 智能调分）— 紫色系与单靶点报告同源视觉 */
  .tgt-ai-adj { margin-left:6px; font-size:10px; color:#5b21b6; border:1px solid #c4b5fd; border-radius:99px; padding:0 7px; background:#ede9fe; white-space:nowrap; cursor:help; }
  .tgt-ai-adj.keep { color:#6d28d9; border-color:#ddd6fe; background:#f5f3ff; }
  /* 目录：共有结构条目突出 + 靶点速览导航 */
  .toc-shared { color:#065f46; font-weight:700; }
  .toc-shared::before { content:'◈ '; color:var(--accent-2); }
  .toc-targets { margin-top:10px; padding-top:10px; border-top:1px dashed var(--line); display:flex; flex-wrap:wrap; align-items:center; gap:6px 8px; }
  .toc-targets b { font-size:11px; }
  .toc-targets a { font-family:var(--mono); font-size:11px; color:var(--accent-2); background:var(--accent-bg); border:1px solid #c7ece0; border-radius:3px; padding:1px 9px; text-decoration:none; white-space:nowrap; }
  .toc-targets a:hover { background:#d9f5e8; }
  /* 靶点单独评估页：顶部返回条 + 底部导航 */
  .tgt-topbar { display:flex; flex-wrap:wrap; align-items:center; gap:10px 14px; margin-bottom:20px; }
  .tgt-topbar-tag { font-family:var(--mono); font-size:10px; letter-spacing:1.8px; text-transform:uppercase; color:var(--faint); font-weight:600; }
  .tgt-back { display:inline-flex; align-items:center; gap:5px; font-family:var(--mono); font-size:11px; font-weight:600; letter-spacing:.5px; color:var(--accent-2); background:var(--accent-bg); border:1px solid #c7ece0; border-radius:5px; padding:5px 13px; cursor:pointer; }
  .tgt-back:hover { background:#d9f5e8; color:#047857; }
  .tgt-page-foot { margin-top:34px; padding-top:16px; border-top:1px solid var(--line); display:flex; flex-wrap:wrap; align-items:center; gap:10px 12px; }
  .tgt-page-nav { margin-left:auto; display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
  .tgt-nav-chip { font-family:var(--mono); font-size:11px; font-weight:600; color:var(--accent-2); background:var(--accent-bg); border:1px solid #c7ece0; border-radius:3px; padding:1px 9px; text-decoration:none; white-space:nowrap; }
  .tgt-nav-chip:hover { background:#d9f5e8; }
  .tgt-nav-pos { font-family:var(--mono); font-size:11px; color:var(--faint); }
  /* 序列一致性矩阵（表头/行标/数值全部居中 — 列内容与表头严格对齐） */
  table.idm { margin:12px auto; max-width:100%; }
  table.idm thead th { text-align:center; }
  table.idm tbody th { font-family:var(--mono); font-size:12px; font-weight:600; color:var(--ink); background:#fafaf8; text-transform:none; letter-spacing:0; padding:6px 10px; border-bottom:1px solid var(--line); white-space:nowrap; }
  table.idm th, table.idm td, table.idm td.num { text-align:center; }
  table.idm td.num { font-size:12.5px; }
  table.idm .idm-corner { font-size:10px; color:var(--faint); letter-spacing:1px; }
  table.idm .idm-diag { background:#f7f7f5; color:var(--faint); }
  table.idm .idm-val { font-weight:600; }
  /* 共有结构面板（绿色突出） */
  .sh-hero { background:var(--accent-bg); border:1px solid #a7f3d0; border-left:4px solid var(--accent); border-radius:6px; padding:14px 18px; margin:0 0 12px; }
  .sh-hero-head { display:flex; flex-wrap:wrap; align-items:baseline; gap:6px 10px; font-size:15px; color:#064e3b; }
  .sh-hero-head b { font-size:18px; font-weight:800; }
  .sh-ico { color:var(--accent); font-size:16px; }
  .sh-hero-sub { flex-basis:100%; font-size:12px; color:#047857; line-height:1.8; }
  .sh-hero-sub b { font-size:12px; font-weight:700; }
  .sh-cov-sum { display:flex; flex-wrap:wrap; gap:6px; margin-top:10px; padding-top:10px; border-top:1px dashed #a7f3d0; }
  .sh-cov-chip { display:inline-flex; align-items:baseline; gap:5px; font-family:var(--mono); font-size:11px; padding:2px 9px; border-radius:3px; background:#fff; border:1px solid #a7f3d0; color:#065f46; white-space:nowrap; }
  .sh-cov-chip i { font-style:normal; font-weight:700; color:var(--accent); }
  .sh-cnt { display:inline-block; font-family:var(--mono); font-size:10.5px; font-weight:700; color:#065f46; background:#ecfdf5; border:1px solid #a7f3d0; border-radius:3px; padding:1px 5px; margin-right:4px; }
  .sh-mark { color:var(--accent); font-size:13px; margin-right:3px; }
  .sh-sum { font-weight:600; font-size:12px; color:#065f46; }
  .cov-cells { max-width:260px; }
  .cov-chip { display:inline-block; font-family:var(--mono); font-size:10px; line-height:1.6; padding:1px 6px; margin:1px 2px 1px 0; border-radius:3px; background:#ecfdf5; border:1px solid #a7f3d0; color:#065f46; white-space:nowrap; }
  .cov-rng { display:inline-block; margin-left:3px; padding:0 3px; border-radius:2px; background:#f0fdf4; color:#047857; font-size:9.5px; }
  /* 对比矩阵扩列（评级副文本 + 占位） */
  .mtx-rating { display:block; font-size:10px; color:var(--sub); font-weight:400; line-height:1.4; }
  .mtx-dash { color:var(--faint); }
  /* 评估表问题回应卡 */
  .qa-ans { margin:7px 0 3px; padding:9px 14px 7px; background:#ecfdf5; border:1px solid #a7f3d0; border-left:3px solid var(--accent); border-radius:4px; font-size:13px; line-height:1.9; text-align:justify; }
  .qa-ans .qa-tag { display:inline-block; font-family:var(--mono); font-size:9.5px; font-weight:700; letter-spacing:1.5px; color:#047857; text-transform:uppercase; margin-bottom:4px; }
  .qa-ans .qa-tag-q { color:#065f46; }
  .qa-ans p { font-size:13px; margin:4px 0; }
  .qa-ans ul { margin:4px 0 4px 18px; font-size:12.5px; } .qa-ans li { margin:2px 0; }
  .qa-ans blockquote { margin:6px 0; font-size:12px; }
  .qa-ans table { font-size:11.5px; } .qa-ans th, .qa-ans td { padding:4px 8px; }
  @media print { .qa-ans { break-inside:avoid-page; } }
  /* AF 统计降级卡（合并嵌入模式 — 模型超预算/获取失败时头部右栏） */
  .mtr-af-stat { display:flex; flex-direction:column; gap:6px; border:1px solid var(--line); border-radius:5px; background:#fdfdfc; padding:12px 14px; }
  .mtr-af-stat-line { font-family:var(--mono); font-size:11px; color:var(--ink); line-height:1.8; }
  .mtr-af-stat-note { font-size:11px; color:var(--sub); line-height:1.7; }
  .mtr-af-link { font-family:var(--mono); font-size:11px; color:var(--accent-2); text-decoration:none; }
  /* glance 共有结构 tile 突出（批次附加） */
  .glance-tile.gt-shared { background:var(--accent-bg); }
  .glance-tile.gt-shared .gt-value { color:#065f46; }
  /* 聚集形式证据链行（首页矩阵下折叠内） */
  .oligo-ev { margin:8px 0 0; border-top:1px dashed var(--line); padding-top:8px; }
  /* v2.26 GPCR 受体主导首页：复合物结构面板覆盖芯片中受体实体高亮（深绿底白字） */
  .cov-chip.cx-chip-shared { background:#065f46; color:#fff; border-color:#065f46; font-weight:700; }
  .cov-chip.cx-chip-shared .cov-rng { background:#0b7a5c; color:#eafff5; }
  .oligo-ev-line { display:flex; gap:10px; font-size:12px; padding:3px 0; align-items:baseline; flex-wrap:wrap; }
  .oligo-ev-src { flex:0 0 158px; color:#065f46; white-space:nowrap; }
  .oligo-ev-ref { flex:0 0 120px; font-family:var(--mono); font-size:11px; color:var(--sub); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .oligo-ev-text { flex:1; min-width:120px; color:var(--sub); }
  .oligo-notes { margin:8px 0 2px 20px; font-size:12.5px; color:var(--sub); }
  .oligo-notes li { margin:3px 0; }

${RESPONSIVE_PAGE_CSS}${LIGHTBOX_CSS}${PRINT_PAGE_CSS}${UX_PAGE_CSS}</style>
</head>
<body>
<div class="page">

  <div class="rpt-view rpt-view-on" id="view-home">
${gpcrBatch ? `
  ${gpcrHeadHtml}
  ${receptorComplexHtml}
${receptorBodyHtml}
  <details class="fold" id="gpcr-batch-fold">
    <summary>批次级补充分析 — 合并评估分析 · 共有结构（${sharedStructures.length}${sharedLitByPmid.size ? ' · 含共有文献' : ''}）${insightsHtml ? ' · 评估表要点' : ''}${ligandsHtml ? ' · 配体' : ''} · 对比矩阵${embedded.length ? ' · 实验数据' : ''}（受体主导批次：批次级材料收纳于此，主报告为上方受体的完整评估）</summary>
    ${batchSupplementHtml}
  </details>` : `
  <header class="rpt-head">
    <div class="rpt-eyebrow">TargetEval · Merged Structure Feasibility Report</div>
    <h1 class="rpt-title">${esc(reportTitle)}</h1>
    <div class="rpt-subtitle">${esc(targets.map(t => (t.nspLabel ? `${t.proteinName} ${t.nspLabel}` : t.proteinName)).join(' · '))}</div>
    <div class="meta-grid">
      <div><b>靶点数</b> ${targets.length} 个（${esc(relName)} · 置信度${relation.confidence === 'high' ? '高' : relation.confidence === 'medium' ? '中' : '低'}）</div>
      <div><b>PDB 结构合计</b> ${pdbTotal} 个${bestRes != null ? ` · 最佳 ${bestRes.toFixed(2)}Å` : ''}（X-ray ${msAgg.xray} · Cryo-EM ${msAgg.cryoem} · NMR ${msAgg.nmr}）</div>
      <div><b>同源结构合计</b> ${blastTotal} 个</div>
      <div><b>关键文献合计</b> ${litTotal} 篇</div>
      <div><b>共有结构</b> ${sharedStructures.length} 个（同一 PDB 覆盖 ≥2 个靶点${sharedAdded ? ` · 含评估后补齐 ${sharedAdded} 条` : ''}）</div>
      <div><b>分析引擎</b> ${esc(input.engineSummary || '—')}</div>
      <div><b>报告日期</b> ${dateStr} · 编号 ${esc(input.batchReportId.slice(0, 10))}</div>
      ${input.goal ? `<div><b>客户目标</b> <span style="color:#92400e">${esc(input.goal.length > 120 ? input.goal.slice(0, 119) + '…' : input.goal)}</span></div>` : ''}
    </div>
    <div class="rpt-badges">
      <span class="badge">${esc(relName)}</span>
      <span class="badge">数据源：UniProt · RCSB · PDBe${targets.some(t => t.blastHits.length > 0) ? (targets.some(t => t.blastStatus?.provider === 'rcsb') ? ' · 序列检索（RCSB 兜底）' : ' · BLAST') : ''}${litTotal ? ' · PubMed' : ''}</span>
      ${input.llmOk ? '<span class="badge">LLM 分析：已完成</span>' : '<span class="badge amber">LLM 分析：失败（见警示）</span>'}
    </div>
    <div class="rel-box">
      <b>靶点关系：${esc(relName)}</b>（置信度：${relation.confidence === 'high' ? '高' : relation.confidence === 'medium' ? '中' : '低'}）<br>
      ${esc(relation.rationale)}<br>
      <b>策略要点：</b>${esc(relation.strategy)}
    </div>
    <div class="tgt-grid">${targetMeta}</div>
  </header>

  ${glanceHtml}

  <nav class="toc">
    <b>Contents · 目录</b>
    <ol>
      <li><a href="#llm">${noLlm} · 合并评估分析（摘要 / 关系分析 / 整合策略 / 总结）</a></li>
      <li><a href="#shared-pdbs" class="toc-shared">${noShared} · 共有结构（${sharedStructures.length}${sharedLitByPmid.size ? ' · 含共有文献' : ''}）</a></li>
      ${insightsHtml ? `<li><a href="#insights">${noInsights} · 客户评估表要点与回应</a></li>` : ''}
      ${ligandsHtml ? `<li><a href="#ligands">${noLigands} · 配体研究数据</a></li>` : ''}
      <li><a href="#matrix">${noMatrix} · 跨靶点对比矩阵</a></li>
      ${matrixHtml ? `<li><a href="#homolog">${noIdentity} · ${isHomologousBatch ? '家族序列一致性矩阵' : '序列一致性'}</a></li>` : ''}
      ${attributionHtml ? `<li><a href="#attribution">${noAttribution} · 评估表序列归属</a></li>` : ''}
      ${embedded.length ? `<li><a href="#assets">${noAssets} · 客户实验数据</a></li>` : ''}
    </ol>
    <div class="toc-targets">
      <b>靶点单独报告 · ${targets.length}</b>
      ${targets.map(t => `<a data-goto="target-${keyOf(t)}" href="#view-target-${keyOf(t)}" title="${esc(t.proteinName)} — PDB ${t.directPdbs.length} · 总体 ${t.scores.overall.score}/10 · 完整单独评估报告（与单靶点评估同格式）">${esc(t.uniprotId ?? t.label)}</a>`).join('')}
    </div>
  </nav>

  ${batchSupplementHtml}
  <footer class="rpt-foot">
    ${gpcrBatch
      ? `Generated by TargetEval · 受体主导复合物合并评估（v2.26 格式：首页为受体（主要评估对象）的完整单独评估报告 + 「受体 × G 蛋白复合物结构」标注分析；G 蛋白伴侣保留单独评估页（刊头卡片进入）；批次级补充分析（合并评估 / 共有结构 / 对比矩阵）收纳于首页底部折叠，打印时自动展开 · 共有结构经全量 ID 交集在线补齐）`
      : `Generated by TargetEval · 多靶点合并评估（v2.26 格式：复合物评估与单独评估分层 — 首页为复合物级分析 + 共有结构与共有文献（全量 ID 交集在线补齐）；每靶点独立单独评估报告页与单靶点评估报告同格式同流程[评估分析 / 可行性评分 / PDB 结构与文献全量展开 / 同源 / 客户实验数据]，刊头靶点卡片进入 · 打印时全部页面依序输出；受体–G 蛋白复合物批次自动切换为受体主导首页）`}<br>
    SOURCES: UniProt REST · RCSB Data API · PDBe API · NCBI BLAST (pdbaa) / RCSB 序列检索（NCBI 拥堵时兜底） · PubMed E-utilities<br>
    Analysis engine: ${esc(input.engineSummary || '—')} · 本报告由系统自动生成，供研究参考，不构成投资/医疗建议。
  </footer>`}
  </div>

  ${targetViews}
</div>
<a href="#top" class="backtop no-print" id="backtop" aria-label="回到顶部" title="回到顶部">↑</a>
<script>
// v2.13：客户实验数据图片池 — 各靶点单独评估页 figure[data-fig-copy] 的 <img> 从
// 首页对应 data-fig 图片复制 src/alt（全批次只内嵌一次，单独页格式与单靶点报告一致）
(function () {
  var pool = {};
  Array.prototype.forEach.call(document.querySelectorAll('#view-home figure.fig[data-fig]'), function (f) {
    var img = f.querySelector('img');
    if (img && img.getAttribute('src')) pool[f.getAttribute('data-fig')] = img;
  });
  Array.prototype.forEach.call(document.querySelectorAll('figure.fig[data-fig-copy]'), function (c) {
    var src = pool[c.getAttribute('data-fig-copy')];
    var img = c.querySelector('img');
    if (src && img && !img.getAttribute('src')) {
      img.src = src.src;
      if (src.alt) img.alt = src.alt;
    }
  });
})();
</script>
<script>
// v2.13：backtop（与单靶点报告同款 — 滚动超一屏出现）
(function () {
  var btn = document.getElementById('backtop');
  if (btn) {
    var onScroll = function () { btn.classList.toggle('show', window.scrollY > 600); };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }
})();
</script>
<script>
// v2.12：打印准备 — 先展开全部 details 折叠块并临时显示全部视图（强制回流让隐藏
// 视图中的 3D 阶段拿到真实尺寸，随后 mtrViewerJs 的 beforeprint 监听再全量初始化）
(function(){
  var memo=[];
  var root=document.documentElement;
  function expand(){
    memo=[];
    document.querySelectorAll('details').forEach(function(d){ if(!d.open){ memo.push(d); d.open=true; } });
    root.classList.add('rpt-print-all');
    void document.body.offsetWidth;
  }
  function restore(){
    memo.forEach(function(d){ d.open=false; }); memo=[];
    root.classList.remove('rpt-print-all');
  }
  window.addEventListener('beforeprint', expand);
  window.addEventListener('afterprint', restore);
})();
</script>
${mtrViewerJs}
${viewSwitchJs}
${UX_PAGE_JS}
${TABLE_FILTER_JS}
${ALIGN_TIP_JS}
${ALIGN_LAYOUT_JS}
${LIGHTBOX_JS}
</body>
</html>`
}
