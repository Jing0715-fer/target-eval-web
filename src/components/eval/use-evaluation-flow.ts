'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { EvaluateRequest, JobDetail } from './types'

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
  /** 当前正在执行的作业下标 */
  currentIndex: number
  items: BatchItem[]
  /** 全部作业已结束 */
  done: boolean
}

const POLL_INTERVAL_MS = 2000
/** 连续获取进度失败次数达到该值时，展示网络异常提示（继续重试） */
const MAX_CONSECUTIVE_FAILURES = 3

/** 从请求中提取展示标签（批量切换栏用） */
function requestLabel(req: EvaluateRequest): string {
  const u = (req.uniprotFromDocx ?? req.uniprot ?? '').trim().toUpperCase()
  if (u) return u
  if (req.mode === 'docx' && req.uploadId) return '序列靶点'
  if (req.mode === 'sequence') return '序列靶点'
  return '评估靶点'
}

/**
 * 评估流程状态机：
 * - startEvaluation(requests)：单个请求 → POST + 2s 轮询（原有流程）；
 *   多个请求（docx 多 UniProt）→ 批量串行编排：逐个创建作业并等待终态再提交
 *   下一个（每 IP 活跃上限 2，串行提交避免 429），全部完成后展示批量切换栏
 * - 轮询 GET /api/jobs/[id]，status 变 done/error/canceled 时停止
 * - cancelJob：DELETE /api/jobs/[id] 后回到 idle（批量模式终止后续提交）
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

  /** 轮询作业至终态（批量模式专用：实时刷新 job 供进度面板展示，终态由编排器处理） */
  const waitForJobTerminal = (id: string): Promise<'done' | 'error' | 'canceled'> => {
    return new Promise((resolve) => {
      let settled = false
      let fails = 0
      const finish = (s: 'done' | 'error' | 'canceled') => {
        if (settled) return
        settled = true
        clearInterval(timer)
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
          setJob(data)
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

  /** 批量编排：逐个「创建 → 轮询至终态 → 下一个」；部分失败不阻塞其余靶点 */
  const runBatch = async (requests: EvaluateRequest[]) => {
    batchCancelRef.current = false
    const st: BatchState = { total: requests.length, currentIndex: 0, items: [], done: false }
    batchRef.current = st
    setBatch({ ...st, items: [] })
    setJob(null)
    setPhase('running')
    startedAtRef.current = Date.now()
    setElapsedSec(0)
    setNetworkIssue(false)
    failCountRef.current = 0
    startTick()

    for (let i = 0; i < requests.length; i++) {
      if (batchCancelRef.current) break
      st.currentIndex = i
      const item: BatchItem = { key: `${i}-${requestLabel(requests[i])}`, label: requestLabel(requests[i]), status: 'running' }
      st.items = [...st.items, item]
      setBatch({ ...st, items: st.items.map(x => ({ ...x })) })

      const created = await createJob(requests[i])
      if (batchCancelRef.current) {
        item.status = 'canceled'
        setBatch({ ...st, items: st.items.map(x => (x.key === item.key ? { ...item } : x)) })
        break
      }
      if (!created.jobId) {
        item.status = 'error'
        item.error = created.error
        setBatch({ ...st, items: st.items.map(x => (x.key === item.key ? { ...item } : x)) })
        continue // 该靶点创建失败 → 继续下一个
      }
      item.jobId = created.jobId
      jobIdRef.current = created.jobId
      const result = await waitForJobTerminal(created.jobId)
      item.status = result
      if (result === 'error') item.error = '评估失败（详见该作业日志）'
      setBatch({ ...st, items: st.items.map(x => (x.key === item.key ? { ...item } : x)) })
      if (result === 'canceled') break
    }

    clearTimers()
    st.done = true
    const finished = st.items
    setBatch({ ...st, items: finished.map(x => ({ ...x })), done: true })
    batchRef.current = null
    jobIdRef.current = null

    if (batchCancelRef.current) {
      setPhase('idle')
      setJob(null)
      return
    }
    const okItems = finished.filter(x => x.status === 'done' && x.jobId)
    if (okItems.length > 0) {
      // 展示第一个成功作业的结果（批量切换栏可查看其余）
      await loadJobById(okItems[0].jobId as string)
    } else {
      const failedCount = finished.filter(x => x.status === 'error').length
      setPhase('idle')
      setJob(null)
      setSubmitError(`批量评估未能完成（${failedCount} 个作业创建失败或执行失败），请检查网络后重试`)
    }
  }

  /** 创建评估作业（单个 = 原有流程；多个 = 批量串行编排） */
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

  /** 取消运行中的作业（批量模式：终止当前作业并不再提交后续） */
  const cancelJob = useCallback(async () => {
    const id = jobIdRef.current
    if (batchRef.current) batchCancelRef.current = true
    clearTimers()
    jobIdRef.current = null
    setPhase('idle')
    setJob(null)
    setNetworkIssue(false)
    if (id) {
      setCanceling(true)
      try {
        await fetch(`/api/jobs/${id}`, { method: 'DELETE' })
      } catch {
        // 忽略取消请求失败（作业可能已结束）
      } finally {
        setCanceling(false)
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

  /** 按 id 拉取作业详情并应用快照（不设置 loading 态；批量完成后切换展示用） */
  const loadJobById = async (id: string) => {
    try {
      const res = await fetch(`/api/jobs/${id}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as JobDetail
      jobIdRef.current = id
      applyJobSnapshot(data)
    } catch {
      setSubmitError('无法加载评估结果，请稍后在历史评估中查看')
      setPhase('idle')
    }
  }

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
    clearSubmitError,
  }
}
