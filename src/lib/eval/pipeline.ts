/**
 * 评估主管线 — 阶段化数据收集 + 评分 + LLM 报告生成 + 持久化。
 * 全流程受 AbortSignal 控制；进度按 STAGE_RANGES 区间映射。
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { db } from '@/lib/db'
import { fetchUniprotInfo, identifyUniprotBySequence, normalizeSequenceInput } from './uniprot'
import { fetchPdbEntries, fetchPdbIdsForUniprot } from './rcsb'
import { fetchPdbeCoverage, describeCoverage, uncoveredRanges } from './pdbe'
import { runBlastPdb, enrichBlastHits } from './blast'
import { buildLiteratureQuery, searchPubmed } from './pubmed'
import { computeScores } from './score'
import { generateReportSections, type ReportContext } from './report'
import { renderReportHtml } from './report-html'
import { isValidUniprotId, type BlastHit, type EvaluationOptions, type InputMode, type JobSummary, type LiteratureItem, type ParsedImage, type PdbEntry, type PdbeCoverageResult, type UniprotInfo } from './types'

export interface PipelineInput {
  jobId: string
  mode: InputMode
  uniprot?: string
  sequence?: string
  uploadId?: string
  goal?: string
  options: EvaluationOptions
}

export interface PipelineCallbacks {
  signal: AbortSignal
  report: (stageKey: string, message: string, subPercent?: number) => void
  log: (msg: string, level?: 'info' | 'warn' | 'error') => void
}

/** 上传解析结果持久化文件 */
async function readUploadParsed(uploadId: string): Promise<{ goalHints: string[] } | null> {
  try {
    const raw = await fs.readFile(path.join(process.cwd(), 'db', 'reports', uploadId, 'parsed.json'), 'utf-8')
    return JSON.parse(raw) as { goalHints: string[] }
  } catch {
    return null
  }
}

/** 从 BLAST 命中描述中解析 UniProt accession（sp|P04637|P53_HUMAN ...） */
function uniprotFromBlastDesc(desc: string): string | null {
  const m = desc.match(/(?:sp|tr)\|([A-NR-Z][0-9][A-Z][A-Z0-9]{2}[0-9]|[OPQ][0-9][A-Z0-9]{3}[0-9])\|/)
  return m ? m[1] : null
}

export async function runPipeline(input: PipelineInput, cb: PipelineCallbacks): Promise<void> {
  const t0 = Date.now()
  const { signal, report, log } = cb
  const maxPdb = Math.min(300, Math.max(20, input.options.maxPdb || 150))

  // ─── 阶段 1：输入解析 ──────────────────────────────────────────────────────
  report('input', '解析输入…', 0.3)
  let goal = input.goal?.trim() || ''
  let goalHints: string[] = []
  let images: ParsedImage[] = []
  let assetDir = ''

  if (input.uploadId) {
    const parsed = await readUploadParsed(input.uploadId)
    if (parsed?.goalHints?.length) goalHints = parsed.goalHints
  }

  let uniprotInfo: UniprotInfo | null = null
  let sequence = ''
  let uniprotIdInput: string | null = null

  if (input.mode === 'uniprot') {
    const id = (input.uniprot ?? '').trim().toUpperCase()
    if (!isValidUniprotId(id)) throw new Error(`UniProt ID 格式无效：${id}（应为 6 位，如 P00533）`)
    uniprotIdInput = id
    report('input', `输入 UniProt ID：${id}`, 0.8)
  } else if (input.mode === 'docx') {
    // docx：优先用解析出的 UniProt（序列将从 UniProt 获取）；否则用评估表中的序列
    const id = (input.uniprot ?? '').trim().toUpperCase()
    if (id && isValidUniprotId(id)) {
      uniprotIdInput = id
      report('input', `评估表解析出 UniProt ID：${id}`, 0.8)
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
    if (!sequence) sequence = info.sequence
    log(`UniProt 元数据完成：${info.entryName}（${info.proteinName}，${info.sequenceLength} aa，${info.organism}）`)
    report('uniprot', 'UniProt 元数据完成', 1)
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
    report('uniprot', uniprotInfo ? 'UniProt 识别完成' : '无直接 UniProt 匹配（BLAST 兜底）', 1)
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

  // ─── 阶段 5：BLAST ────────────────────────────────────────────────────────
  let blastHits: BlastHit[] = []
  const coveragePct = coverage?.coveragePercent ?? 0
  const shouldBlast = !input.options.skipBlast
    && (input.options.forceBlast || !uniprotInfo || directPdbs.length < 5 || coveragePct < 50)
  if (shouldBlast) {
    report('blast', '提交 BLASTp（NCBI pdbaa）…', 0.05)
    try {
      const rawHits = await runBlastPdb(sequence, msg => {
        report('blast', msg, 0.3)
      }, signal)
      const directSet = new Set(directPdbs.map(p => p.pdbId))
      const filtered = rawHits.filter(h => h.pdbId && !directSet.has(h.pdbId))
      blastHits = await enrichBlastHits(filtered, directSet)
      log(`BLAST 完成：${rawHits.length} 个命中，去重/排除直接命中后 ${blastHits.length} 个`)
      // 序列模式且尚未识别 UniProt：从最佳命中回填
      if (!uniprotInfo && blastHits.length > 0) {
        const best = rawHits[0]
        const acc = uniprotFromBlastDesc(best.description)
        if (acc && best.identity >= 85) {
          log(`从 BLAST 命中识别 UniProt ${acc}（identity ${best.identity}%），回填元数据…`)
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
              const directSet2 = new Set(directPdbs.map(p => p.pdbId))
              blastHits = (await enrichBlastHits(filtered, directSet2)).filter(h => !directSet2.has(h.pdbId))
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
      report('blast', `BLAST 完成（${blastHits.length} 个同源结构）`, 1)
    } catch (e) {
      if (signal.aborted) throw e
      log(`BLAST 失败：${e instanceof Error ? e.message : e}（继续后续阶段）`, 'warn')
      report('blast', 'BLAST 不可用（跳过）', 1)
    }
  } else {
    report('blast', input.options.skipBlast ? '已按选项跳过 BLAST' : '结构覆盖充分，跳过 BLAST', 1)
    log('跳过 BLAST（结构覆盖充分或用户关闭）')
  }

  // ─── 阶段 6：PubMed 文献 ──────────────────────────────────────────────────
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
  report('pubmed', `文献检索完成（${literature.length} 篇）`, 1)

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
  report('report', '整理数据上下文…', 0.05)
  // 收集评估表图片元数据（来自 uploadId 的 parsed.json）
  if (input.uploadId) {
    assetDir = path.join(process.cwd(), 'db', 'reports', input.uploadId, 'assets')
    try {
      const raw = await fs.readFile(path.join(process.cwd(), 'db', 'reports', input.uploadId, 'parsed.json'), 'utf-8')
      const parsed = JSON.parse(raw) as { images?: ParsedImage[] }
      images = (parsed.images ?? []).slice(0, 12)
    } catch { /* 无图片元数据 */ }
  }

  const reportCtx: ReportContext = {
    uniprot: uniprotInfo,
    sequence,
    goal: goal || undefined,
    goalHints,
    directPdbs,
    blastHits,
    coverage,
    coverageText,
    gapText,
    literature,
    images,
    scores,
  }

  report('report', 'LLM 生成评估分析（第 1/3 段：摘要与背景）…', 0.15)
  const generated = await generateReportSections(reportCtx, signal)
  for (let i = 0; i < generated.parts.length; i++) {
    const p = generated.parts[i]
    report('report', `LLM 第 ${['1', '2', '3'][i]}/3 段（${['摘要与背景', '结构研究全景', '可行性与策略'][i]}）${p.llmOk ? '完成' : '失败'}${p.llmOk ? `（${p.markdown.length} 字）` : `：${p.error}`}`, (i + 1) / 3)
    log(`LLM 报告段 ${p.key} ${p.llmOk ? `完成（${p.markdown.length} 字）` : `失败：${p.error}`}`, p.llmOk ? 'info' : 'warn')
  }

  // HTML 渲染 + 落盘
  report('report', '组装 HTML 报告…', 0.95)
  const html = await renderReportHtml({
    ctx: reportCtx,
    methodStats: scores.methodStats,
    llmMarkdown: generated.fullMarkdown,
    llmOk: generated.ok,
    llmErrors: generated.errors,
    jobId: input.jobId,
    durationMs: Date.now() - t0,
    totalPdbFound,
    resolveImagePath: (meta) => {
      const ext = meta.mime.includes('png') ? 'png' : meta.mime.includes('gif') ? 'gif' : meta.mime.includes('webp') ? 'webp' : 'jpg'
      return path.join(assetDir, `${meta.id}.${ext}`)
    },
  })
  const reportDir = path.join(process.cwd(), 'db', 'reports', input.jobId)
  await fs.mkdir(reportDir, { recursive: true })
  const reportPath = path.join(reportDir, 'report.html')
  await fs.writeFile(reportPath, html, 'utf-8')

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
      error: null,
      updatedAt: new Date(),
    },
  })

  // 图片资产登记（供 /api/assets 访问）
  if (images.length) {
    for (let i = 0; i < images.length; i++) {
      const meta = images[i]
      const ext = meta.mime.includes('png') ? 'png' : meta.mime.includes('gif') ? 'gif' : meta.mime.includes('webp') ? 'webp' : 'jpg'
      await db.reportAsset.upsert({
        where: { id: meta.id },
        create: { id: meta.id, jobId: input.jobId, kind: meta.kind, caption: meta.caption, mime: meta.mime, size: meta.sizeKB * 1024, path: path.join(assetDir, `${meta.id}.${ext}`), order: i },
        update: { jobId: input.jobId, order: i },
      }).catch(() => undefined)
    }
  }

  log(`评估完成：总耗时 ${(durationMs / 1000).toFixed(1)}s，报告已生成`)
}
