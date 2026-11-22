'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  Search,
  Terminal,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { toast } from '@/hooks/use-toast'
import { logLevel, toLogLines } from './format'

/**
 * 评估日志控制台（运行期实时 + 完成后回看共用）。
 *
 * v2.21 重构（替换旧 LogCard 单向滚动的三条硬伤）：
 *  1. 智能跟随：live 模式默认贴底自动滚动，用户上翻阅读时自动暂停
 *     （不再把人拽回底部），提供「回到底部 · 跟随最新」浮动按钮；
 *     滚回底部自动恢复跟随。
 *  2. 回看工具：级别过滤（全部 / 仅警告与错误）、关键字搜索、
 *     复制全文、下载 .txt（含被折叠的完整行）、展开/收起高度。
 *  3. 行号定位：每行标注原始行号（与下载全文一致，方便报错时引用）。
 *
 * live=false（结果页/错误页回看）：默认更高的静态视口，不自动滚动。
 */

/** 视口内最多渲染的行数（超长作业防止 DOM 过大；完整内容仍可复制/下载） */
const MAX_RENDER = 1500

export interface EvalLogConsoleProps {
  logs: string[]
  /** 卡片标题（live 默认「实时日志」，static 建议「运行日志」） */
  title?: string
  /** live=true（默认）：自动跟随滚动；false：静态回看 */
  live?: boolean
  className?: string
}

type LevelFilter = 'all' | 'issues'

interface LogRow {
  /** 原始行号（1-based，与复制/下载全文一致） */
  no: number
  text: string
  level: 'info' | 'warn' | 'error'
}

export function EvalLogConsole({ logs, title, live = true, className }: EvalLogConsoleProps) {
  const [levelFilter, setLevelFilter] = useState<LevelFilter>('all')
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const [paused, setPaused] = useState(false)

  const scrollRef = useRef<HTMLDivElement>(null)
  /** 跟随开关（用户在底部 = 跟随；上翻 = 暂停） */
  const followRef = useRef(true)

  const heading = title ?? (live ? '实时日志' : '运行日志')

  /** 全量行 + 级别统计 */
  const rows: LogRow[] = useMemo(
    () => toLogLines(logs).map((text, i) => ({ no: i + 1, text, level: logLevel(text) })),
    [logs],
  )
  const warnCount = useMemo(() => rows.filter(r => r.level === 'warn').length, [rows])
  const errCount = useMemo(() => rows.filter(r => r.level === 'error').length, [rows])

  /** 过滤（级别 + 关键字）→ 截断到最近 MAX_RENDER 行 */
  const filtered: LogRow[] = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter(r => {
      if (levelFilter === 'issues' && r.level === 'info') return false
      if (q && !r.text.toLowerCase().includes(q)) return false
      return true
    })
  }, [rows, levelFilter, query])
  const hiddenCount = Math.max(0, filtered.length - MAX_RENDER)
  const visibleRows = hiddenCount > 0 ? filtered.slice(-MAX_RENDER) : filtered

  // live 模式：有新内容且处于跟随态 → 贴底
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !live || !followRef.current) return
    el.scrollTop = el.scrollHeight
  }, [filtered.length, live])

  const handleScroll = () => {
    if (!live) return
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    followRef.current = atBottom
    setPaused(!atBottom)
  }

  const resumeFollow = () => {
    const el = scrollRef.current
    followRef.current = true
    setPaused(false)
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }

  const copyAll = async () => {
    const text = rows.map(r => r.text).join('\n')
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        // 非安全上下文（http）降级
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        ta.remove()
      }
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
      toast({ title: '日志已复制', description: `共 ${rows.length} 行（含未在视口内展示的完整内容）` })
    } catch {
      toast({ title: '复制失败', description: '浏览器未授权剪贴板访问，可改用「下载日志」', variant: 'destructive' })
    }
  }

  const downloadAll = () => {
    try {
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
      const blob = new Blob([rows.map(r => r.text).join('\n')], {
        type: 'text/plain;charset=utf-8',
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `TargetEval_log_${stamp}.txt`
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch {
      toast({ title: '下载失败', description: '日志文件生成失败，可改用「复制」', variant: 'destructive' })
    }
  }

  const filterActive = levelFilter !== 'all' || query.trim() !== ''
  const issuesOnly = levelFilter === 'issues'

  return (
    <Card className={cn('gap-3 rounded-xl border-border bg-card shadow-none', className)}>
      <CardContent className="flex flex-col gap-2.5 px-5 py-4">
        {/* 工具栏：标题 + 行数/级别统计 + 过滤/搜索/操作 */}
        <div className="flex flex-wrap items-center gap-2">
          <Terminal className="size-3.5 shrink-0 text-muted-foreground/80" aria-hidden />
          <h3 className="lin-eyebrow shrink-0 text-muted-foreground">{heading}</h3>
          <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[10px] tabular-nums text-muted-foreground/85">
            {filtered.length !== rows.length ? `${filtered.length}/${rows.length} 行` : `${rows.length} 行`}
            {errCount > 0 && <span className="text-red-500/90">·{errCount} 错误</span>}
            {warnCount > 0 && <span className="text-amber-500/90">·{warnCount} 警告</span>}
          </span>

          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            {/* 级别过滤 */}
            <div
              className="flex items-center rounded-md border border-border bg-muted/50 p-0.5"
              role="group"
              aria-label="日志级别过滤"
            >
              {(
                [
                  { key: 'all', label: '全部' },
                  { key: 'issues', label: '警告/错误' },
                ] as const
              ).map(f => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setLevelFilter(f.key)}
                  aria-pressed={levelFilter === f.key}
                  className={cn(
                    'rounded-[5px] px-2 py-0.5 font-mono text-[10px] transition-colors',
                    levelFilter === f.key
                      ? 'bg-card text-foreground shadow-[0_1px_2px_rgb(22_23_29/0.08)]'
                      : 'text-muted-foreground/85 hover:text-foreground',
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>

            {/* 搜索 */}
            <div className="relative">
              <Search
                className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground/50"
                aria-hidden
              />
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="筛选…"
                aria-label="日志关键字筛选"
                className="h-7 w-24 rounded-md border border-border bg-muted/50 pr-6 pl-6 font-mono text-[11px] text-foreground placeholder:text-muted-foreground/50 focus:border-ring focus:outline-none sm:w-32"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label="清除筛选"
                  className="absolute top-1/2 right-1.5 -translate-y-1/2 text-muted-foreground/80 hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              )}
            </div>

            {/* 复制 / 下载 / 展开 */}
            <Button
              variant="outline"
              size="sm"
              onClick={copyAll}
              className="h-7 gap-1 rounded-md px-2 font-mono text-[10px]"
              title="复制全部日志"
            >
              {copied ? <Check className="size-3 text-emerald-600" /> : <Copy className="size-3" />}
              {copied ? '已复制' : '复制'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={downloadAll}
              className="h-7 gap-1 rounded-md px-2 font-mono text-[10px]"
              title="下载完整日志（.txt）"
            >
              <Download className="size-3" />
              下载
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setExpanded(v => !v)}
              aria-expanded={expanded}
              className="h-7 gap-1 rounded-md px-2 font-mono text-[10px]"
              title={expanded ? '收起日志高度' : '展开日志高度'}
            >
              {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
              {expanded ? '收起' : '展开'}
            </Button>
          </div>
        </div>

        {/* 终端视口 */}
        <div className="relative">
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            role="log"
            aria-live={live ? 'polite' : 'off'}
            aria-label={`${heading}滚动区`}
            className={cn(
              'eval-scroll lin-terminal overflow-y-auto rounded-lg p-3',
              expanded ? 'max-h-[70vh] min-h-48' : live ? 'max-h-72 min-h-48' : 'max-h-96 min-h-40',
            )}
          >
            {visibleRows.length === 0 ? (
              <p className="font-mono text-[11px] text-[#62666d]">
                {rows.length === 0
                  ? live
                    ? '等待日志输出…'
                    : '本作业没有留存日志'
                  : filterActive
                    ? '没有匹配当前筛选的日志行'
                    : ''}
              </p>
            ) : (
              <>
                {hiddenCount > 0 && (
                  <p className="mb-2 rounded border border-dashed border-[#2e3237] px-2 py-1 font-mono text-[10px] text-[#8a8f98]">
                    ↑ 前方 {hiddenCount} 行未在视口渲染（复制/下载仍包含全文）· 仅展示最近 {MAX_RENDER} 行
                  </p>
                )}
                {visibleRows.map(r => (
                  <div key={r.no} className="flex gap-2.5">
                    <span
                      className="lin-terminal-line w-7 shrink-0 text-right text-[10px] leading-relaxed tabular-nums opacity-40 select-none"
                      aria-hidden
                    >
                      {r.no}
                    </span>
                    <span
                      className="lin-terminal-line min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed"
                      data-level={r.level}
                    >
                      {r.text}
                    </span>
                  </div>
                ))}
              </>
            )}
          </div>

          {/* 暂停跟随时的浮动按钮（仅 live） */}
          {live && paused && (
            <button
              type="button"
              onClick={resumeFollow}
              className="absolute bottom-2 left-1/2 -translate-x-1/2 inline-flex items-center gap-1.5 rounded-full border border-[#2e3237] bg-[#16181c] px-3 py-1 font-mono text-[10px] text-[#8a8f98] shadow-lg transition-colors hover:text-white"
            >
              <ArrowDown className="size-3" />
              已暂停跟随 · 回到底部
            </button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
