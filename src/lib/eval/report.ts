/**
 * LLM 评估报告编排 — 相对原项目的优化：
 *  1. 三段式生成（摘要/背景 → 结构研究全景 → 可行性与策略），每段独立调用，
 *     输入输出体积受限，稳定性与内存占用优于单次超长调用
 *  2. 确定性数据（PDB 表/文献列表/评分/胶图）由模板直接渲染，杜绝 LLM 幻觉
 *  3. 报告要求「结论先行」「已有结构研究全景（时间线/方法学/配体态/覆盖空白）」
 *     「客户目标可行性分级（高中低）+ 关键依据 + 风险」三个强化模块
 */
import type { BlastHit, BlastStatusInfo, FormInsights, LiteratureItem, PdbEntry, PdbeCoverageResult, Scores, SequenceComparison, UniprotInfo } from './types'
import type { ParsedImage } from './types'
import { describeBlastStatus } from './types'
import { llmChat } from './llm'
import { elideSequenceRuns } from './seq-elide'

export interface ReportContext {
  uniprot: UniprotInfo | null
  sequence: string
  goal?: string
  goalHints: string[]
  /** 评估表 LLM 智能解析要点（目标/科学问题/实验数据摘要等） */
  insights?: FormInsights
  /** 客户提供的伴随序列（合并评估：UniProt 为主 + 构建边界分析） */
  providedSequence?: { sequence: string; comparison: SequenceComparison }
  directPdbs: PdbEntry[]
  blastHits: BlastHit[]
  /** BLAST 执行状态（跳过/失败原因 — 供报告说明） */
  blastStatus?: BlastStatusInfo
  coverage: PdbeCoverageResult | null
  coverageText: string
  gapText: string
  literature: LiteratureItem[]
  images: ParsedImage[]
  scores: Scores & { rationale: { xray: string; cryoem: string; nmr: string; overall: string } }
}

const SYSTEM = `你是一位资深结构生物学专家（CRO 结构解析项目负责人视角），为蛋白靶点撰写专业的结构解析可行性评估报告。写作要求：
- 全文使用简体中文（专业术语可保留英文），正式书面语，不使用表情符号
- 结论先行：每章开头直接给结论，再展开论据
- 严格基于给定的数据上下文，禁止编造不存在的 PDB ID、PMID、分辨率或文献
- 数据里没有的信息，用"（本次数据未覆盖）"或"暂无可靠数据"明确说明
- 输出为 Markdown 子集：## / ### 标题、**加粗**、- 列表、|表格|、> 引用，不使用图片链接和代码块
- 数字引用必须与数据上下文一致`

// ─── 数据摘要构造（喂给 LLM 的紧凑上下文）──────────────────────────────────

function methodShort(p: { isXray: boolean; isCryoem: boolean; isNmr: boolean; method: string }): string {
  if (p.isXray) return 'X-ray'
  if (p.isCryoem) return 'Cryo-EM'
  if (p.isNmr) return 'NMR'
  return p.method.slice(0, 12)
}

function pdbTable(pdbs: PdbEntry[], n: number): string {
  return pdbs.slice(0, n).map(p =>
    `| ${p.pdbId} | ${methodShort(p)} | ${p.resolution != null ? p.resolution + 'Å' : '-'} | ${p.ligands.length ? p.ligands.slice(0, 3).join(', ') : '-'} | ${p.releaseDate.slice(0, 4)} |`,
  ).join('\n')
}

function blastTable(hits: BlastHit[], n: number): string {
  return hits.slice(0, n).map(h =>
    `| ${h.pdbId || '-'} | ${h.description.slice(0, 70)} | ${h.identity}% | ${h.evalueRaw} |`,
  ).join('\n')
}

function litTable(lits: LiteratureItem[], n: number): string {
  return lits.slice(0, n).map(l =>
    `| ${l.pmid} | ${l.title.slice(0, 90)}${l.fromPdb ? '（结构解析文献，与 PDB 条目直接关联）' : ''} | ${l.journal} ${l.year} |`,
  ).join('\n')
}


function buildDigest(ctx: ReportContext): string {
  const u = ctx.uniprot
  const pdbs = ctx.directPdbs
  const xrayCount = pdbs.filter(p => p.isXray).length
  const cryoemCount = pdbs.filter(p => p.isCryoem).length
  const nmrCount = pdbs.filter(p => p.isNmr).length
  const bestRes = pdbs.reduce<number | null>((b, p) => (p.resolution != null && (b == null || p.resolution < b) ? p.resolution : b), null)

  // 配体词频（研究状态覆盖）
  const ligFreq = new Map<string, number>()
  for (const p of pdbs) for (const l of p.ligands) {
    const key = l.split('(')[0].trim()
    ligFreq.set(key, (ligFreq.get(key) ?? 0) + 1)
  }
  const topLigands = [...ligFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([k, c]) => `${k}×${c}`).join('、')

  // 年份分布
  const yearHist = new Map<string, number>()
  for (const p of pdbs) {
    const y = p.releaseDate.slice(0, 4)
    if (/^\d{4}$/.test(y)) yearHist.set(y, (yearHist.get(y) ?? 0) + 1)
  }
  const timeline = [...yearHist.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([y, c]) => `${y}:${c}`).join('、')

  const domainFeat = u?.features.filter(f => f.type === 'Domain' || f.type === 'Repeat' || f.type === 'Transmembrane' || f.type === 'Signal' || f.type === 'Active site' || f.type === 'Binding site').slice(0, 18)
    .map(f => `${f.type} ${f.begin}-${f.end}${f.description ? ` (${f.description.slice(0, 40)})` : ''}`) ?? []

  const lines: string[] = []
  lines.push('【靶点基本信息】')
  if (u) {
    lines.push(`UniProt: ${u.uniprotId} (${u.entryName})`)
    lines.push(`蛋白: ${u.proteinName}`)
    lines.push(`基因: ${u.geneNames.join(', ') || '-'}`)
    lines.push(`物种: ${u.organism}`)
    lines.push(`序列长度: ${u.sequenceLength} aa`)
    if (u.functionText) lines.push(`功能注释: ${u.functionText.slice(0, 600)}`)
    if (u.subcellularLocations?.length) lines.push(`亚细胞定位: ${u.subcellularLocations.join('; ')}`)
    if (u.keywords?.length) lines.push(`关键词: ${u.keywords.join(', ')}`)
    if (domainFeat.length) lines.push(`关键特征: ${domainFeat.join(' | ')}`)
  } else {
    lines.push(`未知 UniProt（序列直接输入），序列长度 ${ctx.sequence.length} aa`)
    const topHit = ctx.blastHits[0]
    if (topHit) lines.push(`BLAST 首命中: ${topHit.description}`)
  }

  lines.push('')
  lines.push('【客户目标与科学问题】')
  lines.push(ctx.goal?.trim() || ctx.goalHints.join(' / ') || '（未提供明确目标 — 按通用结构解析可行性评估）')
  if (!ctx.goal && ctx.goalHints.length) lines.push(`（评估表中提取的需求线索：${ctx.goalHints.slice(0, 4).map(elideSequenceRuns).join(' / ')}）`)
  const ins = ctx.insights
  if (ins?.scientificQuestions?.length) {
    lines.push('待解决的科学问题（评估表提取）：')
    lines.push(ins.scientificQuestions.map((q, i) => `  ${i + 1}. ${elideSequenceRuns(q)}`).join('\n'))
  }
  if (ins?.experimentalSummary) lines.push(`实验数据要点（评估表提取）：${elideSequenceRuns(ins.experimentalSummary)}`)
  if (ins?.sequenceNotes) lines.push(`构建/序列说明（评估表提取）：${elideSequenceRuns(ins.sequenceNotes)}`)
  if (ins?.homologs) lines.push(`同源/参考信息（评估表提取）：${elideSequenceRuns(ins.homologs)}`)
  if (ins?.keyConcerns?.length) lines.push(`风险关注点（评估表提取）：${ins.keyConcerns.map(elideSequenceRuns).join('；')}`)

  if (ctx.providedSequence) {
    const cmp = ctx.providedSequence.comparison
    lines.push('')
    lines.push('【客户提供序列（构建信息）】')
    lines.push(`提供序列长度 ${cmp.providedLength} aa，UniProt 全长 ${cmp.fullLength} aa（占 ${Math.round((cmp.providedLength / cmp.fullLength) * 100)}%）`)
    if (cmp.start != null && cmp.end != null) {
      lines.push(`估计对应全长区间：${cmp.start}-${cmp.end} 位`)
    }
    lines.push(`与 UniProt 序列一致性：${cmp.identity}%（${cmp.sameTarget ? '同一靶点，已合并为单次评估' : '相似度低于同靶点阈值，可能为不同靶点/同源蛋白'}）`)
    lines.push('（客户已提供具体构建序列：构建设计章节应优先评估该边界的合理性，而非另起炉灶给出完全不同的建议）')
  }

  lines.push('')
  lines.push(`【已有 PDB 结构】共 ${pdbs.length} 个（X-ray ${xrayCount} / Cryo-EM ${cryoemCount} / NMR ${nmrCount}）${bestRes != null ? `，最佳分辨率 ${bestRes}Å` : ''}`)
  if (timeline) lines.push(`按释放年份分布: ${timeline}`)
  if (topLigands) lines.push(`高频配体: ${topLigands}`)
  if (pdbs.length) {
    lines.push('代表性结构（按分辨率排序，前 14 个）:')
    lines.push('| PDB | 方法 | 分辨率 | 主要配体 | 年份 |')
    lines.push('|-----|------|--------|----------|------|')
    lines.push(pdbTable(pdbs, 14))
    lines.push('代表性结构标题:')
    lines.push(pdbs.slice(0, 10).map(p => `- ${p.pdbId}: ${p.title.slice(0, 90)}`).join('\n'))
  } else {
    lines.push('（该 UniProt 无直接关联 PDB 结构）')
  }

  if (ctx.coverage) {
    lines.push('')
    lines.push(`【结构覆盖情况】序列覆盖率 ${ctx.coverage.coveragePercent}%（PDBe 映射）`)
    lines.push(`已覆盖区间: ${ctx.coverageText}`)
    if (ctx.gapText) lines.push(`未覆盖区间（≥20aa）: ${ctx.gapText}`)
  }

  if (ctx.blastHits.length) {
    lines.push('')
    lines.push(`【BLAST 同源结构】前 12 个命中（排除直接命中后）:`)
    lines.push('| PDB | 描述 | Identity | E-value |')
    lines.push('|-----|------|----------|---------|')
    lines.push(blastTable(ctx.blastHits, 12))
  } else if (ctx.blastStatus) {
    // 0 命中/跳过/失败时向 LLM 明确说明，避免报告凭空描述同源结构
    lines.push('')
    lines.push(`【BLAST 同源结构】${describeBlastStatus(ctx.blastStatus)}（报告中请如实说明，不要虚构同源结构）`)
  }

  if (ctx.literature.length) {
    lines.push('')
    lines.push('【PubMed 文献】前 12 篇:')
    lines.push('| PMID | 标题 | 期刊·年份 |')
    lines.push('|------|------|-----------|')
    lines.push(litTable(ctx.literature, 12))
    const excerpts = ctx.literature.slice(0, 6).map(l => `- PMID ${l.pmid}: ${l.abstractExcerpt?.slice(0, 150) ?? ''}`)
    if (excerpts.length) lines.push(`摘要节选:\n${excerpts.join('\n')}`)
  }

  if (ctx.images.length) {
    lines.push('')
    lines.push('【客户提供的实验数据（评估表图片）】')
    lines.push(ctx.images.map(im => {
      const tag = im.kind === 'gel' ? '[SDS-PAGE 胶图]' : im.kind === 'sec' ? '[SEC 分子筛色谱图]' : '[其他实验图]'
      return `- ${tag} ${im.caption}${im.vlmKind ? '（类型与读数经 AI 视觉识别）' : ''}`
    }).join('\n'))
    lines.push('（以上图片已内嵌于报告图库；caption 中标注了 AI 视觉读数的条目请重点基于该读数判读：SDS-PAGE → 条带单一性/纯度估计/降解；SEC → 主峰比例/对称性/有无聚集峰/洗脱体积与预期分子量一致性）')
  }

  lines.push('')
  lines.push('【可行性评分（本系统计算，1-10）】')
  lines.push(`- X-ray: ${ctx.scores.xray.score}/10 — ${ctx.scores.rationale.xray}`)
  lines.push(`- Cryo-EM: ${ctx.scores.cryoem.score}/10 — ${ctx.scores.rationale.cryoem}`)
  lines.push(`- NMR: ${ctx.scores.nmr.score}/10 — ${ctx.scores.rationale.nmr}`)
  lines.push(`- 总体: ${ctx.scores.overall.score}/10 — ${ctx.scores.rationale.overall}`)

  return lines.join('\n')
}

// ─── 三段式生成 ───────────────────────────────────────────────────────────────

export interface ReportPart { key: string; markdown: string; llmOk: boolean; error?: string }

async function callPart(name: string, instruction: string, digest: string, signal?: AbortSignal): Promise<ReportPart> {
  const prompt = `${digest}

━━━━━━━━━━━━━━━━━━━━━━━━━━
基于以上数据上下文，${instruction}`
  const r = await llmChat(prompt, SYSTEM, signal)
  return { key: name, markdown: r.ok ? r.text : '', llmOk: r.ok, error: r.error }
}

/** 第一段：执行摘要 + 客户目标可行性 + 生物学背景 */
function partAInstruction(ctx: ReportContext): string {
  const questions = ctx.insights?.scientificQuestions ?? []
  const qLine = questions.length
    ? `- **待解决科学问题**：逐条列出评估表提取到的科学问题（共 ${questions.length} 条），并逐条回应其从结构解析角度的可回答性与难度\n`
    : ''
  return `撰写报告的以下三章（以 ## 开头，顺序输出，不要输出其他章节）：

## 执行摘要
- 3-4 段：第一段直接给出总体结论（该靶点结构解析可行性如何、推荐什么方法）；第二段概括已有结构研究情况（引用具体数字）；第三段概括客户目标的达成路径与主要风险；第四段一句话给出明确的下一步建议
- 篇幅 400-600 字

## 客户目标与可行性结论
- 先逐字重述客户目标（未提供则写"通用结构解析可行性评估"）
${qLine}- **可行性结论**：直接给出分级（高/中/低）并用一段话说明判断依据
- **关键依据**：3-5 条列表，每条引用具体数据（PDB 数量/覆盖率/最佳分辨率/同源 identity/文献证据）
- **主要风险**：2-4 条列表（构象柔性/覆盖空白/表达纯化难度/竞争风险等，基于数据判断）
- **达成建议**：1-2 段，给出最可行的切入角度
- 篇幅 500-800 字${questions.length ? '（含科学问题逐条回应）' : ''}

## 靶点生物学背景
- ### 功能与机制（基于功能注释与文献，2-3 段）
- ### 疾病与成药关联（引用文献标题证据；无数据则明确说明）
- ### 亚细胞定位与组织表达（基于定位注释，1 段）
- 篇幅 500-700 字`
}

/** 第二段：已有结构研究全景（强化模块） */
function partBInstruction(): string {
  return `撰写报告的以下三章（以 ## 开头，顺序输出，不要输出其他章节）：

## 已有结构研究全景
这是本报告的核心章节，要求"尽量全面总结已有结构的研究情况"，按以下小节展开：
- ### 研究历程概览：按年份分布描述该靶点结构研究的时间线（哪些年份集中发表、近年趋势说明了什么）
- ### 方法学分布与代表性结构：X-ray/Cryo-EM/NMR 各自的数量与代表作（点名 PDB ID + 分辨率 + 配体状态 + 期刊），指出方法学上的研究成熟度
- ### 构象状态与配体覆盖：已覆盖哪些配体结合态/突变体/复合物形式，哪些状态仍缺失（基于配体列表与结构标题推断，禁止编造）
- ### 结构覆盖与空白区：覆盖区间 vs 未覆盖区间（引用具体区间号），分析空白区可能的生物学意义（如无序区/跨膜区/末端结构域）与研究机会
- 篇幅 700-1000 字

## 同源结构分析
- 基于 BLAST 命中（若有）：identity 梯度分析、跨物种/旁系同源情况、对目标蛋白结构解析的参考价值（可作为分子置换模型/ Cryo-EM 初始模型/域边界参考）
- 若无 BLAST 数据，说明本次未运行或无命中，并给出基于直接结构的替代分析
- 篇幅 300-500 字

## 关键文献证据综合
- 按主题（结构机制/抑制剂的发现/疾病遗传学/方法学）归类综合文献证据，每条引用 PMID
- 指出文献证据支持的结论与尚存的空白
- 篇幅 300-500 字`
}

/** 第三段：实验数据评估 + 可行性矩阵 + 方案（强化模块） */
function partCInstruction(ctx: ReportContext): string {
  const hasImages = ctx.images.length > 0
  const expText = ctx.insights?.experimentalSummary
  const cmp = ctx.providedSequence?.comparison
  return `撰写报告的以下三章（以 ## 开头，顺序输出，不要输出其他章节）：

## 实验数据评估${hasImages ? '（客户评估表）' : ''}
${hasImages
    ? `- 客户上传的评估表中包含 ${ctx.images.length} 张实验图：
${ctx.images.map(i => {
      const tag = i.kind === 'gel' ? 'SDS-PAGE 胶图' : i.kind === 'sec' ? 'SEC 分子筛色谱图' : '其他实验图'
      return `  - ${tag}：${i.caption}`
    }).join('\n')}
- 基于图片 caption（含 AI 视觉读数）与评估上下文分图判读：SDS-PAGE 胶图 → 条带单一性/纯度估计/降解情况；SEC 色谱图 → 主峰比例/单分散性/是否有聚集峰/体积与预期分子量的一致性
- 给出**样品质量结论**：当前样品是否达到结构解析级别（X-ray 需 >95% 纯度+单分散；Cryo-EM 需高浓度单分散+合适粒径分布）
- 若图注信息不足以精确判读，给出"需要客户补充的信息"清单
- 篇幅 300-500 字`
    : expText
      ? `- 评估表未含胶图/SEC 图片，但已从评估表文本中提取到实验数据要点：${expText}
- 基于这些文字信息评估当前样品状态与实验成熟度，明确指出信息缺口（如未提供纯度/得率/稳定性数据）
- 给出**样品信息完备度结论**与结构解析前需补充的质控清单（SDS-PAGE、SEC、DLS、DSF 等）
- 篇幅 250-400 字`
      : `- 客户未上传评估表实验数据，说明无法评估当前样品状态
- 列出结构解析前的标准样品质控清单（SDS-PAGE 纯度、SEC 单分散性、DLS、热稳定性 DSF 等）与各项的判定标准
- 篇幅 200-300 字`}

## 结构解析可行性评估
- ### 三方法对比矩阵：用 Markdown 表格对比 X-ray / Cryo-EM / NMR 在本靶点上的适配性，行维度至少包括：分子量适配、可结晶性/成象条件、已有成功先例、构象异质性处理、预计周期、综合评分（引用系统评分）
- ### 评分依据解读：逐方法解释系统评分的含义（引用评分依据文本），哪些因素是加分项/减分项
- ### 推荐技术路线：明确给出第一推荐方法与理由、备选方法与触发条件（如 X-ray 失败多少轮后转 Cryo-EM）
- 篇幅 500-800 字

## 实验方案建议
- ### 构建设计：${cmp
      ? `客户已提供构建序列（${cmp.providedLength} aa${cmp.start != null && cmp.end != null ? `，估计对应全长 ${cmp.start}-${cmp.end} 位` : ''}，与全长一致性 ${cmp.identity}%）— 先评估该构建边界的合理性（与已有结构覆盖区间/结构域边界的匹配度），再给出微调建议（标签位置、端部微调、是否需稳定化突变）
- 禁止无视客户已有构建而另给一套完全不同的边界；若现有构建存在明显缺陷（如包含无序区/缺失关键结构域/跨膜区未处理），需明确指出并给出具体调整区间`
      : '基于结构域特征与覆盖空白，建议截短边界（引用具体区间号）、标签位置、是否需要点突变（如无序区删除/糖基化位点突变/稳定化突变）'}
- ### 表达与纯化策略：推荐表达系统（基于物种与结构域类型）、纯化流程要点（含去垢剂选择若为膜蛋白）
- ### 时间规划：Markdown 表格（阶段/预计时间/关键里程碑/风险点），总计给出一个现实的时间范围
- 篇幅 400-600 字

## 总结
- 3 段以内：核心结论重申 + 给客户的 3 条最重要建议 + 明确的 go/no-go 倾向性意见
- 篇幅 200-300 字`
}

export interface GeneratedReport {
  parts: ReportPart[]
  fullMarkdown: string
  ok: boolean
  errors: string[]
}

export async function generateReportSections(ctx: ReportContext, signal?: AbortSignal): Promise<GeneratedReport> {
  const digest = buildDigest(ctx)
  const parts: ReportPart[] = []
  const partA = await callPart('A', partAInstruction(ctx), digest, signal)
  parts.push(partA)
  const partB = await callPart('B', partBInstruction(), digest, signal)
  parts.push(partB)
  const partC = await callPart('C', partCInstruction(ctx), digest, signal)
  parts.push(partC)
  const fullMarkdown = parts.map(p => p.markdown.trim()).filter(Boolean).join('\n\n')
  const errors = parts.filter(p => !p.llmOk).map(p => `段${p.key}: ${p.error}`)
  return { parts, fullMarkdown, ok: parts.some(p => p.llmOk), errors }
}
