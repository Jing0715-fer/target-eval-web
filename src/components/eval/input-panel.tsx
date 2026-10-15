'use client'

import { useMemo, useState } from 'react'
import {
  ChevronDown,
  CircleAlert,
  CircleCheckBig,
  Dna,
  FileText,
  LoaderCircle,
  Settings2,
  Target,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { countResidues, isValidUniprotId } from './format'
import { uploadEvaluateDocx } from './api'
import { DocxUploadPanel, validateDocxFile } from './docx-upload-panel'
import type { EvaluateOptions, EvaluateRequest, InputMode, UploadResponse } from './types'
import type { StartResult } from './use-evaluation-flow'

type TabMode = InputMode

const EXAMPLE_UNIPROTS = [
  { id: 'P00533', name: 'EGFR' },
  { id: 'P04637', name: 'p53' },
]

const MIN_SEQUENCE_LENGTH = 10

export interface InputPanelProps {
  submitting: boolean
  submitError: string | null
  onStart: (request: EvaluateRequest) => Promise<StartResult>
  onClearSubmitError: () => void
}

/** 输入视图（idle）：三种输入模式 + 客户目标 + 高级选项 + 开始评估 */
export function InputPanel({ submitting, submitError, onStart, onClearSubmitError }: InputPanelProps) {
  const [mode, setMode] = useState<TabMode>('uniprot')

  // UniProt 输入
  const [uniprot, setUniprot] = useState('')
  const uniprotValid = isValidUniprotId(uniprot)

  // 序列输入
  const [sequenceText, setSequenceText] = useState('')
  const seqInfo = useMemo(() => countResidues(sequenceText), [sequenceText])

  // Word 评估表上传
  const [upload, setUpload] = useState<UploadResponse | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [selectedUniprot, setSelectedUniprot] = useState<string | null>(null)
  const [selectedSequenceIndex, setSelectedSequenceIndex] = useState<number | null>(null)
  const docxReady = Boolean(
    upload && (selectedUniprot || (selectedSequenceIndex != null && upload.parsed.sequences[selectedSequenceIndex]))
  )

  // 客户目标
  const [goal, setGoal] = useState('')

  // 高级选项
  const [advOpen, setAdvOpen] = useState(false)
  const [blastEnabled, setBlastEnabled] = useState(true)
  const [forceBlast, setForceBlast] = useState(false)
  const [maxPdb, setMaxPdb] = useState(150)

  const handleFileSelected = async (file: File) => {
    const invalid = validateDocxFile(file)
    if (invalid) {
      setUploadError(invalid)
      return
    }
    setUploading(true)
    setUploadError(null)
    try {
      const res = await uploadEvaluateDocx(file)
      setUpload(res)
      // 默认选中第一个 UniProt，否则第一个序列
      if (res.parsed.uniprotIds.length > 0) {
        setSelectedUniprot(res.parsed.uniprotIds[0])
        setSelectedSequenceIndex(null)
      } else if (res.parsed.sequences.length > 0) {
        setSelectedUniprot(null)
        setSelectedSequenceIndex(0)
      } else {
        setSelectedUniprot(null)
        setSelectedSequenceIndex(null)
      }
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : '上传解析失败，请稍后重试')
    } finally {
      setUploading(false)
    }
  }

  const clearUpload = () => {
    setUpload(null)
    setSelectedUniprot(null)
    setSelectedSequenceIndex(null)
    setUploadError(null)
  }

  const inputReady =
    mode === 'uniprot'
      ? uniprotValid
      : mode === 'sequence'
        ? seqInfo.count >= MIN_SEQUENCE_LENGTH
        : docxReady

  const handleStart = async () => {
    if (!inputReady || submitting) return
    onClearSubmitError()
    const options: EvaluateOptions = {
      skipBlast: !blastEnabled,
      forceBlast: blastEnabled && forceBlast,
      maxPdb,
    }
    const trimmedGoal = goal.trim() || undefined
    let request: EvaluateRequest
    if (mode === 'uniprot') {
      request = { mode: 'uniprot', uniprot: uniprot.trim().toUpperCase(), goal: trimmedGoal, options }
    } else if (mode === 'sequence') {
      request = { mode: 'sequence', sequence: sequenceText.trim(), goal: trimmedGoal, options }
    } else if (!upload) {
      return
    } else {
      const selectedSeq =
        selectedSequenceIndex != null
          ? (upload.parsed.sequences[selectedSequenceIndex]?.seq ?? undefined)
          : undefined
      request = {
        mode: 'docx',
        // 契约字段 docxJobId + 兼容别名 uploadId（同值），后端取任一均可
        docxJobId: upload.uploadId,
        uploadId: upload.uploadId,
        uniprotFromDocx: selectedUniprot ?? undefined,
        sequence: selectedSeq,
        sequenceFromDocx: selectedSeq,
        goal: trimmedGoal,
        options,
      }
    }
    await onStart(request)
  }

  return (
    <Card className="gap-5 rounded-xl border-stone-200 bg-white shadow-sm dark:border-stone-800 dark:bg-stone-900">
      <CardHeader className="px-5 sm:px-6">
        <CardTitle className="text-base text-stone-900 dark:text-stone-100">新建靶点评估</CardTitle>
        <CardDescription>
          输入 UniProt ID、氨基酸序列，或上传 Word 评估表，系统将自动收集结构生物学数据并生成可行性评估报告
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-5 px-5 sm:px-6">
        {/* 输入模式 Tabs */}
        <Tabs value={mode} onValueChange={(v) => setMode(v as TabMode)}>
          <TabsList className="h-12 w-full">
            <TabsTrigger value="uniprot" className="min-h-11 gap-1.5 text-xs sm:text-sm">
              <Dna className="size-4" />
              UniProt ID
            </TabsTrigger>
            <TabsTrigger value="sequence" className="min-h-11 gap-1.5 text-xs sm:text-sm">
              <Target className="size-4" />
              氨基酸序列
            </TabsTrigger>
            <TabsTrigger value="docx" className="min-h-11 gap-1.5 text-xs sm:text-sm">
              <FileText className="size-4" />
              Word 评估表
            </TabsTrigger>
          </TabsList>

          <TabsContent value="uniprot" className="mt-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="uniprot-input" className="text-sm">
                UniProt Accession
              </Label>
              <Input
                id="uniprot-input"
                value={uniprot}
                onChange={(e) => {
                  setUniprot(e.target.value)
                }}
                placeholder="如 P00533 (EGFR)、P04637 (p53)"
                className="h-11 font-mono text-base uppercase placeholder:font-sans placeholder:normal-case md:text-sm"
                spellCheck={false}
                autoComplete="off"
              />
              {uniprot.trim() !== '' && !uniprotValid && (
                <p className="flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
                  <CircleAlert className="size-3.5" />
                  格式不正确：UniProt accession 为 6 或 10 位（如 P00533、Q9NZ08）
                </p>
              )}
              {uniprotValid && (
                <p className="flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400">
                  <CircleCheckBig className="size-3.5" />
                  格式正确，将自动获取该蛋白的元数据与结构信息
                </p>
              )}
              {uniprot.trim() === '' && (
                <div className="flex flex-wrap items-center gap-2 text-xs text-stone-500">
                  <span>快捷示例：</span>
                  {EXAMPLE_UNIPROTS.map((ex) => (
                    <button
                      key={ex.id}
                      type="button"
                      onClick={() => setUniprot(ex.id)}
                      className="min-h-9 rounded-full border border-stone-300 bg-stone-50 px-2.5 font-mono text-[11px] text-stone-600 transition-colors hover:border-emerald-400 hover:text-emerald-700 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-400 dark:hover:border-emerald-700"
                    >
                      {ex.id} · {ex.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </TabsContent>

          <TabsContent value="sequence" className="mt-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="sequence-input" className="text-sm">
                氨基酸序列（支持 FASTA 或裸序列粘贴）
              </Label>
              <Textarea
                id="sequence-input"
                value={sequenceText}
                onChange={(e) => setSequenceText(e.target.value)}
                placeholder={'粘贴 FASTA 格式（以 > 开头的标题行）或直接粘贴氨基酸序列，例如：\n>EGFR kinase domain\nMVPKP…'}
                className="min-h-40 resize-y font-mono text-xs leading-relaxed md:min-h-48"
                spellCheck={false}
              />
              {seqInfo.count > 0 && (
                <p
                  className={cn(
                    'flex items-center gap-1 text-xs',
                    seqInfo.count >= MIN_SEQUENCE_LENGTH
                      ? 'text-emerald-700 dark:text-emerald-400'
                      : 'text-amber-600 dark:text-amber-400'
                  )}
                >
                  <CircleCheckBig className="size-3.5" />
                  已识别 {seqInfo.count.toLocaleString()} 个氨基酸残基
                  {seqInfo.hasFastaHeader && '（FASTA 格式，已忽略标题行）'}
                  {seqInfo.count < MIN_SEQUENCE_LENGTH && `，建议不少于 ${MIN_SEQUENCE_LENGTH} 个残基`}
                </p>
              )}
            </div>
          </TabsContent>

          <TabsContent value="docx" className="mt-3">
            <DocxUploadPanel
              upload={upload}
              uploading={uploading}
              uploadError={uploadError}
              selectionReady={docxReady}
              selectedUniprot={selectedUniprot}
              selectedSequenceIndex={selectedSequenceIndex}
              onFileSelected={handleFileSelected}
              onClearUpload={clearUpload}
              onSelectUniprot={setSelectedUniprot}
              onSelectSequence={setSelectedSequenceIndex}
            />
          </TabsContent>
        </Tabs>

        {/* 客户目标 */}
        <div className="rounded-xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Target className="size-4 text-amber-600" />
            <Label htmlFor="goal-input" className="text-sm font-semibold">
              客户目标 / 科学问题
            </Label>
            <Badge
              variant="outline"
              className="border-amber-300 bg-amber-50 text-[10px] text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-400"
            >
              强烈推荐填写
            </Badge>
          </div>
          <Textarea
            id="goal-input"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="例如：解析 EGFR 激酶域与抑制剂复合物的冷冻电镜结构，评估 CRO 可行性"
            className="min-h-20 resize-y"
          />
          <p className="mt-1.5 text-xs text-stone-500 dark:text-stone-500">
            明确的客户目标将直接用于 LLM 报告中的可行性结论与实验策略推荐（可选）
          </p>
        </div>

        {/* 高级选项 */}
        <Collapsible open={advOpen} onOpenChange={setAdvOpen}>
          <div className="rounded-xl border border-stone-200 dark:border-stone-800">
            <CollapsibleTrigger className="flex min-h-11 w-full items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium text-stone-700 outline-none transition-colors hover:bg-stone-50 dark:text-stone-300 dark:hover:bg-stone-900/60">
              <Settings2 className="size-4 text-emerald-700 dark:text-emerald-500" />
              高级选项
              <span className="ml-auto text-xs font-normal text-stone-400">
                BLAST {blastEnabled ? (forceBlast ? '强制' : '自动') : '关闭'} · PDB ≤ {maxPdb}
              </span>
              <ChevronDown
                className={cn(
                  'size-4 text-stone-400 transition-transform duration-200',
                  advOpen && 'rotate-180'
                )}
              />
            </CollapsibleTrigger>
            <CollapsibleContent className="data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-1">
              <div className="grid gap-4 rounded-b-xl border-t border-stone-100 px-4 py-4 dark:border-stone-800 sm:grid-cols-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-stone-800 dark:text-stone-200">
                      自动 BLAST 同源检索
                    </div>
                    <div className="mt-0.5 text-xs leading-relaxed text-stone-500 dark:text-stone-500">
                      结构覆盖不足时自动执行 NCBI BLAST 检索同源结构
                    </div>
                  </div>
                  <Switch
                    checked={blastEnabled}
                    onCheckedChange={setBlastEnabled}
                    aria-label="自动 BLAST 同源检索"
                    className="data-[state=checked]:bg-emerald-600"
                  />
                </div>

                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-stone-800 dark:text-stone-200">
                      强制 BLAST
                    </div>
                    <div className="mt-0.5 text-xs leading-relaxed text-stone-500 dark:text-stone-500">
                      无论覆盖情况如何，始终执行同源结构检索
                    </div>
                  </div>
                  <Switch
                    checked={forceBlast && blastEnabled}
                    disabled={!blastEnabled}
                    onCheckedChange={setForceBlast}
                    aria-label="强制 BLAST"
                    className="data-[state=checked]:bg-emerald-600"
                  />
                </div>

                <div className="sm:col-span-2">
                  <div className="text-sm font-medium text-stone-800 dark:text-stone-200">
                    PDB 结构详情数量上限
                  </div>
                  <div className="mt-0.5 text-xs text-stone-500 dark:text-stone-500">
                    限制逐条拉取的 RCSB 结构详情数量，越大耗时越长
                  </div>
                  <Select value={String(maxPdb)} onValueChange={(v) => setMaxPdb(Number(v))}>
                    <SelectTrigger className="mt-2 h-10 w-full sm:w-44" aria-label="PDB 详情数上限">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[50, 100, 150, 300].map((n) => (
                        <SelectItem key={n} value={String(n)}>
                          {n} 条
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CollapsibleContent>
          </div>
        </Collapsible>

        {/* 提交错误提示 */}
        {submitError && (
          <Alert variant="destructive" className="border-red-300 dark:border-red-900">
            <CircleAlert />
            <AlertTitle>无法开始评估</AlertTitle>
            <AlertDescription>
              {submitError}
              <span className="text-xs text-stone-500">（评估服务可能尚未就绪，请稍后重试）</span>
            </AlertDescription>
          </Alert>
        )}

        {/* 开始评估 */}
        <div className="flex flex-col gap-2">
          <Button
            size="lg"
            disabled={!inputReady || submitting}
            onClick={handleStart}
            className="h-12 w-full bg-emerald-600 text-base font-semibold text-white shadow-sm hover:bg-emerald-700 dark:bg-emerald-600 dark:text-white dark:hover:bg-emerald-500"
          >
            {submitting ? (
              <LoaderCircle className="size-5 animate-spin" />
            ) : (
              <Dna className="size-5" />
            )}
            {submitting ? '正在创建评估作业…' : '开始评估'}
          </Button>
          <p className="text-center text-xs text-stone-400 dark:text-stone-500">
            将自动聚合 UniProt · RCSB PDB · PDBe · PubMed 数据，并由 LLM 生成结构解析可行性报告
          </p>
        </div>
      </CardContent>
    </Card>
  )
}
