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
import { cn } from '@/lib/utils'

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

/** 首屏主视觉（紧凑单行）：眉题 + 衬线标题 + 一句话导引 + 二级结构线稿 */
function StudioHero() {
  return (
    <div className="flex shrink-0 flex-wrap items-end justify-between gap-x-8 gap-y-3">
      <div className="min-w-0 max-w-3xl">
        <div className="flex items-center gap-2.5">
          <span className="eval-eyebrow text-emerald-700 dark:text-emerald-500">
            Evaluation Studio
          </span>
          <span
            aria-hidden
            className="h-px w-10 bg-gradient-to-r from-emerald-700/50 to-transparent dark:from-emerald-500/50"
          />
          <span className="eval-eyebrow text-stone-400 dark:text-stone-500">
            结构解析可行性
          </span>
        </div>
        <h1 className="mt-2 font-display text-[24px] leading-[1.12] font-bold tracking-tight text-stone-900 dark:text-stone-50 sm:text-[26px]">
          开始一次
          <span className="bg-gradient-to-br from-emerald-800 via-emerald-700 to-teal-600 bg-clip-text text-transparent dark:from-emerald-400 dark:via-emerald-400 dark:to-teal-300">
            靶点评估
          </span>
        </h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-stone-500 dark:text-stone-400">
          输入靶点与配体，自动汇集结构、文献与同源数据，生成
          <span className="font-medium text-stone-700 dark:text-stone-200">
            {' '}X-ray · Cryo-EM · NMR{' '}
          </span>
          三方法可行性报告与实验策略建议。
        </p>
      </div>

      {/* 蛋白二级结构线稿（α-螺旋 · β-折叠箭头 · 卷曲）：装饰性科学示意 */}
      <svg
        viewBox="0 0 168 48"
        fill="none"
        aria-hidden
        className="hidden h-12 w-42 shrink-0 lg:block"
      >
        {/* α-螺旋波浪 */}
        <path
          d="M2 32 Q9 15 16 32 T30 32 T44 32"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          className="text-stone-300 dark:text-stone-700"
        />
        {/* 连接环 */}
        <path
          d="M44 32 C52 32 50 19 60 19"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          className="text-stone-300 dark:text-stone-700"
        />
        {/* β-折叠箭头（翡翠强调） */}
        <path
          d="M60 19 L79 12.5 L74.5 21.5 L93 15"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinejoin="round"
          strokeLinecap="round"
          className="text-emerald-600/90 dark:text-emerald-500/90"
        />
        {/* 无规卷曲 */}
        <path
          d="M93 15 C103 12 101 26 113 24 C123 22 121 34 133 32"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          className="text-stone-300 dark:text-stone-700"
        />
        {/* 原子标记 */}
        <circle cx="79" cy="12.5" r="2.6" className="fill-emerald-600/90 dark:fill-emerald-500/90" />
        <circle cx="133" cy="32" r="2.4" className="fill-stone-400/80 dark:fill-stone-600" />
        <circle cx="16" cy="32" r="2" className="fill-stone-400/80 dark:fill-stone-600" />
      </svg>
    </div>
  )
}

/** 右栏 · 评估管线导引（墨色面板）：提交后自动执行的四个阶段 + 数据源 */
function WorkflowGuide() {
  const steps = [
    { no: '01', title: '输入', desc: 'UniProt · 序列 · 评估表' },
    { no: '02', title: '数据收集', desc: '结构 · 文献 · 同源检索' },
    { no: '03', title: '分析生成', desc: '配体归一 · LLM 综合分析' },
    { no: '04', title: '报告', desc: '三方法可行性 · 实验策略' },
  ]
  const sources = ['UniProt', 'RCSB PDB', 'PDBe', 'PubMed', 'NCBI BLAST', 'AlphaFold DB']
  return (
    <motion.section
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: 0.08, ease: 'easeOut' }}
      aria-label="评估工作流"
      className="studio-ink relative shrink-0 overflow-hidden rounded-2xl text-stone-100 shadow-[0_2px_8px_rgba(28,25,23,0.18),0_24px_48px_-28px_rgba(28,25,23,0.5)] ring-1 ring-stone-900/10 dark:ring-black/50"
    >
      {/* 顶部翡翠发丝线 */}
      <div
        aria-hidden
        className="h-px bg-gradient-to-r from-emerald-400/80 via-emerald-400/25 to-transparent"
      />
      <header className="flex items-baseline gap-2 px-4 pt-3 pb-2">
        <span className="eval-eyebrow text-emerald-400">Workflow</span>
        <h2 className="text-[13px] font-semibold tracking-tight text-stone-50">评估管线</h2>
        <span className="ml-auto font-mono text-[10px] text-stone-400">提交后自动执行</span>
      </header>
      <ol className="flex flex-col px-4 pb-3">
        {steps.map((s, i) => (
          <li key={s.no} className="flex gap-3">
            <div className="flex flex-col items-center" aria-hidden>
              <span className="font-display text-[15px] leading-[1.15] font-bold text-emerald-400/90 tabular-nums">
                {s.no}
              </span>
              {i < steps.length - 1 && (
                <span className="my-1.5 w-px flex-1 bg-emerald-500/25" />
              )}
            </div>
            <div
              className={cn(
                'flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2',
                i < steps.length - 1 && 'pb-3',
              )}
            >
              <span className="text-[12.5px] font-medium text-stone-100">{s.title}</span>
              <span className="truncate text-[10.5px] text-stone-400">{s.desc}</span>
            </div>
          </li>
        ))}
      </ol>
      <div className="border-t border-white/[0.08] px-4 pt-2.5 pb-3.5">
        <div className="eval-eyebrow mb-1.5 text-stone-500">数据源</div>
        <div className="flex flex-wrap gap-1">
          {sources.map((s) => (
            <span
              key={s}
              className="rounded-[4px] border border-white/[0.08] bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] text-stone-400"
            >
              {s}
            </span>
          ))}
        </div>
      </div>
    </motion.section>
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

  /** idle 首屏：一屏工作室布局（lg+ 锁定视口高度，内部滚动）；其余阶段正常文档流 */
  const isIdleStudio = flow.phase === 'idle' && !flow.loadingHistoryJob

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
    <div
      className={cn(
        'flex min-h-screen flex-col bg-[#fafaf9] text-stone-900 dark:bg-stone-950 dark:text-stone-100',
        isIdleStudio && 'studio-bg lg:h-dvh lg:min-h-0 lg:overflow-hidden',
      )}
    >
      <AppHeader
        onOpenHistory={() => setHistoryOpen(true)}
        onHome={handleNewEvaluation}
        canGoHome={flow.phase !== 'idle' && !flow.loadingHistoryJob}
        onOpenLlmConfig={() => setLlmConfigOpen(true)}
        engineIsBuiltin={engine.isBuiltin}
      />

      <main className="mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col px-4 py-4 sm:px-5 lg:px-6 lg:py-4">
        {/* 非 idle 阶段：紧凑流程指示器（idle 阶段由 Hero + 右栏管线导引承载） */}
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
              <motion.div key="idle" {...viewMotion} className="flex min-h-0 flex-1 flex-col">
                {/* 主视觉（全宽单行，紧凑） */}
                <StudioHero />

                {/* 工作台双栏：左 = 评估表单；右 = 管线导引 + 最近评估 */}
                <div className="mt-4 grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-12 lg:grid-rows-[minmax(0,1fr)]">
                  <div className="min-h-0 lg:col-span-8">
                    <InputPanel
                      submitting={flow.submitting}
                      submitError={flow.submitError}
                      onStart={flow.startEvaluation}
                      onClearSubmitError={flow.clearSubmitError}
                    />
                  </div>
                  <aside
                    className="flex min-h-0 flex-col gap-4 lg:col-span-4"
                    aria-label="评估管线与最近评估"
                  >
                    <WorkflowGuide />
                    <RecentEvaluations
                      refreshKey={historyKey}
                      onOpenJob={openHistoryJob}
                      onOpenBatchReport={openBatchReport}
                      onOpenHistory={() => setHistoryOpen(true)}
                    />
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
