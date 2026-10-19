/**
 * 轻量 LRU 响应缓存 — 4GB 内存沙箱防 OOM 设计：
 * - 条目数上限 100，字节总量上限 5MB，超出按 LRU 逐出
 * - 仅缓存幂等的外部 API 响应（UniProt/PDB/PDBe 查询）
 * - 值为按需使用的 JSON（拉取后立即交给调用方，缓存只保留同一份引用，
 *   不做额外拷贝；JSON.stringify 仅在估算大小时对大对象抽样
 */

interface Entry {
  value: unknown
  size: number
  at: number // 插入顺序号
}

const MAX_ITEMS = 100
const MAX_BYTES = 5 * 1024 * 1024

export class LruCache {
  private map = new Map<string, Entry>()
  private clock = 0
  private totalBytes = 0

  get<T>(key: string): T | undefined {
    const e = this.map.get(key)
    if (!e) return undefined
    // 刷新 LRU 顺序
    this.map.delete(key)
    e.at = ++this.clock
    this.map.set(key, e)
    return e.value as T
  }

  set(key: string, value: unknown): void {
    const size = this.estimateSize(value)
    if (size > MAX_BYTES) return // 单条超过总预算，直接不缓存
    if (this.map.has(key)) {
      const old = this.map.get(key)!
      this.totalBytes -= old.size
      this.map.delete(key)
    }
    // 逐出最旧条目直到有空间
    while (this.totalBytes + size > MAX_BYTES || this.map.size >= MAX_ITEMS) {
      const oldest = this.findOldest()
      if (!oldest) break
      this.totalBytes -= this.map.get(oldest)!.size
      this.map.delete(oldest)
    }
    this.map.set(key, { value, size, at: ++this.clock })
    this.totalBytes += size
  }

  private findOldest(): string | undefined {
    let minAt = Infinity
    let minKey: string | undefined
    for (const [k, e] of this.map) {
      if (e.at < minAt) { minAt = e.at; minKey = k }
    }
    return minKey
  }

  /** 粗略估算对象字节：字符串按 UTF-16 长度×2，数组取前 50 项平均 */
  private estimateSize(v: unknown): number {
    try {
      if (v == null) return 16
      if (typeof v === 'string') return v.length * 2
      if (typeof v === 'number' || typeof v === 'boolean') return 16
      if (Array.isArray(v)) {
        const sample = v.slice(0, 50)
        const sampleBytes = sample.reduce((s, x) => s + this.estimateSize(x), 0)
        return v.length === 0 ? 32 : Math.round((sampleBytes / sample.length) * v.length) + 64
      }
      if (typeof v === 'object') {
        let sum = 64
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
          sum += k.length * 2 + this.estimateSize(val)
          if (sum > MAX_BYTES) return MAX_BYTES + 1
        }
        return sum
      }
      return 64
    } catch {
      return 1024
    }
  }

  get size(): number { return this.map.size }
  get bytes(): number { return this.totalBytes }
}

/** 全局单例（dev 模式 HMR 下防重复实例） */
const g = globalThis as unknown as { __evalLruCache?: LruCache }
export const apiCache: LruCache = g.__evalLruCache ?? new LruCache()
g.__evalLruCache = apiCache

/** 带缓存的 JSON fetch（GET） */
export async function cachedJsonFetch<T>(
  url: string,
  opts: { timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<T | null> {
  const cached = apiCache.get<T>(url)
  if (cached !== undefined) return cached
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000)
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', ...opts.headers },
      signal: controller.signal,
    })
    if (!res.ok) return null
    const json = (await res.json()) as T
    apiCache.set(url, json)
    return json
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
