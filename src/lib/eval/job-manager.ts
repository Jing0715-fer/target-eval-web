/**
 * 作业管理器 — 4GB 内存沙箱防 OOM 设计：
 *  - 评估作业小并发池执行（默认 6，EVAL_JOB_CONCURRENCY 可调，上限 8）：
 *    评估管线为 I/O 密集（外部 API 检索 + LLM 调用 + BLAST 轮询 sleep），
 *    BLAST 等待期不占内存 — 多并发可让「部分靶点等慢 BLAST 期间其余靶点
 *    先做数据检索/报告生成」（v2.39：2 → 6 — 用户诉求「轮询期间可以先进行
 *    其他评估，先把 BLAST 都提交起来」）；内存峰值（docx 解析 mammoth/sharp/
 *    VLM）仍由 gatekeeper 独立信号量约束（≤2），不受本池影响
 *  - 内存注册表 LRU ≤ 20：终态作业超限即逐出（历史从 DB 重建）
 *  - 运行中作业持有 AbortController，支持取消
 *  - 进度/日志回调写入内存（日志环缓冲 60 条），终态持久化到 SQLite
 *  - v2.39：hasOtherActiveJobs — 全场活跃作业探测（BLAST 软僵尸保险
 *    「等全场收尾」的判定依据，见 blast.ts）
 *  - v2.40：同靶点指纹去重（dedup-attach）— 同一归属对完全相同的评估输入
 *    重复提交时（断点恢复重提 / 响应丢失重试 / 恢复运行与遗留作业撞车），
 *    直接接上仍在执行的既有作业：不新建、不占并发配额（内存注册表即权威，
 *    进程重启后自然清空 — 重启后作业本就全部夭折，无误接风险）
 */
import { db } from '@/lib/db'
import { STAGE_DEFS, STAGE_RANGES, type JobProgress, type JobStatus, type StageInfo } from './types'

export interface JobSnapshot {
  id: string
  status: JobStatus
  logs: string[]
  progress: JobProgress
  abort: AbortController
  createdAt: number
  startedAt?: number
}

const MAX_MEMORY_JOBS = 20
/** 评估作业并发数（v2.39：默认 2 → 6 — BLAST 轮询等待期推进其余靶点，
 *  docx/VLM 重负载仍由 gatekeeper 解析信号量独立限流） */
function jobConcurrency(): number {
  const n = Number(process.env.EVAL_JOB_CONCURRENCY)
  return Number.isFinite(n) && n >= 1 ? Math.min(8, Math.floor(n)) : 6
}

const g = globalThis as unknown as {
  __evalJobs?: Map<string, JobSnapshot>
  __evalQueueState?: { active: number; pending: Array<() => Promise<void>> }
  /** v2.40：「归属键|评估指纹」→ 活跃作业 id（终态时淘汰） */
  __evalDedup?: Map<string, string>
}

const jobs: Map<string, JobSnapshot> = (g.__evalJobs ??= new Map())
/** 并发池调度状态（HMR / 多次导入间共享同一实例） */
const pool: { active: number; pending: Array<() => Promise<void>> } = (g.__evalQueueState ??= { active: 0, pending: [] })
/** v2.40 同靶点去重注册表（内存态，随进程存亡） */
const dedup: Map<string, string> = (g.__evalDedup ??= new Map())

function nowTime(): string {
  return new Date().toTimeString().slice(0, 8)
}

export function createJobSnapshot(id: string): JobSnapshot {
  const snap: JobSnapshot = {
    id,
    status: 'pending',
    logs: [],
    progress: buildProgress(null),
    abort: new AbortController(),
    createdAt: Date.now(),
  }
  jobs.set(id, snap)
  evictStale()
  return snap
}

function evictStale(): void {
  // 只逐出终态作业；超过 MAX_MEMORY_JOBS 时丢最旧的终态
  const terminal = [...jobs.values()].filter(j => j.status !== 'running' && j.status !== 'pending')
  if (jobs.size - terminal.length >= MAX_MEMORY_JOBS) return // 运行/排队中的太多，不处理
  const excess = jobs.size - MAX_MEMORY_JOBS
  if (excess <= 0) return
  const victims = terminal
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, excess)
  for (const v of victims) jobs.delete(v.id)
}

export function getJobSnapshot(id: string): JobSnapshot | undefined {
  return jobs.get(id)
}

export function markStatus(id: string, status: JobStatus): void {
  const snap = jobs.get(id)
  if (snap) snap.status = status
  // v2.40：终态时淘汰去重注册表中指向本作业的条目（可被同靶点重新提交）
  if (status === 'done' || status === 'error' || status === 'canceled') {
    for (const [k, v] of dedup) {
      if (v === id) dedup.delete(k)
    }
  }
}

export function setJobRunning(id: string): void {
  const snap = jobs.get(id)
  if (snap) {
    snap.status = 'running'
    snap.startedAt = Date.now()
  }
}

/**
 * 小并发池执行（v2.39 默认同时 6 个）：
 * BLAST 轮询是纯等待（sleep + 单请求），其余作业利用该空隙做数据检索/报告，
 * 批量评估总时长显著缩短且内存峰值不变（重负载由解析信号量另限）。
 */
export function enqueueJob(task: () => Promise<void>): void {
  pool.pending.push(task)
  schedulePool()
}

function schedulePool(): void {
  const max = jobConcurrency()
  while (pool.active < max && pool.pending.length > 0) {
    const task = pool.pending.shift()
    if (!task) break
    pool.active++
    void task()
      .catch(() => { /* 作业自身处理错误 */ })
      .finally(() => {
        pool.active--
        schedulePool()
      })
  }
}

// ─── v2.40 同靶点去重（dedup-attach）──────────────────────────────────

/** 记录「归属 × 评估指纹 → 活跃作业」（作业创建时调用）。
 *  注册表有界：超过 200 条时先淘汰已终态/已逐出的陈旧条目。 */
export function rememberDedup(ownerKey: string, fp: string, jobId: string): void {
  if (dedup.size > 200) {
    for (const [k, id] of dedup) {
      const snap = jobs.get(id)
      if (!snap || (snap.status !== 'pending' && snap.status !== 'running')) dedup.delete(k)
    }
  }
  dedup.set(`${ownerKey}|${fp}`, jobId)
}

/** 查找同归属同指纹且仍在执行的作业 — 命中则接上（不新建不占配额）。
 *  以内存注册表为权威：条目指向的作业已终态/被逐出/不存在 → 淘汰并返回 undefined。 */
export function findActiveByFingerprint(ownerKey: string, fp: string): string | undefined {
  const key = `${ownerKey}|${fp}`
  const id = dedup.get(key)
  if (!id) return undefined
  const snap = jobs.get(id)
  if (snap && (snap.status === 'pending' || snap.status === 'running')) return id
  dedup.delete(key)
  return undefined
}

/**
 * v2.39：全场还有其他活跃（pending/running）作业吗（不含 excludeId）—
 * BLAST 软僵尸保险「等全场收尾」的判定依据：
 *  - 只要还有别的作业在排队/执行，慢 BLAST 就继续轮询不判超时；
 *  - 本作业已是全场最后一个时，才进入终局等待窗口（见 blast.ts）。
 * 内存注册表即权威视图（enqueue 前已建快照；终态即逐出/标态）。
 */
export function hasOtherActiveJobs(excludeId?: string): boolean {
  for (const j of jobs.values()) {
    if (excludeId && j.id === excludeId) continue
    if (j.status === 'pending' || j.status === 'running') return true
  }
  return pool.pending.length > 0
}

// ─── 进度与日志 ───────────────────────────────────────────────────────────────

export function buildProgress(activeKey: string | null, message = '', subPercent = 0): JobProgress {
  const stages: StageInfo[] = STAGE_DEFS.map(s => ({ key: s.key, label: s.label, state: 'pending', percent: 0 }))
  if (!activeKey) return { stage: '', percent: 0, message: '', stages }
  const idx = STAGE_DEFS.findIndex(s => s.key === activeKey)
  if (idx < 0) return { stage: activeKey, percent: 0, message, stages }
  for (let i = 0; i < stages.length; i++) {
    if (i < idx) {
      stages[i].state = 'done'
      const [, end] = STAGE_RANGES[stages[i].key]
      stages[i].percent = end
    } else if (i === idx) {
      stages[i].state = 'active'
      const [start, end] = STAGE_RANGES[stages[i].key]
      stages[i].percent = Math.round(start + (end - start) * Math.min(1, Math.max(0, subPercent)))
    }
  }
  const active = stages[idx]
  return {
    stage: activeKey,
    percent: active.percent,
    message,
    stages,
  }
}

export interface ProgressReporter {
  (stageKey: string, message: string, subPercent?: number): void
}

export function makeReporter(id: string): { report: ProgressReporter; log: (msg: string, level?: 'info' | 'warn' | 'error') => void } {
  const report: ProgressReporter = (stageKey, message, subPercent = 0) => {
    const snap = jobs.get(id)
    if (!snap) return
    snap.progress = buildProgress(stageKey, message, subPercent)
  }
  const log = (msg: string, level: 'info' | 'warn' | 'error' = 'info') => {
    const snap = jobs.get(id)
    if (!snap) return
    const prefix = level === 'warn' ? '[警告] ' : level === 'error' ? '[错误] ' : ''
    snap.logs.push(`${nowTime()} ${prefix}${msg}`)
    if (snap.logs.length > 60) snap.logs.splice(0, snap.logs.length - 60)
    // 同步镜像到进度 message（前端轮询展示）
    if (snap.progress && level !== 'info') {
      snap.progress = { ...snap.progress, message: `${prefix}${msg}` }
    }
  }
  return { report, log }
}

/** 全部阶段完成态进度 */
export function doneProgress(): JobProgress {
  const stages: StageInfo[] = STAGE_DEFS.map(s => ({
    key: s.key,
    label: s.label,
    state: 'done' as const,
    percent: STAGE_RANGES[s.key][1],
  }))
  return { stage: 'done', percent: 100, message: '评估完成', stages }
}

/**
 * 服务器重启后遗留的 running 作业 → 标记为中断错误（懒修复）。
 * v2.18.1：①由 /api/jobs 扩展到 /api/evaluate 发起前调用（孤儿 pending 不再
 * 虚增排队计数堵死新评估）；②加 60s 宽限期 — DB create 与 createJobSnapshot
 * 之间有毫秒级窗口，并发请求的清理不得误杀刚创建的作业（事故死行均为分钟级
 * 以上，宽限期不影响其回收）。
 */
const REAP_GRACE_MS = 60 * 1000

export async function reapOrphanJobs(): Promise<void> {
  try {
    const graceCutoff = new Date(Date.now() - REAP_GRACE_MS)
    const orphans = await db.evaluationJob.findMany({
      where: { status: { in: ['pending', 'running'] }, updatedAt: { lt: graceCutoff } },
      select: { id: true },
    })
    for (const o of orphans) {
      if (!jobs.has(o.id)) {
        await db.evaluationJob.update({
          where: { id: o.id },
          data: { status: 'error', error: '服务器重启导致作业中断，请重新发起评估', updatedAt: new Date() },
        })
      }
    }
  } catch { /* DB 不可用时忽略 */ }
}
