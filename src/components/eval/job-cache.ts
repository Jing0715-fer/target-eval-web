'use client'

/**
 * 作业详情 / 合并报告的浏览器本地缓存层（v2.37）。
 *
 * 背景：公网部署平台为 Serverless 实例（阿里云函数计算）——实例空闲即回收，
 * 运行期写入的 SQLite 数据随容器一起丢弃。用户跑完的评估在实例回收后
 * 服务端 404（「日志不可用：作业已清理或服务暂不可用」）。
 *
 * 写入时机（v2.36 被动留档 + v2.37 主动补档）：
 *  1. 轮询到终态（done/error）的瞬间 — 前端恰好持有完整 GET /api/jobs/{id} 详情；
 *  2. 历史/结果页/组日志弹窗成功打开（cache-on-view，v2.37）；
 *  3. 合并报告生成完成 / 成功打开（v2.37，te_batch_report_cache_v1）；
 *  4. backfill 主动补档（v2.37）：打开历史运行时补齐该运行全部终态作业；
 *     页面挂载时（6h 节流）扫描本地 HT 运行 + 服务端历史列表，
 *     趁实例存活把浏览器尚无副本的终态数据静默留档 —— 覆盖
 *     「页面关闭期间服务器侧跑完、浏览器从未轮询到终态」的缺口。
 *
 * 读取策略：本层只做「回看兜底」，不参与任何写操作；服务端数据存在时永远
 * 以服务端为准（缓存副本仅在服务端 404/网络异常时启用）。
 *  - 结果页 / 组日志 / 历史列表均可从本地副本回看
 *  - HTML 报告本就在完成时自动下载到用户本机（v1.19），与这层互补
 *  - LRU 淘汰 + 总量预算（localStorage 常见上限 5MB，预留 headroom）
 */

import { listHTRuns } from './high-throughput-store'
import type { BatchReportInfo, BatchReportListItem, JobDetail, JobListItem } from './types'

const KEY = 'te_job_cache_v1'
/** 总字节预算（localStorage 上限通常 5MB，留 headroom 给其余 key） */
const MAX_TOTAL_BYTES = 3_500_000
/** 单条上限（超过说明该作业字段异常膨胀，不值得挤占其它作业的缓存位） */
const MAX_SINGLE_BYTES = 600_000

/** 合并报告缓存（v2.37）：独立 key + 独立预算（markdown 体积大） */
const BR_KEY = 'te_batch_report_cache_v1'
const BR_MAX_TOTAL_BYTES = 2_000_000
const BR_MAX_SINGLE_BYTES = 500_000

/** 挂载补缓存节流（localStorage 时间戳）：6 小时内不重复扫描 */
const BACKFILL_THROTTLE_KEY = 'te_cache_backfill_at'
const BACKFILL_THROTTLE_MS = 6 * 60 * 60 * 1000
/** 单次补缓存处理的条目数上限（控制请求量与 LRU 淘汰压力） */
const BACKFILL_MAX_ITEMS = 40
/** 补缓存并发（与每 IP 评估并发上限同量级，不干扰在跑评估） */
const BACKFILL_CONCURRENCY = 4

interface CacheEntry {
  /** 缓存时间（兼作列表 createdAt 展示与 LRU 淘汰依据） */
  cachedAt: number
  data: JobDetail
}

interface BatchReportEntry {
  cachedAt: number
  data: BatchReportInfo
}

interface CacheStore {
  v: 1
  jobs: Record<string, CacheEntry>
}

interface BatchReportStore {
  v: 1
  reports: Record<string, BatchReportEntry>
}

function readStore(): CacheStore {
  if (typeof window === 'undefined') return { v: 1, jobs: {} }
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return { v: 1, jobs: {} }
    const data = JSON.parse(raw) as CacheStore
    if (!data || data.v !== 1 || !data.jobs || typeof data.jobs !== 'object') {
      return { v: 1, jobs: {} }
    }
    // 过滤结构异常的条目
    const jobs: Record<string, CacheEntry> = {}
    for (const [id, e] of Object.entries(data.jobs)) {
      if (e && typeof e.cachedAt === 'number' && e.data && e.data.id === id) jobs[id] = e
    }
    return { v: 1, jobs }
  } catch {
    return { v: 1, jobs: {} }
  }
}

function writeStore(store: CacheStore): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(KEY, JSON.stringify(store))
  } catch {
    // 配额满：按 cachedAt 从旧到新淘汰后重试，直至放下或只剩一条
    const ids = Object.keys(store.jobs)
    for (let i = ids.length - 1; i >= 0; i--) {
      try {
        window.localStorage.setItem(KEY, JSON.stringify(store))
        return
      } catch {
        // 找最旧的删一条再试
        let oldest: string | null = null
        let oldestT = Infinity
        for (const id of Object.keys(store.jobs)) {
          const t = store.jobs[id].cachedAt
          if (t < oldestT) {
            oldestT = t
            oldest = id
          }
        }
        if (!oldest) return
        delete store.jobs[oldest]
      }
    }
  }
}

function readBrStore(): BatchReportStore {
  if (typeof window === 'undefined') return { v: 1, reports: {} }
  try {
    const raw = window.localStorage.getItem(BR_KEY)
    if (!raw) return { v: 1, reports: {} }
    const data = JSON.parse(raw) as BatchReportStore
    if (!data || data.v !== 1 || !data.reports || typeof data.reports !== 'object') {
      return { v: 1, reports: {} }
    }
    const reports: Record<string, BatchReportEntry> = {}
    for (const [id, e] of Object.entries(data.reports)) {
      if (e && typeof e.cachedAt === 'number' && e.data && e.data.id === id) reports[id] = e
    }
    return { v: 1, reports }
  } catch {
    return { v: 1, reports: {} }
  }
}

function writeBrStore(store: BatchReportStore): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(BR_KEY, JSON.stringify(store))
    return
  } catch {
    // 配额满：按 cachedAt 从旧到新淘汰重试
    for (;;) {
      try {
        window.localStorage.setItem(BR_KEY, JSON.stringify(store))
        return
      } catch {
        let oldest: string | null = null
        let oldestT = Infinity
        for (const id of Object.keys(store.reports)) {
          const t = store.reports[id].cachedAt
          if (t < oldestT) {
            oldestT = t
            oldest = id
          }
        }
        if (!oldest) return
        delete store.reports[oldest]
      }
    }
  }
}

/** 剥离不该进缓存的字段（fromCache 标记、无状态评估的即时 HTML 大负载） */
function sanitize(detail: JobDetail): JobDetail {
  const { fromCache: _fc, reportHtml: _rh, ...rest } = detail
  return rest as JobDetail
}

/** LRU：删除 store.jobs 中最旧的一条 */
function evictOldestJob(store: CacheStore): boolean {
  let oldest: string | null = null
  let oldestT = Infinity
  for (const id of Object.keys(store.jobs)) {
    const t = store.jobs[id].cachedAt
    if (t < oldestT) {
      oldestT = t
      oldest = id
    }
  }
  if (!oldest) return false
  delete store.jobs[oldest]
  return true
}

/**
 * 批量缓存终态作业详情：一次 read-modify-write（v2.37 重构 — 逐条写入时
 * 每条都要重复序列化整个 store，补缓存批量场景下是 O(n²) 的主线程开销）。
 * 内部完成预算控制与 LRU 淘汰；全部静默，绝不抛错。
 */
function cacheJobDetails(details: JobDetail[]): void {
  if (typeof window === 'undefined' || details.length === 0) return
  try {
    const store = readStore()
    const now = Date.now()
    let added = false
    for (const d of details) {
      if (!d || (d.status !== 'done' && d.status !== 'error')) continue
      const data = sanitize(d)
      if (JSON.stringify(data).length > MAX_SINGLE_BYTES) continue
      store.jobs[d.id] = { cachedAt: now, data }
      added = true
    }
    if (!added) return
    while (JSON.stringify(store).length > MAX_TOTAL_BYTES) {
      if (Object.keys(store.jobs).length <= 1) break
      if (!evictOldestJob(store)) break
    }
    // 巨无霸兜底：淘汰到只剩一条仍超限 → 放弃本次写入（不清空既有缓存）
    if (JSON.stringify(store).length > MAX_TOTAL_BYTES && Object.keys(store.jobs).length === 1) {
      return
    }
    writeStore(store)
  } catch {
    /* 缓存失败不影响主流程 */
  }
}

/** 缓存一份终态作业详情（仅 done/error；其它状态调用为空操作） */
export function cacheJobDetail(detail: JobDetail): void {
  cacheJobDetails([detail])
}

/** 读取缓存副本（命中时 data.fromCache = true，供结果页展示来源横幅） */
export function getCachedJobDetail(id: string): (JobDetail & { fromCache?: boolean }) | null {
  const e = readStore().jobs[id]
  if (!e) return null
  return { ...e.data, fromCache: true }
}

/** 缓存条目 → 历史列表行（服务端列表为空时的回退展示） */
export function listCachedJobs(): JobListItem[] {
  const store = readStore()
  return Object.values(store.jobs)
    .sort((a, b) => b.cachedAt - a.cachedAt)
    .map((e) => {
      const d = e.data
      const s = d.summary
      const nspSuffix = s?.uniprot?.nspLabel ? ` ${s.uniprot.nspLabel}` : ''
      return {
        id: d.id,
        status: d.status,
        title: d.goal || d.uniprotId || '本地缓存副本',
        uniprotId: d.uniprotId,
        proteinName: s?.uniprot?.proteinName ? s.uniprot.proteinName + nspSuffix : (d.uniprotId ?? null),
        createdAt: new Date(e.cachedAt).toISOString(),
        coverage: s?.coverage ?? null,
        pdbCount: s?.directPdbCount ?? null,
        overallScore: s?.scores?.overall?.score ?? null,
        fromCache: true as const,
      }
    })
}

/** 删除作业（服务端 DELETE 成功后）同步清掉本地缓存副本 */
export function removeCachedJob(id: string): void {
  if (typeof window === 'undefined') return
  try {
    const store = readStore()
    if (store.jobs[id]) {
      delete store.jobs[id]
      writeStore(store)
    }
  } catch {
    /* ignore */
  }
}

/** 服务端历史列表 + 本地缓存合并：缓存中服务端已不存在的条目（实例回收丢失）
 *  追加到列表尾部并标记 fromCache，点击后经 loadJob 的缓存回退路径打开 */
export function mergeJobListWithCache(serverList: JobListItem[]): JobListItem[] {
  if (typeof window === 'undefined') return serverList
  try {
    const serverIds = new Set(serverList.map((j) => j.id))
    const cachedOnly = listCachedJobs().filter((j) => !serverIds.has(j.id))
    if (cachedOnly.length === 0) return serverList
    return [...serverList, ...cachedOnly]
  } catch {
    return serverList
  }
}

// ─── 合并报告缓存（v2.37）────────────────────────────────────────

/** 缓存一份已生成的合并报告（status 非 done 或 markdown 为空则跳过） */
export function cacheBatchReport(info: BatchReportInfo): void {
  if (typeof window === 'undefined') return
  if (!info || info.status === 'running' || !info.markdown) return
  try {
    const data: BatchReportInfo = { ...info, status: 'done' }
    if (JSON.stringify(data).length > BR_MAX_SINGLE_BYTES) return
    const store = readBrStore()
    store.reports[data.id] = { cachedAt: Date.now(), data }
    while (JSON.stringify(store).length > BR_MAX_TOTAL_BYTES) {
      const ids = Object.keys(store.reports)
      if (ids.length <= 1) break
      let oldest: string | null = null
      let oldestT = Infinity
      for (const id of ids) {
        const t = store.reports[id].cachedAt
        if (t < oldestT) {
          oldestT = t
          oldest = id
        }
      }
      if (!oldest) break
      delete store.reports[oldest]
    }
    writeBrStore(store)
  } catch {
    /* ignore */
  }
}

/** 读取合并报告缓存副本（命中时 fromCache = true） */
export function getCachedBatchReport(id: string): (BatchReportInfo & { fromCache?: boolean }) | null {
  const e = readBrStore().reports[id]
  if (!e) return null
  return { ...e.data, fromCache: true }
}

/** 删除合并报告缓存副本（与作业删除对称） */
export function removeCachedBatchReport(id: string): void {
  if (typeof window === 'undefined') return
  try {
    const store = readBrStore()
    if (store.reports[id]) {
      delete store.reports[id]
      writeBrStore(store)
    }
  } catch {
    /* ignore */
  }
}

/** 服务端合并报告列表 + 本地缓存合并：缓存中服务端已不存在的报告（实例回收丢失）
 *  追加到列表尾部，点击后经 loadBatchReport 的缓存回退路径打开 */
export function mergeBatchListWithCache(serverList: BatchReportListItem[]): BatchReportListItem[] {
  if (typeof window === 'undefined') return serverList
  try {
    const serverIds = new Set(serverList.map((r) => r.id))
    const store = readBrStore()
    const cachedOnly = Object.values(store.reports)
      .sort((a, b) => b.cachedAt - a.cachedAt)
      .filter((e) => !serverIds.has(e.data.id))
      .map((e) => ({
        id: e.data.id,
        jobIds: e.data.jobIds,
        title: e.data.title?.trim() || `多靶点合并报告（${e.data.jobIds.length} 靶点）`,
        status: 'done' as const,
        hasContent: true,
        createdAt: e.data.createdAt ?? new Date(e.cachedAt).toISOString(),
      }))
    if (cachedOnly.length === 0) return serverList
    return [...serverList, ...cachedOnly]
  } catch {
    return serverList
  }
}

// ─── 主动补档（v2.37）────────────────────────────────────────────

/** 受限并发地执行异步任务（补缓存专用 — 逐个 await 慢，全并发又冲击服务端） */
async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let idx = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const item = items[idx++]
      try {
        await worker(item)
      } catch {
        /* 单条失败静默跳过 */
      }
    }
  })
  await Promise.all(runners)
}

/**
 * 批量补缓存作业详情：跳过本地已有副本的 id，拉取服务端终态详情并留档。
 * 返回新缓存的条数（供调用方决定是否提示）。全部静默失败，绝不抛错。
 */
export async function backfillJobCache(jobIds: string[]): Promise<number> {
  if (typeof window === 'undefined' || jobIds.length === 0) return 0
  const existing = readStore().jobs
  const pending = [...new Set(jobIds)].filter((id) => !existing[id]).slice(0, BACKFILL_MAX_ITEMS)
  if (pending.length === 0) return 0
  let cached = 0
  const batch: JobDetail[] = []
  await runWithConcurrency(pending, BACKFILL_CONCURRENCY, async (id) => {
    const res = await fetch(`/api/jobs/${id}`, { cache: 'no-store' })
    if (!res.ok) return
    const data = (await res.json()) as JobDetail
    if (data && data.id === id && (data.status === 'done' || data.status === 'error')) {
      batch.push(data)
    }
  })
  if (batch.length > 0) {
    cached = batch.length
    cacheJobDetails(batch)
  }
  return cached
}

/** 批量补缓存合并报告（同 backfillJobCache 语义） */
export async function backfillBatchReportCache(ids: string[]): Promise<number> {
  if (typeof window === 'undefined' || ids.length === 0) return 0
  const existing = readBrStore().reports
  const pending = [...new Set(ids)].filter((id) => !existing[id]).slice(0, BACKFILL_MAX_ITEMS)
  if (pending.length === 0) return 0
  let cached = 0
  await runWithConcurrency(pending, BACKFILL_CONCURRENCY, async (id) => {
    const res = await fetch(`/api/evaluate/batch-report?id=${encodeURIComponent(id)}`, { cache: 'no-store' })
    if (!res.ok) return
    const data = (await res.json().catch(() => null)) as { ok?: boolean; batchReport?: BatchReportInfo } | null
    if (data?.ok && data.batchReport?.id === id) {
      cacheBatchReport(data.batchReport)
      cached++
    }
  })
  return cached
}

/** 本地 HT 运行中已终态靶点的作业 id + 各组合并报告 id（补缓存的输入源之一） */
function collectHTRunIds(): { jobIds: string[]; reportIds: string[] } {
  const jobIds = new Set<string>()
  const reportIds = new Set<string>()
  try {
    for (const run of listHTRuns()) {
      for (const g of run.groups) {
        for (const it of g.items) {
          if ((it.status === 'done' || it.status === 'error') && it.jobId) jobIds.add(it.jobId)
        }
        if (g.mergedReportId) reportIds.add(g.mergedReportId)
      }
    }
  } catch {
    /* ignore */
  }
  return { jobIds: [...jobIds], reportIds: [...reportIds] }
}

/**
 * 页面挂载时的节流补缓存（6h 一次）：扫描本地 HT 运行 + 服务端历史列表，
 * 趁实例存活把浏览器尚无副本的终态数据静默留档。
 * 覆盖场景：页面关闭期间服务器侧跑完的作业（浏览器从未轮询到终态）、
 * v2.36 之前完成的旧作业、换浏览器后的历史回看保护。
 */
export async function backfillCacheOnMount(): Promise<void> {
  if (typeof window === 'undefined') return
  try {
    const last = Number(window.localStorage.getItem(BACKFILL_THROTTLE_KEY) ?? '0')
    if (Number.isFinite(last) && last > 0 && Date.now() - last < BACKFILL_THROTTLE_MS) return
  } catch {
    return
  }
  const { jobIds, reportIds } = collectHTRunIds()
  // 服务端历史列表（不可达/无状态部署 → 静默跳过，仅用本地 HT 运行源）
  try {
    const res = await fetch('/api/jobs', { cache: 'no-store' })
    if (res.ok) {
      const list = (await res.json()) as Array<{ id?: string; status?: string }>
      for (const j of Array.isArray(list) ? list : []) {
        if (j?.id && (j.status === 'done' || j.status === 'error')) jobIds.push(j.id)
      }
    }
  } catch {
    /* ignore */
  }
  try {
    const res = await fetch('/api/evaluate/batch-report', { cache: 'no-store' })
    if (res.ok) {
      const data = (await res.json().catch(() => null)) as { items?: Array<{ id?: string; status?: string }> } | null
      for (const it of data?.items ?? []) {
        if (it?.id && it.status === 'done') reportIds.push(it.id)
      }
    }
  } catch {
    /* ignore */
  }
  // 不等全部完成也先落节流戳（避免服务端半途回收导致每次挂载都重扫）；
  // 6h 后的新数据由下一次访问补上
  try {
    window.localStorage.setItem(BACKFILL_THROTTLE_KEY, String(Date.now()))
  } catch {
    /* ignore */
  }
  await Promise.allSettled([backfillJobCache(jobIds), backfillBatchReportCache(reportIds)])
}
