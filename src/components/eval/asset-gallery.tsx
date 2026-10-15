'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import { Images } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { KindBadge } from './badges'
import type { AssetItem } from './types'

const KIND_SECTION_TITLE: Record<string, string> = {
  gel: 'SDS-PAGE 胶图',
  sec: 'SEC 分子筛',
}

/** 胶图 / SEC 实验数据画廊：缩略图网格 + 点击放大 */
export function AssetGallery({ assets }: { assets: AssetItem[] }) {
  const [active, setActive] = useState<AssetItem | null>(null)

  return (
    <>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {assets.map((a, i) => (
          <motion.button
            key={a.id}
            type="button"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.25, delay: Math.min(i * 0.05, 0.4), ease: 'easeOut' }}
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
              <KindBadge kind={a.kind} className="absolute top-2 left-2" />
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
                <p className="min-w-0 flex-1 truncate text-sm text-stone-600 dark:text-stone-400">
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
