'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BadgeCheck,
  Check,
  ChevronDown,
  CircleAlert,
  Eye,
  EyeOff,
  LoaderCircle,
  PlugZap,
  RefreshCw,
  RotateCcw,
  Save,
  Sparkles,
} from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import {
  fetchLlmConfig,
  fetchLlmModels,
  getEngineProviderEntry,
  getLlmEngineOverride,
  setLlmEngineOverride,
  testLlmConnection,
} from './api'
import type { LlmProviderLite } from './types'

export interface LlmConfigPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 保存/重置后回调（刷新页眉页脚的引擎状态） */
  onEngineChange?: (summary: string, isBuiltin: boolean) => void
}

type TestState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; latencyMs: number; reply: string }
  | { kind: 'error'; message: string }

/** LLM 分析引擎配置面板：供应商网格 + Base URL / Key / 模型（自动获取列表）+ 测试 + 启用 */
export function LlmConfigPanel({ open, onOpenChange, onEngineChange }: LlmConfigPanelProps) {
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [providers, setProviders] = useState<LlmProviderLite[]>([])
  const [activeSummary, setActiveSummary] = useState('Z.ai GLM-4.6（内置）')
  const [hasActive, setHasActive] = useState(false)

  // 表单
  const [providerKey, setProviderKey] = useState('builtin')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')

  // 模型列表
  const [models, setModels] = useState<string[]>([])
  const [modelsOpen, setModelsOpen] = useState(false)
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState<string | null>(null)
  // v2.20：用户自拉取/选中后是否手动键入过 — 预填值不作过滤词（防下拉只剩精确匹配一条）
  const [modelQueryDirty, setModelQueryDirty] = useState(false)

  // 测试 / 保存
  const [test, setTest] = useState<TestState>({ kind: 'idle' })
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [resetting, setResetting] = useState(false)

  const [showKey, setShowKey] = useState(false)
  const modelsListRef = useRef<HTMLDivElement | null>(null)

  const provider = useMemo(
    () => providers.find(p => p.key === providerKey) ?? null,
    [providers, providerKey],
  )
  const isBuiltin = providerKey === 'builtin'

  // 打开时加载配置（v2.19：配置读浏览器 localStorage，服务端仅返回供应商表）
  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const data = await fetchLlmConfig()
      setProviders(data.providers)
      const llm = getLlmEngineOverride()
      setHasActive(Boolean(llm))
      setActiveSummary(llm ? `${llm.label || llm.providerKey} · ${llm.model}` : 'Z.ai GLM-4.6（内置）')
      if (llm) {
        setProviderKey(llm.providerKey)
        setBaseUrl(llm.baseUrl ?? '')
        setModel(llm.model)
        setApiKey(llm.apiKey ?? '')
      } else {
        setProviderKey('builtin')
        setBaseUrl('')
        setModel('')
        setApiKey('')
      }
      setModels([])
      setModelQueryDirty(false)
      setTest({ kind: 'idle' })
      setSaveMsg(null)
      setModelsError(null)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : '配置加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  // 切换供应商：v2.19 — 本地保存过则自动回填（含 Key，切回无需重输），否则预填默认
  const selectProvider = (p: LlmProviderLite) => {
    if (p.key === providerKey) return
    setProviderKey(p.key)
    const entry = p.key === 'builtin' ? null : getEngineProviderEntry(p.key)
    setBaseUrl(entry?.baseUrl || p.baseUrl)
    setModel(entry?.model || p.defaultModel)
    setApiKey(entry?.apiKey ?? '')
    setModels([])
    setModelQueryDirty(false)
    setModelsOpen(false)
    setModelsError(null)
    setTest({ kind: 'idle' })
    setSaveMsg(null)
  }

  // 获取模型列表（v2.20：拉取成功后重置 dirty — 预填模型名不作过滤词，展示完整列表）
  const loadModels = async () => {
    if (!provider || isBuiltin) return
    setModelsLoading(true)
    setModelsError(null)
    setModelsOpen(true)
    try {
      const data = await fetchLlmModels({ providerKey, baseUrl, apiKey })
      setModels(data.models?.map(m => m.id) ?? [])
      setModelQueryDirty(false)
    } catch (e) {
      setModels([])
      setModelsError(e instanceof Error ? e.message : '获取失败')
    } finally {
      setModelsLoading(false)
    }
  }

  // 测试连接
  const runTest = async () => {
    setTest({ kind: 'loading' })
    setSaveMsg(null)
    try {
      const r = await testLlmConnection({ providerKey, baseUrl, apiKey, model })
      setTest({ kind: 'ok', latencyMs: r.latencyMs ?? 0, reply: r.reply ?? '' })
    } catch (e) {
      setTest({ kind: 'error', message: e instanceof Error ? e.message : '测试失败' })
    }
  }

  // 保存并启用（v2.19：写入浏览器 localStorage — 不发送服务端，仅本人可用）
  const save = () => {
    setSaving(true)
    setSaveMsg(null)
    try {
      if (isBuiltin) {
        setLlmEngineOverride(null)
        setHasActive(false)
        setActiveSummary('Z.ai GLM-4.6（内置）')
        setSaveMsg({ ok: true, text: '已启用内置引擎（Z.ai GLM-4.6）' })
        onEngineChange?.('Z.ai GLM-4.6（内置）', true)
        return
      }
      const summary = `${provider?.label ?? providerKey} · ${model.trim()}`
      setLlmEngineOverride({
        providerKey,
        label: provider?.label,
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        model: model.trim(),
      })
      setSaveMsg({ ok: true, text: `已启用 ${summary} — 配置已保存到本浏览器，仅你本人可用` })
      setHasActive(true)
      setActiveSummary(summary)
      onEngineChange?.(summary, false)
    } finally {
      setSaving(false)
    }
  }

  // 恢复内置（v2.19：清除本地激活；各供应商已存 Key 保留在本浏览器，切回自动回填）
  const reset = () => {
    setResetting(true)
    setSaveMsg(null)
    try {
      setLlmEngineOverride(null)
      setProviderKey('builtin')
      setBaseUrl('')
      setModel('')
      setApiKey('')
      setHasActive(false)
      setActiveSummary('Z.ai GLM-4.6（内置）')
      setSaveMsg({ ok: true, text: '已恢复内置引擎 — 各供应商已保存的 Key 仍保留在本浏览器，切换回去即自动回填' })
      onEngineChange?.('Z.ai GLM-4.6（内置）', true)
    } finally {
      setResetting(false)
    }
  }

  // v2.20.2：获取成功且下拉打开时，自动滚到当前模型行 — 列表按字母序排列时
  // 最新模型（如 MiniMax-M3.1-Flash）排在尾部，视口有限会被折叠在滚动区底下
  // 看不见（用户实测「只显示到 M2.7」的根因）；主动滚过去让用户第一眼看到预填值。
  const scrollModelIntoView = useCallback(() => {
    if (!modelsOpen || !models.length) return
    requestAnimationFrame(() => {
      const cont = modelsListRef.current?.querySelector('.eval-scroll')
      const q = model.trim().toLowerCase()
      const target = q
        ? Array.from(cont?.querySelectorAll('button[data-model]') ?? []).find(b => b.getAttribute('data-model')?.toLowerCase() === q)
        : undefined
      if (target) (target as HTMLElement).scrollIntoView({ block: 'center' })
    })
  }, [modelsOpen, models.length, model])
  useEffect(() => { scrollModelIntoView() }, [scrollModelIntoView])

  // 点击模型列表外部关闭
  useEffect(() => {
    if (!modelsOpen) return
    const onClick = (e: MouseEvent) => {
      if (modelsListRef.current && !modelsListRef.current.contains(e.target as Node)) {
        setModelsOpen(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [modelsOpen])

  // v2.20：过滤陷阱修复 — 输入框预填的模型名（默认/已保存值）曾被当作过滤词，
  // 点「获取模型列表」后列表被过滤得只剩精确匹配一条（如只剩 MiniMax-M2.7），
  // 看起来像「模型不全」。未手动键入时展示完整列表，键入后才按输入过滤。
  const filteredModels = useMemo(() => {
    if (!modelQueryDirty) return models
    const q = model.trim().toLowerCase()
    if (!q) return models
    return models.filter(m => m.toLowerCase().includes(q))
  }, [models, model, modelQueryDirty])

  const canSave = !isBuiltin && baseUrl.trim() !== '' && model.trim() !== '' && (!provider?.needsKey || apiKey.trim() !== '')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="eval-scroll max-h-[88vh] max-w-2xl overflow-y-auto rounded-xl border-border p-0 sm:max-w-2xl">
        {/* 刊头（右侧留出关闭按钮空间，避免与「当前引擎」徽标重叠） */}
        <DialogHeader className="border-b border-border px-6 pt-6 pb-4">
          <div className="flex items-start justify-between gap-4 pr-10 sm:pr-12">
            <div>
              <p className="lin-eyebrow text-primary">LLM Engine · 分析引擎</p>
              <DialogTitle className="mt-1.5 text-xl font-semibold tracking-[-0.02em] text-foreground">
                LLM 分析引擎配置
              </DialogTitle>
              <DialogDescription className="mt-1 text-xs leading-relaxed text-muted-foreground">
                评估分析与评估表智能解析由该引擎驱动；配置（含 API Key）保存在浏览器本地、仅你本人可用，不存服务端。内置引擎开箱即用，也可切换至任意主流供应商或自定义 OpenAI 兼容端点。
              </DialogDescription>
            </div>
            <div className="hidden shrink-0 items-center gap-1.5 rounded-md border border-primary/30 bg-primary/[0.06] px-2.5 py-1.5 font-mono text-[11px] text-primary sm:flex">
              <BadgeCheck className="size-3.5" />
              当前：{activeSummary}
            </div>
          </div>
        </DialogHeader>

        <div className="flex flex-col gap-5 px-6 py-5">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-14 text-sm text-muted-foreground">
              <LoaderCircle className="size-5 animate-spin text-primary" />
              正在读取配置…
            </div>
          ) : loadError ? (
            <div className="flex flex-col items-center gap-3 py-12">
              <p className="flex items-center gap-1.5 text-sm text-red-600 dark:text-red-400">
                <CircleAlert className="size-4" />
                {loadError}
              </p>
              <Button variant="outline" size="sm" onClick={() => void load()} className="rounded-lg">重试</Button>
            </div>
          ) : (
            <>
              {/* 供应商网格 */}
              <section aria-label="选择供应商">
                <Label className="lin-eyebrow mb-2.5 text-muted-foreground">
                  Provider · 供应商
                </Label>
                <div className="eval-scroll grid max-h-64 grid-cols-2 gap-2 overflow-y-auto pr-1 sm:grid-cols-3">
                  {providers.map(p => {
                    const selected = p.key === providerKey
                    const activeTag = hasActive && activeSummary.includes(p.label.split('（')[0])
                    return (
                      <button
                        key={p.key}
                        type="button"
                        onClick={() => selectProvider(p)}
                        aria-pressed={selected}
                        className={cn(
                          'flex min-h-[60px] flex-col items-start gap-0.5 rounded-lg border p-2.5 text-left outline-none transition-all duration-200 focus-visible:ring-[3px] focus-visible:ring-ring/30',
                          selected
                            ? 'border-primary/40 bg-primary/[0.06] ring-1 ring-primary/30'
                            : 'border-border bg-card hover:-translate-y-px hover:border-primary/30 hover:bg-accent/50',
                        )}
                      >
                        <span className={cn(
                          'flex w-full items-start gap-1.5 text-[13px] leading-tight font-semibold',
                          selected ? 'text-primary' : 'text-foreground',
                        )}>
                          {selected && <Check className="mt-0.5 size-3.5 shrink-0" />}
                          <span className="min-w-0 break-words">{p.label}</span>
                        </span>
                        <span className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                          {p.hint}
                        </span>
                        {activeTag && !selected && (
                          <span className="mt-0.5 inline-flex items-center rounded-sm bg-primary/10 px-1 font-mono text-[9px] font-semibold text-primary">
                            使用中
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              </section>

              {isBuiltin ? (
                <div className="rounded-lg border border-primary/25 bg-primary/[0.05] px-4 py-3.5 text-sm leading-relaxed text-foreground/90">
                  <span className="font-semibold">内置引擎无需配置</span>
                  <span className="text-muted-foreground"> — 由 Z.ai GLM-4.6 驱动，开箱即用。点击「保存并启用」即可（重新）启用内置引擎。</span>
                </div>
              ) : (
                <>
                  {/* Base URL */}
                  <section className="flex flex-col gap-1.5">
                    <Label htmlFor="llm-baseurl" className="lin-eyebrow text-muted-foreground">
                      API Base URL
                    </Label>
                    <Input
                      id="llm-baseurl"
                      value={baseUrl}
                      onChange={(e) => setBaseUrl(e.target.value)}
                      placeholder="https://api.example.com/v1"
                      className="h-10 rounded-lg font-mono text-xs focus-visible:ring-ring/20"
                      spellCheck={false}
                      autoComplete="off"
                    />
                  </section>

                  {/* API Key */}
                  <section className="flex flex-col gap-1.5">
                    <Label htmlFor="llm-apikey" className="lin-eyebrow text-muted-foreground">
                      API Key {provider && !provider.needsKey && <span className="normal-case text-muted-foreground/85">（该供应商可不填）</span>}
                    </Label>
                    <div className="relative">
                      <Input
                        id="llm-apikey"
                        type={showKey ? 'text' : 'password'}
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        placeholder={provider?.needsKey ? '必填（仅保存在你的浏览器本地）' : '可选'}
                        className="h-10 rounded-lg pr-10 font-mono text-xs focus-visible:ring-ring/20"
                        spellCheck={false}
                        autoComplete="off"
                      />
                      <button
                        type="button"
                        onClick={() => setShowKey(v => !v)}
                        aria-label={showKey ? '隐藏 API Key' : '显示 API Key'}
                        className="absolute top-1/2 right-2.5 -translate-y-1/2 rounded p-1 text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/20"
                      >
                        {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                      </button>
                    </div>
                    <p className="text-[11px] leading-relaxed text-muted-foreground/85">
                      Key 保存在浏览器本地（仅你本人可用）：随你发起的评估请求发送到服务器代为调用，服务端不落盘、不共享给其他用户；清除浏览器数据会同时清除已存 Key。
                    </p>
                  </section>

                  {/* 模型 */}
                  <section className="flex flex-col gap-1.5" ref={modelsListRef}>
                    <Label htmlFor="llm-model" className="lin-eyebrow text-muted-foreground">
                      Model · 模型
                    </Label>
                    <div className="relative flex gap-2">
                      <Input
                        id="llm-model"
                        value={model}
                        onChange={(e) => {
                          setModel(e.target.value)
                          setModelQueryDirty(true)
                          if (models.length) setModelsOpen(true)
                        }}
                        onFocus={() => { if (models.length) setModelsOpen(true) }}
                        placeholder={provider?.defaultModel || '模型名，如 gpt-4o'}
                        className="h-10 rounded-lg font-mono text-xs focus-visible:ring-ring/20"
                        spellCheck={false}
                        autoComplete="off"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void loadModels()}
                        disabled={modelsLoading || !provider?.supportsModels}
                        title={provider?.supportsModels ? '从供应商 API 获取模型列表' : (provider?.modelsNote || '该供应商暂不支持自动获取')}
                        className="h-10 shrink-0 rounded-lg px-3 text-xs font-medium"
                      >
                        {modelsLoading
                          ? <LoaderCircle className="size-3.5 animate-spin" />
                          : <RefreshCw className="size-3.5" />}
                        获取模型列表
                      </Button>

                      {modelsOpen && (modelsLoading || modelsError || models.length > 0) && (
                      // v2.20.2：max-h-52→max-h-80 — 拉高视口让常见 9~16 条列表一屏全见；
                      // 更长列表仍可滚动（配合 scrollModelIntoView 自动定位当前模型）
                        <div className="eval-scroll anim-fade-up absolute top-full right-0 left-0 z-10 mt-1.5 max-h-80 overflow-y-auto rounded-lg border border-border bg-popover py-1 elev-2">
                          {modelsLoading && (
                            <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
                              <LoaderCircle className="size-3.5 animate-spin" />
                              正在获取模型列表…
                            </div>
                          )}
                          {!modelsLoading && modelsError && (
                            <div className="flex flex-col gap-2 px-3 py-3 text-xs text-red-600 dark:text-red-400">
                              <span className="flex items-center gap-1.5"><CircleAlert className="size-3.5" />{modelsError}</span>
                              <span className="text-muted-foreground">可手动填写模型名后保存</span>
                            </div>
                          )}
                          {!modelsLoading && !modelsError && (
                            <>
                              <div className="px-3 py-1 font-mono text-[10px] tracking-wider text-muted-foreground/85 uppercase">
                                {modelQueryDirty
                                  ? (filteredModels.length > 0 ? `${filteredModels.length} / ${models.length} models` : `无匹配 — 共 ${models.length} 个，清空输入查看全部`)
                                  : `共 ${models.length} 个模型`}
                              </div>
                              {filteredModels.map(m => (
                                <button
                                  key={m}
                                  type="button"
                                  data-model={m}
                                  onClick={() => {
                                    setModel(m)
                                    setModelQueryDirty(false)
                                    setModelsOpen(false)
                                  }}
                                  className={cn(
                                    'flex w-full items-center justify-between px-3 py-1.5 text-left font-mono text-xs transition-colors hover:bg-accent',
                                    m === model ? 'bg-primary/[0.06] text-primary' : 'text-foreground/80',
                                  )}
                                >
                                  <span className="min-w-0 truncate">{m}</span>
                                  {m === model && <Check className="size-3.5 shrink-0" />}
                                </button>
                              ))}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                    {!provider?.supportsModels && provider?.modelsNote && (
                      <p className="text-[11px] text-amber-600 dark:text-amber-500">{provider.modelsNote}</p>
                    )}
                    {/* v2.19：需要 Key 的供应商且当前未填写 → 主动提示（Key 已存本地时切回会自动预填） */}
                    {provider?.supportsModels && provider.needsKey && apiKey.trim() === '' && (
                      <p className="text-[11px] text-amber-600 dark:text-amber-500">
                        该供应商需先填写 API Key 才能获取模型列表（也可直接手动输入模型名）
                      </p>
                    )}
                  </section>
                </>
              )}

              {/* 测试状态 */}
              {test.kind === 'loading' && (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <LoaderCircle className="size-3.5 animate-spin text-primary" />
                  正在测试连通性（最长 45s）…
                </p>
              )}
              {test.kind === 'ok' && (
                <p className="flex items-center gap-1.5 text-xs text-primary">
                  <Sparkles className="size-3.5" />
                  连接成功 · 延迟 {(test.latencyMs / 1000).toFixed(1)}s · 回复「{test.reply}」
                </p>
              )}
              {test.kind === 'error' && (
                <p className="flex items-start gap-1.5 text-xs text-red-600 dark:text-red-400">
                  <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
                  <span className="break-all">{test.message}</span>
                </p>
              )}

              {/* 保存反馈 */}
              {saveMsg && (
                <p className={cn(
                  'flex items-center gap-1.5 text-xs',
                  saveMsg.ok ? 'text-primary' : 'text-red-600 dark:text-red-400',
                )}>
                  {saveMsg.ok ? <BadgeCheck className="size-3.5" /> : <CircleAlert className="size-3.5" />}
                  {saveMsg.text}
                </p>
              )}

              {/* 操作条 */}
              <div className="flex flex-col-reverse gap-2 border-t border-border/70 pt-4 sm:flex-row sm:items-center">
                <div className="flex gap-2">
                  {!isBuiltin && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void runTest()}
                      disabled={test.kind === 'loading' || !model.trim() || !baseUrl.trim()}
                      className="h-9 rounded-lg px-3 text-xs font-medium"
                    >
                      {test.kind === 'loading'
                        ? <LoaderCircle className="size-3.5 animate-spin" />
                        : <PlugZap className="size-3.5" />}
                      测试连接
                    </Button>
                  )}
                  {hasActive && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => void reset()}
                      disabled={resetting}
                      className="h-9 rounded-lg px-3 text-xs font-medium text-muted-foreground hover:text-red-600"
                    >
                      {resetting
                        ? <LoaderCircle className="size-3.5 animate-spin" />
                        : <RotateCcw className="size-3.5" />}
                      恢复内置
                    </Button>
                  )}
                </div>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void save()}
                  disabled={saving || (isBuiltin ? false : !canSave)}
                  className="btn-brand h-9 rounded-lg px-4 text-xs font-semibold text-primary-foreground sm:ml-auto disabled:opacity-50 disabled:shadow-none"
                >
                  {saving
                    ? <LoaderCircle className="size-3.5 animate-spin" />
                    : <Save className="size-3.5" />}
                  {isBuiltin ? '启用内置引擎' : '保存并启用'}
                </Button>
              </div>

              <p className="flex items-center gap-1 text-[11px] leading-relaxed text-muted-foreground">
                <ChevronDown className="size-3 shrink-0 rotate-[-90deg]" aria-hidden />
                切换引擎后，后续评估作业的 LLM 分析与评估表智能解析将使用新引擎；已生成的报告保持不变。
              </p>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
