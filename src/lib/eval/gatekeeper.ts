/**
 * 并发与配额守卫 — 公网多用户防 OOM / 防滥用。
 *
 * 内存红线（4GB 沙箱，dev 脚本已限 --max-old-space-size=1400）：
 *  - 评估作业全局串行执行（job-manager 队列），本层再加「排队上限」：
 *    全局 pending > MAX_GLOBAL_PENDING → 429 拒绝（防队列无限堆积）
 *  - 每 IP 活跃（pending+running）≤ MAX_ACTIVE_PER_IP → 429
 *  - 每 IP 24h 创建作业 / 上传文档滑动窗口配额 → 429
 *  - docx 解析（mammoth + sharp + VLM）全局并发 ≤ PARSE_CONCURRENCY，
 *    等待队列也设上限 → 429（解析持有 20MB 缓冲 + 图片中间态，是内存峰值主源）
 *  - 终态作业 TTL 清理（≤ 每小时一次）：done/error/canceled 超过 JOB_TTL_DAYS
 *    的记录连同磁盘报告目录一并删除，防 SQLite / db/reports 无限膨胀
 *
 * 计数来源：作业配额查 DB（权威、重启安全）；上传配额与解析信号量在内存
 * （globalThis 挂载，HMR / 多 worker 间共享同一实例时成立）。
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { db } from '@/lib/db'

// ─── 配额常量（公网默认档；可通过环境变量覆盖） ────────────────────────────────
export const MAX_GLOBAL_PENDING = num(process.env.EVAL_MAX_QUEUE, 8)
export const MAX_ACTIVE_PER_IP = num(process.env.EVAL_MAX_ACTIVE_PER_IP, 2)
export const MAX_JOBS_PER_DAY = num(process.env.EVAL_MAX_JOBS_PER_DAY, 30)
export const MAX_UPLOADS_PER_DAY = num(process.env.EVAL_MAX_UPLOADS_PER_DAY, 20)
/** docx 解析全局并发（mammoth/sharp/VLM 内存重负载） */
export const PARSE_CONCURRENCY = num(process.env.EVAL_PARSE_CONCURRENCY, 2)
/** 解析等待队列上限（并发满且排队 ≥ 此值 → 直接 429） */
export const PARSE_WAIT_LIMIT = num(process.env.EVAL_PARSE_WAIT_LIMIT, 4)
/** 终态作业保留天数 */
export const JOB_TTL_DAYS = num(process.env.EVAL_JOB_TTL_DAYS, 7)
/** 清理最小间隔（ms） */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000

function num(v: string | undefined, dflt: number): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt
}

export class QuotaError extends Error {
  readonly status = 429
  readonly retryAfterSec: number
  constructor(message: string, retryAfterSec = 60) {
    super(message)
    this.retryAfterSec = retryAfterSec
  }
}

/** 429 JSON 响应（带 Retry-After） */
export function quotaResponse(e: QuotaError): Response {
  return Response.json(
    { ok: false, error: e.message, retryAfter: e.retryAfterSec },
    { status: 429, headers: { 'Retry-After': String(e.retryAfterSec) } },
  )
}

// ─── 作业配额（DB 权威计数） ───────────────────────────────────────────────────

export interface JobQuotaCheck {
  ok: boolean
  error?: QuotaError
}

/** 创建评估作业前的配额检查：全局排队上限 + 每 IP 活跃上限 + 每 IP 日配额 */
export async function checkJobQuota(ownerKey: string): Promise<JobQuotaCheck> {
  const now = new Date()
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)

  const [globalPending, activeMine, mineToday] = await Promise.all([
    db.evaluationJob.count({ where: { status: 'pending' } }),
    db.evaluationJob.count({ where: { ownerKey, status: { in: ['pending', 'running'] } } }),
    db.evaluationJob.count({ where: { ownerKey, createdAt: { gte: dayAgo } } }),
  ])

  if (globalPending >= MAX_GLOBAL_PENDING) {
    return {
      ok: false,
      error: new QuotaError(
        `当前排队评估较多（${globalPending} 个等待中，上限 ${MAX_GLOBAL_PENDING}），服务器繁忙，请稍后再试`,
        120,
      ),
    }
  }
  if (activeMine >= MAX_ACTIVE_PER_IP) {
    return {
      ok: false,
      error: new QuotaError(
        `你已有 ${activeMine} 个评估正在进行或排队（同时最多 ${MAX_ACTIVE_PER_IP} 个），请等待完成后再发起新评估`,
        60,
      ),
    }
  }
  if (mineToday >= MAX_JOBS_PER_DAY) {
    return {
      ok: false,
      error: new QuotaError(
        `近 24 小时内已创建 ${mineToday} 次评估（每日上限 ${MAX_JOBS_PER_DAY} 次），请明日再试`,
        3600,
      ),
    }
  }
  return { ok: true }
}

// ─── 上传滑动窗口（内存） ─────────────────────────────────────────────────────

const g = globalThis as unknown as {
  __evalUploadWindow?: Map<string, number[]>
  __evalParseSem?: { active: number; waiting: number }
  __evalLastCleanup?: number
}

const uploadWindow: Map<string, number[]> = (g.__evalUploadWindow ??= new Map())

/** 记录一次上传并检查 24h 配额（滑动窗口） */
export function checkAndCountUpload(ownerKey: string): void {
  const now = Date.now()
  const dayAgo = now - 24 * 60 * 60 * 1000
  const list = (uploadWindow.get(ownerKey) ?? []).filter(t => t > dayAgo)
  if (list.length >= MAX_UPLOADS_PER_DAY) {
    // 仍需回写修剪后的列表（过期项清理）
    uploadWindow.set(ownerKey, list)
    throw new QuotaError(
      `近 24 小时内已上传 ${list.length} 份文档（每日上限 ${MAX_UPLOADS_PER_DAY} 份），请明日再试`,
      3600,
    )
  }
  list.push(now)
  uploadWindow.set(ownerKey, list)
  // 顺带修剪整个表（防长期运行内存增长；Map 有界：每 IP 一行）
  if (uploadWindow.size > 5000) {
    for (const [k, v] of uploadWindow) {
      const kept = v.filter(t => t > dayAgo)
      if (kept.length === 0) uploadWindow.delete(k)
      else uploadWindow.set(k, kept)
    }
  }
}

// ─── docx 解析信号量（全局并发 + 等待上限） ────────────────────────────────────

const parseSem = (g.__evalParseSem ??= { active: 0, waiting: 0 })

/** 等待者队列（挂在信号量对象上，HMR 安全） */
const parseWaiters = (() => {
  const sem = parseSem as unknown as { __waiters?: Array<() => void> }
  return (sem.__waiters ??= [])
})()

/** 当前解析并发占用（供状态接口展示） */
export function parseLoad(): { active: number; waiting: number } {
  return { active: parseSem.active, waiting: parseSem.waiting }
}

/**
 * 在解析槽内执行任务：并发满则排队等待；
 * 等待数超限立即 429。保证 mammoth/sharp/VLM 重负载有界。
 */
export async function withParseSlot<T>(task: () => Promise<T>): Promise<T> {
  const release = await acquireParseSlot(PARSE_WAIT_LIMIT)
  try {
    return await task()
  } finally {
    release()
  }
}

/**
 * 后台解析变体：与直传路由共享同一信号量（总并发恒 ≤ PARSE_CONCURRENCY），
 * 但等待不设上限（无 429）—— 用于分块上传的异步解析队列，
 * 由会话过期/墙钟超时兜底，保证不会无限堆积任务。
 */
export async function withParseSlotBg<T>(task: () => Promise<T>): Promise<T> {
  const release = await acquireParseSlot(null)
  try {
    return await task()
  } finally {
    release()
  }
}

/** 获取解析槽位；waitLimit=null 表示无上限等待（后台），否则等待数超限抛 429 */
async function acquireParseSlot(waitLimit: number | null): Promise<() => void> {
  if (parseSem.active >= PARSE_CONCURRENCY && waitLimit !== null && parseSem.waiting >= waitLimit) {
    throw new QuotaError(
      `文档解析繁忙（${parseSem.active} 个进行中、${parseSem.waiting} 个排队），请稍后重试`,
      90,
    )
  }
  await new Promise<void>((resolve) => {
    if (parseSem.active < PARSE_CONCURRENCY) {
      parseSem.active++
      resolve()
    } else {
      parseSem.waiting++
      parseWaiters.push(() => {
        parseSem.waiting--
        parseSem.active++
        resolve()
      })
    }
  })
  const release = () => {
    parseSem.active = Math.max(0, parseSem.active - 1)
    const next = parseWaiters.shift()
    if (next) next()
  }
  return release
}

// ─── 终态作业 TTL 清理 ─────────────────────────────────────────────────────────

/**
 * 惰性清理：删除超过 TTL 的终态作业（DB 行 + db/reports/{jobId} 目录）。
 * 每小时最多执行一次（globalThis 时间戳闸门）；单次最多删 80 条防长尾。
 * fire-and-forget：调用方不 await、失败静默。
 */
export function scheduleJobTtlCleanup(): void {
  void (async () => {
    const last = g.__evalLastCleanup ?? 0
    if (Date.now() - last < CLEANUP_INTERVAL_MS) return
    g.__evalLastCleanup = Date.now()
    try {
      const cutoff = new Date(Date.now() - JOB_TTL_DAYS * 24 * 60 * 60 * 1000)
      const stale = await db.evaluationJob.findMany({
        where: { status: { in: ['done', 'error', 'canceled'] }, updatedAt: { lt: cutoff } },
        select: { id: true },
        take: 80,
      })
      for (const j of stale) {
        try {
          await fs.rm(path.join(process.cwd(), 'db', 'reports', j.id), { recursive: true, force: true })
        } catch { /* 磁盘清理失败不阻塞 */ }
        await db.evaluationJob.delete({ where: { id: j.id } }).catch(() => undefined)
      }
    } catch { /* DB 不可用时忽略 */ }
  })()
}
