'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { generateBatchReport, judgeTargetRelation } from './api'
import type { BatchReportInfo, EvaluateRequest, JobDetail, RelationJudgment } from './types'

/** 主视图状态机：idle（输入）→ running（进度）→ done（结果）；error 单独处理 */
export type Phase = 'idle' | 'running' | 'done' | 'error'

export interface StartResult {
  ok: boolean
  error?: string
}

/** 批量评估条目（docx 多 UniProt：每个靶点一个独立作业） */
export interface BatchItem {
  key: string
  /** 展示标签（UniProt ID / 序列靶点） */
  label: string
  jobId?: string
  status: 'running' | 'done' | 'error' | 'canceled'
  error?: string
}

export interface BatchState {
  total: number
  /** 最近创建（正在推进）的作业下标 */
  currentIndex: number
  items: BatchItem[]
  /** 全部作业已结束 */
  done: boolean
  /** v1.8 靶点关系判断（null = 判断失败/未做） */
  relation?: RelationJudgment | null
  /** 关系判断进行中 */
  relationJudging?: boolean
  /** 关系判断失败原因（降级为独立报告） */
  relationError?: string
  /** 合并报告生成中（关联靶点全部完成后） */
  merging?: boolean
  /** 合并报告（生成成功后存在） */
  mergedReport?: BatchReportInfo
  /** 合并报告生成失败原因 */
  mergedError?: string
  /** 结果视图：merged = 合并报告（默认，关联时）；job = 各靶点数据 */
  view?: 'merged' | 'job'
}

const POLL_INTERVAL_MS = 2000
/** 连续获取进度失败次数达到该值时，展示网络异常提示（继续重试） */
const MAX_CONSECUTIVE_FAILURES = 3
/** 批量并发窗口（与服务端作业并发池 EVAL_JOB_CONCURRENCY=2 对齐：
 *  一个作业等 BLAST 时另一个先做数据检索，批量总时长显著缩短） */
const BATCH_WINDOW = 2

/** 从请求中提取展示标签（批量切换栏用） */
function requestLabel(req: EvaluateRequest): string {
  const u = (req.uniprotFromDocx ?? req.uniprot ?? '').trim().toUpperCase()
  if (u) return u
  if (req.mode === 'docx' && req.docxJobId) return '序列靶点'
  if (req.mode === 'sequence') return '序列靶点'
  return '评估靶点'
}

/** 非关联批次的报告注入说明（服务端同样逻辑，此处用于展示一致性） */
function buildBatchNote(judgment: RelationJudgment, total: number): string {
  const typeText = judgment.relationType === 'pathway'
    ? '同通路/功能相关但结构解析相互独立'
    : judgment.relationType === 'independent'
      ? '相互独立的项目'
      : '功能上存在关联但结构解析独立推进'
  return `本批次共评估 ${total} 个靶点，经分析为${typeText}${judgment.rationale ? `（${judgment.rationale.slice(0, 160)}）` : ''}，各靶点分别出具报告`
}

/**
 * 评估流程状态机：
 * - startEvaluation(requests)：单个请求 → POST + 2s 轮询（原有流程）；
 *   多个请求（docx 多 UniProt）→ v1.8 批量编排：
 *     ① 靶点关系 LLM 判断（关联 → 合并报告；非关联 → 各自报告 + 批次说明）
 *     ② 2 并发滑动窗口执行（服务端并发池对齐，BLAST 等待期推进下一靶点）
 *     ③ 关联批次全部完成后生成合并评估报告（含关系分析章节）
 * - 轮询 GET /api/jobs/[id]，status 变 done/error/canceled 时停止
 * - cancelJob：DELETE 所有进行中作业（批量模式终止后续提交）
 * - loadJob：从历史记录加载作业（done → 结果视图；running → 进度视图）
 */
export function useEvaluationFlow() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [job, setJob] = useState<JobDetail | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [networkIssue, setNetworkIssue] = useState(false)
  const [elapsedSec, setElapsedSec] = useState(0)
  const [canceling, setCanceling] = useState(false)
  const [loadingHistoryJob, setLoadingHistoryJob] = useState(false)
  /** 批量评估状态（多请求时存在；单请求为 null） */
  const [batch, setBatch] = useState<BatchState | null>(null)

  const jobIdRef = useRef<string | null>(null)
  /** 进度面板展示的作业 id（批量并发时展示最新创建的作业） */
  const displayJobIdRef = useRef<string | null>(null)
  /** 批量模式下当前活跃（pending/running）作业集合 — 取消时逐一 DELETE */
  const activeJobIdsRef = useRef<Set<string>>(new Set())
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const tickTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startedAtRef = useRef<number>(0)
  const failCountRef = useRef(0)
  const lastRequestsRef = useRef<EvaluateRequest[] | null>(null)
  const batchRef = useRef<BatchState | null>(null)
  const batchCancelRef = useRef(false)

  const clearTimers = useCallback(() => {
    if (pollTimerRef.current !== null) {
      clearInterval(pollTimerRef.current)
      pollTimerRef.current = null
    }
    if (tickTimerRef.current !== null) {
      clearInterval(tickTimerRef.current)
      tickTimerRef.current = null
    }
  }, [])

  // 组件卸载时清理定时器
  useEffect(() => clearTimers, [clearTimers])

  const startTick = useCallback(() => {
    tickTimerRef.current = setInterval(() => {
      setElapsedSec(Math.max(0, Math.floor((Date.now() - startedAtRef.current) / 1000)))
    }, 1000)
  }, [])

  /** 应用一次作业快照，处理终态切换（单作业路径；批量路径由编排器处理终态） */
  const applyJobSnapshot = useCallback(
    (data: JobDetail) => {
      setJob(data)
      if (batchRef.current) return // 批量进行中：终态切换由批量编排器决定
      if (data.status === 'done') {
        clearTimers()
        setPhase('done')
      } else if (data.status === 'error') {
        clearTimers()
        setPhase('error')
      } else if (data.status === 'canceled') {
        clearTimers()
        jobIdRef.current = null
        setJob(null)
        setPhase('idle')
      }
    },
    [clearTimers]
  )

  const pollOnce = useCallback(async () => {
    const id = jobIdRef.current
    if (!id) return
    try {
      const res = await fetch(`/api/jobs/${id}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as JobDetail
      failCountRef.current = 0
      setNetworkIssue(false)
      applyJobSnapshot(data)
    } catch {
      // 单次失败静默重试；连续失败则提示
      failCountRef.current += 1
      if (failCountRef.current >= MAX_CONSECUTIVE_FAILURES) {
        setNetworkIssue(true)
      }
    }
  }, [applyJobSnapshot])

  const startPolling = useCallback(
    (id: string) => {
      clearTimers()
      jobIdRef.current = id
      displayJobIdRef.current = id
      startedAtRef.current = Date.now()
      setElapsedSec(0)
      setNetworkIssue(false)
      failCountRef.current = 0
      void pollOnce()
      pollTimerRef.current = setInterval(() => {
        void pollOnce()
      }, POLL_INTERVAL_MS)
      startTick()
    },
    [clearTimers, pollOnce, startTick]
  )

  /** 创建一个评估作业（POST /api/evaluate），失败返回 error */
  const createJob = async (request: EvaluateRequest): Promise<{ jobId?: string; error?: string }> => {
    try {
      const res = await fetch('/api/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
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

  /** 轮询作业至终态（批量模式专用）。仅当该作业为「最新展示作业」时更新进度面板。 */
  const waitForJobTerminal = (id: string): Promise<'done' | 'error' | 'canceled'> => {
    return new Promise((resolve) => {
      let settled = false
      let fails = 0
      const finish = (s: 'done' | 'error' | 'canceled') => {
        if (settled) return
        settled = true
        clearInterval(timer)
        activeJobIdsRef.current.delete(id)
        resolve(s)
      }
      const timer = setInterval(async () => {
        if (batchCancelRef.current) {
          finish('canceled')
          return
        }
        try {
          const res = await fetch(`/api/jobs/${id}`, { cache: 'no-store' })
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const data = (await res.json()) as JobDetail
          fails = 0
          setNetworkIssue(false)
          if (data.id === displayJobIdRef.current) setJob(data)
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

  /** 批量编排（v1.8）：关系判断 → 2 并发滑动窗口 → 合并报告（关联时） */
  const runBatch = async (requests: EvaluateRequest[]) => {
    batchCancelRef.current = false
    activeJobIdsRef.current = new Set()
    const st: BatchState = {
      total: requests.length,
      currentIndex: 0,
      items: [],
      done: false,
      relationJudging: true,
      view: 'job',
    }
    const snapshot = (): BatchState => ({ ...st, items: st.items.map(x => ({ ...x })) })
    batchRef.current = st
    setBatch(snapshot())
    setJob(null)
    setPhase('running')
    startedAtRef.current = Date.now()
    setElapsedSec(0)
    setNetworkIssue(false)
    failCountRef.current = 0
    startTick()

    // ── ① 靶点关系判断（失败降级为独立报告，不阻塞）──
    const uploadId = (requests[0]?.docxJobId ?? requests[0]?.uploadId ?? '').trim() || undefined
    const uniprots = requests.map(r => (r.uniprotFromDocx ?? r.uniprot ?? '').trim().toUpperCase()).filter(Boolean)
    let judgment: RelationJudgment | null = null
    if (uploadId && new Set(uniprots).size >= 2) {
      try {
        judgment = await judgeTargetRelation({ uploadId, uniprots, goal: requests[0]?.goal })
      } catch (e) {
        st.relationError = e instanceof Error ? e.message : '关系判断服务暂不可用'
      }
    } else {
      st.relationError = '靶点信息不足（缺少 UniProt ID），未做关系判断'
    }
    if (batchCancelRef.current) {
      clearTimers()
      batchRef.current = null
      setPhase('idle')
      setJob(null)
      return
    }
    st.relationJudging = false
    st.relation = judgment
    setBatch(snapshot())

    const related = judgment?.related === true
    const batchNote = !related && judgment ? buildBatchNote(judgment, requests.length) : undefined
    // 关联 → deferred（数据收集后并入合并报告）；非关联 → 独立报告 + 批次说明
    const reqs: EvaluateRequest[] = requests.map(r => ({
      ...r,
      batchNote,
      options: { ...r.options, reportMode: related ? 'deferred' : 'single' },
    }))

    // ── ② 2 并发滑动窗口执行（一个作业等 BLAST 时另一个先做数据检索）──
    let nextIndex = 0
    const activePromises: Array<Promise<void>> = []

    const launchOne = async (i: number) => {
      const label = requestLabel(reqs[i])
      const item: BatchItem = { key: `${i}-${label}`, label, status: 'running' }
      st.items = [...st.items, item]
      st.currentIndex = i
      setBatch(snapshot())

      const created = await createJob(reqs[i])
      if (batchCancelRef.current) {
        item.status = 'canceled'
        setBatch(snapshot())
        return
      }
      if (!created.jobId) {
        item.status = 'error'
        item.error = created.error
        setBatch(snapshot())
        return // 该靶点创建失败 → 继续其他靶点
      }
      item.jobId = created.jobId
      activeJobIdsRef.current.add(created.jobId)
      displayJobIdRef.current = created.jobId // 进度面板跟随最新创建的作业
      jobIdRef.current = created.jobId
      const result = await waitForJobTerminal(created.jobId)
      item.status = result
      if (result === 'error') item.error = '评估失败（详见该作业日志）'
      setBatch(snapshot())
    }

    while ((nextIndex < reqs.length && !batchCancelRef.current) || activePromises.length > 0) {
      while (nextIndex < reqs.length && !batchCancelRef.current && activePromises.length < BATCH_WINDOW) {
        const p = launchOne(nextIndex).finally(() => {
          const idx = activePromises.indexOf(p)
          if (idx >= 0) activePromises.splice(idx, 1)
        })
        activePromises.push(p)
        nextIndex++
      }
      if (activePromises.length === 0) break
      await Promise.race(activePromises)
    }

    clearTimers()
    const finished = st.items
    st.done = true
    setBatch(snapshot()) // 立即刷新完成态（含合并结果/失败信息）
    batchRef.current = null
    jobIdRef.current = null

    if (batchCancelRef.current) {
      setBatch({ ...snapshot(), done: true })
      setPhase('idle')
      setJob(null)
      return
    }

    const okItems = finished.filter(x => x.status === 'done' && x.jobId)

    // ── ③ 关联批次：生成合并评估报告（含靶点关系分析章节）──
    if (related && okItems.length >= 2 && uploadId) {
      st.merging = true
      setBatch(snapshot())
      try {
        const merged = await generateBatchReport({
          jobIds: okItems.map(x => x.jobId as string),
          uploadId,
          relation: judgment as RelationJudgment,
          goal: requests[0]?.goal,
        })
        st.mergedReport = merged
        st.merging = false
        st.view = 'merged'
        setBatch(snapshot())
      } catch (e) {
        st.merging = false
        st.mergedError = e instanceof Error ? e.message : '合并报告生成失败'
        setBatch(snapshot())
      }
    }

    if (okItems.length > 0) {
      // 合并成功 → 默认展示合并报告（各靶点数据经切换栏查看）；
      // 非关联/合并失败 → 展示第一个成功作业
      await loadJobById(okItems[0].jobId as string, { switchView: !st.mergedReport })
    } else {
      const failedCount = finished.filter(x => x.status === 'error').length
      setBatch({ ...snapshot(), done: true })
      setPhase('idle')
      setJob(null)
      setSubmitError(`批量评估未能完成（${failedCount} 个作业创建失败或执行失败），请检查网络后重试`)
    }
  }

  /** 创建评估作业（单个 = 原有流程；多个 = v1.8 批量编排） */
  const startEvaluation = async (requests: EvaluateRequest[]): Promise<StartResult> => {
    const list = (requests ?? []).filter(Boolean)
    if (list.length === 0) return { ok: false, error: '未提供评估请求' }
    lastRequestsRef.current = list
    setSubmitting(true)
    setSubmitError(null)
    setBatch(null)
    batchCancelRef.current = false
    try {
      if (list.length === 1) {
        const created = await createJob(list[0])
        if (!created.jobId) throw new Error(created.error)
        setJob(null)
        setPhase('running')
        startPolling(created.jobId)
        return { ok: true }
      }
      await runBatch(list)
      return { ok: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : '创建评估作业失败，请稍后重试'
      setSubmitError(msg)
      return { ok: false, error: msg }
    } finally {
      setSubmitting(false)
    }
  }

  /** 取消运行中的作业（批量模式：中止全部活跃作业并不再提交后续） */
  const cancelJob = useCallback(async () => {
    const ids = [...activeJobIdsRef.current]
    if (batchRef.current) batchCancelRef.current = true
    clearTimers()
    jobIdRef.current = null
    setPhase('idle')
    setJob(null)
    setNetworkIssue(false)
    if (ids.length > 0) {
      setCanceling(true)
      try {
        await Promise.allSettled(ids.map(id => fetch(`/api/jobs/${id}`, { method: 'DELETE' })))
      } catch {
        // 忽略取消请求失败（作业可能已结束）
      } finally {
        activeJobIdsRef.current = new Set()
        setCanceling(false)
      }
    } else {
      const id = displayJobIdRef.current
      if (id) {
        setCanceling(true)
        try {
          await fetch(`/api/jobs/${id}`, { method: 'DELETE' })
        } catch {
          // 忽略
        } finally {
          setCanceling(false)
        }
      }
    }
  }, [clearTimers])

  /** 回到输入视图（新评估） */
  const reset = useCallback(() => {
    clearTimers()
    batchCancelRef.current = true
    batchRef.current = null
    jobIdRef.current = null
    setPhase('idle')
    setJob(null)
    setSubmitError(null)
    setNetworkIssue(false)
    setBatch(null)
  }, [clearTimers])

  /** 失败后重试（复用上一次请求参数） */
  const retry = useCallback(() => {
    const reqs = lastRequestsRef.current
    if (reqs && reqs.length) {
      void startEvaluation(reqs)
    } else {
      reset()
    }
  }, [reset, startEvaluation])

  /** 按 id 拉取作业详情并应用快照（批量完成后切换展示用） */
  const loadJobById = async (id: string, opts?: { switchView?: boolean }) => {
    try {
      const res = await fetch(`/api/jobs/${id}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as JobDetail
      jobIdRef.current = id
      displayJobIdRef.current = id
      applyJobSnapshot(data)
      if (opts?.switchView !== false && batchRef.current === null) {
        // 批量已完成：切换到该靶点的数据视图
        setBatch(prev => (prev && prev.items.length > 1 ? { ...prev, view: 'job' } : prev))
      }
    } catch {
      setSubmitError('无法加载评估结果，请稍后在历史评估中查看')
      setPhase('idle')
    }
  }

  /** 切换到合并报告视图（关联批次结果页） */
  const showMergedReport = useCallback(() => {
    setBatch(prev => (prev ? { ...prev, view: 'merged' } : prev))
  }, [])

  /** 从历史记录加载作业：done → 结果视图；running/pending → 进度视图 */
  const loadJob = useCallback(
    async (id: string) => {
      setLoadingHistoryJob(true)
      setSubmitError(null)
      try {
        const res = await fetch(`/api/jobs/${id}`, { cache: 'no-store' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = (await res.json()) as JobDetail
        jobIdRef.current = id
        displayJobIdRef.current = id
        applyJobSnapshot(data)
        if (data.status === 'pending' || data.status === 'running') {
          setPhase('running')
          startPolling(id)
        }
      } catch {
        setSubmitError('无法加载该评估作业，请稍后重试')
      } finally {
        setLoadingHistoryJob(false)
      }
    },
    [applyJobSnapshot, startPolling]
  )

  const clearSubmitError = useCallback(() => setSubmitError(null), [])

  return {
    phase,
    job,
    submitting,
    submitError,
    networkIssue,
    elapsedSec,
    canceling,
    loadingHistoryJob,
    batch,
    startEvaluation,
    cancelJob,
    reset,
    retry,
    loadJob,
    loadJobById,
    showMergedReport,
    clearSubmitError,
  }
}
