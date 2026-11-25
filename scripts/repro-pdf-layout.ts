/** 复现诊断：单靶点报告 PDF 导出「内容压缩成中段窄条」问题（用户实测 P00533 PDF）
 *  — 从 DB 作业数据重建报告 HTML → 复刻 renderReportPdf 步骤 + 注入媒体探针
 *  用法：bun scripts/repro-pdf-layout.ts（FIX_ATPAGE=1 启用纠正性 @page 对照验证）
 */
import * as fs from 'node:fs'
import { chromium } from 'playwright'
import { Database } from 'bun:sqlite'
import { renderReportHtml } from '@/lib/eval/report-html'

const JOB_ID = 'cmwim61oi0000vcfcq0j5smsr'

// ── ① 从 DB 重建报告 HTML ───────────────────────────────────────────────
function loadJob() {
  const db = new Database('db/custom.db', { readonly: true })
  const j = db.query('SELECT * FROM EvaluationJob WHERE id = ?').get(JOB_ID) as Record<string, string>
  db.close()
  return {
    summary: JSON.parse(j.summary) as Record<string, unknown>,
    pdbs: JSON.parse(j.pdbs) as unknown[],
    literature: JSON.parse(j.literature) as unknown[],
    reportMarkdown: j.reportMarkdown,
    options: JSON.parse(j.options) as Record<string, unknown>,
  }
}

function makeSeq(n: number): string {
  const AAS = 'ACDEFGHIKLMNPQRSTVWY'
  let s = ''
  let h = 7
  for (let i = 0; i < n; i++) { h = (h * 31 + i * 7 + 3) % 99991; s += AAS[h % 20] }
  return s
}

/** 极小合成 PDB（3Dmol viewer 初始化路径用） */
const FAKE_PDB = Array.from({ length: 60 }, (_, i) =>
  `ATOM  ${String(i + 1).padStart(5)}  CA  ALA A ${String(i + 1).padStart(4)}    ${((i * 3) % 60).toFixed(3)}  ${((i * 5) % 80).toFixed(3)}  ${((i * 7) % 50).toFixed(3)}  1.00 ${((70 + (i % 20))).toFixed(2)}           C`,
).join('\n')

/** 1x1 红点 PNG（AF 头图占位） */
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

async function buildHtml(): Promise<string> {
  const job = loadJob()
  const s = job.summary
  const uniprot = s.uniprot as Record<string, unknown>
  const scores = { ...(s.scores as Record<string, unknown>) } as unknown as Record<string, unknown>
  scores.rationale = {
    xray: 'X-ray 结晶评分依据（复现）',
    cryoem: 'Cryo-EM 评分依据（复现）',
    nmr: 'NMR 评分依据（复现）',
    overall: '综合评分依据（复现）',
  }
  const ctx = {
    uniprot,
    sequence: makeSeq((uniprot.sequenceLength as number) ?? 1210),
    goalHints: [],
    directPdbs: job.pdbs,
    blastHits: [],
    blastStatus: s.blast,
    coverage: null,
    coverageText: s.coverageText,
    gapText: '—',
    literature: job.literature,
    images: [],
    scores,
    oligomer: s.oligomer,
    alphafold: s.alphafold,
    mwAugment: s.mwAugment,
  } as never // ReportContext 结构复刻（诊断脚本 — 宽松转型）
  const html = await renderReportHtml({
    ctx,
    methodStats: s.methodStats as never,
    llmMarkdown: job.reportMarkdown,
    llmOk: true,
    llmErrors: [],
    jobId: JOB_ID,
    durationMs: (s.durationMs as number) ?? 54637,
    totalPdbFound: 394,
    engineSummary: 'MiniMax（国内） · MiniMax-M3.1-Flash',
    alphafoldFigure: {
      dataUri: TINY_PNG, modelId: 'AF-P00533-F1', globalPlddt: 75.9, version: 6, fracVeryHigh: 0.474,
    },
    alphafoldStructure: {
      pdbText: FAKE_PDB, uniprotId: 'P00533', modelId: 'AF-P00533-F1', globalPlddt: 75.9, version: 6, fracVeryHigh: 0.474,
    },
    resolveImagePath: () => '/dev/null',
  } as never)
  return html
}

// ── ② 复刻 renderReportPdf 步骤（+ 探针）────────────────────────────────
const PIN_CSS = (m: { pw: number; pad: string; bfs: string }) => `/* rpt-cont-v1 */
  html, body { margin: 0 !important; }
  body { font-size: ${m.bfs} !important; }
  .page { margin: 0 !important; max-width: none !important; width: ${m.pw}px !important;${m.pad ? ` padding: ${m.pad} !important;` : ''} min-height: 0 !important; }
  .rpt-view { display: block !important; }
  .tbl-wrap, .tblwrap, .md-tblwrap { overflow: visible !important; }
  .tbl-wrap::before, .tbl-wrap::after, .tblwrap::after { display: none !important; }
  .tblwrap table, .md-tblwrap table { table-layout: auto !important; min-width: 0 !important; }
  .tblwrap th, .md-tblwrap th { white-space: normal; }
  .t-clamp { display: block !important; -webkit-line-clamp: unset !important; overflow: visible !important; }
  .copy-btn, .rpt-zoom-badge, .backtop, .af-expand, .af-fullwrap, .rpt-zoom,
  .af-tb-sel, .tbl-ctl, .lib-toggle, .mt-btns, .mt-tools, .seq-copy, .no-print { display: none !important; }
  .af-stage .af-canvas, .af-stage .af-tb { display: none !important; }
  .af-stage .af-poster[src], .af-stage.af-live .af-poster[src] { display: block !important; }
  .seq-pre { max-height: none !important; overflow: visible !important; }`

/** 媒体探针（PDF 文本提取可读 — 判定 print 管线实际命中哪个媒体/档位） */
const PROBE_CSS = `
#probe-mp, #probe-mq, #probe-vh { position: fixed; left: 0; z-index: 999; font: bold 11px monospace; color: #000; background: #ff0; padding: 1px 4px; }
#probe-mp { top: 0; }
#probe-mq { top: 16px; }
#probe-vh { top: 32px; background: #f0f; color: #fff; }
#probe-mp::after { content: "PROBE-MEDIA-SCREEN"; }
@media print { #probe-mp::after { content: "PROBE-MEDIA-PRINT"; } }
#probe-mq::after { content: "PROBE-MQ-BASE"; }
@media (min-width: 1440px) { #probe-mq::after { content: "PROBE-MQ-1440"; } }
@media (min-width: 2000px) { #probe-mq::after { content: "PROBE-MQ-2000"; } }
#probe-vh::after { content: "PROBE-VH-" attr(data-vh); }
#probe-top { position: static; width: 120px; height: 60px; background: #e11; margin: 0; }
`

async function main() {
  const html = await buildHtml()
  fs.writeFileSync('/tmp/repro-egfr.html', html)
  console.log(`HTML written: ${(html.length / 1024).toFixed(0)}KB`)

  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] })
  const page = await browser.newPage()
  page.on('pageerror', e => console.error('[pageerror]', String(e).slice(0, 200)))
  page.on('console', m => { if (m.type() === 'error') console.error('[console.error]', m.text().slice(0, 200)) })

  await page.emulateMedia({ media: 'screen' })
  await page.setViewportSize({ width: 1440, height: 900 })
  try {
    await page.setContent(html, { waitUntil: 'load', timeout: 90_000 })
  } catch (e) {
    console.warn('load best-effort:', String(e).slice(0, 100))
  }
  await page.waitForFunction('document.readyState !== "loading"', null, { timeout: 10_000, polling: 250 }).catch(() => undefined)
  await page.evaluate(() => {
    document.querySelectorAll('img[loading]').forEach(el => el.setAttribute('loading', 'eager'))
  }).catch(() => undefined)
  await page.waitForFunction('Array.from(document.images).every(function(i){return i.complete})', null, { timeout: 30_000, polling: 250 }).catch(() => console.warn('img wait timeout'))
  await page.evaluate(() => Promise.race([
    (document as unknown as { fonts?: { ready: Promise<unknown> } }).fonts?.ready ?? Promise.resolve(),
    new Promise(r => setTimeout(r, 15_000)),
  ])).catch(() => undefined)
  await new Promise(r => setTimeout(r, 300))

  // 探针注入
  await page.evaluate((css: string) => {
    const st = document.createElement('style')
    st.textContent = css
    document.head.appendChild(st)
    for (const [id, vh] of [['probe-mp', ''], ['probe-mq', ''], ['probe-vh', String(Math.round(window.innerHeight))]] as const) {
      const d = document.createElement('div')
      d.id = id
      d.setAttribute('data-vh', vh)
      document.body.prepend(d)
    }
    const top = document.createElement('div')
    top.id = 'probe-top'
    document.body.prepend(top)
  }, PROBE_CSS)

  // ④ 版心实测 + 注入钉死 CSS
  const m = await page.evaluate(() => {
    const de = document.documentElement
    const b = document.body
    const pg = document.querySelector('.page')
    const cs = pg ? window.getComputedStyle(pg) : null
    return {
      pw: pg ? Math.ceil(pg.getBoundingClientRect().width) : Math.ceil(de.getBoundingClientRect().width) || 1440,
      pad: cs ? `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}` : '',
      bfs: b ? window.getComputedStyle(b).fontSize : '15px',
    }
  })
  console.log('metrics:', JSON.stringify(m))
  await page.evaluate((css: string) => {
    const st = document.createElement('style')
    st.setAttribute('data-marker', 'rpt-cont-v1')
    st.textContent = css
    document.head.appendChild(st)
    document.querySelectorAll('[data-libpanel][hidden]').forEach(p => p.removeAttribute('hidden'))
  }, PIN_CSS(m))
  await new Promise(r => setTimeout(r, 250))

  // ⑤ 屏幕态布局快照（对照用）
  const screenSnap = await page.evaluate(() => {
    const pg = document.querySelector('.page') as HTMLElement | null
    const r = pg?.getBoundingClientRect()
    const first = pg?.firstElementChild as HTMLElement | null
    return {
      scrollH: Math.ceil(Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)),
      pageRect: r ? { top: r.top, h: Math.round(r.height), w: Math.round(r.width) } : null,
      firstChildTop: first ? Math.round(first.getBoundingClientRect().top) : null,
      bodyChildren: Array.from(document.body.children).slice(0, 6).map(c => `${c.tagName}.${(c as HTMLElement).id || (c as HTMLElement).className?.toString().slice(0, 24)}`),
    }
  })
  console.log('SCREEN layout:', JSON.stringify(screenSnap, null, 1))

  const h = screenSnap.scrollH
  const w = Math.max(400, Math.min(m.pw || 1440, 4096))
  const ph = Math.min(h + 8, 19_008)
  console.log(`→ page.pdf width=${w}px height=${ph}px pageRanges=1`)

  // ★ 修复假设验证：注入纠正性 @page（后于模板规则 — 级联取胜，钉住版面几何）
  if (process.env.FIX_ATPAGE) {
    await page.evaluate((c: string) => {
      const st = document.createElement('style')
      st.setAttribute('data-marker', 'rpt-cont-atpage')
      st.textContent = c
      document.head.appendChild(st)
    }, `@page { size: ${w}px ${ph}px; margin: 0; }`)
    console.log(`FIX_ATPAGE injected: @page { size: ${w}px ${ph}px; margin: 0 }`)
  }

  // ⑥ 打印
  const buf = await page.pdf({
    width: `${w}px`,
    height: `${ph}px`,
    printBackground: true,
    preferCSSPageSize: false,
    pageRanges: '1',
    margin: { top: '0px', bottom: '0px', left: '0px', right: '0px' },
  })
  fs.writeFileSync('/tmp/repro.pdf', buf)
  console.log(`PDF written: /tmp/repro.pdf ${(buf.length / 1024).toFixed(0)}KB`)

  await browser.close()
}

main().catch(e => { console.error(e); process.exit(1) })
