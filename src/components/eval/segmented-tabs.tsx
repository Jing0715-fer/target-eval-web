'use client'

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ElementType,
} from 'react'
import { TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

/**
 * 滑动胶囊分段控件（v2.86 — 移植自参考项目 pdb-tracker-web-v5 的
 * mode-segmented-control：rounded-full 胶囊容器 + 白色指示 pill 随选中项滑动）。
 *
 * 纯展示组件：在 Radix Tabs 上下文内渲染 TabsTrigger，选中态由
 * data-state="active" 驱动；pill 位置经 DOM 测量（offsetLeft/offsetWidth）
 * 计算，不介入任何业务状态。
 */
export function SlidingTabsList({
  items,
  className,
  triggerClassName,
}: {
  /** 分段项：value 必须与外层 Tabs 的 value 对应 */
  items: ReadonlyArray<{ value: string; label: string; icon?: ElementType }>
  className?: string
  triggerClassName?: string
}) {
  const listRef = useRef<HTMLDivElement>(null)
  const [pill, setPill] = useState({ left: 0, width: 0, ready: false })

  /** 测量当前选中 trigger 的位置（Radix 自动打 data-state="active"） */
  const measure = useCallback(() => {
    const list = listRef.current
    if (!list) return
    const active = list.querySelector<HTMLElement>('[data-state="active"]')
    if (active) {
      setPill({ left: active.offsetLeft, width: active.offsetWidth, ready: true })
    }
  }, [])

  useLayoutEffect(measure, [measure])

  // 容器尺寸变化（换行 / 视口缩放 / 字体加载）时重测
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const ro = new ResizeObserver(measure)
    ro.observe(list)
    window.addEventListener('resize', measure)
    // v2.91 修复：切换标签时 pill 不跟随。根因：Radix 切换只改 trigger 的
    //  data-state 属性 — 本组件不消费 Tabs 上下文不会 re-render，容器尺寸也
    //  不变 → measure 再无触发时机，pill 停在初始位置（用户实测「输入方式的
    //  标签切换的 UI 有问题」）。MutationObserver 监听 data-state 变化重测：
    //  attributeFilter 限定 data-state（pill 自身 style 内联属性更新不会回环
    //  触发）；回调在微任务队列中先于浏览器绘制执行 — 切换无闪烁。
    const mo = new MutationObserver(measure)
    mo.observe(list, { subtree: true, attributes: true, attributeFilter: ['data-state'] })
    return () => {
      ro.disconnect()
      mo.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [measure])

  return (
    <TabsList
      ref={listRef}
      className={cn(
        'mode-segmented-control relative h-9 w-full justify-between gap-0 rounded-full p-[3px] sm:w-auto sm:justify-start',
        className,
      )}
    >
      {/* 滑动指示 pill：绝对定位 + CSS 过渡 — 切换时从旧位置滑到新位置 */}
      <span
        aria-hidden
        className="mode-segmented-pill absolute top-[3px] h-[calc(100%-6px)] rounded-full transition-[left,width,opacity] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]"
        style={{
          left: pill.left,
          width: pill.width,
          opacity: pill.ready ? 1 : 0,
        }}
      />
      {items.map(({ value, label, icon: Icon }) => (
        <TabsTrigger
          key={value}
          value={value}
          className={cn(
            'mode-segmented-tab relative z-10 h-7 flex-1 gap-1.5 rounded-full px-2.5 text-[12px] font-medium text-muted-foreground shadow-none transition-colors duration-200 data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none sm:flex-none sm:px-3.5 [&_svg]:size-3.5',
            triggerClassName,
          )}
        >
          {Icon ? <Icon aria-hidden /> : null}
          {label}
        </TabsTrigger>
      ))}
    </TabsList>
  )
}
