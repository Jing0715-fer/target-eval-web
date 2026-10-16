/**
 * POST /api/evaluate/relation — 批量评估前的靶点关系判断（v1.8）
 * 输入 { uploadId, uniprots: string[] }（docx 多靶点）；
 * 拉取各 UniProt 简介后由 LLM 判断是否合并为一份报告。
 * 判断失败不阻塞：返回降级 judgment（related=false，error 说明）。
 */
import { NextResponse } from 'next/server'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fetchUniprotInfo } from '@/lib/eval/uniprot'
import { judgeTargetRelation, type RelationTargetBrief } from '@/lib/eval/relation'
import { getOwner } from '@/lib/eval/request-guard'
import { isUploadId, uploadOwnedBy } from '@/lib/eval/upload-owner'
import { detectAntibody } from '@/lib/eval/antibody'
import type { FormInsights, ParsedSequence, RelationJudgment } from '@/lib/eval/types'

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
  if (!uploadId || !isUploadId(uploadId)) {
    return NextResponse.json({ ok: false, error: 'uploadId 无效' }, { status: 400 })
  }
  if (uniprots.length < 2) {
    return NextResponse.json({ ok: false, error: '关系判断至少需要 2 个靶点' }, { status: 400 })
  }
  if (!(await uploadOwnedBy(uploadId, owner))) {
    return NextResponse.json({ ok: false, error: '无权使用该上传（仅上传者本人可用）' }, { status: 403 })
  }

  // 读取解析结果 + LLM 要点（缺失时容错）
  const uploadDir = path.join(process.cwd(), 'db', 'reports', uploadId)
  let sequences: ParsedSequence[] = []
  let goalHints: string[] = []
  let insights: FormInsights | null = null
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(uploadDir, 'parsed.json'), 'utf-8')) as { sequences?: ParsedSequence[]; goalHints?: string[] }
    sequences = parsed.sequences ?? []
    goalHints = parsed.goalHints ?? []
  } catch { /* 解析数据缺失时仅按 UniProt 判断 */ }
  try {
    const data = JSON.parse(await fs.readFile(path.join(uploadDir, 'insights.json'), 'utf-8')) as FormInsights
    if (Array.isArray(data.goals)) insights = data
  } catch { /* insights 可选 */ }

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
  })

  return NextResponse.json({ ok: true, judgment })
}
