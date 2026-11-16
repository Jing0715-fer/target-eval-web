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
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { db } from '@/lib/db'
import { llmChat } from './llm'
import { elideSequenceRuns } from './seq-elide'
import { esc, renderMarkdown, strategyZh, ligDetailProps, ligStructFig, ligIdentFold, RESPONSIVE_PAGE_CSS, LIGHTBOX_CSS, LIGHTBOX_JS, PRINT_PAGE_CSS, UX_PAGE_CSS, UX_PAGE_JS } from './report-html'
import { describeRelationType, describeBlastStatus, type AlphafoldSummaryInfo, type BlastHit, type BlastStatusInfo, type ConstructInfo, type FormInsights, type HomologPair, type LiteratureItem, type MethodStats, type MwAugmentAnalysis, type OligomerAnalysis, type ParsedImage, type PdbEntry, type RelationJudgment, type Scores, type SequenceAttribution, type SharedStructure } from './types'
import { describeEvidenceSource, describeOligoConfidence } from './oligomer'
import { ensureLigand2dVector, type LigandResolution } from './ligand'
import { computeSharedStructures } from './shared-structures'
import { alphafoldStructureFor, alphafoldMetaFor, ensure3DmolBundle, plddtStyleApplyJs } from './alphafold'
import { splitQaChapter, parseInsightQa, QA_CHAPTER_TITLE } from './qa-chapter'

// ─── 数据结构 ─────────────────────────────────────────────────────────────────

/** 单个靶点的合并报告数据（从 EvaluationJob 加载） */
export interface MergedTargetData {
  jobId: string
  label: string
  uniprotId?: string
  proteinName: string
  geneNames: string[]
  organism: string
  sequenceLength: number
  scores: Scores
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
  /** v1.24：聚集形式（寡聚态）分析（v1.24+ 作业存在；历史作业缺省） */
  oligomer?: OligomerAnalysis
  ligands?: LigandResolution[]
  /** v1.26：分子量增重策略分析（v1.26+ 作业存在；历史作业缺省） */
  mwAugment?: MwAugmentAnalysis | null
  /** v2.9：AlphaFold 预测结构信息（v2.0+ 作业存于摘要；旧作业在渲染时按需补齐） */
  alphafold?: AlphafoldSummaryInfo
}

/** 前端展示用的轻量靶点数据（合并报告响应携带 — PDB/BLAST/文献列表带 UniProt 归属）
 *  v2.9：补齐各靶点单独简报所需字段（scores/methodStats/alphafold/construct/覆盖区间） */
export interface MergedTargetLite {
  jobId: string
  uniprotId?: string
  proteinName: string
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
  /** v2.9：AlphaFold 预测结构元数据（前端简报卡展示；交互 3D 视图见 HTML 报告） */
  alphafold?: AlphafoldSummaryInfo
}

/** 轻量化：网页合并视图（v1.24 起全部携带 — PDB/BLAST/文献不再截断，全部展示） */
export function toMergedTargetLite(t: MergedTargetData): MergedTargetLite {
  return {
    jobId: t.jobId,
    uniprotId: t.uniprotId,
    proteinName: t.proteinName,
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
    alphafold: t.alphafold,
  }
}

/** 从 DB 加载一批已完成作业为合并报告数据（不校验归属，调用方负责） */
export async function loadMergedTargets(jobIds: string[]): Promise<MergedTargetData[]> {
  const targets: MergedTargetData[] = []
  for (const id of jobIds) {
    const job = await db.evaluationJob.findUnique({ where: { id } })
    if (!job || job.status !== 'done') continue
    let summary: {
      uniprot?: { uniprotId: string; proteinName: string; geneNames: string[]; organism: string; sequenceLength: number }
      scores?: Scores; methodStats?: MethodStats; coverage?: number; ligandCount?: number; literatureCount?: number
      blast?: BlastStatusInfo; construct?: ConstructInfo; durationMs?: number; coverageText?: string; gapText?: string
      oligomer?: OligomerAnalysis
  ligands?: LigandResolution[]
      mwAugment?: MwAugmentAnalysis | null
      alphafold?: AlphafoldSummaryInfo
    } | null = null
    let pdbs: PdbEntry[] = []
    let blastHits: BlastHit[] = []
    let literature: LiteratureItem[] = []
    try { summary = job.summary ? JSON.parse(job.summary) : null } catch { /* ignore */ }
    try { pdbs = job.pdbs ? JSON.parse(job.pdbs) : [] } catch { /* ignore */ }
    try { blastHits = job.blastHits ? JSON.parse(job.blastHits) : [] } catch { /* ignore */ }
    try { literature = job.literature ? JSON.parse(job.literature) : [] } catch { /* ignore */ }
    if (!summary?.scores) continue
    targets.push({
      jobId: job.id,
      label: job.uniprotId ?? summary.uniprot?.proteinName ?? '未知靶点',
      uniprotId: job.uniprotId ?? undefined,
      proteinName: summary.uniprot?.proteinName || job.uniprotId || '未知靶点',
      geneNames: summary.uniprot?.geneNames ?? [],
      organism: summary.uniprot?.organism ?? '',
      sequenceLength: summary.uniprot?.sequenceLength ?? 0,
      scores: summary.scores,
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
      oligomer: summary.oligomer,
      ligands: summary.ligands,
      mwAugment: summary.mwAugment ?? null,
      alphafold: summary.alphafold,
    })
  }
  return targets
}

// ─── LLM 三段式生成 ───────────────────────────────────────────────────────────

const SYSTEM = `你是一位资深结构生物学专家（CRO 结构解析项目负责人视角），为客户撰写多靶点合并评估报告。写作要求：
- 全文使用简体中文（专业术语可保留英文），正式书面语，不使用表情符号
- 结论先行：每章开头直接给结论，再展开论据
- 严格基于给定的数据上下文，禁止编造不存在的 PDB ID、PMID、分辨率或文献
- 数据里没有的信息，用"（本次数据未覆盖）"或"暂无可靠数据"明确说明
- 输出为 Markdown 子集：# 标题（仅首行使用一次，作为整份报告的描述性标题）/ ## / ### 标题、**加粗**、- 列表、|表格|、> 引用，不使用图片链接和代码块
- 数字引用必须与数据上下文一致`

function targetDigest(t: MergedTargetData): string {
  const lines: string[] = []
  lines.push(`### ${t.label}${t.proteinName && t.proteinName !== t.label ? `（${t.proteinName}）` : ''}`)
  if (t.geneNames.length) lines.push(`基因: ${t.geneNames.slice(0, 5).join(', ')} · 物种: ${t.organism || '—'} · 长度: ${t.sequenceLength} aa`)
  lines.push(`评分: X-ray ${t.scores.xray.score}/10 · Cryo-EM ${t.scores.cryoem.score}/10 · NMR ${t.scores.nmr.score}/10 · 总体 ${t.scores.overall.score}/10（${t.scores.overall.rating}）`)
  const ms = t.methodStats
  lines.push(`PDB 结构: ${t.directPdbs.length} 个（X-ray ${ms.xrayCount} / Cryo-EM ${ms.cryoemCount} / NMR ${ms.nmrCount}）${ms.bestResolution != null ? `，最佳 ${ms.bestResolution}Å` : ''} · 覆盖率 ${t.coveragePercent}%${t.coverageText ? `（已覆盖: ${t.coverageText.slice(0, 160)}）` : ''}${t.gapText ? ` · 未覆盖区间: ${t.gapText.slice(0, 160)}` : ''} · 配体 ${t.ligandCount} 种 · 文献 ${t.literatureCount} 篇`)
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
    const pathZh = mw.assemblyPath === 'complex' ? '已有复合物结构' : mw.assemblyPath === 'oligomer' ? '自身寡聚' : mw.assemblyPath === 'homolog-complex' ? '同源复合物推断（BLAST，需实验验证）' : '互作伙伴推断'
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

  const partA = await callPart('A', `撰写合并报告的标题与首两章。首行输出 # 开头的描述性报告标题（一行，≤30 字，不要副标题，不要包含"报告"二字、日期、编号），高度概括本批次靶点与关系类型，例如「EGFR 与 p53 抗体-抗原复合物合并评估」「MAPK 家族三成员合并结构可行性评估」「血红蛋白 α/β 异源二聚体复合物评估」。然后顺序输出以下两章（以 ## 开头，不要输出其他章节）：

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
- **一句话结论**：该靶点结构解析可行性如何、推荐方法
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

function scoreCell(item: { score: number; rating: string }): string {
  return `${item.score}/10 · ${esc(item.rating)}`
}

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
  /** v1.22：共有结构（同一 PDB 覆盖多个输入 UniProt）；未传时内部从 targets 计算 */
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
  const { targets, relation } = input
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
  const sharedStructures = input.sharedStructures ?? computeSharedStructures(targets)
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
  // v2.11：各靶点结构/同源/文献明细一律默认折叠（避免过多次要信息干扰阅读；
  // 打印时自动展开）— 阅读动线：批次级（分析 + 共有结构）→ 靶点简报 → 需要时展开明细
  // 每靶点锚点：目录「靶点速览」直达对应结构折叠块
  const anchorOf = (t: MergedTargetData) => `struct-${(t.uniprotId ?? t.label).replace(/[^A-Za-z0-9]/g, '')}`

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
  // v2.12：预算警告按靶点分组（随简报卡展示，不再集中首页 — 独立页内直接对应）
  const afBudgetWarnsBy = new Map<string, string[]>()
  const afWarn = (key: string, msg: string) => { const list = afBudgetWarnsBy.get(key) ?? []; list.push(msg); afBudgetWarnsBy.set(key, list) }
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
      if (!st.embeddable) {
        afWarn(t.uniprotId, `模型过大（${Math.round(st.pdbText.length / 1024)}KB > 单模型 2560KB 上限）`)
        return
      }
      if (st.pdbText.length > afBudgetLeft) {
        afWarn(t.uniprotId, `超出批次内嵌总预算（剩余 ${Math.round(afBudgetLeft / 1024)}KB）`)
        return
      }
      afViews.set(t.uniprotId, { pdbText: st.pdbText, modelId: st.meta.modelId, version: st.meta.latestVersion, globalPlddt: st.meta.globalPlddt, fracVeryHigh: st.meta.fracVeryHigh })
      afBudgetLeft -= st.pdbText.length
    } catch { /* 视图降级 — 统计信息 */ }
  }))
  const af3dBundle = afViews.size > 0 ? await ensure3DmolBundle() : null

  // ── v2.9：各靶点单独报告（简报卡 — 基本信息 + 预测结构）──────────────────
  // 每个靶点独立一张简报：基本信息（方法评分/总体可行性/实验结构/序列覆盖/同源/
  // 文献配体/聚集形式/分子量/客户构建）+ AlphaFold 预测结构（元数据 + 交互 3D
  // 视图）。展示优先级：本次新获取的模型/元数据 > 作业摘要（作业时获取失败的
  // 靶点，本次获取成功时仍能展示完整预测结构）。
  // v2.12：简报卡不再集中首页独立章节，而是嵌入各靶点单独报告视图页（与综述/
  // PDB/同源/文献同页）；内嵌模型预算警告随卡展示（不再集中首页说明）。
  const targetKeyOf = (t: MergedTargetData) => (t.uniprotId ?? t.label).replace(/[^A-Za-z0-9]/g, '')
  const mtrCardOf = new Map<string, string>()
  targets.forEach((t, i) => {
    const ms = t.methodStats
    const view = t.uniprotId ? afViews.get(t.uniprotId) : undefined
    // 展示优先级：本次新获取的模型/元数据（新鲜）优先于作业摘要（作业时断网获取
    // 失败、本次成功的靶点仍能展示完整预测结构）；摘要 available 时以摘要为准
    const af = (t.alphafold?.available ? t.alphafold : (t.uniprotId ? afMetaFill.get(t.uniprotId) : undefined)) ?? t.alphafold
    const o = t.oligomer
    const oligoCatZh = o ? (o.category === 'monomer' ? '单体' : o.category === 'homo-oligomer' ? '同源寡聚体' : o.category === 'hetero-complex' ? '异源复合物' : '未知') : ''
    const sharedBlast = t.blastStatus?.status === 'ok' && /共享自家族代表/.test(t.blastStatus.note ?? '')
    const scoreTone = t.scores.overall.score >= 7 ? '#047857' : t.scores.overall.score >= 4 ? '#b45309' : '#92400e'
    // 预测结构（AlphaFold）区块：本次获取到可内嵌模型 → 交互 3D 视图；
    // 仅元数据（模型超限/下载失败但摘要可用）→ 统计卡；无预测 → 说明行
    const afStatsLine = view
      ? `${esc(view.modelId)} · v${view.version} · 平均 pLDDT ${view.globalPlddt ?? '—'}${view.fracVeryHigh != null ? ` · pLDDT ≥90 区段 ${Math.round(view.fracVeryHigh * 100)}%` : ''}`
      : af?.available
        ? `${esc(af.modelId ?? 'AF 模型')} · v${af.version ?? '?'} · 平均 pLDDT ${af.globalPlddt ?? '—'}${af.fracVeryHigh != null ? ` · pLDDT ≥90 区段 ${Math.round(af.fracVeryHigh * 100)}%` : ''}`
        : ''
    const afHtml = view
        ? `<figure class="af-fig mtr-fig">
          <div class="af-stage" data-maf="${esc(t.uniprotId ?? '')}">
            <div class="af-canvas"></div>
            <img class="af-poster" alt="AlphaFold 预测结构（pLDDT 着色）">
          </div>
          <div class="af-legend">
            <span><i style="background:#0053D6"></i>pLDDT ≥ 90</span>
            <span><i style="background:#65CBF3"></i>70–90</span>
            <span><i style="background:#FFDB13"></i>50–70</span>
            <span><i style="background:#FF7D45"></i>&lt; 50</span>
          </div>
          <figcaption><b>预测结构</b> · 拖拽旋转 · 滚轮缩放 · 可全屏放大<br>${afStatsLine} · ${Math.round(view.pdbText.length / 1024)}KB 内嵌模型<br><a href="https://alphafold.ebi.ac.uk/entry/${esc(t.uniprotId ?? '')}" target="_blank" rel="noopener">alphafold.ebi.ac.uk →</a></figcaption>
        </figure>`
      : af?.available
        ? `<div class="mtr-af-stat">
          <div class="mtr-af-stat-line">${afStatsLine}</div>
          <div class="mtr-af-stat-note">模型体积超出内嵌预算或本次获取失败 — 交互视图请前往 AlphaFold DB（下方链接）或该靶点的单独评估报告</div>
          <a class="mtr-af-link" href="https://alphafold.ebi.ac.uk/entry/${esc(t.uniprotId ?? '')}" target="_blank" rel="noopener">alphafold.ebi.ac.uk →</a>
        </div>`
        : `<p class="mtr-af-none">${af?.note ? esc(af.note) : t.uniprotId ? '该靶点在 AlphaFold DB 无预测模型' : '（序列输入未归属 UniProt — 无 AlphaFold 预测）'}</p>`
    return mtrCardOf.set(targetKeyOf(t), `
    <article class="mtr-card" id="mtr-${esc(targetKeyOf(t))}">
      <div class="mtr-head">
        <span class="mtr-no">${i + 1}</span>
        <span class="mtr-name">${esc(t.proteinName)}</span>
        ${t.uniprotId ? `<a class="mtr-id" href="https://www.uniprot.org/uniprotkb/${t.uniprotId}" target="_blank" rel="noopener">${t.uniprotId}</a>` : '<span class="mtr-id mtr-id-na">无 UniProt</span>'}
        <span class="mtr-meta">${esc(t.geneNames.slice(0, 3).join('/') || '—')} · ${esc(t.organism || '—')} · ${t.sequenceLength} aa</span>
        <span class="mtr-score" style="color:${scoreTone}">总体 ${t.scores.overall.score}/10 · ${esc(t.scores.overall.rating)}</span>
      </div>
      <div class="mtr-body">
        <div class="mtr-info">
          <h4>基本信息</h4>
          <dl class="mtr-dl">
            <div><dt>方法评分</dt><dd>X-ray ${t.scores.xray.score}/10 · Cryo-EM ${t.scores.cryoem.score}/10 · NMR ${t.scores.nmr.score}/10${t.scores.oligomerAdjust ? '（含聚集形式调整）' : ''}</dd></div>
            <div><dt>总体可行性</dt><dd><b style="color:${scoreTone}">${t.scores.overall.score}/10</b>（${esc(t.scores.overall.rating)}）</dd></div>
            <div><dt>实验结构</dt><dd>${t.directPdbs.length ? `${t.directPdbs.length} 个（X-ray ${ms.xrayCount} / Cryo-EM ${ms.cryoemCount} / NMR ${ms.nmrCount}）${ms.bestResolution != null ? ` · 最佳 ${ms.bestResolution.toFixed(2)}Å` : ''}` : '无直接关联 PDB 结构'}</dd></div>
            <div><dt>序列覆盖</dt><dd>${t.coveragePercent}%${t.coverageText ? `（已覆盖 ${esc(t.coverageText.slice(0, 120))}）` : ''}${t.gapText ? ` · 空白 ${esc(t.gapText.slice(0, 120))}` : ''}</dd></div>
            <div><dt>同源结构</dt><dd>${t.blastHits.length} 个${sharedBlast ? '（共享自家族代表，未单独检索）' : ''}${!sharedBlast && t.blastStatus?.note ? `（${esc(t.blastStatus.note.slice(0, 60))}）` : ''}</dd></div>
            <div><dt>文献 / 配体</dt><dd>${t.literatureCount} 篇 · ${t.ligandCount} 种</dd></div>
            ${o ? `<div><dt>聚集形式</dt><dd>${oligoCatZh}${o.stoichiometry ? `（${esc(o.stoichiometry)}）` : ''} · 置信度${esc(describeOligoConfidence(o.confidence))}</dd></div>` : ''}
            ${t.mwAugment?.applicable ? `<div><dt>分子量</dt><dd>单体 ~${t.mwAugment.monomerKda} kDa${t.mwAugment.assemblyKda != null ? ` → 装配 ~${t.mwAugment.assemblyKda} kDa` : '（无生物装配增重路径）'}</dd></div>` : ''}
            ${t.construct ? `<div><dt>客户构建</dt><dd>${t.construct.providedLength} aa（与全长一致性 ${t.construct.identity}%${t.construct.start != null && t.construct.end != null ? `，区间 ${t.construct.start}-${t.construct.end}` : ''}）</dd></div>` : ''}
          </dl>
        </div>
        <div class="mtr-af">
          <h4>预测结构（AlphaFold）</h4>
          ${afHtml}
          ${(afBudgetWarnsBy.get(t.uniprotId ?? t.label) ?? []).length ? `<p class="note" style="margin-top:8px">内嵌模型预算提示：${esc((afBudgetWarnsBy.get(t.uniprotId ?? t.label) ?? []).join('；'))} — 本页仅展示统计信息。</p>` : ''}
        </div>
      </div>
    </article>`)
  })

  // 3Dmol bundle 一次内嵌 + 多视图初始化（所有 data-maf 阶段共用同一实现与 pLDDT 着色）
  // 无可内嵌模型（全部靶点无预测/超预算）时整段省略 — 报告不携带死脚本
  // MODELS 映射为 UniProt → 模型 PDB 文本（纯字符串 — plddtStyleApplyJs 直接消费）
  // v2.12：懒初始化 — 只初始化「当前可见视图」内的阶段（隐藏视图的 canvas 尺寸
  // 为 0，盲初始化会渲染出空白）；视图切换时补初始化，打印前全量初始化（海报补齐）
  const afModelsJson = JSON.stringify(Object.fromEntries([...afViews].map(([k, v]) => [k, v.pdbText]))).replace(/<\//g, '<\\/')
  const mtrViewerJs = afViews.size > 0 ? `
    ${af3dBundle ? `<script>${af3dBundle.replace(/<\/script/gi, '<\\/script')}</script>` : ''}
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
  // v1.24：全部展示（移除前 60 截断）
  const sharedRows = sharedStructures.map(s => {
    const covChips = s.coverage.map(c =>
      `<span class="cov-chip" title="${esc(c.proteinName)}">${esc(c.uniprotId)}${c.chainRanges ? `<span class="cov-rng">${esc(c.chainRanges)}</span>` : ''}</span>`,
    ).join(' ')
    const lit = s.pubmedId
      ? `<a href="https://pubmed.ncbi.nlm.nih.gov/${s.pubmedId}/" target="_blank" rel="noopener">${s.pubmedId}</a>`
      : '—'
    return `
    <tr>
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
    <div class="tbl-wrap"><table class="tbl-data">
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
          <span class="tgt-inline">${esc(t.proteinName)}${t.uniprotId ? `（${t.uniprotId}）` : ''}</span>
          <span class="oligo-badge" style="background:${oligoBadgeOf(o.category)}">${esc(oligoCatOf(o.category))}</span>
          ${o.stoichiometry ? `<span class="oligo-stoich">${esc(o.stoichiometry)}</span>` : ''}
          <span class="oligo-conf">置信度：${esc(describeOligoConfidence(o.confidence))}</span>
        </div>
        <p class="oligo-summary">${esc(o.summary)}</p>
        ${t.scores.oligomerAdjust ? `<p class="oligo-summary" style="font-size:12px">评分调整：X-ray ${t.scores.oligomerAdjust.xray > 0 ? '+' : ''}${t.scores.oligomerAdjust.xray} / Cryo-EM ${t.scores.oligomerAdjust.cryoem > 0 ? '+' : ''}${t.scores.oligomerAdjust.cryoem} / NMR ${t.scores.oligomerAdjust.nmr > 0 ? '+' : ''}${t.scores.oligomerAdjust.nmr} — ${esc(t.scores.oligomerAdjust.note)}</p>` : ''}
        ${t.mwAugment?.applicable ? `<p class="oligo-summary" style="font-size:12px">分子量增重：单体 ~${t.mwAugment.monomerKda} kDa${t.mwAugment.assemblyKda != null ? ` → 装配 ~${t.mwAugment.assemblyKda} kDa（${t.mwAugment.assemblyPath === 'complex' ? '已有复合物结构' : t.mwAugment.assemblyPath === 'oligomer' ? '自身寡聚' : t.mwAugment.assemblyPath === 'homolog-complex' ? '同源复合物推断（BLAST）' : '互作伙伴推断'}）` : '（无生物装配路径）'}${t.scores.mwAugmentAdjust ? `；Cryo-EM 调整 ${t.scores.mwAugmentAdjust.cryoem > 0 ? '+' : ''}${t.scores.mwAugmentAdjust.cryoem} — ${esc(t.scores.mwAugmentAdjust.note)}` : ''}${(t.mwAugment.homologComplexes ?? []).length ? `<br>同源复合物：${(t.mwAugment.homologComplexes ?? []).map(h => `${h.pdbId}（identity ${Math.round(h.identity)}%，靶点换算 ~${h.estimatedKda} kDa）`).join('、')}` : (t.mwAugment.homologSearchNote ? `<br>${esc(t.mwAugment.homologSearchNote)}` : '')}</p>` : ''}
        ${o.evidence.length ? `<div class="oligo-ev">${o.evidence.map(e => `<div class="oligo-ev-line"><span class="oligo-ev-src">${esc(describeEvidenceSource(e.source))}</span><span class="oligo-ev-ref">${esc(e.ref)}</span><span class="oligo-ev-text">${esc(e.text)}</span></div>`).join('')}</div>` : ''}
      </div>`
      }).join('')}
    </details>` : ''

  // v2.8 报告格式优化：靶点卡 → mini 仪表盘（补结构/覆盖率/同源/文献关键数字，
  // 多靶点批次可不经对比矩阵直接在刊头扫读各靶点研究现状）
  // v2.12：靶点卡整体可点 — 点击进入该靶点的单独报告页（综述/简报/单独结构同页；
  // 卡内 UniProt 链接除外 — 点击仍跳 UniProt）；卡底「单独报告 →」为明确入口提示
  const targetMeta = targets.map(t => {
    const o = t.oligomer
    const ms = t.methodStats
    return `
    <div class="tgt-card" data-goto="target-${targetKeyOf(t)}" title="查看 ${esc(t.proteinName)} 的单独报告页（综述 / 基本信息 / 预测结构 / PDB / 同源 / 文献）">
      <div class="tgt-name">${esc(t.proteinName)}${t.uniprotId ? ` <a href="https://www.uniprot.org/uniprotkb/${t.uniprotId}" target="_blank" rel="noopener">${t.uniprotId}</a>` : ''}</div>
      <div class="tgt-meta">${esc(t.geneNames.slice(0, 3).join('/') || '—')} · ${esc(t.organism || '—')} · ${t.sequenceLength} aa</div>
      ${o ? `<div class="tgt-oligo"><span class="oligo-badge" style="background:${oligoBadgeOf(o.category)}">${esc(oligoCatOf(o.category))}</span>${o.stoichiometry ? `<span class="oligo-stoich">${esc(o.stoichiometry)}</span>` : ''}<span class="tgt-oligo-conf">置信度${esc(describeOligoConfidence(o.confidence))}</span></div>` : ''}
      <div class="tgt-score">总体 <b>${t.scores.overall.score}</b>/10 · ${esc(t.scores.overall.rating)}${t.scores.oligomerAdjust ? '<span class="tgt-oligo-adj">含聚集形式调整</span>' : ''}</div>
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
    <div class="glance-foot">阅读路径：本页（复合物评估）先读「${noLlm} 合并评估分析」与「${noShared} 共有结构」（复合物级结论与共同结构证据/文献）→ 点击刊头靶点卡片或目录「靶点单独报告」进入各靶点单独报告页（结构可行性综述 + 基本信息 + 预测结构 + 该靶点 PDB/同源/文献同页），页内「返回报告首页」随时回到本页；打印时全部页面依序输出。</div>
  </section>`

  // v2.8 报告格式优化：对比矩阵扩列（同源结构/文献/寡聚态）+ 总体分附评级 —
  // 多靶点批次的一张表即可横向比较全部关键可行性指标
  const matrixRows = targets.map(t => `
    <tr>
      <td class="td-id">${t.uniprotId ? `<a href="https://www.uniprot.org/uniprotkb/${t.uniprotId}" target="_blank" rel="noopener">${t.uniprotId}</a>` : '—'}</td>
      <td class="t-title">${esc(t.proteinName)}</td>
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

  // v2.11：每靶点折叠块带锚点 · 默认折叠（避免过多次要信息干扰阅读，打印自动
  // 展开）；行内 ◈ 徽标与「共有结构」章节互证，摘要行给共有/单独结构计数。
  // v2.12：各靶点 PDB/同源/文献折叠块不再集中首页独立章节，而是嵌入该靶点的
  // 单独报告视图页（单独评估与单独结构同页）— key → 折叠块 HTML 映射。
  const pdbFoldOf = new Map<string, string>()
  targets.forEach(t => {
    if (!t.directPdbs.length) { pdbFoldOf.set(targetKeyOf(t), ''); return }
    const tShared = t.directPdbs.filter(p => sharedIds.has(p.pdbId)).length
    // v1.24：全部展示（移除前 12 截断）
    const rows = t.directPdbs.map(p => `
      <tr>
        <td class="td-id">${sharedIds.has(p.pdbId) ? '<span class="sh-mark" title="共有结构 — 该 PDB 同时覆盖本批次多个输入靶点，见共有结构章节">◈</span>' : ''}<a href="https://www.rcsb.org/structure/${p.pdbId}" target="_blank" rel="noopener">${p.pdbId}</a></td>
        <td><span class="mth mth-${p.isXray ? 'xray' : p.isCryoem ? 'cryoem' : p.isNmr ? 'nmr' : 'other'}">${p.isXray ? 'X-ray' : p.isCryoem ? 'Cryo-EM' : p.isNmr ? 'NMR' : esc(p.method.slice(0, 10))}</span></td>
        <td class="num">${p.resolution != null ? p.resolution.toFixed(2) : '—'}</td>
        <td class="t-title">${esc(p.title.slice(0, 80))}</td>
        <td class="num">${esc(p.releaseDate.slice(0, 4))}</td>
      </tr>`).join('')
    pdbFoldOf.set(targetKeyOf(t), `
    <details class="pdb-fold" id="${anchorOf(t)}">
      <summary>${esc(t.proteinName)}${t.uniprotId ? `（${t.uniprotId}）` : ''} — ${t.directPdbs.length} 个结构（全部）${tShared ? ` · <span class="sh-sum">共有 ${tShared} / 单独 ${t.directPdbs.length - tShared}</span>` : ' · 单独结构'}</summary>
      <div class="tbl-wrap"><table>
        <colgroup><col style="width:78px"><col style="width:70px"><col style="width:64px"><col><col style="width:56px"></colgroup>
        <thead><tr><th>PDB</th><th>方法</th><th>分辨率</th><th>标题</th><th>年份</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </details>`)
  })

  // v1.11 同源结构（BLAST/序列检索命中 — 含共享自家族代表的标注，可溯源归属靶点）
  const blastFoldOf = new Map<string, string>()
  targets.forEach(t => {
    if (!t.blastHits.length) { blastFoldOf.set(targetKeyOf(t), ''); return }
    const shared = t.blastStatus?.status === 'ok' && /共享自家族代表/.test(t.blastStatus.note ?? '')
    // v1.24：全部展示（移除前 10 截断）
    const rows = t.blastHits.map(h => `
      <tr>
        <td class="td-id"><a href="https://www.rcsb.org/structure/${h.pdbId}" target="_blank" rel="noopener">${h.pdbId || '—'}</a></td>
        <td class="t-title">${esc(h.description.slice(0, 84))}</td>
        <td class="num">${h.identity}%</td>
        <td class="num">${h.resolution != null ? h.resolution.toFixed(2) + 'Å' : '—'}</td>
        <td class="t-title">${esc((h.method || '').slice(0, 16))}</td>
      </tr>`).join('')
    blastFoldOf.set(targetKeyOf(t), `
    <details class="pdb-fold" id="blast-${anchorOf(t)}">
      <summary>${esc(t.proteinName)}${t.uniprotId ? `（${t.uniprotId}）` : ''} — ${t.blastHits.length} 个同源结构（全部）${shared ? ' · <span style="font-weight:400;font-size:12px">共享自家族代表，未单独检索</span>' : ''}</summary>
      <div class="tbl-wrap"><table>
        <colgroup><col style="width:74px"><col><col style="width:64px"><col style="width:70px"><col style="width:80px"></colgroup>
        <thead><tr><th>PDB</th><th>描述</th><th>Identity</th><th>分辨率</th><th>方法</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </details>`)
  })

  // v1.11 各靶点文献（PMID 可点击；结构解析文献标记；归属靶点清晰可辨）
  // v2.12：移入各靶点单独报告页（首页只保留共有结构文献）
  const litFoldOf = new Map<string, string>()
  targets.forEach(t => {
    if (!t.literature.length) { litFoldOf.set(targetKeyOf(t), ''); return }
    // v1.24：全部展示（移除前 10 截断）
    const rows = t.literature.map(l => `
      <tr>
        <td class="td-id">${l.pmid ? `<a href="https://pubmed.ncbi.nlm.nih.gov/${l.pmid}/" target="_blank" rel="noopener">${esc(l.pmid)}</a>` : '—'}</td>
        <td class="t-title">${esc(l.title.slice(0, 110))}${l.fromPdb ? ' <span class="mth" style="background:#ecfdf5;color:#047857">结构解析文献</span>' : ''}</td>
        <td class="t-title">${esc(l.journal.slice(0, 30))}</td>
        <td class="num">${esc(l.year || '—')}</td>
      </tr>`).join('')
    litFoldOf.set(targetKeyOf(t), `
    <details class="pdb-fold" id="lit-${anchorOf(t)}">
      <summary>${esc(t.proteinName)}${t.uniprotId ? `（${t.uniprotId}）` : ''} — ${t.literature.length} 篇（全部）</summary>
      <div class="tbl-wrap"><table>
        <colgroup><col style="width:76px"><col><col style="width:150px"><col style="width:52px"></colgroup>
        <thead><tr><th>PMID</th><th>标题</th><th>期刊</th><th>年份</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </details>`)
  })

  const figHtml = embedded.length ? `
  <section class="sec" id="assets">
    <h2>${secHead(noAssets, `客户实验数据（${embedded.length} 张）`, 'Experimental Data')}</h2>
    ${embedded.map(({ meta, dataUri }) => `
    <figure class="fig">
      <img src="${dataUri}" alt="${esc(meta.caption)}" loading="lazy">
      <figcaption><span class="fig-tag fig-${meta.kind}">${meta.kind === 'gel' ? 'SDS-PAGE' : meta.kind === 'sec' ? 'SEC' : '图'}</span>${meta.vlmKind ? '<span class="fig-tag fig-ai">AI 视觉识别</span>' : ''}${esc(meta.caption)}</figcaption>
    </figure>`).join('')}
  </section>` : ''

  // v1.15：评估表 AI 解析要点（LLM 失败时作为兜底证据；正常时作为可溯源原始要点）
  // v2.0：配体研究数据（批次共享，取首个有数据的靶点）
  const batchLigands = targets.find(t => (t.ligands?.length ?? 0) > 0)?.ligands ?? []
  // v2.7.6 ⑤：配体卡补 2D 结构式 —— 渲染前兜底充实（v2.7 前旧作业 detail 缺失补全；
  // PNG-only 详情回补 SVG 矢量版，磁盘缓存命中零网络开销）
  await Promise.all(batchLigands.filter(l => l.ok).map(async l => {
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

  // ── v2.12 ②：各靶点单独报告视图页 ─────────────────────────────────────────
  // 单独评估与单独结构同页：结构可行性综述（LLM 章节拆分归属）+ 单独报告卡（基本
  // 信息 + AlphaFold 预测结构交互 3D）+ 该靶点 PDB/同源/文献明细（默认折叠，打印
  // 自动展开）。页首「← 返回报告首页」+ 页脚上一/下一靶点导航；hash 深链
  // #view-target-<ID> 可直达；打印时所有视图依序输出、靶点页另起一页。
  const scoreToneOf = (t: MergedTargetData) => t.scores.overall.score >= 7 ? '#047857' : t.scores.overall.score >= 4 ? '#b45309' : '#92400e'
  const targetViews = targets.map((t, i) => {
    const key = targetKeyOf(t)
    const reviewMd = reviewByTarget.get(t.uniprotId ?? t.label)
    const mtrCard = mtrCardOf.get(key) ?? ''
    const pdbFold = pdbFoldOf.get(key) ?? ''
    const blastFold = blastFoldOf.get(key) ?? ''
    const litFold = litFoldOf.get(key) ?? ''
    const tShared = t.directPdbs.filter(p => sharedIds.has(p.pdbId)).length
    const scoreTone = scoreToneOf(t)
    const prev = i > 0 ? targets[i - 1] : null
    const next = i < targets.length - 1 ? targets[i + 1] : null
    let tnoSeq = 0
    const tno = () => String(++tnoSeq).padStart(2, '0')
    const reviewHtml = reviewMd
      ? renderMarkdown(reviewMd, 1)
      : input.llmOk
        ? `<p class="note">该靶点的综述小节未能从合并分析章节中归属（LLM 小节标题偏离预期，内容未丢失）— 完整综述请「← 返回报告首页」查看「${noLlm} 合并评估分析」章节。</p>`
        : `<div class="warn-box">LLM 分析生成失败（${esc(input.llmErrors.join('；')) || '未知原因'}）— 该靶点无综述内容，以下为系统收集的确定性数据（基本信息 / 预测结构 / PDB / 同源 / 文献）。</div>`
    const navChip = (tgt: MergedTargetData | null, dir: 'prev' | 'next') => tgt
      ? `<a class="tgt-nav-chip" data-goto="target-${targetKeyOf(tgt)}" href="#view-target-${targetKeyOf(tgt)}" title="${esc(tgt.proteinName)}（${esc(tgt.uniprotId ?? tgt.label)}）">${dir === 'prev' ? '← ' : ''}${esc(tgt.uniprotId ?? tgt.label)}${dir === 'next' ? ' →' : ''}</a>`
      : ''
    return `
  <div class="rpt-view" id="view-target-${key}">
    <header class="tgt-page-head">
      <button type="button" class="tgt-back" data-goto="home">← 返回报告首页</button>
      <div class="tgt-page-eyebrow">TargetEval · Per-Target Report · 靶点单独报告 ${i + 1}/${targets.length}</div>
      <h1 class="tgt-page-name">${esc(t.proteinName)}${t.uniprotId ? ` <a class="tgt-page-id" href="https://www.uniprot.org/uniprotkb/${t.uniprotId}" target="_blank" rel="noopener">${t.uniprotId}</a>` : ''}</h1>
      <div class="tgt-page-meta">${esc(t.geneNames.slice(0, 3).join('/') || '—')} · ${esc(t.organism || '—')} · ${t.sequenceLength} aa · 总体 <b style="color:${scoreTone}">${t.scores.overall.score}/10</b>（${esc(t.scores.overall.rating)}）· PDB <b>${t.directPdbs.length}</b> 个${t.directPdbs.length ? `（共有 ${tShared} / 单独 ${t.directPdbs.length - tShared}）` : ''} · 同源 ${t.blastHits.length} · 文献 ${t.literature.length}</div>
    </header>
    <section class="sec">
      <h2>${secHead(tno(), '结构可行性综述', 'Feasibility Review')}</h2>
      ${reviewHtml}
    </section>
    <section class="sec">
      <h2>${secHead(tno(), '单独报告（基本信息 + 预测结构）', 'Target Report')}</h2>
      ${mtrCard}
    </section>
    <section class="sec">
      <h2>${secHead(tno(), `PDB 结构（${t.directPdbs.length} 个${tShared ? ` · 共有 ${tShared}` : ''} · 默认折叠）`, 'Structures')}</h2>
      <p class="note">该靶点直接关联的 PDB 结构明细（默认折叠，打印自动展开）；◈ 徽标为共有结构（同时覆盖本批次多个输入靶点，见首页「${noShared} 共有结构」章节）。</p>
      ${pdbFold || '<p>该靶点暂无直接关联 PDB 结构 — 构建边界可参考上方 AlphaFold 预测与下方同源结构。</p>'}
    </section>
    ${blastFold ? `
    <section class="sec">
      <h2>${secHead(tno(), `同源结构（${t.blastHits.length} 个 · BLAST/序列检索 · 默认折叠）`, 'Homologous Structures')}</h2>
      <p class="note">该靶点经 BLAST（NCBI pdbaa）或 RCSB 序列检索（NCBI 拥堵时兜底）获得的同源结构命中，已排除该靶点自身的直接结构。</p>
      ${blastFold}
    </section>` : ''}
    ${litFold ? `
    <section class="sec">
      <h2>${secHead(tno(), `文献（${t.literature.length} 篇 · 默认折叠）`, 'Literature')}</h2>
      <p class="note">该靶点检索的 PubMed 文献（含 PDB 结构主引文，标记「结构解析文献」）。复合物级共有结构文献见首页「${noShared} 共有结构」章节。</p>
      ${litFold}
    </section>` : ''}
    <div class="tgt-page-foot">
      <button type="button" class="tgt-back" data-goto="home">← 返回报告首页</button>
      <div class="tgt-page-nav">
        ${navChip(prev, 'prev')}
        <span class="tgt-nav-pos">${i + 1} / ${targets.length}</span>
        ${navChip(next, 'next')}
      </div>
    </div>
  </div>`
  }).join('')

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
<!-- mrg-fmt-v2.12 合并报告格式版本标记：旧版落盘 HTML 无此标记时由报告路由自动升级重渲染 -->
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;600;700;900&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;0,8..60,700;1,8..60,400&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<title>${esc(reportTitle)} · ${esc(targets.map(t => t.label).join(' + '))}</title>
<style>
  .lig-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(340px,1fr)); gap:14px; margin-top:8px; }
  .lig-card { background:#fff; border:1px solid var(--line); border-radius:6px; padding:14px 18px; break-inside:avoid; }
  .lig-fail { border-style:dashed; opacity:.78; }
  .lig-head { display:flex; flex-wrap:wrap; align-items:baseline; gap:8px 10px; }
  .lig-id { font-family:ui-monospace,Menlo,monospace; font-size:14.5px; font-weight:700; color:#065f46; background:#f0fdf7; border:1px solid #b8e6d2; border-radius:4px; padding:1px 10px; letter-spacing:.5px; }
  .lig-id-fail { color:#92400e; background:#fffbeb; border-color:#fde68a; }
  .lig-name { font-size:13px; font-weight:600; color:var(--ink); overflow-wrap:anywhere; min-width:120px; }
  .lig-src { margin-left:auto; font-family:ui-monospace,Menlo,monospace; font-size:10px; color:var(--faint); letter-spacing:.4px; }
  .lig-meta { display:flex; flex-wrap:wrap; gap:4px 16px; margin-top:9px; font-size:11.5px; color:var(--sub); }
  .lig-meta b { color:var(--ink); font-weight:600; font-variant-numeric:tabular-nums; }
  .lig-pdbs { display:flex; flex-wrap:wrap; gap:6px; margin-top:10px; padding-top:10px; border-top:1px dashed #efedeb; }
  .lig-pdbs a { font-family:ui-monospace,Menlo,monospace; font-size:10.5px; font-weight:600; color:var(--accent); background:#f0fdf7; border:1px solid #c7ece0; border-radius:3px; padding:1px 8px; text-decoration:none; white-space:nowrap; }
  .lig-pdbs a i { font-style:normal; color:var(--faint); font-weight:400; margin-left:3px; }
  .lig-pdbs a.lig-also { background:#e0faf1; border-color:#71cdb2; color:#04503c; }
  .lig-pdbs a:hover { background:#d9f5e8; }
  .lig-more { align-self:center; font-family:ui-monospace,Menlo,monospace; font-size:10.5px; color:var(--faint); }
  .lig-none { font-size:12px; color:var(--faint); border-top:1px dashed #efedeb; margin-top:10px; padding-top:8px; }
  /* v2.7.6 ⑤：配体卡 2D 结构式 + 性质 + 标识符（与单靶点报告同版布局） */
  .lig-main { display:flex; gap:14px; align-items:flex-start; }
  .lig-struct { flex:0 0 150px; margin:0; text-align:center; }
  .lig-struct img { display:block; width:150px; height:150px; object-fit:contain; background:#fff; border:1px solid var(--line); border-radius:4px; padding:3px; box-shadow:0 1px 2px rgba(28,25,23,.05); }
  .lig-struct figcaption { margin-top:5px; font-size:9.5px; line-height:1.5; color:var(--faint); font-family:ui-monospace,Menlo,monospace; }
  .lig-info { flex:1 1 auto; min-width:0; }
  .lig-id-pc { color:#4c5fd7; background:#eef0fd; border-color:#c6cdf6; }
  .lig-iupac { margin-top:7px; font-size:10.5px; line-height:1.65; color:var(--faint); overflow-wrap:anywhere; }
  .lig-props { display:flex; flex-wrap:wrap; gap:4px 14px; margin-top:8px; padding-top:8px; border-top:1px dashed #efedeb; font-size:11px; color:var(--sub); }
  .lig-props b { color:var(--ink); font-weight:600; font-variant-numeric:tabular-nums; }
  .lig-fold { margin:8px 0 0; border-radius:4px; padding:4px 8px; }
  .lig-fold > summary { font-size:11.5px; color:var(--accent-2); }
  .lig-ident { font-size:11px; color:var(--sub); line-height:1.9; overflow-wrap:anywhere; }
  .lig-ident b { color:var(--ink); font-weight:600; margin-right:4px; }
  .lig-ident .mono { font-size:10px; color:var(--sub); font-family:ui-monospace,Menlo,monospace; }
  @media (max-width:560px){ .lig-main{flex-direction:column; align-items:center} .lig-info{align-self:stretch} .lig-struct{flex-basis:auto} }
  :root { --ink:#1c1917; --sub:#57534e; --faint:#a8a29e; --line:#e7e5e4; --hairline:#efedeb; --accent:#047857; --accent-2:#059669; --accent-bg:#f0fdf7; --paper:#ffffff; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:"Source Serif 4","Noto Serif SC","Source Han Serif SC","Songti SC",Georgia,serif; background:#fcfcfb; color:var(--ink); font-size:15px; line-height:1.92; }
  .page { max-width:920px; margin:0 auto; background:var(--paper); padding:56px 56px 48px; box-shadow:0 0 0 1px var(--hairline); }
  .rpt-head { border-bottom:1px solid var(--ink); position:relative; padding-bottom:22px; margin-bottom:26px; }
  .rpt-head::after { content:''; position:absolute; left:0; bottom:3px; width:100%; border-bottom:3px solid var(--ink); }
  .rpt-eyebrow { font-family:ui-monospace,Menlo,monospace; font-size:11px; letter-spacing:2.5px; color:var(--accent); text-transform:uppercase; margin-bottom:10px; }
  .rpt-title { font-size:27px; font-weight:700; line-height:1.35; margin-bottom:6px; }
  .rpt-subtitle { font-size:14px; color:var(--sub); margin-bottom:16px; }
  .rel-box { background:#ecfdf5; border:1px solid #a7f3d0; border-left:4px solid var(--accent); border-radius:5px; padding:14px 18px; margin:14px 0 4px; font-size:13px; color:#064e3b; }
  .rel-box b { color:#064e3b; }
  .tgt-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:10px; margin:14px 0; }
  .tgt-card { border:1px solid var(--line); border-radius:5px; padding:10px 14px; background:#fff; }
  .tgt-name { font-weight:600; font-size:14px; } .tgt-name a { color:var(--accent-2); text-decoration:none; }
  .tgt-meta { font-size:11.5px; color:var(--sub); margin-top:2px; }
  .tgt-score { font-size:12px; color:var(--accent); margin-top:4px; }
  .meta-line { font-family:ui-monospace,Menlo,monospace; font-size:11.5px; color:var(--sub); margin-top:10px; }
  .badge { display:inline-block; border:1px solid var(--accent); color:var(--accent); border-radius:99px; padding:2px 12px; font-size:11.5px; margin:10px 6px 0 0; font-family:ui-monospace,Menlo,monospace; }
  .badge.amber { border-color:#d97706; color:#b45309; }
  .toc { border:1px solid var(--line); border-radius:5px; padding:12px 20px; margin:20px 0 30px; font-size:13px; background:#fdfdfc; }
  .toc b { font-family:ui-monospace,Menlo,monospace; font-size:11px; letter-spacing:1.5px; color:var(--sub); }
  .toc ol { margin:6px 0 0 20px; columns:2; column-gap:36px; } .toc a { color:var(--accent-2); text-decoration:none; }
  /* v2.11：目录内共有结构条目突出（绿色加粗 + ◈ 前缀 — 批次核心证据章节） */
  .toc-shared { color:#065f46; font-weight:700; }
  .toc-shared::before { content:'◈ '; color:var(--accent); }
  /* v2.8：靶点速览导航（目录内 — 每靶点直达其结构折叠块锚点） */
  .toc-targets { margin-top:10px; padding-top:10px; border-top:1px dashed var(--line); display:flex; flex-wrap:wrap; align-items:center; gap:6px 8px; }
  .toc-targets b { font-size:11px; }
  .toc-targets a { font-family:ui-monospace,Menlo,monospace; font-size:11px; color:var(--accent-2); background:#f0fdf7; border:1px solid #c7ece0; border-radius:3px; padding:1px 9px; text-decoration:none; white-space:nowrap; }
  .toc-targets a:hover { background:#d9f5e8; }
  /* ── v2.12：视图分层（首页 = 复合物评估；每靶点单独报告独立视图页）── */
  .rpt-view { display:none; }
  .rpt-view.rpt-view-on { display:block; }
  .tgt-card[data-goto] { cursor:pointer; transition:border-color .15s, box-shadow .15s; }
  .tgt-card[data-goto]:hover { border-color:#a7f3d0; box-shadow:0 2px 10px rgba(4,120,87,.10); }
  .tgt-open { margin-top:7px; padding-top:7px; border-top:1px dashed var(--line); font-family:ui-monospace,Menlo,monospace; font-size:10.5px; font-weight:600; letter-spacing:.5px; color:var(--accent-2); }
  .tgt-card[data-goto]:hover .tgt-open { color:#047857; }
  .tgt-page-head { position:relative; border-bottom:1px solid var(--ink); padding-bottom:18px; margin-bottom:26px; }
  .tgt-page-head::after { content:''; position:absolute; left:0; bottom:3px; width:100%; border-bottom:3px solid var(--ink); }
  .tgt-back { display:inline-flex; align-items:center; gap:5px; font-family:ui-monospace,Menlo,monospace; font-size:11px; font-weight:600; letter-spacing:.5px; color:var(--accent-2); background:#f0fdf7; border:1px solid #c7ece0; border-radius:5px; padding:5px 13px; cursor:pointer; }
  .tgt-back:hover { background:#d9f5e8; color:#047857; }
  .tgt-page-eyebrow { font-family:ui-monospace,Menlo,monospace; font-size:11px; letter-spacing:2.5px; color:var(--accent); text-transform:uppercase; margin:10px 0 8px; }
  .tgt-page-name { font-size:24px; font-weight:700; line-height:1.35; margin:0 0 7px; }
  .tgt-page-id { font-family:ui-monospace,Menlo,monospace; font-size:14px; font-weight:700; color:#065f46; background:#f0fdf7; border:1px solid #b8e6d2; border-radius:4px; padding:1px 10px; letter-spacing:.5px; text-decoration:none; vertical-align:2px; margin-left:6px; white-space:nowrap; }
  .tgt-page-id:hover { background:#d9f5e8; }
  .tgt-page-meta { font-size:12.5px; color:var(--sub); line-height:1.9; }
  .tgt-page-meta b { font-variant-numeric:tabular-nums; }
  .tgt-page-foot { margin-top:38px; padding-top:16px; border-top:1px solid var(--line); display:flex; flex-wrap:wrap; align-items:center; gap:10px 12px; }
  .tgt-page-nav { margin-left:auto; display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
  .tgt-nav-chip { font-family:ui-monospace,Menlo,monospace; font-size:11px; font-weight:600; color:var(--accent-2); background:#f0fdf7; border:1px solid #c7ece0; border-radius:3px; padding:1px 9px; text-decoration:none; white-space:nowrap; }
  .tgt-nav-chip:hover { background:#d9f5e8; }
  .tgt-nav-pos { font-family:ui-monospace,Menlo,monospace; font-size:11px; color:var(--faint); }
  /* v2.12 ④：序列一致性矩阵 — 表头/行标/数值全部居中（列内容与表头严格对齐）；
  行标改用正文风格（此前沿用 th 表头样式 uppercase/字距/粗底边，观感错位） */
  table.idm { margin:12px auto; max-width:100%; }
  table.idm thead th { text-align:center; }
  table.idm tbody th { font-family:ui-monospace,Menlo,monospace; font-size:12px; font-weight:600; color:#1c1917; background:#fafaf8; text-transform:none; letter-spacing:0; padding:6px 10px; border-bottom:1px solid var(--line); white-space:nowrap; }
  table.idm th, table.idm td, table.idm td.num { text-align:center; }
  table.idm td.num { font-size:12.5px; }
  table.idm .idm-corner { font-size:10px; color:var(--faint); letter-spacing:1px; }
  table.idm .idm-diag { background:#f7f7f5; color:#a8a29e; }
  table.idm .idm-val { font-weight:600; }
  @media print {
    .rpt-view { display:block !important; }
    .rpt-view + .rpt-view { break-before:page; }
    .tgt-back, .tgt-open, .tgt-page-nav, .tgt-nav-pos { display:none !important; }
  }
  /* 打印前临时全展开（beforeprint JS 挂载 — 隐藏视图中的 3D 阶段先拿到真实尺寸再初始化） */
  .rpt-print-all .rpt-view { display:block !important; }
  /* v2.8：章节编号方块（与单靶点报告同构 — 连续编号替代原断续的「一/二/三」） */
  .sec h2 .sec-no { flex:none; width:30px; height:30px; background:var(--ink); color:#fff; display:inline-flex; align-items:center; justify-content:center; font-size:14px; font-weight:700; border-radius:5px; font-family:ui-monospace,Menlo,monospace; }
  .sec h2 .sec-title { min-width:0; }
  /* v2.8：靶点卡 mini 仪表盘（结构/覆盖率/同源/文献关键数字） */
  .tgt-stats { display:flex; flex-wrap:wrap; gap:4px 12px; margin-top:6px; padding-top:6px; border-top:1px dashed var(--line); font-size:10.5px; color:var(--sub); font-variant-numeric:tabular-nums; }
  .tgt-stats b { color:var(--ink); font-weight:600; }
  /* v2.8：对比矩阵扩列 — 评级副文本与寡聚态列占位 */
  .mtx-rating { display:block; font-size:10px; color:var(--sub); font-weight:400; line-height:1.4; }
  .mtx-dash { color:var(--faint); }
  /* v2.10 ②：评估表问题回应卡（LLM 逐条回答 — 内嵌于「客户评估表要点」的目标/问题条目内） */
  .qa-ans { margin:7px 0 3px; padding:9px 14px 7px; background:#ecfdf5; border:1px solid #a7f3d0; border-left:3px solid var(--accent); border-radius:4px; font-size:13px; line-height:1.9; text-align:justify; }
  .qa-ans .qa-tag { display:inline-block; font-family:ui-monospace,Menlo,monospace; font-size:9.5px; font-weight:700; letter-spacing:1.5px; color:#047857; text-transform:uppercase; margin-bottom:4px; }
  .qa-ans .qa-tag-q { color:#065f46; }
  .qa-ans p { font-size:13px; margin:4px 0; }
  .qa-ans ul { margin:4px 0 4px 18px; font-size:12.5px; } .qa-ans li { margin:2px 0; }
  .qa-ans blockquote { margin:6px 0; font-size:12px; }
  .qa-ans table { font-size:11.5px; } .qa-ans th, .qa-ans td { padding:4px 8px; }
  @media print { .qa-ans { break-inside:avoid-page; } }
  /* ── v2.9：各靶点单独报告（简报卡 — 基本信息 + AlphaFold 预测结构）── */
  .mtr-list { display:flex; flex-direction:column; gap:14px; margin-top:8px; }
  .mtr-card { border:1px solid var(--line); border-radius:6px; background:#fff; padding:16px 20px 14px; break-inside:avoid-page; }
  .mtr-head { display:flex; flex-wrap:wrap; align-items:baseline; gap:6px 10px; border-bottom:1px dashed var(--line); padding-bottom:9px; }
  .mtr-no { flex:none; width:22px; height:22px; display:inline-flex; align-items:center; justify-content:center; background:var(--ink); color:#fff; border-radius:4px; font-family:ui-monospace,Menlo,monospace; font-size:11.5px; font-weight:700; }
  .mtr-name { font-weight:700; font-size:15px; color:var(--ink); }
  .mtr-id { font-family:ui-monospace,Menlo,monospace; font-size:12.5px; font-weight:700; color:#065f46; background:#f0fdf7; border:1px solid #b8e6d2; border-radius:4px; padding:1px 9px; letter-spacing:.5px; text-decoration:none; white-space:nowrap; }
  .mtr-id:hover { background:#d9f5e8; }
  .mtr-id-na { color:var(--faint); background:#f5f5f4; border-color:var(--line); }
  .mtr-meta { font-size:11.5px; color:var(--sub); min-width:0; overflow-wrap:anywhere; }
  .mtr-score { margin-left:auto; font-size:12px; font-weight:600; font-variant-numeric:tabular-nums; white-space:nowrap; }
  .mtr-body { display:grid; grid-template-columns:minmax(0,1fr) 300px; gap:18px; margin-top:12px; }
  @media (max-width:760px){ .mtr-body { grid-template-columns:1fr; } }
  .mtr-info h4, .mtr-af h4 { font-size:13px; color:#064e3b; margin:0 0 8px; }
  .mtr-dl > div { display:flex; gap:12px; padding:4.5px 0; border-bottom:1px dashed #f0efec; font-size:12.5px; }
  .mtr-dl > div:last-child { border-bottom:0; }
  .mtr-dl dt { flex:0 0 88px; color:var(--faint); font-size:11px; padding-top:1px; white-space:nowrap; }
  .mtr-dl dd { flex:1; min-width:0; color:var(--ink); line-height:1.75; font-variant-numeric:tabular-nums; }
  .mtr-dl b { font-weight:600; }
  .mtr-af-none { font-size:12.5px; color:var(--sub); background:#f7f6f3; border:1px dashed var(--line); border-radius:5px; padding:10px 14px; margin:0; }
  .mtr-af-stat { display:flex; flex-direction:column; gap:6px; border:1px solid var(--line); border-radius:5px; background:#fdfdfc; padding:12px 14px; }
  .mtr-af-stat-line { font-family:ui-monospace,Menlo,monospace; font-size:11px; color:var(--ink); line-height:1.8; }
  .mtr-af-stat-note { font-size:11px; color:var(--sub); line-height:1.7; }
  .mtr-af-link { font-family:ui-monospace,Menlo,monospace; font-size:11px; color:var(--accent-2); text-decoration:none; }
  /* v2.9：AlphaFold 交互 3D 视图（与单靶点报告同版几何 — 交互成功→poster 隐藏；异常→canvas 隐藏；打印→poster 常显） */
  .af-fig { margin:0; text-align:center; }
  .af-stage { position:relative; width:100%; height:236px; border:1px solid var(--line); border-radius:6px; background:#fff; overflow:hidden; box-shadow:0 1px 3px rgba(28,25,23,.06); }
  .af-canvas { position:absolute; inset:0; cursor:grab; }
  .af-canvas:active { cursor:grabbing; }
  .af-poster { display:block; width:100%; height:236px; object-fit:contain; background:#fff; }
  .af-poster:not([src]) { display:none; }
  .af-stage.af-live .af-poster { display:none; }
  .af-stage.af-fail .af-canvas { display:none; }
  .af-legend { display:flex; gap:10px; margin-top:6px; font-size:9.5px; font-family:ui-monospace,Menlo,monospace; color:var(--sub); justify-content:center; flex-wrap:wrap; }
  .af-legend span { display:inline-flex; align-items:center; gap:4px; white-space:nowrap; }
  .af-legend i { display:inline-block; width:10px; height:10px; border-radius:2px; border:1px solid rgba(28,25,23,.15); }
  .af-fig figcaption { margin-top:8px; font-size:10.5px; line-height:1.75; color:var(--sub); font-family:ui-monospace,Menlo,monospace; text-align:left; }
  .af-fig figcaption b { color:var(--ink); font-weight:600; }
  .af-fig figcaption a { color:var(--accent-2); text-decoration:none; border-bottom:1px solid #c7ece0; }
  @media print { .af-stage .af-canvas { display:none; } .af-stage .af-poster, .af-stage.af-live .af-poster { display:block; } .mtr-card { break-inside:avoid; } }
  .sec { margin:0 0 40px; } .sec h2 { font-size:19px; font-weight:700; padding-bottom:10px; border-bottom:2px solid var(--ink); margin-bottom:16px; display:flex; align-items:center; gap:10px; }
  .sec-en { font-family:ui-monospace,Menlo,monospace; font-size:10.5px; color:var(--faint); font-weight:400; letter-spacing:1.5px; margin-left:auto; }
  .sec h3 { font-size:15.5px; margin:18px 0 8px; color:#064e3b; }
  .sec h4 { font-size:13.5px; margin:14px 0 6px; }
  .sec p { font-size:14.5px; margin:8px 0; text-align:justify; }
  .sec ul { margin:8px 0 8px 22px; font-size:14.5px; } .sec li { margin:4px 0; }
  .sec blockquote { border-left:3px solid var(--accent); background:#f0fdf4; padding:8px 14px; margin:10px 0; font-size:13px; color:var(--sub); }
  .sec strong { color:#064e3b; }
  .sec a { color:var(--accent-2); text-decoration:none; }
  .sec code { font-family:ui-monospace,Menlo,monospace; font-size:12.5px; background:#f5f5f4; padding:1px 5px; border-radius:3px; }
  .tbl-wrap { overflow-x:auto; margin:12px 0; }
  table { border-collapse:collapse; width:100%; font-size:12.5px; }
  th { background:#f7f7f5; color:var(--sub); font-weight:600; padding:7px 10px; text-align:left; white-space:nowrap; font-size:10px; letter-spacing:1px; text-transform:uppercase; border-bottom:1.5px solid #d6d3d1; }
  td { padding:6px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  tr:nth-child(even) td { background:#fafaf8; } tr:hover td { background:#f5f5f4; }
  .td-id { font-family:ui-monospace,Menlo,monospace; white-space:nowrap; }
  .num { font-family:ui-monospace,Menlo,monospace; white-space:nowrap; text-align:right; font-variant-numeric:tabular-nums; }
  .t-title { font-size:12px; color:var(--sub); }
  .mth { font-size:10.5px; padding:1px 7px; border-radius:3px; white-space:nowrap; }
  .mth-xray { background:#eff6ff; color:#1d4ed8; } .mth-cryoem { background:#fdf4ff; color:#a21caf; } .mth-nmr { background:#fff7ed; color:#c2410c; } .mth-other { background:#f5f5f4; color:var(--sub); }
  /* v1.22 共有结构覆盖靶点列 */
  .cov-cells { max-width:260px; }
  .cov-chip { display:inline-block; font-family:var(--mono); font-size:10px; line-height:1.6; padding:1px 6px; margin:1px 2px 1px 0; border-radius:3px; background:#ecfdf5; border:1px solid #a7f3d0; color:#065f46; white-space:nowrap; }

  /* ── 聚集形式（v1.25：融入靶点卡片 + 矩阵下折叠）── */
  .oligo-card { border:1px solid var(--line); border-radius:5px; padding:14px 18px; background:#fff; margin:14px 0; }
  .oligo-head { display:flex; flex-wrap:wrap; align-items:center; gap:10px; margin-bottom:8px; }
  .tgt-inline { font-weight:700; font-size:13.5px; }
  .oligo-badge { color:#fff; font-size:11.5px; font-weight:700; padding:2px 11px; border-radius:3px; letter-spacing:1px; white-space:nowrap; }
  .oligo-stoich { font-family:var(--mono); font-size:11.5px; color:#1c1917; background:#f5f5f4; border:1px solid #e7e5e4; padding:1px 9px; border-radius:3px; white-space:nowrap; }
  .oligo-conf { font-size:11.5px; color:#57534e; margin-left:auto; white-space:nowrap; }
  .tgt-oligo { display:flex; flex-wrap:wrap; align-items:center; gap:6px; margin-top:5px; }
  .tgt-oligo .oligo-badge { font-size:10px; padding:1px 8px; }
  .tgt-oligo .oligo-stoich { font-size:10px; padding:0 7px; }
  .tgt-oligo-conf { font-size:10.5px; color:var(--sub); }
  .tgt-oligo-adj { margin-left:6px; font-size:10px; color:#047857; border:1px solid #a7f3d0; border-radius:99px; padding:0 7px; background:#ecfdf5; white-space:nowrap; }
  .oligo-summary { margin:6px 0 4px; font-size:13px; }
  .oligo-ev { margin:8px 0 0; border-top:1px dashed #e7e5e4; padding-top:8px; }
  .oligo-ev-line { display:flex; gap:10px; font-size:12px; padding:3px 0; align-items:baseline; }
  .oligo-ev-src { flex:0 0 158px; color:#065f46; white-space:nowrap; }
  .oligo-ev-ref { flex:0 0 120px; font-family:var(--mono); font-size:11px; color:#57534e; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .oligo-ev-text { flex:1; color:#57534e; }
  .oligo-notes { margin:8px 0 2px 20px; font-size:12.5px; color:#57534e; }
  .oligo-notes li { margin:3px 0; }
  .cov-rng { display:inline-block; margin-left:3px; padding:0 3px; border-radius:2px; background:#f0fdf4; color:#047857; font-size:9.5px; }
  .pdb-fold, .fold { border:1px solid var(--line); border-radius:5px; padding:10px 16px; margin:12px 0; }
  .pdb-fold > summary, .fold > summary { font-size:13.5px; font-weight:600; cursor:pointer; color:#064e3b; list-style:none; }
  .pdb-fold > summary::before, .fold > summary::before { content:'＋ '; color:var(--accent); font-family:ui-monospace,Menlo,monospace; font-weight:400; }
  .pdb-fold[open] > summary::before, .fold[open] > summary::before { content:'－ '; }
  .pdb-fold > summary::-webkit-details-marker, .fold > summary::-webkit-details-marker { display:none; }
  .fig { margin:22px 0; text-align:center; }
  .fig img { max-width:100%; border:1px solid var(--line); border-radius:4px; background:#fff; }
  .fig figcaption { font-size:12px; color:var(--sub); margin-top:6px; text-align:left; }
  .fig-tag { display:inline-block; font-size:10.5px; padding:1px 8px; border-radius:3px; margin-right:8px; font-family:ui-monospace,Menlo,monospace; }
  .fig-gel { background:#fef2f2; color:#b91c1c; } .fig-sec { background:#eff6ff; color:#1d4ed8; } .fig-other { background:#f5f5f4; color:var(--sub); } .fig-ai { background:#f0fdfa; color:#0f766e; border:1px solid #99f6e4; }
  .warn-box { background:#fffbeb; border:1px solid #fde68a; color:#92400e; border-radius:4px; padding:12px 16px; font-size:12.5px; margin:14px 0; }
  /* v2.11：空态/提示块（与单靶点报告同款 — 共有结构空态等场景） */
  .callout { border-radius:6px; padding:14px 18px; margin:12px 0; font-size:13px; line-height:1.95; border:1px solid; text-align:justify; }
  .callout b { display:block; margin-bottom:5px; font-size:13.5px; }
  .callout-amber { background:#fffbeb; border-color:#fde68a; color:#92400e; }
  /* ── v2.11：批次核心结论速览（At a Glance — 与单靶点报告同款版式）── */
  .glance { border:1.5px solid var(--ink); border-radius:8px; margin:0 0 30px; background:#fff; overflow:hidden; }
  .glance-kicker { font-family:ui-monospace,Menlo,monospace; font-size:10px; letter-spacing:2.2px; text-transform:uppercase; color:var(--accent); padding:13px 20px 11px; font-weight:700; border-bottom:1px solid var(--line); background:linear-gradient(180deg,#ffffff,#f7fcf9); }
  .glance-grid { display:grid; grid-template-columns:200px 1fr; }
  .glance-hero { padding:18px 20px; border-right:1px solid var(--line); display:flex; flex-direction:column; justify-content:center; align-items:flex-start; background:#fbfdfc; }
  .glance-score { font-family:ui-monospace,Menlo,monospace; font-size:46px; font-weight:700; line-height:1; }
  .glance-score span { font-size:15px; color:var(--faint); font-weight:400; }
  .glance-hero-label { font-size:12px; color:var(--sub); margin-top:8px; }
  .glance-rating { display:inline-block; margin-top:9px; padding:2px 12px; border-radius:3px; font-size:12px; font-weight:700; color:#fff; letter-spacing:1px; }
  .glance-tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(158px,1fr)); }
  .glance-tile { padding:13px 16px 11px; border-right:1px solid var(--hairline); border-bottom:1px solid var(--hairline); min-width:0; }
  .glance-tile:nth-child(3n) { border-right:none; }
  .glance-tile.gt-warn { background:#fffbeb; }
  .glance-tile.gt-warn .gt-value { color:#b45309; }
  .glance-tile.gt-shared { background:#f0fdf7; }
  .glance-tile.gt-shared .gt-value { color:#065f46; }
  .gt-label { font-family:ui-monospace,Menlo,monospace; font-size:9.5px; letter-spacing:1.4px; text-transform:uppercase; color:var(--faint); font-weight:600; }
  .gt-value { font-size:14px; font-weight:700; margin-top:4px; line-height:1.5; overflow-wrap:anywhere; }
  .gt-sub { font-size:11px; color:var(--sub); margin-top:3px; line-height:1.55; }
  .glance-foot { padding:10px 20px; border-top:1px dashed var(--line); font-size:12px; color:var(--sub); background:#fbfdfc; line-height:1.8; }
  @media (max-width:680px){
    .glance-grid { grid-template-columns:1fr; }
    .glance-hero { border-right:none; border-bottom:1px solid var(--line); flex-direction:row; align-items:center; gap:16px; }
    .glance-score { font-size:36px; }
    .glance-tile { border-right:none; border-bottom:1px solid var(--hairline); }
  }
  @media print { .glance { break-inside:avoid; } }
  /* ── v2.11：共有结构突出面板（绿色 — 与单独评估互作复合物同设计语言）── */
  .sh-hero { background:#f0fdf7; border:1px solid #a7f3d0; border-left:4px solid var(--accent); border-radius:6px; padding:14px 18px; margin:0 0 12px; }
  .sh-hero-head { display:flex; flex-wrap:wrap; align-items:baseline; gap:6px 10px; font-size:15px; color:#064e3b; }
  .sh-hero-head b { font-size:18px; font-weight:800; }
  .sh-ico { color:var(--accent); font-size:16px; }
  .sh-hero-sub { flex-basis:100%; font-size:12px; color:#047857; line-height:1.8; }
  .sh-hero-sub b { font-size:12px; font-weight:700; }
  .sh-cov-sum { display:flex; flex-wrap:wrap; gap:6px; margin-top:10px; padding-top:10px; border-top:1px dashed #a7f3d0; }
  .sh-cov-chip { display:inline-flex; align-items:baseline; gap:5px; font-family:ui-monospace,Menlo,monospace; font-size:11px; padding:2px 9px; border-radius:3px; background:#fff; border:1px solid #a7f3d0; color:#065f46; white-space:nowrap; }
  .sh-cov-chip i { font-style:normal; font-weight:700; color:var(--accent); }
  .sh-cnt { display:inline-block; font-family:ui-monospace,Menlo,monospace; font-size:10.5px; font-weight:700; color:#065f46; background:#ecfdf5; border:1px solid #a7f3d0; border-radius:3px; padding:1px 5px; margin-right:4px; }
  .sh-mark { color:var(--accent); font-size:13px; margin-right:3px; }
  .sh-sum { font-weight:600; font-size:12px; color:#065f46; }
  .note { font-size:12.5px; color:#57534e; background:#f7f6f3; border-left:3px solid #a8a29e; padding:8px 14px; margin:10px 0; border-radius:0 4px 4px 0; }
  .rpt-foot { margin-top:48px; padding-top:18px; border-top:1px solid var(--ink); font-size:11.5px; color:var(--sub); line-height:2; font-family:ui-monospace,Menlo,monospace; }
  @media print { body { background:#fff; } .page { padding:24px 8px; } .pdb-fold, .fold { page-break-inside:avoid; } }
  @media (max-width:640px) { .toc ol { columns:1; } }

${RESPONSIVE_PAGE_CSS}${LIGHTBOX_CSS}${PRINT_PAGE_CSS}${UX_PAGE_CSS}</style>
</head>
<body>
<div class="page">

  <div class="rpt-view rpt-view-on" id="view-home">
  <header class="rpt-head">
    <div class="rpt-eyebrow">TargetEval · Merged Structure Feasibility Report</div>
    <h1 class="rpt-title">${esc(reportTitle)}</h1>
    <div class="rpt-subtitle">${esc(targets.map(t => t.proteinName).join(' · '))}</div>
    <div class="rel-box">
      <b>靶点关系：${esc(relName)}</b>（置信度：${relation.confidence === 'high' ? '高' : relation.confidence === 'medium' ? '中' : '低'}）<br>
      ${esc(relation.rationale)}<br>
      <b>策略要点：</b>${esc(relation.strategy)}
    </div>
    <div class="tgt-grid">${targetMeta}</div>
    <div class="meta-line">
      靶点 ${targets.length} 个 · PDB 结构合计 ${targets.reduce((s, t) => s + t.directPdbs.length, 0)} 个 ·
      同源结构合计 ${targets.reduce((s, t) => s + t.blastHits.length, 0)} 个 · 文献合计 ${litTotal} 篇 ·
      报告编号 ${esc(input.batchReportId.slice(0, 10))} · ${dateStr}
      ${input.goal ? `<br>客户目标：${esc(input.goal.slice(0, 160))}` : ''}
    </div>
    <div>
      <span class="badge">${esc(relName)}</span>
      <span class="badge">数据源：UniProt · RCSB · PDBe${targets.some(t => t.blastHits.length > 0) ? (targets.some(t => t.blastStatus?.provider === 'rcsb') ? ' · 序列检索（RCSB 兜底）' : ' · BLAST') : ''}</span>
      ${input.llmOk ? '<span class="badge">LLM 分析：已完成</span>' : '<span class="badge amber">LLM 分析：失败（见警示）</span>'}
    </div>
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
      ${targets.map(t => `<a data-goto="target-${targetKeyOf(t)}" href="#view-target-${targetKeyOf(t)}" title="${esc(t.proteinName)} — PDB ${t.directPdbs.length} · 总体 ${t.scores.overall.score}/10 · 综述/基本信息/预测结构/单独结构同页">${esc(t.uniprotId ?? t.label)}</a>`).join('')}
    </div>
  </nav>

  ${input.llmOk ? '' : `<div class="warn-box">LLM 分析生成失败（${esc(input.llmErrors.join('；')) || '未知原因'}）。以下为系统收集的确定性数据与评估表 AI 解析要点。</div>`}

  <section class="sec" id="llm">
    <h2>${secHead(noLlm, '合并评估分析', 'Merged Analysis')}</h2>
    ${renderMarkdown(llmHomeMd || '（LLM 分析不可用 — 请参考下方数据区块与评估表要点）', 1)}
  </section>

  ${sharedStructuresHtml}

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

  ${figHtml}

  <footer class="rpt-foot">
    Generated by TargetEval · 多靶点合并评估（v2.12 格式：复合物评估与单独评估分层 — 首页为复合物级分析 + 共有结构与共有文献，每靶点独立单独报告页[综述 + 基本信息 + AlphaFold 预测结构交互视图 + 该靶点 PDB/同源/文献明细，刊头靶点卡片进入] · 打印时全部页面依序输出）<br>
    SOURCES: UniProt REST · RCSB Data API · PDBe API · NCBI BLAST (pdbaa) / RCSB 序列检索（NCBI 拥堵时兜底） · PubMed E-utilities<br>
    Analysis engine: ${esc(input.engineSummary || '—')} · 本报告由系统自动生成，供研究参考，不构成投资/医疗建议。
  </footer>
  </div>

  ${targetViews}
</div>
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
${LIGHTBOX_JS}
</body>
</html>`
}
