/**
 * 上传目录归属（db/reports/u_*）— 文件级 owner 标记。
 *
 * parsed.json / insights.json / assets/ 均在上传目录内；目录 TTL 24h。
 * owner.json 由上传路由在解析完成后写入（key = IP 哈希，mask = 掩码）。
 * 缺失 owner.json（历史目录/极小竞争窗口）视为无主 → 放行
 * （asset id 为不可猜测随机串，风险可忽略）。
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { RequestOwner } from './request-guard'

interface OwnerFile {
  key: string
  mask: string
  at: number
}

const UPLOAD_ID_RE = /^u_[\w-]{4,64}$/

export function isUploadId(id: string): boolean {
  return UPLOAD_ID_RE.test(id)
}

export function uploadDir(uploadId: string): string {
  return path.join(process.cwd(), 'db', 'reports', uploadId)
}

/** 写入归属标记（解析成功后调用；失败静默 — 无主目录按放行处理） */
export async function writeOwnerFile(uploadId: string, owner: RequestOwner): Promise<void> {
  try {
    const data: OwnerFile = { key: owner.key, mask: owner.mask, at: Date.now() }
    await fs.writeFile(path.join(uploadDir(uploadId), 'owner.json'), JSON.stringify(data), 'utf-8')
  } catch { /* 磁盘失败不阻塞上传返回 */ }
}

/** 校验目录归属；无 owner.json 放行，key 不匹配返回 false */
export async function uploadOwnedBy(uploadId: string, owner: RequestOwner): Promise<boolean> {
  try {
    const raw = await fs.readFile(path.join(uploadDir(uploadId), 'owner.json'), 'utf-8')
    const data = JSON.parse(raw) as Partial<OwnerFile>
    if (!data.key) return true
    return data.key === owner.key
  } catch {
    return true // 无标记（历史/竞争窗口）→ 放行
  }
}
