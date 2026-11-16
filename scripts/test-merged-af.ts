/**
 * v2.9 各靶点单独报告 — AlphaFold 交互视图真实链路验证：
 *  3 个真实小蛋白（血红蛋白 α/β + 肌红蛋白）联网获取 AF 模型 →
 *  renderMergedReportHtml 产出含 MODELS/3Dmol 的 HTML → Playwright 实机加载：
 *  断言 .af-stage.af-live ×3（三视图全部初始化成功）+ 截图留档。
 *  断网环境自动降级：afViews 为空 → 跳过实机部分（仅静态断言）。
 */
import * as fs from 'node:fs/promises'
import { renderMergedReportHtml, type MergedTargetData } from '../src/lib/eval/report-merged'
import type { AlphafoldSummaryInfo, BlastHit, PdbEntry, RelationJudgment, Scores } from '../src/lib/eval/types'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}`, detail !== undefined ? JSON.stringify(detail) : '') }
}

function mockTarget(uniprot: string, name: string, pdbCount: number, af: AlphafoldSummaryInfo): MergedTargetData {
  const scores: Scores = {
    xray: { score: 8, rating: '优先推荐' },
    cryoem: { score: 4, rating: '中等' },
    nmr: { score: 3, rating: '困难' },
    overall: { score: 7, rating: '优先推荐' },
  }
  const pdbs: PdbEntry[] = Array.from({ length: pdbCount }, (_, i) => ({
    pdbId: `1AB${i}`,
    title: `${name} structure ${i + 1}`,
    method: 'X-RAY DIFFRACTION',
    resolution: 1.8 + i * 0.2,
    releaseDate: '2021-06-01',
    ligands: [],
    isXray: true,
    isCryoem: false,
    isNmr: false,
  }))
  const blast: BlastHit[] = []
  return {
    jobId: `job_${uniprot}`,
    label: uniprot,
    uniprotId: uniprot,
    proteinName: name,
    geneNames: [name.toUpperCase()],
    organism: 'Homo sapiens',
    sequenceLength: 150,
    scores,
    methodStats: { xrayCount: pdbCount, cryoemCount: 0, nmrCount: 0, bestResolution: pdbCount ? 1.8 : null },
    directPdbs: pdbs,
    blastHits: blast,
    coveragePercent: 88,
    literature: [],
    literatureCount: 0,
    ligandCount: 0,
    durationMs: 60000,
    alphafold: af,
  }
}

const relation: RelationJudgment = {
  related: true,
  relationType: 'homologous',
  confidence: 'high',
  rationale: '球蛋白家族',
  strategy: '家族证据互用',
}

async function main() {
  const targets: MergedTargetData[] = [
    mockTarget('P69905', 'Hemoglobin subunit alpha', 4, { available: true, modelId: 'AF-P69905-F1', globalPlddt: 92.1, version: 4, fracVeryHigh: 0.65 }),
    mockTarget('P68871', 'Hemoglobin subunit beta', 3, { available: true, modelId: 'AF-P68871-F1', globalPlddt: 90.4, version: 4, fracVeryHigh: 0.6 }),
    mockTarget('P02144', 'Myoglobin', 2, { available: true, modelId: 'AF-P02144-F1', globalPlddt: 94.8, version: 4, fracVeryHigh: 0.72 }),
  ]

  const html = await renderMergedReportHtml({
    targets,
    relation,
    goal: '家族级结构解析可行性评估',
    markdown: '# 球蛋白家族合并评估\n\n## 执行摘要\n\nmock 摘要。',
    title: '球蛋白家族合并结构可行性评估',
    llmOk: true,
    llmErrors: [],
    images: [],
    assetDir: '/tmp/none',
    batchReportId: 'br_af_real',
    engineSummary: 'mock-engine',
  })

  console.log('\n[1] 静态断言（真实 AF 模型链路）')
  const stages = [...html.matchAll(/<div class="af-stage" data-maf="(P\d+)"/g)].map(m => m[1])
  console.log('  data-maf 阶段：', stages.join(','))
  check('3 个交互视图阶段（P69905/P68871/P02144）', stages.join(',') === 'P69905,P68871,P02144', { stages })
  check('3Dmol bundle 内嵌', html.includes('$3Dmol') && /createViewer/.test(html))
  check('MODELS JSON 含真实 PDB 文本（HEADER/ATOM 行）', /"P69905":"(?:HEADER|ATOM)/.test(html), html.includes('MODELS'))
  check('pLDDT 着色脚本内嵌', html.includes("v >= 90 ? 'hi'"))
  check('统计行含 pLDDT', html.includes('平均 pLDDT'))

  const htmlPath = '/tmp/merged-af-test.html'
  await fs.writeFile(htmlPath, html, 'utf-8')
  console.log(`  HTML 已落盘：${htmlPath}（${Math.round(html.length / 1024)}KB）`)

  if (stages.length < 3) {
    console.log('\n[2] 断网/无模型 — 跳过实机验证（静态断言已覆盖降级路径）')
    console.log(`\n结果：${pass} 通过 · ${fail} 失败`)
    if (fail > 0) process.exit(1)
    return
  }

  console.log('\n[2] Playwright 实机验证（多视图初始化）')
  const pw = (await import('playwright')) as unknown as { chromium: { launch(o: object): Promise<any> } }
  const browser = await pw.chromium.launch({ args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] })
  const page = await browser.newPage()
  await page.setViewportSize({ width: 1000, height: 1400 })
  const errors: string[] = []
  page.on('pageerror', (e: Error) => errors.push(String(e).slice(0, 200)))
  await page.goto(`file://${htmlPath}`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  try {
    await page.waitForFunction(
      `document.querySelectorAll('.af-stage[data-maf]').length === 3 && document.querySelectorAll('.af-stage.af-live, .af-stage.af-fail').length === 3`,
      null,
      { timeout: 25_000, polling: 200 },
    )
  } catch {
    // 超时也继续 — 下面断言给出明确失败信息
  }
  const liveCount = await page.evaluate(`document.querySelectorAll('.af-stage.af-live').length`)
  const failCount = await page.evaluate(`document.querySelectorAll('.af-stage.af-fail').length`)
  console.log(`  af-live: ${liveCount} · af-fail: ${failCount}`)
  check('3 个视图全部 af-live（交互初始化成功）', liveCount === 3 && failCount === 0, { liveCount, failCount })
  check('无页面脚本错误', errors.length === 0, errors)
  // 滚到简报章节截图留档
  await page.evaluate(`document.querySelector('#mini-reports').scrollIntoView()`)
  await new Promise(r => setTimeout(r, 800))
  await page.screenshot({ path: '/tmp/merged-af-mini.png', type: 'png' })
  check('截图已保存', true)
  await browser.close()

  console.log(`\n结果：${pass} 通过 · ${fail} 失败`)
  if (fail > 0) process.exit(1)
}

main().catch(e => {
  console.error('FATAL', e)
  process.exit(1)
})
