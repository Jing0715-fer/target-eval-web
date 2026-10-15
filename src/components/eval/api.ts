/**
 * 前端 API 访问层（相对路径 fetch）
 * 所有函数对失败抛出 Error，由调用方决定降级方式。
 */
import type { JobListItem, UploadResponse } from './types'

/** GET /api/jobs — 最近作业列表 */
export async function fetchJobList(): Promise<JobListItem[]> {
  const res = await fetch('/api/jobs', { cache: 'no-store' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json().catch(() => null)
  if (!Array.isArray(data)) throw new Error('响应格式错误')
  return data as JobListItem[]
}

/** DELETE /api/jobs/[id] — 取消/删除作业 */
export async function deleteJobById(id: string): Promise<void> {
  const res = await fetch(`/api/jobs/${id}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

/** POST /api/evaluate/upload — 上传 Word 评估表（multipart: file） */
export async function uploadEvaluateDocx(file: File): Promise<UploadResponse> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch('/api/evaluate/upload', { method: 'POST', body: form })
  let data: (UploadResponse & { error?: string }) | null = null
  try {
    data = (await res.json()) as UploadResponse & { error?: string }
  } catch {
    data = null
  }
  if (!res.ok || !data || !data.ok || !data.parsed) {
    throw new Error(data?.error ?? `上传解析失败（HTTP ${res.status}）`)
  }
  return data
}
