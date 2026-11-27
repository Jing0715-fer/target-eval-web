/**
 * POST /api/evaluate — 创建评估作业（串行队列执行）
 * 公网加固：记录创建者归属（IP 哈希）、创建前配额检查（全局排队上限 /
 * 每 IP 活跃与日配额）、上传目录归属校验、触发终态作业 TTL 清理。
 */
import { NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { db } from '@/lib/db'
import { createJobSnapshot, enqueueJob, getJobSnapshot, makeReporter, setJobRunning, markStatus, reapOrphanJobs, rememberDedup, findActiveByFingerprint } from '@/lib/eval/job-manager'
import { runPipeline } from '@/lib/eval/pipeline'
import { getOwner } from '@/lib/eval/request-guard'
import { runWithLlmOverride, sanitizeLlmOverride } from '@/lib/eval/llm-provider'
import { checkJobQuota, quotaResponse, scheduleJobTtlCleanup, QuotaError } from '@/lib/eval/gatekeeper'
import { isUploadId, uploadOwnedBy } from '@/lib/eval/upload-owner'
import { isYearSpan } from '@/lib/eval/construct-range'
import { MAX_PDB_UNLIMITED, type BlastGroup, type EvaluationOptions, type InputMode } from '@/lib/eval/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 600

interface EvaluateBody {
  mode?: InputMode
  uniprot?: string
  sequence?: string
  /** v2.16：序列标签头（FASTA 头/评估表序列标签 — 靶点命名证据 + 头内 UniProt 提取） */
  sequenceHeader?: string
  docxJobId?: string
  uploadId?: string
  uniprotFromDocx?: string
  sequenceFromDocx?: string
  goal?: string
  /** 批次关系说明（非关联批量：注入报告说明独立/复合物定位，≤500 字） */
  batchNote?: string
  /** ≥90% 高一致同源组委托（v1.11）：组内首个到达 BLAST 阶段的作业为代表，其余共享结果不重复检索 */
  homologBlast?: Partial<BlastGroup>
  /** v2.0：配体输入（名称/分子式/三位 ID；上传文件提取的线索），最多 8 条 */
  ligands?: Array<{ raw: string; source?: 'text' | 'file' | 'eval-table'; fileName?: string }>
  /** v2.19：用户本地引擎配置（localStorage → 请求内联携带；服务端不落盘） */
  llm?: { providerKey?: string; baseUrl?: string; apiKey?: string; model?: string }
  options?: Partial<EvaluationOptions>
}

export async function POST(req: Request) {
  const owner = getOwner(req)

  let body: EvaluateBody
  try {
    body = (await req.json()) as EvaluateBody
  } catch {
    return NextResponse.json({ ok: false, error: '请求体不是合法 JSON' }, { status: 400 })
  }

  const mode = body.mode
  if (mode !== 'uniprot' && mode !== 'sequence' && mode !== 'docx') {
    return NextResponse.json({ ok: false, error: 'mode 必须是 uniprot / sequence / docx 之一' }, { status: 400 })
  }

  const uploadId = body.docxJobId || body.uploadId || undefined
  const sequence = body.sequence || body.sequenceFromDocx || undefined
  const uniprot = body.uniprot || body.uniprotFromDocx || undefined
  // v2.16：序列标签头消毒（≤80 字，与状态字段同口径）
  const sequenceHeader = typeof body.sequenceHeader === 'string' ? body.sequenceHeader.trim().slice(0, 80) || undefined : undefined

  if (mode === 'uniprot' && !uniprot) {
    return NextResponse.json({ ok: false, error: 'mode=uniprot 需要 uniprot 字段' }, { status: 400 })
  }
  if (mode === 'sequence' && !sequence) {
    return NextResponse.json({ ok: false, error: 'mode=sequence 需要 sequence 字段' }, { status: 400 })
  }
  if (mode === 'docx' && !uniprot && !sequence) {
    return NextResponse.json({ ok: false, error: 'mode=docx 需要评估表中解析出的 uniprot 或 sequence（请先上传并选择）' }, { status: 400 })
  }

  // 上传目录归属校验（防跨用户引用他人上传的评估表/图片）
  if (uploadId) {
    if (!isUploadId(uploadId)) {
      return NextResponse.json({ ok: false, error: 'uploadId 无效' }, { status: 400 })
    }
    const owned = await uploadOwnedBy(uploadId, owner)
    if (!owned) {
      return NextResponse.json({ ok: false, error: '无权使用该上传（仅上传者本人可用）' }, { status: 403 })
    }
  }

  // 并发/配额守卫（全局排队上限 + 每 IP 活跃上限 + 日配额）
  // v2.18.1：先清理孤儿作业（进程重启后内存队列蒸发，DB pending 残留死行会
  // 虚增排队计数，把所有新评估堵死——24 条孤儿堆积即此事故）。
  // 失败静默：DB 不可用时退回原行为（仅计数，不清理）。
  await reapOrphanJobs().catch(() => undefined)
  try {
    const quota = await checkJobQuota(owner.key)
    if (!quota.ok && quota.error) throw quota.error
  } catch (e) {
    if (e instanceof QuotaError) return quotaResponse(e)
    // v2.103：真实异常必须落日志（用户实测「配额检查失败」暂停整场运行时
    //  dev.log 零痕迹 — count 查询撞 DB 锁等瞬时错误全靠猜）；文案同时避开
    //  前端 isRateLimitError 的限流关键词（「配额」二字曾把 500 误判成 429
    //  限流 → pauseWithReason 整场暂停 — 瞬时错误只应标该靶点 error）
    console.error('[evaluate] 配额检查异常（DB count 查询失败，非真实限流）：',
      e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e))
    return NextResponse.json({ ok: false, error: '服务暂时不可用，请稍后重试' }, { status: 500 })
  }

  // v1.23 评估范围限定（UniProt 残基编号，1-based 闭区间）：仅 UniProt 单靶点无伴随序列时有效
  // v2.37 年份区间守卫：两端均在 1900-2099 且跨度 ≤60（如 2022-2024 流行年份）→ 忽略，
  // 评估区间改由管线在 BLAST 归属后推导（构建比对 / BLAST nr HSP）
  const rawRange = body.options?.range
  let range: [number, number] | undefined
  if (Array.isArray(rawRange) && rawRange.length === 2) {
    const s = Number(rawRange[0]), e = Number(rawRange[1])
    if (Number.isFinite(s) && Number.isFinite(e) && s >= 1 && e >= s && e <= 100000) {
      const rs = Math.round(s), re = Math.round(e)
      if (!isYearSpan(rs, re)) range = [rs, re]
    }
  }

  // v2.72：复合物评估中同行的抗体链（HT 序列靶点行携带 — 抗体已忽略不评估，
  // 但其分子量计入抗原的 Cryo-EM 复合物评分）。链数 1-20、合计长度 90-20000。
  const rawAbp = body.options?.antibodyPartner
  const antibodyPartner = rawAbp && typeof rawAbp === 'object'
    && Number.isFinite(rawAbp.chains) && rawAbp.chains >= 1 && rawAbp.chains <= 20
    && Number.isFinite(rawAbp.lengthAa) && rawAbp.lengthAa >= 90 && rawAbp.lengthAa <= 20000
    ? { chains: Math.round(rawAbp.chains), lengthAa: Math.round(rawAbp.lengthAa) }
    : undefined

  const options: EvaluationOptions = {
    skipBlast: body.options?.skipBlast ?? false,
    forceBlast: body.options?.forceBlast ?? false,
    // v2.5：MAX_PDB_UNLIMITED（10000）= 不限；普通值仍在 20-300 区间
    maxPdb: body.options?.maxPdb === MAX_PDB_UNLIMITED ? MAX_PDB_UNLIMITED : Math.min(300, Math.max(20, body.options?.maxPdb ?? 150)),
    reportMode: body.options?.reportMode === 'deferred' ? 'deferred' : 'single',
    range,
    // v2.29：结构域名提示（评估表不写区间而写域名 — 管线内与 UniProt domain 划分匹配推导区间）
    rangeHint: typeof body.options?.rangeHint === 'string' && body.options.rangeHint.trim()
      ? body.options.rangeHint.trim().slice(0, 60) : undefined,
    antibodyPartner,
  }
  const batchNote = body.batchNote?.trim().slice(0, 500) || undefined
  // v2.19：用户本地引擎配置消毒（未知供应商/缺模型名 → 回退内置；不持久化）
  const llmOverride = sanitizeLlmOverride(body.llm)
  // v2.0 配体输入消毒（去空/截断/上限 8 条）
  const rawLigands: Array<{ raw: string; source?: 'text' | 'file' | 'eval-table'; fileName?: string }> = Array.isArray(body.ligands) ? body.ligands : []
  const ligands = rawLigands
    .map(l => ({
      raw: String(l?.raw ?? '').trim().slice(0, 160),
      source: l?.source === 'file' ? 'file' as const : l?.source === 'eval-table' ? 'eval-table' as const : 'text' as const,
      fileName: typeof l?.fileName === 'string' ? l.fileName.slice(0, 80) : undefined,
    }))
    .filter(l => l.raw.length > 0)
    .slice(0, 8)


  // v1.11 同源家族 BLAST 委托（宽松校验：字段形态不对则忽略，不影响常规评估）
  const hb = body.homologBlast
  const homologBlast = hb
    && typeof hb.groupKey === 'string' && /^hg[\w-]{1,48}$/.test(hb.groupKey)
    && Array.isArray(hb.members) && hb.members.length >= 2 && hb.members.length <= 6
    && hb.members.every(m => typeof m === 'string' && /^[A-Z0-9-]{6,16}$/.test(m))
    && typeof hb.minIdentity === 'number' && hb.minIdentity >= 40 && hb.minIdentity <= 100
    ? { groupKey: hb.groupKey, members: hb.members, minIdentity: hb.minIdentity }
    : undefined

  // ── v2.40 同靶点活跃作业接续（dedup-attach，防重复占坑）──
  // 用户事故：恢复运行时同一靶点被重复提交（旧作业仍在执行但客户端已放弃），
  // 旧僵尸耗尽并发坑位 → 新提交 429 → 整场运行被限流暂停。
  // 同一归属对「完全相同的评估输入」（靶点/序列/区间/目标/配体/引擎全部一致）
  // 重复提交时直接接上仍在执行的既有作业：不新建、不占配额；输入有任何
  // 差异（如不同 goal / 不同构建区间 / 不同引擎）指纹不同 → 照常新建。
  const dedupFp = createHash('sha256').update(JSON.stringify([
    mode,
    uniprot?.toUpperCase() ?? null,
    sequence ?? null,
    uploadId ?? null,
    body.goal?.slice(0, 2000) ?? null,
    batchNote ?? null,
    homologBlast?.groupKey ?? null,
    ligands,
    options,
    llmOverride ? [llmOverride.providerKey, llmOverride.baseUrl ?? null, llmOverride.model, llmOverride.apiKey ?? null] : null,
  ])).digest('hex').slice(0, 40)
  const attachedId = findActiveByFingerprint(owner.key, dedupFp)
  if (attachedId) {
    return NextResponse.json({ ok: true, jobId: attachedId, attached: true })
  }

  // 创建 DB 记录（pending）— 记录归属（哈希键 + 掩码）
  // v2.34：序列靶点标题用 sequenceHeader（结构交付行 = 「文件名·链N」）— 百行级
  // 高通量运行中全部叫「序列靶点」无法区分；无标签时退回长度描述
  const seqTitle = mode === 'sequence'
    ? (sequenceHeader
        ? sequenceHeader.slice(0, 60)
        : `序列靶点 ${typeof sequence === 'string' ? sequence.length : '?'}aa`)
    : '评估表靶点'
  const job = await db.evaluationJob.create({
    data: {
      status: 'pending',
      mode,
      title: mode === 'uniprot' ? `UniProt ${uniprot}` : seqTitle,
      uniprotId: uniprot?.toUpperCase() ?? null,
      goal: body.goal?.slice(0, 2000) ?? null,
      options: JSON.stringify(options),
      ownerKey: owner.key,
      ownerMask: owner.mask,
    },
  })

  // 惰性触发终态作业 TTL 清理（fire-and-forget）
  scheduleJobTtlCleanup()

  // v2.40：登记指纹 → 本作业活跃期间同靶点重复提交直接接上
  rememberDedup(owner.key, dedupFp, job.id)

  // 内存快照 + 串行队列
  createJobSnapshot(job.id)
  const { report, log } = makeReporter(job.id)

  enqueueJob(() => runWithLlmOverride(llmOverride, async () => {
    // v2.19：整个管线在用户引擎的请求作用域内执行（AsyncLocalStorage 随 await 链
    // 传播 — 含 getEngineSummary 报告标注；Key 仅存活于本作业内存，不落盘）
    // 复用已有快照（保留排队期间的取消标记），不存在才补建
    const snap = getJobSnapshot(job.id) ?? createJobSnapshot(job.id)
    if (snap.status === 'canceled') return
    setJobRunning(job.id)
    await db.evaluationJob.update({ where: { id: job.id }, data: { status: 'running', updatedAt: new Date() } }).catch(() => undefined)
    report('input', '开始评估…', 0)
    log(`作业开始：mode=${mode}${uniprot ? ` uniprot=${uniprot}` : ''}${sequence ? ` seqLen=${sequence.length}` : ''}${uploadId ? ` uploadId=${uploadId}` : ''}`)
    try {
      await runPipeline(
        {
          jobId: job.id,
          mode,
          uniprot: uniprot?.toUpperCase(),
          sequence,
          sequenceHeader,
          uploadId,
          goal: body.goal?.slice(0, 2000), // v2.5：与 DB 落库同口径截断（防无界载荷进 LLM prompt）
          batchNote,
          homologBlast,
          ligands,
          options,
        },
        { signal: snap.abort.signal, report, log },
      )
      markStatus(job.id, 'done')
      await db.evaluationJob.update({
        where: { id: job.id },
        data: { logs: JSON.stringify(snap.logs), updatedAt: new Date() },
      }).catch(() => undefined)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const aborted = snap.abort.signal.aborted || /abort/i.test(msg)
      const status = aborted ? 'canceled' : 'error'
      markStatus(job.id, status)
      log(`作业${status === 'canceled' ? '已取消' : `失败：${msg}`}`, 'error')
      await db.evaluationJob.update({
        where: { id: job.id },
        data: {
          status,
          error: status === 'canceled' ? '用户取消' : msg.slice(0, 500),
          logs: JSON.stringify(snap.logs),
          updatedAt: new Date(),
        },
      }).catch(() => undefined)
    }
  }))

  return NextResponse.json({ ok: true, jobId: job.id })
}
