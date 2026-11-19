/**
 * POST /api/evaluate/blast-warmup — BLAST 预热（v2.39 用户诉求「先把 BLAST 都提交起来，加快进度」）。
 *
 * 高通量运行启动/恢复时，前端把全部待评估靶点（序列 / UniProt ID）一次性发来：
 *  - UniProt ID → 解析出 BLAST 序列（cachedJsonFetch 缓存 — 管线随后同键复用）
 *  - 序列规范化（与管线 st.sequence 同口径 → 序列哈希可精确命中）
 *  - 抗体序列默认跳过（forceBlast=true 除外 — 与管线 blast-submit 决策一致）
 *  - 去重后排入服务端全局节拍队列（~15s/发），作业还在队列排队时 NCBI 已在计算
 *
 * 管线 blast-submit 阶段按序列哈希命中预提交 RID（takePresubmittedBlast）：
 * 命中即跳过提交直接收集 — 慢队列下总时长大幅缩短；未命中回退常规提交，行为不变。
 *
 * 边界：单次 ≤ 200 条 / 每 IP 每日 ≤ 800 条 / 注册表 ≤ 300（终态 1h 淘汰）；
 * 全部失败静默（管线常规提交兜底，预热永远不阻塞主流程）。
 */
import { NextResponse } from 'next/server'
import { getOwner } from '@/lib/eval/request-guard'
import { fetchUniprotInfo, normalizeSequenceInput } from '@/lib/eval/uniprot'
import { detectAntibody } from '@/lib/eval/antibody'
import { presubmitBlastSequence, presubmitRegistrySize } from '@/lib/eval/blast'
import { isValidUniprotId } from '@/lib/eval/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_PER_REQUEST = 200
const MAX_PER_IP_PER_DAY = 800
/** UniProt 序列解析并发（cachedJsonFetch — 小并发即秒级完成，防请求超时） */
const UNIPRO_RESOLVE_CONCURRENCY = 5

/** 每 IP 24h 滑动窗口（内存 — 与上传窗口同模式，HMR 共享） */
const g = globalThis as unknown as { __blastWarmupWindow?: Map<string, number[]> }
const warmupWindow: Map<string, number[]> = (g.__blastWarmupWindow ??= new Map())

interface WarmupBody {
  sequences?: unknown
  uniprots?: unknown
  forceBlast?: unknown
}

export async function POST(req: Request) {
  const owner = getOwner(req)

  let body: WarmupBody
  try {
    body = (await req.json()) as WarmupBody
  } catch {
    return NextResponse.json({ ok: false, error: '请求体不是合法 JSON' }, { status: 400 })
  }
  const forceBlast = body.forceBlast === true
  const rawSeqs = Array.isArray(body.sequences) ? body.sequences : []
  const rawAccs = Array.isArray(body.uniprots) ? body.uniprots : []
  const total = rawSeqs.length + rawAccs.length
  if (total === 0) {
    return NextResponse.json({ ok: false, error: '未提供任何序列或 UniProt ID' }, { status: 400 })
  }
  if (total > MAX_PER_REQUEST) {
    return NextResponse.json({ ok: false, error: `单次最多预热 ${MAX_PER_REQUEST} 条（本次 ${total}）— 请分批提交` }, { status: 400 })
  }

  // 每 IP 每日窗口
  const now = Date.now()
  const dayAgo = now - 24 * 60 * 60_000
  const list = (warmupWindow.get(owner.key) ?? []).filter((t) => t > dayAgo)
  if (list.length >= MAX_PER_IP_PER_DAY) {
    return NextResponse.json(
      { ok: false, error: `近 24 小时已预热 ${list.length} 条序列（每日上限 ${MAX_PER_IP_PER_DAY}），明日再试` },
      { status: 429, headers: { 'Retry-After': '3600' } },
    )
  }

  // ① UniProt ID → BLAST 序列（小并发解析；失败跳过 — 管线常规提交兜底）
  const accs: string[] = []
  for (const raw of rawAccs) {
    if (typeof raw !== 'string') continue
    const acc = raw.trim().toUpperCase().slice(0, 16)
    if (acc && isValidUniprotId(acc)) accs.push(acc)
  }
  let uniprotResolved = 0
  const uniprotSeqs: string[] = []
  for (let i = 0; i < accs.length; i += UNIPRO_RESOLVE_CONCURRENCY) {
    const batch = accs.slice(i, i + UNIPRO_RESOLVE_CONCURRENCY)
    const results = await Promise.allSettled(batch.map((acc) => fetchUniprotInfo(acc)))
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value?.sequence) {
        uniprotSeqs.push(r.value.sequence)
        uniprotResolved++
      }
    }
  }

  // ② 裸序列规范化（与管线 st.sequence 同口径 — 哈希命中的一致性前提）
  const normSeqs: string[] = []
  for (const raw of rawSeqs) {
    if (typeof raw !== 'string') continue
    const norm = normalizeSequenceInput(raw)
    if (norm.ok) normSeqs.push(norm.seq)
  }

  // ③ 抗体过滤（与管线 blast-submit 决策一致 — forceBlast 除外）
  let antibodySkipped = 0
  const blastSeqs: string[] = []
  for (const s of [...uniprotSeqs, ...normSeqs]) {
    if (detectAntibody(s).isAntibody && !forceBlast) {
      antibodySkipped++
      continue
    }
    blastSeqs.push(s)
  }

  // ④ 去重入队（全局 ~15s 节拍链 — presubmitBlastSequence 幂等）
  let submitted = 0
  for (const s of blastSeqs) {
    if (presubmitBlastSequence(s)) submitted++
  }

  // 每日窗口计数（按有效序列数计）
  if (blastSeqs.length > 0) {
    list.push(...blastSeqs.map(() => now))
    warmupWindow.set(owner.key, list)
  }

  return NextResponse.json({
    ok: true,
    submitted,
    deduped: blastSeqs.length - submitted,
    uniprotResolved,
    invalidSkipped: Math.max(0, total - accs.length - normSeqs.length),
    antibodySkipped,
    registrySize: presubmitRegistrySize(),
    note: '服务端按 ~15s/条节拍陆续提交 NCBI；作业开始评估时自动命中预提交结果（按序列精确匹配），未命中则常规提交，无需额外操作。',
  })
}
