'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  AlertTriangle,
  ArrowLeft,
  Atom,
  BookOpenText,
  Dna,
  Download,
  ExternalLink,
  Eye,
  Layers,
  Link2,
  Loader2,
  ChevronDown,
  Printer,
  SearchX,
  ShieldCheck,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { describeRelationType } from './types'
import { mdComponents } from './result-view'
import { BlastTable } from './blast-table'
import { LiteratureList } from './literature-list'
import { PdbTable } from './pdb-table'
import { SharedPdbTable, SharedStructuresHeader } from './shared-pdb-table'
import type { BatchReportInfo, MergedTargetLite } from './types'

export interface MergedReportViewProps {
  report: BatchReportInfo
  /** 参与批次的靶点展示标签（chips 用） */
  targetLabels: string[]
  onNewEvaluation: () => void
}

/* ---------------- v2.10 ③：内嵌完整 HTML 合并报告（与下载同一份文件） ---------------- */

/**
 * 同源 iframe 内嵌完整合并报告：web 展示与「下载 HTML」共用同一文件（GET ?inline=1），
 * 样式 100% 一致 — 与单靶点结果页的 ReportFrame 同构（此前合并报告 web 端用 React
 * 重绘、与离线 HTML 双版本渐漂移；现与单独评估一致：直接嵌同一份 HTML）。
 * - 自动高度：注入内嵌适配样式（取消 .page 100vh 最小高 / 隐藏回顶部钮）后按内容同步；
 *   ResizeObserver 监听 body（details 折叠展开 / 图片懒加载引起的高度变化）
 * - 加载失败（报告文件丢失 404）→ onFail 降级为旧版 React 数据区块
 */
function MergedReportFrame({
  url,
  iframeRef,
  onFail,
}: {
  url: string
  iframeRef: React.RefObject<HTMLIFrameElement | null>
  onFail: () => void
}) {
  const [height, setHeight] = useState(1600)
  const [loaded, setLoaded] = useState(false)

  const syncHeight = useCallback(() => {
    const doc = iframeRef.current?.contentDocument
    if (!doc) return
    try {
      if (!doc.getElementById('embed-tweaks')) {
        const st = doc.createElement('style')
        st.id = 'embed-tweaks'
        st.textContent = '.page{min-height:auto!important}.backtop{display:none!important}'
        doc.head.appendChild(st)
      }
      const h = Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight)
      if (Number.isFinite(h) && h > 100) setHeight(h + 16)
    } catch { /* 跨域异常不应发生（同源）；忽略 */ }
  }, [iframeRef])

  useEffect(() => {
    if (!loaded) return
    let ro: ResizeObserver | null = null
    try {
      const doc = iframeRef.current?.contentDocument
      if (doc?.body) {
        ro = new ResizeObserver(() => syncHeight())
        ro.observe(doc.body)
      }
    } catch { /* ignore */ }
    // rAF 延迟一帧再同步高度（避免 effect 内同步 setState 触发级联渲染）
    const raf = requestAnimationFrame(() => syncHeight())
    return () => {
      cancelAnimationFrame(raf)
      ro?.disconnect()
    }
  }, [loaded, syncHeight])

  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-card shadow-none">
      {!loaded && (
        <div className="absolute inset-0 z-10 flex min-h-72 flex-col items-center justify-center gap-3 bg-card">
          <Loader2 className="size-6 animate-spin text-primary" aria-hidden />
          <p className="font-mono text-xs text-muted-foreground">正在加载完整合并报告（与下载 HTML 同一份）…</p>
        </div>
      )}
      <iframe
        ref={iframeRef}
        src={url}
        title="合并评估报告（与下载 HTML 一致）"
        aria-label="合并评估报告（与下载 HTML 一致）"
        onLoad={() => {
          setLoaded(true)
          syncHeight()
          // 报告丢失（404 JSON）→ 降级旧版数据区块
          try {
            const doc = iframeRef.current?.contentDocument
            if (doc && !doc.querySelector('.rpt-head')) onFail()
          } catch { /* ignore */ }
        }}
        style={{ height }}
        className="block w-full bg-white transition-[height] duration-200 ease-out"
      />
    </div>
  )
}

/** 关系类型 → 视觉色调（关联=紫罗兰系；同源家族=青色系；独立批次的合并报告不会走到此视图） */
function relationTone(type: BatchReportInfo['relation']['relationType']): { chip: string; icon: string; border: string } {
  switch (type) {
    case 'antibody-antigen':
      return {
        chip: 'border-violet-500/40 bg-violet-500/[0.08] text-violet-700 dark:text-violet-300',
        icon: 'text-violet-600 dark:text-violet-400',
        border: 'border-violet-500/30 bg-violet-500/[0.06]',
      }
    case 'complex':
      return {
        chip: 'border-primary/40 bg-primary/[0.08] text-primary',
        icon: 'text-primary',
        border: 'border-primary/25 bg-primary/[0.05]',
      }
    case 'homologous':
      return {
        chip: 'border-teal-500/40 bg-teal-500/[0.08] text-teal-700 dark:text-teal-300',
        icon: 'text-teal-600 dark:text-teal-400',
        border: 'border-teal-500/30 bg-teal-500/[0.06]',
      }
    default:
      return {
        chip: 'border-border bg-muted text-foreground/70',
        icon: 'text-muted-foreground',
        border: 'border-border bg-muted/40',
      }
  }
}

/** 靶点分组头（每个数据列表块的归属标识 — 用户要求「能看到属于哪个 UniProt ID」） */
function TargetGroupHeader({ t, right }: { t: MergedTargetLite; right?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
      <span className="rounded-md border border-primary/30 bg-primary/[0.06] px-1.5 py-0.5 font-mono text-[11px] font-semibold text-primary">
        {t.uniprotId ?? '—'}
      </span>
      <span className="text-sm font-semibold text-foreground">{t.proteinName}</span>
      <span className="truncate font-mono text-[11px] text-muted-foreground/70" title={[t.geneNames.slice(0, 3).join('/'), t.organism].filter(Boolean).join(' · ')}>
        {t.geneNames.slice(0, 2).join('/') || '—'} · {t.organism || '—'}
      </span>
      {right && <span className="ml-auto font-mono text-[11px] tabular-nums text-muted-foreground/70">{right}</span>}
    </div>
  )
}

/** 同源结构状态备注（共享自家族代表 / 跳过说明 — 不虚构数据） */
function BlastNote({ t }: { t: MergedTargetLite }) {
  const st = t.blastStatus
  if (!st) return null
  const shared = st.status === 'ok' && (st.note ?? '').includes('共享自家族代表')
  if (st.status === 'ok' && !shared) return null
  return (
    <div className={cn(
      'flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-relaxed',
      shared
        ? 'border-teal-500/30 bg-teal-500/[0.06] text-teal-700 dark:text-teal-300'
        : 'border-border bg-muted/50 text-muted-foreground',
    )}>
      {shared ? <Dna className="mt-0.5 size-3.5 shrink-0" aria-hidden /> : <SearchX className="mt-0.5 size-3.5 shrink-0" aria-hidden />}
      <span>{st.note ?? '未执行同源检索'}</span>
    </div>
  )
}

/** v2.9：各靶点单独简报卡（基本信息 + 预测结构 — 简版；交互 3D 视图见 HTML 报告） */
function TargetMiniReport({ t, index }: { t: MergedTargetLite; index: number }) {
  const af = t.alphafold
  const afOk = af?.available === true
  const overall = t.scores?.overall
  const scoreTone = overall
    ? overall.score >= 7
      ? 'border-emerald-500/40 bg-emerald-500/[0.08] text-emerald-700 dark:text-emerald-300'
      : overall.score >= 4
        ? 'border-amber-500/40 bg-amber-500/[0.08] text-amber-700 dark:text-amber-300'
        : 'border-rose-500/40 bg-rose-500/[0.08] text-rose-700 dark:text-rose-300'
    : 'border-border bg-muted text-muted-foreground'
  const ms = t.methodStats
  const oligoZh = t.oligomer
    ? t.oligomer.category === 'monomer'
      ? '单体'
      : t.oligomer.category === 'homo-oligomer'
        ? '同源寡聚体'
        : t.oligomer.category === 'hetero-complex'
          ? '异源复合物'
          : '未知'
    : ''
  const rows: Array<{ k: string; v: string }> = [
    { k: '方法评分', v: t.scores ? `X-ray ${t.scores.xray.score}/10 · Cryo-EM ${t.scores.cryoem.score}/10 · NMR ${t.scores.nmr.score}/10${t.scores.oligomerAdjust ? '（含聚集形式调整）' : ''}` : '—（历史报告）' },
    { k: '总体可行性', v: overall ? `${overall.score}/10（${overall.rating}）` : '—' },
    { k: '实验结构', v: `${t.directPdbCount} 个${ms ? `（X-ray ${ms.xrayCount} / Cryo-EM ${ms.cryoemCount} / NMR ${ms.nmrCount}）` : ''}${ms?.bestResolution != null ? ` · 最佳 ${ms.bestResolution.toFixed(2)} Å` : ''}` },
    { k: '序列覆盖', v: `${t.coveragePercent}%${t.coverageText ? `（已覆盖 ${t.coverageText.slice(0, 80)}）` : ''}${t.gapText ? ` · 空白 ${t.gapText.slice(0, 80)}` : ''}` },
    { k: '同源结构', v: `${t.blastHitCount} 个` },
    { k: '文献 / 配体', v: `${t.literatureCount ?? t.literature.length} 篇 · ${t.ligandCount ?? 0} 种` },
    ...(t.oligomer ? [{ k: '聚集形式', v: `${oligoZh}${t.oligomer.stoichiometry ? `（${t.oligomer.stoichiometry}）` : ''}` }] : []),
    ...(t.mwAugment?.applicable ? [{ k: '分子量', v: `单体 ~${t.mwAugment.monomerKda} kDa${t.mwAugment.assemblyKda != null ? ` → 装配 ~${t.mwAugment.assemblyKda} kDa` : '（无生物装配增重路径）'}` }] : []),
    ...(t.construct ? [{ k: '客户构建', v: `${t.construct.providedLength} aa（与全长一致性 ${t.construct.identity}%${t.construct.start != null && t.construct.end != null ? `，区间 ${t.construct.start}-${t.construct.end}` : ''}）` }] : []),
  ]
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-border/70 bg-muted/30 px-4 py-3">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-foreground font-mono text-[11px] font-bold text-background">{index + 1}</span>
        <span className="text-sm font-semibold text-foreground">{t.proteinName}</span>
        {t.uniprotId ? (
          <a
            href={`https://www.uniprot.org/uniprotkb/${t.uniprotId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md border border-primary/30 bg-primary/[0.06] px-1.5 py-0.5 font-mono text-[11px] font-semibold text-primary hover:bg-primary/[0.12]"
          >
            {t.uniprotId}
          </a>
        ) : (
          <span className="rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">无 UniProt</span>
        )}
        <span
          className="min-w-0 truncate font-mono text-[11px] text-muted-foreground/70"
          title={[t.geneNames.slice(0, 3).join('/'), t.organism].filter(Boolean).join(' · ')}
        >
          {t.geneNames.slice(0, 2).join('/') || '—'} · {t.organism || '—'} · {t.sequenceLength} aa
        </span>
        {overall && (
          <span className={cn('ml-auto rounded-md border px-2 py-0.5 font-mono text-[11px] font-semibold tabular-nums', scoreTone)}>
            总体 {overall.score}/10 · {overall.rating}
          </span>
        )}
      </div>
      <div className="grid gap-0 sm:grid-cols-[minmax(0,1fr)_240px]">
        <div className="px-4 py-3 sm:border-r sm:border-border/60">
          <div className="mb-2 flex items-center gap-1.5 text-muted-foreground/80">
            <Dna className="size-3.5" aria-hidden />
            <span className="lin-eyebrow">基本信息</span>
          </div>
          <dl className="flex flex-col">
            {rows.map(r => (
              <div key={r.k} className="flex gap-3 border-b border-border/40 py-1.5 text-[12.5px] leading-relaxed last:border-0">
                <dt className="w-20 shrink-0 text-[11px] text-muted-foreground/80">{r.k}</dt>
                <dd className="min-w-0 flex-1 text-foreground/90">{r.v}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="px-4 py-3">
          <div className="mb-2 flex items-center gap-1.5 text-muted-foreground/80">
            <Atom className="size-3.5" aria-hidden />
            <span className="lin-eyebrow">预测结构（AlphaFold）</span>
          </div>
          {afOk ? (
            <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2.5">
              <div className="font-mono text-[11px] leading-relaxed text-foreground/85">
                {af.modelId ?? 'AF 模型'} · v{af.version ?? '?'} · 平均 pLDDT {af.globalPlddt ?? '—'}{af.fracVeryHigh != null ? ` · ≥90 区段 ${Math.round(af.fracVeryHigh * 100)}%` : ''}
              </div>
              {t.uniprotId && (
                <a
                  href={`https://alphafold.ebi.ac.uk/entry/${t.uniprotId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-mono text-[11px] text-primary hover:underline"
                >
                  alphafold.ebi.ac.uk <ExternalLink className="size-3" aria-hidden />
                </a>
              )}
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                交互式 3D 预测结构视图（pLDDT 置信着色 · 拖拽旋转 / 滚轮缩放 / 全屏放大）内嵌于可下载的 HTML 报告中。
              </p>
            </div>
          ) : (
            <p className="rounded-lg border border-dashed border-border bg-muted/40 px-3 py-2.5 text-[12px] leading-relaxed text-muted-foreground">
              {af?.note ?? (t.uniprotId ? '该靶点在 AlphaFold DB 无预测模型' : '序列输入未归属 UniProt — 无 AlphaFold 预测')}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * 合并评估报告视图（v1.8 关联靶点批量）：
 * 返回栏 → 刊头（关系判定卡）→ 报告操作条（下载 HTML / 打印 / 新窗口）→ 内嵌完整
 * HTML 报告（v2.10 ③：与下载文件同一份，web 展示与离线 100% 一致 — 像单独评估那样）；
 * 报告文件丢失时降级为旧版 React 数据区块（合并分析全文 / 各靶点数据列表）。
 * v1.11：新增各靶点 PDB / 同源结构 / 文献三组数据列表（带 UniProt 归属分组头）
 */
export function MergedReportView({ report, targetLabels, onNewEvaluation }: MergedReportViewProps) {
  const rel = report.relation
  const tone = relationTone(rel.relationType)
  const md = report.markdown?.trim() || ''
  const llmOk = report.llmOk !== false && md.length > 0
  const homologPairs = (rel.homologPairs ?? []).filter(p => p.identity > 0)
  const attribution = report.sequenceAttribution ?? []
  const sharedStructures = report.sharedStructures ?? []
  const targets = report.targets ?? []
  const pdbTargets = targets.filter(t => t.directPdbs.length > 0)
  const blastTargets = targets.filter(t => t.blastHits.length > 0 || t.blastStatus)
  const litTargets = targets.filter(t => t.literature.length > 0)
  // v1.24：聚集形式（寡聚态）分析（历史作业无此数据时不显示）
  const oligoTargets = targets.filter(t => t.oligomer)
  // v1.14：LLM 生成的描述性标题（fallback 通用标题）
  const reportTitle = report.title?.trim() || '多靶点合并可行性评估'
  // 剥离 markdown 首行 # 标题（已用作刊头 h1，避免重复渲染）
  const bodyMd = md ? md.replace(/^#\s+.+\r?\n?/, '') : md

  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewLoaded, setPreviewLoaded] = useState(false)
  const [previewSlow, setPreviewSlow] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  /** v2.10 ③：内嵌完整报告加载失败（文件丢失/未生成）→ 降级旧版 React 数据区块 */
  const [embedFailed, setEmbedFailed] = useState(false)
  const reportFrameRef = useRef<HTMLIFrameElement>(null)

  const openPreview = () => {
    setPreviewLoaded(false)
    setPreviewSlow(false)
    setPreviewOpen(true)
  }

  // 预览加载超过 12s 提供降级提示
  useEffect(() => {
    if (!previewOpen || previewLoaded) return
    const t = setTimeout(() => setPreviewSlow(true), 12_000)
    return () => clearTimeout(t)
  }, [previewOpen, previewLoaded])

  const downloadReport = () => {
    window.open(`/api/evaluate/batch-report?id=${encodeURIComponent(report.id)}&download=1`, '_blank')
  }

  const inlineUrl = `/api/evaluate/batch-report?id=${encodeURIComponent(report.id)}&inline=1`

  const confidenceText = rel.confidence === 'high' ? '高' : rel.confidence === 'medium' ? '中' : '低'

  return (
    <div className="flex flex-col gap-8">
      {/* 0. 返回导航条 */}
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          onClick={onNewEvaluation}
          className="h-9 gap-1.5 rounded-lg px-3 text-xs font-medium"
        >
          <ArrowLeft className="size-3.5" />
          新建评估
        </Button>
        <span className="font-mono text-[11px] text-muted-foreground/70">
          合并报告 {report.id.slice(0, 8)} · {targetLabels.length} 个关联靶点
        </span>
      </div>

      {/* 1. 刊头 */}
      <motion.header
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: 'easeOut' }}
        className="flex flex-col gap-3"
      >
        <p className="lin-eyebrow text-primary">
          Merged Evaluation Report · 合并评估报告
        </p>
        <h1 className="text-2xl leading-snug font-semibold tracking-[-0.02em] text-foreground sm:text-[28px]">
          {reportTitle}
        </h1>

        {/* 关系判定卡 */}
        <div className={cn('flex flex-col gap-2.5 rounded-xl border px-4 py-3.5 sm:px-5', tone.border)}>
          <div className="flex flex-wrap items-center gap-2">
            <Link2 className={cn('size-4 shrink-0', tone.icon)} aria-hidden />
            <span className="text-sm font-semibold text-foreground">
              靶点关系：{describeRelationType(rel.relationType)}
            </span>
            <span className={cn('rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-medium', tone.chip)}>
              置信度 {confidenceText}
            </span>
            {rel.error && (
              <span className="rounded-md border border-amber-500/40 bg-amber-500/[0.07] px-1.5 py-0.5 font-mono text-[10px] text-amber-700 dark:text-amber-400">
                判断服务异常，已降级
              </span>
            )}
          </div>
          <p className="text-sm leading-relaxed text-foreground/80">{rel.rationale}</p>
          {rel.strategy && (
            <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
              <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
              <span><span className="lin-eyebrow mr-1.5 text-primary">策略要点</span>{rel.strategy}</span>
            </p>
          )}
          {/* v1.10 同源证据：系统比对一致性徽标行 */}
          {homologPairs.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
              <span className="lin-eyebrow text-muted-foreground/70">序列一致性（系统比对）</span>
              {homologPairs.map(p => (
                <span
                  key={`${p.a}-${p.b}`}
                  className={cn(
                    'rounded-md border px-1.5 py-0.5',
                    p.identity >= 40
                      ? 'border-teal-500/40 bg-teal-500/[0.07] text-teal-700 dark:text-teal-300'
                      : 'border-border bg-muted text-muted-foreground',
                  )}
                  title={`${p.a} 与 ${p.b} 全长序列比对一致性 ${p.identity}%（${p.identity >= 40 ? '家族级同源' : p.identity >= 30 ? '弱同源信号' : '非同源'}）`}
                >
                  {p.a}↔{p.b} {p.identity}%
                </span>
              ))}
            </div>
          )}
        </div>

        {/* 参与靶点 chips */}
        <div className="flex flex-wrap items-center gap-1.5 font-mono text-xs text-muted-foreground">
          <span className="lin-eyebrow text-muted-foreground/70">批次靶点</span>
          {targetLabels.map(l => (
            <span key={l} className="rounded-md border border-border px-1.5 py-0.5">
              {l}
            </span>
          ))}
        </div>
      </motion.header>

      {/* 2. 报告操作条 + 内嵌完整 HTML 报告（v2.10 ③：与下载文件同一份，展示 100% 一致） */}
      <motion.section
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: 0.14, ease: 'easeOut' }}
        className="flex flex-col gap-4"
      >
        <div
          className={cn(
            'flex flex-col gap-4 rounded-xl border px-5 py-4 sm:flex-row sm:items-center',
            llmOk
              ? 'border-violet-500/30 bg-violet-500/[0.06]'
              : 'border-amber-500/30 bg-amber-500/[0.06]'
          )}
        >
          <div className="flex items-center gap-3">
            <div className={cn(
              'flex size-9 shrink-0 items-center justify-center rounded-lg text-primary-foreground',
              llmOk ? 'bg-violet-600 dark:bg-violet-700' : 'bg-amber-600 dark:bg-amber-700'
            )}>
              {llmOk ? <Layers className="size-4.5" /> : <AlertTriangle className="size-4.5" />}
            </div>
            <div>
              <div className="text-sm font-semibold text-foreground">
                {llmOk ? '合并评估报告已生成' : '合并报告（LLM 部分失败）'}
              </div>
              <div className="font-mono text-[11px] text-muted-foreground">
                完整 HTML 报告 · 在线展示与下载文件一致{md.length > 0 ? ` · ${md.length.toLocaleString()} 字分析` : ''} · 可独立分享
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 sm:ml-auto">
            <Button
              onClick={openPreview}
              className="h-10 gap-2 rounded-lg bg-primary px-4 font-medium text-primary-foreground hover:bg-[#7a84dc] dark:hover:bg-[#828fff]"
            >
              <Eye className="size-4" />
              大窗预览
            </Button>
            <Button
              onClick={downloadReport}
              className="h-10 gap-2 rounded-lg bg-violet-600 px-4 font-medium text-white hover:bg-violet-700 dark:bg-violet-700"
            >
              <Download className="size-4" />
              下载 HTML（{reportTitle.slice(0, 12)}{reportTitle.length > 12 ? '…' : ''}）
            </Button>
            {!embedFailed && (
              <Button
                onClick={() => reportFrameRef.current?.contentWindow?.print()}
                variant="outline"
                className="h-10 gap-2 rounded-lg border-violet-500/40 bg-card px-4 font-medium text-violet-700 hover:bg-violet-500/[0.06] dark:text-violet-300"
              >
                <Printer className="size-4" />
                打印
              </Button>
            )}
          </div>
        </div>
        {!embedFailed ? (
          <MergedReportFrame url={inlineUrl} iframeRef={reportFrameRef} onFail={() => setEmbedFailed(true)} />
        ) : (
          <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-3.5 py-2.5 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            完整 HTML 报告加载失败（文件可能已被服务器清理）— 已切换为在线数据视图；可尝试「大窗预览 / 下载 HTML」或重新发起评估。
          </div>
        )}
      </motion.section>

      {/* 3-6 旧版 React 数据区块：仅内嵌报告不可用时降级展示（与单靶点结果页同构） */}
      {embedFailed && <>
      {/* 2.5 评估表序列归属（v1.10 — 每条序列的去向，不再静默丢弃） */}
      {attribution.length > 0 && (
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.18, ease: 'easeOut' }}
          className="flex flex-col gap-2.5"
          aria-labelledby="sec-attribution"
        >
          <div id="sec-attribution" className="lin-eyebrow text-muted-foreground">
            Sequence Attribution · 评估表序列归属（系统比对）
          </div>
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-border bg-muted/60">
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">#</th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">序列</th>
                    <th className="px-3 py-2 text-right font-medium text-muted-foreground">长度</th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">最佳匹配</th>
                    <th className="px-3 py-2 text-right font-medium text-muted-foreground">一致性</th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">归属</th>
                  </tr>
                </thead>
                <tbody>
                  {attribution.map((a, i) => {
                    const kindMeta = {
                      construct: { text: '客户构建 · 已并入评估', cls: 'border-teal-500/40 bg-teal-500/[0.07] text-teal-700 dark:text-teal-300' },
                      homolog: { text: '同源家族成员', cls: 'border-amber-500/40 bg-amber-500/[0.07] text-amber-700 dark:text-amber-300' },
                      antibody: { text: '抗体 · 背景证据', cls: 'border-violet-500/40 bg-violet-500/[0.07] text-violet-700 dark:text-violet-300' },
                      unmatched: { text: '未匹配', cls: 'border-border bg-muted text-muted-foreground' },
                    }[a.kind]
                    return (
                      <tr key={a.index} className="border-b border-border/60 last:border-0" title={a.note}>
                        <td className="px-3 py-2 font-mono text-muted-foreground/60">{i + 1}</td>
                        <td className="max-w-56 truncate px-3 py-2 text-foreground/80" title={a.header}>
                          {a.header || '（未命名序列）'}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-foreground/80">{a.length} aa</td>
                        <td className="px-3 py-2 font-mono text-foreground/80">{a.uniprotId ?? '—'}</td>
                        <td className="px-3 py-2 text-right font-mono text-foreground/80">{a.identity != null ? `${a.identity}%` : '—'}</td>
                        <td className="px-3 py-2">
                          <span className={cn('inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium', kindMeta.cls)}>
                            {kindMeta.text}
                            {a.kind === 'construct' && a.start != null && a.end != null && (
                              <span className="ml-1 font-mono opacity-75">{a.start}-{a.end}</span>
                            )}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </motion.section>
      )}

      {/* 3. 合并分析全文 */}
      <motion.section
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: 0.2, ease: 'easeOut' }}
        className="flex flex-col gap-3"
        aria-labelledby="sec-merged-report"
      >
        <div id="sec-merged-report" className="lin-eyebrow text-muted-foreground">
          Merged Analysis · 合并分析（摘要 / 关系分析 / 各靶点综述 / 整合策略）
        </div>
        {!llmOk && (() => {
          const errs = report.errors ?? []
          return (
            <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-3.5 py-2.5 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              合并报告 LLM 分析生成失败或部分失败{errs.length > 0 && `（${errs.join('；')}）`}；
              可在批次完成后重新发起评估重试。各靶点的结构化数据（评分 / PDB / BLAST / 文献）经切换栏查看。
            </div>
          )
        })()}
        <Card className="rounded-xl border-border bg-card shadow-none">
          <CardContent className="px-5 py-5 sm:px-7 sm:py-6">
            <div className="mb-4 flex items-center gap-2 text-muted-foreground/70">
              <BookOpenText className="size-3.5" aria-hidden />
              <span className="lin-eyebrow">Analysis · 由大语言模型基于批次结构化数据生成，结论供参考</span>
            </div>
            {md ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                {bodyMd}
              </ReactMarkdown>
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">
                合并分析生成失败 — 各靶点数据经上方切换栏查看
              </p>
            )}
          </CardContent>
        </Card>
      </motion.section>

      {/* 3.2 各靶点单独报告（v2.9 — 简版：基本信息 + 预测结构；交互 3D 视图见 HTML 报告） */}
      {targets.length > 0 && (
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.2, ease: 'easeOut' }}
          className="flex flex-col gap-3"
          aria-labelledby="sec-merged-mini"
        >
          <div id="sec-merged-mini" className="lin-eyebrow text-muted-foreground">
            Per-Target Reports · 各靶点单独报告（{targets.length} · 基本信息 + 预测结构）
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            批次内每个靶点的独立简报（精简版，不重复单独评估的全部明细）— 完整数据见下方 PDB 结构 / 同源结构 / 文献章节；
            交互式 3D 预测结构视图（pLDDT 置信着色 · 拖拽旋转 / 滚轮缩放 / 全屏放大）内嵌于可下载的 HTML 报告中。
          </p>
          <div className="flex flex-col gap-4">
            {targets.map((t, i) => (
              <TargetMiniReport key={t.jobId} t={t} index={i} />
            ))}
          </div>
        </motion.section>
      )}

      {/* 3.5 共有结构（v1.22 — 同一 PDB 覆盖多个输入 UniProt） */}
      {sharedStructures.length > 0 && (
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.22, ease: 'easeOut' }}
          className="flex flex-col gap-3"
          aria-labelledby="sec-merged-shared"
        >
          <SharedStructuresHeader count={sharedStructures.length} total={targets.length} />
          <p className="text-xs leading-relaxed text-muted-foreground">
            同一 PDB 条目同时覆盖多个输入 UniProt 的结构（复合物亚基共结晶 / 抗体-抗原复合物 / 融合构建等）。
            「覆盖靶点」列按输入顺序列出该 PDB 引用的各 UniProt 及其链范围（UniProt 残基编号）。
            按覆盖靶点数降序、分辨率升序排列。
          </p>
          <SharedPdbTable shared={sharedStructures} />
        </motion.section>
      )}

      {/* 3.5 聚集形式（v1.25：融入为折叠块，不再单独成章 — 判定已计入各靶点评分，分析见合并分析全文） */}
      {oligoTargets.length > 0 && (
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.22, ease: 'easeOut' }}
          aria-labelledby="sec-merged-oligomer"
        >
          <details className="group overflow-hidden rounded-xl border border-border bg-card">
            <summary className="flex cursor-pointer select-none flex-wrap items-center gap-x-2 gap-y-1.5 px-5 py-3.5 list-none [&::-webkit-details-marker]:hidden">
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground/60 transition-transform duration-200 group-open:rotate-180" aria-hidden />
              <span id="sec-merged-oligomer" className="lin-eyebrow text-muted-foreground">
                Oligomeric State · 聚集形式判定（{oligoTargets.length} 个靶点 · 已计入各靶点评分）
              </span>
              <span className="ml-auto flex flex-wrap justify-end gap-1.5">
                {oligoTargets.map(t => {
                  const o = t.oligomer!
                  const catZh = o.category === 'monomer' ? '单体' : o.category === 'homo-oligomer' ? '同源寡聚体' : o.category === 'hetero-complex' ? '异源复合物' : '未知'
                  const badgeCls = o.category === 'monomer'
                    ? 'border-emerald-500/40 bg-emerald-500/[0.08] text-emerald-700 dark:text-emerald-400'
                    : o.category === 'hetero-complex'
                      ? 'border-amber-500/40 bg-amber-500/[0.08] text-amber-700 dark:text-amber-400'
                      : 'border-border bg-muted text-foreground/70'
                  return (
                    <span key={`chip-${t.jobId}`} className={cn('inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10.5px] font-semibold', badgeCls)}>
                      {t.uniprotId ?? t.proteinName} {catZh}
                    </span>
                  )
                })}
              </span>
            </summary>
            <div className="flex flex-col gap-4 border-t border-border px-5 py-4">
              {oligoTargets.map(t => {
                const o = t.oligomer!
                const catZh = o.category === 'monomer' ? '单体' : o.category === 'homo-oligomer' ? '同源寡聚体' : o.category === 'hetero-complex' ? '异源复合物' : '未知'
                const confZh = o.confidence === 'high' ? '高' : o.confidence === 'medium' ? '中' : '低'
                const badgeCls = o.category === 'monomer'
                  ? 'border-emerald-500/40 bg-emerald-500/[0.08] text-emerald-700 dark:text-emerald-400'
                  : o.category === 'hetero-complex'
                    ? 'border-amber-500/40 bg-amber-500/[0.08] text-amber-700 dark:text-amber-400'
                    : 'border-border bg-muted text-foreground/70'
                return (
                  <div key={t.jobId} className="flex flex-col gap-2.5 rounded-xl border border-border bg-card px-5 py-4">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <span className="text-sm font-semibold text-foreground">
                        {t.proteinName}
                        {t.uniprotId && <span className="ml-1.5 font-mono text-[11px] font-normal text-muted-foreground/70">{t.uniprotId}</span>}
                      </span>
                      <span className={cn('inline-flex min-h-6 items-center rounded-md border px-2 text-[11px] font-semibold', badgeCls)}>{catZh}</span>
                      {o.stoichiometry && (
                        <span className="rounded-md border border-border bg-muted/60 px-2 py-0.5 font-mono text-[10.5px] text-foreground/80">
                          {o.stoichiometry}
                        </span>
                      )}
                      <span className="ml-auto font-mono text-[10.5px] text-muted-foreground/60">置信度 {confZh}</span>
                    </div>
                    <p className="text-[13px] leading-6 text-foreground/80">{o.summary}</p>
                    {t.mwAugment?.applicable && (
                      <p className="text-xs leading-6 text-muted-foreground">
                        <span className="lin-eyebrow mr-1.5 text-primary">分子量增重</span>
                        单体 ~{t.mwAugment.monomerKda} kDa
                        {t.mwAugment.assemblyKda != null
                          ? ` → 装配 ~${t.mwAugment.assemblyKda} kDa（${t.mwAugment.assemblyPath === 'complex' ? '已有复合物结构' : t.mwAugment.assemblyPath === 'oligomer' ? '自身寡聚' : t.mwAugment.assemblyPath === 'homolog-complex' ? '同源复合物推断（BLAST）' : '互作伙伴推断'}）`
                          : '（无生物装配增重路径 — 需技术增重策略）'}
                        {(t.mwAugment.homologComplexes ?? []).length > 0
                          ? `；同源复合物 ${(t.mwAugment.homologComplexes ?? []).map(h => `${h.pdbId}（identity ${Math.round(h.identity)}%，靶点换算 ~${h.estimatedKda} kDa）`).join('、')}`
                          : t.mwAugment.homologSearchNote
                            ? `；${t.mwAugment.homologSearchNote}`
                            : ''}
                      </p>
                    )}
                    {o.evidence.length > 0 && (
                      <ul className="grid gap-1.5 sm:grid-cols-2">
                        {o.evidence.map((e, i) => (
                          <li key={`${t.jobId}-${e.ref}-${i}`} className="flex items-baseline gap-2 rounded-md border border-border/70 bg-muted/40 px-2.5 py-1.5 text-[11px] leading-relaxed text-foreground/80">
                            <span className="shrink-0 font-mono text-[10px] font-semibold text-primary">{e.ref}</span>
                            <span className="min-w-0 flex-1">{e.text}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )
              })}
              <p className="text-[11px] leading-relaxed text-muted-foreground/70">
                聚集形式由系统按证据优先级判定（已有结构 → 同源结构 → UniProt interaction → 文献）；判定与调整已计入各靶点评分，分析已融入上方合并分析全文，完整明细见下载的 HTML 报告。
              </p>
            </div>
          </details>
        </motion.section>
      )}

      {/* 4. 各靶点 PDB 结构（v1.11 — 带 UniProt 归属，与单靶点结果页同等粒度） */}
      {pdbTargets.length > 0 && (
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.24, ease: 'easeOut' }}
          className="flex flex-col gap-3"
          aria-labelledby="sec-merged-pdb"
        >
          <div id="sec-merged-pdb" className="lin-eyebrow text-muted-foreground">
            Structures by Target · 各靶点 PDB 结构（{pdbTargets.reduce((s, t) => s + t.directPdbCount, 0)} 个）
          </div>
          <div className="flex flex-col gap-5">
            {pdbTargets.map(t => (
              <div key={t.jobId} className="flex flex-col gap-2">
                <TargetGroupHeader t={t} right={`${t.directPdbCount} PDB · 覆盖率 ${t.coveragePercent}%`} />
                <PdbTable pdbs={t.directPdbs} literature={t.literature} />
              </div>
            ))}
          </div>
        </motion.section>
      )}

      {/* 5. 同源结构（BLAST/序列检索 — 含共享自家族代表的标注） */}
      {blastTargets.length > 0 && (
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.28, ease: 'easeOut' }}
          className="flex flex-col gap-3"
          aria-labelledby="sec-merged-blast"
        >
          <div id="sec-merged-blast" className="flex flex-wrap items-center gap-x-2">
            <span className="lin-eyebrow text-muted-foreground">
              Homologous Structures · 同源结构（BLAST / 序列检索）
            </span>
            {(rel.blastGroups ?? []).length > 0 && (
              <span className="rounded-md border border-teal-500/40 bg-teal-500/[0.07] px-1.5 py-0.5 font-mono text-[10px] text-teal-700 dark:text-teal-300">
                ≥90% 家族成员共享一次检索
              </span>
            )}
          </div>
          <div className="flex flex-col gap-5">
            {blastTargets.map(t => (
              <div key={t.jobId} className="flex flex-col gap-2">
                <TargetGroupHeader t={t} right={t.blastHits.length > 0 ? `${t.blastHitCount} 个同源结构` : '无命中'} />
                {t.blastHits.length > 0 && <BlastTable hits={t.blastHits} />}
                <BlastNote t={t} />
              </div>
            ))}
          </div>
        </motion.section>
      )}

      {/* 6. 各靶点文献（v1.11 — 归属 UniProt，含结构解析文献标记） */}
      {litTargets.length > 0 && (
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.32, ease: 'easeOut' }}
          className="flex flex-col gap-3"
          aria-labelledby="sec-merged-lit"
        >
          <div id="sec-merged-lit" className="lin-eyebrow text-muted-foreground">
            Literature by Target · 各靶点文献（{litTargets.reduce((s, t) => s + t.literature.length, 0)} 篇）
          </div>
          <div className="flex flex-col gap-5">
            {litTargets.map(t => (
              <div key={t.jobId} className="flex flex-col gap-2">
                <TargetGroupHeader t={t} right={`${t.literature.length} 篇`} />
                <LiteratureList items={t.literature} pdbs={t.directPdbs} />
              </div>
            ))}
          </div>
        </motion.section>
      )}

      </>
      /* 内嵌报告正常时以上数据区块不渲染（HTML 报告内已含同等数据，避免双版本漂移） */}

      {/* 报告在线预览（大窗口 iframe + 加载态 + 新窗口/打印） */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent
          showCloseButton
          className="flex h-[88vh] w-[calc(100vw-2rem)] max-w-6xl flex-col gap-0 overflow-hidden rounded-xl p-0 sm:w-full xl:max-w-[1280px] 2xl:max-w-[1560px]"
        >
          <DialogHeader className="flex-row items-center justify-between gap-4 border-b border-border px-5 py-3 pr-14 text-left">
            <div className="flex flex-col gap-0.5">
              <DialogTitle className="flex items-center gap-2 text-base font-semibold tracking-[-0.01em]">
                合并评估报告 · {report.id.slice(0, 8)}
              </DialogTitle>
              <DialogDescription className="font-mono text-[11px] text-muted-foreground/70">
                完整 HTML 报告 · 可直接打印
              </DialogDescription>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                variant="outline"
                size="sm"
                onClick={() => iframeRef.current?.contentWindow?.print()}
                className="h-8 gap-1.5 rounded-lg bg-card px-2.5 font-mono text-[11px]"
              >
                <Printer className="size-3.5" />
                打印
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => window.open(inlineUrl, '_blank')}
                className="h-8 gap-1.5 rounded-lg bg-card px-2.5 font-mono text-[11px]"
              >
                <ExternalLink className="size-3.5" />
                新窗口
              </Button>
            </div>
          </DialogHeader>
          <div className="relative min-h-0 flex-1">
            {!previewLoaded && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-card">
                <Loader2 className="size-6 animate-spin text-primary" />
                {previewSlow ? (
                  <div className="flex max-w-xs flex-col items-center gap-3 px-4 text-center">
                    <p className="text-xs text-muted-foreground">
                      报告加载较慢（含内嵌图片时体积较大），也可选择其他方式查看：
                    </p>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => window.open(inlineUrl, '_blank')}
                        className="h-8 gap-1.5 rounded-lg"
                      >
                        <ExternalLink className="size-3.5" />
                        新窗口打开
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={downloadReport}
                        className="h-8 gap-1.5 rounded-lg"
                      >
                        <Download className="size-3.5" />
                        下载
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="font-mono text-xs text-muted-foreground/70">报告加载中…</p>
                )}
              </div>
            )}
            <iframe
              ref={iframeRef}
              src={inlineUrl}
              title="合并评估报告预览"
              onLoad={() => setPreviewLoaded(true)}
              className="h-full w-full bg-white"
            />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
