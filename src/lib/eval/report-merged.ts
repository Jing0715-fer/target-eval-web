/**
 * 合并评估报告（v1.8 关联靶点批量）：
 *  - 关系判断为 related 的批次：各靶点作业以 deferred 模式完成数据收集后，
 *    由本模块加载全部作业数据，LLM 生成一份合并报告
 *  - 核心新增章节「靶点关系分析」：关系类型/证据/生物学意义/对结构解析策略的影响
 *    （复合物共表达、抗体-抗原复合物组装、融合构建边界等）
 *  - 三段式生成（摘要+关系 / 各靶点综述 / 整合策略），确定性数据由模板直出
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { db } from '@/lib/db'
import { llmChat } from './llm'
import { elideSequenceRuns } from './seq-elide'
import { esc, renderMarkdown } from './report-html'
import { describeRelationType, describeBlastStatus, type BlastHit, type BlastStatusInfo, type ConstructInfo, type FormInsights, type HomologPair, type LiteratureItem, type MethodStats, type ParsedImage, type PdbEntry, type RelationJudgment, type Scores, type SequenceAttribution } from './types'

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
}

/** 前端展示用的轻量靶点数据（合并报告响应携带 — PDB/BLAST/文献列表带 UniProt 归属） */
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
}

/** 轻量化：网页合并视图展示上限（PDB 30 / BLAST 40 / 文献 12） */
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
    directPdbs: t.directPdbs.slice(0, 30),
    blastHits: t.blastHits.slice(0, 40),
    literature: t.literature.slice(0, 12),
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
  if (t.construct) {
    lines.push(`客户构建: ${t.construct.providedLength} aa（与全长一致性 ${t.construct.identity}%${t.construct.start != null && t.construct.end != null ? `，估计区间 ${t.construct.start}-${t.construct.end}` : ''}）`)
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

export async function generateMergedReport(input: MergedReportInput, signal?: AbortSignal): Promise<GeneratedMergedReport> {
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
  const digest = digestLines.join('\n')

  const callPart = async (name: string, instruction: string): Promise<{ key: string; markdown: string; llmOk: boolean; error?: string }> => {
    const r = await llmChat(`${digest}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n基于以上数据上下文，${instruction}`, SYSTEM, signal)
    return { key: name, markdown: r.ok ? r.text : '', llmOk: r.ok, error: r.error }
  }

  const partA = await callPart('A', `撰写合并报告的标题与首两章。首行输出 # 开头的描述性报告标题（一行，≤30 字，不要副标题，不要包含"报告"二字、日期、编号），高度概括本批次靶点与关系类型，例如「EGFR 与 p53 抗体-抗原复合物合并评估」「MAPK 家族三成员合并结构可行性评估」「血红蛋白 α/β 异源二聚体复合物评估」。然后顺序输出以下两章（以 ## 开头，不要输出其他章节）：

## 执行摘要
- 3-4 段：第一段给出批次总体结论（这些靶点作为整体项目的结构解析可行性、推荐技术路线${relation.relationType === 'homologous' ? '；同源家族批次需说明家族级结论（任一成员的结构证据对整个家族的指导意义）' : ''}）；第二段逐个靶点一句话概括其结构研究现状（引用具体数字）；第三段概括客户目标的达成路径与整体风险；第四段一句话给出下一步建议
- 篇幅 400-600 字

### 可行性结论（${relation.relationType === 'homologous' ? '家族级' : '批次级'}）
- **结论分级**：直接给出高/中/低分级，并用一段话说明判断依据（引用具体数字：结构总数/最佳分辨率/覆盖率/同源命中/文献）
- **关键依据**：3-5 条列表，每条注明来源靶点（哪个 UniProt 的证据）
- **主要风险**：2-4 条列表（构象柔性/覆盖空白/表达纯化难度/家族成员间差异等，基于数据判断）

## 靶点关系分析
本报告的核心章节 — 客户需要理解这些靶点为什么合并评估：
- ### 关系判定与证据：明确说明判定为「${relName}」的依据${pairs.length ? '（引用系统序列一致性比对的具体数字 + 蛋白名/基因/物种证据）' : '（引用数据上下文中的具体证据：蛋白名/功能注释/客户目标/序列信息）'}${relation.blastGroups?.length ? '；说明 ≥90% 高一致成员共享同源检索结果的策略（哪些靶点未单独检索而共享了代表的命中）' : ''}
- ### 生物学意义：${relation.relationType === 'homologous' ? '同源家族的生物学背景：直系/旁系同源关系的判定依据（一致性水平/物种分布/基因名）、家族保守区域（催化残基/结构域）与变异区域的分布、物种差异对结构与功能的影响（基于注释，禁止编造）' : '这种关系的生物学背景（复合物的组装方式/抗体-抗原结合模式/融合构建的设计意图等，基于注释与文献，禁止编造）'}
- ### 对结构解析策略的影响：${relation.relationType === 'complex' ? '复合物亚基的共表达/共纯化策略、化学计量比、组装验证' : relation.relationType === 'antibody-antigen' ? '抗体（Fab/scFv）与抗原的复合物组装、抗体辅助结晶或 Cryo-EM 配对策略' : relation.relationType === 'fusion' ? '融合构建的边界设计、linker 选择、各结构域的折叠独立性' : relation.relationType === 'homologous' ? '家族证据互用原则：任一成员已有结构可直接指导其他成员的构建边界设计与结晶条件借鉴；建议优先解析的家族成员（结构数据最丰富/表达最成熟者先行）；家族保守区与可变区的构建边界策略；如有序列归属中的同源序列，说明其与已选靶点的家族关系' : '关联项目协同推进的要点'}
- 篇幅 600-900 字`)

  const partB = await callPart('B', `撰写报告的以下章节（以 ## 开头，顺序输出，不要输出其他章节，不要再输出 # 标题）：

## 各靶点结构可行性综述
对批次中每个靶点输出一个小节（### 靶点名），每节包含（详细程度不低于独立单靶点报告）：
- **一句话结论**：该靶点结构解析可行性如何、推荐方法
- **已有结构研究概况**：引用 PDB 数量/方法分布/最佳分辨率/覆盖率（含覆盖区间与空白区间）/高频配体/结构释放年份分布（研究热度变化）
- **同源结构证据**：BLAST/序列检索命中概况（最高一致性/命中数）；命中为共享自家族代表时必须如实说明（未单独检索、共享来源），不得虚构
- **文献证据**：引用 1-2 篇代表性文献（PMID + 一句话贡献，优先结构解析文献）
- **${relation.relationType === 'homologous' ? '家族内定位' : '主要风险与注意点'}**：${relation.relationType === 'homologous' ? '与其他成员的一致性水平、在家族中的结构研究成熟度、可从哪些成员借鉴构建经验与结晶条件' : '构象柔性/覆盖空白/构建边界问题，基于数据判断'}
- **风险与切入建议**：主要风险 1-2 条 + 最可行的切入点（构建边界/表达系统/方法选择）
- 篇幅每靶点 500-700 字

要求：各靶点篇幅均衡；数据引用与数据摘要一致（PDB ID/PMID/分辨率/一致性数字必须来自数据上下文，禁止编造）；BLAST 跳过/失败/共享的靶点如实说明${input.sequenceAttribution?.some(a => a.kind === 'construct') ? '；已归属为客户构建的序列（见序列归属）在对应靶点小节中说明构建边界与全长区间的对应关系' : ''}`)

  const partC = await callPart('C', `撰写报告的以下两章（以 ## 开头，顺序输出，不要输出其他章节，不要再输出 # 标题）：

## 整合可行性与实验策略
- ### 跨靶点对比矩阵：用 Markdown 表格对比各靶点（行：靶点/PDB 数量/最佳分辨率/覆盖率/总体评分/推荐方法/主要风险）
- ### 整合实验方案：${relation.relationType === 'complex' ? '复合物共表达与组装策略（共表达比例/纯化顺序/组装验证 SEC-MALS）、备选方案（分开表达后体外组装）' : relation.relationType === 'antibody-antigen' ? '抗体-抗原复合物制备（Fab 酶切/亲和纯化/复合物组装与纯化）、抗体辅助结晶 vs Cryo-EM 的选择' : relation.relationType === 'fusion' ? '融合构建表达纯化要点与各结构域独立对照实验的必要性' : relation.relationType === 'homologous' ? '家族实验策略：优先表达/解析哪个家族成员（结构数据最丰富、覆盖最完整者先行作模板）、其余成员的构建边界借鉴方案（保守核心 + 可变区处理）、物种选择建议（表达系统兼容性与序列一致性的权衡）、若需全部解析则给优先级排序' : '各靶点独立推进的资源配置与优先级排序建议'}
- ### 时间规划：Markdown 表格（阶段/预计时间/关键里程碑/风险点）
- 篇幅 500-800 字

## 总结
- 3 段以内：批次核心结论重申 + 给客户的 3 条最重要建议 + 明确的 go/no-go 倾向性意见
- 篇幅 200-300 字`)

  const parts = [partA, partB, partC]
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
      const buf = await fs.readFile(path.join(assetDir, `${meta.id}.${ext}`))
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
  // 剥离 markdown 首行 # 标题（已用作 HTML <h1>，避免重复渲染）
  const llmMarkdown = input.markdown ? input.markdown.replace(/^#\s+.+\r?\n?/, '') : ''
  const dateStr = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
  const embedded = await embedImages(input.images, input.assetDir)

  // v1.10 同源证据：一致性矩阵（下三角）与序列归属表（确定性数据，模板直出）
  const pairMap = new Map<string, number>()
  for (const p of relation.homologPairs ?? []) pairMap.set(`${p.a}|${p.b}`, p.identity)
  const getPair = (a: string, b: string) => pairMap.get(`${a}|${b}`) ?? pairMap.get(`${b}|${a}`)
  const isHomologousBatch = relation.relationType === 'homologous'
  const matrixHtml = (isHomologousBatch || relation.homologPairs?.some(p => p.identity > 0)) && targets.length >= 2 ? `
  <section class="sec" id="homolog">
    <h2>${isHomologousBatch ? '家族序列一致性矩阵' : '序列一致性'}<span class="sec-en">Pairwise Identity</span></h2>
    <p class="note">系统对全部靶点全长序列两两比对（种子-对角链算法）得到的确定性一致性估计；≥40% 判为家族级同源，任一成员的已有结构可直接指导其他成员的构建设计。</p>
    <div class="tbl-wrap"><table>
      <thead><tr><th></th>${targets.map(t => `<th>${esc(t.uniprotId ?? t.label)}</th>`).join('')}</tr></thead>
      <tbody>${targets.map((row, i) => `<tr><th style="background:#f5f5f4;color:#1c1917">${esc(row.uniprotId ?? row.label)}</th>${targets.map((col, j) => {
        if (i === j) return '<td class="num">—</td>'
        if (j < i) {
          const v = getPair(row.uniprotId ?? row.label, col.uniprotId ?? col.label)
          return `<td class="num">${v != null ? v + '%' : '—'}</td>`
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
    <h2>评估表序列归属<span class="sec-en">Sequence Attribution</span></h2>
    <p class="note">评估表中每条序列经系统比对后的去向：同一靶点（一致性 ≥85%）的序列已作为客户构建并入对应靶点的评估（构建边界分析）；同源（35–85%）标注为家族成员；抗体序列作为背景证据；其余为未匹配。</p>
    <div class="tbl-wrap"><table>
      <thead><tr><th>#</th><th>序列</th><th>长度(aa)</th><th>最佳匹配</th><th>一致性</th><th>归属</th></tr></thead>
      <tbody>${attrRows}</tbody>
    </table></div>
  </section>` : ''

  const targetMeta = targets.map(t => `
    <div class="tgt-card">
      <div class="tgt-name">${esc(t.proteinName)}${t.uniprotId ? ` <a href="https://www.uniprot.org/uniprotkb/${t.uniprotId}" target="_blank" rel="noopener">${t.uniprotId}</a>` : ''}</div>
      <div class="tgt-meta">${esc(t.geneNames.slice(0, 3).join('/') || '—')} · ${esc(t.organism || '—')} · ${t.sequenceLength} aa</div>
      <div class="tgt-score">总体 <b>${t.scores.overall.score}</b>/10 · ${esc(t.scores.overall.rating)}</div>
    </div>`).join('')

  const matrixRows = targets.map(t => `
    <tr>
      <td class="td-id">${t.uniprotId ? `<a href="https://www.uniprot.org/uniprotkb/${t.uniprotId}" target="_blank" rel="noopener">${t.uniprotId}</a>` : '—'}</td>
      <td class="t-title">${esc(t.proteinName)}</td>
      <td class="num">${t.directPdbs.length}</td>
      <td class="num">${t.methodStats.bestResolution != null ? t.methodStats.bestResolution.toFixed(2) + 'Å' : '—'}</td>
      <td class="num">${t.coveragePercent}%</td>
      <td class="num">${t.scores.xray.score}</td>
      <td class="num">${t.scores.cryoem.score}</td>
      <td class="num">${t.scores.nmr.score}</td>
      <td class="num"><b>${t.scores.overall.score}</b></td>
    </tr>`).join('')

  const pdbBlocks = targets.map(t => {
    if (!t.directPdbs.length) return ''
    const rows = t.directPdbs.slice(0, 12).map(p => `
      <tr>
        <td class="td-id"><a href="https://www.rcsb.org/structure/${p.pdbId}" target="_blank" rel="noopener">${p.pdbId}</a></td>
        <td><span class="mth mth-${p.isXray ? 'xray' : p.isCryoem ? 'cryoem' : p.isNmr ? 'nmr' : 'other'}">${p.isXray ? 'X-ray' : p.isCryoem ? 'Cryo-EM' : p.isNmr ? 'NMR' : esc(p.method.slice(0, 10))}</span></td>
        <td class="num">${p.resolution != null ? p.resolution.toFixed(2) : '—'}</td>
        <td class="t-title">${esc(p.title.slice(0, 80))}</td>
        <td class="num">${esc(p.releaseDate.slice(0, 4))}</td>
      </tr>`).join('')
    return `
    <details class="pdb-fold" open>
      <summary>${esc(t.proteinName)}${t.uniprotId ? `（${t.uniprotId}）` : ''} — ${t.directPdbs.length} 个结构（前 12）</summary>
      <div class="tbl-wrap"><table>
        <colgroup><col style="width:74px"><col style="width:70px"><col style="width:64px"><col><col style="width:56px"></colgroup>
        <thead><tr><th>PDB</th><th>方法</th><th>分辨率</th><th>标题</th><th>年份</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </details>`
  }).filter(Boolean).join('')

  // v1.11 同源结构（BLAST/序列检索命中 — 含共享自家族代表的标注，可溯源归属靶点）
  const blastBlocks = targets.map(t => {
    if (!t.blastHits.length) return ''
    const shared = t.blastStatus?.status === 'ok' && /共享自家族代表/.test(t.blastStatus.note ?? '')
    const rows = t.blastHits.slice(0, 10).map(h => `
      <tr>
        <td class="td-id"><a href="https://www.rcsb.org/structure/${h.pdbId}" target="_blank" rel="noopener">${h.pdbId || '—'}</a></td>
        <td class="t-title">${esc(h.description.slice(0, 84))}</td>
        <td class="num">${h.identity}%</td>
        <td class="num">${h.resolution != null ? h.resolution.toFixed(2) + 'Å' : '—'}</td>
        <td class="t-title">${esc((h.method || '').slice(0, 16))}</td>
      </tr>`).join('')
    return `
    <details class="pdb-fold">
      <summary>${esc(t.proteinName)}${t.uniprotId ? `（${t.uniprotId}）` : ''} — ${t.blastHits.length} 个同源结构（前 10）${shared ? ' · <span style="font-weight:400;font-size:12px">共享自家族代表，未单独检索</span>' : ''}</summary>
      <div class="tbl-wrap"><table>
        <colgroup><col style="width:74px"><col><col style="width:64px"><col style="width:70px"><col style="width:80px"></colgroup>
        <thead><tr><th>PDB</th><th>描述</th><th>Identity</th><th>分辨率</th><th>方法</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </details>`
  }).filter(Boolean).join('')

  // v1.11 各靶点文献（PMID 可点击；结构解析文献标记；归属靶点清晰可辨）
  const litTotal = targets.reduce((s, t) => s + t.literature.length, 0)
  const litBlocks = targets.map(t => {
    if (!t.literature.length) return ''
    const rows = t.literature.slice(0, 10).map(l => `
      <tr>
        <td class="td-id">${l.pmid ? `<a href="https://pubmed.ncbi.nlm.nih.gov/${l.pmid}/" target="_blank" rel="noopener">${esc(l.pmid)}</a>` : '—'}</td>
        <td class="t-title">${esc(l.title.slice(0, 110))}${l.fromPdb ? ' <span class="mth" style="background:#ecfdf5;color:#047857">结构解析文献</span>' : ''}</td>
        <td class="t-title">${esc(l.journal.slice(0, 30))}</td>
        <td class="num">${esc(l.year || '—')}</td>
      </tr>`).join('')
    return `
    <details class="pdb-fold">
      <summary>${esc(t.proteinName)}${t.uniprotId ? `（${t.uniprotId}）` : ''} — ${t.literature.length} 篇（前 10）</summary>
      <div class="tbl-wrap"><table>
        <colgroup><col style="width:76px"><col><col style="width:150px"><col style="width:52px"></colgroup>
        <thead><tr><th>PMID</th><th>标题</th><th>期刊</th><th>年份</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </details>`
  }).filter(Boolean).join('')

  const figHtml = embedded.length ? `
  <section class="sec" id="assets">
    <h2>六、客户实验数据<span class="sec-en">Experimental Data</span></h2>
    ${embedded.map(({ meta, dataUri }) => `
    <figure class="fig">
      <img src="${dataUri}" alt="${esc(meta.caption)}" loading="lazy">
      <figcaption><span class="fig-tag fig-${meta.kind}">${meta.kind === 'gel' ? 'SDS-PAGE' : meta.kind === 'sec' ? 'SEC' : '图'}</span>${meta.vlmKind ? '<span class="fig-tag fig-ai">AI 视觉识别</span>' : ''}${esc(meta.caption)}</figcaption>
    </figure>`).join('')}
  </section>` : ''

  // v1.15：评估表 AI 解析要点（LLM 失败时作为兜底证据；正常时作为可溯源原始要点）
  const ins = input.insights
  const insightsHtml = ins && (ins.goals?.length || ins.scientificQuestions?.length || ins.experimentalSummary || ins.sequenceNotes || ins.homologs || ins.keyConcerns?.length) ? `
  <section class="sec" id="insights">
    <h2>客户评估表要点<span class="sec-en">Form Insights</span></h2>
    <p class="note">由 AI 从上传的评估表中结构化提取的关键要点 — 供比对 LLM 分析的复述是否忠于原始输入。</p>
    ${ins.goals?.length ? `<h3>客户目标</h3><ul>${ins.goals.map(g => `<li>${esc(g)}</li>`).join('')}</ul>` : ''}
    ${ins.scientificQuestions?.length ? `<h3>待解决科学问题</h3><ol>${ins.scientificQuestions.map(q => `<li>${esc(q)}</li>`).join('')}</ol>` : ''}
    ${ins.experimentalSummary ? `<h3>实验数据要点</h3><blockquote>${esc(ins.experimentalSummary)}</blockquote>` : ''}
    ${ins.sequenceNotes ? `<h3>构建 / 序列说明</h3><blockquote>${esc(ins.sequenceNotes)}</blockquote>` : ''}
    ${ins.homologs ? `<h3>同源 / 参考信息</h3><blockquote>${esc(ins.homologs)}</blockquote>` : ''}
    ${ins.keyConcerns?.length ? `<h3>风险关注点</h3><ul>${ins.keyConcerns.map(c => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
  </section>` : ''

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(reportTitle)} · ${esc(targets.map(t => t.label).join(' + '))}</title>
<style>
  :root { --ink:#1c1917; --sub:#57534e; --faint:#a8a29e; --line:#e7e5e4; --accent:#047857; --accent-2:#059669; --paper:#fffdf9; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:"Source Han Serif SC","Noto Serif SC","Songti SC",Georgia,serif; background:#f0efec; color:var(--ink); font-size:14.5px; line-height:1.85; }
  .page { max-width:920px; margin:0 auto; background:var(--paper); padding:56px 56px 48px; }
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
  .toc { border:1px solid var(--line); border-radius:5px; padding:12px 20px; margin:20px 0; font-size:13px; }
  .toc b { font-family:ui-monospace,Menlo,monospace; font-size:11px; letter-spacing:1.5px; color:var(--sub); }
  .toc ol { margin:6px 0 0 20px; columns:2; column-gap:36px; } .toc a { color:var(--accent-2); text-decoration:none; }
  .sec { margin:34px 0; } .sec h2 { font-size:19px; padding-bottom:8px; border-bottom:1px solid var(--ink); margin-bottom:14px; display:flex; align-items:baseline; }
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
  .note { font-size:12.5px; color:#57534e; background:#f7f6f3; border-left:3px solid #a8a29e; padding:8px 14px; margin:10px 0; border-radius:0 4px 4px 0; }
  .rpt-foot { margin-top:48px; padding-top:18px; border-top:1px solid var(--ink); font-size:11.5px; color:var(--sub); line-height:2; font-family:ui-monospace,Menlo,monospace; }
  @media print { body { background:#fff; } .page { padding:24px 8px; } .pdb-fold, .fold { page-break-inside:avoid; } }
  @media (max-width:640px) { .page { padding:28px 18px; } .rpt-title { font-size:20px; } .toc ol { columns:1; } }
</style>
</head>
<body>
<div class="page">

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

  <nav class="toc">
    <b>Contents · 目录</b>
    <ol>
      <li><a href="#llm">合并评估分析（摘要 / 关系分析 / 各靶点综述 / 整合策略）</a></li>
      ${insightsHtml ? '<li><a href="#insights">客户评估表要点</a></li>' : ''}
      <li><a href="#matrix">跨靶点对比矩阵</a></li>
      ${matrixHtml ? '<li><a href="#homolog">' + (isHomologousBatch ? '家族序列一致性矩阵' : '序列一致性') + '</a></li>' : ''}
      ${attributionHtml ? '<li><a href="#attribution">评估表序列归属</a></li>' : ''}
      <li><a href="#pdbs">各靶点 PDB 结构</a></li>
      ${blastBlocks ? '<li><a href="#blast-hits">同源结构（BLAST/序列检索）</a></li>' : ''}
      ${litBlocks ? '<li><a href="#literature">各靶点文献</a></li>' : ''}
      ${embedded.length ? '<li><a href="#assets">客户实验数据</a></li>' : ''}
    </ol>
  </nav>

  ${input.llmOk ? '' : `<div class="warn-box">LLM 分析生成失败（${esc(input.llmErrors.join('；')) || '未知原因'}）。以下为系统收集的确定性数据与评估表 AI 解析要点。</div>`}

  <section class="sec" id="llm">
    <h2>一、合并评估分析<span class="sec-en">Merged Analysis</span></h2>
    ${renderMarkdown(llmMarkdown || '（LLM 分析不可用 — 请参考下方数据区块与评估表要点）', 1)}
  </section>

  ${insightsHtml}

  <section class="sec" id="matrix">
    <h2>二、跨靶点对比矩阵<span class="sec-en">Comparison Matrix</span></h2>
    <div class="tbl-wrap"><table>
      <thead><tr><th>UniProt</th><th>靶点</th><th>PDB</th><th>最佳分辨率</th><th>覆盖率</th><th>X-ray</th><th>Cryo-EM</th><th>NMR</th><th>总体</th></tr></thead>
      <tbody>${matrixRows}</tbody>
    </table></div>
  </section>

  ${matrixHtml}
  ${attributionHtml}

  <section class="sec" id="pdbs">
    <h2>三、各靶点 PDB 结构<span class="sec-en">Structures by Target</span></h2>
    ${pdbBlocks || '<p>本批次靶点暂无直接关联 PDB 结构。</p>'}
  </section>

  ${blastBlocks ? `
  <section class="sec" id="blast-hits">
    <h2>四、同源结构（BLAST / 序列检索）<span class="sec-en">Homologous Structures</span></h2>
    <p class="note">各靶点经 BLAST（NCBI pdbaa）或 RCSB 序列检索（NCBI 拥堵时兜底）获得的同源结构命中，已排除该靶点自身的直接结构。≥90% 序列一致性的家族成员共享家族代表的同一次检索结果（标注「共享自家族代表」）。</p>
    ${blastBlocks}
  </section>` : ''}

  ${litBlocks ? `
  <section class="sec" id="literature">
    <h2>五、各靶点文献<span class="sec-en">Literature by Target</span></h2>
    <p class="note">各靶点分别检索的 PubMed 文献（含 PDB 结构主引文，标记「结构解析文献」）— 按靶点分组，每条文献的归属 UniProt 见分组标题。同一文献可能同时关联多个靶点。</p>
    ${litBlocks}
  </section>` : ''}

  ${figHtml}

  <footer class="rpt-foot">
    Generated by TargetEval · 多靶点合并评估（v1.14）<br>
    SOURCES: UniProt REST · RCSB Data API · PDBe API · NCBI BLAST (pdbaa) / RCSB 序列检索（NCBI 拥堵时兜底） · PubMed E-utilities<br>
    Analysis engine: ${esc(input.engineSummary || '—')} · 本报告由系统自动生成，供研究参考，不构成投资/医疗建议。
  </footer>
</div>
<script>
// 打印时自动展开所有 <details> 折叠块，打印后恢复原状
(function(){
  var memo=[];
  function expand(){ memo=[]; document.querySelectorAll('details').forEach(function(d){ if(!d.open){ memo.push(d); d.open=true; } }); }
  function restore(){ memo.forEach(function(d){ d.open=false; }); memo=[]; }
  window.addEventListener('beforeprint', expand);
  window.addEventListener('afterprint', restore);
})();
</script>
</body>
</html>`
}
