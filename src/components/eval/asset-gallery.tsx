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
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ScanEye className="size-3.5 text-primary" aria-hidden />
            图片类型与读数经 AI 视觉识别（{vlmCount}/{assets.length} 张）
          </p>
        )}
        {groups.map(g => (
          <div key={g.kind} className="flex flex-col gap-2.5">
            <div className="flex items-baseline gap-2">
              <h4 className="text-sm font-semibold tracking-[-0.01em] text-foreground">
                {KIND_SECTION_TITLE[g.kind] ?? '实验图'}
              </h4>
              <span className="eval-eyebrow text-muted-foreground/70">
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
                    className="group overflow-hidden rounded-lg border border-border bg-card text-left shadow-none transition-colors hover:border-ring/60 focus-visible:ring-[3px] focus-visible:ring-ring/30 focus-visible:outline-none"
                  >
                    <div className="relative h-36 w-full overflow-hidden bg-muted">
                      <img
                        src={`/api/assets/${a.id}`}
                        alt={a.caption || KIND_SECTION_TITLE[a.kind] || '实验图片'}
                        loading="lazy"
                        className="size-full object-contain transition-transform duration-300 group-hover:scale-105"
                      />
                      {a.vlmKind && (
                        <span
                          className="absolute top-2 right-2 flex items-center gap-0.5 rounded-sm border border-primary/40 bg-card/90 px-1 py-px font-mono text-[9px] font-semibold text-primary backdrop-blur-sm"
                          title="类型由 AI 视觉识别判定"
                        >
                          <ScanEye className="size-2.5" aria-hidden />
                          AI
                        </span>
                      )}
                    </div>
                    <div className="px-3 py-2">
                      <p
                        className="line-clamp-2 text-xs leading-snug text-foreground/80"
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
            <DialogTitle className="flex items-center gap-2 text-base font-semibold tracking-[-0.01em]">
              <Images className="size-4 text-primary" />
              {active ? KIND_SECTION_TITLE[active.kind] || '实验数据图' : ''}
            </DialogTitle>
            <DialogDescription className="sr-only">实验图片放大预览</DialogDescription>
          </DialogHeader>
          {active && (
            <>
              <img
                src={`/api/assets/${active.id}`}
                alt={active.caption || '实验图片'}
                className="max-h-[65vh] w-full rounded-xl border border-border bg-muted object-contain"
              />
              <div className="flex items-center gap-2">
                <KindBadge kind={active.kind} />
                {active.vlmKind && (
                  <span className="flex items-center gap-1 rounded-sm border border-primary/40 bg-primary/[0.06] px-1.5 py-px font-mono text-[10px] font-semibold text-primary">
                    <ScanEye className="size-2.5" aria-hidden />
                    AI 视觉识别
                  </span>
                )}
                <p className="min-w-0 flex-1 text-sm text-foreground/80">
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
