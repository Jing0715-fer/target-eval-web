'use client'

import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { ArrowRight, CircleAlert, History, LoaderCircle, ShieldCheck, Trash2 } from 'lucide-react'
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
import { deleteJobById, fetchJobList } from './api'
import { StatusBadge } from './badges'
import { formatDateTime, formatPercent } from './format'
import type { JobListItem } from './types'

/* ---------------- 共享行组件 ---------------- */

function JobRow({
  job,
  onOpen,
  onDelete,
  deleting,
}: {
  job: JobListItem
  onOpen: (id: string) => void
  onDelete?: (id: string) => void
  deleting?: boolean
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
      className="flex min-h-14 cursor-pointer items-center gap-3 rounded-md border border-stone-200 bg-white px-4 py-3 transition-colors outline-none hover:border-emerald-300 hover:bg-stone-50 focus-visible:ring-[3px] focus-visible:ring-emerald-500/40 dark:border-stone-800 dark:bg-stone-900 dark:hover:border-emerald-800 dark:hover:bg-stone-900/60"
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-stone-800 dark:text-stone-200">
          {job.proteinName || job.title || job.uniprotId || '未命名评估'}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-stone-500 dark:text-stone-500">
          {job.uniprotId && <span className="font-mono">{job.uniprotId}</span>}
          <span>{formatDateTime(job.createdAt)}</span>
          {job.pdbCount != null && <span>· {job.pdbCount} PDB</span>}
          {job.coverage != null && <span>· 覆盖 {formatPercent(job.coverage)}</span>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {job.overallScore != null && (
          <span className="text-sm font-bold tabular-nums text-stone-800 dark:text-stone-200">
            {Number(job.overallScore.toFixed(1))}
          </span>
        )}
        <StatusBadge status={job.status} />
        {onDelete && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="删除该评估记录"
            className="size-8 text-stone-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40"
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
      title="评估记录按来源网络（IP）隔离，其他用户不可见"
    >
      <ShieldCheck className="size-3" aria-hidden />
      仅自己可见
    </span>
  )
}

/* ---------------- 历史记录 Dialog ---------------- */

export function HistoryDialog({
  open,
  onOpenChange,
  refreshKey,
  onOpenJob,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  refreshKey: number
  onOpenJob: (id: string) => void
}) {
  const [jobs, setJobs] = useState<JobListItem[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<JobListItem | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const list = await fetchJobList()
      setJobs(list)
    } catch {
      setJobs([])
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
            你最近的评估作业，点击记录加载结果或继续跟踪进度；记录按来源网络隔离，其他用户不可见
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
          ) : !jobs || jobs.length === 0 ? (
            <EmptyHistoryState />
          ) : (
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

/* ---------------- idle 视图底部「最近评估」 ---------------- */

export function RecentEvaluations({
  refreshKey,
  onOpenJob,
  onOpenHistory,
}: {
  refreshKey: number
  onOpenJob: (id: string) => void
  onOpenHistory: () => void
}) {
  const [jobs, setJobs] = useState<JobListItem[] | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<JobListItem | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchJobList()
      .then((list) => {
        if (!cancelled) setJobs(list)
      })
      .catch(() => {
        // API 未就绪时静默降级为空状态
        if (!cancelled) setJobs([])
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

  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: 0.15, ease: 'easeOut' }}
      className="mt-10"
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="flex flex-wrap items-center gap-2.5 text-sm font-semibold text-stone-700 dark:text-stone-300">
          <span className="eval-eyebrow text-emerald-700 dark:text-emerald-500">Recent</span>
          最近评估
          <PrivacyBadge />
        </h2>
        <Button
          variant="ghost"
          size="sm"
          onClick={onOpenHistory}
          className="h-9 gap-1 text-xs text-stone-500 hover:text-stone-800 dark:hover:text-stone-200"
        >
          查看全部
          <ArrowRight className="size-3.5" />
        </Button>
      </div>

      {jobs === null ? (
        <div className="flex flex-col gap-2">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-14 w-full rounded-lg" />
          ))}
        </div>
      ) : jobs.length === 0 ? (
        <EmptyHistoryState compact />
      ) : (
        <div className="flex flex-col gap-2">
          {jobs.slice(0, 5).map((j) => (
            <JobRow
              key={j.id}
              job={j}
              onOpen={onOpenJob}
              onDelete={(id) => setConfirmDelete(jobs.find((x) => x.id === id) ?? null)}
              deleting={deletingId === j.id}
            />
          ))}
          {jobs.length > 5 && (
            <div className="flex justify-center pt-1">
              <span className="font-mono text-[11px] text-stone-400 dark:text-stone-500">
                共 {jobs.length} 条记录
              </span>
            </div>
          )}
        </div>
      )}

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
