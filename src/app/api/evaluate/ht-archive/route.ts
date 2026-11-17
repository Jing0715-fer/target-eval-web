/**
 * GET /api/evaluate/ht-archive?jobIds=a,b&mergedIds=c,d — 高通量评估批量下载（v2.25）。
 *
 * 把一次高通量运行产出的全部报告（每靶点独立报告 + 各组合并报告）打包为单个 zip：
 *  - 每组一个子文件夹（G01_xxx/），组内靶点报告 + 合并报告归入；
 *  - 无组信息的单报告平铺在根目录（兼容非 HT 场景的批量下载）；
 *  - 附 _README.txt（运行摘要 + 文件清单）。
 * 公网加固：仅创建者本人可下载（ownerKey 归属校验，与 jobs/[id]/report 同口径）。
 * zip 用 jszip（纯内存；单报告 HTML 截断 2MB，份数上限 600 对齐高通量上限）。
 */
import { NextResponse } from 'next/server'
import * as fs from 'node:fs/promises'
import JSZip from 'jszip'
import { db } from '@/lib/db'
import { getOwner, isOwnedBy } from '@/lib/eval/request-guard'
import { applyResponsiveOverride, applyZoomUpgrade, applyUxUpgrade } from '@/lib/eval/report-html'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

/** 入参条目：报告引用（job = 单靶点独立报告；merged = 组合并报告）+ 所属组序号与标签 */
interface ArchiveEntryInput {
  jobId?: string
  mergedId?: string
  /** 1-based 组序号（无组信息时省略 → 根目录平铺） */
  group?: number
  /** 组内展示名（文件名组成部分） */
  label?: string
}

/** 单条 HTML 上限（防超大报告撑爆内存；正常报告 ≤1MB） */
const MAX_HTML_BYTES = 2 * 1024 * 1024
/** 打包报告份数上限（对齐高通量 MAX_HT_TARGETS_TOTAL） */
const MAX_ENTRIES = 600

/** 文件名安全化：非法字符 → 空格折叠；限长；空值兜底 */
function safeName(s: string, max = 60): string {
  return (s || '')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\s]+$/, '')
    .slice(0, max) || 'report'
}

export async function GET(req: Request) {
  const owner = getOwner(req)
  const url = new URL(req.url)

  // ── 参数解析：entries JSON（组结构化）优先；否则 jobIds/mergedIds 逗号串 + groups/labels 下标对齐 ──
  let entries: ArchiveEntryInput[] = []
  const json = url.searchParams.get('entries')
  if (json) {
    try {
      const parsed = JSON.parse(json) as ArchiveEntryInput[]
      if (Array.isArray(parsed)) entries = parsed.filter(x => x && (x.jobId || x.mergedId)).slice(0, MAX_ENTRIES)
    } catch { /* 解析失败 → 空列表 → 422 */ }
  } else {
    const jobIds = (url.searchParams.get('jobIds') ?? '').split(',').map(s => s.trim()).filter(Boolean)
    const mergedIds = (url.searchParams.get('mergedIds') ?? '').split(',').map(s => s.trim()).filter(Boolean)
    const groups = (url.searchParams.get('groups') ?? '').split(',').map(s => Number(s.trim()))
    const labels = (url.searchParams.get('labels') ?? '').split(',')
    entries = [
      ...jobIds.map((jobId, i) => ({
        jobId,
        group: Number.isFinite(groups[i]) && groups[i] > 0 ? groups[i] : undefined,
        label: labels[i]?.trim() || undefined,
      })),
      ...mergedIds.map(mergedId => ({ mergedId })),
    ].slice(0, MAX_ENTRIES)
  }
  if (entries.length === 0) {
    return NextResponse.json({ ok: false, error: '未提供要下载的报告（jobIds/mergedIds 为空）' }, { status: 422 })
  }

  // ── 逐条取报告 HTML（归属校验 + 复用既有升级管线）──
  interface Loaded { entry: ArchiveEntryInput; html: string; kind: 'job' | 'merged'; title: string }
  const loaded: Loaded[] = []
  const missing: string[] = []
  for (const entry of entries) {
    if (entry.jobId) {
      const job = await db.evaluationJob.findUnique({
        where: { id: entry.jobId },
        select: { reportPath: true, status: true, uniprotId: true, title: true, ownerKey: true, ownerMask: true },
      })
      if (!job || !isOwnedBy(job, owner) || !job.reportPath || job.status !== 'done') {
        missing.push(entry.label ?? entry.jobId)
        continue
      }
      try {
        let html = await fs.readFile(job.reportPath, 'utf-8')
        if (html.length > MAX_HTML_BYTES) html = html.slice(0, MAX_HTML_BYTES)
        html = applyUxUpgrade(applyZoomUpgrade(applyResponsiveOverride(html)))
        loaded.push({ entry, html, kind: 'job', title: safeName(entry.label || job.uniprotId || job.title || entry.jobId) })
      } catch {
        missing.push(entry.label ?? entry.jobId)
      }
    } else if (entry.mergedId) {
      const record = await db.batchReport.findUnique({ where: { id: entry.mergedId } })
      if (!record || (record.ownerKey && record.ownerKey !== owner.key && record.ownerKey !== owner.ipKey) || !record.htmlPath) {
        missing.push(entry.mergedId)
        continue
      }
      try {
        let html = await fs.readFile(record.htmlPath, 'utf-8')
        if (html.length > MAX_HTML_BYTES) html = html.slice(0, MAX_HTML_BYTES)
        html = applyUxUpgrade(applyZoomUpgrade(applyResponsiveOverride(html)))
        loaded.push({ entry, html, kind: 'merged', title: safeName(record.title || `merged-${record.id.slice(0, 8)}`, 80) })
      } catch {
        missing.push(entry.mergedId)
      }
    }
  }
  if (loaded.length === 0) {
    return NextResponse.json({ ok: false, error: '没有可下载的报告（均未生成、已清理或无权访问）' }, { status: 404 })
  }

  // ── 组文件夹归档（G01_/G02_…；无组号平铺根目录；文件名去重）──
  const zip = new JSZip()
  const usedNames = new Set<string>()
  const dedupe = (name: string): string => {
    if (!usedNames.has(name)) { usedNames.add(name); return name }
    const dot = name.lastIndexOf('.')
    const stem = dot > 0 ? name.slice(0, dot) : name
    const ext = dot > 0 ? name.slice(dot) : ''
    for (let i = 2; i < 100; i++) {
      const cand = `${stem}_${i}${ext}`
      if (!usedNames.has(cand)) { usedNames.add(cand); return cand }
    }
    return `${stem}_${Date.now()}${ext}`
  }

  // 按组聚合（组内：合并报告 → 各靶点报告；组键空串 = 根目录）
  const byGroup = new Map<string, Loaded[]>()
  for (const item of loaded) {
    const key = item.entry.group != null ? `G${String(item.entry.group).padStart(2, '0')}` : ''
    if (!byGroup.has(key)) byGroup.set(key, [])
    byGroup.get(key)!.push(item)
  }
  const fileLines: string[] = []
  for (const [key, items] of [...byGroup.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const dir = key ? `${key}/` : ''
    for (const item of items.filter(x => x.kind === 'merged')) {
      const fname = dedupe(`${dir}${item.title}.html`)
      zip.file(fname, item.html)
      fileLines.push(fname)
    }
    for (const item of items.filter(x => x.kind === 'job')) {
      const fname = dedupe(`${dir}${item.title}.html`)
      zip.file(fname, item.html)
      fileLines.push(fname)
    }
  }

  // README（运行摘要 + 清单 + 缺失说明）
  const readme = [
    'TargetEval 高通量评估报告归档',
    `生成时间：${new Date().toISOString()}`,
    `报告份数：${loaded.length}（HTML 均为自包含单文件）`,
    `分组目录：${[...byGroup.keys()].filter(Boolean).length} 组`,
    ...(missing.length ? ['', '以下报告未包含（未生成 / 已清理 / 无权访问）：', ...missing.map(m => `  - ${m}`)] : []),
    '',
    '文件清单：',
    ...fileLines.map(f => `  ${f}`),
  ].join('\n')
  zip.file('_README.txt', readme)

  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } })
  const zipName = `TargetEval_HT_${new Date().toISOString().slice(0, 10)}_${loaded.length}reports.zip`
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${zipName}"`,
      'Cache-Control': 'no-store',
    },
  })
}
