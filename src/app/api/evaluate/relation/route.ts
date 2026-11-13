/**
 * POST /api/evaluate/relation — 批量评估前的靶点关系判断（v1.8；v1.10 增同源归并；v1.22 增无 uploadId 模式）
 * 输入 { uploadId?, uniprots: string[], goal? }：
 *  - 有 uploadId（docx 模式）：拉取评估表解析序列 + LLM 要点后判断
 *  - 无 uploadId（v1.22 UniProt/序列多输入模式）：仅用 UniProt 元数据与全长序列判断
 * 拉取各 UniProt 简介后：① 全长序列两两同源比对（确定性证据）② 评估表序列归属（仅 docx）
 * ③ LLM 综合判断是否合并为一份报告。序列一致性 ≥40% 的靶点对直接判定同源家族
 * （LLM 不可否决 — 生物学上确定性事件）；判断失败不阻塞：降级 independent。
 */
import { NextResponse } from 'next/server'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fetchUniprotInfo } from '@/lib/eval/uniprot'
import { judgeTargetRelation, type RelationTargetBrief } from '@/lib/eval/relation'
import { getOwner } from '@/lib/eval/request-guard'
import { isUploadId, uploadOwnedBy } from '@/lib/eval/upload-owner'
import { detectAntibody } from '@/lib/eval/antibody'
import { clusterHomologs, attributeSequences, groupHighIdentity, HOMOLOG_MERGE_IDENTITY, type HomologTarget } from '@/lib/eval/homology'
import type { FormInsights, ParsedSequence, RelationJudgment, SequenceAttribution } from '@/lib/eval/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

interface RelationBody {
  uploadId?: string
  uniprots?: string[]
  goal?: string
}

export async function POST(req: Request) {
  const owner = getOwner(req)
  let body: RelationBody
  try {
    body = (await req.json()) as RelationBody
  } catch {
    return NextResponse.json({ ok: false, error: '请求体不是合法 JSON' }, { status: 400 })
  }

  const uploadId = body.uploadId?.trim()
  const uniprots = (body.uniprots ?? []).map(u => u.trim().toUpperCase()).filter(Boolean)
  // v1.22：uploadId 可选（UniProt/序列多输入模式无 uploadId）
  if (uploadId && !isUploadId(uploadId)) {
    return NextResponse.json({ ok: false, error: 'uploadId 无效' }, { status: 400 })
  }
  if (uniprots.length < 2) {
    return NextResponse.json({ ok: false, error: '关系判断至少需要 2 个靶点' }, { status: 400 })
  }
  if (uploadId && !(await uploadOwnedBy(uploadId, owner))) {
    return NextResponse.json({ ok: false, error: '无权使用该上传（仅上传者本人可用）' }, { status: 403 })
  }

  // 读取解析结果 + LLM 要点（仅 docx 模式有 uploadId；缺失时容错）
  const uploadDir = uploadId ? path.join(process.cwd(), 'db', 'reports', uploadId) : ''
  let sequences: ParsedSequence[] = []
  let goalHints: string[] = []
  let insights: FormInsights | null = null
  if (uploadId) {
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(uploadDir, 'parsed.json'), 'utf-8')) as { sequences?: ParsedSequence[]; goalHints?: string[] }
      sequences = parsed.sequences ?? []
      goalHints = parsed.goalHints ?? []
    } catch { /* 解析数据缺失时仅按 UniProt 判断 */ }
    try {
      const data = JSON.parse(await fs.readFile(path.join(uploadDir, 'insights.json'), 'utf-8')) as FormInsights
      if (Array.isArray(data.goals)) insights = data
    } catch { /* insights 可选 */ }
  }

  // 各靶点拉取 UniProt 简介（并行 + 8s 超时容错 — 失败的靶点仅用 ID 判断）
  const briefs: RelationTargetBrief[] = await Promise.all(uniprots.slice(0, 6).map(async (id) => {
    const brief: RelationTargetBrief = { label: id, uniprotId: id }
    try {
      const info = await Promise.race([
        fetchUniprotInfo(id),
        new Promise<null>(resolve => setTimeout(() => resolve(null), 8000)),
      ])
      if (info) {
        brief.proteinName = info.proteinName
        brief.geneNames = info.geneNames
        brief.organism = info.organism
        brief.functionText = info.functionText
      }
    } catch { /* 单靶点失败不阻塞判断 */ }
    return brief
  }))

  // v1.10 同源归并：全长序列两两比对（确定性证据）+ 评估表序列归属
  // fetchUniprotInfo 有 LRU 缓存，此处二次拉取命中缓存（拿到完整 sequence）
  const homologTargets: HomologTarget[] = []
  for (const id of uniprots.slice(0, 6)) {
    try {
      const info = await fetchUniprotInfo(id)
      if (info?.sequence && info.sequence.length >= 40) {
        homologTargets.push({ uniprotId: info.uniprotId, sequence: info.sequence })
      }
    } catch { /* 单靶点失败仅降级该靶点 */ }
  }
  const { pairs: homologPairs } = clusterHomologs(homologTargets)
  const hasDeterministicFamily = homologPairs.some(p => p.identity >= HOMOLOG_MERGE_IDENTITY)

  let sequenceAttribution: SequenceAttribution[] = []
  if (sequences.length && homologTargets.length) {
    // 完整传入（含过短/空序列）— attributeSequences 内部容错，保持与 parsed.sequences 的下标对应
    sequenceAttribution = attributeSequences(
      sequences.map(s => ({ header: s.header, seq: s.seq, length: s.length })),
      homologTargets,
    )
  }

  // 评估表中的序列（含抗体角色）作为关系判断的背景证据（非独立靶点，不传原始序列）
  const sequenceEvidence: Array<{ header?: string; length: number; role: 'antibody' | 'antigen' }> = []
  for (const s of sequences.slice(0, 4)) {
    if (!s.seq || s.length < 30) continue
    const ab = detectAntibody(s.seq)
    sequenceEvidence.push({
      header: s.header,
      length: s.length,
      role: ab.isAntibody ? 'antibody' : 'antigen',
    })
  }

  const judgment: RelationJudgment = await judgeTargetRelation({
    targets: briefs,
    sequences: sequenceEvidence,
    goal: body.goal,
    insights: insights ?? { goals: goalHints, scientificQuestions: [], source: 'regex' },
    homologEvidence: homologPairs.length ? homologPairs : undefined,
  })

  // 确定性覆盖：序列一致性 ≥40% 的靶点对为同源家族（LLM 判为非关联时覆盖；
  // LLM 判为 complex/fusion 等物理关联时保留 LLM 类型，仅补充同源证据）
  if (hasDeterministicFamily) {
    judgment.homologPairs = homologPairs
    if (!judgment.related) {
      const topPair = homologPairs.filter(p => p.identity >= HOMOLOG_MERGE_IDENTITY).sort((x, y) => y.identity - x.identity)[0]
      judgment.related = true
      judgment.relationType = 'homologous'
      judgment.confidence = 'high'
      judgment.rationale = `系统全长序列比对确认同源家族（${topPair.a} 与 ${topPair.b} 一致性 ${topPair.identity}%）${judgment.rationale ? `；${judgment.rationale}` : ''}`
      judgment.strategy = judgment.strategy || '同源家族合并评估：任一成员的已有结构与构建经验可直接指导其他成员'
    }
  }

  // v1.11 ≥90% 高一致组：组内仅家族代表执行一次 BLAST，其余成员委托共享结果
  // （用户反馈：同源性超过 90% 时不需要每个都检索；groupKey 带上传标识防跨批次碰撞）
  const groupKeySrc = (uploadId || uniprots.join('')).replace(/[^\w]/g, '').slice(-10)
  const blastGroups = groupHighIdentity(homologPairs, `hg${groupKeySrc}`)
  if (blastGroups.length) judgment.blastGroups = blastGroups

  return NextResponse.json({ ok: true, judgment, sequenceAttribution })
}
