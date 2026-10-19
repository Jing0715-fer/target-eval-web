/**
 * 分块上传会话 + 后台异步解析 — 公网网关超时对策。
 *
 * 背景：平台外层 ALB 对单个 HTTP 请求有 ~30s 硬超时（含请求体上传与服务端
 * 处理）。大文件慢速上传或多图 VLM 解析（预算 90s）都会超时 → 502。
 *
 * 方案：把「上传」与「解析」全部拆成短请求：
 *  1. init     —— 建会话（配额检查 + 归属标记），毫秒级返回
 *  2. chunk    —— 2MB 分块追加写盘，单请求秒级完成，支持逐块重试
 *  3. complete —— 校验完整性后把解析任务丢进后台队列，立即返回
 *  4. status   —— 前端轮询解析进度（queued/parsing/done/error）
 *
 * 内存策略：分块落盘（raw.docx.part），仅解析开始时才读入缓冲（≤20MB）；
 * 后台解析复用全局解析信号量（PARSE_CONCURRENCY=2，与旧直传路由共享上限，
 * 总并发不放大），等待不设上限（由会话过期兜底）。
 *
 * 会话布局（db/reports/{uploadId}/）：
 *  - session.json  会话元数据（size/received/phase/ownerKey…，完成即删）
 *  - raw.docx.part 分块累积文件（解析前重命名为 upload.docx）
 *  - owner.json    归属标记（init 即写入，chunks/complete/status 全程校验）
 *  - parsed.json / assets/  解析产物（与旧直传格式完全一致）
 *
 * 过期回收：未完成会话（含 session.json 且 >30min）在 init/chunk 时惰性扫描
 * 删除；已完成上传沿用既有 24h TTL。
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DOCX_MAX_BYTES, parseDocx } from './docx'
import { checkAndCountUpload, QuotaError, withParseSlotBg } from './gatekeeper'
import { writeOwnerFile, uploadDir, uploadOwnedBy } from './upload-owner'
import type { RequestOwner } from './request-guard'
import type { DocxParsed } from './types'

/** 单分块上限（客户端按 2MB 切片，服务端留余量防御异常请求） */
export const CHUNK_MAX_BYTES = 8 * 1024 * 1024
/** 客户端分块大小（响应给前端） */
export const CHUNK_SIZE = 2 * 1024 * 1024
/** 会话过期（未完成即作废） */
const SESSION_TTL_MS = 30 * 60 * 1000

export type SessionPhase = 'uploading' | 'queued' | 'parsing' | 'done' | 'error'

export interface UploadSession {
  uploadId: string
  name: string
  size: number
  received: number
  phase: SessionPhase
  error?: string
  ownerKey: string
  ownerMask: string
  at: number
  updatedAt: number
}

type SessionFile = Omit<UploadSession, 'uploadId'>

const SESSION_FILE = 'session.json'
const PART_FILE = 'raw.docx.part'
const FINAL_FILE = 'upload.docx'

// ─── 会话存取（文件即真相，进程重启安全） ─────────────────────────────────────

function sessionPath(uploadId: string): string {
  return path.join(uploadDir(uploadId), SESSION_FILE)
}
function partPath(uploadId: string): string {
  return path.join(uploadDir(uploadId), PART_FILE)
}
function finalPath(uploadId: string): string {
  return path.join(uploadDir(uploadId), FINAL_FILE)
}

async function readSession(uploadId: string): Promise<UploadSession | null> {
  try {
    const raw = await fs.readFile(sessionPath(uploadId), 'utf-8')
    const f = JSON.parse(raw) as SessionFile
    return { ...f, uploadId }
  } catch {
    return null
  }
}

async function writeSession(s: UploadSession): Promise<void> {
  const { uploadId: _id, ...rest } = s
  void _id
  await fs.writeFile(sessionPath(s.uploadId), JSON.stringify({ ...rest, updatedAt: Date.now() }), 'utf-8')
}

/** 校验 uploadId 格式（与 upload-owner 同规则） */
function validId(id: string): boolean {
  return /^u_[\w-]{4,64}$/.test(id)
}

// ─── init ─────────────────────────────────────────────────────────────────────

export interface InitResult {
  ok: true
  uploadId: string
  chunkSize: number
}

/**
 * 创建上传会话：配额检查（每 IP 24h 上传数）→ 建目录 + 归属标记 + 会话文件。
 * 顺带惰性回收过期会话。
 */
export async function initUploadSession(owner: RequestOwner, name: string, size: number): Promise<InitResult | { ok: false; status: number; error: string }> {
  void scheduleSessionSweep()
  if (!Number.isFinite(size) || size <= 0 || size > DOCX_MAX_BYTES) {
    return { ok: false, status: 413, error: `文件大小无效（上限 20MB，收到 ${Number.isFinite(size) ? `${(size / 1024 / 1024).toFixed(1)}MB` : '未知'}）` }
  }
  const safeName = (name || 'upload.docx').slice(0, 120)
  if (!/\.docx$/i.test(safeName)) {
    return { ok: false, status: 400, error: '仅支持 .docx 格式（旧版 .doc 请先另存为 .docx）' }
  }
  // 每 IP 上传日配额（滑动窗口）
  try {
    checkAndCountUpload(owner.key)
  } catch (e) {
    if (e instanceof QuotaError) {
      return { ok: false, status: 429, error: e.message }
    }
    throw e
  }

  const uploadId = `u_${randomUUID().slice(0, 12)}`
  const dir = uploadDir(uploadId)
  await fs.mkdir(dir, { recursive: true })
  await writeOwnerFile(uploadId, owner)
  const now = Date.now()
  const session: UploadSession = {
    uploadId,
    name: safeName,
    size,
    received: 0,
    phase: 'uploading',
    ownerKey: owner.key,
    ownerMask: owner.mask,
    at: now,
    updatedAt: now,
  }
  await writeSession(session)
  return { ok: true, uploadId, chunkSize: CHUNK_SIZE }
}

// ─── chunk ────────────────────────────────────────────────────────────────────

/**
 * 追加一个分块：校验归属与偏移（严格顺序追加）→ 流式写盘。
 * 请求体为原始二进制（application/octet-stream），无 multipart 开销。
 */
export async function appendChunk(
  owner: RequestOwner,
  uploadId: string,
  offset: number,
  chunk: ArrayBuffer,
): Promise<{ ok: true; received: number } | { ok: false; status: number; error: string }> {
  if (!validId(uploadId)) return { ok: false, status: 400, error: 'uploadId 无效' }
  const s = await readSession(uploadId)
  if (!s) return { ok: false, status: 404, error: '上传会话不存在或已过期，请重新上传' }
  if (s.ownerKey !== owner.key) return { ok: false, status: 403, error: '无权访问该上传会话' }
  if (s.phase !== 'uploading') return { ok: false, status: 409, error: '该会话已完成上传，不能继续追加分块' }
  if (!Number.isFinite(offset) || offset < 0) return { ok: false, status: 400, error: 'offset 无效' }
  if (offset !== s.received) return { ok: false, status: 409, error: `offset 不连续（期望 ${s.received}，收到 ${offset}），请按顺序上传` }
  const len = chunk.byteLength
  if (len === 0) return { ok: false, status: 400, error: '分块为空' }
  if (len > CHUNK_MAX_BYTES) return { ok: false, status: 413, error: `分块过大（上限 8MB）` }
  if (s.received + len > s.size) return { ok: false, status: 413, error: '超出会话声明的文件大小' }
  if (Date.now() - s.at > SESSION_TTL_MS) {
    await fs.rm(uploadDir(uploadId), { recursive: true, force: true }).catch(() => undefined)
    return { ok: false, status: 410, error: '上传会话已过期（30 分钟），请重新上传' }
  }

  await fs.appendFile(partPath(uploadId), Buffer.from(chunk))
  s.received += len
  await writeSession(s)
  return { ok: true, received: s.received }
}

// ─── complete ─────────────────────────────────────────────────────────────────

/**
 * 完成上传：校验完整性 → 最后一分块重命名 → 后台队列解析（立即返回）。
 * 返回的并非解析结果，前端随后轮询 status。
 */
export async function completeUploadSession(
  owner: RequestOwner,
  uploadId: string,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (!validId(uploadId)) return { ok: false, status: 400, error: 'uploadId 无效' }
  const s = await readSession(uploadId)
  if (!s) return { ok: false, status: 404, error: '上传会话不存在或已过期，请重新上传' }
  if (s.ownerKey !== owner.key) return { ok: false, status: 403, error: '无权访问该上传会话' }
  if (s.phase === 'done') return { ok: true }
  if (s.phase !== 'uploading' && s.phase !== 'queued' && s.phase !== 'parsing') {
    return { ok: false, status: 409, error: s.error ?? '会话状态异常，请重新上传' }
  }
  if (s.received !== s.size) {
    return { ok: false, status: 409, error: `文件不完整（${s.received}/${s.size} 字节），请重传缺失分块` }
  }
  if (s.phase === 'queued' || s.phase === 'parsing') return { ok: true } // 幂等

  // 分块文件定稿
  try {
    await fs.access(partPath(uploadId))
    await fs.rename(partPath(uploadId), finalPath(uploadId))
  } catch {
    return { ok: false, status: 500, error: '上传数据丢失，请重新上传' }
  }
  s.phase = 'queued'
  await writeSession(s)
  enqueueBackgroundParse(uploadId)
  return { ok: true }
}

// ─── status ───────────────────────────────────────────────────────────────────

export interface SessionStatus {
  ok: true
  uploadId: string
  phase: SessionPhase
  /** phase=done 时与旧直传响应同构（前端复用同一渲染） */
  parsed?: DocxParsed
  /** 无可用靶点信息时的提示（与旧直传一致） */
  error?: string
}

export async function getSessionStatus(owner: RequestOwner, uploadId: string): Promise<SessionStatus | { ok: false; status: number; error: string }> {
  if (!validId(uploadId)) return { ok: false, status: 400, error: 'uploadId 无效' }
  // 会话仍在（未 done）：按 session.json 判断
  const s = await readSession(uploadId)
  if (s) {
    if (s.ownerKey !== owner.key) return { ok: false, status: 403, error: '无权访问该上传会话' }
    return { ok: true, uploadId, phase: s.phase, error: s.error }
  }
  // 会话已删（完成或过期）：查 parsed.json —— 归属以 owner.json 为准（跨用户 404）
  try {
    if (!(await uploadOwnedBy(uploadId, owner))) {
      return { ok: false, status: 404, error: '上传会话不存在或已过期，请重新上传' }
    }
    const raw = await fs.readFile(path.join(uploadDir(uploadId), 'parsed.json'), 'utf-8')
    const parsed = JSON.parse(raw) as DocxParsed
    const hint = parsed.uniprotIds.length === 0 && parsed.sequences.length === 0
      ? '提示：未在评估表中识别出 UniProt ID 或蛋白序列，请检查文档内容或改用其他输入方式'
      : undefined
    return { ok: true, uploadId, phase: 'done', parsed, error: hint }
  } catch {
    return { ok: false, status: 404, error: '上传会话不存在或已过期，请重新上传' }
  }
}

// ─── 后台解析队列（并发与直传路由共享解析信号量） ─────────────────────────────

function enqueueBackgroundParse(uploadId: string): void {
  void (async () => {
    try {
      await withParseSlotBg(async () => {
        const s0 = await readSession(uploadId)
        if (!s0 || (s0.phase !== 'queued' && s0.phase !== 'parsing')) return // 会话被清理/取消
        s0.phase = 'parsing'
        await writeSession(s0)

        const buffer = await fs.readFile(finalPath(uploadId))
        const { parsed } = await parseDocx(buffer, { uploadId })
        // 持久化解析结果（与旧直传路由同构：含 fullText 供 insights 复用）。
        // 写入失败必须置错（否则 status 永远等不到 parsed.json）。
        const parsedPath = path.join(uploadDir(uploadId), 'parsed.json')
        try {
          await fs.writeFile(parsedPath, JSON.stringify(parsed), 'utf-8')
        } catch {
          try {
            await fs.mkdir(path.dirname(parsedPath), { recursive: true })
            await fs.writeFile(parsedPath, JSON.stringify(parsed), 'utf-8')
          } catch (e2) {
            throw new Error(`解析结果持久化失败：${e2 instanceof Error ? e2.message : String(e2)}`)
          }
        }
        // done：删除会话文件与原始上传件（status 此后改读 parsed.json）
        await fs.rm(sessionPath(uploadId), { force: true }).catch(() => undefined)
        await fs.rm(finalPath(uploadId), { force: true }).catch(() => undefined)
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      await markParseError(uploadId, `文档解析失败：${msg.slice(0, 200)}`)
    }
  })()
}

async function markParseError(uploadId: string, msg: string): Promise<void> {
  const s = await readSession(uploadId)
  if (!s || s.phase === 'done') return
  s.phase = 'error'
  s.error = msg
  await writeSession(s).catch(() => undefined)
}

// ─── 过期会话回收 ─────────────────────────────────────────────────────────────

let sweeping = false
/** 惰性回收：删除含 session.json 且超 30min 的目录（未完成即作废）。单次 ≤30 个。 */
export async function scheduleSessionSweep(): Promise<void> {
  if (sweeping) return
  sweeping = true
  try {
    const root = path.join(process.cwd(), 'db', 'reports')
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
    const now = Date.now()
    let removed = 0
    for (const e of entries) {
      if (removed >= 30) break
      if (!e.isDirectory() || !e.name.startsWith('u_')) continue
      const dir = path.join(root, e.name)
      try {
        const st = await fs.stat(path.join(dir, SESSION_FILE)).catch(() => null)
        if (!st) continue // 无会话文件（已完成或旧格式上传）
        if (now - st.mtimeMs > SESSION_TTL_MS) {
          await fs.rm(dir, { recursive: true, force: true })
          removed++
        }
      } catch { /* 单目录失败忽略 */ }
    }
  } finally {
    sweeping = false
  }
}
