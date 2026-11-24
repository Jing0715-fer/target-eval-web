/**
 * v2.71 内存压测：模拟百级靶点全量内嵌（117 × ~1.5MB 报告原文 ≈ 175MB），
 * 对比旧链路（renderHtDashboardHtml 整串渲染 — rows 持全部原文 + payload 深拷贝）
 * 与新链路（writeHtDashboardHtmlFile 流式写盘 — rows 只带路径，逐份延迟读取）
 * 的堆内存峰值与耗时。验证 OOM 修复效果。
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  renderHtDashboardHtml,
  writeHtDashboardHtmlFile,
  computeHtStats,
  type HtDashboardRow,
  type HtVerdict,
} from '../src/lib/eval/ht-dashboard'

const N = 117
const KB_PER_REPORT = 1536 // ~1.5MB

function bigHtml(tag: string, sizeKb: number): string {
  const pad = `<div class="pad">x</div>`.repeat(Math.round(sizeKb * 1024 / 17))
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${tag}</title></head><body><h1>${tag}</h1>${pad}</body></html>`
}

function heapMb(): number {
  globalThis.gc?.()
  return Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
}

function baseRow(over: Partial<HtDashboardRow>): HtDashboardRow {
  return {
    jobId: 'j', label: 'T', proteinName: 'P', organism: 'E', overall: 6, xray: 5, cryoem: 3, nmr: 2,
    directPdbCount: 4, blastHitCount: 12, coverage: 78, methodXrayCount: 3, methodCryoemCount: 1,
    methodNmrCount: 0, bestResolution: 2.1, ligandCount: 2, literatureCount: 5, reportLlmOk: true,
    durationMs: 1000, hasReport: true, ...over,
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2] === '--old' ? 'old' : process.argv[2] === '--new' ? 'new' : 'both'
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'htdash-mem-'))
  const files: string[] = []
  for (let i = 0; i < N; i++) {
    const f = path.join(tmp, `r${i}.html`)
    fs.writeFileSync(f, bigHtml(`报告 ${i}`, KB_PER_REPORT), 'utf-8')
    files.push(f)
  }
  const totalMb = Math.round(fs.statSync(files[0]!).size * N / 1024 / 1024)
  console.log(`场景：${N} 份报告 × ${(KB_PER_REPORT / 1024).toFixed(1)}MB ≈ ${totalMb}MB 原文（用户实测规模）`)

  const rows: HtDashboardRow[] = files.map((f, i) => baseRow({
    jobId: `job-${String(i).padStart(24, '0')}`,
    label: `靶点${i}`,
    overall: (i % 10) + 1,
    reportHtmlPath: f,
  }))
  const verdicts: HtVerdict[] = rows.map(r => ({ jobId: r.jobId, verdict: 'go' as const, line: 'ok', source: 'rule' as const }))
  const stats = computeHtStats(rows, N, 0)
  const baseInput = {
    title: `高通量评估汇总报告 · ${N} 靶点（v2.71 内存压测）`,
    rows, stats, verdicts,
    markdown: '## 执行摘要\n压测。',
    llmOk: true, llmErrors: [], engineSummary: '压测引擎', origin: 'https://x.example.com',
    generatedAt: '2026-02-01 10:00:00',
  } as Parameters<typeof renderHtDashboardHtml>[0]

  if (mode === 'old' || mode === 'both') {
    // ── 链路 A（旧 v2.70）：全部原文读入内存 → 整串渲染 → 一次性写盘 ──
    const memRows = rows.map(r => ({ ...r, reportHtml: fs.readFileSync(r.reportHtmlPath!, 'utf-8') }))
    const oldInput = { ...baseInput, rows: memRows }
    const baseA = heapMb()
    const tA = Date.now()
    const wholeHtml = renderHtDashboardHtml(oldInput)
    const wholePath = path.join(tmp, 'whole.html')
    fs.writeFileSync(wholePath, wholeHtml, 'utf-8')
    const peakA = heapMb()
    console.log(`旧链路（整串渲染）：产物 ${(fs.statSync(wholePath).size / 1024 / 1024).toFixed(1)}MB · 堆峰值 ${peakA}MB（基线 ${baseA}MB，增量 ${peakA - baseA}MB）· ${Date.now() - tA}ms`)
    if (mode === 'old') {
      fs.rmSync(tmp, { recursive: true, force: true })
      return
    }
  }

  if (mode === 'new' || mode === 'both') {
    // ── 链路 B（新 v2.71）：rows 只带路径 → 流式写盘（逐份延迟读取）──
    const baseB = heapMb()
    const tB = Date.now()
    const streamPath = path.join(tmp, 'stream.html')
    await writeHtDashboardHtmlFile(baseInput, streamPath, () => undefined)
    const peakB = heapMb()
    console.log(`新链路（流式写盘）：产物 ${(fs.statSync(streamPath).size / 1024 / 1024).toFixed(1)}MB · 堆峰值 ${peakB}MB（基线 ${baseB}MB，增量 ${peakB - baseB}MB）· ${Date.now() - tB}ms`)
  }

  // 产物对比（both 模式）：轻量（不 JSON.parse 两份 372MB 载荷 — 那会把压测进程
  //  自己 OOM；逐行字节一致性由 test-ht-stream-write.ts 的 16 项断言覆盖）
  if (mode === 'both') {
    const wholePath = path.join(tmp, 'whole.html')
    const streamPath = path.join(tmp, 'stream.html')
    const wholeSize = fs.statSync(wholePath).size
    const streamSize = fs.statSync(streamPath).size
    // 差值 = 新链路保守内嵌的重建页样式 c（几十 KB 内）— 设计内差异
    const delta = Math.abs(streamSize - wholeSize)
    const ok = delta < 200_000
    console.log(`产物大小：旧 ${wholeSize} / 新 ${streamSize}（差 ${delta}B = 保守内嵌的重建页样式 c）— ${ok ? '✓' : '✗ 超出预期'}`)
    fs.rmSync(tmp, { recursive: true, force: true })
    if (!ok) process.exit(1)
    return
  }
  fs.rmSync(tmp, { recursive: true, force: true })
}

// --expose-gc 下运行：bun run scripts/test-ht-memory.ts --smol 之类不需要；
// bun 默认支持 globalThis.gc? 需 --expose-gc — 无 gc 时 heapMb 读数偏高但仍可比
void main().catch(e => { console.error(e); process.exit(1) })
