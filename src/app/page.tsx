'use client'

import { useCallback, useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { LoaderCircle } from 'lucide-react'
import { AppSidebar, MobileHeader } from '@/components/eval/app-shell'
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

/** 首屏主视觉（Linear 式）：mono 眉题 + 紧字距标题 + 一句话导引 */
function StudioHero() {
  return (
    <div className="shrink-0">
      <div className="min-w-0 max-w-3xl">
        <div className="flex items-center gap-2.5">
          <span className="lin-eyebrow text-primary">
            Evaluation Studio
          </span>
          <span
            aria-hidden
            className="h-px w-10 bg-gradient-to-r from-primary/50 to-transparent"
          />
          <span className="lin-eyebrow text-muted-foreground/60">
            结构解析可行性
          </span>
        </div>
        <h1 className="mt-2 text-[24px] leading-[1.12] font-semibold tracking-[-0.02em] text-foreground sm:text-[27px]">
          开始一次
          <span className="text-primary">靶点评估</span>
        </h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
          输入靶点与配体，自动汇集结构、文献与同源数据，生成
          <span className="font-medium text-foreground/80">
            {' '}X-ray · Cryo-EM · NMR{' '}
          </span>
          三方法可行性报告与实验策略建议。
        </p>
      </div>
    </div>
  )
}

/** 右栏 · 评估管线导引（Linear 表面阶梯卡）：提交后自动执行的四个阶段 + 数据源 */
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
      className="relative shrink-0 overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_2px_rgb(22_23_29/0.04)] dark:shadow-[0_1px_2px_rgb(0_0_0/0.4)]"
    >
      <header className="flex items-baseline gap-2 px-4 pt-3.5 pb-2">
        <span className="lin-eyebrow text-primary">Workflow</span>
        <h2 className="text-[13px] font-semibold tracking-[-0.01em] text-foreground">评估管线</h2>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground/60">提交后自动执行</span>
      </header>
      <ol className="flex flex-col px-4 pb-3">
        {steps.map((s, i) => (
          <li key={s.no} className="flex gap-3">
            <div className="flex flex-col items-center" aria-hidden>
              <span className="font-mono text-[13px] leading-[1.3] font-semibold text-primary tabular-nums">
                {s.no}
              </span>
              {i < steps.length - 1 && (
                <span className="my-1.5 w-px flex-1 bg-primary/25" />
              )}
            </div>
            <div
              className={cn(
                'flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2',
                i < steps.length - 1 && 'pb-3',
              )}
            >
              <span className="text-[12.5px] font-medium text-foreground">{s.title}</span>
              <span className="truncate text-[10.5px] text-muted-foreground/70">{s.desc}</span>
            </div>
          </li>
        ))}
      </ol>
      <div className="border-t border-border/70 px-4 pt-2.5 pb-3.5">
        <div className="lin-eyebrow mb-1.5 text-muted-foreground/60">数据源</div>
        <div className="flex flex-wrap gap-1">
          {sources.map((s) => (
            <span
              key={s}
              className="rounded-md border border-border bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
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

  /** idle 首屏：一屏工作台布局（lg+ 锁定视口高度，内部滚动）；其余阶段正常文档流 */
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

  // 作业进入终态（done / error）时刷新侧边栏最近评估列表（常驻展示需要保持新鲜）
  useEffect(() => {
    if (flow.phase === 'done' || flow.phase === 'error') {
      setHistoryKey((k) => k + 1)
    }
  }, [flow.phase])

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
        'flex min-h-dvh bg-background text-foreground',
        isIdleStudio && 'lg:h-dvh lg:min-h-0 lg:overflow-hidden',
      )}
    >
      {/* 桌面侧边导航（含最近评估） */}
      <AppSidebar
        onOpenHistory={() => setHistoryOpen(true)}
        onHome={handleNewEvaluation}
        canGoHome={flow.phase !== 'idle' && !flow.loadingHistoryJob}
        onOpenLlmConfig={() => setLlmConfigOpen(true)}
        engineIsBuiltin={engine.isBuiltin}
        isIdle={flow.phase === 'idle'}
      >
        <RecentEvaluations
          refreshKey={historyKey}
          onOpenJob={openHistoryJob}
          onOpenBatchReport={openBatchReport}
          onOpenHistory={() => setHistoryOpen(true)}
        />
      </AppSidebar>

      {/* 主列：移动顶栏 + 工作区 + 页脚 */}
      <div className="flex min-h-dvh min-w-0 flex-1 flex-col lg:h-dvh lg:min-h-0">
        <MobileHeader
          onOpenHistory={() => setHistoryOpen(true)}
          onHome={handleNewEvaluation}
          canGoHome={flow.phase !== 'idle' && !flow.loadingHistoryJob}
          onOpenLlmConfig={() => setLlmConfigOpen(true)}
          engineIsBuiltin={engine.isBuiltin}
        />

        <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 py-4 sm:px-6 lg:min-h-0 lg:px-8 lg:py-5">
          {/* 非 idle 阶段：紧凑流程指示器（idle 阶段由 Hero + 右栏管线导引承载） */}
          {flow.phase !== 'idle' && !flow.loadingHistoryJob && (
            <Stepper step={step} className="mb-5" />
          )}

          {flow.loadingHistoryJob ? (
            <div className="flex flex-1 items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <LoaderCircle className="size-5 animate-spin text-primary" />
              正在加载评估作业…
            </div>
          ) : (
            <AnimatePresence mode="wait">
              {flow.phase === 'idle' && (
                <motion.div key="idle" {...viewMotion} className="flex min-h-0 flex-1 flex-col">
                  {/* 主视觉 */}
                  <StudioHero />

                  {/* 工作台双栏：左 = 评估表单；右 = 管线导引 */}
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
                      {/* 移动端最近评估（桌面端在左侧导航栏常驻展示） */}
                      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card lg:hidden">
                        <RecentEvaluations
                          refreshKey={historyKey}
                          onOpenJob={openHistoryJob}
                          onOpenBatchReport={openBatchReport}
                          onOpenHistory={() => setHistoryOpen(true)}
                        />
                      </div>
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
      </div>

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
