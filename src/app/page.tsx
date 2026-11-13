'use client'

import { useCallback, useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { LoaderCircle } from 'lucide-react'
import { AppHeader } from '@/components/eval/app-header'
import { AppFooter } from '@/components/eval/app-footer'
import { Stepper } from '@/components/eval/stepper'
import { InputPanel } from '@/components/eval/input-panel'
import { ProgressPanel } from '@/components/eval/progress-panel'
import { ErrorPanel } from '@/components/eval/error-panel'
import { ResultView } from '@/components/eval/result-view'
import { MergedReportView } from '@/components/eval/merged-report-view'
import { BatchBar } from '@/components/eval/batch-bar'
import { HistoryDialog, RecentEvaluations } from '@/components/eval/history'
import { LlmConfigPanel } from '@/components/eval/llm-config-panel'
import { useEvaluationFlow } from '@/components/eval/use-evaluation-flow'
import { fetchLlmConfig } from '@/components/eval/api'

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

/** 侧栏信息卡：评估流程（纵向编号轨）+ 数据源标签 */
function PipelineCard() {
  const steps = [
    { no: '01', label: '输入', desc: 'UniProt · 序列 · 评估表' },
    { no: '02', label: '数据收集', desc: '结构 · 文献 · 同源检索' },
    { no: '03', label: '分析生成', desc: '配体归一 · LLM 综合分析' },
    { no: '04', label: '报告', desc: '三方法可行性 · 实验策略' },
  ]
  const sources = ['UniProt', 'RCSB PDB', 'PDBe', 'PubMed', 'NCBI BLAST', 'AlphaFold DB']
  return (
    <section
      aria-label="评估流程与数据源"
      className="overflow-hidden rounded-xl border border-stone-200/90 bg-white shadow-[0_1px_2px_rgba(28,25,23,0.04),0_12px_32px_-24px_rgba(28,25,23,0.18)] dark:border-stone-800 dark:bg-stone-900 dark:shadow-[0_1px_2px_rgba(0,0,0,0.3),0_12px_32px_-24px_rgba(0,0,0,0.5)]"
    >
      <div className="flex items-center gap-2 border-b border-stone-100 px-3.5 py-2.5 dark:border-stone-800/70">
        <span className="eval-eyebrow text-emerald-700 dark:text-emerald-500">Pipeline</span>
        <h2 className="text-[13px] font-semibold text-stone-800 dark:text-stone-100">评估流程</h2>
      </div>
      <ol className="flex flex-col px-3.5 py-3">
        {steps.map((s, i) => (
          <li key={s.no} className="flex gap-2.5">
            <div className="flex flex-col items-center" aria-hidden>
              <span className="flex size-5.5 shrink-0 items-center justify-center rounded-[5px] border border-emerald-200 bg-emerald-50 font-mono text-[9.5px] font-semibold text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-400">
                {s.no}
              </span>
              {i < steps.length - 1 && <span className="w-px flex-1 bg-stone-200 dark:bg-stone-800" />}
            </div>
            <div className={i < steps.length - 1 ? 'min-w-0 flex-1 pb-3' : 'min-w-0 flex-1'}>
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-[12.5px] font-medium text-stone-800 dark:text-stone-200">{s.label}</span>
                <span className="truncate text-[10.5px] text-stone-400 dark:text-stone-500">{s.desc}</span>
              </div>
            </div>
          </li>
        ))}
      </ol>
      <div className="border-t border-stone-100 px-3.5 py-2.5 dark:border-stone-800/70">
        <div className="eval-eyebrow mb-1.5 text-stone-400 dark:text-stone-500">数据源</div>
        <div className="flex flex-wrap gap-1">
          {sources.map((s) => (
            <span
              key={s}
              className="rounded-sm border border-stone-200 bg-stone-50 px-1.5 py-0.5 font-mono text-[10px] text-stone-500 dark:border-stone-700 dark:bg-stone-800/60 dark:text-stone-400"
            >
              {s}
            </span>
          ))}
        </div>
      </div>
    </section>
  )
}

export default function Home() {
  const flow = useEvaluationFlow()
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyKey, setHistoryKey] = useState(0)
  const [llmConfigOpen, setLlmConfigOpen] = useState(false)
  const [engine, setEngine] = useState<{ summary: string; isBuiltin: boolean }>({
    summary: 'Z.ai GLM-4.6（内置）',
    isBuiltin: true,
  })

  // 首次加载读取 LLM 引擎状态（失败静默保持内置）
  useEffect(() => {
    let alive = true
    fetchLlmConfig()
      .then(d => {
        if (alive) setEngine({ summary: d.engineSummary, isBuiltin: !d.active })
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  const handleEngineChange = useCallback((summary: string, isBuiltin: boolean) => {
    setEngine({ summary, isBuiltin })
  }, [])

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

  const openBatchReport = (id: string) => {
    void flow.loadBatchReport(id)
  }

  return (
    <div className="flex min-h-screen flex-col bg-[#fafaf9] text-stone-900 dark:bg-stone-950 dark:text-stone-100">
      <AppHeader
        onOpenHistory={() => setHistoryOpen(true)}
        onHome={handleNewEvaluation}
        canGoHome={flow.phase !== 'idle' && !flow.loadingHistoryJob}
        onOpenLlmConfig={() => setLlmConfigOpen(true)}
        engineIsBuiltin={engine.isBuiltin}
      />

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-4 sm:px-5 sm:py-5">
        {/* 非 idle 阶段：紧凑流程指示器（idle 阶段的流程信息由侧栏 PipelineCard 承载） */}
        {flow.phase !== 'idle' && !flow.loadingHistoryJob && (
          <Stepper step={step} className="mb-4 sm:mb-5" />
        )}

        {flow.loadingHistoryJob ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-stone-500">
            <LoaderCircle className="size-5 animate-spin text-emerald-700" />
            正在加载评估作业…
          </div>
        ) : (
          <AnimatePresence mode="wait">
            {flow.phase === 'idle' && (
              <motion.div key="idle" {...viewMotion}>
                {/* 紧凑双栏：左 = 工作台表单；右 = 最近评估 + 流程信息 */}
                <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-12">
                  <div className="min-w-0 lg:col-span-7">
                    <InputPanel
                      submitting={flow.submitting}
                      submitError={flow.submitError}
                      onStart={flow.startEvaluation}
                      onClearSubmitError={flow.clearSubmitError}
                    />
                  </div>
                  <aside className="flex min-w-0 flex-col gap-4 lg:col-span-5" aria-label="最近评估与流程信息">
                    <RecentEvaluations
                      refreshKey={historyKey}
                      onOpenJob={openHistoryJob}
                      onOpenBatchReport={openBatchReport}
                      onOpenHistory={() => setHistoryOpen(true)}
                    />
                    <PipelineCard />
                  </aside>
                </div>
              </motion.div>
            )}

            {flow.phase === 'running' && (
              <motion.div key="running" {...viewMotion}>
                <ProgressPanel
                  job={flow.job}
                  elapsedSec={flow.elapsedSec}
                  networkIssue={flow.networkIssue}
                  canceling={flow.canceling}
                  batch={flow.batch && !flow.batch.done ? flow.batch : null}
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
              <motion.div key={`done-${flow.job.id}`} {...viewMotion}>
                {flow.batch && flow.batch.items.length > 1 && (
                  <div className="mb-4">
                    <BatchBar
                      batch={flow.batch}
                      currentJobId={flow.job.id}
                      onSelect={(id) => void flow.loadJobById(id, { switchView: true })}
                      onShowMerged={flow.showMergedReport}
                      currentJobLabel={
                        flow.job.summary?.uniprot
                          ? `${flow.job.summary.uniprot.uniprotId} · ${flow.job.summary.uniprot.proteinName || flow.job.summary.uniprot.entryName}`
                          : flow.job.uniprotId ?? null
                      }
                    />
                  </div>
                )}
                {flow.batch?.mergedReport && flow.batch.view === 'merged' ? (
                  <MergedReportView
                    report={flow.batch.mergedReport}
                    targetLabels={flow.batch.items.map(x => x.label)}
                    onNewEvaluation={handleNewEvaluation}
                  />
                ) : (
                  <ResultView job={flow.job} onNewEvaluation={handleNewEvaluation} />
                )}
              </motion.div>
            )}
          </AnimatePresence>
        )}
      </main>

      <AppFooter engineSummary={engine.summary} />

      <HistoryDialog
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        refreshKey={historyKey}
        onOpenJob={(id) => {
          setHistoryOpen(false)
          openHistoryJob(id)
        }}
        onOpenBatchReport={(id) => {
          setHistoryOpen(false)
          openBatchReport(id)
        }}
      />

      <LlmConfigPanel
        open={llmConfigOpen}
        onOpenChange={setLlmConfigOpen}
        onEngineChange={handleEngineChange}
      />
    </div>
  )
}
