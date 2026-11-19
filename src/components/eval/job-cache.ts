'use client'

/**
 * 作业详情的浏览器本地缓存层（v2.36）。
 *
 * 背景：公网部署平台为 Serverless 实例（阿里云函数计算）——实例空闲即回收，
 * 运行期写入的 SQLite 数据随容器一起丢弃。用户跑完的评估在实例回收后
 * 服务端 404（「日志不可用：作业已清理或服务暂不可用」）。
 *
 * 策略：作业到达终态（done/error）的瞬间，前端恰好持有一份完整的
 * GET /api/jobs/{id} 详情（轮询响应），把它缓存进 localStorage：
 *  - 之后无论实例是否回收，结果页 / 组日志 / 历史列表均可从本地副本回看
 *  - HTML 报告本就在完成时自动下载到用户本机（v1.19），与这层互补
 *  - LRU 淘汰 + 总量预算（localStorage 常见上限 5MB，预留 headroom）
 *
 * 注意：本层只做「回看兜底」，不参与任何写操作；服务端数据存在时永远
 * 以服务端为准（缓存副本仅在服务端 404 时启用）。
 */

import type { JobDetail, JobListItem } from './types'

const KEY = 'te_job_cache_v1'
/** 总字节预算（localStorage 上限通常 5MB，留 1.5MB 给其余 key） */
const MAX_TOTAL_BYTES = 3_500_000
/** 单条上限（超过说明该作业字段异常膨胀，不值得挤占其它作业的缓存位） */
const MAX_SINGLE_BYTES = 600_000

interface CacheEntry {
  /** 缓存时间（兼作列表 createdAt 展示与 LRU 淘汰依据） */
  cachedAt: number
  data: JobDetail
}

interface CacheStore {
  v: 1
  jobs: Record<string, CacheEntry>
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

/** 剥离不该进缓存的字段（fromCache 标记、无状态评估的即时 HTML 大负载） */
function sanitize(detail: JobDetail): JobDetail {
  const { fromCache: _fc, reportHtml: _rh, ...rest } = detail
  return rest as JobDetail
}

/** 缓存一份终态作业详情（仅 done/error；其它状态调用为空操作） */
export function cacheJobDetail(detail: JobDetail): void {
  if (typeof window === 'undefined') return
  if (detail.status !== 'done' && detail.status !== 'error') return
  try {
    const data = sanitize(detail)
    const entry: CacheEntry = { cachedAt: Date.now(), data }
    const store = readStore()
    store.jobs[detail.id] = entry
    // 超预算：从最旧开始淘汰（刚写入的这条若自己是巨无霸也会被跳过保护——先删别人）
    const sizeOf = () => JSON.stringify(store).length
    while (sizeOf() > MAX_TOTAL_BYTES) {
      const ids = Object.keys(store.jobs)
      if (ids.length <= 1) break
      let oldest: string | null = null
      let oldestT = Infinity
      for (const id of ids) {
        const t = store.jobs[id].cachedAt
        if (t < oldestT) {
          oldestT = t
          oldest = id
        }
      }
      if (!oldest) break
      delete store.jobs[oldest]
    }
    // 单条巨无霸兜底：仍超限且只剩自己 → 放弃本条（不清空既有缓存）
    if (sizeOf() > MAX_TOTAL_BYTES && Object.keys(store.jobs).length === 1 && store.jobs[detail.id]) {
      return
    }
    if (JSON.stringify(entry).length > MAX_SINGLE_BYTES && Object.keys(store.jobs).length === 1) {
      return
    }
    writeStore(store)
  } catch {
    /* 缓存失败不影响主流程 */
  }
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
