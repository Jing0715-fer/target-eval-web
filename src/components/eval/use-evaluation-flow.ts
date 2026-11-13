'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from '@/hooks/use-toast'
import { evaluateSyncStream, fetchBatchReport, generateBatchReport, isStatelessEnv, judgeTargetRelation } from './api'
import { addSessionJob, getSessionJob } from './session-history'
import type { BatchReportInfo, EvaluateRequest, JobDetail, RelationJudgment, SequenceAttribution } from './types'

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
  /** 评估表序列归属（v1.10 — 批量条/合并报告展示「每条序列的去向」） */
  sequenceAttribution?: SequenceAttribution[]
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

/** 关系判断完全失败时的兜底独立判断（保证合并报告仍能生成） */
function fallbackIndependentJudgment(): RelationJudgment {
  return {
    related: false,
    relationType: 'independent',
    confidence: 'low',
    rationale: `关系判断未能完成，已按相互独立项目处理`,
    strategy: '各靶点独立推进结构解析评估',
  }
}

/** v1.19 自动下载记录（模块级：同一页面会话内每个报告只自动下载一次；切靶点/重渲染不重复） */
const autoDownloadedKeys = new Set<string>()

/** v2.4 无状态模式：内联 HTML 报告 → Blob 自动下载（服务器不保留文件，第一时间落到本机） */
function autoDownloadInlineReport(reportHtml: string, key: string, label: string) {
  if (autoDownloadedKeys.has(key)) return
  autoDownloadedKeys.add(key)
  try {
    const blob = new Blob([reportHtml], { type: 'text/html;charset=utf-8' })
    const blobUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = blobUrl
    a.download = `TargetEval_${label.replace(/[\\/:*?"<>|\s]+/g, '_')}_${new Date().toISOString().slice(0, 10)}.html`
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000)
    toast({
      title: 'HTML 报告已自动下载',
      description: `${label} — 已保存到本机下载目录（无状态部署服务器不保留文件，请及时查看）。若浏览器未弹出下载，请点击结果页的「下载 HTML」按钮。`,
    })
  } catch {
    autoDownloadedKeys.delete(key)
  }
}

/**
 * 作业 / 合并报告完成后自动把 HTML 报告下载到用户本机（v1.19）。
 *
 * 背景：公网部署（Z.ai space 等容器平台）空闲数小时后容器会被平台回收重建，
 * SQLite（db/custom.db）与磁盘报告（db/reports/）均为运行时数据、不随仓库保留
 * —— 在线评估结果因此「几小时就消失」（应用自身终态 TTL 为 30 天，丢失发生在
 * 平台容器层，应用无法阻止）。
 *
 * 对策：作业完成的第一时间把 HTML 报告落到本机：
 *  - fetch 先校验（报告未生成 / 已清理 → 404 静默跳过，不弹下载失败框）
 *  - Blob + <a download> 触发（沿用服务端 Content-Disposition 文件名）
 *  - 跨站 iframe（预览面板）可能拦截自动下载 → toast 引导手动按钮
 *  - 历史记录查看不经过触发点，不会误弹；失败时允许后续重试
 */
function autoDownloadHtmlReport(url: string, key: string, label: string) {
  if (autoDownloadedKeys.has(key)) return
  autoDownloadedKeys.add(key)
  void (async () => {
    try {
      const res = await fetch(url, { cache: 'no-store' })
      if (!res.ok) {
        // 报告未生成（关联批次的 deferred 单靶点无独立 HTML）或已被清理 → 跳过
        autoDownloadedKeys.delete(key)
        return
      }
      const blob = await res.blob()
      const blobUrl = URL.createObjectURL(blob)
      // 文件名：优先服务端 Content-Disposition，回退默认名
      let filename = 'TargetEval_Report.html'
      const cd = res.headers.get('content-disposition') ?? ''
      const m = /filename\*?=(?:UTF-8'')?"?([^";\n]+)/i.exec(cd)
      if (m && m[1]) {
        try { filename = decodeURIComponent(m[1].trim()) } catch { filename = m[1].trim() }
      }
      const a = document.createElement('a')
      a.href = blobUrl
      a.download = filename
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000)
      toast({
        title: 'HTML 报告已自动下载',
        description: `${label} — 已保存到本机下载目录（服务器端运行数据不长期保留，请及时查看）。若浏览器未弹出下载，请点击结果页的「下载 HTML」按钮。`,
      })
    } catch {
      autoDownloadedKeys.delete(key) // 失败允许重试
    }
  })()
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
  /** 上一次请求携带的 docx 原始序列（v1.10：关系判断归属 → 按靶点附构建序列） */
  const docxSequencesRef = useRef<string[] | null>(null)
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
      // v1.19：live 轮询到终态完成 → 自动下载 HTML 报告到本机
      // （历史查看路径不经过 pollOnce，不会误触发；deferred 作业 404 静默跳过）
      if (data.status === 'done') {
        autoDownloadHtmlReport(
          `/api/jobs/${id}/report?download=1`,
          `job:${id}`,
          data.uniprotId || '评估报告',
        )
      }
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

  /** 按 id 拉取作业详情并应用快照（批量完成后切换展示用）。
   * v1.9：切换失败改为非破坏性 —— 保留当前结果视图 + toast 提示
   * （旧实现直接退回输入态，用户会误以为“点击没有真正切换”）；成功后滚回页面顶部，
   * 让刊头/靶点徽标的变化立即可见（同蛋白家族场景下避免看不出切换）。
   * v2.4：会话本地记录优先（无状态部署：/api/jobs 在其他实例拿不到本会话数据） */
  const loadJobById = async (id: string, opts?: { switchView?: boolean }) => {
    try {
      const sess = getSessionJob(id)
      if (sess) {
        jobIdRef.current = id
        displayJobIdRef.current = id
        applyJobSnapshot(sess.job)
        if (opts?.switchView !== false && batchRef.current === null) {
          setBatch(prev => (prev && prev.items.length > 1 ? { ...prev, view: 'job' } : prev))
        }
        if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'auto' })
        return
      }
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
      if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'auto' })
    } catch {
      toast({
        title: '切换靶点失败',
        description: '无法加载该靶点的评估结果（网络波动或服务暂不可用），当前结果未受影响，请稍后重试',
        variant: 'destructive',
      })
    }
  }

  // ─── v2.4 无状态同步评估 ────────────────────────────────────────────────────

  /** 同步评估的取消句柄（abort fetch → 服务器同步中止管线） */
  const syncAbortRef = useRef<AbortController | null>(null)

  /**
   * 无状态模式单作业同步评估：单个流式请求内完成，进度事件直刷 UI。
   * 返回 { ok, job }；取消/失败返回 { ok:false, error }（取消静默处理）。
   */
  const runSyncJob = async (
    request: EvaluateRequest,
    opts: { isDisplay: boolean },
  ): Promise<{ ok: boolean; job?: JobDetail; reportHtml?: string | null; error?: string }> => {
    const ctrl = new AbortController()
    syncAbortRef.current = ctrl
    try {
      const { job, reportHtml } = await evaluateSyncStream(request, {
        signal: ctrl.signal,
        onProgress: (p) => {
          if (opts.isDisplay) setJob(p)
        },
      })
      const finalJob: JobDetail = { ...job, reportHtml: reportHtml ?? null, stateless: true }
      addSessionJob(finalJob, reportHtml)
      if (reportHtml) {
        autoDownloadInlineReport(
          reportHtml,
          `job:${finalJob.id}`,
          finalJob.uniprotId || finalJob.summary?.uniprot?.proteinName || '评估报告',
        )
      }
      return { ok: true, job: finalJob, reportHtml }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const aborted = ctrl.signal.aborted || /abort/i.test(msg)
      if (aborted) return { ok: false, error: '__canceled__' }
      return { ok: false, error: msg }
    } finally {
      if (syncAbortRef.current === ctrl) syncAbortRef.current = null
    }
  }

  /** 无状态模式：单个请求 → 同步流式评估直至终态 */
  const runSyncSingle = async (request: EvaluateRequest): Promise<void> => {
    setJob(null)
    setPhase('running')
    startedAtRef.current = Date.now()
    setElapsedSec(0)
    setNetworkIssue(false)
    startTick()
    const r = await runSyncJob(request, { isDisplay: true })
    if (r.ok && r.job) {
      clearTimers()
      jobIdRef.current = r.job.id
      displayJobIdRef.current = r.job.id
      applyJobSnapshot(r.job)
    } else if (r.error === '__canceled__') {
      clearTimers()
      jobIdRef.current = null
      setJob(null)
      setPhase('idle')
    } else {
      clearTimers()
      setSubmitError(r.error ?? '同步评估失败')
      setPhase('error')
    }
  }

  /** 无状态模式批量：关系判断（内联序列/目标提示）→ 逐靶点串行同步评估 → 各自独立报告 */
  const runSyncBatch = async (requests: EvaluateRequest[], opts?: { docxSequences?: string[] }): Promise<void> => {
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
    startTick()

    // ── ① 靶点关系判断（v2.4：内联携带评估表序列与目标提示）──
    const uploadId = (requests[0]?.docxJobId ?? requests[0]?.uploadId ?? '').trim() || undefined
    const uniprots = requests.map(r => (r.uniprotFromDocx ?? r.uniprot ?? '').trim().toUpperCase()).filter(Boolean)
    let judgment: RelationJudgment | null = null
    if (new Set(uniprots).size >= 2) {
      try {
        const seqs = (opts?.docxSequences ?? [])
          .map(s => ({ header: '', seq: s, length: s.replace(/[^A-Za-z]/g, '').length }))
          .filter(s => s.length >= 30)
          .slice(0, 8)
        const rel = await judgeTargetRelation({
          uploadId,
          uniprots,
          goal: requests[0]?.goal,
          sequences: seqs,
          goalHints: requests[0]?.evalTable?.goalHints,
        })
        judgment = rel.judgment
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

    // 无状态部署不支持合并报告（各靶点在不同实例完成，服务器无共享数据）→ 恒独立报告 + 批次说明
    const batchNote = judgment ? buildBatchNote(judgment, requests.length) : undefined
    const reqs: EvaluateRequest[] = requests.map(r => ({
      ...r,
      batchNote,
      options: { ...r.options, reportMode: 'single' },
    }))

    // ── ② 逐靶点串行同步评估（流式请求一个接一个，避免单实例并发超限）──
    for (let i = 0; i < reqs.length; i++) {
      if (batchCancelRef.current) break
      const label = requestLabel(reqs[i])
      const item: BatchItem = { key: `${i}-${label}`, label, status: 'running' }
      st.items = [...st.items, item]
      st.currentIndex = i
      setBatch(snapshot())

      const r = await runSyncJob(reqs[i], { isDisplay: true })
      if (batchCancelRef.current) {
        item.status = 'canceled'
        setBatch(snapshot())
        break
      }
      if (r.ok && r.job) {
        item.status = 'done'
        item.jobId = r.job.id
      } else if (r.error === '__canceled__') {
        item.status = 'canceled'
        setBatch(snapshot())
        break
      } else {
        item.status = 'error'
        item.error = r.error ?? '评估失败'
      }
      setBatch(snapshot())
    }

    clearTimers()
    const finished = st.items
    st.done = true
    setBatch(snapshot())
    batchRef.current = null
    jobIdRef.current = null

    if (batchCancelRef.current) {
      setBatch({ ...snapshot(), done: true })
      setPhase('idle')
      setJob(null)
      return
    }

    const okItems = finished.filter(x => x.status === 'done' && x.jobId)
    if (judgment?.related === true && okItems.length >= 2) {
      // 关联批次在无状态部署下无合并报告 — 明确提示（关系分析仍展示于批次条）
      st.mergedError = '无状态部署暂不支持合并报告：各靶点已分别生成独立报告（关系分析见批次条）'
      setBatch(snapshot())
    }
    if (okItems.length > 0) {
      const first = okItems[0]
      const sess = first.jobId ? getSessionJob(first.jobId) : undefined
      if (sess) {
        jobIdRef.current = sess.job.id
        displayJobIdRef.current = sess.job.id
        applyJobSnapshot(sess.job)
      } else {
        setBatch({ ...snapshot(), done: true })
        setPhase('idle')
        setJob(null)
      }
    } else {
      const failedCount = finished.filter(x => x.status === 'error').length
      setBatch({ ...snapshot(), done: true })
      setPhase('idle')
      setJob(null)
      setSubmitError(`批量评估未能完成（${failedCount} 个作业执行失败），请检查网络后重试`)
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
          // 作业已从服务端消失（外部取消/删除/TTL 清理）→ 终止等待并按取消处理
          // （否则 404 会被当作网络抖动无限重试，批量编排卡死）
          if (res.status === 404 || res.status === 410) {
            finish('canceled')
            return
          }
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

    // ── ① 靶点关系判断（含 v1.10 同源归并：系统序列比对 + 序列归属；失败降级为独立报告）──
    // v1.22：uploadId 可选 — UniProt/序列多输入模式无 uploadId 也能做关系判断
    const uploadId = (requests[0]?.docxJobId ?? requests[0]?.uploadId ?? '').trim() || undefined
    const uniprots = requests.map(r => (r.uniprotFromDocx ?? r.uniprot ?? '').trim().toUpperCase()).filter(Boolean)
    let judgment: RelationJudgment | null = null
    let attribution: SequenceAttribution[] | undefined
    if (new Set(uniprots).size >= 2) {
      try {
        const rel = await judgeTargetRelation({ uploadId, uniprots, goal: requests[0]?.goal })
        judgment = rel.judgment
        attribution = rel.sequenceAttribution
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
    st.sequenceAttribution = attribution
    setBatch(snapshot())

    const related = judgment?.related === true
    const batchNote = !related && judgment ? buildBatchNote(judgment, requests.length) : undefined
    // v1.10 按归属附构建序列：kind=construct 的序列 → 归属靶点的作业（服务端已验证
    // 同一靶点 ≥85%，不会再走「疑似不同靶点」告警分支）；无归属时回退用户手选序列
    const attachMap = new Map<string, string>()
    const docxSeqs = docxSequencesRef.current
    if (docxSeqs && attribution) {
      for (const a of attribution) {
        if (a.kind === 'construct' && a.uniprotId && a.index < docxSeqs.length && docxSeqs[a.index]) {
          if (!attachMap.has(a.uniprotId)) attachMap.set(a.uniprotId, docxSeqs[a.index])
        }
      }
    }
    // v1.11 ≥90% 高一致组：组内首个提交 BLAST 的作业成为家族代表统一检索，
    // 其余成员跳过（结果在合并报告阶段共享）— 用户反馈「≥90% 不必每个都搜」
    const blastGroups = judgment?.blastGroups ?? []
    // 关联 → deferred（数据收集后并入合并报告）；非关联 → 独立报告 + 批次说明
    const reqs: EvaluateRequest[] = requests.map(r => {
      const u = (r.uniprotFromDocx ?? r.uniprot ?? '').trim().toUpperCase()
      const attributedSeq = u ? attachMap.get(u) : undefined
      const group = u ? blastGroups.find(g => g.members.includes(u)) : undefined
      return {
        ...r,
        sequence: attributedSeq ?? r.sequence,
        sequenceFromDocx: attributedSeq ?? r.sequenceFromDocx,
        batchNote,
        homologBlast: group,
        options: { ...r.options, reportMode: related ? 'deferred' : 'single' },
      }
    })

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
      // v1.19：非关联批次 — 各靶点独立报告，完成即自动下载
      // （关联批次为 deferred 模式，单靶点无独立 HTML，最终下载合并报告）
      if (result === 'done' && !related) {
        autoDownloadHtmlReport(
          `/api/jobs/${created.jobId}/report?download=1`,
          `job:${created.jobId}`,
          label,
        )
      }
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

    // ── ③ 生成合并评估报告（v1.22：无论关联与否都生成 — 含关系分析 + 共有结构 + 对比矩阵）。
    // 关联批次：各靶点 deferred 模式（无独立报告），合并报告是唯一交付物。
    // 非关联批次：各靶点 single 模式（有独立报告），合并报告额外提供关系性 + 共有结构分析。
    if (okItems.length >= 2) {
      st.merging = true
      setBatch(snapshot())
      try {
        const merged = await generateBatchReport({
          jobIds: okItems.map(x => x.jobId as string),
          uploadId,
          relation: (judgment ?? fallbackIndependentJudgment()) as RelationJudgment,
          goal: requests[0]?.goal,
        })
        st.mergedReport = merged
        st.merging = false
        st.view = 'merged'
        setBatch(snapshot())
        // v1.19：合并报告（关联批次的最终交付物）完成即自动下载到本机
        autoDownloadHtmlReport(
          `/api/evaluate/batch-report?id=${encodeURIComponent(merged.id)}&download=1`,
          `batch:${merged.id}`,
          '合并评估报告',
        )
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

  /** 创建评估作业（单个 = 原有流程；多个 = v1.8 批量编排 + v1.10 同源归并；
   *  v2.4 无状态部署 → 同步流式评估（作业轮询在该环境不可用）） */
  const startEvaluation = async (
    requests: EvaluateRequest[],
    opts?: { docxSequences?: string[] },
  ): Promise<StartResult> => {
    const list = (requests ?? []).filter(Boolean)
    if (list.length === 0) return { ok: false, error: '未提供评估请求' }
    lastRequestsRef.current = list
    docxSequencesRef.current = opts?.docxSequences ?? null
    setSubmitting(true)
    setSubmitError(null)
    setBatch(null)
    batchCancelRef.current = false
    try {
      // v2.4：无状态环境 → 同步流式评估（服务器不保留作业/磁盘状态）
      if (isStatelessEnv()) {
        if (list.length === 1) {
          await runSyncSingle(list[0])
        } else {
          await runSyncBatch(list, opts)
        }
        return { ok: true }
      }
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

  /** 取消运行中的作业（批量模式：中止全部活跃作业并不再提交后续；
   *  v2.4 无状态模式：abort 同步评估流 → 服务器同步中止管线） */
  const cancelJob = useCallback(async () => {
    const ids = [...activeJobIdsRef.current]
    if (batchRef.current) batchCancelRef.current = true
    clearTimers()
    // v2.4：同步评估中的取消 — abort 流（服务器监听断开并中止管线）
    const syncCtrl = syncAbortRef.current
    if (syncCtrl) {
      setCanceling(true)
      try {
        syncCtrl.abort()
      } finally {
        setCanceling(false)
      }
    }
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
      if (id && !syncCtrl) {
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
    docxSequencesRef.current = null
  }, [clearTimers])

  /** 失败后重试（复用上一次请求参数） */
  const retry = useCallback(() => {
    const reqs = lastRequestsRef.current
    if (reqs && reqs.length) {
      void startEvaluation(reqs, { docxSequences: docxSequencesRef.current ?? undefined })
    } else {
      reset()
    }
  }, [reset, startEvaluation])

  /** 切换到合并报告视图（关联批次结果页） */
  const showMergedReport = useCallback(() => {
    setBatch(prev => (prev ? { ...prev, view: 'merged' } : prev))
  }, [])

  /** 从历史记录加载合并报告（v1.13：批量评估历史）
   *  拉取 BatchReport → 构造最小 batch 状态 → 切到 done + merged 视图 */
  const loadBatchReport = useCallback(
    async (id: string) => {
      setLoadingHistoryJob(true)
      setSubmitError(null)
      try {
        const report = await fetchBatchReport(id)
        // 各靶点标签：优先取 targets 中的 uniprot/蛋白名；降级用 jobIds 序号
        const labels = (report.targets ?? []).map(t => {
          const id = t.uniprotId || t.jobId?.slice(0, 6) || '?'
          return t.proteinName ? `${id} · ${t.proteinName}` : `靶点 ${id}`
        })
        while (labels.length < report.jobIds.length) {
          labels.push(`靶点 ${report.jobIds[labels.length]?.slice(0, 6) ?? '?'}`)
        }
        const items = report.jobIds.map((jid, i) => ({
          key: jid,
          label: labels[i] ?? jid.slice(0, 8),
          jobId: jid,
          status: 'done' as const,
        }))
        setBatch({
          total: items.length,
          currentIndex: items.length - 1,
          items,
          done: true,
          relation: report.relation,
          mergedReport: report,
          view: 'merged',
          sequenceAttribution: report.sequenceAttribution ?? undefined,
        })
        // 同步加载第一个靶点的详情作为 flow.job（ResultView 切换栏需要）
        if (report.jobIds.length > 0) {
          try {
            const res = await fetch(`/api/jobs/${report.jobIds[0]}`, { cache: 'no-store' })
            if (res.ok) {
              const data = (await res.json()) as JobDetail
              jobIdRef.current = data.id
              displayJobIdRef.current = data.id
              applyJobSnapshot(data)
            }
          } catch { /* 靶点详情加载失败不阻断合并报告展示 */ }
        }
        setPhase('done')
        if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'auto' })
      } catch {
        setSubmitError('无法加载该合并报告，可能已被清理或服务暂不可用')
      } finally {
        setLoadingHistoryJob(false)
      }
    },
    [applyJobSnapshot]
  )

  /** 从历史记录加载作业：done → 结果视图；running/pending → 进度视图
   *  v2.4：无状态部署优先读会话本地记录（服务器历史不可达） */
  const loadJob = useCallback(
    async (id: string) => {
      setLoadingHistoryJob(true)
      setSubmitError(null)
      try {
        const sess = getSessionJob(id)
        if (sess) {
          jobIdRef.current = id
          displayJobIdRef.current = id
          applyJobSnapshot(sess.job)
          return
        }
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
    loadBatchReport,
    showMergedReport,
    clearSubmitError,
  }
}
