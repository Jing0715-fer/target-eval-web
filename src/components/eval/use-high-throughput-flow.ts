'use client'

/**
 * 高通量评估编排（v2.22 → v2.39 并行化重设计）。
 *
 * 输入契约：「;」分隔组，组内「,」分隔靶点 ——
 *  - 组内多个靶点 = 按现有复合物批量评估链路（关系判断 → 并发评估 → ≥2 成功出合并报告）
 *  - 组内仅一个靶点 = 单作业独立评估
 *  - v2.39：组间并行推进（原严格串行）— 全部组同时开动，共享跨组全局并发窗口
 *    HT_WINDOW（=6，与服务端作业执行池 EVAL_JOB_CONCURRENCY=6 对齐；
 *    每 IP 准入上限 v2.40 起 = 8，留出旧运行遗留作业/断点重挂余量）。
 *    用户核心诉求：「有些 BLAST 结果很久返不回结果，轮询期间可以先进行其他评估」—
 *    慢 BLAST 只占用自己的窗口槽位，不阻塞其他组/靶点推进
 *  - v2.39：启动/恢复时 BLAST 预热（blast-warmup）— 全部待评估序列一次性发服务端
 *    限速预提交 NCBI（先把 BLAST 都提交起来），作业排队期间 NCBI 已在计算
 *
 * 限流自动暂停（用户核心诉求）：
 *  - 检测点覆盖：作业创建 429（系统配额；瞬时「同时最多/排队较多」型先有界退避重试，
 *    重试耗尽才判限流暂停）、作业终态 error 的限流指纹、
 *    作业完成但报告 LLM 全部失败（reportLlmOk !== true，常见于供应商限流/额度耗尽）、
 *    关系判断 / 合并报告生成失败的限流指纹
 *  - 暂停 = 不再提交新作业；已在跑的作业让其在服务器自然跑完（数据不浪费），
 *    结果照常记入组状态。v2.40：退出 HT 视图同理（暂停语义）— 在飞作业继续
 *    收尾并记录，项保持 running；恢复时直接接上，不产生重复提交/僵尸占坑。
 *    服务端 v2.40 同靶点去重（dedup-attach）兜底：同归属对完全相同的评估输入
 *    重复提交时直接接上仍在执行的既有作业（不新建、不占并发配额）
 *  - 配额恢复后由用户「重新开始运行」：从断点续跑 —— 已完成/已终态的靶点不重复评估，
 *    未提交的继续提交，未开始的组继续开
 *
 * 持久化：运行结构（组清单 + 每组作业 id + 报告 id + 断点）落 localStorage（te_ht_runs_v1，
 * 保留最近 5 份运行历史）；页面刷新后标记 interrupted，可从断点恢复或回看。
 * 报告本体（HTML/作业 logs）持久化在服务端 DB（30 天 TTL），回看按需拉取。
 *
 * v2.38 可控运行（用户诉求：手动终止/暂停后可恢复；可选靶点跳过；失败可重跑；
 * 新建时可选择评估范围；zip 导入既有报告直接跳过）：
 *  - 手动暂停 pauseRun：不删服务器作业（跑完照常记结果），恢复从断点继续；
 *  - 手动停止 cancelRun：取消服务器活跃作业，运行标 stopped（非 done）—
 *    「继续运行」把 canceled 项重置为 pending 重新提交；
 *  - 靶点级操作（非 running）：跳过/恢复（skipped 状态 — 不评估但保留在记录里，
 *    可随时恢复评估）、单项重跑、组级重跑失败/跳过未开始、全局重跑失败；
 *  - 启动时选择：HTStartPayload.skipFlags — 未勾选的靶点以 skipped 入运行记录；
 *  - zip 导入 importArchive：解析既有报告包（manifest 精确 / 文件名+题目兜底），
 *    匹配到的未评估靶点标 skipped（报告已在用户手里的 zip 中，不重复评估）。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from '@/hooks/use-toast'
import { downloadHtReportArchive, generateBatchReport, generateHtDashboard, getLlmEngineOverride, isStatelessEnv, judgeTargetRelation, type HtArchiveEntry } from './api'
import { deleteHTRun, getHTRun, listHTRuns, markInterruptedOnLoad, saveHTRun } from './high-throughput-store'
import { backfillBatchReportCache, backfillCacheOnMount, backfillJobCache, cacheBatchReport, cacheJobDetail, getCachedJobDetail } from './job-cache'
import { enrichImportedReports, parseHtImportFiles, matchReportToTarget, planArchiveSkips, sha256Hex16, diagnoseArchiveImport, type HtArchiveReport, type HtMatchTarget, type ImportEnrichItem } from './ht-archive-import'
import type { StartResult } from './use-evaluation-flow'
import { autoDownloadHtmlReport, buildBatchNote, fallbackIndependentJudgment } from './use-evaluation-flow'
import type { EvaluateRequest, HTGroupItemState, HTGroupState, HTRunState, HtSeqTarget, HTStartPayload, JobDetail, RelationJudgment } from './types'

export type HTPhase = 'idle' | 'running' | 'paused' | 'stopped' | 'done'

const POLL_INTERVAL_MS = 2000
/** 连续轮询失败达到该值 → 网络异常提示（继续重试） */
const MAX_CONSECUTIVE_FAILURES = 3
/** v2.39 跨组全局并发窗口（原组内窗口 2 → 全局 6 — 与服务端作业执行池
 *  EVAL_JOB_CONCURRENCY=6 对齐；每 IP 准入上限 v2.40 起 = 8，客户端仍自限 6
 *  保证进度反馈紧凑，服务端余量 2 坑容忍旧运行遗留/断点重挂的作业占坑）：
 *  组间并行推进，全部组的待评估项共享这 6 个槽位 — 慢 BLAST 只占自己的槽，
 *  其余靶点照常推进（用户核心诉求） */
const HT_WINDOW = 6
/** v2.39：作业创建遇到「同时最多/排队较多」型瞬时 429 的有界退避重试
 *  （窗口释放即可提交成功；耗尽才按限流暂停处理）。
 *  v2.40：8 → 40 次（15s 退避 ≈ 最长 10 分钟）— 旧运行遗留的慢 BLAST 作业
 *  短期占坑时，新提交退避等待窗口释放，而不是把整场运行暂停等人工干预 */
const CREATE_JOB_QUOTA_RETRIES = 40
const CREATE_JOB_QUOTA_RETRY_MS = 15_000

/** v2.25 目录段安全化：非法字符折叠为空格并限长 */
function safeDir(s: string, max = 60): string {
  return (s || '')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\s]+$/, '')
    .slice(0, max)
}

/** v2.25 组号段（G01_…：0-based index → 1-based 两位序号） */
function groupFolderLabel(index: number): string {
  return `G${String(index + 1).padStart(2, '0')}`
}

/**
 * 限流 / 配额特征指纹（v2.22）：
 *  - LLM 供应商侧：429 / too many requests / rate limit
 *  - 系统自身配额（gatekeeper QuotaError 文本）：排队评估较多 / 同时最多 / 每日上限 / 近 24 小时内已创建
 */
export function isRateLimitError(text: string | null | undefined): boolean {
  if (!text) return false
  return /\b429\b|too many requests|rate ?limit|rate_limit|限流|频率过高|配额|quota|每日上限|近 24 小时内已创建|同时最多|排队评估较多/i.test(text)
}

/** 组状态 → 图标 + 文案（组状态与靶点状态在视图层组装，此处只给状态） */
function cloneRun(run: HTRunState): HTRunState {
  return JSON.parse(JSON.stringify(run)) as HTRunState
}

/** v2.75：该运行是否有可生成汇总报告的数据源 — 评估完成靶点（jobId）或任何形态的
 *  导入载入靶点（与 finalizeHtDashboard 的 entries/importedBare 收集口径一致：
 *  importedJobId（DB 恢复完整统计行）/ importedReportId·importedStats（解析报告的
 *  完整统计行）/ 纯 imported 标记（bare 降级行 — 主表呈现 + 完成口径））。
 *  此前 regenerateDashboard 守卫只认前三者，纯 bare 载入运行（报告无法解析且
 *  原文留存失败）会误拒「无法生成汇总报告」。 */
function hasDashboardSource(r: HTRunState): boolean {
  return r.groups.some((g) => g.items.some((it) =>
    (it.status === 'done' && it.jobId) ||
    it.importedJobId ||
    it.importedReportId ||
    it.importedStats ||
    it.imported === true ||
    (it.status === 'skipped' && (it.skipNote ?? '').startsWith('已导入')),
  ))
}

/** v2.38：靶点有变动待评估 → 组回可执行态 + 汇总看板作废（下次自然完成重生成） */
function touchGroupForRerun(g: HTGroupState, r: HTRunState): void {
  if (g.status === 'done' || g.status === 'canceled') {
    g.status = 'pending'
    g.finishedAt = undefined
  }
  if (r.dashboardId || r.dashboardError || r.dashboardPending) {
    r.dashboardId = undefined
    r.dashboardError = undefined
    r.dashboardPending = false
    r.dashboardProgress = undefined
    r.dashboardProgressPct = undefined
    r.dashboardPendingSince = undefined
  }
}

/** v2.38：停止/中断恢复前的重置 — canceled 项/组回 pending（清除已死作业引用，
 *  恢复时重新提交）；running+jobId 项保留（接上仍在执行的服务器作业） */
function resetCanceledForResume(r: HTRunState): void {
  for (const g of r.groups) {
    if (g.status === 'canceled') {
      g.status = 'pending'
      g.finishedAt = undefined
    }
    for (const it of g.items) {
      if (it.status === 'canceled') {
        it.status = 'pending'
        it.jobId = undefined
        it.error = undefined
      }
    }
  }
}

/** v2.38：全局重跑失败项（error/canceled → pending）— 返回重置数；组回可执行态 + 看板作废
 *  v2.41：①done 但报告不完整（部分章节失败）的靶点也纳入重跑；
 *  ②修复：重置时同步清 jobId — 旧作业已终态，pending+jobId 既不在 unstarted
 *  也不在 reattach 集合里，重跑会被静默吞掉（历史 bug） */
function resetFailedForRetry(r: HTRunState): number {
  let n = 0
  for (const g of r.groups) {
    for (const it of g.items) {
      if (it.status === 'error' || it.status === 'canceled' || (it.status === 'done' && it.reportIncomplete)) {
        it.status = 'pending'
        it.error = undefined
        it.reportIncomplete = undefined
        it.reportMissingNote = undefined
        it.jobId = undefined // v2.41 修复：清旧作业引用（重置为重新提交）
        n++
      }
    }
    if (g.items.some((it) => it.status === 'pending')) touchGroupForRerun(g, r)
  }
  return n
}

/** v2.41：从终态作业详情推导「LLM 报告未完整生成」的备注（完整时 undefined）。
 *  新作业读 summary.reportLlmMissing；旧版本作业（无该字段）从终态日志快照
 *  推导（管线日志行「LLM 报告章节 X「…」 失败: …」）— 存量运行同样能标可重跑 */
function reportIncompleteNote(job: JobDetail | null | undefined): string | undefined {
  if (!job) return undefined
  const missing = job.summary?.reportLlmMissing ?? 0
  if (missing > 0) return `报告不完整（${missing} 个章节未生成 — 常见于供应商限流或超时，可重跑补齐）`
  const failLine = (job.logs ?? []).find((l) => l.includes('LLM 报告章节') && l.includes('失败'))
  if (failLine) {
    const label = failLine.match(/LLM 报告章节\s*\S+「([^」]+)」/)?.[1]
    return `报告不完整（${label ? `章节「${label}」等未生成` : '部分章节未生成'} — 可重跑补齐）`
  }
  return undefined
}

/** v2.49 applyArchiveSkips 结果：匹配数 + 未命中文件诊断（导入 toast 展示） */
interface ArchiveSkipResult {
  matched: number
  /** 未命中文件的人话原因（逐文件一行，已截断） */
  missLines: string[]
  /** 仅命中已完成/进行中靶点的文件数（报告有效但对应靶点已完成，无需导入） */
  doneOnlyCount: number
  /** v2.69：匹配到的靶点键 → 胜出的报告条目（含无 jobId 的旧版报告与合并报告 —
   *  enrich 步骤据此读源文件解析统计 + 上传原文） */
  matchedByKey: Map<string, HtArchiveReport | undefined>
  /** v2.70：有源文件但原文未能留存/内嵌的靶点数（上传失败或超 32MB 上限 —
   *  统计快照不受影响，仅汇总弹出页无原文可嵌；toast 提示用户） */
  uploadMissed: number
  /** v2.73：导入后仍需评估的靶点数（pending + canceled — 恢复运行时 canceled
   *  会被重置为 pending 重新评估）。0 = 全部靶点已了结（完成/载入/跳过），
   *  点击「继续运行」即刻完成并直接生成汇总报告（toast/按钮文案自适应用） */
  pendingLeft: number
}

/** v2.38→v2.45 导入既有报告匹配 — 用 planArchiveSkips 统一严格规则 + v2.45 组号通道：
 *  单靶点 job 报告：序列靶点 SHA 精确等值 / 标签+长度严格相等且无歧义才标 skipped
 *  （用户反馈：旧包含式匹配把无报告的靶点也误跳了）；合并报告（文件名携带
 *  G{NN} 组号）：总组数对齐 + 组内靶点数一致 → 整组跳过（用户诉求「文件名中
 *  G73 之类的数字应该就能匹配」）。v2.49：未命中文件附带逐文件原因。 */
function applyArchiveSkips(
  r: HTRunState,
  reports: HtArchiveReport[],
  shaByKey: Map<string, string | undefined>,
  fileName: string,
): ArchiveSkipResult {
  const matchable: HtMatchTarget[] = []
  const all: HtMatchTarget[] = []
  for (const g of r.groups) {
    for (const it of g.items) {
      const t: HtMatchTarget = {
        key: it.key,
        acc: it.sequence ? undefined : it.label,
        range: it.range,
        header: it.sequenceHeader,
        label: it.label,
        length: it.sequence?.length,
        seqSha: shaByKey.get(it.key),
        seq: it.sequence,
        groupIndex: g.index,
      }
      all.push(t)
      if (it.status !== 'done' && it.status !== 'running') matchable.push(t)
    }
  }
  const matchedKeys = planArchiveSkips(reports, matchable, { totalGroups: r.groups.length })
  // v2.68→v2.69：逐项定位匹配的报告条目 — jobId（zip 清单 / 报告内嵌标记）随靶点留存，
  //  汇总报告生成时发回服务端恢复完整统计行（DB 保留期内）；v2.69 起同时留存胜出
  //  条目本身（无 jobId 的旧版报告也定位）— enrich 步骤读源文件解析统计快照 +
  //  上传原文，旧版报告也能整合进汇总表格与弹出页
  const jobReports = reports.filter((rep) => rep.kind === 'job')
  const mergedReports = reports.filter((rep) => rep.kind === 'merged' && rep.group != null)
  const targetByKey = new Map(all.map((t) => [t.key, t]))
  const matchedByKey = new Map<string, HtArchiveReport | undefined>()
  for (const it of r.groups.flatMap((g) => g.items)) {
    if (matchedKeys.has(it.key)) {
      it.status = 'skipped'
      it.error = undefined
      it.skipNote = `已导入 ${fileName.slice(0, 40)} 的既有报告`
      it.imported = true // v2.60：进度统计计入已完成（「N 评估 + M 载入」）
      const t = targetByKey.get(it.key)!
      let rep = jobReports.find((r2) => matchReportToTarget(r2, t))
      if (!rep) {
        // 组号通道的合并报告整组跳过 — 按靶点所在组定位合并条目（源文件 = 合并报告）
        const gi = r.groups.findIndex((g) => g.items.some((x) => x.key === it.key))
        rep = gi >= 0 ? mergedReports.find((m) => m.group === gi + 1) : undefined
      }
      it.importedJobId = rep?.jobId
      it.importedFile = rep
        ? (rep.path.split('::')[0] ?? rep.path).split('/').pop()?.slice(0, 80) ?? fileName.slice(0, 80)
        : fileName.slice(0, 80)
      matchedByKey.set(it.key, rep)
    }
  }
  // v2.49 逐文件诊断（含已完成靶点提示 — 避免误报「不在清单」）
  const diag = diagnoseArchiveImport(reports, matchable, { totalGroups: r.groups.length }, all)
  // v2.73：导入后仍需评估的靶点数（pending + canceled；恢复时 canceled 重置为
  //  pending 重新评估）。0 = 点击「继续运行」即刻完成并直接生成汇总报告。
  const pendingLeft = r.groups.flatMap((g) => g.items)
    .filter((it) => it.status === 'pending' || it.status === 'canceled').length
  return {
    matched: matchedKeys.size,
    missLines: diag.filter((d) => !d.matched && !d.doneOnly).map((d) => `${d.file}：${d.reason}`),
    doneOnlyCount: diag.filter((d) => d.doneOnly).length,
    matchedByKey,
    uploadMissed: 0,
    pendingLeft,
  }
}

/**
 * 高通量评估流程状态机：
 * idle（HT Tab 输入）→ running（组矩阵 + 当前组进度面板）
 *   → paused（限流自动暂停 → 用户重新开始）→ running → …
 *   → done（每组报告入口 + 运行日志回看）
 */
export function useHighThroughputFlow() {
  const [phase, setPhase] = useState<HTPhase>('idle')
  const [run, setRun] = useState<HTRunState | null>(null)
  const [recentRuns, setRecentRuns] = useState<HTRunState[]>([])
  /** 当前组活跃作业（喂给 ProgressPanel：阶段时间线 / 日志控制台） */
  const [displayJob, setDisplayJob] = useState<JobDetail | null>(null)
  const [networkIssue, setNetworkIssue] = useState(false)
  const [elapsedSec, setElapsedSec] = useState(0)
  const [canceling, setCanceling] = useState(false)
  const [starting, setStarting] = useState(false)
  /** v2.25 批量下载中（视图禁用入口 + spinner） */
  const [archiving, setArchiving] = useState(false)

  /** 权威运行状态（可变引用；每次关键节点 snapshot() 落 localStorage + 刷视图） */
  const runRef = useRef<HTRunState | null>(null)
  /** v2.36：finalizeHtDashboard 的稳定引用（openRunById 自动续生成用 — 声明先于函数体） */
  const finalizeHtDashboardRef = useRef<(() => Promise<void>) | null>(null)
  /** v2.75：本会话内已自动重试过汇总生成的运行 id（打开失败横幅的运行时自动重试
   *  一次 — 每会话每运行只试一次，失败后靠横幅中的「重新生成」手动重试，避免反复
   *  打开运行时无谓消耗 LLM 配额） */
  const dashboardAutoRetriedRef = useRef<Set<string>>(new Set())
  /** v2.25：一次高通量运行的自动下载统一目录前缀 — 默认下载目录下新建文件夹，
   *  同次运行的全部报告（每靶点独立报告 + 合并报告）都落在同一文件夹内。
   *  命名：TargetEval_HT_日期_Ng（恢复运行/openRunById 时按 run 元数据重建，
   *  页面刷新后自动下载继续落在同一文件夹）。 */
  const runFolderRef = useRef<string>('')
  const pausedRef = useRef(false)
  const cancelRef = useRef(false)
  const activeJobIdsRef = useRef<Set<string>>(new Set())
  const displayJobIdRef = useRef<string | null>(null)
  const tickTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const activeMsRef = useRef(0)
  const lastTickRef = useRef(0)
  /** v2.39 跨组全局并发窗口状态（active = 占用槽位数；waiters = 排队等待者）。
 *  组间并行后由全部组共享 — 慢 BLAST 只占自己的槽位，不阻塞其他组/靶点 */
  const windowRef = useRef<{ active: number; waiters: Array<() => void> }>({ active: 0, waiters: [] })
  /** v2.40 编排链代际（epoch）：startRun / resumeRun 每次启动新链时 +1；
 *  旧链（退出视图后仍在收尾的在飞作业链）在关键推进点检测到代际过时即让位，
 *  防止新旧双链同时推进同一组（重复生成合并报告 / 重复标记完成） */
  const orchestrateEpochRef = useRef(0)
  /** v2.39 关系判断串行链（并行组下多组同时打 LLM 关系判断易触发限流；
 *  判断很快不构成瓶颈 — 单靶点组无判断不受影响） */
  const judgeChainRef = useRef<Promise<unknown>>(Promise.resolve())

  const refreshRecentRuns = useCallback(() => setRecentRuns(listHTRuns()), [])

  const stopTick = useCallback(() => {
    if (tickTimerRef.current !== null) {
      clearInterval(tickTimerRef.current)
      tickTimerRef.current = null
    }
  }, [])

  useEffect(() => stopTick, [stopTick])

  // 挂载：页面刷新/关闭导致编排中断的运行标记 interrupted（服务器侧作业可能仍在执行），
  // 供 HT Tab 展示「恢复上次运行」入口
  useEffect(() => {
    const hit = markInterruptedOnLoad()
    refreshRecentRuns()
    // v2.37：挂载即后台补缓存（6h 节流）— 本地 HT 运行 + 服务端历史列表中
    // 已终态但浏览器尚无副本的作业/合并报告，趁实例存活静默留档；
    // 实例回收后组日志/结果/合并报告仍可离线回看
    void backfillCacheOnMount()
    if (hit) {
      toast({
        title: '检测到未完成的高通量运行',
        description: `上次运行（${hit.groups.length} 组）因页面刷新而中断，可在「高通量」标签页从断点恢复 — 已完成的组不会重复评估。`,
      })
    }
  }, [refreshRecentRuns])

  const startTick = useCallback(() => {
    stopTick()
    lastTickRef.current = Date.now()
    tickTimerRef.current = setInterval(() => {
      const now = Date.now()
      if (!pausedRef.current && !cancelRef.current) {
        activeMsRef.current += now - lastTickRef.current
      }
      lastTickRef.current = now
      setElapsedSec(Math.floor(activeMsRef.current / 1000))
    }, 1000)
  }, [stopTick])

  /** 运行状态 → localStorage + 视图（组状态关键节点调用）。
 *  v2.39：running 中 currentIndex 指向首个未完成组（并行组视图「当前组」面板/高亮） */
  const snapshot = useCallback(() => {
    const r = runRef.current
    if (!r) return
    if (r.status === 'running') {
      const firstActive = r.groups.find((g) => g.status !== 'done' && g.status !== 'canceled')
      if (firstActive) r.currentIndex = firstActive.index
    }
    saveHTRun(r)
    setRun(cloneRun(r))
  }, [])

  // ── v2.39 全局并发窗口槽位（跨组共享）────────────────────────────────

  /** 获取一个窗口槽位：窗口满则排队等待；暂停/取消时（含等待中被唤醒）直接放弃 */
  const acquireWindowSlot = useCallback(async (): Promise<boolean> => {
    const w = windowRef.current
    if (pausedRef.current || cancelRef.current) return false
    if (w.active < HT_WINDOW) {
      w.active++
      return true
    }
    await new Promise<void>((resolve) => {
      w.waiters.push(resolve)
    })
    // 被唤醒：要么槽位已让出（唤醒方保证可用），要么暂停/取消（直接放弃不占槽）
    if (pausedRef.current || cancelRef.current) return false
    w.active++
    return true
  }, [])

  /** 释放窗口槽位：非停状态下按 FIFO 唤醒一个等待者；暂停/取消时唤醒全部（让其退出） */
  const releaseWindowSlot = useCallback(() => {
    const w = windowRef.current
    w.active = Math.max(0, w.active - 1)
    if (pausedRef.current || cancelRef.current) {
      while (w.waiters.length > 0) w.waiters.shift()?.()
    } else if (w.active < HT_WINDOW && w.waiters.length > 0) {
      w.waiters.shift()?.()
    }
  }, [])

  /** 创建一个评估作业（POST /api/evaluate，本地引擎内联携带 — 与单次评估同路径）。
 *  v2.39：遇到「同时最多/排队较多」型瞬时 429（并行窗口释放间隙的竞态）时
 *  有界退避重试（窗口释放即可成功），耗尽才按限流处理交给上层暂停 */
  const createJob = async (request: EvaluateRequest): Promise<{ jobId?: string; error?: string }> => {
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
    for (let attempt = 0; ; attempt++) {
      if (cancelRef.current || pausedRef.current) return { error: '运行已暂停/停止，不再提交新作业' }
      try {
        const llm = getLlmEngineOverride()
        const res = await fetch('/api/evaluate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(llm ? { ...request, llm } : request),
        })
        let data: { ok?: boolean; jobId?: string; error?: string; retryAfter?: number } | null = null
        try {
          data = (await res.json()) as { ok?: boolean; jobId?: string; error?: string; retryAfter?: number }
        } catch {
          data = null
        }
        if (res.ok && data?.jobId) return { jobId: data.jobId }
        // v2.39：瞬时配额 429（并发窗口竞态 / 全局队列瞬时满）— 退避重试而非立即暂停
        if (res.status === 429 && attempt < CREATE_JOB_QUOTA_RETRIES && /同时最多|排队评估较多/.test(data?.error ?? '')) {
          const wait = Math.min(data?.retryAfter ?? CREATE_JOB_QUOTA_RETRY_MS, 30_000)
          await sleep(Math.max(3_000, wait))
          continue
        }
        return { error: data?.error ?? `评估服务暂不可用（HTTP ${res.status}）` }
      } catch (err) {
        return { error: err instanceof Error ? err.message : '创建评估作业失败，请稍后重试' }
      }
    }
  }

  /**
   * 轮询作业至终态（高通量专用）：返回终态 + 最后一次快照（用于限流判定：
   * error 文本指纹 / done 但 reportLlmOk 缺失）。暂停语义下继续轮询到终态
   * （已在跑的作业让它跑完，结果记入组状态）。
   */
  const waitForJobTerminal = (id: string): Promise<{ status: 'done' | 'error' | 'canceled'; job: JobDetail | null }> => {
    return new Promise((resolve) => {
      let settled = false
      let fails = 0
      let last: JobDetail | null = null
      const finish = (s: 'done' | 'error' | 'canceled') => {
        if (settled) return
        settled = true
        clearInterval(timer)
        activeJobIdsRef.current.delete(id)
        resolve({ status: s, job: last })
      }
      const timer = setInterval(async () => {
        if (cancelRef.current) {
          finish('canceled')
          return
        }
        try {
          const res = await fetch(`/api/jobs/${id}`, { cache: 'no-store' })
          // 作业从服务端消失（外部取消/删除/TTL/Serverless 实例回收）：
          // v2.36 — 本地缓存有终态副本则按真实终态收尾，否则按 canceled（不无限重试）
          if (res.status === 404 || res.status === 410) {
            const cached = getCachedJobDetail(id)
            if (cached && (cached.status === 'done' || cached.status === 'error')) {
              last = cached
              if (cached.id === displayJobIdRef.current) setDisplayJob(cached)
              finish(cached.status)
            } else {
              finish('canceled')
            }
            return
          }
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const data = (await res.json()) as JobDetail
          last = data
          fails = 0
          setNetworkIssue(false)
          if (data.id === displayJobIdRef.current) setDisplayJob(data)
          // v2.36：终态瞬间存入浏览器本地缓存（Serverless 实例回收后回看的唯一兜底）
          if (data.status === 'done' || data.status === 'error') cacheJobDetail(data)
          if (data.status === 'done') finish('done')
          else if (data.status === 'error') finish('error')
          else if (data.status === 'canceled') finish('canceled')
        } catch {
          fails += 1
          if (fails >= MAX_CONSECUTIVE_FAILURES) setNetworkIssue(true)
          // 网络抖动继续轮询（作业在服务器侧继续执行）
        }
      }, POLL_INTERVAL_MS)
    })
  }

  /** 自动暂停：记原因 + 断点持久化 + 视图切换（后台仍在跑的作业照常收尾） */
  const pauseWithReason = useCallback((reason: string) => {
    if (pausedRef.current) return
    pausedRef.current = true
    const r = runRef.current
    if (r) {
      r.status = 'paused'
      r.pausedReason = reason
      r.pausedAt = Date.now()
      saveHTRun(r)
      setRun(cloneRun(r))
    }
    setPhase('paused')
    stopTick()
    toast({
      title: '高通量评估已自动暂停',
      description: `${reason} 配额恢复后可点击「重新开始运行」从断点继续（已完成的组不会重复评估）。`,
      variant: 'destructive',
    })
  }, [stopTick])

  /** 单个靶点作业终态收尾：状态 + 限流判定 + 独立报告自动落盘（非关联批次） */
  const finishItem = useCallback(
    (item: HTGroupItemState, label: string, related: boolean, groupNo: number, r: { status: 'done' | 'error' | 'canceled'; job: JobDetail | null }) => {
      if (r.status === 'done') {
        // 报告 LLM 全部失败（reportLlmOk 缺失 = 无任何章节成功）— 供应商限流/额度耗尽的典型表现
        if (r.job?.summary && r.job.summary.reportLlmOk !== true) {
          item.status = 'error'
          item.error = '数据收集完成，但报告生成 LLM 全部失败（常见于供应商限流或额度耗尽）'
          item.reportIncomplete = undefined
          item.reportMissingNote = undefined
          pauseWithReason(`第 ${groupNo} 组靶点 ${label} 报告生成失败（LLM 全章节未产出，常见于供应商限流或额度耗尽）。`)
        } else {
          item.status = 'done'
          // v2.41：部分章节失败的「报告不完整」标记（不阻塞流程，但可一键重跑补齐）
          const note = reportIncompleteNote(r.job)
          item.reportIncomplete = note ? true : undefined
          item.reportMissingNote = note
          // 非关联批次 — 各靶点独立报告，完成即自动下载（关联批次 deferred 无独立 HTML）
          // v2.25：目录前缀 = 运行文件夹 + 组号段（G01_…），同次运行集中在一个新文件夹
          if (!related && item.jobId) {
            autoDownloadHtmlReport(
              `/api/jobs/${item.jobId}/report?download=1`,
              `job:${item.jobId}`,
              label,
              `${runFolderRef.current}/${groupFolderLabel(groupNo - 1)}`,
            )
          }
        }
      } else if (r.status === 'error') {
        item.status = 'error'
        item.error = r.job?.error ?? '评估失败（详见该作业日志）'
        item.reportIncomplete = undefined
        item.reportMissingNote = undefined
        if (isRateLimitError(r.job?.error)) {
          pauseWithReason(`靶点 ${label} 作业执行失败（限流/配额）：${(r.job?.error ?? '').slice(0, 120)}`)
        }
      } else {
        item.status = 'canceled'
        item.reportIncomplete = undefined
        item.reportMissingNote = undefined
      }
    },
    [pauseWithReason],
  )

  /**
   * 执行一组（可重入 — 恢复运行时从组内 items 状态续）：
   *  judging（多靶点）→ 全局窗口 evaluating → merging（≥2 成功）→ done
   * 暂停/取消：正在跑的作业收尾后组标 paused/canceled，循环不再推进。
   * v2.38：skipped 靶点不参与评估（关系判断/并发窗口只看非 skipped 项；
   * 全部跳过的组直接标 done）。
   * v2.39：组间并行 — 本组的待评估项通过全局窗口（windowRef）跨组共享
   * HT_WINDOW 个槽位，慢 BLAST 只占自己的槽，不阻塞其他组/靶点。
   */
  const runGroup = async (g: HTGroupState, epoch: number): Promise<void> => {
    const runState = runRef.current
    if (!runState) return
    // v2.38：skipped = 已处理（用户选择不评估 / zip 导入既有报告）— 全部跳过的组直接完成
    const activeItems = g.items.filter((it) => it.status !== 'skipped')
    const activeUniprotTargets = activeItems.filter((it) => !it.sequence).map((it) => it.label)
    const single = g.targets.length === 0 ? activeItems.length <= 1 : activeUniprotTargets.length <= 1
    g.startedAt = g.startedAt ?? Date.now()
    if (activeItems.length === 0) {
      g.status = 'done'
      g.finishedAt = Date.now()
      snapshot()
      return
    }

    // ── ① 关系判断（多靶点组；重入时已有 relation 则跳过；v2.38 只判非 skipped 靶点）──
    // v2.39：跨组串行链（并行组下多组同时打 LLM 关系判断易触发限流；判断很快
    // 不构成瓶颈 — 单靶点组无判断不受影响）
    if (!single && !g.relation) {
      g.status = 'judging'
      snapshot()
      const judge = async (): Promise<RelationJudgment> => {
        const rel = await judgeTargetRelation({ uniprots: activeUniprotTargets, goal: runState.goal })
        return rel.judgment
      }
      const chained = judgeChainRef.current.then(judge, judge)
      judgeChainRef.current = chained.catch(() => undefined)
      try {
        g.relation = await chained
      } catch (e) {
        const msg = e instanceof Error ? e.message : '关系判断服务暂不可用'
        if (isRateLimitError(msg)) {
          g.status = 'paused'
          pauseWithReason(`第 ${g.index + 1} 组关系判断遇到限流：${msg.slice(0, 120)}`)
          return
        }
        g.relationError = msg
        g.relation = fallbackIndependentJudgment()
      }
      if (pausedRef.current || cancelRef.current) {
        g.status = pausedRef.current ? 'paused' : 'canceled'
        snapshot()
        return
      }
      snapshot()
    }
    if (!single && !g.relation) g.relation = fallbackIndependentJudgment()
    const related = g.relation?.related === true
    const batchNote = !related && g.relation ? buildBatchNote(g.relation, activeUniprotTargets.length) : undefined
    // v1.11 ≥90% 高一致组委托：组内首个提交 BLAST 的作业为家族代表，其余共享结果
    const blastGroups = g.relation?.blastGroups ?? []

    // v2.40：旧链让位 — 恢复/重开已启动新编排链时，本组推进权交给新链
    // （在飞作业的结果记录不受影响，由 launchOne/finishItem 独立完成）
    if (epoch !== orchestrateEpochRef.current) return

    // ── ② 全局并发窗口（v2.39：跨组共享 HT_WINDOW 个槽位；重入：已终态跳过；
    //    running+jobId 接上等待；未提交的重新提交。窗口满则排队等槽位释放，
    //    暂停/取消时等待者被唤醒直接放弃，不再提交新作业）──
    g.status = 'evaluating'
    snapshot()

    const items = g.items
    const unstarted = items.filter((it) => it.status === 'pending' && !it.jobId)
    const reattach = items.filter((it) => it.jobId && it.status === 'running')

    const launchOne = async (item: HTGroupItemState) => {
      const label = item.label
      // v2.23.1 序列兜底靶点：mode=sequence 提交（命名证据随构基标签头携带；
      // 结构预测无 AFDB 收录时自动走 ESMFold 公共预测兜底）；UniProt 靶点走既有链路
      const group = item.sequence ? undefined : blastGroups.find((grp) => grp.members.includes(label))
      const req: EvaluateRequest = item.sequence
        ? {
            mode: 'sequence',
            sequence: item.sequence,
            sequenceHeader: item.sequenceHeader,
            goal: runState.goal,
            ligands: runState.ligands,
            // v2.27/v2.29：行内构建区间与域名提示（手动值优先于比对推导；域名匹 UniProt domain 推导）；
            // v2.72：同行抗体链（抗原-抗体复合物交付 — Cryo-EM 评分计入复合物分子量）
            options: { ...runState.options, reportMode: 'single', range: item.range, rangeHint: item.domainHint, ...(item.antibodyPartner ? { antibodyPartner: item.antibodyPartner } : {}) },
          }
        : {
            mode: 'uniprot',
            uniprot: label,
            goal: runState.goal,
            ligands: runState.ligands,
            batchNote,
            homologBlast: group,
            // v2.27/v2.29：截短构建感知与域名提示 — options.range / rangeHint
            options: { ...runState.options, reportMode: related ? 'deferred' : 'single', range: item.range, rangeHint: item.domainHint },
          }
      const created = await createJob(req)
      if (cancelRef.current || pausedRef.current) {
        // v2.40 提交-暂停/停止竞态收尾：刚创建成功的服务器作业不能被丢弃成
        // 无人轮询的僵尸（占并发坑位 + 结果浪费）：
        //  - 停止（cancel）：主动撤销服务器作业（cancelRun 的 DELETE 批次可能已错过它）；
        //  - 暂停（paused）：记录 jobId 并照常轮询到终态（暂停语义 — 结果记入组
        //    状态；恢复运行时该项已是 running+jobId，直接接上不重复提交）
        if (created.jobId && cancelRef.current) {
          // v2.42：取消模式（保留日志与结果 — 停止与完成竞态时不误删已产出报告）
          void fetch(`/api/jobs/${created.jobId}?mode=cancel`, { method: 'DELETE' }).catch(() => undefined)
          item.status = 'canceled'
        } else if (created.jobId && pausedRef.current) {
          item.jobId = created.jobId
          item.status = 'running'
          activeJobIdsRef.current.add(created.jobId)
          snapshot()
          const r = await waitForJobTerminal(created.jobId)
          finishItem(item, label, related, g.index + 1, r)
          snapshot()
          return
        } else {
          item.status = 'canceled'
        }
        snapshot()
        return
      }
      if (!created.jobId) {
        item.status = 'error'
        item.error = created.error
        if (isRateLimitError(created.error)) {
          pauseWithReason(`提交靶点 ${label} 的评估作业被限流：${(created.error ?? '').slice(0, 120)}`)
        }
        snapshot()
        return
      }
      item.jobId = created.jobId
      item.status = 'running'
      activeJobIdsRef.current.add(created.jobId)
      displayJobIdRef.current = created.jobId // 进度面板跟随最新创建的作业
      snapshot() // v2.40：提交成功即时持久化 — 刷新窗口内 jobId 不丢失（恢复时直接接上而非重复提交）
      const r = await waitForJobTerminal(created.jobId)
      finishItem(item, label, related, g.index + 1, r)
      snapshot()
    }

    const reattachOne = async (item: HTGroupItemState) => {
      const id = item.jobId as string
      activeJobIdsRef.current.add(id)
      displayJobIdRef.current = id
      const r = await waitForJobTerminal(id)
      finishItem(item, item.label, related, g.index + 1, r)
      snapshot()
    }

    // v2.39：占全局窗口槽位执行（满则排队；暂停/取消时放弃不提交）
    const runWithSlot = async (fn: () => Promise<void>): Promise<void> => {
      if (!(await acquireWindowSlot())) return
      try {
        await fn()
      } finally {
        releaseWindowSlot()
      }
    }

    const activePromises: Array<Promise<void>> = []
    // 恢复场景：接上服务器侧仍在执行的作业（全局窗口统一限流，不设组内截断）
    for (const item of reattach) {
      activePromises.push(runWithSlot(() => reattachOne(item)))
    }
    // 待提交项全部入队 — 实际提交节奏由全局窗口控制（≤ HT_WINDOW 个在飞）
    for (const item of unstarted) {
      activePromises.push(runWithSlot(() => launchOne(item)))
    }

    // 等待本组全部项收尾（暂停时已在跑的作业照常收尾；等待槽位的项被唤醒后放弃）
    if (activePromises.length > 0) await Promise.all(activePromises)

    // v2.40：旧链让位 — 新链已接管本组（避免双链重复推进合并报告/完成标记）
    if (epoch !== orchestrateEpochRef.current) return

    // 窗口收尾（暂停时后台作业可能仍在跑 — orchestrate 已退出循环，这里的 promise 由自身驱动收尾）
    if (pausedRef.current) {
      g.status = 'paused'
      snapshot()
      return
    }
    if (cancelRef.current) {
      g.status = 'canceled'
      g.finishedAt = Date.now()
      snapshot()
      return
    }

    const okItems = items.filter((it) => it.status === 'done' && it.jobId)
    // 关联但仅 1 个成功：合并报告需 ≥2 — 显式说明（同现有批量行为）
    if (!single && related && okItems.length === 1) {
      const failed = items.filter((it) => it.status === 'error').length
      g.mergedError = `本组判定为关联复合物，但仅 1 个靶点评估成功${failed ? `（${failed} 个失败/中断）` : ''}；合并报告需要至少 2 个成功靶点，可稍后在普通模式单独重试失败靶点。`
    }

    // ── ③ 合并报告（组内 ≥2 成功；重入时已生成过则跳过）──────────────
    if (!single && okItems.length >= 2 && !g.mergedReportId && !g.mergedError) {
      g.status = 'merging'
      snapshot()
      try {
        const merged = await generateBatchReport({
          jobIds: okItems.map((it) => it.jobId as string),
          relation: (g.relation ?? fallbackIndependentJudgment()) as RelationJudgment,
          goal: runState.goal,
        })
        g.mergedReportId = merged.id
        // v2.37：合并报告生成完成（markdown 完整）→ 立即留入浏览器本地缓存
        // （实例回收后「打开合并报告」仍可从本地副本回看）
        cacheBatchReport(merged)
        autoDownloadHtmlReport(
          `/api/evaluate/batch-report?id=${encodeURIComponent(merged.id)}&download=1`,
          `batch:${merged.id}`,
          `第 ${g.index + 1} 组合并评估报告`,
          `${runFolderRef.current}/${groupFolderLabel(g.index)}`,
        )
      } catch (e) {
        const msg = e instanceof Error ? e.message : '合并报告生成失败'
        if (isRateLimitError(msg)) {
          g.status = 'paused'
          pauseWithReason(`第 ${g.index + 1} 组合并报告生成被限流：${msg.slice(0, 120)}`)
          return
        }
        g.mergedError = msg
      }
      if (pausedRef.current || cancelRef.current) {
        g.status = pausedRef.current ? 'paused' : 'canceled'
        g.finishedAt = g.finishedAt ?? (cancelRef.current ? Date.now() : undefined)
        snapshot()
        return
      }
      snapshot()
    }

    g.status = 'done'
    g.finishedAt = Date.now()
    snapshot()
  }

  /**
   * v2.39 组编排：全部未完成组并行推进（共享全局 HT_WINDOW 槽位）—
   * 慢 BLAST 只占自己的窗口槽位，其余组/靶点照常推进（用户核心诉求）。
   * 暂停/取消：已在跑的作业照常收尾后各组标 paused/canceled；done/canceled 组跳过（恢复语义）。
   */
  const orchestrate = async (): Promise<void> => {
    const runState = runRef.current
    if (!runState) return
    // v2.40：启动新编排链（代际 +1）— 旧链在关键推进点检测到过时即让位
    const epoch = ++orchestrateEpochRef.current
    const runnable = runState.groups.filter((g) => g.status !== 'done' && g.status !== 'canceled')
    if (runnable.length > 0) {
      snapshot()
      await Promise.all(runnable.map((g) => runGroup(g, epoch)))
    }
    // v2.40：旧链让位 — 新链已接管运行（避免双链重复收尾/生成看板）
    if (epoch !== orchestrateEpochRef.current) return
    if (pausedRef.current) return // runGroup/pauseWithReason 已置状态；后台作业继续收尾
    // v2.38 手动停止：未开始的组标 canceled，运行标 stopped（可恢复 — 继续运行时
    // canceled 项/组重置为 pending 重新提交）；不生成汇总看板（那是自然完成的收尾）
    if (cancelRef.current) {
      for (const g of runState.groups) {
        if (g.status === 'pending' || g.status === 'judging' || g.status === 'evaluating' || g.status === 'merging') {
          g.status = 'canceled'
        }
      }
      runState.status = 'stopped'
      setPhase('stopped')
      stopTick()
      snapshot()
      const doneTargets = runState.groups.flatMap((g) => g.items).filter((it) => it.status === 'done').length
      const importedTargets = runState.groups.flatMap((g) => g.items).filter((it) => it.imported === true || (it.status === 'skipped' && (it.skipNote ?? '').startsWith('已导入'))).length
      const skippedTargets = runState.groups.flatMap((g) => g.items).filter((it) => it.status === 'skipped' && it.imported !== true && !(it.skipNote ?? '').startsWith('已导入')).length
      toast({
        title: '高通量评估已停止',
        description: `已完成的 ${doneTargets + importedTargets} 个靶点结果保留${importedTargets > 0 ? `（${doneTargets} 个评估完成 + ${importedTargets} 个载入既有报告）` : ''}${skippedTargets > 0 ? `；另手动跳过 ${skippedTargets} 个` : ''}；可「继续运行」从断点恢复，或在组卡片中跳过/重跑指定靶点后再继续。`,
      })
      return
    }
    runState.status = 'done'
    runState.finishedAt = Date.now()
    setPhase('done')
    stopTick()
    snapshot()
    // ── v2.28 运行完成 → 统计看板（评分统计 + AI 整体可行性报告 + 每靶点一句话
    //    结论；离线 HTML 自动下载；生成后存入运行状态供回看与 zip 归档）──
    void finalizeHtDashboard()
    const doneGroups = runState.groups.filter((g) => g.status === 'done').length
    const reports = runState.groups.filter((g) => g.mergedReportId || g.items.some((it) => it.status === 'done')).length
    const skippedTargets = runState.groups.flatMap((g) => g.items).filter((it) => it.status === 'skipped' && it.imported !== true && !(it.skipNote ?? '').startsWith('已导入')).length
    const importedTargets = runState.groups.flatMap((g) => g.items).filter((it) => it.imported === true || (it.status === 'skipped' && (it.skipNote ?? '').startsWith('已导入'))).length
    // v2.42：完成提示诚实化 — 如实报告未成功靶点数（作业被取消/失败不再被「完成」掩盖）
    const failedTargets = runState.groups.flatMap((g) => g.items).filter((it) => it.status === 'error' || it.status === 'canceled').length
    const incompleteTargets = runState.groups.flatMap((g) => g.items).filter((it) => it.status === 'done' && it.reportIncomplete).length
    const unfinished = failedTargets + incompleteTargets
    toast({
      title: unfinished > 0 ? `高通量评估完成（${unfinished} 个靶点未成功）` : '高通量评估完成',
      description: `${runState.groups.length} 组中 ${doneGroups} 组完成，${reports} 组产出了可查看的报告${importedTargets > 0 ? `（另载入 ${importedTargets} 个靶点的既有报告，未重复评估）` : ''}${skippedTargets > 0 ? `（手动跳过 ${skippedTargets} 个靶点）` : ''}${unfinished > 0 ? `；${failedTargets > 0 ? `${failedTargets} 个失败/被取消` : ''}${failedTargets > 0 && incompleteTargets > 0 ? '、' : ''}${incompleteTargets > 0 ? `${incompleteTargets} 个报告不完整` : ''}，可「重跑失败/不完整项」补齐` : ''}；汇总报告（统计看板 + 全靶点总表 + AI 整体可行性报告，单文件）正在生成，完成后自动下载。运行日志可在每组卡片中回看。`,
    })
  }

  /**
   * v2.28：运行完成后生成统计看板 — entries 与 zip 归档同构（服务端据此计算离线
   * 链接命名）；≥1 个成功靶点才生成。幂等：已有 dashboardId 的运行不重复生成
   * （恢复/重开场景）。失败不阻塞（运行已完成）；限流/超时记入 dashboardError，
   * 可从「批量下载全部」入口重试。v2.36：dashboardPending 标记生成中状态（完成
   * 横幅的「生成中」态 — 用户此前在生成期间看不到任何看板提示）。
   */
  const finalizeHtDashboard = async (): Promise<void> => {
    const runState = runRef.current
    if (!runState || runState.dashboardId || runState.dashboardError === '__done__') return
    const entries: HtArchiveEntry[] = []
    // v2.68→v2.69：导入既有报告的靶点纳入汇总（修复「汇总报告信息不全」）—
    //  有 importedJobId（zip 清单 / 报告内嵌标记）的靶点同时走两条通道：
    //  ① entries + importedJobIds → DB 仍在保留期内时恢复完整统计行（评分/结构/结论，
    //     与本次评估同权，行标「载入」）；
    //  ② imported 载荷（全部导入靶点）— v2.69 起 stats（导入报告解析的统计快照）
    //     存在时直接构建完整统计行（不依赖 DB 保留期，旧版报告也能整合进表格）；
    //     reportId（原文服务端留存 id）供弹出页内嵌报告原文；两者都缺时降级行兜底。
    //     DB 命中时服务端按 label 去重（以 DB 恢复行为准 — 数据更全）
    const importedBare: Array<{ label: string; group?: number; sequence?: string; fileName?: string; reportId?: string; range?: [number, number]; stats?: HTGroupItemState['importedStats'] }> = []
    const importedJobIds = new Set<string>()
    for (const g of runState.groups) {
      for (const it of g.items) {
        if (it.status === 'done' && it.jobId) {
          entries.push({ jobId: it.jobId, group: g.index + 1, label: it.label })
        } else if (it.imported === true || (it.status === 'skipped' && (it.skipNote ?? '').startsWith('已导入'))) {
          importedBare.push({
            label: it.label,
            group: g.index + 1,
            sequence: it.sequence?.slice(0, 50_000),
            fileName: it.importedFile,
            reportId: it.importedReportId,
            range: it.range,
            stats: it.importedStats,
          })
          if (it.importedJobId) {
            entries.push({ jobId: it.importedJobId, group: g.index + 1, label: it.label })
            importedJobIds.add(it.importedJobId)
          }
        }
      }
      if (g.mergedReportId) entries.push({ mergedId: g.mergedReportId, group: g.index + 1 })
    }
    if (!entries.some((e) => e.jobId) && importedBare.length === 0) {
      runState.dashboardError = '__done__'
      saveHTRun(runState)
      setRun(cloneRun(runState))
      // v2.42：明确提示（此前静默写入哨兵值，横幅只显示「__done__」原始文本）
      toast({
        title: '未生成汇总报告',
        description: '本次运行没有成功完成的靶点（全部失败/被取消/被跳过），无可统计的评估结果。可「重跑失败/不完整项」补齐后自动重新生成。',
        variant: 'destructive',
      })
      return
    }
    // v2.36：生成中标记（横幅立即可见，终态后接替）；v2.78：起始时间戳（横幅「已等待 Ns」计时）
    runState.dashboardPending = true
    runState.dashboardPendingSince = Date.now()
    saveHTRun(runState)
    setRun(cloneRun(runState))
    try {
      // v2.61：各序列靶点的提交序列（jobId → 全文 — 汇总表「复制序列」按钮与全靶点
      // 完整报告页展示；≤600 条、总量 600K 字符防载荷膨胀 — 超出部分静默丢弃）。
      // v2.68：导入载入的序列靶点（importedJobId）同样回填 — 汇总弹出页/复制按钮可用
      const sequences: Array<{ jobId: string; sequence: string }> = []
      let seqChars = 0
      for (const g of runState.groups) {
        for (const it of g.items) {
          const sid = it.status === 'done' && it.jobId ? it.jobId : it.importedJobId
          if (!sid || !it.sequence) continue
          if (sequences.length >= 600 || seqChars + it.sequence.length > 600_000) continue
          sequences.push({ jobId: sid, sequence: it.sequence })
          seqChars += it.sequence.length
        }
      }
      const dash = await generateHtDashboard({
        entries,
        goal: runState.goal,
        excelRows: runState.excelRows,
        sequences,
        imported: importedBare.length ? importedBare : undefined,
        importedJobIds: importedJobIds.size ? [...importedJobIds] : undefined,
        // v2.71：running 期间轮询回传阶段进度（生成中横幅实时展示 — 不落盘，
        //  仅文本变化时刷新视图避免重渲染抖动）；v2.76：附带全局百分比 pct
        //  （进度条 — 百分比前移同样触发刷新，条平滑推进）
        onProgress: (msg, pct) => {
          if (runState.dashboardProgress === msg && runState.dashboardProgressPct === pct) return
          runState.dashboardProgress = msg
          runState.dashboardProgressPct = pct
          setRun(cloneRun(runState))
        },
      })
      runState.dashboardPending = false
      runState.dashboardProgress = undefined
      runState.dashboardProgressPct = undefined
      runState.dashboardPendingSince = undefined
      if (dash.status === 'done') {
        runState.dashboardId = dash.id
        runState.dashboardError = undefined
        // 离线 HTML 自动下载（与其他报告同机制 — 服务器端数据不长期保留）
        autoDownloadHtmlReport(
          `/api/evaluate/ht-dashboard?id=${encodeURIComponent(dash.id)}&download=1`,
          `htdash:${dash.id}`,
          '高通量统计看板（评分统计 + AI 整体可行性报告）',
          runFolderRef.current,
        )
        // v2.60：数据恢复 / 部分跳过提示（服务端作业过期时由浏览器缓存快照重建）
        const recoverTail = (dash.recoveredCount ?? 0) > 0
          ? `已从浏览器本地缓存恢复 ${dash.recoveredCount} 个靶点的统计数据（服务端数据已过期 — 看板内标「缓存恢复」）；`
          : ''
        const dropTail = (dash.droppedCount ?? 0) > 0
          ? `${dash.droppedCount} 个靶点因服务端与本地缓存均无数据被跳过${dash.droppedLabels?.length ? `（如 ${dash.droppedLabels.slice(0, 3).join('、')}）` : ''}；`
          : ''
        // v2.69：导入靶点统计整合情况（toast 提示 — 与服务端实际行构建结果对齐）
        const parsedImportedCount = importedBare.filter((t) => t.stats).length
        const importedTail = importedBare.length + importedJobIds.size > 0
          ? `已包含 ${importedJobIds.size + importedBare.length} 个导入载入的靶点（${importedJobIds.size} 个恢复了完整统计${parsedImportedCount ? `、${parsedImportedCount} 个已解析导入报告的评分与结论` : ''}${importedBare.length - parsedImportedCount > 0 ? `、${importedBare.length - parsedImportedCount} 个以载入行呈现（报告无法解析）` : ''}）；`
          : ''
        toast({
          title: '统计看板已生成',
          description: `${recoverTail}${dropTail}${importedTail}评分统计 + AI 整体可行性报告已自动下载；每靶点含一句话结论（能否做）与单独报告链接，「批量下载全部」zip 解压后离线链接可直接点开。`,
        })
      } else {
        runState.dashboardError = dash.error ?? '统计看板生成失败'
        toast({
          title: '统计看板生成失败',
          description: `${runState.dashboardError}（运行结果不受影响；可在历史运行中重试）`,
          variant: 'destructive',
        })
      }
    } catch (e) {
      runState.dashboardPending = false
      runState.dashboardProgress = undefined
      runState.dashboardProgressPct = undefined
      runState.dashboardPendingSince = undefined
      runState.dashboardError = e instanceof Error ? e.message : '统计看板生成失败'
      toast({
        title: '统计看板生成失败',
        description: `${runState.dashboardError}（运行结果不受影响）`,
          variant: 'destructive',
      })
    }
    saveHTRun(runState)
    setRun(cloneRun(runState))
  }
  // ref 赋值须在 effect 内（render 期访问 ref 违反 React 规则；每次渲染后刷新引用）
  useEffect(() => {
    finalizeHtDashboardRef.current = finalizeHtDashboard
  })

  /**
   * v2.39 BLAST 预热（用户诉求「先把 BLAST 都提交起来，加快进度」）：
   * 启动/恢复运行时把全部待评估靶点（序列 / UniProt ID）一次性发服务端 —
   * 服务端按全局节拍（~15s/发）限速预提交 NCBI，作业还在排队时 NCBI 已在计算；
   * 管线 blast-submit 阶段按序列哈希命中预提交 RID 直接收集。
   * fire-and-forget：失败静默（管线回退常规提交，预热永不阻塞主流程）。
   */
  const warmupBlast = useCallback((r: HTRunState): void => {
    if (r.options?.skipBlast) return
    const uniprots = [...new Set(
      r.groups.flatMap((g) => g.items.filter((it) => !it.sequence && it.status === 'pending' && !it.jobId).map((it) => it.label)),
    )]
    const sequences = [...new Set(
      r.groups.flatMap((g) => g.items.filter((it) => it.sequence && it.status === 'pending' && !it.jobId).map((it) => it.sequence as string)),
    )]
    if (uniprots.length + sequences.length === 0) return
    void (async () => {
      try {
        const res = await fetch('/api/evaluate/blast-warmup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sequences, uniprots, forceBlast: r.options?.forceBlast === true }),
        })
        if (!res.ok) return
        const data = (await res.json()) as { ok?: boolean; submitted?: number }
        if (data.ok && data.submitted && data.submitted > 0) {
          toast({
            title: 'BLAST 预热已启动',
            description: `${data.submitted} 条序列已进入限速预提交队列（~15s/发）— 作业排队期间 NCBI 已在计算，开始评估时自动命中结果。`,
          })
        }
      } catch {
        /* 预热失败静默 — 管线会常规提交 */
      }
    })()
  }, [])

  /** 启动一次高通量运行（HT Tab → 开始高通量评估） */
  const startRun = async (payload: HTStartPayload): Promise<StartResult> => {
    if (isStatelessEnv()) {
      const msg = '无状态部署暂不支持高通量评估（作业队列不可用），请使用单次 / 批量评估'
      toast({ title: '无法开始高通量评估', description: msg, variant: 'destructive' })
      return { ok: false, error: msg }
    }
    const groups = (payload.groups ?? []).filter((g) => Array.isArray(g) && g.length > 0)
    // v2.23.1 序列兜底组（Excel 导入：行缺 UniProt 但有构建序列 — 每行一组，逐序列独立评估）
    const seqGroups = (payload.seqGroups ?? []).filter((g) => Array.isArray(g) && g.length > 0)
    if (groups.length === 0 && seqGroups.length === 0) {
      const msg = '未解析到有效分组（请用分号分隔组、组内逗号分隔靶点，或从 Excel 导入）'
      toast({ title: '无法开始高通量评估', description: msg, variant: 'destructive' })
      return { ok: false, error: msg }
    }
    setStarting(true)
    try {
      const now = Date.now()
      const groupStates: HTGroupState[] = [
        ...groups.map((targets, i) => ({
          index: i,
          targets,
          items: targets.map((t, j) => ({
            key: `${i}-${j}-${t}`,
            label: t,
            // v2.27：逐靶点评估区间（Excel 构建区间 / 手输「:起-止」后缀）— 提交时随 options.range
            range: payload.groupRanges?.[i]?.[j],
            // v2.29：结构域名提示（Excel 域名 / 手输「:域名」后缀）— 提交时随 options.rangeHint
            domainHint: payload.groupDomainHints?.[i]?.[j],
            // v2.38：启动时未勾选的靶点直接跳过（保留在记录里 — 可随时恢复评估）
            status: (payload.skipFlags?.groups?.[i]?.[j] ? 'skipped' : 'pending') as 'skipped' | 'pending',
            // v2.66：因「导入既有报告」而取消勾选 → imported 标记（进度统计计入「载入」
            //  完成口径 — 修复：启动面板导入后组数涨而靶点完成数恒 0）
            ...(payload.importedFlags?.groups?.[i]?.[j]
              ? { imported: true as const, skipNote: '已导入既有报告（启动前导入匹配 — 跳过评估，计入「载入」）' }
              : {}),
          })),
          status: 'pending' as const,
        })),
        ...seqGroups.map((seqs, k) => ({
          index: groups.length + k,
          targets: [] as string[],
          seqTargets: seqs,
          items: seqs.map((s: HtSeqTarget, j: number) => ({
            key: `sq-${k}-${j}-${s.length}`,
            // v2.34：结构交付行标签「文件名·链N」— 长 header 截头保尾（链序号在尾部，全截会失去区分度）
            label: s.header
              ? `${s.header.length > 30 ? `${s.header.slice(0, 22)}…${s.header.slice(-7)}` : s.header} · ${s.length}aa`
              : `序列${j + 1} · ${s.length}aa`,
            range: s.range,
            sequence: s.seq,
            sequenceHeader: s.header || undefined,
            // v2.72：同行被忽略的抗体链透传（提交评估时随 options — 抗原的 Cryo-EM
            //  评分计入抗原-抗体复合物分子量）
            ...(s.antibodyPartner ? { antibodyPartner: s.antibodyPartner } : {}),
            // v2.38：同上 — 启动时未勾选的序列靶点跳过（可恢复）
            status: (payload.skipFlags?.seqGroups?.[k]?.[j] ? 'skipped' : 'pending') as 'skipped' | 'pending',
            // v2.66：同上 — 导入匹配而跳过的序列靶点计入「载入」口径
            ...(payload.importedFlags?.seqGroups?.[k]?.[j]
              ? { imported: true as const, skipNote: '已导入既有报告（启动前导入匹配 — 跳过评估，计入「载入」）' }
              : {}),
          })),
          status: 'pending' as const,
        })),
      ]
      // v2.68：启动面板导入报告携带的数据（键与 skipFlags 同构重排 — 按载荷组索引
      //  `g:${i}:${j}` / `sq:${k}:${j}`）：jobId 供汇总报告从服务端恢复完整统计行
      const importedReportByKey = new Map((payload.importedReports ?? []).map((e) => [e.key, e]))
      for (let i = 0; i < groups.length; i++) {
        for (let j = 0; j < groupStates[i]!.items.length; j++) {
          const it = groupStates[i]!.items[j]!
          if (it.imported) {
            const rep = importedReportByKey.get(`g:${i}:${j}`)
            if (rep) {
              it.importedJobId = rep.jobId
              it.importedFile = rep.fileName
              it.importedStats = rep.stats
              it.importedReportId = rep.reportId
            }
          }
        }
      }
      for (let k = 0; k < seqGroups.length; k++) {
        const g = groupStates[groups.length + k]
        if (!g) continue
        for (let j = 0; j < g.items.length; j++) {
          const it = g.items[j]!
          if (it.imported) {
            const rep = importedReportByKey.get(`sq:${k}:${j}`)
            if (rep) {
              it.importedJobId = rep.jobId
              it.importedFile = rep.fileName
              it.importedStats = rep.stats
              it.importedReportId = rep.reportId
            }
          }
        }
      }
      const importedAtStart = groupStates.reduce((n, g) => n + g.items.filter((it) => it.imported === true).length, 0)
      const newRun: HTRunState = {
        id: `ht-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: now,
        goal: payload.goal,
        options: payload.options,
        ligands: payload.ligands,
        groups: groupStates,
        currentIndex: 0,
        status: 'running',
        resumedCount: 0,
        totalTargetCount: groupStates.reduce((n, g) => n + g.items.length, 0),
        // v2.36：原始 Excel 行快照（汇总报告「原表内容」列）
        excelRows: payload.excelRows,
        // v2.66：启动前导入的靶点数（运行级备注 — 与运行中 zip 导入的 importedNote 同构）
        importedNote: importedAtStart > 0
          ? `启动前已导入 ${importedAtStart} 个靶点的既有报告（跳过评估，进度计入「载入」）`
          : undefined,
      }
      const skippedAtStart = groupStates.reduce((n, g) => n + g.items.filter((it) => it.status === 'skipped').length, 0)
      const toEvaluate = newRun.totalTargetCount - skippedAtStart
      if (toEvaluate <= 0 && importedAtStart === 0) {
        const msg = '所有靶点都被跳过了 — 请至少勾选一个要评估的靶点（或移除跳过标记）'
        toast({ title: '无法开始高通量评估', description: msg, variant: 'destructive' })
        return { ok: false, error: msg }
      }
      // v2.69：纯导入运行（0 个待评估、全部载入）— 全部组即刻完成，直接产出汇总报告
      runRef.current = newRun
      runFolderRef.current = safeDir(`TargetEval_HT_${new Date(now).toISOString().slice(0, 10)}_${groupStates.length}g`)
      pausedRef.current = false
      cancelRef.current = false
      activeJobIdsRef.current = new Set()
      activeMsRef.current = 0
      setElapsedSec(0)
      setNetworkIssue(false)
      setDisplayJob(null)
      displayJobIdRef.current = null
      saveHTRun(newRun)
      setRun(cloneRun(newRun))
      refreshRecentRuns()
      setPhase('running')
      startTick()
      warmupBlast(newRun)
      void orchestrate()
      if (importedAtStart > 0 && toEvaluate === 0) {
        toast({
          title: '高通量评估已开始',
          description: `全部 ${importedAtStart} 个靶点已载入既有报告 — 无需重复评估，运行即刻完成并直接生成汇总报告（导入报告的评分与结论已整合）。`,
        })
      } else if (skippedAtStart > 0) {
        toast({
          title: '高通量评估已开始',
          description: `将评估 ${toEvaluate} 个靶点（另载入/跳过 ${skippedAtStart} 个 — 可在运行中随时恢复评估）。`,
        })
      }
      return { ok: true }
    } finally {
      setStarting(false)
    }
  }

  /**
   * 配额恢复后手动重新开始（从断点续跑；已完成组不重复评估）。
   * v2.38：stopped/中断恢复 — canceled 项重置为 pending 重新提交（手动停止时
   * 服务器作业已被取消，无结果可接）；running+jobId 项仍接上等待（中断时服务器
   * 侧可能仍在执行，结果不浪费）。
   */
  const resumeRun = useCallback(async (): Promise<StartResult> => {
    const r = runRef.current
    if (!r || r.status === 'running') return { ok: false, error: '没有可恢复的运行' }
    if (!runFolderRef.current) {
      runFolderRef.current = safeDir(`TargetEval_HT_${new Date(r.createdAt).toISOString().slice(0, 10)}_${r.groups.length}g`)
    }
    // v2.38：canceled → pending（组与项；清除已死作业引用 — 恢复时重新提交）
    resetCanceledForResume(r)
    pausedRef.current = false
    cancelRef.current = false
    r.status = 'running'
    r.resumedCount += 1
    r.pausedReason = undefined
    saveHTRun(r)
    setRun(cloneRun(r))
    refreshRecentRuns()
    setPhase('running')
    startTick()
    warmupBlast(r) // v2.39：恢复时对尚未评估的靶点再预热（幂等 — 已预提交的序列自动去重）
    void orchestrate()
    return { ok: true }
  }, [refreshRecentRuns, startTick, warmupBlast])

  /** v2.38 手动暂停：不取消服务器作业（跑完照常记结果），不再开新组/新作业 */
  const pauseRun = useCallback((): void => {
    const r = runRef.current
    if (!r || r.status !== 'running') return
    pausedRef.current = true
    r.status = 'paused'
    r.pausedReason = '用户手动暂停 — 服务器上正在执行的作业会继续跑完并记录结果'
    r.pausedAt = Date.now()
    saveHTRun(r)
    setRun(cloneRun(r))
    refreshRecentRuns()
    setPhase('paused')
    stopTick()
    toast({
      title: '已手动暂停',
      description: '正在执行的作业会继续跑完并记录结果；可随时「继续运行」从断点恢复，或先跳过/重跑指定靶点。',
    })
  }, [refreshRecentRuns, stopTick])

  /** v2.38：靶点级/组级编辑守卫 — 仅非 running 阶段可改（运行中编排独占状态） */
  const ensureEditable = useCallback((): boolean => {
    const r = runRef.current
    if (!r) return false
    if (r.status === 'running') {
      toast({ title: '运行进行中', description: '请先暂停或停止运行，再调整靶点的评估/跳过选择。', variant: 'destructive' })
      return false
    }
    return true
  }, [])

  /** v2.38：靶点有变动待评估 → 组回可执行态 + 汇总看板作废（见模块级 touchGroupForRerun） */

  /** v2.38：跳过/恢复一个靶点（pending/error/canceled ↔ skipped） */
  const toggleSkipItem = useCallback((groupIndex: number, key: string): void => {
    if (!ensureEditable()) return
    const r = runRef.current
    const g = r?.groups.find((x) => x.index === groupIndex)
    const it = g?.items.find((x) => x.key === key)
    if (!r || !g || !it) return
    if (it.status === 'skipped') {
      it.status = 'pending'
      it.skipNote = undefined
      it.imported = undefined // v2.60：恢复评估 — 脱离「载入」统计口径
      it.importedJobId = undefined // v2.68：报告数据一并清空（重新评估后以本作业为准）
      it.importedFile = undefined
      it.importedStats = undefined // v2.69：解析快照与原文留存一并作废
      it.importedReportId = undefined
      touchGroupForRerun(g, r)
    } else if (it.status !== 'done' && it.status !== 'running') {
      it.status = 'skipped'
      it.skipNote = '手动跳过（不评估）'
      it.imported = undefined
      it.importedJobId = undefined
      it.importedFile = undefined
      it.importedStats = undefined
      it.importedReportId = undefined
    }
    snapshot()
  }, [ensureEditable, snapshot])

  /** v2.38：重跑一个靶点（error/canceled/skipped → pending）；
 *  v2.41：done 但报告不完整（部分章节失败）也可重跑；重置时清旧 jobId
 *  （旧作业已终态 — pending+jobId 不会被重新提交，历史 bug） */
  const retryItem = useCallback((groupIndex: number, key: string): void => {
    if (!ensureEditable()) return
    const r = runRef.current
    const g = r?.groups.find((x) => x.index === groupIndex)
    const it = g?.items.find((x) => x.key === key)
    if (!r || !g || !it) return
    if (it.status === 'error' || it.status === 'canceled' || it.status === 'skipped' || (it.status === 'done' && it.reportIncomplete)) {
      it.status = 'pending'
      it.error = undefined
      it.skipNote = undefined
      it.imported = undefined
      it.importedJobId = undefined // v2.68：重新评估 — 导入数据作废
      it.importedFile = undefined
      it.importedStats = undefined // v2.69：解析快照与原文留存一并作废
      it.importedReportId = undefined
      it.reportIncomplete = undefined
      it.reportMissingNote = undefined
      it.jobId = undefined // v2.41 修复：清旧作业引用（重置为重新提交）
      touchGroupForRerun(g, r)
      snapshot()
    }
  }, [ensureEditable, snapshot])

  /** v2.38：组级 — 重跑本组全部失败/中断项（error/canceled → pending）；
 *  v2.41：报告不完整的 done 项也纳入（含清 jobId 修复） */
  const retryGroupFailures = useCallback((groupIndex: number): void => {
    if (!ensureEditable()) return
    const r = runRef.current
    const g = r?.groups.find((x) => x.index === groupIndex)
    if (!r || !g) return
    let n = 0
    for (const it of g.items) {
      if (it.status === 'error' || it.status === 'canceled' || (it.status === 'done' && it.reportIncomplete)) {
        it.status = 'pending'
        it.error = undefined
        it.reportIncomplete = undefined
        it.reportMissingNote = undefined
        it.jobId = undefined // v2.41 修复：清旧作业引用
        n++
      }
    }
    if (n > 0) {
      touchGroupForRerun(g, r)
      snapshot()
      toast({ title: `第 ${groupIndex + 1} 组已重置 ${n} 个失败/报告不完整靶点`, description: '点击「继续运行」开始重跑。' })
    }
  }, [ensureEditable, snapshot])

  /** v2.38：组级 — 跳过本组全部未开始项（pending → skipped） */
  const skipGroupPending = useCallback((groupIndex: number): void => {
    if (!ensureEditable()) return
    const r = runRef.current
    const g = r?.groups.find((x) => x.index === groupIndex)
    if (!r || !g) return
    let n = 0
    for (const it of g.items) {
      if (it.status === 'pending') {
        it.status = 'skipped'
        it.skipNote = '组级跳过（不评估）'
        n++
      }
    }
    if (n > 0) snapshot()
  }, [ensureEditable, snapshot])

  /**
   * v2.38：全局重跑失败项（error/canceled → pending）并自动继续运行。
   * 从 done/stopped/paused 均可调用；汇总看板作废（下次自然完成时重新生成）。
   */
  const retryFailed = useCallback(async (): Promise<StartResult> => {
    if (!ensureEditable()) return { ok: false, error: '运行进行中' }
    const r = runRef.current
    if (!r) return { ok: false, error: '没有打开的运行' }
    const n = resetFailedForRetry(r)
    if (n === 0) {
      toast({ title: '没有可重跑的失败靶点', description: '全部靶点均已成功或已跳过。' })
      return { ok: false, error: '没有失败靶点' }
    }
    toast({ title: `已重置 ${n} 个失败靶点`, description: '正在继续运行…' })
    return resumeRun()
  }, [ensureEditable, resumeRun])

  /**
   * v2.38→v2.44 导入既有报告（zip 归档 / 单独 HTML 文件，可多选批量）— 匹配到的
   * 未评估靶点标 skipped（报告已在用户手里，不重复评估、不占配额）。返回匹配数
   * + 未命中诊断（v2.49）；失败抛错。匹配循环在模块级 applyArchiveSkips
   * （react-hooks/immutability：直接在 useCallback 内改 runRef 会被 React 编译器拦，
   * 模块函数不受限）。
   */
  const importArchive = useCallback(async (files: File | File[]): Promise<ArchiveSkipResult> => {
    if (!ensureEditable()) throw new Error('运行进行中，请先暂停或停止')
    const r = runRef.current
    if (!r) throw new Error('没有打开的运行')
    const list = (Array.isArray(files) ? files : [files]).filter(Boolean)
    if (list.length === 0) throw new Error('未选择要导入的报告文件')
    const parsed = await parseHtImportFiles(list)
    if (parsed.reports.length === 0) throw new Error('所选文件中没有可识别的报告（支持 zip 归档与报告 HTML）')
    // 序列靶点预先算好 SHA（清单通道精确匹配）
    const shaByKey = new Map<string, string | undefined>()
    for (const g of r.groups) {
      for (const it of g.items) {
        if (it.sequence) shaByKey.set(it.key, await sha256Hex16(it.sequence))
      }
    }
    const displayName = list.length === 1 ? (list[0] as File).name : `${list.length} 个报告文件`
    const result = applyArchiveSkips(r, parsed.reports, shaByKey, displayName)
    // v2.69 enrich：解析匹配报告的统计快照 + 上传原文到服务端留存 —
    //  stats 入运行记录（localStorage 持久化，不依赖服务端保留期）；reportId 供
    //  汇总报告生成时服务端读回内嵌弹出页。任一失败独立降级，不阻塞导入
    if (result.matchedByKey.size > 0) {
      const enrichItems: ImportEnrichItem[] = []
      const enrichedTargets: HTGroupItemState[] = []
      for (const g of r.groups) {
        for (const it of g.items) {
          if (!result.matchedByKey.has(it.key)) continue
          // v2.72：seqSha（导入前已算好 — shaByKey 复用）/label 一并传入（SHA 精确
          //  定位区段 + 同长歧义标签消歧 — 修复合并报告内已识别序列靶点定位失败）
          enrichItems.push({
            acc: it.sequence ? undefined : it.label,
            range: it.range,
            length: it.sequence?.length,
            seqSha: shaByKey.get(it.key),
            label: it.label,
            rep: result.matchedByKey.get(it.key),
          })
          enrichedTargets.push(it)
        }
      }
      try {
        const enriched = await enrichImportedReports(enrichItems, parsed)
        enrichedTargets.forEach((it, i) => {
          if (enriched[i]?.stats) it.importedStats = enriched[i]!.stats
          if (enriched[i]?.reportId) it.importedReportId = enriched[i]!.reportId
        })
        // v2.70：原文留存失败计数（有源文件但没拿到 reportId — 上传失败/超 32MB）
        result.uploadMissed = enriched.reduce(
          (n, e, i) => n + (enrichItems[i]?.rep && !e.reportId ? 1 : 0), 0,
        )
      } catch {
        /* enrich 失败（网络/解析）→ 降级「载入」行，导入匹配本身不受影响 */
      }
    }
    r.importedNote = result.matched > 0 ? `已从 ${displayName.slice(0, 40)} 导入 ${result.matched} 个靶点的既有报告（跳过评估）` : undefined
    snapshot()
    return result
  }, [ensureEditable, snapshot])

  /** v2.44：手动重新生成「高通量评估汇总报告」（回看已完成运行时 — 首次生成失败 /
   * 旧报告已过期 / 重跑后想刷新时）。清除旧结果标记后走 finalizeHtDashboard 同一
   * 生成链路（评分统计 + 全靶点总表 + AI 整体可行性；完成后自动下载新 HTML）。 */
  const regenerateDashboard = useCallback(async (): Promise<void> => {
    const r = runRef.current
    if (!r) { toast({ title: '没有打开的运行' }) ; return }
    if (r.status === 'running' || r.dashboardPending) {
      toast({ title: '汇总报告生成中', description: '请等待当前生成完成后重试。' })
      return
    }
    if (!hasDashboardSource(r)) {
      toast({ title: '无法生成汇总报告', description: '该运行没有成功完成的靶点（全部失败/被取消/被跳过）— 可「重跑失败/不完整项」补齐后自动重新生成。', variant: 'destructive' })
      return
    }
    r.dashboardId = undefined
    r.dashboardError = undefined
    r.dashboardProgress = undefined
    r.dashboardProgressPct = undefined
    snapshot()
    await finalizeHtDashboardRef.current?.()
  }, [snapshot])

  /** 打开一份历史运行（done = 回看；paused/interrupted = 提供恢复入口） */
  const openRunById = useCallback(
    (id: string): void => {
      const r = getHTRun(id)
      if (!r) {
        toast({ title: '无法加载该高通量运行', description: '本地运行记录已不存在（浏览器数据被清理）', variant: 'destructive' })
        return
      }
      runRef.current = r
      runFolderRef.current = safeDir(`TargetEval_HT_${new Date(r.createdAt).toISOString().slice(0, 10)}_${r.groups.length}g`)
      setRun(cloneRun(r))
      setDisplayJob(null)
      displayJobIdRef.current = null
      setNetworkIssue(false)
      if (r.status === 'running') r.status = 'interrupted'
      // v2.38：stopped 独立阶段（可恢复 — 与限流自动暂停区分文案与操作集）
      setPhase(r.status === 'done' ? 'done' : r.status === 'stopped' ? 'stopped' : 'paused')
      // v2.37：打开历史运行 → 趁服务实例仍存活，后台补齐该运行全部终态作业与
      // 各组合并报告的本地副本（组日志弹窗/报告入口此后不再依赖服务端存活）
      const jobIds = r.groups.flatMap((g) =>
        g.items
          .filter((it) => (it.status === 'done' || it.status === 'error') && it.jobId)
          .map((it) => it.jobId as string),
      )
      const reportIds = r.groups.flatMap((g) => (g.mergedReportId ? [g.mergedReportId] : []))
      // v2.41：补档完成后回扫 done 靶点 — 从终态详情（含旧版本作业的日志快照）
      // 推导「报告不完整」标记（新作业在 finishItem 已实时标记）；补挂后可一键重跑
      void backfillJobCache(jobIds).then(() => {
        const cur = runRef.current
        if (!cur || cur.id !== id) return
        let changed = false
        for (const g of cur.groups) {
          for (const it of g.items) {
            if (it.status === 'done' && it.jobId && !it.reportIncomplete) {
              const note = reportIncompleteNote(getCachedJobDetail(it.jobId))
              if (note) {
                it.reportIncomplete = true
                it.reportMissingNote = note
                changed = true
              }
            }
          }
        }
        if (changed) snapshot()
      })
      void backfillBatchReportCache(reportIds)
      // v2.36：打开时发现汇总报告生成被刷新中断（done + pending 且无结果）→ 自动续生成
      if (r.status === 'done' && r.dashboardPending && !r.dashboardId) void finalizeHtDashboardRef.current?.()
      // v2.75：打开时发现汇总报告生成失败（错误横幅持久化在 localStorage）→ 自动重试
      //  一次自愈。背景：用户实测「统计看板生成失败（HTTP 404）」后，失败状态永久
      //  挂在横幅上（刷新/重开都还在），且纯导入运行的「重新生成」按钮被 doneTargets>0
      //  门控隐藏（v2.75 已改 settledTargets）— 用户既看不懂也无处可点。网络类失败
      //  （HTTP 4xx/5xx/Failed to fetch/超时）多为服务重启窗口的瞬态，服务恢复后
      //  重试即成功；每会话每运行只自动试一次（防 LLM 配额无谓消耗），失败后横幅
      //  「重新生成汇总报告」按钮仍可手动重试。
      if (
        r.status === 'done' && !r.dashboardId && !r.dashboardPending &&
        r.dashboardError && r.dashboardError !== '__done__' &&
        !dashboardAutoRetriedRef.current.has(id) && hasDashboardSource(r)
      ) {
        dashboardAutoRetriedRef.current.add(id)
        void finalizeHtDashboardRef.current?.()
      }
      if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'auto' })
    },
    [],
  )

  /** 删除一份运行历史（当前打开的运行被删除 → 回 idle） */
  const removeRun = useCallback(
    (id: string): void => {
      deleteHTRun(id)
      refreshRecentRuns()
      if (runRef.current?.id === id) {
        runRef.current = null
        setPhase('idle')
        setRun(null)
      }
    },
    [refreshRecentRuns],
  )

  /** v2.25：批量下载运行报告（zip：每组一个子文件夹 + 合并报告 + README 清单）。
   *  - 无参数：归档整个当前运行；
   *  - 传 id：归档任意历史运行（最近评估列表入口）；
   *  - 传 groupIndex：归档当前运行的指定单组（组卡「本组打包」）。 */
  const archiveRun = useCallback(async (id?: string, groupIndex?: number): Promise<void> => {
    const r = id ? getHTRun(id) : runRef.current
    if (!r) {
      toast({ title: '无法批量下载', description: '运行记录不存在（浏览器数据被清理）', variant: 'destructive' })
      return
    }
    // 归档条目：组内成功靶点的独立报告 + 组合并报告（组号→zip 子文件夹）
    // v2.28：统计看板（若有）作为根级 00_ 文件一并打包 — 内含离线链接指向本包各报告
    // v2.38：条目携带靶点元数据（uniprot/range/seqSha…）→ 包内 _TargetEval_manifest.json
    //  （新建运行导入该 zip 时精确匹配已完成的靶点直接跳过）
    const entries: HtArchiveEntry[] = []
    for (const g of r.groups) {
      if (groupIndex != null && g.index !== groupIndex) continue
      for (const it of g.items) {
        if (it.status === 'done' && it.jobId) {
          entries.push({
            jobId: it.jobId,
            group: g.index + 1,
            label: it.label,
            uniprot: it.sequence ? undefined : it.label,
            range: it.range,
            seqSha: it.sequence ? await sha256Hex16(it.sequence) : undefined,
            seqLength: it.sequence?.length,
            sequenceHeader: it.sequenceHeader,
          })
        }
      }
      if (g.mergedReportId) entries.push({ mergedId: g.mergedReportId, group: g.index + 1 })
    }
    if (groupIndex == null && r.dashboardId) entries.push({ dashboardId: r.dashboardId })
    if (entries.length === 0) {
      toast({ title: '没有可下载的报告', description: '该运行没有已完成的评估报告（全部失败/未开始或已清理）。', variant: 'destructive' })
      return
    }
    setArchiving(true)
    try {
      await downloadHtReportArchive(entries, groupIndex != null ? `G${String(groupIndex + 1).padStart(2, '0')}` : `${r.groups.length}g`)
      toast({
        title: '批量下载已开始',
        description: groupIndex != null
          ? `已打包第 ${groupIndex + 1} 组 ${entries.length} 份报告为 zip。`
          : `已打包 ${entries.length} 份报告为 zip（每组一个子文件夹，含合并报告与 README 清单）。`,
      })
    } catch (e) {
      toast({ title: '批量下载失败', description: e instanceof Error ? e.message : '归档服务暂不可用，请稍后重试', variant: 'destructive' })
    } finally {
      setArchiving(false)
    }
  }, [])

  /** 手动停止：取消服务器侧活跃作业 + 未开始的组标 canceled；已完成组结果保留 */
  const cancelRun = useCallback(async (): Promise<void> => {
    const r = runRef.current
    if (!r) return
    cancelRef.current = true
    const ids = [...activeJobIdsRef.current]
    stopTick()
    if (ids.length > 0) {
      setCanceling(true)
      try {
        // v2.42：取消模式 — 中止运行中作业但保留日志与已产出结果（与历史页的
        // 删除语义分开；停止与作业完成竞态时不再误删已完成报告）
        await Promise.allSettled(ids.map((id) => fetch(`/api/jobs/${id}?mode=cancel`, { method: 'DELETE' })))
      } catch {
        // 忽略取消请求失败（作业可能已结束）
      } finally {
        activeJobIdsRef.current = new Set()
        setCanceling(false)
      }
    }
  }, [stopTick])

  /** 退出高通量视图回输入页（运行记录保留在本地与 HT Tab）。
   * v2.40：运行中退出 = 暂停语义（原为 cancel 语义 — 在飞作业被标 canceled 但
   * 服务器侧照跑，成为无人轮询的僵尸：占并发坑位 + 恢复时被重复提交，双重浪费）。
   * 改为与手动暂停一致：在飞作业继续执行并记录结果，项保持 running —
   * 回到 HT 标签页「继续运行」时直接接上（reattach），不重复提交、不虚占坑位；
   * 尚未提交的项（等槽位/退避中）被唤醒后放弃，恢复时重新提交（无服务器作业，无浪费）。 */
  const exitToIdle = useCallback((): void => {
    const r = runRef.current
    if (r && r.status === 'running') {
      r.status = 'interrupted'
      pausedRef.current = true
      saveHTRun(r)
    }
    stopTick()
    setPhase('idle')
    setDisplayJob(null)
    refreshRecentRuns()
  }, [refreshRecentRuns, stopTick])

  return {
    phase,
    run,
    recentRuns,
    displayJob,
    elapsedSec,
    networkIssue,
    canceling,
    starting,
    /** v2.25 批量下载中（入口禁用 + spinner） */
    archiving,
    startRun,
    resumeRun,
    openRunById,
    removeRun,
    /** v2.25 批量下载运行报告（当前运行或按 id 的历史运行 → zip） */
    archiveRun,
    cancelRun,
    exitToIdle,
    /** v2.38 手动暂停（不取消服务器作业 — 跑完照常记结果） */
    pauseRun,
    /** v2.38 跳过/恢复一个靶点（非 running 阶段） */
    toggleSkipItem,
    /** v2.38 重跑一个靶点（error/canceled/skipped → pending） */
    retryItem,
    /** v2.38 组级：重跑本组全部失败/中断项 */
    retryGroupFailures,
    /** v2.38 组级：跳过本组全部未开始项 */
    skipGroupPending,
    /** v2.38 全局重跑失败项并自动继续运行 */
    retryFailed,
    /** v2.38 导入既有报告（zip / 单独 HTML，可多选；匹配到的未评估靶点标 skipped） */
    importArchive,
    /** v2.44 手动重新生成汇总报告（回看已完成运行时） */
    regenerateDashboard,
  }
}
