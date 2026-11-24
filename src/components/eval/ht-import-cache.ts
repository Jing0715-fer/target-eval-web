/**
 * v2.81：导入报告原文的浏览器本地留存（内存 + IndexedDB）。
 *
 * 背景（用户实测「117 个靶点的原文未能内嵌弹出页（超出体积预算或留存失败）」）：
 * v2.69 起导入报告原文只在「导入时」上传服务端留存一次（reportId），失败
 * （服务重启窗口 / 表未建 / 网络抖动）或留存事后丢失（DB 重置 / 实例回收）时，
 * 客户端手里明明有完整 HTML（解析统计快照时就读过），却因为读盘后即丢弃，
 * 只能接受弹出页降级 — 汇总报告里全部 117 个靶点的原文内嵌齐齐落空。
 *
 * 本模块把导入时读到的源文件 HTML 以 **内容哈希（sha256 前 32 hex）** 为键
 * 留存在浏览器（内存 Map + IndexedDB 持久化 — 刷新/重开浏览器后仍在）：
 *  - enrichImportedReports 读完源文件 → saveImportedSource 落缓存，sha 随
 *    imported 条目/运行记录持久化（importedReportSha）；
 *  - 汇总报告生成前（finalizeHtDashboard）按 sha 取回缓存，向服务端校验
 *    reportId 留存是否存活，缺失/死亡 → 从缓存重新上传自愈（详见
 *    ensureImportedRetention）— 不再依赖导入那一瞬间的上传成败。
 *
 * 键选内容哈希而非批次序号：同内容跨批次天然共享（不重复存），不同内容
 * 永不串键（批次序号 f:0 会被下一批导入覆盖 → 旧运行错拿新内容的隐患）。
 *
 * 体积护栏：单份 >8MB 不入 IndexedDB（仅内存 — 超大报告本就走 32MB 上限
 * 门控）；IndexedDB 总量 >150MB 时按写入时间淘汰最旧的条目。所有 IDB 操作
 * try/catch 静默降级（隐私模式/配额拒绝 → 仅内存，行为退回 v2.80 但不报错）。
 */

/** 单份入 IndexedDB 的体积上限（字符 — 约 8MB；更大的仅内存留存） */
const IDB_SINGLE_MAX_CHARS = 8_000_000
/** IndexedDB 总量上限（字符 — 约 150MB；超出按最旧淘汰） */
const IDB_TOTAL_MAX_CHARS = 150_000_000
/** 淘汰扫描的条目上限（防御 — 超大库存时截断扫描） */
const IDB_TRIM_SCAN_LIMIT = 400

interface CachedSource {
  fileName: string
  html: string
  at: number
}

/** 内存缓存（sha → 源文件）— 同会话内零延迟命中 */
const memCache = new Map<string, CachedSource>()

// ─── IndexedDB（best-effort — 打开失败静默降级为纯内存）───────────────────────

const IDB_NAME = 'te-import-cache'
const IDB_STORE = 'sources'
let idbOpenPromise: Promise<IDBDatabase | null> | null = null

function openIdb(): Promise<IDBDatabase | null> {
  if (idbOpenPromise) return idbOpenPromise
  idbOpenPromise = new Promise(resolve => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null)
      const req = indexedDB.open(IDB_NAME, 1)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          const store = db.createObjectStore(IDB_STORE, { keyPath: 'sha' })
          store.createIndex('at', 'at')
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return idbOpenPromise
}

function idbReq<T>(req: IDBRequest<T>): Promise<T | null> {
  return new Promise(resolve => {
    req.onsuccess = () => resolve(req.result ?? null)
    req.onerror = () => resolve(null)
  })
}

async function idbPut(entry: CachedSource & { sha: string }): Promise<void> {
  const db = await openIdb()
  if (!db) return
  try {
    await idbReq(db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).put(entry))
  } catch { /* 配额/隐私模式 — 静默 */ }
}

async function idbGet(sha: string): Promise<CachedSource | null> {
  const db = await openIdb()
  if (!db) return null
  try {
    const hit = await idbReq(db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(sha))
    return hit ?? null
  } catch {
    return null
  }
}

/** 总量超限时按写入时间淘汰最旧条目（best-effort — 失败不影响本次写入） */
async function idbTrimIfNeeded(incomingChars: number): Promise<void> {
  const db = await openIdb()
  if (!db) return
  try {
    const store = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE)
    const all = (await idbReq(store.getAll())) as Array<CachedSource & { sha: string }> | null
    if (!all) return
    let total = incomingChars
    for (const e of all) total += e.html.length
    if (total <= IDB_TOTAL_MAX_CHARS) return
    const sorted = [...all].sort((a, b) => a.at - b.at)
    const victims: string[] = []
    let cur = total
    for (const e of sorted) {
      if (cur <= IDB_TOTAL_MAX_CHARS || victims.length >= IDB_TRIM_SCAN_LIMIT) break
      cur -= e.html.length
      victims.push(e.sha)
    }
    if (!victims.length) return
    const tx = db.transaction(IDB_STORE, 'readwrite')
    for (const sha of victims) tx.objectStore(IDB_STORE).delete(sha)
    await new Promise<void>(resolve => { tx.oncomplete = () => resolve(); tx.onerror = () => resolve(); tx.onabort = () => resolve() })
  } catch { /* 静默 */ }
}

// ─── 对外接口 ─────────────────────────────────────────────────────────────────

/** sha256(hex 前 32 位) — 浏览器 crypto.subtle（https/localhost 可用；不可用时退化 djb2） */
async function sourceSha(html: string): Promise<string> {
  try {
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(html))
      return Array.from(new Uint8Array(digest).slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join('')
    }
  } catch { /* 降级 */ }
  // FNV-1a 64 近似（crypto.subtle 不可用的 file:// 等）— 键唯一性略降但内容寻址语义不变
  let h1 = 0x811c9dc5, h2 = 0x01000193
  for (let i = 0; i < html.length; i++) {
    h1 = (h1 ^ html.charCodeAt(i)) * 0x01000193 >>> 0
    h2 = (h2 + html.charCodeAt(i) * 31) >>> 0
  }
  return `x${h1.toString(16)}${h2.toString(16)}`
}

/**
 * 留存一份导入源文件原文 — 返回内容哈希键（随 imported 条目/运行记录持久化，
 * 生成汇总报告时按键取回自愈重传）。内存必写；IndexedDB 按体积护栏 best-effort。
 */
export async function saveImportedSource(fileName: string, html: string): Promise<string> {
  const sha = await sourceSha(html)
  const entry: CachedSource = { fileName: fileName.slice(0, 120), html, at: Date.now() }
  memCache.set(sha, entry)
  if (html.length <= IDB_SINGLE_MAX_CHARS) {
    await idbPut({ ...entry, sha }).catch(() => undefined)
    void idbTrimIfNeeded(html.length).catch(() => undefined)
  }
  return sha
}

/** 按哈希键取回留存的源文件（内存 → IndexedDB；未留存认 null） */
export async function getImportedSource(sha: string): Promise<CachedSource | null> {
  const mem = memCache.get(sha)
  if (mem) return mem
  const hit = await idbGet(sha)
  if (hit) memCache.set(sha, hit)
  return hit
}
