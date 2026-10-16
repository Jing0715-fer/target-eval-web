'use client'

import { motion } from 'framer-motion'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  AlertTriangle,
  ArrowLeft,
  BookOpenText,
  Download,
  Layers,
  Link2,
  ShieldCheck,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { describeRelationType } from './types'
import { mdComponents } from './result-view'
import type { BatchReportInfo } from './types'

export interface MergedReportViewProps {
  report: BatchReportInfo
  /** 参与批次的靶点展示标签（chips 用） */
  targetLabels: string[]
  onNewEvaluation: () => void
}

/** 关系类型 → 视觉色调（关联=紫罗兰系；独立批次的合并报告不会走到此视图） */
function relationTone(type: BatchReportInfo['relation']['relationType']): { chip: string; icon: string; border: string } {
  switch (type) {
    case 'antibody-antigen':
      return {
        chip: 'border-violet-300 bg-violet-100 text-violet-800 dark:border-violet-800 dark:bg-violet-950/60 dark:text-violet-300',
        icon: 'text-violet-600 dark:text-violet-400',
        border: 'border-violet-200 bg-violet-50/60 dark:border-violet-900/60 dark:bg-violet-950/20',
      }
    case 'complex':
      return {
        chip: 'border-emerald-300 bg-emerald-100 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300',
        icon: 'text-emerald-600 dark:text-emerald-400',
        border: 'border-emerald-200 bg-emerald-50/60 dark:border-emerald-800/60 dark:bg-emerald-950/20',
      }
    default:
      return {
        chip: 'border-stone-300 bg-stone-100 text-stone-700 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-300',
        icon: 'text-stone-500 dark:text-stone-400',
        border: 'border-stone-200 bg-stone-50/60 dark:border-stone-800 dark:bg-stone-900/40',
      }
  }
}

/**
 * 合并评估报告视图（v1.8 关联靶点批量）：
 * 返回栏 → 刊头（关系判定卡）→ 报告操作条（下载 HTML）→ LLM 合并分析全文
 */
export function MergedReportView({ report, targetLabels, onNewEvaluation }: MergedReportViewProps) {
  const rel = report.relation
  const tone = relationTone(rel.relationType)
  const md = report.markdown?.trim() || ''
  const llmOk = report.llmOk !== false && md.length > 0

  const downloadReport = () => {
    window.open(`/api/evaluate/batch-report?id=${encodeURIComponent(report.id)}&download=1`, '_blank')
  }

  const confidenceText = rel.confidence === 'high' ? '高' : rel.confidence === 'medium' ? '中' : '低'

  return (
    <div className="flex flex-col gap-8">
      {/* 0. 返回导航条 */}
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          onClick={onNewEvaluation}
          className="h-9 gap-1.5 rounded-md border-stone-300 px-3 text-xs font-medium text-stone-600 hover:border-emerald-400 hover:text-emerald-800 dark:border-stone-700 dark:text-stone-300 dark:hover:border-emerald-700 dark:hover:text-emerald-400"
        >
          <ArrowLeft className="size-3.5" />
          新建评估
        </Button>
        <span className="font-mono text-[11px] text-stone-400 dark:text-stone-500">
          合并报告 {report.id.slice(0, 8)} · {targetLabels.length} 个关联靶点
        </span>
      </div>

      {/* 1. 刊头 */}
      <motion.header
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: 'easeOut' }}
        className="flex flex-col gap-3"
      >
        <p className="eval-eyebrow text-violet-700 dark:text-violet-400">
          Merged Evaluation Report · 合并评估报告
        </p>
        <h1 className="font-display text-2xl leading-snug font-bold text-stone-900 sm:text-3xl dark:text-stone-50">
          多靶点合并可行性评估
        </h1>

        {/* 关系判定卡 */}
        <div className={cn('flex flex-col gap-2.5 rounded-lg border px-4 py-3.5 sm:px-5', tone.border)}>
          <div className="flex flex-wrap items-center gap-2">
            <Link2 className={cn('size-4 shrink-0', tone.icon)} aria-hidden />
            <span className="text-sm font-semibold text-stone-800 dark:text-stone-100">
              靶点关系：{describeRelationType(rel.relationType)}
            </span>
            <span className={cn('rounded-sm border px-1.5 py-0.5 font-mono text-[10px] font-medium', tone.chip)}>
              置信度 {confidenceText}
            </span>
            {rel.error && (
              <span className="rounded-sm border border-amber-300 bg-amber-50 px-1.5 py-0.5 font-mono text-[10px] text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-400">
                判断服务异常，已降级
              </span>
            )}
          </div>
          <p className="text-sm leading-relaxed text-stone-600 dark:text-stone-300">{rel.rationale}</p>
          {rel.strategy && (
            <p className="flex items-start gap-2 text-xs leading-relaxed text-stone-500 dark:text-stone-400">
              <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-500" aria-hidden />
              <span><span className="eval-eyebrow mr-1.5 text-emerald-700 dark:text-emerald-500">策略要点</span>{rel.strategy}</span>
            </p>
          )}
        </div>

        {/* 参与靶点 chips */}
        <div className="flex flex-wrap items-center gap-1.5 font-mono text-xs text-stone-500 dark:text-stone-400">
          <span className="eval-eyebrow text-stone-400">批次靶点</span>
          {targetLabels.map(l => (
            <span key={l} className="rounded-sm border border-stone-200 px-1.5 py-0.5 dark:border-stone-700">
              {l}
            </span>
          ))}
        </div>
      </motion.header>

      {/* 2. 报告操作条 */}
      <motion.section
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: 0.14, ease: 'easeOut' }}
        className={cn(
          'flex flex-col gap-4 rounded-lg border px-5 py-4 sm:flex-row sm:items-center',
          llmOk
            ? 'border-violet-300 bg-violet-50/60 dark:border-violet-800 dark:bg-violet-950/20'
            : 'border-amber-300 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/20'
        )}
      >
        <div className="flex items-center gap-3">
          <div className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-md text-white',
            llmOk ? 'bg-violet-700 dark:bg-violet-800' : 'bg-amber-600 dark:bg-amber-700'
          )}>
            {llmOk ? <Layers className="size-4.5" /> : <AlertTriangle className="size-4.5" />}
          </div>
          <div>
            <div className="text-sm font-semibold text-stone-900 dark:text-stone-100">
              {llmOk ? '合并评估报告已生成' : '合并报告（LLM 部分失败）'}
            </div>
            <div className="font-mono text-[11px] text-stone-500 dark:text-stone-400">
              HTML · {md.length > 0 ? `${md.length.toLocaleString()} 字分析` : '分析缺失'} · 可独立下载分享
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 sm:ml-auto">
          <Button
            onClick={downloadReport}
            className="h-10 gap-2 rounded-md bg-violet-700 px-4 font-medium text-white hover:bg-violet-600 dark:bg-violet-800 dark:hover:bg-violet-700"
          >
            <Download className="size-4" />
            下载 HTML
          </Button>
        </div>
      </motion.section>

      {/* 3. 合并分析全文 */}
      <motion.section
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: 0.2, ease: 'easeOut' }}
        className="flex flex-col gap-3"
        aria-labelledby="sec-merged-report"
      >
        <div id="sec-merged-report" className="eval-eyebrow text-stone-500 dark:text-stone-400">
          Merged Analysis · 合并分析（摘要 / 关系分析 / 各靶点综述 / 整合策略）
        </div>
        {!llmOk && (() => {
          const errs = report.errors ?? []
          return (
            <div className="flex items-start gap-2.5 rounded-md border border-amber-200 bg-amber-50/70 px-3.5 py-2.5 text-xs leading-relaxed text-amber-800 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              合并报告 LLM 分析生成失败或部分失败{errs.length > 0 && `（${errs.join('；')}）`}；
              可在批次完成后重新发起评估重试。各靶点的结构化数据（评分 / PDB / BLAST / 文献）经切换栏查看。
            </div>
          )
        })()}
        <Card className="rounded-lg border-stone-200 bg-white shadow-none dark:border-stone-800 dark:bg-stone-900">
          <CardContent className="px-5 py-5 sm:px-7 sm:py-6">
            <div className="mb-4 flex items-center gap-2 text-stone-400 dark:text-stone-500">
              <BookOpenText className="size-3.5" aria-hidden />
              <span className="eval-eyebrow">Analysis · 由大语言模型基于批次结构化数据生成，结论供参考</span>
            </div>
            {md ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                {md}
              </ReactMarkdown>
            ) : (
              <p className="py-6 text-center text-sm text-stone-500 dark:text-stone-400">
                合并分析生成失败 — 各靶点数据经上方切换栏查看
              </p>
            )}
          </CardContent>
        </Card>
      </motion.section>
    </div>
  )
}
