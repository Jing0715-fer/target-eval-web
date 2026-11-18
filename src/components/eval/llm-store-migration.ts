/**
 * v2.20.1：LLM 引擎本地存储（localStorage）— MiniMax 端点纠偏迁移（纯函数，无浏览器依赖）。
 *
 * 背景（三端点分立，两平台 Key 不通用）：
 *  - api.minimax.cn/v1   国内新端点（platform.minimax.cn 文档）— MiniMax-M3.1-Flash / M3
 *  - api.minimax.io/v1   国际端点（platform.minimax.io 文档）— 需国际 Key
 *  - api.minimaxi.com    旧国内端点（chatcompletion_v2）— 只服务 M2.x 系列
 *                        （「模型列表只显示到 M2.7」的原始根因：/v1/models 列表仅含 M2.x）
 *
 * v2.20 曾把 'minimax' 主条目默认切到 api.minimax.io/v1（国际端点）— 国内 Key 打过去
 * 得到 HTTP 401 "invalid api key (2049)"（用户实测报错）。v2.20.1 纠偏：主条目回归
 * 国内端点 api.minimax.cn/v1，国际端点独立为 'minimax-intl' 条目。
 */

/** localStorage 存储结构：激活供应商 + 每供应商一条完整配置 */
export interface LocalEngineStore {
  active: string | null
  providers: Record<string, {
    label?: string
    baseUrl: string
    apiKey: string
    model: string
    savedAt: number
  }>
}

/** 国内新端点（v2.20.1 主条目默认） */
export const MINIMAX_CN_BASE = 'https://api.minimax.cn/v1'
/** 国际端点（'minimax-intl' 条目） */
export const MINIMAX_INTL_BASE = 'https://api.minimax.io/v1'

/**
 * v2.20 迁移（v2.20.1 修正目标端点）：v2.18 及以前本地存的 'minimax' 条目指向旧国内
 * 端点 api.minimaxi.com，拆两条：
 *  - 'minimax-legacy'：原样保留（Key + M2 模型，旧工作流不断，面板里一键切回）
 *  - 'minimax'：升级为国内新端点 api.minimax.cn/v1 + 默认模型 MiniMax-M3.1-Flash，
 *    Key 沿用（同一国内平台换域名，账号 Key 通用）
 * 自定义 baseUrl（反代/中转等非官方域名）不动 — 尊重用户自己的端点选择。
 */
export function migrateMinimaxEndpoint(s: LocalEngineStore): boolean {
  const old = s.providers.minimax
  if (!old) return false
  if (!/api\.minimaxi\.com/i.test(old.baseUrl ?? '')) return false
  if (s.providers['minimax-legacy']) return false // 已迁移过
  s.providers['minimax-legacy'] = {
    label: old.label ?? 'MiniMax 旧版 API',
    baseUrl: old.baseUrl,
    apiKey: old.apiKey ?? '',
    model: old.model ?? 'MiniMax-M2.7',
    savedAt: Date.now(),
  }
  s.providers.minimax = {
    label: 'MiniMax（国内）',
    baseUrl: MINIMAX_CN_BASE,
    apiKey: old.apiKey ?? '',
    model: /minimax-m3/i.test(old.model ?? '') ? old.model : 'MiniMax-M3.1-Flash',
    savedAt: Date.now(),
  }
  return true
}

/**
 * v2.20.1 纠偏迁移：凡 'minimax' 主条目仍指向 api.minimax.io 的（v2.20 版写入或其
 * 迁移产物 — 当时误把国内用户切到了国际端点）：
 *  - 原条目原样挪到 'minimax-intl'（Key/模型一字不丢；若那把 Key 本就是国内的，
 *    在「国际版」上仍会 401，面板错误提示会引导切对端点）
 *  - 'minimax' 主条目重建为国内端点 api.minimax.cn/v1 — Key 优先取 'minimax-legacy'
 *    存的国内 Key（v2.20 迁移时 Key 被原样带到 .io 条目，两处等价，取得到即可）
 * 已存 'minimax-intl' 且带 Key（用户自己保存过国际 Key）不覆盖 — 只重建主条目。
 * 幂等：迁移后 baseUrl 为 .cn，不再匹配；自定义/反代 baseUrl 不受影响。
 */
export function migrateMinimaxDomesticDefault(s: LocalEngineStore): boolean {
  const cur = s.providers.minimax
  if (!cur) return false
  if (!/^https:\/\/api\.minimax\.io\/?/i.test(cur.baseUrl ?? '')) return false
  if (!s.providers['minimax-intl'] || !(s.providers['minimax-intl'].apiKey ?? '').trim()) {
    s.providers['minimax-intl'] = {
      label: 'MiniMax 国际版',
      baseUrl: cur.baseUrl,
      apiKey: cur.apiKey ?? '',
      model: cur.model ?? 'MiniMax-M3.1-Flash',
      savedAt: Date.now(),
    }
  }
  const legacyKey = (s.providers['minimax-legacy']?.apiKey ?? '').trim()
  const domesticKey = legacyKey || (cur.apiKey ?? '').trim()
  s.providers.minimax = {
    label: 'MiniMax（国内）',
    baseUrl: MINIMAX_CN_BASE,
    apiKey: domesticKey,
    model: /minimax-m3/i.test(cur.model ?? '') ? cur.model : 'MiniMax-M3.1-Flash',
    savedAt: Date.now(),
  }
  return true
}
