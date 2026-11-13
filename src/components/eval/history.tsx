'use client'

import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { ArrowRight, CircleAlert, History, Layers, LoaderCircle, ShieldCheck, Trash2 } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { deleteJobById, fetchBatchReportList, fetchJobList } from './api'
import { StatusBadge } from './badges'
import { formatDateTime, formatPercent } from './format'
import type { BatchReportListItem, JobListItem } from './types'

/* ---------------- 共享行组件 ---------------- */

function JobRow({
  job,
  onOpen,
  onDelete,
  deleting,
  dense = false,
}: {
  job: JobListItem
  onOpen: (id: string) => void
  onDelete?: (id: string) => void
  deleting?: boolean
  /** 紧凑模式（侧栏列表：无卡片边框、更小字号） */
  dense?: boolean
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(job.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(job.id)
        }
      }}
      className={cn(
        'group cursor-pointer items-center gap-2.5 outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-emerald-500/40 dark:focus-visible:ring-emerald-500/30',
        dense
          ? 'flex min-h-11 rounded-md px-2.5 py-1.5 hover:bg-stone-100/80 dark:hover:bg-stone-800/60'
          : 'flex min-h-14 rounded-md border border-stone-200 bg-white px-4 py-3 hover:border-emerald-300 hover:bg-stone-50 dark:border-stone-800 dark:bg-stone-900 dark:hover:border-emerald-800 dark:hover:bg-stone-900/60',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className={cn(
          'truncate font-medium text-stone-800 dark:text-stone-200',
          dense ? 'text-[13px]' : 'text-sm',
        )}>
          {job.proteinName || job.title || job.uniprotId || '未命名评估'}
        </div>
        <div className="mt-px flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10.5px] text-stone-500 dark:text-stone-500">
          {job.uniprotId && <span className="font-mono">{job.uniprotId}</span>}
          <span>{formatDateTime(job.createdAt)}</span>
          {job.pdbCount != null && <span>· {job.pdbCount} PDB</span>}
          {job.coverage != null && <span>· 覆盖 {formatPercent(job.coverage)}</span>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {job.overallScore != null && (
          <span className="text-[13px] font-bold tabular-nums text-stone-800 dark:text-stone-200">
            {Number(job.overallScore.toFixed(1))}
          </span>
        )}
        <StatusBadge status={job.status} />
        {onDelete && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="删除该评估记录"
            className={cn(
              'text-stone-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40',
              dense ? 'size-7 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100' : 'size-8',
            )}
            disabled={deleting}
            onClick={(e) => {
              e.stopPropagation()
              onDelete(job.id)
            }}
          >
            {deleting ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <Trash2 className="size-3.5" />
            )}
          </Button>
        )}
      </div>
    </div>
  )
}

function EmptyHistoryState({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-stone-300 text-center dark:border-stone-700',
        compact ? 'py-8' : 'py-12'
      )}
    >
      <div className="flex size-12 items-center justify-center rounded-full bg-stone-100 dark:bg-stone-800">
        <History className="size-5 text-stone-400" />
      </div>
      <p className="text-sm font-medium text-stone-600 dark:text-stone-400">暂无评估记录</p>
      <p className="text-xs text-stone-400 dark:text-stone-500">
        完成第一次靶点评估后，记录将显示在此处（仅你自己的记录可见）
      </p>
    </div>
  )
}

/** 隐私隔离标识：按来源网络隔离的记录可见性提示 */
function PrivacyBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-sm border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-400',
        className,
      )}
      title="评估记录按浏览器会话隔离，其他用户不可见"
    >
      <ShieldCheck className="size-3" aria-hidden />
      仅自己可见
    </span>
  )
}

/* ---------------- 合并报告行组件 ---------------- */

function BatchReportRow({
  report,
  onOpen,
  dense = false,
}: {
  report: BatchReportListItem
  onOpen: (id: string) => void
  /** 紧凑模式（侧栏列表） */
  dense?: boolean
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(report.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(report.id)
        }
      }}
      className={cn(
        'group cursor-pointer items-center gap-2.5 outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-violet-500/40 dark:focus-visible:ring-violet-500/30',
        dense
          ? 'flex min-h-11 rounded-md px-2.5 py-1.5 hover:bg-stone-100/80 dark:hover:bg-stone-800/60'
          : 'flex min-h-14 rounded-md border border-stone-200 bg-white px-4 py-3 hover:border-violet-300 hover:bg-stone-50 dark:border-stone-800 dark:bg-stone-900 dark:hover:border-violet-800 dark:hover:bg-stone-900/60',
      )}
    >
      <div className={cn(
        'flex shrink-0 items-center justify-center rounded-md bg-violet-100 text-violet-700 dark:bg-violet-950/40 dark:text-violet-400',
        dense ? 'size-7' : 'size-9',
      )}>
        <Layers className={dense ? 'size-3.5' : 'size-4'} />
      </div>
      <div className="min-w-0 flex-1">
        <div className={cn(
          'truncate font-medium text-stone-800 dark:text-stone-200',
          dense ? 'text-[13px]' : 'text-sm',
        )}>
          {report.title}
        </div>
        <div className="mt-px flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10.5px] text-stone-500 dark:text-stone-500">
          <span>{report.jobIds.length} 个靶点</span>
          <span>{formatDateTime(report.createdAt)}</span>
          {report.status === 'running' && <span className="text-amber-600">· 生成中</span>}
          {report.status === 'error' && <span className="text-red-500">· 生成失败</span>}
        </div>
      </div>
      <ArrowRight className="size-3.5 shrink-0 text-stone-300 transition-colors group-hover:text-violet-500 dark:text-stone-600" />
    </div>
  )
}

/* ---------------- 历史记录 Dialog ---------------- */

export function HistoryDialog({
  open,
  onOpenChange,
  refreshKey,
  onOpenJob,
  onOpenBatchReport,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  refreshKey: number
  onOpenJob: (id: string) => void
  onOpenBatchReport: (id: string) => void
}) {
  const [jobs, setJobs] = useState<JobListItem[] | null>(null)
  const [batches, setBatches] = useState<BatchReportListItem[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<JobListItem | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [jobList, batchList] = await Promise.all([
        fetchJobList(),
        fetchBatchReportList().catch(() => [] as BatchReportListItem[]),
      ])
      setJobs(jobList)
      setBatches(batchList)
    } catch {
      setJobs([])
      setBatches([])
      setError('无法获取评估记录（评估服务可能尚未就绪）')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) void load()
  }, [open, refreshKey, load])

  const handleDelete = async (id: string) => {
    setDeletingId(id)
    try {
      await deleteJobById(id)
      setJobs((prev) => prev?.filter((j) => j.id !== id) ?? null)
    } catch {
      setError('删除失败，请稍后重试')
    } finally {
      setDeletingId(null)
      setConfirmDelete(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[82vh] w-full flex-col gap-3 overflow-hidden sm:max-w-xl">
        <DialogHeader className="text-left">
          <DialogTitle className="flex items-center gap-2 font-display">
            <History className="size-4 text-emerald-700 dark:text-emerald-500" />
            历史评估
            <PrivacyBadge className="ml-1" />
          </DialogTitle>
          <DialogDescription>
            你最近的评估作业与合并报告，点击记录加载结果；记录按浏览器会话隔离，其他用户不可见
          </DialogDescription>
        </DialogHeader>

        <div className="eval-scroll -mx-1 min-h-0 flex-1 overflow-y-auto px-1">
          {loading && jobs === null ? (
            <div className="flex flex-col gap-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-14 w-full rounded-lg" />
              ))}
            </div>
          ) : error ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <CircleAlert className="size-5 text-red-500" />
              <p className="text-sm text-stone-600 dark:text-stone-400">{error}</p>
              <Button variant="outline" size="sm" onClick={() => void load()} className="mt-1 h-9 gap-1.5">
                <LoaderCircle className="size-3.5" />
                重新加载
              </Button>
            </div>
          ) : (
            <>
              {/* 合并报告（批量评估历史） */}
              {batches && batches.length > 0 && (
                <div className="mb-4">
                  <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-violet-700 dark:text-violet-400">
                    <Layers className="size-3.5" />
                    合并报告（{batches.length}）
                  </div>
                  <div className="flex flex-col gap-2">
                    {batches.map((b) => (
                      <BatchReportRow key={b.id} report={b} onOpen={onOpenBatchReport} />
                    ))}
                  </div>
                </div>
              )}
              {/* 单靶点评估 */}
              {(!jobs || jobs.length === 0) && (!batches || batches.length === 0) ? (
                <EmptyHistoryState />
              ) : jobs && jobs.length > 0 ? (
                <div>
                  {batches && batches.length > 0 && (
                    <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400">
                      <History className="size-3.5" />
                      单靶点评估（{jobs.length}）
                    </div>
                  )}
                  <div className="flex flex-col gap-2">
                    {jobs.map((j) => (
                      <JobRow
                        key={j.id}
                        job={j}
                        onOpen={onOpenJob}
                        onDelete={(id) => setConfirmDelete(jobs.find((x) => x.id === id) ?? null)}
                        deleting={deletingId === j.id}
                      />
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>
      </DialogContent>

      {/* 删除确认 */}
      <AlertDialog open={confirmDelete != null} onOpenChange={(v) => !v && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除这条评估记录？</AlertDialogTitle>
            <AlertDialogDescription>
              将删除「{confirmDelete?.proteinName || confirmDelete?.title || confirmDelete?.uniprotId || '未命名评估'}」的作业记录、生成的报告与上传的实验图片，且不可恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-400/40"
              onClick={() => confirmDelete && void handleDelete(confirmDelete.id)}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  )
}

/* ---------------- idle 视图侧栏「最近评估」 ---------------- */

export function RecentEvaluations({
  refreshKey,
  onOpenJob,
  onOpenBatchReport,
  onOpenHistory,
}: {
  refreshKey: number
  onOpenJob: (id: string) => void
  onOpenBatchReport: (id: string) => void
  onOpenHistory: () => void
}) {
  const [jobs, setJobs] = useState<JobListItem[] | null>(null)
  const [batches, setBatches] = useState<BatchReportListItem[] | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<JobListItem | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetchJobList().catch(() => [] as JobListItem[]),
      fetchBatchReportList().catch(() => [] as BatchReportListItem[]),
    ]).then(([jobList, batchList]) => {
      if (!cancelled) {
        setJobs(jobList)
        setBatches(batchList)
      }
    })
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  const handleDelete = async (id: string) => {
    setDeletingId(id)
    try {
      await deleteJobById(id)
      setJobs((prev) => prev?.filter((j) => j.id !== id) ?? null)
    } catch {
      // 忽略删除失败
    } finally {
      setDeletingId(null)
      setConfirmDelete(null)
    }
  }

  const empty = jobs != null && batches != null && jobs.length === 0 && batches.length === 0

  return (
    <motion.section
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: 0.14, ease: 'easeOut' }}
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-stone-200/80 bg-white ring-1 ring-stone-950/[0.03] shadow-[0_1px_2px_rgba(28,25,23,0.04),0_12px_32px_-20px_rgba(28,25,23,0.16)] dark:border-stone-800 dark:bg-stone-900 dark:ring-white/[0.04] dark:shadow-[0_1px_2px_rgba(0,0,0,0.4),0_16px_40px_-24px_rgba(0,0,0,0.6)]"
      aria-label="最近评估"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-stone-100 px-3.5 py-2.5 dark:border-stone-800/70">
        <span className="eval-eyebrow text-emerald-700 dark:text-emerald-500">Recent</span>
        <h2 className="text-[13px] font-semibold text-stone-800 dark:text-stone-100">最近评估</h2>
        <PrivacyBadge />
        <Button
          variant="ghost"
          size="sm"
          onClick={onOpenHistory}
          className="ml-auto h-7 gap-1 rounded-md px-2 text-[11px] text-stone-500 hover:text-stone-800 dark:hover:text-stone-200"
        >
          查看全部
          <ArrowRight className="size-3" />
        </Button>
      </div>

      {jobs === null || batches === null ? (
        <div className="flex flex-col gap-2 px-3.5 py-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-10 w-full rounded-md" />
          ))}
        </div>
      ) : empty ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-3.5 py-7 text-center">
          <div className="flex size-9 items-center justify-center rounded-full bg-stone-100 dark:bg-stone-800">
            <History className="size-4 text-stone-400" />
          </div>
          <p className="text-[13px] font-medium text-stone-600 dark:text-stone-400">暂无评估记录</p>
          <p className="text-[11px] text-stone-400 dark:text-stone-500">
            完成第一次靶点评估后，记录将显示在此处
          </p>
        </div>
      ) : (
        <div className="eval-scroll eval-scroll-fade min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
          {batches.slice(0, 3).map((b) => (
            <BatchReportRow key={b.id} report={b} onOpen={onOpenBatchReport} dense />
          ))}
          {jobs.slice(0, 6).map((j) => (
            <JobRow
              key={j.id}
              job={j}
              onOpen={onOpenJob}
              onDelete={(id) => setConfirmDelete(jobs.find((x) => x.id === id) ?? null)}
              deleting={deletingId === j.id}
              dense
            />
          ))}
          {(jobs.length > 6 || batches.length > 3) && (
            <div className="px-2.5 pt-1 pb-0.5 text-center">
              <span className="font-mono text-[10.5px] text-stone-400 dark:text-stone-500">
                共 {batches.length} 份合并报告 · {jobs.length} 条单靶点记录
              </span>
            </div>
          )}
        </div>
      )}

      {/* 卡底锚点：全部历史入口（消解尾部留白） */}
      <div className="shrink-0 border-t border-stone-100 px-2.5 py-2 dark:border-stone-800/70">
        <button
          type="button"
          onClick={onOpenHistory}
          className="flex min-h-8 w-full items-center justify-center gap-1.5 rounded-md text-[11.5px] font-medium text-stone-500 transition-colors outline-none hover:bg-stone-100/70 hover:text-stone-800 focus-visible:ring-[3px] focus-visible:ring-emerald-500/40 dark:text-stone-400 dark:hover:bg-stone-800/50 dark:hover:text-stone-200"
        >
          <History className="size-3.5" aria-hidden />
          查看全部历史评估
          <ArrowRight className="size-3" aria-hidden />
        </button>
      </div>

      {/* 删除确认 */}
      <AlertDialog open={confirmDelete != null} onOpenChange={(v) => !v && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除这条评估记录？</AlertDialogTitle>
            <AlertDialogDescription>
              将删除「{confirmDelete?.proteinName || confirmDelete?.title || confirmDelete?.uniprotId || '未命名评估'}」的作业记录、生成的报告与上传的实验图片，且不可恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-400/40"
              onClick={() => confirmDelete && void handleDelete(confirmDelete.id)}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </motion.section>
  )
}
