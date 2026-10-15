'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import { Images, ScanEye } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { KindBadge } from './badges'
import type { AssetItem } from './types'

const KIND_SECTION_TITLE: Record<string, string> = {
  gel: 'SDS-PAGE 胶图',
  sec: 'SEC 分子筛',
  other: '其他实验图',
}

/** 按类型分组顺序（gel → sec → other） */
const KIND_ORDER: Array<AssetItem['kind']> = ['gel', 'sec', 'other']

/** 胶图 / SEC 实验数据画廊：按类型分组 + 缩略图网格 + 点击放大 */
export function AssetGallery({ assets }: { assets: AssetItem[] }) {
  const [active, setActive] = useState<AssetItem | null>(null)

  const groups = KIND_ORDER
    .map(kind => ({ kind, items: assets.filter(a => a.kind === kind) }))
    .filter(g => g.items.length > 0)
  const vlmCount = assets.filter(a => a.vlmKind).length
  // 入场动画延迟：按原图全局序号（渲染前预计算，避免 render 期间重新赋值）
  const orderMap = new Map(assets.map((a, i) => [a.id, i] as const))

  return (
    <>
      <div className="flex flex-col gap-5">
        {vlmCount > 0 && (
          <p className="flex items-center gap-1.5 text-xs text-stone-500 dark:text-stone-400">
            <ScanEye className="size-3.5 text-emerald-700 dark:text-emerald-500" aria-hidden />
            图片类型与读数经 AI 视觉识别（{vlmCount}/{assets.length} 张）
          </p>
        )}
        {groups.map(g => (
          <div key={g.kind} className="flex flex-col gap-2.5">
            <div className="flex items-baseline gap-2">
              <h4 className="font-display text-sm font-bold text-stone-800 dark:text-stone-200">
                {KIND_SECTION_TITLE[g.kind] ?? '实验图'}
              </h4>
              <span className="eval-eyebrow text-stone-400 dark:text-stone-500">
                {g.items.length} 张
              </span>
              <KindBadge kind={g.kind} className="translate-y-px" />
            </div>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {g.items.map((a) => {
                const delay = Math.min((orderMap.get(a.id) ?? 0) * 0.05, 0.4)
                return (
                  <motion.button
                    key={a.id}
                    type="button"
                    initial={{ opacity: 0, scale: 0.96 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ duration: 0.25, delay, ease: 'easeOut' }}
                    onClick={() => setActive(a)}
                    className="group overflow-hidden rounded-md border border-stone-200 bg-white text-left shadow-none transition-colors hover:border-emerald-300 focus-visible:ring-[3px] focus-visible:ring-emerald-500/40 focus-visible:outline-none dark:border-stone-800 dark:bg-stone-900 dark:hover:border-emerald-700"
                  >
                    <div className="relative h-36 w-full overflow-hidden bg-stone-100 dark:bg-stone-800">
                      <img
                        src={`/api/assets/${a.id}`}
                        alt={a.caption || KIND_SECTION_TITLE[a.kind] || '实验图片'}
                        loading="lazy"
                        className="size-full object-contain transition-transform duration-300 group-hover:scale-105"
                      />
                      {a.vlmKind && (
                        <span
                          className="absolute top-2 right-2 flex items-center gap-0.5 rounded-sm border border-emerald-300/80 bg-white/90 px-1 py-px font-mono text-[9px] font-semibold text-emerald-800 backdrop-blur-sm dark:border-emerald-800 dark:bg-stone-900/90 dark:text-emerald-400"
                          title="类型由 AI 视觉识别判定"
                        >
                          <ScanEye className="size-2.5" aria-hidden />
                          AI
                        </span>
                      )}
                    </div>
                    <div className="px-3 py-2">
                      <p
                        className="line-clamp-2 text-xs leading-snug text-stone-600 dark:text-stone-400"
                        title={a.caption}
                      >
                        {a.caption?.trim() || '（未提供说明）'}
                      </p>
                    </div>
                  </motion.button>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      {/* 放大预览 */}
      <Dialog open={active != null} onOpenChange={(open) => !open && setActive(null)}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 font-display text-base">
              <Images className="size-4 text-emerald-700 dark:text-emerald-500" />
              {active ? KIND_SECTION_TITLE[active.kind] || '实验数据图' : ''}
            </DialogTitle>
            <DialogDescription className="sr-only">实验图片放大预览</DialogDescription>
          </DialogHeader>
          {active && (
            <>
              <img
                src={`/api/assets/${active.id}`}
                alt={active.caption || '实验图片'}
                className="max-h-[65vh] w-full rounded-lg border border-stone-200 bg-stone-50 object-contain dark:border-stone-800 dark:bg-stone-950"
              />
              <div className="flex items-center gap-2">
                <KindBadge kind={active.kind} />
                {active.vlmKind && (
                  <span className="flex items-center gap-1 rounded-sm border border-emerald-300/80 bg-emerald-50 px-1.5 py-px font-mono text-[10px] font-semibold text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-400">
                    <ScanEye className="size-2.5" aria-hidden />
                    AI 视觉识别
                  </span>
                )}
                <p className="min-w-0 flex-1 text-sm text-stone-600 dark:text-stone-400">
                  {active.caption?.trim() || '（未提供说明）'}
                </p>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
