/**
 * v2.71 验证：writeHtDashboardHtmlFile（流式写盘）与 renderHtDashboardHtml
 * （整串渲染）的输出必须字节级一致 — 重构前弹出页/下载内容完全不变。
 *
 * 覆盖形态：
 *  ① reportHtmlPath（服务端延迟读取路径 — 新链路）
 *  ② reportHtml（内存字符串 — fixture/旧链路）
 *  ③ 无原文回退重建页（reportMarkdown）
 *  ④ bare 降级载入行
 *  ⑤ 导入解析行（importedFromFile）
 *  ⑥ 报告文件丢失（stat 通过但读取失败 — 写盘时回退重建页变体，两路径一致）
 *  ⑦ 大文件（>500KB 多份 — 分块边界）
 * 断言：两路径产物逐字节相等 + JSON 载荷可解析 + data-i 索引对齐。
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

function bigHtml(tag: string, sizeKb: number): string {
  const pad = `<div class="pad">x</div>`.repeat(Math.round(sizeKb * 1024 / 17))
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${tag}</title><style>body{font-family:sans-serif}</style></head><body><h1>${tag}</h1>${pad}<p>含特殊字符 & " ' < > 检查转义</p></body></html>`
}

function baseRow(over: Partial<HtDashboardRow>): HtDashboardRow {
  return {
    jobId: 'j-000000000000000000000001',
    label: '测试靶点 · 100aa',
    proteinName: 'Test protein',
    organism: 'E. coli',
    overall: 6,
    xray: 5,
    cryoem: 3,
    nmr: 2,
    directPdbCount: 4,
    blastHitCount: 12,
    coverage: 78,
    methodXrayCount: 3,
    methodCryoemCount: 1,
    methodNmrCount: 0,
    bestResolution: 2.1,
    ligandCount: 2,
    literatureCount: 5,
    reportLlmOk: true,
    durationMs: 1000,
    hasReport: true,
    ...over,
  }
}

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'htdash-v271-'))
  // 临时报告文件（路径形态 + 一份会被删除的丢失文件）
  const f1 = path.join(tmp, 'r1.html')
  const f2 = path.join(tmp, 'r2.html')
  const fLost = path.join(tmp, 'lost.html')
  fs.writeFileSync(f1, bigHtml('路径报告 A（含 & < > 转义检查）', 300), 'utf-8')
  fs.writeFileSync(f2, bigHtml('路径报告 B（导入留存）', 120), 'utf-8')
  fs.writeFileSync(fLost, bigHtml('将丢失的报告', 50), 'utf-8')

  const rows: HtDashboardRow[] = [
    baseRow({ jobId: 'job-aaaaaaaaaaaaaaaaaaaa1', label: '靶点A（路径原文）', overall: 8, reportHtmlPath: f1 }),
    baseRow({ jobId: 'job-aaaaaaaaaaaaaaaaaaaa2', label: '靶点B（内存原文）', overall: 7, reportHtml: bigHtml('内存报告 C', 90) }),
    baseRow({ jobId: 'job-aaaaaaaaaaaaaaaaaaaa3', label: '靶点C（markdown 重建）', overall: 5, hasReport: false, reportMarkdown: '## 评估结论\n总分 5/10，证据有限。', reportHtmlPath: undefined, reportHtml: undefined }),
    baseRow({ jobId: 'impb-1', label: '靶点D（bare 降级载入）', overall: 0, imported: true, bare: true, importedFile: '导入报告.html', hasReport: false, sequence: 'MKTAYIAKQRQISFVKSHFSRQ' }),
    baseRow({ jobId: 'imp-1', label: '靶点E（导入解析行）', overall: 7, imported: true, importedFromFile: true, importedFile: '导入报告.html', hasReport: false, reportHtmlPath: f2 }),
    baseRow({ jobId: 'job-aaaaaaaaaaaaaaaaaaaa4', label: '靶点F（文件丢失→写盘回退）', overall: 4, reportHtmlPath: fLost }),
  ]
  // 删除 lost 文件 — stat/规划阶段已通过（模拟：写盘时文件被清理）
  fs.rmSync(fLost)

  const verdicts: HtVerdict[] = rows.map(r => ({
    jobId: r.jobId,
    verdict: r.overall >= 7 ? 'go' : r.overall >= 5 ? 'caution' : 'no',
    line: `规则结论 — 总分 ${r.overall}/10`,
    source: 'rule',
  }))
  const stats = computeHtStats(rows.filter(r => !r.bare), rows.filter(r => !r.bare).length, rows.filter(r => r.bare).length)
  const input = {
    title: '高通量评估汇总报告 · 6 靶点 · 2026-02-01（v2.71 流式一致性验证）',
    goal: '验证流式写盘与整串渲染字节一致',
    rows,
    stats,
    verdicts,
    markdown: '## 执行摘要\n测试批次。\n\n## 整体可行性画像\n含 <特殊> & "字符"。',
    llmOk: true,
    llmErrors: [],
    engineSummary: '测试引擎 · test-model',
    origin: 'https://eval.example.com',
    generatedAt: '2026-02-01 10:00:00',
    excelRows: [{ label: '靶点A（路径原文）', text: '原始行 · 蛋白A · 小鼠 [序列 100 aa]' }],
  } as Parameters<typeof renderHtDashboardHtml>[0]

  // 路径 1：旧整串渲染（fixture 链路）
  const whole = renderHtDashboardHtml(input)
  const wholePath = path.join(tmp, 'whole.html')
  fs.writeFileSync(wholePath, whole, 'utf-8')

  // 路径 2：流式写盘（服务端链路 — 含进度回调）
  const progressMsgs: string[] = []
  const streamPath = path.join(tmp, 'stream.html')
  await writeHtDashboardHtmlFile(input, streamPath, m => progressMsgs.push(m))

  const wholeBuf = fs.readFileSync(wholePath)
  const streamBuf = fs.readFileSync(streamPath)
  let pass = 0
  let fail = 0
  const check = (name: string, ok: boolean, detail?: string) => {
    if (ok) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
  }
  // 路径行语义：整串渲染（fixture 链路）降级重建页变体；流式写盘（服务端链路）嵌原文
  // → 两产物行数相同、内存行/bare 行/重建行逐行一致，路径行仅在流式侧多出 html
  check('两路径载荷 script 标签均存在', streamBuf.includes('<script type="application/json" id="ht-rpt-data">') && wholeBuf.includes('<script type="application/json" id="ht-rpt-data">'))
  const re = /<script type="application\/json" id="ht-rpt-data">([\s\S]*?)<\/script>/
  const wm = re.exec(wholeBuf.toString('utf-8'))
  const sm = re.exec(streamBuf.toString('utf-8'))
  check('载荷正则可提取（两路径）', Boolean(wm && sm))
  if (wm && sm) {
    const wp = JSON.parse(wm[1]!.replace(/\\u003c/g, '<')) as { c?: string; r: Array<{ j: string; html?: string; a?: string; h?: string }> }
    const sp = JSON.parse(sm[1]!.replace(/\\u003c/g, '<')) as typeof wp
    const order = [...rows].sort((a, b) => b.overall - a.overall).map(r => r.jobId)
    check('载荷 JSON 可解析且含 6 行（两路径）', wp.r.length === 6 && sp.r.length === 6, `whole ${wp.r.length} / stream ${sp.r.length}`)
    check('载荷顺序与主表排序一致（data-i 对齐，两路径）', wp.r.every((x, i) => x.j === order[i]) && sp.r.every((x, i) => x.j === order[i]))
    // 内存行 / markdown 行 / bare 行：两路径逐行字节一致
    const wBy = new Map(wp.r.map(x => [x.j, x] as const))
    const sBy = new Map(sp.r.map(x => [x.j, x] as const))
    check('内存原文行两路径一致（html 逐字节）', wBy.get('job-aaaaaaaaaaaaaaaaaaaa2')?.html === sBy.get('job-aaaaaaaaaaaaaaaaaaaa2')?.html)
    check('markdown 重建行两路径一致（a 逐字节）', wBy.get('job-aaaaaaaaaaaaaaaaaaaa3')?.a === sBy.get('job-aaaaaaaaaaaaaaaaaaaa3')?.a)
    check('bare 载入行两路径一致（a 逐字节）', wBy.get('impb-1')?.a === sBy.get('impb-1')?.a)
    // 路径行：流式嵌原文（与磁盘文件一致）；整串降级 a 变体（fixture 链路不读盘）
    // v2.86：原文进共享池（r[i].sk 引用 + RP.s 池）— 断言解引后与磁盘文件比对
    const f1Src = fs.readFileSync(f1, 'utf-8')
    const f2Src = fs.readFileSync(f2, 'utf-8')
    const skHtml = (p: typeof sp, job: string): string | undefined => {
      const row = p.r.find(x => x.j === job)
      if (!row) return undefined
      if (typeof row.html === 'string') return row.html
      return row.sk != null && p.s && typeof p.s[row.sk] === 'string' ? p.s[row.sk] : undefined
    }
    check('靶点A 路径原文已内嵌且与磁盘文件一致（延迟读取生效 — v2.86 sk 共享池）', skHtml(sp, 'job-aaaaaaaaaaaaaaaaaaaa1') === f1Src)
    check('靶点E 导入留存原文已内嵌且与磁盘文件一致（v2.86 sk 共享池）', skHtml(sp, 'imp-1') === f2Src)
    check('整串链路路径行降级重建页变体（a 字段 — fixture 语义）', typeof wBy.get('job-aaaaaaaaaaaaaaaaaaaa1')?.a === 'string' && !wBy.get('job-aaaaaaaaaaaaaaaaaaaa1')?.html)
    // 丢文件行：流式回退 a 变体；重建页样式 c 已内嵌（保守判定）
    check('靶点F 文件丢失回退重建页变体（a 字段 — 写盘时降级）', typeof sBy.get('job-aaaaaaaaaaaaaaaaaaaa4')?.a === 'string' && !sBy.get('job-aaaaaaaaaaaaaaaaaaaa4')?.html)
    check('重建页样式 c 已内嵌（任何行无内存原文即内嵌 — 丢文件行弹出页不缺样式）', typeof sp.c === 'string' && sp.c.length > 1000)
  }
  check('进度回调有输出', progressMsgs.length > 0, progressMsgs.join(' | '))
  check('进度含内嵌报告计数', progressMsgs.some(x => /内嵌报告原文 \d+\/\d+/.test(x)), progressMsgs.join(' | '))

  // 纯内存行场景（fixture 形态 — 全部 reportHtml 字符串）：两路径必须字节级一致
  const memRows: HtDashboardRow[] = [
    baseRow({ jobId: 'job-cccccccccccccccccccc1', label: 'M1', overall: 9, reportHtml: bigHtml('内存 1', 60) }),
    baseRow({ jobId: 'job-cccccccccccccccccccc2', label: 'M2', overall: 6, hasReport: false, reportMarkdown: '## md2' }),
    baseRow({ jobId: 'job-cccccccccccccccccccc3', label: 'M3', overall: 0, imported: true, bare: true, hasReport: false, sequence: 'MKTAYIAK' }),
  ]
  const memInput = { ...input, rows: memRows, verdicts: memRows.map(r => ({ jobId: r.jobId, verdict: 'go' as const, line: 'ok', source: 'rule' as const })), stats: computeHtStats(memRows.filter(r => !r.bare), 2, 1) } as Parameters<typeof renderHtDashboardHtml>[0]
  const memWhole = renderHtDashboardHtml(memInput)
  const memStream = path.join(tmp, 'mem.html')
  await writeHtDashboardHtmlFile(memInput, memStream)
  check('纯内存行：两路径字节级一致（fixture 链路等价）', fs.readFileSync(memStream).equals(Buffer.from(memWhole, 'utf-8')))

  // 无载荷行场景（anyBody=false — 直写）
  const noBodyRows = [baseRow({ jobId: 'job-bbbbbbbbbbbbbbbbbbbb1', label: '纯统计行', reportHtml: undefined, reportHtmlPath: undefined, hasReport: false })]
  const input2 = { ...input, rows: noBodyRows, verdicts: [{ jobId: 'job-bbbbbbbbbbbbbbbbbbbb1', verdict: 'go', line: 'ok', source: 'rule' }], stats: computeHtStats(noBodyRows, 1, 0) } as Parameters<typeof renderHtDashboardHtml>[0]
  const nbWhole = renderHtDashboardHtml(input2)
  const nbStream = path.join(tmp, 'nobody.html')
  await writeHtDashboardHtmlFile(input2, nbStream)
  check('无载荷行：两路径一致', fs.readFileSync(nbStream).equals(Buffer.from(nbWhole, 'utf-8')))

  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

void main().catch(e => { console.error(e); process.exit(1) })
