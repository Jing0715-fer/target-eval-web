'use client'

import { useCallback, useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { LoaderCircle, PenLine, Globe2, Sparkles, FileCheck2 } from 'lucide-react'
import { AppHeader } from '@/components/eval/app-shell'
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
import { useHighThroughputFlow } from '@/components/eval/use-high-throughput-flow'
import { HighThroughputView } from '@/components/eval/high-throughput-progress'
import { fetchLlmConfig, getLlmEngineOverride } from '@/components/eval/api'
import { toast } from '@/hooks/use-toast'
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

/** 首屏主视觉（v2.86 Refined Studio）：mono 眉题 + 渐变强调大标题 + 导引 + 能力 chips */
function StudioHero() {
  return (
    <div className="relative shrink-0">
      {/* 环境光晕 + 点阵网格（装饰层，不拦截交互） */}
      <div aria-hidden className="studio-ambient absolute -inset-x-8 -top-10 bottom-0 -z-10" />
      <div aria-hidden className="studio-grid absolute -inset-x-8 -top-10 bottom-0 -z-10" />
      <div className="min-w-0 max-w-3xl xl:max-w-4xl">
        <div className="anim-fade-up flex items-center gap-2.5">
          <span className="lin-eyebrow rounded-md border border-primary/25 bg-primary/[0.05] px-1.5 py-0.5 text-primary">
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
        <h1
          className="anim-fade-up mt-2.5 text-[26px] leading-[1.1] font-semibold tracking-[-0.025em] text-foreground sm:text-[30px] xl:text-[34px]"
          style={{ animationDelay: '60ms' }}
        >
          开始一次
          <span className="text-gradient-brand">靶点评估</span>
        </h1>
        <p
          className="anim-fade-up mt-2 max-w-xl text-[13px] leading-relaxed text-muted-foreground sm:text-[13.5px]"
          style={{ animationDelay: '120ms' }}
        >
          输入靶点与配体，自动汇集结构、文献与同源数据，生成
          <span className="font-medium text-foreground/80">
            {' '}X-ray · Cryo-EM · NMR{' '}
          </span>
          三方法可行性报告与实验策略建议。
        </p>
        {/* v2.86 能力 chips：一眼看清平台能力入口 */}
        <div
          className="anim-fade-up mt-3.5 flex flex-wrap items-center gap-1.5"
          style={{ animationDelay: '180ms' }}
        >
          {['多靶点批量', '高通量逐组', 'Word 评估表导入', 'LLM 综合分析', '报告原文内嵌'].map((chip) => (
            <span
              key={chip}
              className="rounded-md border border-border bg-card/80 px-2 py-0.5 text-[10.5px] font-medium text-muted-foreground shadow-[0_1px_2px_rgb(22_23_29/0.03)] dark:bg-card/60"
            >
              {chip}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

/** 右栏 · 评估管线导引（v2.86 Claude 式）：语义色图标色块（welcome-stat-badge 模式）+
 *  悬浮缩放 + 连线轨道 + 数据源徽标 — 四步骤各配参考项目语义色 */
function WorkflowGuide() {
  const steps = [
    { no: '01', title: '输入', desc: 'UniProt · 序列 · 评估表', icon: PenLine, color: '#5e6ad2', tint: 'var(--accent-light)' },
    { no: '02', title: '数据收集', desc: '结构 · 文献 · 同源检索', icon: Globe2, color: '#2d8f8f', tint: 'var(--cryoem-bg)' },
    { no: '03', title: '分析生成', desc: '配体归一 · LLM 综合分析', icon: Sparkles, color: '#7c5cbf', tint: 'var(--xray-bg)' },
    { no: '04', title: '报告', desc: '三方法可行性 · 实验策略', icon: FileCheck2, color: '#c9872e', tint: 'var(--nmr-bg)' },
  ]
  const sources = ['UniProt', 'RCSB PDB', 'PDBe', 'PubMed', 'NCBI BLAST', 'AlphaFold DB']
  return (
    <motion.section
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: 0.08, ease: 'easeOut' }}
      aria-label="评估工作流"
      className="studio-card relative shrink-0 overflow-hidden rounded-xl border border-border bg-card"
    >
      {/* 顶部渐变发丝线 — 品牌质感 */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/30 to-transparent"
      />
      <header className="flex items-center gap-2 px-4 pt-3.5 pb-2">
        <span className="lin-eyebrow text-primary">Workflow</span>
        <h2 className="text-[13px] font-semibold tracking-[-0.01em] text-foreground">评估管线</h2>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground/60">提交后自动执行</span>
      </header>
      <ol className="flex flex-col px-4 pb-3">
        {steps.map((s, i) => (
          <li key={s.no} className="group flex gap-3">
            <div className="flex flex-col items-center" aria-hidden>
              {/* 参考项目 welcome-stat-badge：色块容器 + hover 缩放 110% */}
              <span
                className="flex size-7 items-center justify-center rounded-lg transition-transform duration-200 group-hover:scale-110"
                style={{ backgroundColor: s.tint }}
              >
                <s.icon className="size-3.5" style={{ color: s.color }} />
              </span>
              {i < steps.length - 1 && (
                <span className="my-1 w-px flex-1 bg-gradient-to-b from-border to-border/40" />
              )}
            </div>
            <div
              className={cn(
                'flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2',
                i < steps.length - 1 && 'pb-3.5',
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
              className="rounded-md border border-border bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors duration-200 hover:border-primary/30 hover:text-foreground"
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
  // v2.22 高通量评估：独立编排状态机（组间串行 + 限流自动暂停 + 断点续跑）
  const ht = useHighThroughputFlow()
  const htActive = ht.phase !== 'idle'
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyKey, setHistoryKey] = useState(0)
  const [llmConfigOpen, setLlmConfigOpen] = useState(false)
  const [engine, setEngine] = useState<{ summary: string; isBuiltin: boolean }>({
    summary: 'Z.ai GLM-4.6（内置）',
    isBuiltin: true,
  })

  // 首次加载读取 LLM 引擎状态（v2.19：读浏览器 localStorage；顺带触发服务端
  // 历史存量配置的一次性清除 — fetchLlmConfig GET 副作用；失败静默保持内置）
  useEffect(() => {
    const llm = getLlmEngineOverride()
    setEngine({
      summary: llm ? `${llm.label || llm.providerKey} · ${llm.model}` : 'Z.ai GLM-4.6（内置）',
      isBuiltin: !llm,
    })
    void fetchLlmConfig().catch(() => undefined)
  }, [])

  const handleEngineChange = useCallback((summary: string, isBuiltin: boolean) => {
    setEngine({ summary, isBuiltin })
  }, [])

  // 作业进入终态（done / error）时刷新侧边栏最近评估列表（常驻展示需要保持新鲜）；
  // v2.22：高通量运行完成同样刷新（各组产出已入库）
  useEffect(() => {
    if (flow.phase === 'done' || flow.phase === 'error') {
      setHistoryKey((k) => k + 1)
    }
  }, [flow.phase])

  useEffect(() => {
    if (ht.phase === 'done') {
      setHistoryKey((k) => k + 1)
    }
  }, [ht.phase])

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
    ht.exitToIdle()
    flow.reset()
    setHistoryKey((k) => k + 1) // 刷新最近评估列表
    if (typeof window !== 'undefined') window.scrollTo({ top: 0 })
  }

  // 历史记录入口守卫：高通量运行中不切换视图（前端编排不中断）；
  // paused/done 时退出 HT 视图后正常打开（运行记录保留在本地与 HT 标签页）
  const openHistoryJob = (id: string) => {
    if (ht.phase === 'running') {
      toast({
        title: '高通量评估进行中',
        description: '请先等待完成或停止高通量运行，再查看历史评估（运行中的编排不可后台切换）。',
        variant: 'destructive',
      })
      return
    }
    ht.exitToIdle()
    void flow.loadJob(id)
  }

  const openBatchReport = (id: string) => {
    if (ht.phase === 'running') {
      toast({
        title: '高通量评估进行中',
        description: '请先等待完成或停止高通量运行，再查看合并报告。',
        variant: 'destructive',
      })
      return
    }
    ht.exitToIdle()
    void flow.loadBatchReport(id)
  }

  return (
    // v2.87：overflow-x-clip — Hero 环境层（studio-grid/ambient -inset-x-8 出血）
    // 在窄屏把文档撑出横向滚动条（390px 视口实测 406px）；clip（非 hidden）
    // 不创建滚动容器，粘性顶栏/页脚不受影响
    <div className="flex min-h-dvh flex-col overflow-x-clip bg-background text-foreground">
      {/* 顶部应用栏（v1.3：恢复原顶栏布局 — 功能在顶部，历史记录在 workflow 下方） */}
      <AppHeader
        onOpenHistory={() => setHistoryOpen(true)}
        onHome={handleNewEvaluation}
        canGoHome={flow.phase !== 'idle' && !flow.loadingHistoryJob}
        onOpenLlmConfig={() => setLlmConfigOpen(true)}
        engineIsBuiltin={engine.isBuiltin}
        isIdle={flow.phase === 'idle'}
      />

      {/* 主列：工作区 + 页脚（v2.4 宽屏：xl 起放开容器宽度，充分利用页面） */}
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 py-4 sm:px-6 lg:px-8 lg:py-5 xl:max-w-[1440px] 2xl:max-w-[1720px]">
          {/* 非 idle 阶段：紧凑流程指示器（idle 阶段由 Hero + 右栏管线导引承载）；
              v2.22：高通量运行使用自带组导航的独立视图，不显示单链 Stepper */}
          {flow.phase !== 'idle' && !flow.loadingHistoryJob && !htActive && (
            <Stepper step={step} className="mb-5" />
          )}

          {flow.loadingHistoryJob ? (
            <div className="flex flex-1 items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <LoaderCircle className="size-5 animate-spin text-primary" />
              正在加载评估作业…
            </div>
          ) : (
            <AnimatePresence mode="wait">
              {/* v2.22 高通量评估视图（running / paused / done）— 优先于单链 flow 分支渲染 */}
              {htActive && (
                <motion.div key="ht" {...viewMotion}>
                  <HighThroughputView
                    flow={ht}
                    onOpenJob={(id) => {
                      ht.exitToIdle()
                      void flow.loadJob(id)
                    }}
                    onOpenBatchReport={(id) => {
                      ht.exitToIdle()
                      void flow.loadBatchReport(id)
                    }}
                    onNewEvaluation={handleNewEvaluation}
                  />
                </motion.div>
              )}

              {flow.phase === 'idle' && !htActive && (
                <motion.div key="idle" {...viewMotion} className="flex flex-1 flex-col">
                  {/* 主视觉 */}
                  <StudioHero />

                  {/* 工作台双栏：左 = 评估表单；右 = 管线导引 + 历史记录（v1.3：历史放在 workflow 下面）
                      v2.4 宽屏：xl 起 7/5 比例（表单更饱满 + 最近评估列表更宽敞）；双栏铺满视口剩余高度 */}
                  <div className="mt-4 grid flex-1 grid-cols-1 gap-4 lg:grid-cols-12 lg:items-stretch">
                    <div className="lg:col-span-8 xl:col-span-7">
                      <InputPanel
                        submitting={flow.submitting || ht.starting}
                        submitError={flow.submitError}
                        onStart={flow.startEvaluation}
                        onClearSubmitError={flow.clearSubmitError}
                        onStartHighThroughput={ht.startRun}
                        recentHTRuns={ht.recentRuns}
                        onResumeHTRun={ht.openRunById}
                        onDeleteHTRun={ht.removeRun}
                        onArchiveHTRun={(id) => void ht.archiveRun(id)}
                        htArchiving={ht.archiving}
                      />
                    </div>
                    <aside
                      className="flex min-w-0 flex-col gap-4 lg:col-span-4 xl:col-span-5"
                      aria-label="评估管线与最近评估"
                    >
                      <WorkflowGuide />
                      {/* 最近评估（常驻右栏，workflow 下方；内部滚动；宽屏放开高度上限充分利用纵向空间）
                          v2.87：高度上限放开从 xl 提前到 lg — lg 档 max-h-400 与左栏拉伸高度
                          不匹配，卡底到栏底留出 ~100px 空洞（右侧排版被扰乱）；lg 起即随栏伸展填满 */}
                      <div className="studio-card flex max-h-[400px] min-h-[220px] flex-col overflow-hidden rounded-xl border border-border bg-card lg:max-h-none lg:flex-1">
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

              {flow.phase === 'running' && !htActive && (
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

              {flow.phase === 'error' && !htActive && (
                <motion.div key="error" {...viewMotion}>
                  <ErrorPanel
                    job={flow.job}
                    submitting={flow.submitting}
                    submitError={flow.submitError}
                    onRetry={flow.retry}
                    onReset={flow.reset}
                  />
                </motion.div>
              )}

              {flow.phase === 'done' && flow.job && !htActive && (
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
                      onRegenerated={flow.updateMergedReport}
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
