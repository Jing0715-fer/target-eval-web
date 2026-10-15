'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { EvaluateRequest, JobDetail } from './types'

/** 主视图状态机：idle（输入）→ running（进度）→ done（结果）；error 单独处理 */
export type Phase = 'idle' | 'running' | 'done' | 'error'

export interface StartResult {
  ok: boolean
  error?: string
}

const POLL_INTERVAL_MS = 2000
/** 连续获取进度失败次数达到该值时，展示网络异常提示（继续重试） */
const MAX_CONSECUTIVE_FAILURES = 3

/**
 * 评估流程状态机：
 * - startEvaluation：POST /api/evaluate 成功后进入 running 并开始 2s 轮询
 * - 轮询 GET /api/jobs/[id]，status 变 done/error/canceled 时停止
 * - cancelJob：DELETE /api/jobs/[id] 后回到 idle
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

  const jobIdRef = useRef<string | null>(null)
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const tickTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startedAtRef = useRef<number>(0)
  const failCountRef = useRef(0)
  const lastRequestRef = useRef<EvaluateRequest | null>(null)

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

  /** 应用一次作业快照，处理终态切换 */
  const applyJobSnapshot = useCallback(
    (data: JobDetail) => {
      setJob(data)
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
      tickTimerRef.current = setInterval(() => {
        setElapsedSec(Math.max(0, Math.floor((Date.now() - startedAtRef.current) / 1000)))
      }, 1000)
    },
    [clearTimers, pollOnce]
  )

  /** 创建评估作业（POST /api/evaluate），成功进入 running */
  const startEvaluation = useCallback(
    async (request: EvaluateRequest): Promise<StartResult> => {
      lastRequestRef.current = request
      setSubmitting(true)
      setSubmitError(null)
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
          throw new Error(data?.error ?? `评估服务暂不可用（HTTP ${res.status}）`)
        }
        setJob(null)
        setPhase('running')
        startPolling(data.jobId)
        return { ok: true }
      } catch (err) {
        const msg = err instanceof Error ? err.message : '创建评估作业失败，请稍后重试'
        setSubmitError(msg)
        return { ok: false, error: msg }
      } finally {
        setSubmitting(false)
      }
    },
    [startPolling]
  )

  /** 取消运行中的作业（DELETE /api/jobs/[id]） */
  const cancelJob = useCallback(async () => {
    const id = jobIdRef.current
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
    jobIdRef.current = null
    setPhase('idle')
    setJob(null)
    setSubmitError(null)
    setNetworkIssue(false)
  }, [clearTimers])

  /** 失败后重试（复用上一次请求参数） */
  const retry = useCallback(() => {
    const req = lastRequestRef.current
    if (req) {
      void startEvaluation(req)
    } else {
      reset()
    }
  }, [startEvaluation, reset])

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
    startEvaluation,
    cancelJob,
    reset,
    retry,
    loadJob,
    clearSubmitError,
  }
}
