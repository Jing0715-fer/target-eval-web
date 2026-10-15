/**
 * 作业管理器 — 4GB 内存沙箱防 OOM 设计：
 *  - 评估作业全局串行执行（promise chain 队列），任意时刻最多 1 个在跑
 *  - 内存注册表 LRU ≤ 20：终态作业超限即逐出（历史从 DB 重建）
 *  - 运行中作业持有 AbortController，支持取消
 *  - 进度/日志回调写入内存（日志环缓冲 60 条），终态持久化到 SQLite
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

const g = globalThis as unknown as {
  __evalJobs?: Map<string, JobSnapshot>
  __evalQueue?: Promise<void>
}

const jobs: Map<string, JobSnapshot> = (g.__evalJobs ??= new Map())
let queue: Promise<void> = (g.__evalQueue ??= Promise.resolve())

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
}

export function setJobRunning(id: string): void {
  const snap = jobs.get(id)
  if (snap) {
    snap.status = 'running'
    snap.startedAt = Date.now()
  }
}

/** 串行执行：任意时刻最多一个作业在跑 */
export function enqueueJob(task: () => Promise<void>): void {
  queue = queue.then(task).catch(() => { /* 作业自身处理错误 */ })
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

/** 服务器重启后遗留的 running 作业 → 标记为中断错误（懒修复） */
export async function reapOrphanJobs(): Promise<void> {
  try {
    const orphans = await db.evaluationJob.findMany({
      where: { status: { in: ['pending', 'running'] } },
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
