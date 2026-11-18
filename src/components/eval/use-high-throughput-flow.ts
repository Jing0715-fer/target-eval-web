'use client'

/**
 * 高通量评估编排（v2.22）。
 *
 * 输入契约：「;」分隔组，组内「,」分隔靶点 ——
 *  - 组内多个靶点 = 按现有复合物批量评估链路（关系判断 → 2 并发窗口 → ≥2 成功出合并报告）
 *  - 组内仅一个靶点 = 单作业独立评估
 *  - 每组单独出报告；组间严格串行（贴合服务端每 IP 并发上限 EVAL_MAX_ACTIVE_PER_IP=2）
 *
 * 限流自动暂停（用户核心诉求）：
 *  - 检测点覆盖：作业创建 429（系统配额）、作业终态 error 的限流指纹、
 *    作业完成但报告 LLM 全部失败（reportLlmOk !== true，常见于供应商限流/额度耗尽）、
 *    关系判断 / 合并报告生成失败的限流指纹
 *  - 暂停 = 不再提交新作业、不开下一组；已在跑的作业让其在服务器自然跑完（数据不浪费），
 *    结果照常记入组状态
 *  - 配额恢复后由用户「重新开始运行」：从断点续跑 —— 已完成/已终态的靶点不重复评估，
 *    未提交的继续提交，未开始的组继续开
 *
 * 持久化：运行结构（组清单 + 每组作业 id + 报告 id + 断点）落 localStorage（te_ht_runs_v1，
 * 保留最近 5 份运行历史）；页面刷新后标记 interrupted，可从断点恢复或回看。
 * 报告本体（HTML/作业 logs）持久化在服务端 DB（30 天 TTL），回看按需拉取。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from '@/hooks/use-toast'
import { downloadHtReportArchive, generateBatchReport, generateHtDashboard, getLlmEngineOverride, isStatelessEnv, judgeTargetRelation, type HtArchiveEntry } from './api'
import { deleteHTRun, getHTRun, listHTRuns, markInterruptedOnLoad, saveHTRun } from './high-throughput-store'
import type { StartResult } from './use-evaluation-flow'
import { autoDownloadHtmlReport, buildBatchNote, fallbackIndependentJudgment } from './use-evaluation-flow'
import type { EvaluateRequest, HTGroupItemState, HTGroupState, HTRunState, HtSeqTarget, HTStartPayload, JobDetail, RelationJudgment } from './types'

export type HTPhase = 'idle' | 'running' | 'paused' | 'done'

const POLL_INTERVAL_MS = 2000
/** 连续轮询失败达到该值 → 网络异常提示（继续重试） */
const MAX_CONSECUTIVE_FAILURES = 3
/** 组内并发窗口（与服务端每 IP 并发上限 EVAL_MAX_ACTIVE_PER_IP=2 对齐） */
const HT_WINDOW = 2

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

/** 组级进度可复用 ProgressPanel（BatchState 形状）所需要的数据源（视图层组装，此处只给状态） */
function cloneRun(run: HTRunState): HTRunState {
  return JSON.parse(JSON.stringify(run)) as HTRunState
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

  /** 运行状态 → localStorage + 视图（组状态关键节点调用） */
  const snapshot = useCallback(() => {
    const r = runRef.current
    if (!r) return
    saveHTRun(r)
    setRun(cloneRun(r))
  }, [])

  /** 创建一个评估作业（POST /api/evaluate，本地引擎内联携带 — 与单次评估同路径） */
  const createJob = async (request: EvaluateRequest): Promise<{ jobId?: string; error?: string }> => {
    try {
      const llm = getLlmEngineOverride()
      const res = await fetch('/api/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(llm ? { ...request, llm } : request),
      })
      let data: { ok?: boolean; jobId?: string; error?: string } | null = null
      try {
        data = (await res.json()) as { ok?: boolean; jobId?: string; error?: string }
      } catch {
        data = null
      }
      if (!res.ok || !data || !data.jobId) {
        return { error: data?.error ?? `评估服务暂不可用（HTTP ${res.status}）` }
      }
      return { jobId: data.jobId }
    } catch (err) {
      return { error: err instanceof Error ? err.message : '创建评估作业失败，请稍后重试' }
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
          // 作业从服务端消失（外部取消/删除/TTL）→ 按 canceled 收尾（不无限重试）
          if (res.status === 404 || res.status === 410) {
            finish('canceled')
            return
          }
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const data = (await res.json()) as JobDetail
          last = data
          fails = 0
          setNetworkIssue(false)
          if (data.id === displayJobIdRef.current) setDisplayJob(data)
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
          pauseWithReason(`第 ${groupNo} 组靶点 ${label} 报告生成失败（LLM 全章节未产出，常见于供应商限流或额度耗尽）。`)
        } else {
          item.status = 'done'
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
        if (isRateLimitError(r.job?.error)) {
          pauseWithReason(`靶点 ${label} 作业执行失败（限流/配额）：${(r.job?.error ?? '').slice(0, 120)}`)
        }
      } else {
        item.status = 'canceled'
      }
    },
    [pauseWithReason],
  )

  /**
   * 执行一组（可重入 — 恢复运行时从组内 items 状态续）：
   *  judging（多靶点）→ 2 并发窗口 evaluating → merging（≥2 成功）→ done
   * 暂停/取消：正在跑的作业收尾后组标 paused/canceled，循环不再推进。
   */
  const runGroup = async (g: HTGroupState): Promise<void> => {
    const runState = runRef.current
    if (!runState) return
    const single = g.targets.length === 1
    g.startedAt = g.startedAt ?? Date.now()

    // ── ① 关系判断（多靶点组；重入时已有 relation 则跳过）──────────────
    if (!single && !g.relation) {
      g.status = 'judging'
      snapshot()
      try {
        const rel = await judgeTargetRelation({ uniprots: g.targets, goal: runState.goal })
        g.relation = rel.judgment
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
    const batchNote = !related && g.relation ? buildBatchNote(g.relation, g.targets.length) : undefined
    // v1.11 ≥90% 高一致组委托：组内首个提交 BLAST 的作业为家族代表，其余共享结果
    const blastGroups = g.relation?.blastGroups ?? []

    // ── ② 2 并发滑动窗口（重入：已终态跳过；running+jobId 接上等待；未提交的重新提交）──
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
            // v2.27：行内构建区间（UniProt 归属后区间过滤；手动值优先于比对推导）
            options: { ...runState.options, reportMode: 'single', range: item.range },
          }
        : {
            mode: 'uniprot',
            uniprot: label,
            goal: runState.goal,
            ligands: runState.ligands,
            batchNote,
            homologBlast: group,
            // v2.27：截短构建感知 — options.range（仅保留链范围重叠的结构）
            options: { ...runState.options, reportMode: related ? 'deferred' : 'single', range: item.range },
          }
      const created = await createJob(req)
      if (cancelRef.current || pausedRef.current) {
        item.status = 'canceled'
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

    let next = 0
    const activePromises: Array<Promise<void>> = []
    // 恢复场景：先接上服务器侧仍在执行的作业（同组至多 HT_WINDOW 个）
    for (const item of reattach.slice(0, HT_WINDOW)) {
      const p = reattachOne(item).finally(() => {
        const idx = activePromises.indexOf(p)
        if (idx >= 0) activePromises.splice(idx, 1)
      })
      activePromises.push(p)
    }

    while ((next < unstarted.length && !pausedRef.current && !cancelRef.current) || activePromises.length > 0) {
      while (next < unstarted.length && !pausedRef.current && !cancelRef.current && activePromises.length < HT_WINDOW) {
        const p = launchOne(unstarted[next]).finally(() => {
          const idx = activePromises.indexOf(p)
          if (idx >= 0) activePromises.splice(idx, 1)
        })
        activePromises.push(p)
        next++
      }
      if (activePromises.length === 0) break
      await Promise.race(activePromises)
    }

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

  /** 组循环：串行推进（暂停/取消即停；done 组跳过 — 恢复语义） */
  const orchestrate = async (): Promise<void> => {
    const runState = runRef.current
    if (!runState) return
    for (let gi = 0; gi < runState.groups.length; gi++) {
      if (pausedRef.current || cancelRef.current) break
      const g = runState.groups[gi]
      if (g.status === 'done' || g.status === 'canceled') continue
      runState.currentIndex = gi
      snapshot()
      await runGroup(g)
      if (pausedRef.current || cancelRef.current) break
    }
    if (pausedRef.current) return // runGroup/pauseWithReason 已置状态；后台作业继续收尾
    // 手动停止：未开始的组标 canceled
    if (cancelRef.current) {
      for (const g of runState.groups) {
        if (g.status === 'pending' || g.status === 'judging' || g.status === 'evaluating' || g.status === 'merging') {
          g.status = 'canceled'
        }
      }
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
    toast({
      title: '高通量评估完成',
      description: `${runState.groups.length} 组中 ${doneGroups} 组完成，${reports} 组产出了可查看的报告；统计看板正在生成（评分统计 + AI 整体可行性报告，完成后自动下载）。运行日志可在每组卡片中回看。`,
    })
  }

  /**
   * v2.28：运行完成后生成统计看板 — entries 与 zip 归档同构（服务端据此计算离线
   * 链接命名）；≥1 个成功靶点才生成。幂等：已有 dashboardId 的运行不重复生成
   * （恢复/重开场景）。失败不阻塞（运行已完成）；限流/超时记入 dashboardError，
   * 可从「批量下载全部」入口重试。
   */
  const finalizeHtDashboard = async (): Promise<void> => {
    const runState = runRef.current
    if (!runState || runState.dashboardId || runState.dashboardError === '__done__') return
    const entries: HtArchiveEntry[] = []
    for (const g of runState.groups) {
      for (const it of g.items) {
        if (it.status === 'done' && it.jobId) entries.push({ jobId: it.jobId, group: g.index + 1, label: it.label })
      }
      if (g.mergedReportId) entries.push({ mergedId: g.mergedReportId, group: g.index + 1 })
    }
    if (!entries.some((e) => e.jobId)) return
    try {
      const dash = await generateHtDashboard({ entries, goal: runState.goal })
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
        toast({
          title: '统计看板已生成',
          description: `评分统计 + AI 整体可行性报告已自动下载；每靶点含一句话结论（能否做）与单独报告链接，「批量下载全部」zip 解压后离线链接可直接点开。`,
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
            status: 'pending' as const,
          })),
          status: 'pending' as const,
        })),
        ...seqGroups.map((seqs, k) => ({
          index: groups.length + k,
          targets: [] as string[],
          seqTargets: seqs,
          items: seqs.map((s: HtSeqTarget, j: number) => ({
            key: `sq-${k}-${j}-${s.length}`,
            label: s.header ? `${s.header.slice(0, 24)} · ${s.length}aa` : `序列${j + 1} · ${s.length}aa`,
            range: s.range,
            sequence: s.seq,
            sequenceHeader: s.header || undefined,
            status: 'pending' as const,
          })),
          status: 'pending' as const,
        })),
      ]
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
      }
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
      void orchestrate()
      return { ok: true }
    } finally {
      setStarting(false)
    }
  }

  /** 配额恢复后手动重新开始（从断点续跑；已完成组不重复评估） */
  const resumeRun = useCallback(async (): Promise<StartResult> => {
    const r = runRef.current
    if (!r || r.status === 'done') return { ok: false, error: '没有可恢复的运行' }
    if (!runFolderRef.current) {
      runFolderRef.current = safeDir(`TargetEval_HT_${new Date(r.createdAt).toISOString().slice(0, 10)}_${r.groups.length}g`)
    }
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
    void orchestrate()
    return { ok: true }
  }, [refreshRecentRuns, startTick])

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
      setPhase(r.status === 'done' ? 'done' : 'paused')
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
    const entries: HtArchiveEntry[] = []
    for (const g of r.groups) {
      if (groupIndex != null && g.index !== groupIndex) continue
      for (const it of g.items) {
        if (it.status === 'done' && it.jobId) entries.push({ jobId: it.jobId, group: g.index + 1, label: it.label })
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
        await Promise.allSettled(ids.map((id) => fetch(`/api/jobs/${id}`, { method: 'DELETE' })))
      } catch {
        // 忽略取消请求失败（作业可能已结束）
      } finally {
        activeJobIdsRef.current = new Set()
        setCanceling(false)
      }
    }
  }, [stopTick])

  /** 退出高通量视图回输入页（运行记录保留在本地与 HT Tab；running 时视为中断保存） */
  const exitToIdle = useCallback((): void => {
    const r = runRef.current
    if (r && r.status === 'running') {
      r.status = 'interrupted'
      pausedRef.current = true
      cancelRef.current = true
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
  }
}
