/**
 * HT zip 归档文件名规划（v2.28）— ht-archive 打包路由与 ht-dashboard 看板共享。
 *
 * 看板为「离线 HTML + 链接到所有单独报告」生成每靶点 zip 相对链接；链接要能对上，
 * 命名必须与 ht-archive 打包时完全一致：同 safeName 规则、同目录（G{NN}/）、
 * 同去重序、同「组内合并报告在前各靶点在后」。两端从 DB 取同名来源
 * （job: label/uniprotId/title/jobId；merged: title/merged-短id），规划器输入
 * 已解析标题，输出逐条 zip 内相对路径。
 */

export interface ArchivePlanItem {
  kind: 'job' | 'merged'
  /** 1-based 组序号（缺省 = 根目录平铺） */
  group?: number
  /** 已解析的展示名（job: label/uniprotId/title/jobId；merged: title） */
  title: string
}

/** 文件名安全化（与 ht-archive 旧实现一致 — 非法字符折叠为空格；限长；空值兜底） */
export function safeArchiveName(s: string, max = 60): string {
  return (s || '')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\s]+$/, '')
    .slice(0, max) || 'report'
}

/**
 * 规划 zip 内相对路径（与旧 ht-archive 打包行为逐位一致）：
 *  - 组内顺序：merged 报告在前、各靶点报告在后（沿用 v2.25 口径）
 *  - 组间按组号排序；无组号条目平铺根目录
 *  - 全局去重（同名追加 _2/_3…）
 * 返回与输入同序（按输入出现序，不重排）的路径数组 — 调用方按下标取用。
 */
export function planArchiveNames(items: ArchivePlanItem[]): string[] {
  const used = new Set<string>()
  const dedupe = (name: string): string => {
    if (!used.has(name)) { used.add(name); return name }
    const dot = name.lastIndexOf('.')
    const stem = dot > 0 ? name.slice(0, dot) : name
    const ext = dot > 0 ? name.slice(dot) : ''
    for (let i = 2; i < 100; i++) {
      const cand = `${stem}_${i}${ext}`
      if (!used.has(cand)) { used.add(cand); return cand }
    }
    return `${stem}_${Date.now()}${ext}`
  }

  // 分桶（组键 = G{NN} 或 ''）+ 组内 merged 在前
  const order: Array<{ key: string; idx: number }> = items.map((it, idx) => ({
    key: it.group != null ? `G${String(it.group).padStart(2, '0')}` : '',
    idx,
  }))
  const byGroup = new Map<string, number[]>()
  order.forEach(o => {
    if (!byGroup.has(o.key)) byGroup.set(o.key, [])
    byGroup.get(o.key)!.push(o.idx)
  })
  for (const arr of byGroup.values()) {
    arr.sort((a, b) => (items[a].kind === 'merged' ? -1 : 0) - (items[b].kind === 'merged' ? -1 : 0) || a - b)
  }

  const names: string[] = new Array(items.length)
  for (const key of [...byGroup.keys()].sort((a, b) => a.localeCompare(b))) {
    const dir = key ? `${key}/` : ''
    for (const idx of byGroup.get(key)!) {
      names[idx] = dedupe(`${dir}${safeArchiveName(items[idx].title, items[idx].kind === 'merged' ? 80 : 60)}.html`)
    }
  }
  return names
}

/** 看板在 zip 内的根级文件名（ht-archive 的 dashboardId 条目使用 — 首位排序） */
export const HT_DASHBOARD_ZIP_NAME = '00_统计看板_整体可行性.html'
