'use client'

import { useRef, useState } from 'react'
import {
  CircleCheckBig,
  FileCheck2,
  FileUp,
  LoaderCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { KindBadge } from './badges'
import type { UploadResponse } from './types'

export interface DocxUploadPanelProps {
  upload: UploadResponse | null
  uploading: boolean
  uploadError: string | null
  selectionReady: boolean
  selectedUniprot: string | null
  selectedSequenceIndex: number | null
  onFileSelected: (file: File) => void
  onClearUpload: () => void
  onSelectUniprot: (id: string | null) => void
  onSelectSequence: (index: number | null) => void
}

const MAX_SIZE_BYTES = 20 * 1024 * 1024

/** Word 评估表上传与解析结果展示（拖拽/点击上传 → UniProt/序列点选 → 图片网格） */
export function DocxUploadPanel(props: DocxUploadPanelProps) {
  const {
    upload,
    uploading,
    uploadError,
    selectionReady,
    selectedUniprot,
    selectedSequenceIndex,
    onFileSelected,
    onClearUpload,
    onSelectUniprot,
    onSelectSequence,
  } = props
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFile = (file: File | undefined | null) => {
    if (!file) return
    // 扩展名/大小校验统一由父级 validateDocxFile 处理并提示
    onFileSelected(file)
  }

  if (!upload) {
    return (
      <div className="flex flex-col gap-2">
        <div
          role="button"
          tabIndex={0}
          aria-label="上传 Word 评估表"
          onClick={() => !uploading && inputRef.current?.click()}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === ' ') && !uploading) {
              e.preventDefault()
              inputRef.current?.click()
            }
          }}
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            handleFile(e.dataTransfer.files?.[0])
          }}
          className={cn(
            'flex min-h-40 cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed px-6 py-8 text-center outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-emerald-500/40',
            dragOver
              ? 'border-emerald-600 bg-emerald-50/70 dark:bg-emerald-950/40'
              : 'border-stone-300 bg-stone-50/60 hover:border-emerald-500 hover:bg-emerald-50/30 dark:border-stone-700 dark:bg-stone-900/40 dark:hover:border-emerald-600',
            uploading && 'pointer-events-none opacity-80'
          )}
        >
          {uploading ? (
            <LoaderCircle className="size-7 animate-spin text-emerald-700" />
          ) : (
            <FileUp className="size-7 text-stone-400 dark:text-stone-500" />
          )}
          <div className="text-sm font-medium text-stone-700 dark:text-stone-300">
            {uploading ? '正在上传并解析评估表…' : '拖拽 Word 评估表到此处，或点击选择文件'}
          </div>
          <div className="font-mono text-[11px] text-stone-400 dark:text-stone-500">
            支持 .docx 格式（≤ 20MB），上传后自动解析 UniProt ID、序列与实验图片
          </div>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".docx"
          className="hidden"
          onChange={(e) => {
            handleFile(e.target.files?.[0])
            e.target.value = ''
          }}
        />
        {uploadError && (
          <p className="text-xs text-red-600 dark:text-red-400">{uploadError}</p>
        )}
      </div>
    )
  }

  const { parsed } = upload
  return (
    <div className="flex flex-col gap-4 rounded-md border border-stone-200 bg-stone-50/50 p-4 dark:border-stone-800 dark:bg-stone-900/40">
      {/* 解析摘要 */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <CircleCheckBig className="size-4 shrink-0 text-emerald-700" />
        <span className="font-medium text-stone-800 dark:text-stone-200">评估表解析完成</span>
        <span className="text-xs text-stone-500 dark:text-stone-500">
          {parsed.uniprotIds.length} 个 UniProt · {parsed.sequences.length} 条序列 ·{' '}
          {parsed.images.length} 张图片
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-8 px-2.5 text-xs text-stone-500 hover:text-stone-800 dark:hover:text-stone-200"
          onClick={onClearUpload}
          disabled={uploading}
        >
          重新上传
        </Button>
      </div>

      {/* 基因名 */}
      {parsed.genes.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium text-stone-500 dark:text-stone-500">基因名：</span>
          {parsed.genes.map((g) => (
            <Badge key={g} variant="secondary" className="font-mono text-[11px]">
              {g}
            </Badge>
          ))}
        </div>
      )}

      {/* UniProt ID chips */}
      {parsed.uniprotIds.length > 0 && (
        <div>
          <div className="mb-2 text-xs font-medium text-stone-600 dark:text-stone-400">
            识别出的 UniProt ID（点选用于评估）
          </div>
          <div className="flex flex-wrap gap-2">
            {parsed.uniprotIds.map((id) => {
              const selected = selectedUniprot === id
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    if (selected) {
                      onSelectUniprot(null)
                    } else {
                      onSelectUniprot(id)
                      onSelectSequence(null)
                    }
                  }}
                  className={cn(
                    'min-h-10 rounded-md border px-3.5 font-mono text-sm transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-emerald-500/40',
                    selected
                      ? 'border-emerald-700 bg-emerald-800 font-semibold text-white'
                      : 'border-stone-300 bg-white text-stone-700 hover:border-emerald-500 hover:text-emerald-800 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300 dark:hover:border-emerald-600 dark:hover:text-emerald-400'
                  )}
                >
                  {id}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* 序列列表 */}
      {parsed.sequences.length > 0 && (
        <div>
          <div className="mb-2 text-xs font-medium text-stone-600 dark:text-stone-400">
            识别出的序列（点选用于评估）
          </div>
          <div className="flex flex-col gap-2">
            {parsed.sequences.map((s, i) => {
              const selected = selectedSequenceIndex === i
              return (
                <button
                  key={`${s.header}-${i}`}
                  type="button"
                  onClick={() => {
                    if (selected) {
                      onSelectSequence(null)
                    } else {
                      onSelectSequence(i)
                      onSelectUniprot(null)
                    }
                  }}
                  className={cn(
                    'rounded-md border p-3 text-left transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-emerald-500/40',
                    selected
                      ? 'border-emerald-700 bg-emerald-50 ring-1 ring-emerald-700 dark:border-emerald-600 dark:bg-emerald-950/40'
                      : 'border-stone-200 bg-white hover:border-emerald-400 dark:border-stone-800 dark:bg-stone-900 dark:hover:border-emerald-700'
                  )}
                >
                  <div className="flex items-baseline gap-2">
                    <span className="truncate text-xs font-medium text-stone-700 dark:text-stone-300">
                      {s.header?.trim() || `序列 ${i + 1}`}
                    </span>
                    <span className="ml-auto shrink-0 text-[11px] text-emerald-700 dark:text-emerald-500">
                      {s.length || s.seq?.length || 0} aa
                    </span>
                  </div>
                  {s.seq && (
                    <p
                      className="mt-1 truncate font-mono text-[11px] text-stone-400 dark:text-stone-500"
                      title={s.seq}
                    >
                      {s.seq}
                    </p>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* 图片缩略图网格 */}
      {parsed.images.length > 0 && (
        <div>
          <div className="mb-2 text-xs font-medium text-stone-600 dark:text-stone-400">
            提取的实验图片
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {parsed.images.map((img) => (
              <div
                key={img.id}
                className="overflow-hidden rounded-lg border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900"
              >
                <div className="relative h-28 bg-stone-100 dark:bg-stone-800">
                  <img
                    src={`/api/assets/${img.id}`}
                    alt={img.caption || '实验图片'}
                    loading="lazy"
                    className="size-full object-contain"
                  />
                  <KindBadge kind={img.kind} className="absolute top-1.5 left-1.5" />
                </div>
                <div className="flex items-center gap-1 px-2 py-1.5">
                  <FileCheck2 className="size-3 shrink-0 text-stone-400" />
                  <p
                    className="truncate text-[11px] text-stone-500 dark:text-stone-500"
                    title={img.caption || `${img.sizeKB} KB`}
                  >
                    {img.caption?.trim() || `${img.mime || '图片'} · ${img.sizeKB}KB`}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 选择状态提示 */}
      <p
        className={cn(
          'text-xs',
          selectionReady
            ? 'text-emerald-700 dark:text-emerald-400'
            : 'text-amber-600 dark:text-amber-400'
        )}
      >
        {selectionReady
          ? '已选择评估对象，可以开始评估'
          : '请从上方点选一个 UniProt ID 或序列作为评估对象'}
      </p>

      {uploadError && <p className="text-xs text-red-600 dark:text-red-400">{uploadError}</p>}
    </div>
  )
}

/** 客户端文件预校验（扩展名 / 大小） */
export function validateDocxFile(file: File): string | null {
  if (!file.name.toLowerCase().endsWith('.docx')) {
    return '仅支持 .docx 格式的 Word 文档'
  }
  if (file.size > MAX_SIZE_BYTES) {
    return '文件大小超过 20MB 上限'
  }
  return null
}
