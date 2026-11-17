/**
 * v2.4 无状态部署的会话本地历史。
 *
 * 函数计算等无状态环境中 SQLite/磁盘不跨请求保留，服务端历史（GET /api/jobs）
 * 拿不到本浏览器刚完成的评估。此模块把同步评估的完成作业保存在页面内存中
 * （不落盘、刷新即失），历史面板与「最近评估」侧栏在无状态模式下优先展示。
 *
 * 同时保存内联 HTML 报告（reportHtml），供结果页切换查看与下载（Blob）。
 */
'use client'

import type { JobDetail, JobListItem } from './types'

export interface SessionJob {
  job: JobDetail
  /** 内联 HTML 报告（同步评估 done 事件携带；可能为 null） */
  reportHtml: string | null
  /** 记录时间 */
  at: number
}

const MAX_SESSION_JOBS = 12

const g: { jobs?: SessionJob[] } = {}

function list(): SessionJob[] {
  g.jobs ??= []
  return g.jobs
}

/** 记录一个已完成的同步评估作业（去重按 job.id） */
export function addSessionJob(job: JobDetail, reportHtml: string | null): void {
  const jobs = list()
  const idx = jobs.findIndex(j => j.job.id === job.id)
  if (idx >= 0) jobs.splice(idx, 1)
  jobs.unshift({ job, reportHtml, at: Date.now() })
  if (jobs.length > MAX_SESSION_JOBS) jobs.length = MAX_SESSION_JOBS
}

export function getSessionJobs(): SessionJob[] {
  return list()
}

export function getSessionJob(id: string): SessionJob | undefined {
  return list().find(j => j.job.id === id)
}

export function removeSessionJob(id: string): void {
  const jobs = list()
  const idx = jobs.findIndex(j => j.job.id === id)
  if (idx >= 0) jobs.splice(idx, 1)
}

/** 会话作业 → 历史列表项（与 GET /api/jobs 响应同构） */
export function sessionJobToListItem(s: SessionJob): JobListItem {
  const summary = s.job.summary
  return {
    id: s.job.id,
    status: s.job.status,
    title: summary?.uniprot?.proteinName ?? s.job.uniprotId ?? '评估作业',
    uniprotId: s.job.uniprotId,
    proteinName: summary?.uniprot?.proteinName ?? null,
    createdAt: new Date(s.at).toISOString(),
    coverage: summary?.coverage ?? null,
    pdbCount: summary?.directPdbCount ?? null,
    overallScore: summary?.scores?.overall?.score ?? null,
  }
}
