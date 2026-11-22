'use client'

/**
 * 配体 2D 化学结构式缩略图 + 点击放大预览（v2.7.5）：
 *  - 缩略图 128px（与实验图画廊同交互口径），悬停显示放大镜角标，触屏常显
 *  - Dialog 放大预览（与 asset-gallery 同模式），展示 PubChem 原始分辨率
 *  - 结构图源为服务端内嵌 data URI（PubChem PNG，v2.7.5 起取图 600×600）
 */
import { useState } from 'react'
import { FlaskConical, ZoomIn } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

export function Ligand2dFigure({ src, cid, name }: { src: string; cid?: number; name: string }) {
  const [open, setOpen] = useState(false)
  /** 原始图像素（PubChem 取图尺寸；加载后读取 naturalWidth/Height） */
  const [dim, setDim] = useState('')

  return (
    <figure className="relative flex-none self-start text-center">
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="点击放大查看 2D 结构式"
        aria-label={`放大查看 ${name} 的 2D 结构式`}
        className="group relative block cursor-zoom-in rounded-md focus-visible:ring-[3px] focus-visible:ring-ring/30 focus-visible:outline-none"
      >
        <img
          src={src}
          alt="2D 化学结构式"
          className="h-32 w-32 rounded-md border border-border bg-white object-contain p-1 transition-[box-shadow,border-color] group-hover:border-ring/50 group-hover:shadow-sm"
        />
        <span className="pointer-events-none absolute top-1.5 right-1.5 flex items-center gap-0.5 rounded-sm border border-border/70 bg-card/90 px-1 py-px font-mono text-[9px] font-semibold text-muted-foreground opacity-0 backdrop-blur-sm transition-opacity duration-200 group-hover:opacity-100 pointer-coarse:opacity-100">
          <ZoomIn className="size-2.5" aria-hidden />
          放大
        </span>
      </button>
      <figcaption className="mt-1 font-mono text-[9px] text-muted-foreground/80">
        2D 结构式 · PubChem{cid ? ` · CID ${cid}` : ''}
      </figcaption>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base font-semibold tracking-[-0.01em]">
              <FlaskConical className="size-4 text-primary" />
              {name}
              {cid && <span className="font-mono text-xs font-normal text-muted-foreground/85">CID {cid}</span>}
            </DialogTitle>
            <DialogDescription className="sr-only">配体 2D 化学结构式放大预览</DialogDescription>
          </DialogHeader>
          <img
            src={src}
            alt={`${name} 2D 化学结构式`}
            onLoad={(e) => {
              const el = e.currentTarget
              if (el.naturalWidth > 1) setDim(`${el.naturalWidth} × ${el.naturalHeight} px`)
            }}
            className="mx-auto max-h-[68vh] w-auto max-w-full rounded-xl border border-border bg-white object-contain p-2"
          />
          <p className="text-center font-mono text-[10px] tracking-wide text-muted-foreground/85">
            2D 结构式 · PubChem{cid ? ` · CID ${cid}` : ''}{dim ? ` · 原始分辨率 ${dim}` : ''}
          </p>
        </DialogContent>
      </Dialog>
    </figure>
  )
}
