'use client'

import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  AlertTriangle,
  ArrowLeft,
  BookOpenText,
  Dna,
  Download,
  ExternalLink,
  Eye,
  Layers,
  Link2,
  Loader2,
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
import type { BatchReportInfo, MergedTargetLite } from './types'

export interface MergedReportViewProps {
  report: BatchReportInfo
  /** 参与批次的靶点展示标签（chips 用） */
  targetLabels: string[]
  onNewEvaluation: () => void
}

/** 关系类型 → 视觉色调（关联=紫罗兰系；同源家族=青色系；独立批次的合并报告不会走到此视图） */
function relationTone(type: BatchReportInfo['relation']['relationType']): { chip: string; icon: string; border: string } {
  switch (type) {
    case 'antibody-antigen':
      return {
        chip: 'border-violet-300 bg-violet-100 text-violet-800 dark:border-violet-800 dark:bg-violet-950/60 dark:text-violet-300',
        icon: 'text-violet-600 dark:text-violet-400',
        border: 'border-violet-200 bg-violet-50/60 dark:border-violet-900/60 dark:bg-violet-950/20',
      }
    case 'complex':
      return {
        chip: 'border-emerald-300 bg-emerald-100 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300',
        icon: 'text-emerald-600 dark:text-emerald-400',
        border: 'border-emerald-200 bg-emerald-50/60 dark:border-emerald-800/60 dark:bg-emerald-950/20',
      }
    case 'homologous':
      return {
        chip: 'border-teal-300 bg-teal-100 text-teal-800 dark:border-teal-800 dark:bg-teal-950/60 dark:text-teal-300',
        icon: 'text-teal-600 dark:text-teal-400',
        border: 'border-teal-200 bg-teal-50/60 dark:border-teal-900/60 dark:bg-teal-950/20',
      }
    default:
      return {
        chip: 'border-stone-300 bg-stone-100 text-stone-700 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-300',
        icon: 'text-stone-500 dark:text-stone-400',
        border: 'border-stone-200 bg-stone-50/60 dark:border-stone-800 dark:bg-stone-900/40',
      }
  }
}

/** 靶点分组头（每个数据列表块的归属标识 — 用户要求「能看到属于哪个 UniProt ID」） */
function TargetGroupHeader({ t, right }: { t: MergedTargetLite; right?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
      <span className="rounded-sm border border-teal-300 bg-teal-50 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-teal-800 dark:border-teal-800 dark:bg-teal-950/40 dark:text-teal-300">
        {t.uniprotId ?? '—'}
      </span>
      <span className="text-sm font-semibold text-stone-800 dark:text-stone-100">{t.proteinName}</span>
      <span className="truncate font-mono text-[11px] text-stone-400 dark:text-stone-500" title={[t.geneNames.slice(0, 3).join('/'), t.organism].filter(Boolean).join(' · ')}>
        {t.geneNames.slice(0, 2).join('/') || '—'} · {t.organism || '—'}
      </span>
      {right && <span className="ml-auto font-mono text-[11px] tabular-nums text-stone-400 dark:text-stone-500">{right}</span>}
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
      'flex items-start gap-2 rounded-md border px-3 py-2 text-xs leading-relaxed',
      shared
        ? 'border-teal-200 bg-teal-50/70 text-teal-800 dark:border-teal-900/70 dark:bg-teal-950/30 dark:text-teal-300'
        : 'border-stone-200 bg-stone-50/70 text-stone-500 dark:border-stone-800 dark:bg-stone-900/60 dark:text-stone-400',
    )}>
      {shared ? <Dna className="mt-0.5 size-3.5 shrink-0" aria-hidden /> : <SearchX className="mt-0.5 size-3.5 shrink-0" aria-hidden />}
      <span>{st.note ?? '未执行同源检索'}</span>
    </div>
  )
}

/**
 * 合并评估报告视图（v1.8 关联靶点批量）：
 * 返回栏 → 刊头（关系判定卡）→ 报告操作条（下载 HTML）→ LLM 合并分析全文
 * v1.11：新增各靶点 PDB / 同源结构 / 文献三组数据列表（带 UniProt 归属分组头）
 */
export function MergedReportView({ report, targetLabels, onNewEvaluation }: MergedReportViewProps) {
  const rel = report.relation
  const tone = relationTone(rel.relationType)
  const md = report.markdown?.trim() || ''
  const llmOk = report.llmOk !== false && md.length > 0
  const homologPairs = (rel.homologPairs ?? []).filter(p => p.identity > 0)
  const attribution = report.sequenceAttribution ?? []
  const targets = report.targets ?? []
  const pdbTargets = targets.filter(t => t.directPdbs.length > 0)
  const blastTargets = targets.filter(t => t.blastHits.length > 0 || t.blastStatus)
  const litTargets = targets.filter(t => t.literature.length > 0)

  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewLoaded, setPreviewLoaded] = useState(false)
  const [previewSlow, setPreviewSlow] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement>(null)

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
          className="h-9 gap-1.5 rounded-md border-stone-300 px-3 text-xs font-medium text-stone-600 hover:border-emerald-400 hover:text-emerald-800 dark:border-stone-700 dark:text-stone-300 dark:hover:border-emerald-700 dark:hover:text-emerald-400"
        >
          <ArrowLeft className="size-3.5" />
          新建评估
        </Button>
        <span className="font-mono text-[11px] text-stone-400 dark:text-stone-500">
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
        <p className="eval-eyebrow text-violet-700 dark:text-violet-400">
          Merged Evaluation Report · 合并评估报告
        </p>
        <h1 className="font-display text-2xl leading-snug font-bold text-stone-900 sm:text-3xl dark:text-stone-50">
          多靶点合并可行性评估
        </h1>

        {/* 关系判定卡 */}
        <div className={cn('flex flex-col gap-2.5 rounded-lg border px-4 py-3.5 sm:px-5', tone.border)}>
          <div className="flex flex-wrap items-center gap-2">
            <Link2 className={cn('size-4 shrink-0', tone.icon)} aria-hidden />
            <span className="text-sm font-semibold text-stone-800 dark:text-stone-100">
              靶点关系：{describeRelationType(rel.relationType)}
            </span>
            <span className={cn('rounded-sm border px-1.5 py-0.5 font-mono text-[10px] font-medium', tone.chip)}>
              置信度 {confidenceText}
            </span>
            {rel.error && (
              <span className="rounded-sm border border-amber-300 bg-amber-50 px-1.5 py-0.5 font-mono text-[10px] text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-400">
                判断服务异常，已降级
              </span>
            )}
          </div>
          <p className="text-sm leading-relaxed text-stone-600 dark:text-stone-300">{rel.rationale}</p>
          {rel.strategy && (
            <p className="flex items-start gap-2 text-xs leading-relaxed text-stone-500 dark:text-stone-400">
              <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-500" aria-hidden />
              <span><span className="eval-eyebrow mr-1.5 text-emerald-700 dark:text-emerald-500">策略要点</span>{rel.strategy}</span>
            </p>
          )}
          {/* v1.10 同源证据：系统比对一致性徽标行 */}
          {homologPairs.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-stone-500 dark:text-stone-400">
              <span className="eval-eyebrow text-stone-400">序列一致性（系统比对）</span>
              {homologPairs.map(p => (
                <span
                  key={`${p.a}-${p.b}`}
                  className={cn(
                    'rounded-sm border px-1.5 py-0.5',
                    p.identity >= 40
                      ? 'border-teal-300 bg-teal-50 text-teal-700 dark:border-teal-800 dark:bg-teal-950/40 dark:text-teal-300'
                      : 'border-stone-200 bg-stone-50 text-stone-500 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-400',
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
        <div className="flex flex-wrap items-center gap-1.5 font-mono text-xs text-stone-500 dark:text-stone-400">
          <span className="eval-eyebrow text-stone-400">批次靶点</span>
          {targetLabels.map(l => (
            <span key={l} className="rounded-sm border border-stone-200 px-1.5 py-0.5 dark:border-stone-700">
              {l}
            </span>
          ))}
        </div>
      </motion.header>

      {/* 2. 报告操作条 */}
      <motion.section
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: 0.14, ease: 'easeOut' }}
        className={cn(
          'flex flex-col gap-4 rounded-lg border px-5 py-4 sm:flex-row sm:items-center',
          llmOk
            ? 'border-violet-300 bg-violet-50/60 dark:border-violet-800 dark:bg-violet-950/20'
            : 'border-amber-300 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/20'
        )}
      >
        <div className="flex items-center gap-3">
          <div className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-md text-white',
            llmOk ? 'bg-violet-700 dark:bg-violet-800' : 'bg-amber-600 dark:bg-amber-700'
          )}>
            {llmOk ? <Layers className="size-4.5" /> : <AlertTriangle className="size-4.5" />}
          </div>
          <div>
            <div className="text-sm font-semibold text-stone-900 dark:text-stone-100">
              {llmOk ? '合并评估报告已生成' : '合并报告（LLM 部分失败）'}
            </div>
            <div className="font-mono text-[11px] text-stone-500 dark:text-stone-400">
              HTML · {md.length > 0 ? `${md.length.toLocaleString()} 字分析` : '分析缺失'} · 可独立下载分享
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 sm:ml-auto">
          <Button
            onClick={openPreview}
            disabled={!llmOk}
            className="h-10 gap-2 rounded-md bg-violet-700 px-4 font-medium text-white hover:bg-violet-600 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-violet-800 dark:hover:bg-violet-700"
          >
            <Eye className="size-4" />
            在线预览报告
          </Button>
          <Button
            onClick={downloadReport}
            disabled={!llmOk}
            variant="outline"
            className="h-10 gap-2 rounded-md border-violet-300 px-4 font-medium text-violet-700 hover:bg-violet-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-violet-800 dark:text-violet-300 dark:hover:bg-violet-950/40"
          >
            <Download className="size-4" />
            下载 HTML
          </Button>
        </div>
      </motion.section>

      {/* 2.5 评估表序列归属（v1.10 — 每条序列的去向，不再静默丢弃） */}
      {attribution.length > 0 && (
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.18, ease: 'easeOut' }}
          className="flex flex-col gap-2.5"
          aria-labelledby="sec-attribution"
        >
          <div id="sec-attribution" className="eval-eyebrow text-stone-500 dark:text-stone-400">
            Sequence Attribution · 评估表序列归属（系统比对）
          </div>
          <div className="overflow-hidden rounded-lg border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-stone-200 bg-stone-50 dark:border-stone-800 dark:bg-stone-900/60">
                    <th className="px-3 py-2 text-left font-medium text-stone-500 dark:text-stone-400">#</th>
                    <th className="px-3 py-2 text-left font-medium text-stone-500 dark:text-stone-400">序列</th>
                    <th className="px-3 py-2 text-right font-medium text-stone-500 dark:text-stone-400">长度</th>
                    <th className="px-3 py-2 text-left font-medium text-stone-500 dark:text-stone-400">最佳匹配</th>
                    <th className="px-3 py-2 text-right font-medium text-stone-500 dark:text-stone-400">一致性</th>
                    <th className="px-3 py-2 text-left font-medium text-stone-500 dark:text-stone-400">归属</th>
                  </tr>
                </thead>
                <tbody>
                  {attribution.map((a, i) => {
                    const kindMeta = {
                      construct: { text: '客户构建 · 已并入评估', cls: 'border-teal-300 bg-teal-50 text-teal-700 dark:border-teal-800 dark:bg-teal-950/40 dark:text-teal-300' },
                      homolog: { text: '同源家族成员', cls: 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300' },
                      antibody: { text: '抗体 · 背景证据', cls: 'border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-300' },
                      unmatched: { text: '未匹配', cls: 'border-stone-300 bg-stone-50 text-stone-500 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-400' },
                    }[a.kind]
                    return (
                      <tr key={a.index} className="border-b border-stone-100 last:border-0 dark:border-stone-800/60" title={a.note}>
                        <td className="px-3 py-2 font-mono text-stone-400">{i + 1}</td>
                        <td className="max-w-56 truncate px-3 py-2 text-stone-600 dark:text-stone-300" title={a.header}>
                          {a.header || '（未命名序列）'}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-stone-600 dark:text-stone-300">{a.length} aa</td>
                        <td className="px-3 py-2 font-mono text-stone-600 dark:text-stone-300">{a.uniprotId ?? '—'}</td>
                        <td className="px-3 py-2 text-right font-mono text-stone-600 dark:text-stone-300">{a.identity != null ? `${a.identity}%` : '—'}</td>
                        <td className="px-3 py-2">
                          <span className={cn('inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[11px] font-medium', kindMeta.cls)}>
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
        <div id="sec-merged-report" className="eval-eyebrow text-stone-500 dark:text-stone-400">
          Merged Analysis · 合并分析（摘要 / 关系分析 / 各靶点综述 / 整合策略）
        </div>
        {!llmOk && (() => {
          const errs = report.errors ?? []
          return (
            <div className="flex items-start gap-2.5 rounded-md border border-amber-200 bg-amber-50/70 px-3.5 py-2.5 text-xs leading-relaxed text-amber-800 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              合并报告 LLM 分析生成失败或部分失败{errs.length > 0 && `（${errs.join('；')}）`}；
              可在批次完成后重新发起评估重试。各靶点的结构化数据（评分 / PDB / BLAST / 文献）经切换栏查看。
            </div>
          )
        })()}
        <Card className="rounded-lg border-stone-200 bg-white shadow-none dark:border-stone-800 dark:bg-stone-900">
          <CardContent className="px-5 py-5 sm:px-7 sm:py-6">
            <div className="mb-4 flex items-center gap-2 text-stone-400 dark:text-stone-500">
              <BookOpenText className="size-3.5" aria-hidden />
              <span className="eval-eyebrow">Analysis · 由大语言模型基于批次结构化数据生成，结论供参考</span>
            </div>
            {md ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                {md}
              </ReactMarkdown>
            ) : (
              <p className="py-6 text-center text-sm text-stone-500 dark:text-stone-400">
                合并分析生成失败 — 各靶点数据经上方切换栏查看
              </p>
            )}
          </CardContent>
        </Card>
      </motion.section>

      {/* 4. 各靶点 PDB 结构（v1.11 — 带 UniProt 归属，与单靶点结果页同等粒度） */}
      {pdbTargets.length > 0 && (
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.24, ease: 'easeOut' }}
          className="flex flex-col gap-3"
          aria-labelledby="sec-merged-pdb"
        >
          <div id="sec-merged-pdb" className="eval-eyebrow text-stone-500 dark:text-stone-400">
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
            <span className="eval-eyebrow text-stone-500 dark:text-stone-400">
              Homologous Structures · 同源结构（BLAST / 序列检索）
            </span>
            {(rel.blastGroups ?? []).length > 0 && (
              <span className="rounded-sm border border-teal-200 bg-teal-50 px-1.5 py-0.5 font-mono text-[10px] text-teal-700 dark:border-teal-900 dark:bg-teal-950/40 dark:text-teal-300">
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
          <div id="sec-merged-lit" className="eval-eyebrow text-stone-500 dark:text-stone-400">
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

      {/* 报告在线预览（大窗口 iframe + 加载态 + 新窗口/打印） */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent
          showCloseButton
          className="flex h-[88vh] w-full max-w-6xl flex-col gap-0 overflow-hidden rounded-lg p-0 sm:max-w-6xl"
        >
          <DialogHeader className="flex-row items-center justify-between gap-4 border-b border-stone-200 px-5 py-3 pr-14 text-left dark:border-stone-800">
            <div className="flex flex-col gap-0.5">
              <DialogTitle className="flex items-center gap-2 font-display text-base">
                合并评估报告 · {report.id.slice(0, 8)}
              </DialogTitle>
              <DialogDescription className="font-mono text-[11px] text-stone-400 dark:text-stone-500">
                完整 HTML 报告 · 可直接打印
              </DialogDescription>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                variant="outline"
                size="sm"
                onClick={() => iframeRef.current?.contentWindow?.print()}
                className="h-8 gap-1.5 rounded-md border-stone-300 bg-white px-2.5 font-mono text-[11px] text-stone-600 hover:border-violet-400 hover:text-violet-800 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300"
              >
                <Printer className="size-3.5" />
                打印
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => window.open(inlineUrl, '_blank')}
                className="h-8 gap-1.5 rounded-md border-stone-300 bg-white px-2.5 font-mono text-[11px] text-stone-600 hover:border-violet-400 hover:text-violet-800 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300"
              >
                <ExternalLink className="size-3.5" />
                新窗口
              </Button>
            </div>
          </DialogHeader>
          <div className="relative min-h-0 flex-1">
            {!previewLoaded && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-white dark:bg-stone-950">
                <Loader2 className="size-6 animate-spin text-violet-700 dark:text-violet-500" />
                {previewSlow ? (
                  <div className="flex max-w-xs flex-col items-center gap-3 px-4 text-center">
                    <p className="text-xs text-stone-500 dark:text-stone-400">
                      报告加载较慢（含内嵌图片时体积较大），也可选择其他方式查看：
                    </p>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => window.open(inlineUrl, '_blank')}
                        className="h-8 gap-1.5 rounded-md"
                      >
                        <ExternalLink className="size-3.5" />
                        新窗口打开
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={downloadReport}
                        className="h-8 gap-1.5 rounded-md"
                      >
                        <Download className="size-3.5" />
                        下载
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="font-mono text-xs text-stone-400">报告加载中…</p>
                )}
              </div>
            )}
            <iframe
              ref={iframeRef}
              src={inlineUrl}
              title="合并评估报告预览"
              onLoad={() => setPreviewLoaded(true)}
              className="h-full w-full bg-white dark:bg-stone-950"
            />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
