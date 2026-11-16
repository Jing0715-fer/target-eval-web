'use client'

import {
  CheckCircle2,
  Eye,
  FileStack,
  Layers,
  Link2,
  LoaderCircle,
  MousePointerClick,
  ShieldAlert,
  XCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { describeRelationType } from './types'
import type { BatchState } from './use-evaluation-flow'

export interface BatchBarProps {
  batch: BatchState
  /** 当前展示的作业 id */
  currentJobId?: string | null
  onSelect: (jobId: string) => void
  /** 切换到合并报告视图（关联批次） */
  onShowMerged?: () => void
  /** 当前展示靶点的可读标识（如 "P00533 · Epidermal growth factor receptor"） */
  currentJobLabel?: string | null
}

/**
 * 批量评估切换栏（docx 多 UniProt 评估）：
 * 进度态显示「批量 i/N + 当前靶点」；完成态显示各靶点状态 chips，点击切换结果。
 * v1.8：关系判定横幅（关联 → 合并报告按钮；独立 → 说明banner）+ 并发窗口双靶点进行中。
 * v1.9：切换区醒目化（用户反馈「UI 不太明显、点击看不出切换」）—
 *  「切换靶点」标签行 + 当前查看徽标（ID·蛋白名）+ 更大 chips（激活态 Eye/查看中标记）。
 * v1.10：同源家族横幅（青色系 + 一致性徽标）+ 序列归属摘要（构建已并入 N 靶点）。
 */
export function BatchBar({ batch, currentJobId, onSelect, onShowMerged, currentJobLabel }: BatchBarProps) {
  if (batch.items.length <= 1 && !batch.mergedReport) return null
  const doneCount = batch.items.filter(x => x.status === 'done').length
  const failCount = batch.items.filter(x => x.status === 'error' || x.status === 'canceled').length
  const runningCount = batch.items.filter(x => x.status === 'running').length
  const running = !batch.done
  const rel = batch.relation ?? null
  const mergedActive = batch.view === 'merged' && Boolean(batch.mergedReport)

  return (
    <div
      className="flex flex-col gap-2.5 rounded-xl border border-border bg-card px-4 py-3.5"
      role="group"
      aria-label="批量评估靶点切换"
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Layers className="size-3.5 text-primary" aria-hidden />
        <span className="font-medium text-foreground">
          {running ? '批量评估进行中' : '批量评估完成'}
        </span>
        <span className="font-mono tabular-nums text-muted-foreground/70">
          {doneCount}/{batch.total} 完成{failCount > 0 ? ` · ${failCount} 失败` : ''}
          {running && runningCount > 1 ? ` · ${runningCount} 个并行执行中` : ''}
        </span>
        {/* 批量总进度条 */}
        <span className="ml-auto flex min-w-24 items-center gap-1.5" aria-hidden>
          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <span
              className="block h-full rounded-full bg-primary transition-all"
              style={{ width: `${Math.round((batch.items.length / batch.total) * 100)}%` }}
            />
          </span>
          <span className="font-mono text-[10px] tabular-nums text-muted-foreground/70">{Math.round((batch.items.length / batch.total) * 100)}%</span>
        </span>
      </div>

      {/* 关系判定横幅（v1.8；v1.10 同源家族青色系） */}
      {batch.relationJudging && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-xs text-foreground/80">
          <LoaderCircle className="size-3.5 shrink-0 animate-spin text-primary" aria-hidden />
          正在分析 {batch.total} 个靶点之间的关联关系（同源家族 / 复合物 / 抗体-抗原 / 融合构建 / 独立项目）…
        </div>
      )}
      {!batch.relationJudging && batch.merging && (
        <div className="flex items-center gap-2 rounded-lg border border-violet-500/30 bg-violet-500/[0.06] px-3 py-2 text-xs text-violet-700 dark:text-violet-300">
          <LoaderCircle className="size-3.5 shrink-0 animate-spin text-violet-600 dark:text-violet-400" aria-hidden />
          靶点关联（{rel ? describeRelationType(rel.relationType) : '关联'}）— 正在生成合并评估报告（含关系分析章节）…
        </div>
      )}
      {!batch.relationJudging && !batch.merging && rel && (
        <div
          className={cn(
            'flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-3 py-2 text-xs leading-relaxed',
            rel.relationType === 'homologous'
              ? 'border-teal-500/30 bg-teal-500/[0.06] text-teal-700 dark:text-teal-300'
              : rel.related
                ? 'border-violet-500/30 bg-violet-500/[0.06] text-violet-700 dark:text-violet-300'
                : 'border-border bg-muted/50 text-foreground/80'
          )}
        >
          <Link2 className={cn('size-3.5 shrink-0', rel.relationType === 'homologous' ? 'text-teal-600 dark:text-teal-400' : rel.related ? 'text-violet-600 dark:text-violet-400' : 'text-muted-foreground/60')} aria-hidden />
          {rel.relationType === 'homologous' ? (
            <>
              <span className="font-medium">同源蛋白家族 · {batch.total} 个靶点</span>
              <span className="text-muted-foreground">已合并为一份家族级评估报告（结构证据互用）</span>
              {(rel.blastGroups ?? []).length > 0 && (
                <span className="rounded-md border border-teal-500/40 bg-card/60 px-1.5 py-0.5 font-mono text-[10px] text-teal-700 dark:text-teal-300" title="≥90% 序列一致性的成员共享家族代表的同一次检索结果，不重复检索">
                  ≥90% 成员共享同源检索
                </span>
              )}
              {(rel.homologPairs ?? []).filter(p => p.identity >= 40).slice(0, 3).map(p => (
                <span key={`${p.a}-${p.b}`} className="rounded-md border border-teal-500/40 bg-card/60 px-1.5 py-0.5 font-mono text-[10px] text-teal-700 dark:text-teal-300" title={`${p.a} 与 ${p.b} 全长序列比对一致性 ${p.identity}%`}>
                  {p.a}↔{p.b} {p.identity}%
                </span>
              ))}
            </>
          ) : rel.related ? (
            <>
              <span className="font-medium">关联靶点 · {describeRelationType(rel.relationType)}</span>
              <span className="text-muted-foreground">已合并生成一份报告（含关系性分析）</span>
            </>
          ) : (
            <>
              <span className="font-medium">{describeRelationType(rel.relationType)}</span>
              <span className="text-muted-foreground">分别生成报告（报告中已注明批次定位）</span>
            </>
          )}
          {rel.rationale && (
            <span
              className="hidden max-w-full truncate text-muted-foreground/60 md:inline"
              title={rel.rationale}
            >
              — {rel.rationale}
            </span>
          )}
        </div>
      )}
      {!batch.relationJudging && !rel && batch.relationError && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <ShieldAlert className="size-3.5 shrink-0" aria-hidden />
          靶点关系判断未能完成（{batch.relationError}），已按独立项目分别生成报告
        </div>
      )}
      {!batch.merging && batch.mergedError && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <ShieldAlert className="size-3.5 shrink-0" aria-hidden />
          合并报告生成失败（{batch.mergedError}）— 各靶点数据仍可正常查看，可重新发起评估重试
        </div>
      )}

      {/* v1.10 序列归属摘要（构建序列已按靶点并入评估） */}
      {!batch.relationJudging && (batch.sequenceAttribution ?? []).some(a => a.kind === 'construct') && (() => {
        const attr = batch.sequenceAttribution ?? []
        const constructs = attr.filter(a => a.kind === 'construct')
        const homologs = attr.filter(a => a.kind === 'homolog')
        return (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-teal-500/25 bg-teal-500/[0.04] px-3 py-1.5 text-[11px] text-teal-700 dark:text-teal-300">
            <span className="lin-eyebrow text-teal-600 dark:text-teal-400">序列归属</span>
            <span>{constructs.length} 条构建序列已并入对应靶点评估</span>
            {homologs.length > 0 && <span className="text-muted-foreground">· {homologs.length} 条同源序列在合并报告中标注</span>}
            <span className="text-muted-foreground/70">详见合并报告「评估表序列归属」</span>
          </div>
        )
      })()}

      {/* 靶点切换区（醒目化：用户反馈“UI 不太明显，容易被忽略”） */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <MousePointerClick className="size-3.5 shrink-0 text-primary" aria-hidden />
          <span className="text-xs font-semibold text-foreground">切换靶点</span>
          <span className="text-[11px] text-muted-foreground/70">共 {batch.total} 个 · 点击编号查看对应评估结果</span>
          {/* 当前查看标识：同蛋白家族（如多个 GP 变体）场景下避免“看不出切换了” */}
          {!running && !mergedActive && currentJobLabel && (
            <span
              className="ml-auto inline-flex min-h-6 max-w-full items-center gap-1.5 truncate rounded-md border border-primary/30 bg-primary/[0.06] px-2 font-mono text-[11px] font-semibold text-primary"
              title={currentJobLabel}
            >
              <Eye className="size-3 shrink-0" aria-hidden />
              <span className="truncate">当前查看：{currentJobLabel}</span>
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
        {/* 合并报告切换（关联批次，生成后显示） */}
        {batch.mergedReport && onShowMerged && (
          <button
            type="button"
            onClick={onShowMerged}
            title="查看本批次的合并评估报告（含靶点关系分析）"
            className={cn(
              'flex min-h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30',
              mergedActive
                ? 'border-violet-600 bg-violet-600 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.15)] dark:bg-violet-700'
                : 'border-violet-500/40 bg-violet-500/[0.06] text-violet-700 hover:border-violet-500/70 dark:text-violet-300',
            )}
          >
            <FileStack className="size-3.5 shrink-0" aria-hidden />
            合并报告
          </button>
        )}
        {batch.items.map((item) => {
          const active = Boolean(item.jobId && item.jobId === currentJobId) && !mergedActive
          const clickable = Boolean(item.jobId && item.status === 'done')
          return (
            <button
              key={item.key}
              type="button"
              disabled={!clickable}
              onClick={() => item.jobId && onSelect(item.jobId)}
              title={
                item.status === 'error'
                  ? `评估失败${item.error ? `：${item.error}` : ''}`
                  : item.status === 'running'
                    ? `${item.label} 评估中…`
                    : active
                      ? `正在查看 ${item.label} 的评估结果`
                      : `点击切换查看 ${item.label} 的评估结果`
              }
              className={cn(
                'flex min-h-9 items-center gap-1.5 rounded-lg border px-3 font-mono text-xs transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30 disabled:cursor-default',
                active
                  ? 'border-primary bg-primary font-bold text-primary-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.15),0_0_0_1px_rgb(94_106_210/0.25)]'
                  : clickable
                    ? 'border-border bg-card font-semibold text-foreground/80 hover:border-ring/60 hover:text-primary'
                    : 'border-border bg-muted/60 text-muted-foreground/60'
              )}
            >
              {item.status === 'done' ? (
                active ? (
                  <Eye className="size-3.5 shrink-0" aria-hidden />
                ) : (
                  <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" aria-hidden />
                )
              ) : item.status === 'running' ? (
                <LoaderCircle className="size-3.5 shrink-0 animate-spin text-primary" aria-hidden />
              ) : (
                <XCircle className="size-3.5 shrink-0 text-red-400" aria-hidden />
              )}
              {item.label}
              {active && <span className="rounded bg-white/25 px-1 text-[10px] font-sans font-semibold">查看中</span>}
            </button>
          )
        })}
        {/* 尚未开始的靶点占位 */}
        {batch.items.length < batch.total &&
          Array.from({ length: batch.total - batch.items.length }, (_, i) => (
            <span
              key={`pending-${i}`}
              className="flex min-h-9 items-center rounded-lg border border-dashed border-border px-3 font-mono text-xs text-muted-foreground/50"
            >
              待排队
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
