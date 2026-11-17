'use client'

/**
 * 高通量评估输入面板（v2.22）— 嵌入 InputPanel 的「高通量」Tab。
 *
 * 输入契约：「;」分隔组（一组 = 一份独立报告，按复合物批量评估出合并报告），
 * 组内「,」分隔靶点；组内仅一个靶点 = 独立评估。
 * 实时解析预览（组矩阵 + 复合物/单靶点徽章）+ 最近运行历史（恢复 / 回看 / 删除）。
 */

import { AlertTriangle, FileStack, Play, RotateCcw, Trash2, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { formatDateTime } from './format'
import type { HTRunState } from './types'

export interface HighThroughputPanelProps {
  value: string
  onChange: (v: string) => void
  parsed: { groups: string[][]; invalid: string[]; duplicates: string[] }
  recentRuns: HTRunState[]
  onResumeRun: (id: string) => void
  onDeleteRun: (id: string) => void
}

const inputBase =
  'w-full rounded-lg border border-input bg-card text-foreground outline-none transition-[border-color,box-shadow] duration-200 placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20 dark:placeholder:text-muted-foreground/60'

function runStatusPill(run: HTRunState): { label: string; cls: string } {
  switch (run.status) {
    case 'running':
      return { label: '进行中', cls: 'border-primary/40 bg-primary/[0.07] text-primary' }
    case 'paused':
      return { label: '已暂停（限流）', cls: 'border-amber-500/40 bg-amber-500/[0.08] text-amber-600 dark:text-amber-400' }
    case 'interrupted':
      return { label: '已中断（可恢复）', cls: 'border-amber-500/40 bg-amber-500/[0.08] text-amber-600 dark:text-amber-400' }
    default:
      return { label: '已完成', cls: 'border-emerald-500/40 bg-emerald-500/[0.08] text-emerald-600 dark:text-emerald-400' }
  }
}

export function HighThroughputPanel({ value, onChange, parsed, recentRuns, onResumeRun, onDeleteRun }: HighThroughputPanelProps) {
  const totalTargets = parsed.groups.reduce((n, g) => n + g.length, 0)

  return (
    <div className="flex flex-col gap-2.5">
      <Textarea
        aria-label="高通量分组输入"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={
          '按组输入 UniProt ID — 组间用分号「;」分隔，组内用逗号「,」分隔：\n'
          + 'P04637, P00533, Q9Y6K9; O14746\n'
          + 'Q04206; Q14296, Q8N5K9\n'
          + '（组内多个靶点按复合物批量评估并出合并报告；单个靶点则独立评估）'
        }
        className={cn(inputBase, 'min-h-[128px] resize-y px-3.5 py-2.5 font-mono text-[13px] leading-[22px] uppercase placeholder:font-sans placeholder:normal-case placeholder:text-[12px] placeholder:leading-[20px]')}
        spellCheck={false}
      />

      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/60 px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
          <FileStack className="size-3" aria-hidden />
          {parsed.groups.length} 组 · {totalTargets} 靶点
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/60 px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
          <Zap className="size-3" aria-hidden />
          逐组出报告 · 限流自动暂停
        </span>
        {parsed.groups.length > 0 && (
          <span className="font-mono text-[10px] text-muted-foreground/70">
            复合物组 {parsed.groups.filter((g) => g.length > 1).length} · 单靶点组 {parsed.groups.filter((g) => g.length === 1).length}
          </span>
        )}
      </div>

      {/* 分组预览：每组一行（组号 + 靶点 chips + 复合物/单靶点徽章） */}
      {parsed.groups.length > 0 && (
        <ol className="flex flex-col gap-1.5">
          {parsed.groups.map((g, i) => (
            <li key={i} className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-muted/40 px-2.5 py-1.5">
              <span className="shrink-0 rounded-md bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-primary">
                G{String(i + 1).padStart(2, '0')}
              </span>
              {g.map((t) => (
                <span key={t} className="rounded-md border border-border bg-card px-1.5 py-0.5 font-mono text-[11px] text-foreground/90">
                  {t}
                </span>
              ))}
              <span
                className={cn(
                  'ml-auto shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[9.5px] font-semibold',
                  g.length > 1 ? 'bg-violet-500/10 text-violet-600 dark:text-violet-400' : 'bg-muted text-muted-foreground',
                )}
                title={g.length > 1 ? '组内多靶点：关系判断 → 逐靶点评估 → 合并评估报告' : '单靶点独立评估，独立报告'}
              >
                {g.length > 1 ? `复合物 · ${g.length} 靶点` : '单靶点 · 独立评估'}
              </span>
            </li>
          ))}
        </ol>
      )}

      {parsed.invalid.length > 0 && (
        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
          无效 UniProt ID（不符合编号规则，将被忽略）：{parsed.invalid.join('、')}
        </p>
      )}
      {parsed.duplicates.length > 0 && (
        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
          重复靶点已自动去重（仅保留首次出现的组）：{parsed.duplicates.join('、')}
        </p>
      )}

      <p className="text-[11px] leading-relaxed text-muted-foreground/80">
        每组按现有复合物批量评估链路执行（靶点关系判断 → 并发评估 → 合并评估报告），组间串行推进；
        遇 LLM 限流 / 服务配额时自动暂停，配额恢复后可从断点重新开始（已完成的组不会重复评估）。
        每组报告与运行日志在完成后均保留可回看。
      </p>

      {/* 最近高通量运行（恢复断点 / 回看结果） */}
      {recentRuns.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-2.5">
          <p className="lin-eyebrow text-muted-foreground/80">Recent Runs · 最近高通量运行</p>
          <ol className="flex flex-col gap-1">
            {recentRuns.slice(0, 3).map((r) => {
              const pill = runStatusPill(r)
              return (
                <li key={r.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border/70 bg-muted/30 px-2.5 py-1.5">
                  <span className={cn('rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium', pill.cls)}>{pill.label}</span>
                  <span className="font-mono text-[11px] text-foreground/90">
                    {r.groups.length} 组 · {r.totalTargetCount} 靶点
                  </span>
                  <span className="font-mono text-[10px] text-muted-foreground/70">{formatDateTime(new Date(r.createdAt).toISOString())}</span>
                  <span className="ml-auto flex items-center gap-1">
                    {r.status !== 'done' ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => onResumeRun(r.id)}
                        className="h-7 gap-1 rounded-lg px-2.5 text-[11px] font-medium"
                        title={r.status === 'paused' ? '从断点恢复运行' : '接上仍在执行的作业，从断点继续'}
                      >
                        <RotateCcw className="size-3" aria-hidden />
                        恢复运行
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => onResumeRun(r.id)}
                        className="h-7 gap-1 rounded-lg px-2.5 text-[11px] font-medium"
                        title="回看该次运行的组结果与日志"
                      >
                        <Play className="size-3" aria-hidden />
                        回看
                      </Button>
                    )}
                    <button
                      type="button"
                      onClick={() => onDeleteRun(r.id)}
                      aria-label="删除该运行记录"
                      className="flex size-7 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-accent hover:text-red-600"
                    >
                      <Trash2 className="size-3" />
                    </button>
                  </span>
                </li>
              )
            })}
          </ol>
        </div>
      )}
    </div>
  )
}
