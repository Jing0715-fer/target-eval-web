'use client'

import { CircleAlert, LoaderCircle, RotateCcw, Undo2 } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { LogCard } from './progress-panel'
import type { JobDetail } from './types'

export interface ErrorPanelProps {
  job: JobDetail | null
  submitting: boolean
  onRetry: () => void
  onReset: () => void
  /** v2.6：提交/流中断层的真实错误（job.error 为空时展示 — 同步流中断曾显示为“未知错误”） */
  submitError?: string | null
}

/** 失败视图：错误信息 + 重试 / 返回按钮，保留日志便于排查 */
export function ErrorPanel({ job, submitting, onRetry, onReset, submitError }: ErrorPanelProps) {
  const logs = job?.logs ?? []
  const errorText = job?.error?.trim() || submitError?.trim() || ''
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <p className="lin-eyebrow text-red-600 dark:text-red-400">Evaluation Failed</p>
        <h1 className="text-2xl leading-snug font-semibold tracking-[-0.02em] text-foreground sm:text-[28px]">
          评估失败
        </h1>
      </header>

      <Alert variant="destructive" className="rounded-lg bg-card text-red-700 shadow-none dark:bg-card dark:text-red-400">
        <CircleAlert />
        <AlertTitle className="text-sm font-semibold">执行出错</AlertTitle>
        <AlertDescription className="text-red-700/90 dark:text-red-400/90">
          <p className="leading-relaxed">{errorText || '作业执行过程中发生未知错误'}</p>
          {job?.uniprotId && (
            <p className="mt-1 font-mono text-xs opacity-75">目标蛋白：{job.uniprotId}</p>
          )}
        </AlertDescription>
      </Alert>

      <div className="flex flex-wrap gap-2.5">
        <Button
          onClick={onRetry}
          disabled={submitting}
          className="h-10 gap-2 rounded-lg bg-primary font-medium text-primary-foreground hover:bg-[#7a84dc] dark:hover:bg-[#828fff]"
        >
          {submitting ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <RotateCcw className="size-4" />
          )}
          {submitting ? '正在重新提交…' : '重试评估'}
        </Button>
        <Button variant="outline" onClick={onReset} className="h-10 gap-2 rounded-lg">
          <Undo2 className="size-4" />
          返回修改输入
        </Button>
      </div>

      {logs.length > 0 && <LogCard logs={logs} title="失败前的执行日志" />}
    </div>
  )
}
