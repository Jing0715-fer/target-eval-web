'use client'

/**
 * 高通量评估输入面板（v2.22；v2.23 增 Excel 导入）— 嵌入 InputPanel 的「高通量」Tab。
 *
 * 输入契约：「;」分隔组（一组 = 一份独立报告，按复合物批量评估出合并报告），
 * 组内「,」分隔靶点；组内仅一个靶点 = 独立评估。
 * 实时解析预览（组矩阵 + 复合物/单靶点徽章）+ 最近运行历史（恢复 / 回看 / 删除）。
 * v2.23：「从 Excel 导入」— 上传靶点表（.xlsx/.xls/.csv）由 LLM 语义提取分组
 * （组号/复合物列、同行多靶点等），一键填入分组输入（LLM 不可用时规则兜底），
 * 导入可撤销（恢复导入前的手输内容）。
 */

import { useRef, useState } from 'react'
import {
  AlertTriangle,
  CircleAlert,
  CircleCheckBig,
  FileSpreadsheet,
  FileStack,
  LoaderCircle,
  Play,
  RotateCcw,
  Trash2,
  Undo2,
  Zap,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { formatDateTime } from './format'
import { extractHtTargetsFromExcel } from './api'
import type { HTRunState } from './types'

export interface HighThroughputPanelProps {
  value: string
  onChange: (v: string) => void
  parsed: { groups: string[][]; invalid: string[]; duplicates: string[] }
  recentRuns: HTRunState[]
  onResumeRun: (id: string) => void
  onDeleteRun: (id: string) => void
}

const inputBase =
  'w-full rounded-lg border border-input bg-card text-foreground outline-none transition-[border-color,box-shadow] duration-200 placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20 dark:placeholder:text-muted-foreground/60'

/** Excel 导入客户端预校验上限（与服务端 HT_EXCEL_MAX_BYTES 一致） */
const MAX_EXCEL_BYTES = 10 * 1024 * 1024
const EXCEL_EXT_RE = /\.(xlsx|xlsm|xls|csv)$/i

interface ExcelImportMeta {
  fileName: string
  source: 'llm' | 'regex'
  groupCount: number
  targetCount: number
  invalid: string[]
  note?: string
}

function runStatusPill(run: HTRunState): { label: string; cls: string } {
  switch (run.status) {
    case 'running':
      return { label: '进行中', cls: 'border-primary/40 bg-primary/[0.07] text-primary' }
    case 'paused':
      return { label: '已暂停（限流）', cls: 'border-amber-500/40 bg-amber-500/[0.08] text-amber-600 dark:text-amber-400' }
    case 'interrupted':
      return { label: '已中断（可恢复）', cls: 'border-amber-500/40 bg-amber-500/[0.08] text-amber-600 dark:text-amber-400' }
    default:
      return { label: '已完成', cls: 'border-emerald-500/40 bg-emerald-500/[0.08] text-emerald-600 dark:text-emerald-400' }
  }
}

export function HighThroughputPanel({ value, onChange, parsed, recentRuns, onResumeRun, onDeleteRun }: HighThroughputPanelProps) {
  const totalTargets = parsed.groups.reduce((n, g) => n + g.length, 0)

  // ── v2.23 Excel 导入：LLM/规则提取分组 → 填入输入框（可撤销） ──
  const excelInputRef = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [importMeta, setImportMeta] = useState<ExcelImportMeta | null>(null)
  /** 导入前的手输内容（撤销恢复用；null = 本次会话尚无导入） */
  const [preImportText, setPreImportText] = useState<string | null>(null)

  const handleExcelImport = async (file: File | null | undefined) => {
    if (!file || importing) return
    if (!EXCEL_EXT_RE.test(file.name)) {
      setImportError('仅支持 .xlsx / .xlsm / .xls / .csv 格式的靶点表')
      return
    }
    if (file.size > MAX_EXCEL_BYTES) {
      setImportError(`文件超过 10MB 上限（当前 ${(file.size / 1048576).toFixed(1)}MB），请拆分后分次导入`)
      return
    }
    setImporting(true)
    setImportError(null)
    try {
      const r = await extractHtTargetsFromExcel(file)
      if (!r.groups?.length) {
        setImportError(r.note || '未在表格中识别到 UniProt 靶点（表格需含 UniProt accession 列）')
        return
      }
      setPreImportText(value)
      onChange(r.groups.map((g) => g.join(', ')).join(';\n'))
      setImportMeta({
        fileName: file.name,
        source: r.source,
        groupCount: r.groups.length,
        targetCount: r.groups.reduce((n, g) => n + g.length, 0),
        invalid: r.invalid ?? [],
        note: r.note,
      })
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Excel 解析失败，请稍后重试')
    } finally {
      setImporting(false)
    }
  }

  const undoExcelImport = () => {
    if (preImportText === null) return
    onChange(preImportText)
    setPreImportText(null)
    setImportMeta(null)
    setImportError(null)
  }

  return (
    <div className="flex flex-col gap-2.5">
      <Textarea
        aria-label="高通量分组输入"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={
          '按组输入 UniProt ID — 组间用分号「;」分隔，组内用逗号「,」分隔：\n'
          + 'P04637, P00533, Q9Y6K9; O14746\n'
          + 'Q04206; Q14296, Q8N5K9\n'
          + '（组内多个靶点按复合物批量评估并出合并报告；单个靶点则独立评估）'
        }
        className={cn(inputBase, 'min-h-[128px] resize-y px-3.5 py-2.5 font-mono text-[13px] leading-[22px] uppercase placeholder:font-sans placeholder:normal-case placeholder:text-[12px] placeholder:leading-[20px]')}
        spellCheck={false}
      />

      {/* v2.23 Excel 导入：LLM 解析靶点表 → 填充分组输入（覆盖手输，可撤销） */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={excelInputRef}
          type="file"
          accept=".xlsx,.xlsm,.xls,.csv"
          className="hidden"
          onChange={(e) => {
            void handleExcelImport(e.target.files?.[0])
            e.target.value = ''
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={importing}
          onClick={() => excelInputRef.current?.click()}
          className="h-7 gap-1.5 rounded-lg px-2.5 text-[11px] font-medium"
          title="上传 Excel/CSV 靶点表，由 LLM 语义提取分组（组号/复合物列、同行多靶点等）并填入下方输入；LLM 不可用时自动规则提取"
        >
          {importing
            ? <LoaderCircle className="size-3 animate-spin" aria-hidden />
            : <FileSpreadsheet className="size-3" aria-hidden />}
          {importing ? 'AI 解析中…' : '从 Excel 导入'}
        </Button>
        <span className="font-mono text-[10px] text-muted-foreground/70">
          .xlsx / .xls / .csv ≤ 10MB · AI 识别分组列与复合物行 · 导入会替换当前输入
        </span>
      </div>

      {importing && (
        <div className="flex items-center gap-2 rounded-lg border border-primary/25 bg-primary/[0.05] px-2.5 py-1.5 text-[11px] text-foreground/90">
          <LoaderCircle className="size-3.5 shrink-0 animate-spin text-primary" aria-hidden />
          AI 正在解析靶点表：识别 UniProt 靶点与分组语义（组号 / 复合物 / 同行多靶点）…
        </div>
      )}

      {importError && (
        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-red-600 dark:text-red-400">
          <CircleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
          {importError}
        </p>
      )}

      {importMeta && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-primary/25 bg-primary/[0.05] px-2.5 py-1.5">
          <CircleCheckBig className="size-3.5 shrink-0 text-primary" aria-hidden />
          <span className="max-w-52 truncate font-mono text-[11px] text-foreground/90" title={importMeta.fileName}>
            {importMeta.fileName}
          </span>
          <span
            className={cn(
              'rounded-md px-1.5 py-0.5 font-mono text-[9.5px] font-semibold',
              importMeta.source === 'llm'
                ? 'bg-primary/10 text-primary'
                : 'bg-muted text-muted-foreground',
            )}
            title={importMeta.source === 'llm' ? 'LLM 语义提取（组号/复合物列与同行多靶点识别）' : 'LLM 不可用或超时，已按规则提取（组列/同行语义）'}
          >
            {importMeta.source === 'llm' ? 'LLM 智能提取' : '规则提取（LLM 不可用）'}
          </span>
          <span className="font-mono text-[11px] text-foreground/90">
            提取 {importMeta.groupCount} 组 · {importMeta.targetCount} 靶点，已填入下方分组
          </span>
          {importMeta.note && (
            <span className="text-[10px] text-muted-foreground/80">{importMeta.note}</span>
          )}
          {importMeta.invalid.length > 0 && (
            <span className="text-[10px] text-amber-600 dark:text-amber-400">
              未识别条目：{importMeta.invalid.join('、')}
            </span>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={undoExcelImport}
            className="ml-auto h-6 gap-1 rounded-md px-2 text-[10.5px] font-medium text-muted-foreground hover:text-foreground"
            title="恢复导入前的手输内容（覆盖当前已填充分组）"
          >
            <Undo2 className="size-3" aria-hidden />
            撤销导入
          </Button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/60 px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
          <FileStack className="size-3" aria-hidden />
          {parsed.groups.length} 组 · {totalTargets} 靶点
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/60 px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
          <Zap className="size-3" aria-hidden />
          逐组出报告 · 限流自动暂停
        </span>
        {parsed.groups.length > 0 && (
          <span className="font-mono text-[10px] text-muted-foreground/70">
            复合物组 {parsed.groups.filter((g) => g.length > 1).length} · 单靶点组 {parsed.groups.filter((g) => g.length === 1).length}
          </span>
        )}
      </div>

      {/* 分组预览：每组一行（组号 + 靶点 chips + 复合物/单靶点徽章） */}
      {parsed.groups.length > 0 && (
        <ol className="flex flex-col gap-1.5">
          {parsed.groups.map((g, i) => (
            <li key={i} className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-muted/40 px-2.5 py-1.5">
              <span className="shrink-0 rounded-md bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-primary">
                G{String(i + 1).padStart(2, '0')}
              </span>
              {g.map((t) => (
                <span key={t} className="rounded-md border border-border bg-card px-1.5 py-0.5 font-mono text-[11px] text-foreground/90">
                  {t}
                </span>
              ))}
              <span
                className={cn(
                  'ml-auto shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[9.5px] font-semibold',
                  g.length > 1 ? 'bg-violet-500/10 text-violet-600 dark:text-violet-400' : 'bg-muted text-muted-foreground',
                )}
                title={g.length > 1 ? '组内多靶点：关系判断 → 逐靶点评估 → 合并评估报告' : '单靶点独立评估，独立报告'}
              >
                {g.length > 1 ? `复合物 · ${g.length} 靶点` : '单靶点 · 独立评估'}
              </span>
            </li>
          ))}
        </ol>
      )}

      {parsed.invalid.length > 0 && (
        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
          无效 UniProt ID（不符合编号规则，将被忽略）：{parsed.invalid.join('、')}
        </p>
      )}
      {parsed.duplicates.length > 0 && (
        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
          重复靶点已自动去重（仅保留首次出现的组）：{parsed.duplicates.join('、')}
        </p>
      )}

      <p className="text-[11px] leading-relaxed text-muted-foreground/80">
        支持手输或「从 Excel 导入」（AI 语义提取分组）。每组按现有复合物批量评估链路执行
        （靶点关系判断 → 并发评估 → 合并评估报告），组间串行推进；
        遇 LLM 限流 / 服务配额时自动暂停，配额恢复后可从断点重新开始（已完成的组不会重复评估）。
        每组报告与运行日志在完成后均保留可回看。
      </p>

      {/* 最近高通量运行（恢复断点 / 回看结果） */}
      {recentRuns.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-2.5">
          <p className="lin-eyebrow text-muted-foreground/80">Recent Runs · 最近高通量运行</p>
          <ol className="flex flex-col gap-1">
            {recentRuns.slice(0, 3).map((r) => {
              const pill = runStatusPill(r)
              return (
                <li key={r.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border/70 bg-muted/30 px-2.5 py-1.5">
                  <span className={cn('rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium', pill.cls)}>{pill.label}</span>
                  <span className="font-mono text-[11px] text-foreground/90">
                    {r.groups.length} 组 · {r.totalTargetCount} 靶点
                  </span>
                  <span className="font-mono text-[10px] text-muted-foreground/70">{formatDateTime(new Date(r.createdAt).toISOString())}</span>
                  <span className="ml-auto flex items-center gap-1">
                    {r.status !== 'done' ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => onResumeRun(r.id)}
                        className="h-7 gap-1 rounded-lg px-2.5 text-[11px] font-medium"
                        title={r.status === 'paused' ? '从断点恢复运行' : '接上仍在执行的作业，从断点继续'}
                      >
                        <RotateCcw className="size-3" aria-hidden />
                        恢复运行
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => onResumeRun(r.id)}
                        className="h-7 gap-1 rounded-lg px-2.5 text-[11px] font-medium"
                        title="回看该次运行的组结果与日志"
                      >
                        <Play className="size-3" aria-hidden />
                        回看
                      </Button>
                    )}
                    <button
                      type="button"
                      onClick={() => onDeleteRun(r.id)}
                      aria-label="删除该运行记录"
                      className="flex size-7 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-accent hover:text-red-600"
                    >
                      <Trash2 className="size-3" />
                    </button>
                  </span>
                </li>
              )
            })}
          </ol>
        </div>
      )}
    </div>
  )
}
