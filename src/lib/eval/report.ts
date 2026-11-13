/**
 * LLM 评估报告编排 — 相对原项目的优化：
 *  1. 三段式生成（摘要/背景 → 结构研究全景 → 可行性与策略），每段独立调用，
 *     输入输出体积受限，稳定性与内存占用优于单次超长调用
 *  2. 确定性数据（PDB 表/文献列表/评分/胶图）由模板直接渲染，杜绝 LLM 幻觉
 *  3. 报告要求「结论先行」「已有结构研究全景（时间线/方法学/配体态/覆盖空白）」
 *     「客户目标可行性分级（高中低）+ 关键依据 + 风险」三个强化模块
 */
import type { BlastHit, BlastStatusInfo, FormInsights, InteractionAnalysis, LiteratureItem, MwAugmentAnalysis, OligomerAnalysis, PdbEntry, PdbeCoverageResult, Scores, SequenceComparison, UniprotInfo } from './types'
import type { ParsedImage } from './types'
import type { AlphafoldSummaryInfo } from './types'
import type { LigandResolution } from './ligand'
import { describeBlastStatus } from './types'
import { describeEvidenceSource, describeOligoConfidence } from './oligomer'
import { llmChat } from './llm'
import { elideSequenceRuns } from './seq-elide'

export interface ReportContext {
  uniprot: UniprotInfo | null
  sequence: string
  goal?: string
  goalHints: string[]
  /** 评估表 LLM 智能解析要点（目标/科学问题/实验数据摘要等） */
  insights?: FormInsights
  /** 批次关系说明（v1.8+ 非关联批量：LLM 在执行摘要中说明独立/复合物项目定位） */
  batchNote?: string
  /** 客户提供的伴随序列（合并评估：UniProt 为主 + 构建边界分析） */
  providedSequence?: { sequence: string; comparison: SequenceComparison }
  /** v1.23：用户指定的评估范围（UniProt 残基编号，1-based 闭区间）；报告题目与摘要中体现 */
  range?: [number, number]
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
  /** v1.24：聚集形式（寡聚态）分析（oligomer.ts 产出） */
  oligomer?: OligomerAnalysis
  /** v2.0：配体归一结果（用户输入/上传文件/评估表识别；LLM 消费） */
  ligands?: LigandResolution[]
  /** v2.0：AlphaFold 预测信息（报告头图元数据） */
  alphafold?: AlphafoldSummaryInfo
  /** v1.26：分子量增重策略分析（mw-augment.ts 产出；小分子量靶点时 applicable=true） */
  mwAugment?: MwAugmentAnalysis
  /** v1.29：互作复合物证据分析（interaction.ts 产出；无直接结构时有证据则 hasEvidence=true） */
  interaction?: InteractionAnalysis
}

const SYSTEM = `你是一位资深结构生物学专家（CRO 结构解析项目负责人视角），为蛋白靶点撰写专业的结构解析可行性评估报告。写作要求：
- 全文使用简体中文（专业术语可保留英文），正式书面语，不使用表情符号
- 结论先行：每章开头直接给结论，再展开论据；每个 ## 章节的第一句话必须是加粗的核心结论句（**…**，一句话概括该章结论，便于速读）
- 关键数据加粗突出（PDB 数量/分辨率/identity/覆盖率等核心数字），但每段加粗不超过 2 处，避免通篇加粗
- 严格基于给定的数据上下文，禁止编造不存在的 PDB ID、PMID、分辨率或文献
- 数据里没有的信息，用"（本次数据未覆盖）"或"暂无可靠数据"明确说明
- 输出为 Markdown 子集：## / ### 标题、**加粗**、- 列表、|表格|、> 引用，不使用图片链接和代码块；## 章节标题保持简短（≤14 字）
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
    if (ctx.range) lines.push(`评估范围: 残基 ${ctx.range[0]}-${ctx.range[1]}（仅分析与该区间重叠的结构）`)
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
  if (ctx.batchNote) {
    lines.push('')
    lines.push(`【批次靶点关系】${ctx.batchNote}`)
    lines.push('（本报告属于同批次多靶点评估：请在执行摘要末尾用 1-2 句自然说明本项目的定位 — 独立项目还是与批次内其他靶点构成复合物/配对关系，以及对结构解析策略的影响）')
  }
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
  lines.push('【蛋白聚集形式（寡聚态）分析 — 系统判定，报告必写】')
  if (ctx.oligomer) {
    lines.push(`判定: ${ctx.oligomer.summary}`)
    lines.push(`化学计量: ${ctx.oligomer.stoichiometry || '未知'} · 置信度: ${describeOligoConfidence(ctx.oligomer.confidence)}`)
    if (ctx.oligomer.evidence.length) {
      lines.push('证据链（按优先级：已有结构 → 同源结构 → UniProt interaction → 文献）:')
      lines.push(ctx.oligomer.evidence.map(e => `  - [${describeEvidenceSource(e.source)}] ${e.ref}: ${e.text}`).join('\n'))
    }
    if (ctx.oligomer.notes.length) {
      lines.push('对结构解析策略的影响（系统要点，报告中需展开呼应）:')
      lines.push(ctx.oligomer.notes.map(n => `  - ${n}`).join('\n'))
    }
    lines.push('（聚集形式是结构解析可行性的关键维度：请在「已有结构研究全景」的「聚集形式与装配状态」小节中专门展开上述判定与影响要点 — 判定依据与证据链、组装界面保留、有效分子量与三方法适配、组装验证实验（SEC-MALS）、共表达 vs 体外组装选择；并在「执行摘要」与「实验方案建议」的构建设计/表达纯化策略中呼应；证据不足处如实说明）')
  } else {
    lines.push('（本次未获得寡聚态分析数据 — 如实说明，不要虚构聚集形式）')
  }

  // v1.26：分子量增重策略（小分子量靶点）— 仅 applicable 时输出完整块
  if (ctx.mwAugment?.applicable) {
    const mw = ctx.mwAugment
    lines.push('')
    lines.push('【分子量与增重策略分析（小分子量靶点）— 系统判定，融入可行性评估，不单独成章】')
    lines.push(`单体分子量: ~${mw.monomerKda} kDa`)
    lines.push(`区间解读: ${mw.zoneNote}`)
    if (mw.assemblyKda != null) {
      const pathZh = mw.assemblyPath === 'complex' ? '已有复合物结构' : mw.assemblyPath === 'oligomer' ? '自身寡聚' : mw.assemblyPath === 'homolog-complex' ? '同源复合物推断（BLAST 扩展检索，需实验验证）' : mw.assemblyPath === 'partner' ? '互作伙伴推断' : '—'
      lines.push(`装配有效分子量: ~${mw.assemblyKda} kDa（路径：${pathZh}）`)
      lines.push(`计算依据: ${mw.assemblyBasis}`)
    } else {
      lines.push('装配有效分子量: 无生物装配路径（无寡聚拷贝数/复合物结构/已注释伙伴）')
    }
    if (mw.homologSearchNote) {
      lines.push(`同源扩展检索（v1.27，直接路径装配不足 50 kDa 时触发）: ${mw.homologSearchNote}`)
    }
    if (mw.complexes.length) {
      lines.push('已有复合物结构（组分总分子量统计）:')
      lines.push(mw.complexes.map(c =>
        `  - ${c.pdbId}（${c.method}${c.resolution != null ? ` ${c.resolution}Å` : ''}）: ${c.components.map(x => `${x.isTarget ? '靶点' : x.name}~${x.kda} kDa`).join(' + ')} = ~${c.totalKda} kDa — ${c.note}`,
      ).join('\n'))
    }
    const homologs = mw.homologComplexes ?? []
    if (homologs.length) {
      lines.push('同源结构形成的大复合物（BLAST 扩展检索 — 同源亚基按靶点单体换算）:')
      lines.push(homologs.map(h =>
        `  - ${h.pdbId}（identity ${Math.round(h.identity)}%，${h.method}${h.resolution != null ? ` ${h.resolution}Å` : ''}）: ${h.componentSummary} = 同源装配 ~${h.totalKda} kDa → 按靶点换算 ~${h.estimatedKda} kDa — ${h.note}`,
      ).join('\n'))
    }
    const sizedPartners = mw.partners.filter(p => p.kda != null)
    if (sizedPartners.length) {
      lines.push(`UniProt 互作伙伴（可作增重路径，按 1:1 估计）: ${sizedPartners.slice(0, 6).map(p => `${p.geneName ?? p.proteinName ?? p.accession}（${p.accession}，${p.lengthAa} aa ~${p.kda} kDa）`).join('、')}`)
    }
    lines.push(`技术增重工具箱: ${mw.options.map(o => `${o.name}（${o.addKda}）`).join('、')}`)
    if (mw.conflicts.length) {
      lines.push('与客户目的的比对（增重组分是否冲突）:')
      lines.push(mw.conflicts.map(c => `  - [${c.level === 'aligned' ? '契合' : c.level === 'caution' ? '需注意' : '冲突'}] ${c.text}`).join('\n'))
    }
    lines.push('系统要点（报告中需展开呼应）:')
    lines.push(mw.notes.map(n => `  - ${n}`).join('\n'))
    lines.push('（分子量是小靶点结构解析方法选择的第一约束：请将上述判定融入「结构解析可行性评估」章节 — 三方法对比矩阵中 Cryo-EM 的分子量适配行按装配分子量而非单体分子量评估；推荐技术路线与构建设计中给出增重路径优先级（生理装配 → 已有复合物 → 同源复合物（BLAST 推断，组装需验证）→ 互作伙伴 → 技术组分），并逐条回应冲突分析；执行摘要用一句话点明分子量结论。同源复合物为推断证据时，需按 identity 说明置信度（≥40% 界面通常保守 / 30-40% 边缘 / <30% 仅参考）并前置组装验证建议。禁止将本分析另列为独立章节）')
  }

  // v1.29：互作复合物证据（无直接结构时）— 融入可行性评估，不单独成章
  if (ctx.interaction?.applicable) {
    const itx = ctx.interaction
    lines.push('')
    lines.push('【互作复合物证据（Complex Portal / IntAct）— 无直接结构时的评估依据，融入可行性评估，不单独成章】')
    if (itx.hasEvidence) {
      lines.push(`汇总: ${itx.summary}`)
      if (itx.subunitNote) lines.push(`UniProt SUBUNIT 注释: ${itx.subunitNote}`)
      for (const c of itx.complexes) {
        lines.push(`curated 复合物 ${c.complexAc}（${c.name}${c.assembly ? ` · ${c.assembly}` : ''}${c.assemblyKda != null ? ` · 装配 ~${c.assemblyKda} kDa` : ''}）:`)
        lines.push(c.components.map(x =>
          `  · ${x.isTarget ? `【靶点】${x.name}` : x.name}（${x.accession}${x.kda != null ? `，~${x.kda} kDa` : ''}${x.stoichiometryText ? `，${x.stoichiometryText.replace(/minValue: |maxValue: /g, '').replace(/, /g, '–')}` : ''}）${x.isTarget ? '' : x.pdbCount > 0 ? ` — ${x.pdbCount} 个结构（共有 ${x.sharedPdbIds?.length ?? 0} · 单独 ${x.soloPdbCount ?? 0}；代表：${x.representativePdbs.slice(0, 2).map(p => `${p.pdbId} ${p.resolution != null ? p.resolution + 'Å' : p.method.slice(0, 8)}`).join('、')}）` : ' — 无结构'}`,
        ).join('\n'))
        if (c.sharedPdbs?.length) {
          lines.push(`  共有结构（同一 PDB 条目含 ≥2 个复合物组分 — 组分共组装的直接先例，共 ${c.sharedPdbTotal} 个，按覆盖组分数与分辨率取优）:`)
          lines.push(c.sharedPdbs.slice(0, 6).map(s =>
            `    ◈ ${s.pdbId}（${s.componentNames.join('+')}${s.componentCount > 2 ? ` 共${s.componentCount}组分` : ''} · ${s.isXray ? 'X-ray' : s.isCryoem ? 'Cryo-EM' : s.isNmr ? 'NMR' : s.method.slice(0, 10)}${s.resolution != null ? ` ${s.resolution}Å` : ''}）${s.title ? ` — ${s.title.slice(0, 60)}` : ''}`,
          ).join('\n'))
        }
      }
      if (itx.binaryPartners.length) {
        lines.push(`binary 互作伙伴（IntAct 实验证据，复合物之外）: ${itx.binaryPartners.map(b => `${b.geneName ?? b.accession}（${b.accession}，${b.pdbCount} 个结构）`).join('、')}`)
      }
      lines.push('系统要点（报告中需展开呼应）:')
      lines.push(itx.notes.map(n => `  - ${n}`).join('\n'))
      lines.push('（互作复合物是本靶点无直接/同源结构时的核心评估依据：Complex Portal 复合物为人工审核的装配证据，化学计量可靠 — 请融入「结构解析可行性评估」与「实验方案建议」：推荐技术路线中给出复合物组装路线（共表达/体外组装）与单体路线的优先级比对，组分结构用作构建边界参考与组装验证对照；存在共有结构（同一 PDB 含 ≥2 组分）时重点说明其作为共组装先例的价值与可借鉴的组装形式；并说明该路线与客户目的是否契合（若客户需要靶点单独结构，复合物路线为间接路径）。禁止将本分析另列为独立章节）')
    } else {
      lines.push('（互作通道已检索：无 curated 复合物、binary 伙伴无结构 — 如实说明，不要虚构互作证据）')
    }
  }

  lines.push('')
  lines.push(`【已有 PDB 结构】共 ${pdbs.length} 个（X-ray ${xrayCount} / Cryo-EM ${cryoemCount} / NMR ${nmrCount}）${bestRes != null ? `，最佳分辨率 ${bestRes}Å` : ''}${ctx.interaction?.applicable && pdbs.length === 0 && ctx.interaction.hasEvidence ? '（无直接结构 — 结构证据来自互作复合物组分，见上方互作证据块）' : ''}`)
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

  if (ctx.ligands?.length) {
    lines.push('')
    lines.push('【配体研究数据（非标准输入已归一到 RCSB 三位 ID）】')
    for (const l of ctx.ligands) {
      if (l.ok) {
        const rep = l.structures.slice(0, 6).map(s => `${s.pdbId}${s.resolution != null ? `（${s.resolution}Å）` : ''}`).join('、')
        const alsoTarget = l.structures.filter(s => s.alsoTarget).map(s => s.pdbId).join('、')
        lines.push(`- ${l.raw} → ${l.compId}（${l.name}；分子式 ${l.formula || '—'}${l.weight != null ? `，MW ${l.weight}` : ''}；归一策略 ${l.strategy}）：含该配体的 PDB 结构 ${l.totalStructures} 个${rep ? `，代表结构 ${rep}` : ''}${alsoTarget ? `；其中 ${alsoTarget} 同时是本靶点的直接结构（共结晶/复合物先例）` : ''}`)
      } else {
        lines.push(`- ${l.raw}：未能归一到 PDB 化学组分（${l.error ?? '未知原因'}）— 如实说明，不要虚构`)
      }
    }
    lines.push('（请在「已有结构研究全景」的配体态小节与实验方案建议中利用上述数据：结合含该配体结构的数量、方法与分辨率分布，评估靶点-配体复合物结构解析的先例与可行性；禁止编造未列出的 PDB ID）')
  }
  if (ctx.alphafold?.available) {
    lines.push('')
    lines.push(`【AlphaFold 预测】${ctx.alphafold.modelId ?? ''}（模型 v${ctx.alphafold.version ?? '?'}）：平均 pLDDT ${ctx.alphafold.globalPlddt ?? '—'}${ctx.alphafold.fracVeryHigh != null ? `，pLDDT ≥90 区段占 ${Math.round(ctx.alphafold.fracVeryHigh * 100)}%` : ''}`)
    lines.push('（报告头部已附 pLDDT 着色的 AlphaFold 预测结构图；pLDDT ≥70 区段构象可信度较高，可作为构建设计与 Cryo-EM 分子量估计的参考 — 引用时须注明其为计算预测而非实验结构）')
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
  const mwLine = ctx.mwAugment?.applicable
    ? `，并一句话点明分子量结论（单体 ~${ctx.mwAugment.monomerKda} kDa${ctx.mwAugment.assemblyKda != null ? `，装配后 ~${ctx.mwAugment.assemblyKda} kDa${ctx.mwAugment.assemblyPath === 'homolog-complex' ? '（同源复合物推断）' : ''}` : '，无生物装配增重路径'} — 对方法选择的影响）`
    : ''
  const itxLine = ctx.interaction?.applicable && ctx.interaction.hasEvidence
    ? `；无直接/同源结构时点明互作复合物证据（${ctx.interaction.complexes[0] ? `${ctx.interaction.complexes[0].complexAc} curated 复合物${ctx.interaction.complexes[0].componentsWithStructure > 0 ? '，其他组分有结构' : ''}${ctx.interaction.complexes[0].sharedPdbTotal ? `（含 ${ctx.interaction.complexes[0].sharedPdbTotal} 个共有结构 — 组分共组装先例）` : ''}` : 'binary 互作伙伴有结构'} — 是本评估的结构证据基础）`
    : ''
  return `撰写报告的以下三章（以 ## 开头，顺序输出，不要输出其他章节）：

## 执行摘要
- 3-4 段：第一段直接给出总体结论（该靶点结构解析可行性如何、推荐什么方法）${ctx.oligomer ? '，并点明聚集形式判定（' + (ctx.oligomer.label || ctx.oligomer.summary.split('—')[0].trim()) + '）及其对方法选择的影响' : ''}${mwLine}${itxLine}；第二段概括已有结构研究情况（引用具体数字，无直接结构时说明结构证据的实际来源）；第三段概括客户目标的达成路径与主要风险；第四段一句话给出明确的下一步建议${ctx.batchNote ? '，并用 1-2 句说明本项目在同批次多靶点中的定位（独立项目/复合物相关）' : ''}
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
function partBInstruction(ctx: ReportContext): string {
  const itxB = ctx.interaction?.applicable && ctx.interaction.hasEvidence
    ? ctx.interaction.complexes.some(c => c.componentsWithStructure > 0)
      ? `\n- 本靶点无直接结构，但互作复合物（Complex Portal curated）其他组分有结构：在本章「同源结构分析」中改以「复合物组分结构参考」展开 — 各组分（基因名/PDB/分辨率）对靶点构建设计（边界借鉴）与组装策略（化学计量、共表达组合）的参考价值；组分结构不能替代靶点自身结构，需明确区分`
      : `\n- 本靶点无直接结构与同源结构，仅有互作证据（IntAct binary 伙伴/curated 复合物无组分结构）：如实说明结构证据缺位，基于 SUBUNIT 注释与互作伙伴讨论复合物组装可能性`
    : ''
  return `撰写报告的以下三章（以 ## 开头，顺序输出，不要输出其他章节）：

## 已有结构研究全景
这是本报告的核心章节，要求"尽量全面总结已有结构的研究情况"，按以下小节展开：
- ### 研究历程概览：按年份分布描述该靶点结构研究的时间线（哪些年份集中发表、近年趋势说明了什么）
- ### 方法学分布与代表性结构：X-ray/Cryo-EM/NMR 各自的数量与代表作（点名 PDB ID + 分辨率 + 配体状态 + 期刊），指出方法学上的研究成熟度
- ### 构象状态与配体覆盖：已覆盖哪些配体结合态/突变体/复合物形式，哪些状态仍缺失（基于配体列表与结构标题推断，禁止编造）
- ### 聚集形式与装配状态：引用「蛋白聚集形式（寡聚态）分析」的判定（类别/化学计量/置信度）与证据链（已有结构 → 同源结构 → UniProt interaction → 文献），说明该靶点以何种装配形式发挥功能、已有结构以何种形式解析、以及对结构解析策略的具体影响（组装界面保留/有效分子量与三方法适配/SEC-MALS 组装验证/共表达 vs 体外组装）；证据不足处如实说明
- ### 结构覆盖与空白区：覆盖区间 vs 未覆盖区间（引用具体区间号），分析空白区可能的生物学意义（如无序区/跨膜区/末端结构域）与研究机会
- 篇幅 700-1000 字

## 同源结构分析
- 基于 BLAST 命中（若有）：identity 梯度分析、跨物种/旁系同源情况、对目标蛋白结构解析的参考价值（可作为分子置换模型/ Cryo-EM 初始模型/域边界参考）
- 若无 BLAST 数据，说明本次未运行或无命中，并给出基于直接结构的替代分析${itxB}
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
  const itxC = ctx.interaction?.applicable && ctx.interaction.hasEvidence
    ? `\n- 互作复合物路线（无直接结构时的核心路径）：${ctx.interaction.complexes[0] ? `Complex Portal curated 复合物 ${ctx.interaction.complexes[0].complexAc}（${ctx.interaction.complexes[0].componentsWithStructure}/${ctx.interaction.complexes[0].components.length - 1} 个其他组分有结构${ctx.interaction.complexes[0].assemblyKda != null ? `，装配 ~${ctx.interaction.complexes[0].assemblyKda} kDa` : ''}）` : 'IntAct binary 互作伙伴有结构'} — 给出复合物组装路线（共表达组合/体外组装顺序/化学计量验证 SEC-MALS）与单体路线的优先级比对；组分结构用作构建边界参考；说明该路线与客户目的是否契合（需要靶点单独结构时复合物路线为间接路径）`
    : ''
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
- ### 三方法对比矩阵：用 Markdown 表格对比 X-ray / Cryo-EM / NMR 在本靶点上的适配性，行维度至少包括：分子量适配、可结晶性/成象条件、已有成功先例、构象异质性处理、预计周期、综合评分（引用系统评分）${ctx.mwAugment?.applicable ? '\n- 分子量维度（小分子量靶点）：Cryo-EM 的「分子量适配」按装配有效分子量（~' + (ctx.mwAugment.assemblyKda ?? ctx.mwAugment.monomerKda) + ' kDa' + (ctx.mwAugment.assemblyPath === 'homolog-complex' ? '，同源复合物推断 — 需组装验证' : ctx.mwAugment.assemblyKda == null ? '，无生物装配路径 — 需技术增重' : '') + '）评估而非单体分子量；X-ray/NMR 行说明分子量对其影响的差异（增重对 NMR 无益、对 X-ray 非瓶颈）' : ''}
- ### 评分依据解读：逐方法解释系统评分的含义（引用评分依据文本），哪些因素是加分项/减分项${ctx.mwAugment?.applicable ? '；Cryo-EM 评分中的「分子量维度」调整（' + (ctx.scores.mwAugmentAdjust ? ctx.scores.mwAugmentAdjust.note : '无') + '）需明确解读' : ''}
- ### 推荐技术路线：明确给出第一推荐方法与理由、备选方法与触发条件（如 X-ray 失败多少轮后转 Cryo-EM）${ctx.mwAugment?.applicable ? '\n- 增重路径优先级：生理装配（寡聚/复合物，已有结构先例）→ 同源复合物（BLAST 推断，identity 按高低取舍，共表达/体外组装前需 pull-down/SPR 验证互作）→ 互作伙伴复合物（无结构先例，需共表达/体外组装与 SEC-MALS 验证）→ 技术组分（Fab/nanobody/MBP/ferritin 支架）；逐条回应「与客户目的的比对」中的契合/需注意/冲突条目（加入的蛋白是否改变研究对象/锁定构象/遮蔽界面）' : ''}${itxC}
- 篇幅 500-800 字

## 实验方案建议
- ### 构建设计：${cmp
      ? `客户已提供构建序列（${cmp.providedLength} aa${cmp.start != null && cmp.end != null ? `，估计对应全长 ${cmp.start}-${cmp.end} 位` : ''}，与全长一致性 ${cmp.identity}%）— 先评估该构建边界的合理性（与已有结构覆盖区间/结构域边界的匹配度），再给出微调建议（标签位置、端部微调、是否需稳定化突变）
- 禁止无视客户已有构建而另给一套完全不同的边界；若现有构建存在明显缺陷（如包含无序区/缺失关键结构域/跨膜区未处理），需明确指出并给出具体调整区间`
      : '基于结构域特征与覆盖空白，建议截短边界（引用具体区间号）、标签位置、是否需要点突变（如无序区删除/糖基化位点突变/稳定化突变）'}${ctx.oligomer ? '；聚集形式考量：若为同源寡聚体，截短边界必须保留寡聚化界面/组装结构域（引用证据中的多拷贝链结构）；若为异源复合物依赖，说明单独亚基构建与复合物构建的分阶段策略' : ''}
- ### 表达与纯化策略：推荐表达系统（基于物种与结构域类型）、纯化流程要点（含去垢剂选择若为膜蛋白）${ctx.oligomer && ctx.oligomer.category !== 'monomer' ? '；组装验证：SEC-MALS/DLS 验证实际聚集状态与化学计量（引用寡聚态分析判定），同源寡聚体验证表观分子量为单体整数倍，异源复合物需确定亚基化学计量比' : ''}
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
  const partB = await callPart('B', partBInstruction(ctx), digest, signal)
  parts.push(partB)
  const partC = await callPart('C', partCInstruction(ctx), digest, signal)
  parts.push(partC)
  const fullMarkdown = parts.map(p => p.markdown.trim()).filter(Boolean).join('\n\n')
  const errors = parts.filter(p => !p.llmOk).map(p => `段${p.key}: ${p.error}`)
  return { parts, fullMarkdown, ok: parts.some(p => p.llmOk), errors }
}
