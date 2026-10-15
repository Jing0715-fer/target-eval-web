'use client'

import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { LoaderCircle } from 'lucide-react'
import { AppHeader } from '@/components/eval/app-header'
import { AppFooter } from '@/components/eval/app-footer'
import { Stepper } from '@/components/eval/stepper'
import { InputPanel } from '@/components/eval/input-panel'
import { ProgressPanel } from '@/components/eval/progress-panel'
import { ErrorPanel } from '@/components/eval/error-panel'
import { ResultView } from '@/components/eval/result-view'
import { HistoryDialog, RecentEvaluations } from '@/components/eval/history'
import { useEvaluationFlow } from '@/components/eval/use-evaluation-flow'

const viewMotion = {
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -10 },
  transition: { duration: 0.28, ease: 'easeOut' as const },
}

/** 分析生成阶段的 stage key 特征（评分 / LLM / 报告） */
function isAnalysisStage(stage: string | null | undefined): boolean {
  return /score|rating|llm|report|generat|summary/i.test(stage ?? '')
}

export default function Home() {
  const flow = useEvaluationFlow()
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyKey, setHistoryKey] = useState(0)

  /** 根据阶段计算 stepper 步数：0 输入 / 1 数据收集 / 2 分析生成 / 3-4 报告 */
  const step =
    flow.phase === 'idle'
      ? 0
      : flow.phase === 'done'
        ? 4
        : flow.phase === 'error'
          ? 2
          : isAnalysisStage(flow.job?.progress?.stage)
            ? 2
            : 1

  const handleNewEvaluation = () => {
    flow.reset()
    setHistoryKey((k) => k + 1) // 刷新最近评估列表
    if (typeof window !== 'undefined') window.scrollTo({ top: 0 })
  }

  const openHistoryJob = (id: string) => {
    void flow.loadJob(id)
  }

  return (
    <div className="flex min-h-screen flex-col bg-[#fafaf9] text-stone-900 dark:bg-stone-950 dark:text-stone-100">
      <AppHeader
        onOpenHistory={() => setHistoryOpen(true)}
        onHome={handleNewEvaluation}
        canGoHome={flow.phase !== 'idle' && !flow.loadingHistoryJob}
      />

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
        <Stepper step={step} className="mb-8 sm:mb-10" />

        {flow.loadingHistoryJob ? (
          <div className="flex items-center justify-center gap-2 py-24 text-sm text-stone-500">
            <LoaderCircle className="size-5 animate-spin text-emerald-700" />
            正在加载评估作业…
          </div>
        ) : (
          <AnimatePresence mode="wait">
            {flow.phase === 'idle' && (
              <motion.div key="idle" {...viewMotion}>
                <InputPanel
                  submitting={flow.submitting}
                  submitError={flow.submitError}
                  onStart={flow.startEvaluation}
                  onClearSubmitError={flow.clearSubmitError}
                />
              </motion.div>
            )}

            {flow.phase === 'running' && (
              <motion.div key="running" {...viewMotion}>
                <ProgressPanel
                  job={flow.job}
                  elapsedSec={flow.elapsedSec}
                  networkIssue={flow.networkIssue}
                  canceling={flow.canceling}
                  onCancel={() => void flow.cancelJob()}
                />
              </motion.div>
            )}

            {flow.phase === 'error' && (
              <motion.div key="error" {...viewMotion}>
                <ErrorPanel
                  job={flow.job}
                  submitting={flow.submitting}
                  onRetry={flow.retry}
                  onReset={flow.reset}
                />
              </motion.div>
            )}

            {flow.phase === 'done' && flow.job && (
              <motion.div key="done" {...viewMotion}>
                <ResultView job={flow.job} onNewEvaluation={handleNewEvaluation} />
              </motion.div>
            )}
          </AnimatePresence>
        )}

        {/* idle 视图底部：最近评估 */}
        {flow.phase === 'idle' && !flow.loadingHistoryJob && (
          <RecentEvaluations
            refreshKey={historyKey}
            onOpenJob={openHistoryJob}
            onOpenHistory={() => setHistoryOpen(true)}
          />
        )}
      </main>

      <AppFooter />

      <HistoryDialog
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        refreshKey={historyKey}
        onOpenJob={(id) => {
          setHistoryOpen(false)
          openHistoryJob(id)
        }}
      />
    </div>
  )
}
