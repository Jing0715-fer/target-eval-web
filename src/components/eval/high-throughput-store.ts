'use client'

/**
 * 高通量评估运行的浏览器持久层（v2.22）。
 *
 *  - localStorage key：te_ht_runs_v1（与 te_llm_engine_v1 命名惯例对齐）
 *  - 保留最近 MAX_STORED_RUNS 份运行历史（用户要求「保留多个评估历史」）：
 *    每组产出的评估作业 / 合并报告本就持久化在服务端 DB（30 天 TTL），
 *    此层只保存「组 × 组」运行结构（组清单、每组作业 id、报告 id、暂停断点），
 *    页面刷新后据此恢复断点续跑或回看上次运行。
 *  - 合并报告 markdown 不入 localStorage（体积大）— 只存 mergedReportId，
 *    回看时经 /api/evaluate/batch-report?id= 按需拉取。
 */

import type { HTRunState } from './types'

const KEY = 'te_ht_runs_v1'
/** 保留的运行历史份数 */
const MAX_STORED_RUNS = 5

interface HTStore {
  runs: HTRunState[]
}

function readStore(): HTStore {
  if (typeof window === 'undefined') return { runs: [] }
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return { runs: [] }
    const data = JSON.parse(raw) as HTStore
    if (!data || !Array.isArray(data.runs)) return { runs: [] }
    return { runs: data.runs.filter((r) => r && r.id && Array.isArray(r.groups)) }
  } catch {
    return { runs: [] }
  }
}

function writeStore(store: HTStore): void {
  if (typeof window === 'undefined') return
  try {
    // 截断到最近 MAX_STORED_RUNS 份（最新在前）
    const runs = store.runs.slice(0, MAX_STORED_RUNS)
    window.localStorage.setItem(KEY, JSON.stringify({ runs }))
  } catch {
    // 配额满（罕见）：逐步丢弃最旧的再试一次
    try {
      const runs = store.runs.slice(0, 1)
      window.localStorage.setItem(KEY, JSON.stringify({ runs }))
    } catch {
      /* 放弃持久化（运行仍可在页面内继续，仅刷新后丢失） */
    }
  }
}

/** 列出运行历史（最新在前） */
export function listHTRuns(): HTRunState[] {
  return readStore().runs
}

export function getHTRun(id: string): HTRunState | null {
  return readStore().runs.find((r) => r.id === id) ?? null
}

/** upsert 一份运行（保持最新在前；超限截断） */
export function saveHTRun(run: HTRunState): void {
  const store = readStore()
  const rest = store.runs.filter((r) => r.id !== run.id)
  writeStore({ runs: [run, ...rest] })
}

export function deleteHTRun(id: string): void {
  const store = readStore()
  writeStore({ runs: store.runs.filter((r) => r.id !== id) })
}

/**
 * 页面挂载时调用：store 中遗留 status=running 的运行一定是页面刷新/关闭
 * 导致的前端编排中断（服务器侧作业可能仍在执行）— 标记为 interrupted，
 * 由用户决定是否从断点恢复（恢复时会接上仍在跑的作业继续等待终态）。
 * 返回被标记的运行（供 UI 提示），无则返回 null。
 */
export function markInterruptedOnLoad(): HTRunState | null {
  const store = readStore()
  const hit = store.runs.find((r) => r.status === 'running')
  if (!hit) return null
  hit.status = 'interrupted'
  writeStore(store)
  return hit
}
