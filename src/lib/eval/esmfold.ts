/**
 * ESMFold 公共预测结构集成（仅服务端）— AFDB 无收录时的免登录兜底。
 *
 * 场景：AlphaFold DB 只收录 UniProt 全长标准条目 — 序列直接输入（无 UniProt
 * 归属）或 AFDB 无该条目时，报告原先完全没有计算预测结构。v2.15 起改用 ESM
 * Atlas 公共 ESMFold 接口兜底预测（单序列语言模型，无 MSA）。
 *
 * 通道实测（2026-11）：
 *  - POST https://api.esmatlas.com/foldSequence/v1/pdb/，请求体为纯序列文本
 *    （Content-Type: text/plain）→ 返回 PDB 文本。无鉴权、无 API Key、无登录
 *    （官方 esmfold CLI 与 Atlas fold 页同源实现；ToolUniverse 同款用法）。
 *  - 旧 /predict/ 端点已坏（502 Internal server error）；JSON 体亦不被接受
 *    （422 — 后端把请求体整体当序列做 token 校验，花括号自然全部非法）。
 *  - 序列上限 400 aa（413 「Sequence is longer than 400」）；服务端 AWS 网关
 *    ~30s 切断 — 高峰期中长序列常 504（「Gateway Time-out」），短序列（≤80 aa）
 *    健康时 ~3.5s 稳定返回。失败按瞬时处理：磁盘缓存使下次评估重试零成本。
 *  - 返回 PDB 的 B-factor 列为残基 pLDDT，但标度 0-1（AFDB 模型为 0-100）—
 *    本模块统一 ×100 重写 ATOM 行，下游 pLDDT 着色/统计与 AF 模型完全同构。
 *
 * 磁盘缓存 db/cache/esmfold/{key}.pdb + {key}.json（key = 序列 sha1 前 20 位）：
 * 模型确定性（ESMFold v1 固定权重），TTL 无限；断网/服务退化时已评估序列
 * 仍能出完整 ESMFold 区块（元数据 + 3D 视图），与 AF 磁盘优先策略对齐。
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createHash } from 'node:crypto'

/** ESM Atlas 公共折叠接口（免登录） */
const ESMFOLD_API = 'https://api.esmatlas.com/foldSequence/v1/pdb/'
/** 无关字段干扰的干净 UA（Atlas 前端同款） */
const ESMFOLD_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36'

/** 公共接口序列长度硬上限（413 超限；官方 fold 页同限） */
export const ESMFOLD_MAX_AA = 400
/** 内嵌预算（与 AF 模型同口径 — 超大模型仅展示统计信息） */
export const ESMFOLD_EMBED_MAX_BYTES = 2.5 * 1024 * 1024

/** API 允许的氨基酸 token 集（实测 422 报文枚举：20 标准 + B/J/X/Z；无 O/U） */
const ALLOWED_TOKENS = new Set('ACDEFGHIKLMNPQRSTVWYBJZX'.split(''))

// ─── 序列归一 / 缓存键 ───────────────────────────────────────────────────────

/** 序列清洗：去 FASTA 头/空白/数字，仅保留 API 允许 token，大写 */
export function cleanEsmfoldSequence(raw: string): string {
  const noHeader = raw
    .split('\n')
    .filter(l => !l.startsWith('>'))
    .join('')
  const upper = noHeader.toUpperCase()
  let out = ''
  for (const ch of upper) if (ALLOWED_TOKENS.has(ch)) out += ch
  return out
}

/** 缓存键（序列 sha1 前 20 位 — 与目录名/摘要存档一致） */
export function esmfoldCacheKey(sequence: string): string {
  return createHash('sha1').update(sequence).digest('hex').slice(0, 20)
}

// ─── pLDDT 标度归一（0-1 → 0-100）与统计 ────────────────────────────────────

/** 重写 ATOM/HETATM 行 B-factor（61-66 列）：ESMFold 0-1 → AFDB 0-100 口径 */
function scalePlddtTo100(pdbText: string): string {
  const lines = pdbText.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (l.length < 66 || (l.startsWith('ATOM  ') === false && l.startsWith('HETATM') === false)) continue
    const b = parseFloat(l.slice(60, 66))
    if (!Number.isFinite(b)) continue
    const scaled = Math.min(100, Math.max(0, b * 100))
    // %6.2f 右对齐 6 字符（PDB 定宽列规范；toFixed(2) 最长 "100.00" = 6 位恰合）
    lines[i] = l.slice(0, 60) + scaled.toFixed(2).padStart(6) + l.slice(66)
  }
  return lines.join('\n')
}

export interface EsmfoldStats {
  /** 残基数（首个 ATOM 计一个残基） */
  length: number
  /** 平均 pLDDT（0-100，一位小数） */
  meanPlddt: number
  /** pLDDT ≥90 区段占比（0-1） */
  fracVeryHigh: number
  /** pLDDT <50 区段占比（0-1） */
  fracVeryLow: number
}

/** 逐残基 pLDDT 统计（输入须已 ×100 归一） */
function computePlddtStats(pdbText: string): EsmfoldStats {
  const byResi = new Map<number, number>()
  for (const l of pdbText.split('\n')) {
    if (!l.startsWith('ATOM  ')) continue
    const resi = parseInt(l.slice(22, 26), 10)
    const b = parseFloat(l.slice(60, 66))
    if (Number.isFinite(resi) && Number.isFinite(b) && !byResi.has(resi)) byResi.set(resi, b)
  }
  const vals = [...byResi.values()]
  if (!vals.length) return { length: 0, meanPlddt: 0, fracVeryHigh: 0, fracVeryLow: 0 }
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length
  return {
    length: vals.length,
    meanPlddt: Math.round(mean * 10) / 10,
    fracVeryHigh: vals.filter(v => v >= 90).length / vals.length,
    fracVeryLow: vals.filter(v => v < 50).length / vals.length,
  }
}

// ─── 磁盘缓存（db/cache/esmfold/）────────────────────────────────────────────

function cacheDir(): string {
  return path.join(process.cwd(), 'db', 'cache', 'esmfold')
}

export interface EsmfoldCacheMeta {
  savedAt: number
  sequenceLength: number
  meanPlddt: number
  fracVeryHigh: number
  fracVeryLow: number
}

/** 读缓存的模型文本（毫秒级；render/合并报告直读路径 — 无网络） */
export async function loadCachedEsmfoldModel(cacheKey: string): Promise<{ pdbText: string; meta: EsmfoldCacheMeta } | null> {
  if (!/^[0-9a-f]{20}$/.test(cacheKey)) return null
  try {
    const meta = JSON.parse(await fs.readFile(path.join(cacheDir(), `${cacheKey}.json`), 'utf-8')) as EsmfoldCacheMeta
    const pdbText = await fs.readFile(path.join(cacheDir(), `${cacheKey}.pdb`), 'utf-8')
    if (!pdbText.includes('ATOM') || typeof meta?.savedAt !== 'number') return null
    return { pdbText, meta }
  } catch {
    return null
  }
}

async function writeCache(cacheKey: string, pdbText: string, meta: EsmfoldCacheMeta): Promise<void> {
  try {
    await fs.mkdir(cacheDir(), { recursive: true })
    await fs.writeFile(path.join(cacheDir(), `${cacheKey}.pdb`), pdbText, 'utf-8')
    await fs.writeFile(path.join(cacheDir(), `${cacheKey}.json`), JSON.stringify(meta), 'utf-8')
  } catch { /* 缓存失败不影响主流程 */ }
}

// ─── 对外编排 ────────────────────────────────────────────────────────────────

export type EsmfoldOutcome =
  | { ok: true; cacheKey: string; pdbText: string; stats: EsmfoldStats; fromCache: boolean; embeddable: boolean }
  | { ok: false; reason: 'too-long' | 'invalid' | 'timeout' | 'service'; detail?: string }

/** 失败原因 → 用户可读说明（作业摘要 note / 日志共用） */
export function esmfoldFailNote(out: Extract<EsmfoldOutcome, { ok: false }>): string {
  switch (out.reason) {
    case 'too-long':
      return `序列超过 ESMFold 公共接口上限（400 aa）— 建议改用需登录的 ColabFold 或 AlphaFold Server`
    case 'invalid':
      return '序列无效（未包含标准氨基酸字符）— 未执行 ESMFold 预测'
    case 'timeout':
      return `公共 ESMFold 服务超时（${out.detail ?? '远端网关切断'}）— 服务高峰期常见，可稍后重新评估自动重试`
    default:
      return `公共 ESMFold 服务不可用（${out.detail ?? '未知错误'}）`
  }
}

/**
 * ESMFold 预测结构（缓存优先 — 命中零网络）。
 * 失败分类：413 → too-long；5xx/Gateway Time-out → timeout/service；
 * 其余网络异常 → service。调用方（af2 相位）把失败写入摘要 note，本次作业
 * 不再重试；磁盘缓存保证重新评估时命中即零成本。
 */
export async function esmfoldStructureFor(
  sequence: string,
  opts: { timeoutMs?: number } = {},
): Promise<EsmfoldOutcome> {
  const clean = cleanEsmfoldSequence(sequence)
  if (clean.length === 0) return { ok: false, reason: 'invalid' }
  if (clean.length > ESMFOLD_MAX_AA) return { ok: false, reason: 'too-long', detail: `${clean.length} aa` }
  const key = esmfoldCacheKey(clean)

  // 磁盘缓存命中（确定性模型 — 直接复用）
  const cached = await loadCachedEsmfoldModel(key)
  if (cached) {
    return {
      ok: true, cacheKey: key, pdbText: cached.pdbText, fromCache: true,
      stats: { length: cached.meta.sequenceLength, meanPlddt: cached.meta.meanPlddt, fracVeryHigh: cached.meta.fracVeryHigh, fracVeryLow: cached.meta.fracVeryLow },
      embeddable: cached.pdbText.length <= ESMFOLD_EMBED_MAX_BYTES,
    }
  }

  // 远端预测（text/plain 纯序列体 — 官方格式；JSON 体会被 422 拒绝）
  let res: Response
  try {
    res = await fetch(ESMFOLD_API, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'User-Agent': ESMFOLD_UA },
      body: clean,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 35_000),
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, reason: /timeout|timed out|abort/i.test(msg) ? 'timeout' : 'service', detail: msg.slice(0, 120) }
  }
  if (res.status === 413) return { ok: false, reason: 'too-long', detail: `${clean.length} aa` }
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 120)
    const gatewayTimeout = /gateway time-out|timed? ?out/i.test(text) || res.status === 504
    return { ok: false, reason: gatewayTimeout ? 'timeout' : 'service', detail: `HTTP ${res.status}${text ? ` ${text}` : ''}`.slice(0, 140) }
  }
  const raw = await res.text().catch(() => '')
  if (!raw.includes('ATOM')) return { ok: false, reason: 'service', detail: '响应无 ATOM 记录（非 PDB）' }
  if (raw.length > ESMFOLD_EMBED_MAX_BYTES) return { ok: false, reason: 'service', detail: `模型体积超限（${Math.round(raw.length / 1024)}KB）` }

  const pdbText = scalePlddtTo100(raw)
  const stats = computePlddtStats(pdbText)
  if (stats.length === 0) return { ok: false, reason: 'service', detail: 'PDB 无可解析残基' }
  await writeCache(key, pdbText, {
    savedAt: Date.now(), sequenceLength: stats.length, meanPlddt: stats.meanPlddt,
    fracVeryHigh: stats.fracVeryHigh, fracVeryLow: stats.fracVeryLow,
  })
  return { ok: true, cacheKey: key, pdbText, stats, fromCache: false, embeddable: true }
}
