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

/** 失败视图：红色 Alert（含错误信息 + 重试 / 返回按钮），保留日志便于排查 */
export function ErrorPanel({ job, submitting, onRetry, onReset }: ErrorPanelProps) {
  const logs = job?.logs ?? []
  return (
    <div className="flex flex-col gap-5">
      <Alert
        variant="destructive"
        className="rounded-xl border-red-300 bg-white text-red-700 shadow-sm dark:border-red-900 dark:bg-stone-900 dark:text-red-400"
      >
        <CircleAlert />
        <AlertTitle className="text-sm font-semibold">评估失败</AlertTitle>
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
          className="h-11 gap-2 bg-emerald-600 font-medium text-white hover:bg-emerald-700 dark:bg-emerald-600 dark:hover:bg-emerald-500"
        >
          {submitting ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <RotateCcw className="size-4" />
          )}
          {submitting ? '正在重新提交…' : '重试评估'}
        </Button>
        <Button variant="outline" onClick={onReset} className="h-11 gap-2">
          <Undo2 className="size-4" />
          返回修改输入
        </Button>
      </div>

      {logs.length > 0 && <LogCard logs={logs} title="失败前的执行日志" />}
    </div>
  )
}
