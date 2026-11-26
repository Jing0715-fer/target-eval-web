/**
 * v2.99 旧版报告自动升级（上传/读回时补全至最新版）。
 *
 * 用户规则：上传报告后，如果报告是通过旧版生成的，则更新成最新版 — 补全后续
 * 版本加入的内容。两条互补通道：
 *
 * 1) **确定性补丁链**（applyReportPatchChain — 零 IO，与三个报告服务路由同源
 *    的幂等升级函数串）：响应式版心 / 灯箱放大 / 打印 UX / 表格筛选排序 /
 *    比对面板块宽自适应 + 非缺口口径重算（aln-fit-v2）。特性标记检测 —
 *    「旧版报告」即缺任一标记的报告，新版报告原样返回（幂等）。
 *
 * 2) **比对面板内容回填**（backfillAlignmentPanel — 读作业数据快照）：
 *    v2.96 前生成的报告没有「序列比对」面板（提交序列 ↔ UniProt 条目 — 悬停
 *    残基号）。面板数据 = Smith-Waterman 局部比对（纯 CPU 无网络），输入是
 *    提交序列与条目序列 — 前者不在报告 HTML 里（仅 SHA/长度标记），后者同样
 *    不在；两序列都在评估完成时落盘的 db/reports/{jobId}/llm-ctx.json 快照
 *    （v2.51 起）。回填按管线 v2.96 收尾同口径（已归属 + 非 100% 一致性才展示，
 *    ≥99.95% 完全归属无需比对佐证），注入面板 HTML + 面板 CSS + 悬停脚本 +
 *    块宽自适应脚本（applyAlignLayoutUpgrade）。快照缺失/规则不满足/注入点
 *    不明 → 静默跳过（报告保持原内容，零回归风险）。
 *
 * 接入面（v2.99）：
 *  - storeImportedReportHtml（导入报告上传留存 — 含去重命中旧记录的就地治愈）；
 *  - ht-dashboard 载荷内嵌读取（htPayloadJsonChunks — 留存/作业报告文件逐份
 *    升级后内嵌弹出页）；
 *  - jobs/[id]/report（旧作业报告在线查看/下载/PDF）；
 *  - ht-archive（批量下载 zip 内的作业报告条目）；
 *  - report-merged loadMergedTargets（旧合并报告重渲染的单独评估页 — 经
 *    summary 缺口走同一快照回填，见 alignmentForLegacyJob）。
 *
 * 注意：回填不改变报告结论 — 身份识别级联（PDB 同源 → EBI → nr/全库 → 精确
 * 匹配）需要 BLAST 网络，不在升级范围；只有「已归属靶点的比对证据可视化」
 * （v2.96 面板）与展示层升级可确定性补全。
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {
  applyResponsiveOverride,
  applyZoomUpgrade,
  applyUxUpgrade,
  applyTableFilterUpgrade,
  applyAlignLayoutUpgrade,
  ALIGN_PANEL_CSS,
  ALIGN_TIP_JS,
  identityAlignmentPanelHtml,
} from './report-html'
import { alignForIdentityEvidence } from './identity-align'
import type { IdentityAlignment, TargetIdentityInfo } from './types'

/** ALIGN_TIP_JS 的幂等标记（脚本内注释 — 旧报告无此标记才注入） */
const ALIGN_TIP_MARKER = 'aln-tip-v1'

/** 面板存在性判据 — 真实面板 div（class="aln-panel"）。不能用裸 'aln-panel'：
 *  v2.96+ 报告的样式表本身就含 .aln-panel 选择器（无面板的报告也会命中
 *  字符串，误判为已回填）。 */
const PANEL_PRESENT = 'class="aln-panel"'

/** 作业 id 护栏（cuid 形态 — 同时防路径穿越：非 [a-z0-9] 一律拒绝） */
const JOB_ID_RE = /^[a-z0-9]{16,40}$/

/** llm-ctx.json 快照的最小字段（回填只用这些 — 其余字段忽略） */
interface LlmCtxLite {
  ctx?: {
    sequence?: string
    uniprot?: { uniprotId?: string; entryName?: string; sequence?: string } | null
    targetIdentity?: TargetIdentityInfo
    /** 构建比对（合并评估的伴随序列 — 身份一致性兜底口径） */
    providedSequence?: { comparison?: { identity?: number } }
    /** v2.96+ 快照自带比对（权威 — 直接采信） */
    identityAlignment?: IdentityAlignment
  } | null
}

/** 展示层幂等补丁链（与 jobs/report 路由同序 — 零 IO） */
export function applyReportPatchChain(html: string): string {
  return applyAlignLayoutUpgrade(
    applyTableFilterUpgrade(
      applyUxUpgrade(
        applyZoomUpgrade(
          applyResponsiveOverride(html),
        ),
      ),
    ),
  )
}

/** 从报告 HTML 的 targeteval:job meta 提取作业 id（v2.68+ 报告携带；更早的报告返回 null） */
export function parseReportJobId(html: string): string | null {
  const at = html.indexOf('targeteval:job')
  if (at < 0) return null
  const tagStart = html.lastIndexOf('<', at)
  const tagEnd = html.indexOf('>', at)
  if (tagStart < 0 || tagEnd < 0) return null
  const cm = /content="([^"]*)"/i.exec(html.slice(tagStart, tagEnd))
  if (!cm?.[1]) return null
  // esc() 转义还原（&amp; 必须最后 — 标准反序）
  const raw = cm[1]
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
  try {
    const parsed = JSON.parse(raw) as { jobId?: unknown }
    const id = typeof parsed.jobId === 'string' ? parsed.jobId : ''
    return JOB_ID_RE.test(id) ? id : null
  } catch {
    return null
  }
}

/** v2.98 非缺口口径重算（对齐串几何权威、跨版本不变；identity/positives 百分比
 *  随口径演进 — v2.96/2.97 快照存的是含缺口旧值，与新报告 SSR 口径不一致）。
 *  与 identity-align.ts alignLocal 回溯同计数：全同列 m / 正替代列（中线 '+'）/
 *  缺口列（双侧任一 '-'）；分母 = 非缺口列。 */
function recalibNonGapStats(aln: IdentityAlignment): IdentityAlignment {
  let matches = 0
  let positives = 0
  let gaps = 0
  for (let k = 0; k < aln.qSeq.length; k++) {
    const q = aln.qSeq[k]
    const h = aln.hSeq[k]
    if (q === '-' || h === '-') { gaps++; continue }
    if (q === h) { matches++; positives++ }
    else if (aln.mSeq[k] === '+') positives++
  }
  const nonGap = aln.qSeq.length - gaps
  if (nonGap < 1) return aln
  return {
    ...aln,
    identity: Math.round((matches / nonGap) * 1000) / 10,
    positives: Math.round((positives / nonGap) * 1000) / 10,
    gaps,
    alignLen: aln.qSeq.length,
  }
}

/**
 * 按管线 v2.96 收尾同口径，从数据快照 ctx 计算身份比对（无网络、毫秒级）：
 * 已归属（uniprot 序列在）+ 提交序列 ≥8 aa + 双侧不全同 + 一致性 <99.95%。
 * 规则不满足 / 比对失败（超规模/无种子）→ null（调用方跳过面板）。
 */
export function alignmentFromCtx(ctx: NonNullable<LlmCtxLite['ctx']>): IdentityAlignment | null {
  const qSeq = typeof ctx.sequence === 'string' ? ctx.sequence : ''
  const u = ctx.uniprot
  if (!u?.sequence || !u.uniprotId || qSeq.length < 8) return null
  if (ctx.identityAlignment?.qSeq) {
    // 新快照自带比对 — 对齐串几何权威采信，统计按 v2.98 非缺口口径从串重算
    // （快照若由 v2.96/2.97 生成，其 identity/positives 为含缺口旧口径）
    return recalibNonGapStats(ctx.identityAlignment)
  }
  if (qSeq === u.sequence) return null // 完全一致 — 无需比对佐证（用户规则「非 100% 才展示」）
  const identPct = ctx.targetIdentity?.identity ?? ctx.providedSequence?.comparison?.identity
  if (identPct == null || identPct >= 99.95) return null
  try {
    return alignForIdentityEvidence(qSeq, u.sequence, {
      acc: u.uniprotId,
      entryName: u.entryName,
      blastIdentity: ctx.targetIdentity?.identity,
    })
  } catch {
    return null // best-effort：比对异常不影响报告其余内容
  }
}

/** 读作业数据快照并计算回填比对（文件缺失/损坏 → null，静默降级） */
async function alignmentForJob(jobId: string): Promise<{ aln: IdentityAlignment; ti?: TargetIdentityInfo } | null> {
  if (!JOB_ID_RE.test(jobId)) return null
  let snap: LlmCtxLite
  try {
    snap = JSON.parse(
      await fs.readFile(path.join(process.cwd(), 'db', 'reports', jobId, 'llm-ctx.json'), 'utf-8'),
    ) as LlmCtxLite
  } catch {
    return null // v2.51 前的旧作业无快照 / 文件已回收 — 无法回填
  }
  const aln = snap.ctx ? alignmentFromCtx(snap.ctx) : null
  if (!aln) return null
  return { aln, ti: snap.ctx?.targetIdentity }
}

/** v2.99：旧作业（summary 无 identityAlignment 字段 — v2.96 前评估）的比对回填，
 *  供合并报告重渲染的单独评估页补全「序列比对」面板。新作业直传 summary 值，
 *  本函数仅在缺省时被调用（有值零开销不触发）；快照缺失/规则不满足 → null。 */
export async function alignmentForLegacyJob(jobId: string): Promise<IdentityAlignment | null> {
  const got = await alignmentForJob(jobId)
  return got?.aln ?? null
}

/** 把片段插入 BLAST 章节末尾（该章节的 </section> 前 — 与新报告面板位置一致）。
 *  定位：① id 含 "blast" 的 <section>（单靶点 id="blast" / 合并单独评估页
 *  id="{key}-blast"）；② 兜底 h2「BLAST 同源结构」后的首个 </section>。
 *  找不到 → 返回 ''（调用方放弃注入）。 */
function injectIntoBlastSection(html: string, fragment: string): string {
  const secRe = /<section[^>]*\bid="[^"]*blast[^"]*"[^>]*>/gi
  let insertAt = -1
  let m: RegExpExecArray | null
  while ((m = secRe.exec(html))) {
    const closeIdx = html.indexOf('</section>', m.index + m[0].length)
    if (closeIdx >= 0) { insertAt = closeIdx; break }
  }
  if (insertAt < 0) {
    const h2 = html.indexOf('BLAST 同源结构')
    if (h2 >= 0) {
      const closeIdx = html.indexOf('</section>', h2)
      if (closeIdx >= 0) insertAt = closeIdx
    }
  }
  if (insertAt < 0) return ''
  return `${html.slice(0, insertAt)}${fragment}${html.slice(insertAt)}`
}

/**
 * v2.99 比对面板内容回填（旧报告 → 最新版面板）。
 * 幂等：已含面板 / 无作业标记 / 快照缺失 / 规则不满足 / 文档截断（无
 * </head>/</body>，ht-archive 2MB 前缀读取的截断件）→ 原样返回。
 */
export async function backfillAlignmentPanel(html: string, jobId: string): Promise<string> {
  if (!jobId || html.includes(PANEL_PRESENT)) return html
  const headAt = html.indexOf('</head>')
  const bodyAt = html.lastIndexOf('</body>')
  if (headAt < 0 || bodyAt < 0) return html // 截断文档 — 不注入
  const got = await alignmentForJob(jobId)
  if (!got) return html
  const panel = identityAlignmentPanelHtml(got.aln, got.ti)
  if (!panel) return html // 防御性（alignmentFromCtx 已过滤不可比对序列）
  const withPanel = injectIntoBlastSection(html, `<div>${panel}</div>`)
  if (!withPanel) return html
  // 面板 CSS（旧报告样式表无 .aln-* 规则）+ 悬停脚本（幂等标记检测）
  let out = `${withPanel.slice(0, headAt)}<style id="rpt-aln">${ALIGN_PANEL_CSS}</style>\n${withPanel.slice(headAt)}`
  if (!out.includes(ALIGN_TIP_MARKER)) {
    const b = out.lastIndexOf('</body>')
    if (b >= 0) out = `${out.slice(0, b)}${ALIGN_TIP_JS}\n${out.slice(b)}`
  }
  // 面板就位后注入块宽自适应脚本（applyAlignLayoutUpgrade 幂等判据 aln-fit-v2）
  return applyAlignLayoutUpgrade(out)
}

export interface UpgradeReportResult {
  html: string
  /** 任一升级实际改动（false = 已是最新版，原样返回） */
  changed: boolean
  /** 比对面板是否回填（诊断/日志用） */
  panelBackfilled: boolean
}

/**
 * v2.99 报告全量升级（补丁链 + 面板回填）。opts.jobId 缺省时从报告 meta
 * 解析（jobs 路由已知 id 可直传省一次解析）。任何异常都回退补丁链结果 —
 * 升级是增强，绝不因升级失败丢失报告。
 */
export async function upgradeReportHtml(html: string, opts?: { jobId?: string }): Promise<UpgradeReportResult> {
  const chained = applyReportPatchChain(html)
  let out = chained
  let panelBackfilled = false
  try {
    const jobId = opts?.jobId ?? parseReportJobId(html)
    if (jobId && !out.includes(PANEL_PRESENT)) {
      const backfilled = await backfillAlignmentPanel(out, jobId)
      if (backfilled !== out) {
        out = backfilled
        panelBackfilled = true
      }
    }
  } catch {
    // 回填异常不影响补丁链结果（best-effort 内容增强）
  }
  return { html: out, changed: out !== html, panelBackfilled }
}
