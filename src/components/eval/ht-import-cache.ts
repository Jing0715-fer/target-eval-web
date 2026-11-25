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
 * 门控）；IndexedDB 总量 >600MB（v2.92：150M 提升 — 百份级批次多轮导入防淘汰）
 * 时按写入时间淘汰最旧的条目。所有 IDB 操作
 * try/catch 静默降级（隐私模式/配额拒绝 → 仅内存，行为退回 v2.80 但不报错）。
 */

/** 单份入 IndexedDB 的体积上限（字符 — 约 8MB；更大的仅内存留存） */
const IDB_SINGLE_MAX_CHARS = 8_000_000
/** IndexedDB 总量上限（字符；超出按最旧淘汰）。
 *  v2.92：150M → 600M — 用户实测形态：117 份 × ~1.1MB ≈ 128MB/批，多轮导入
 *  （重测/补验）两批即超 150M → 按写入时间淘汰最旧 → **上一轮运行的源被清光**；
 *  生成时 heal（本地无源重传）与直传（本地取源）双双无源 → 全降级。Chrome/
 *  Firefox 的 IndexedDB 配额通常是磁盘级（GB 级），600M 仍属自律范围但足以
 *  容纳多轮百份级批次。 */
const IDB_TOTAL_MAX_CHARS = 600_000_000
/** 淘汰扫描的条目上限（防御 — 超大库存时截断扫描） */
const IDB_TRIM_SCAN_LIMIT = 400

interface CachedSource {
  fileName: string
  html: string
  at: number
}

/** 内存缓存（sha → 源文件）— 同会话内零延迟命中。
 *  v2.83：有界 LRU（旧版无界 — 117 份 × 1.1MB ≈ 128MB 常驻是渲染进程 OOM 的
 *  第二根源；IndexedDB 才是持久层，内存层只为同会话自愈加速，容量 8 足够） */
const MEM_CACHE_MAX = 8
const memCache = new Map<string, CachedSource>()

function memCacheSet(sha: string, entry: CachedSource): void {
  memCache.delete(sha)
  while (memCache.size >= MEM_CACHE_MAX) {
    const oldest = memCache.keys().next().value
    if (oldest === undefined) break
    memCache.delete(oldest)
  }
  memCache.set(sha, entry)
}

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

/** v2.83：IDB 总量近似值（-1 = 未知需扫描初始化）。避免每写一份就全库游标扫描
 *  ——内存计数器只在跨过 150MB 阈值时才触发真正的淘汰扫描） */
let approxIdbChars = -1

/** 总量超限时按写入时间淘汰最旧条目（best-effort — 失败不影响本次写入）。
 *  v2.83：**游标流式扫描**（旧版 getAll 把全库条目整读进 JS 堆 — 117 份 × 1.1MB
 *  的留存每写一份就 getAll 一次 = 128MB 级瞬态 × 117 次，V8 回收跟不上 →
 *  渲染进程 JS 堆飙到 678MB / 总 RSS 2.4GB 被内核 OOM 杀死，实测定位）。
 *  游标逐条流过只累计 {sha, 时间, 长度}，任意时刻至多驻留单份原文。 */
async function idbTrimIfNeeded(incomingChars: number): Promise<void> {
  // v2.83：已知总量且未超限 → 纯内存计数，零扫描（百份导入的主路径）
  if (approxIdbChars >= 0 && approxIdbChars + incomingChars <= IDB_TOTAL_MAX_CHARS) {
    approxIdbChars += incomingChars
    return
  }
  const db = await openIdb()
  if (!db) return
  try {
    let total = incomingChars
    const entries: Array<{ sha: string; at: number; chars: number }> = []
    await new Promise<void>(resolve => {
      const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).openCursor()
      req.onsuccess = () => {
        const cur = req.result
        if (!cur) return resolve()
        const v = cur.value as (CachedSource & { sha?: string }) | null
        const sha = typeof v?.sha === 'string' ? v.sha : (cur.key as string)
        const chars = typeof v?.html?.length === 'number' ? v.html.length : 0
        total += chars
        entries.push({ sha, at: typeof v?.at === 'number' ? v.at : 0, chars })
        cur.continue()
      }
      req.onerror = () => resolve()
    })
    approxIdbChars = total // 缓存近似总量（淘汰后同步扣减）
    if (total <= IDB_TOTAL_MAX_CHARS) return
    const sorted = [...entries].sort((a, b) => a.at - b.at)
    const victims: string[] = []
    let curTotal = total
    for (const e of sorted) {
      if (curTotal <= IDB_TOTAL_MAX_CHARS || victims.length >= IDB_TRIM_SCAN_LIMIT) break
      curTotal -= e.chars
      victims.push(e.sha)
    }
    if (!victims.length) return
    const tx = db.transaction(IDB_STORE, 'readwrite')
    for (const sha of victims) tx.objectStore(IDB_STORE).delete(sha)
    for (const v of victims) {
      const e = entries.find(x => x.sha === v)
      if (e) approxIdbChars -= e.chars
    }
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
  memCacheSet(sha, entry)
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
  if (hit) memCacheSet(sha, hit)
  return hit
}

// ─── v2.87：会话级源文件注册表（生成时原文直传的数据源）────────────────────────
//
// 动机（用户实测「上传的报告还是没有嵌入到汇总报告中」跨 v2.69–v2.86 多版复现）：
// 导入时上传 → reportId → 运行记录持久化 → 生成前自愈重传 → 服务端留存读取 —
// 环节多且任一失败都静默降级。v2.87 在汇总生成请求里**直接携带原文**（同一请求
// 内落库并内嵌 — 链路环节全部收敛掉）。本注册表是直传的取数来源之一：
//  - enrich 解析每份源文件时顺手登记（同会话导入 → 生成的主路径，浏览器
//    IndexedDB 不可用（隐私模式等）也照常工作）；
//  - 跨会话（导入后隔天生成）由 IndexedDB（getImportedSource 按 sha）覆盖；
//  - 无 sha 键的旧运行记录条目可按 fileName 在本表反查（仅同会话）。
//
// 体积护栏：单份 >8MB 不登记（与 IndexedDB 同口径）；会话总量 96MB（百份级
// 报告全量覆盖；超出按 FIFO 弃最旧 — 直传侧还有 32MB 请求预算兜底）。

const SESSION_SOURCES_MAX_CHARS = 96_000_000
const SESSION_SINGLE_MAX_CHARS = 8_000_000
const sessionSources = new Map<string, CachedSource>() // sha → {fileName, html, at}
const sessionByName = new Map<string, string>() // fileName（小写）→ sha
let sessionChars = 0

/** v2.87：登记一份会话源文件（enrich 解析时调用 — 生成时直传取数） */
export function registerSessionSource(sha: string, fileName: string, html: string): void {
  if (!sha || html.length > SESSION_SINGLE_MAX_CHARS) return
  if (sessionSources.has(sha)) return
  while (sessionChars + html.length > SESSION_SOURCES_MAX_CHARS) {
    const oldest = sessionSources.keys().next().value
    if (oldest === undefined) break
    const v = sessionSources.get(oldest)
    sessionSources.delete(oldest)
    if (v) {
      sessionChars -= v.html.length
      for (const [k, s] of sessionByName) {
        if (s === oldest) { sessionByName.delete(k); break }
      }
    }
  }
  if (sessionChars + html.length > SESSION_SOURCES_MAX_CHARS) return
  const entry: CachedSource = { fileName: fileName.slice(0, 120), html, at: Date.now() }
  sessionSources.set(sha, entry)
  sessionChars += html.length
  sessionByName.set(fileName.trim().toLowerCase(), sha)
}

/** v2.87：按 sha 取会话源文件（内存 — 不触 IndexedDB） */
export function getSessionSource(sha: string): CachedSource | null {
  return sessionSources.get(sha) ?? null
}

/** v2.87：按文件名反查会话源 sha（无留存键的旧条目 — 前缀 80 字符匹配吸收切片差异） */
export function getSessionSourceShaByFileName(fileName: string): string | null {
  const key = fileName.trim().toLowerCase().slice(0, 80)
  if (!key) return null
  for (const [name, sha] of sessionByName) {
    if (name.slice(0, 80) === key) return sha
  }
  return null
}

/** v2.87：当前会话已登记的源文件数（诊断用） */
export function sessionSourceCount(): number {
  return sessionSources.size
}
