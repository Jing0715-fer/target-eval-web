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
  resetLlmConfig,
  saveLlmConfig,
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
  const [savedKeyMasked, setSavedKeyMasked] = useState('')
  const [model, setModel] = useState('')

  // 模型列表
  const [models, setModels] = useState<string[]>([])
  const [modelsOpen, setModelsOpen] = useState(false)
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState<string | null>(null)

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

  // 打开时加载配置
  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const data = await fetchLlmConfig()
      setProviders(data.providers)
      setHasActive(Boolean(data.active))
      setActiveSummary(data.engineSummary)
      if (data.active) {
        setProviderKey(data.active.providerKey)
        setBaseUrl(data.active.baseUrl)
        setModel(data.active.model)
        setSavedKeyMasked(data.active.hasKey ? data.active.apiKeyMasked : '')
      } else {
        setProviderKey('builtin')
        setBaseUrl('')
        setModel('')
        setSavedKeyMasked('')
      }
      setApiKey('')
      setModels([])
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

  // 切换供应商：预填 Base URL / 默认模型
  const selectProvider = (p: LlmProviderLite) => {
    if (p.key === providerKey) return
    setProviderKey(p.key)
    setBaseUrl(p.baseUrl)
    setModel(p.defaultModel)
    setModels([])
    setModelsOpen(false)
    setModelsError(null)
    setTest({ kind: 'idle' })
    setSaveMsg(null)
    // 已保存的相同供应商 Key 提示
    setSavedKeyMasked('')
    setApiKey('')
  }

  // 获取模型列表
  const loadModels = async () => {
    if (!provider || isBuiltin) return
    setModelsLoading(true)
    setModelsError(null)
    setModelsOpen(true)
    try {
      const data = await fetchLlmModels({ providerKey, baseUrl, apiKey })
      setModels(data.models?.map(m => m.id) ?? [])
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

  // 保存并启用
  const save = async () => {
    setSaving(true)
    setSaveMsg(null)
    try {
      const r = await saveLlmConfig({
        providerKey,
        baseUrl,
        apiKey,
        model,
        keepKey: apiKey.trim() === '',
      })
      setSaveMsg({ ok: true, text: `已启用 ${r.engineSummary}` })
      setHasActive(Boolean(r.active))
      setActiveSummary(r.engineSummary)
      onEngineChange?.(r.engineSummary, !r.active)
      // 刷新已保存 Key 掩码
      setApiKey('')
      try {
        const data = await fetchLlmConfig()
        setSavedKeyMasked(data.active?.hasKey ? (data.active?.apiKeyMasked ?? '') : '')
      } catch { /* 忽略 */ }
    } catch (e) {
      setSaveMsg({ ok: false, text: e instanceof Error ? e.message : '保存失败' })
    } finally {
      setSaving(false)
    }
  }

  // 恢复内置
  const reset = async () => {
    setResetting(true)
    setSaveMsg(null)
    try {
      const r = await resetLlmConfig()
      setProviderKey('builtin')
      setBaseUrl('')
      setModel('')
      setApiKey('')
      setSavedKeyMasked('')
      setHasActive(false)
      setActiveSummary(r.engineSummary)
      setSaveMsg({ ok: true, text: '已恢复内置引擎（Z.ai GLM-4.6）' })
      onEngineChange?.(r.engineSummary, true)
    } catch (e) {
      setSaveMsg({ ok: false, text: e instanceof Error ? e.message : '恢复失败' })
    } finally {
      setResetting(false)
    }
  }

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

  const filteredModels = useMemo(() => {
    const q = model.trim().toLowerCase()
    if (!q) return models
    return models.filter(m => m.toLowerCase().includes(q))
  }, [models, model])

  const canSave = !isBuiltin && baseUrl.trim() !== '' && model.trim() !== '' && (!provider?.needsKey || apiKey.trim() !== '' || savedKeyMasked !== '')

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
                评估分析与评估表智能解析由该引擎驱动；内置引擎开箱即用，也可切换至任意主流供应商或自定义 OpenAI 兼容端点。
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
                          'flex min-h-[60px] flex-col items-start gap-0.5 rounded-lg border p-2.5 text-left outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/30',
                          selected
                            ? 'border-primary bg-primary/[0.06] ring-1 ring-primary'
                            : 'border-border bg-card hover:border-ring/60',
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
                      className="h-10 rounded-lg font-mono text-xs"
                      spellCheck={false}
                      autoComplete="off"
                    />
                  </section>

                  {/* API Key */}
                  <section className="flex flex-col gap-1.5">
                    <Label htmlFor="llm-apikey" className="lin-eyebrow text-muted-foreground">
                      API Key {provider && !provider.needsKey && <span className="normal-case text-muted-foreground/70">（该供应商可不填）</span>}
                    </Label>
                    <div className="relative">
                      <Input
                        id="llm-apikey"
                        type={showKey ? 'text' : 'password'}
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        placeholder={savedKeyMasked ? `已保存 ${savedKeyMasked}，留空沿用` : (provider?.needsKey ? '必填' : '可选')}
                        className="h-10 rounded-lg pr-10 font-mono text-xs"
                        spellCheck={false}
                        autoComplete="off"
                      />
                      <button
                        type="button"
                        onClick={() => setShowKey(v => !v)}
                        aria-label={showKey ? '隐藏 API Key' : '显示 API Key'}
                        className="absolute top-1/2 right-2.5 -translate-y-1/2 rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
                      >
                        {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                      </button>
                    </div>
                    <p className="text-[11px] leading-relaxed text-muted-foreground/70">
                      Key 仅保存在本地数据库用于服务端调用，不会出现在评估报告或前端页面中。
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
                          if (models.length) setModelsOpen(true)
                        }}
                        onFocus={() => { if (models.length) setModelsOpen(true) }}
                        placeholder={provider?.defaultModel || '模型名，如 gpt-4o'}
                        className="h-10 rounded-lg font-mono text-xs"
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
                        <div className="eval-scroll absolute top-full right-0 left-0 z-10 mt-1.5 max-h-52 overflow-y-auto rounded-lg border border-border bg-popover py-1 shadow-lg">
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
                              <div className="px-3 py-1 font-mono text-[10px] tracking-wider text-muted-foreground/70 uppercase">
                                {filteredModels.length > 0 ? `${filteredModels.length} / ${models.length} models` : `无匹配 — 共 ${models.length} 个，清空输入查看全部`}
                              </div>
                              {filteredModels.map(m => (
                                <button
                                  key={m}
                                  type="button"
                                  onClick={() => {
                                    setModel(m)
                                    setModelsOpen(false)
                                  }}
                                  className={cn(
                                    'flex w-full items-center justify-between px-3 py-1.5 text-left font-mono text-xs transition-colors hover:bg-accent',
                                    m === model ? 'text-primary' : 'text-foreground/80',
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
                  className="h-9 rounded-lg bg-primary px-4 text-xs font-semibold text-primary-foreground hover:bg-[#7a84dc] sm:ml-auto dark:hover:bg-[#828fff]"
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
