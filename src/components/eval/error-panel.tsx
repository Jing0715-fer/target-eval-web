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
}

/** 失败视图：错误信息 + 重试 / 返回按钮，保留日志便于排查 */
export function ErrorPanel({ job, submitting, onRetry, onReset }: ErrorPanelProps) {
  const logs = job?.logs ?? []
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <p className="eval-eyebrow text-red-700 dark:text-red-400">Evaluation Failed</p>
        <h1 className="font-display text-2xl leading-snug font-bold text-stone-900 sm:text-3xl dark:text-stone-50">
          评估失败
        </h1>
      </header>

      <Alert
        variant="destructive"
        className="rounded-md border-red-300 bg-white text-red-700 shadow-none dark:border-red-900 dark:bg-stone-900 dark:text-red-400"
      >
        <CircleAlert />
        <AlertTitle className="text-sm font-semibold">执行出错</AlertTitle>
        <AlertDescription className="text-red-700/90 dark:text-red-400/90">
          <p className="leading-relaxed">{job?.error?.trim() || '作业执行过程中发生未知错误'}</p>
          {job?.uniprotId && (
            <p className="mt-1 font-mono text-xs opacity-75">目标蛋白：{job.uniprotId}</p>
          )}
        </AlertDescription>
      </Alert>

      <div className="flex flex-wrap gap-2.5">
        <Button
          onClick={onRetry}
          disabled={submitting}
          className="h-10 gap-2 rounded-md bg-emerald-800 font-medium text-white hover:bg-emerald-700 dark:bg-emerald-700 dark:hover:bg-emerald-600"
        >
          {submitting ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <RotateCcw className="size-4" />
          )}
          {submitting ? '正在重新提交…' : '重试评估'}
        </Button>
        <Button variant="outline" onClick={onReset} className="h-10 gap-2 rounded-md">
          <Undo2 className="size-4" />
          返回修改输入
        </Button>
      </div>

      {logs.length > 0 && <LogCard logs={logs} title="失败前的执行日志" />}
    </div>
  )
}
