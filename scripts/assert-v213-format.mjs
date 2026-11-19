/**
 * v2.13 DOM 级格式一致性断言：合并报告首页/靶点单独评估页 vs 单靶点报告
 *  - 刊头计算样式（font-family / font-size / font-weight / letter-spacing）逐项对比
 *  - 章节结构类名存在性（rpt-head/meta-grid/glance/score-card/pdb 表/文献列表）
 *  - PDB/文献展开验证（直出条数 = 全量，details 不包 PDB/文献主区块）
 */
import { chromium } from 'playwright'

const BASE = 'http://localhost:3000'
const MERGED_OWNER = 'af74a0c83a684442940af04a85764981'
const OWNER = '9043a4cce0f74e379c7972549e500b81'
const MERGED_ID = 'cmwivvirm000fp7cjh7mf7ebl'
const SINGLE_JOB = 'cmwin52wn0007p7too04q7jw7'

const pick = (el) => el ? el.slice(0, 80) : null

async function headStyles(page) {
  return page.evaluate(() => {
    const g = (sel) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const cs = getComputedStyle(el)
      return {
        sel,
        fontFamily: cs.fontFamily.split(',')[0].trim(),
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        letterSpacing: cs.letterSpacing,
        marginBottom: cs.marginBottom,
        color: cs.color,
      }
    }
    return {
      title: g('h1.rpt-title') ?? g('.rpt-title'),
      eyebrow: g('.rpt-eyebrow'),
      subtitle: g('.rpt-subtitle'),
      metaGrid: g('.meta-grid'),
      h2: g('section h2') ?? g('h2'),
      body: g('body'),
    }
  })
}

async function sectionMap(page) {
  return page.evaluate(() => {
    const out = []
    for (const h of document.querySelectorAll('h2')) {
      out.push((h.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40))
    }
    return out
  })
}

const run = async () => {
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })

  // 合并报告
  const p1 = await ctx.newPage()
  await p1.context().addCookies([{ name: 'te_owner', value: MERGED_OWNER, url: BASE }])
  await p1.goto(`${BASE}/api/evaluate/batch-report?id=${MERGED_ID}&inline=1`, { waitUntil: 'load', timeout: 240_000 })
  await p1.waitForTimeout(2500)
  const mergedHome = await headStyles(p1)
  const mergedHomeH2 = await sectionMap(p1)

  // 进入靶点单独评估页
  await p1.click('.tgt-card')
  await p1.waitForTimeout(1500)
  const mergedTarget = await headStyles(p1)
  const mergedTargetH2 = await sectionMap(p1)
  // PDB 与文献全量展开验证
  const pdbLit = await p1.evaluate(() => {
    const rows = document.querySelectorAll('.pdb-table tbody tr, table.pdb-table tr').length
    const lit = document.querySelectorAll('.lit-item, .lit-list li').length
    const foldPdb = [...document.querySelectorAll('details')].filter(d => /PDB|结构清单/.test(d.querySelector('summary')?.textContent || '')).length
    const foldLit = [...document.querySelectorAll('details')].filter(d => /文献/.test(d.querySelector('summary')?.textContent || '')).length
    const back = document.querySelectorAll('.tgt-back').length
    const score = document.querySelector('.score-card') ? 1 : 0
    const glance = document.querySelector('.glance') ? 1 : 0
    const hasRationale = document.querySelector('.score-rationale') ? 1 : 0
    const afView = document.querySelector('[data-af-3d], .af-3d, #af-3d') ? 1 : 0
    return { rows, lit, foldPdb, foldLit, back, score, glance, hasRationale, afView }
  })

  // 单靶点报告（EGFR）
  const p2 = await ctx.newPage()
  await p2.context().addCookies([{ name: 'te_owner', value: OWNER, url: BASE }])
  await p2.goto(`${BASE}/api/jobs/${SINGLE_JOB}/report`, { waitUntil: 'load', timeout: 120_000 })
  await p2.waitForTimeout(2000)
  const single = await headStyles(p2)
  const singleH2 = await sectionMap(p2)

  console.log('=== 刊头样式对比（合并首页 vs 单靶点）===')
  for (const key of ['title', 'eyebrow', 'subtitle', 'metaGrid', 'h2', 'body']) {
    const a = mergedHome[key], b = single[key]
    if (!a && !b) { console.log(`  ${key}: 两边都缺`); continue }
    const same = a && b && a.fontFamily === b.fontFamily && a.fontSize === b.fontSize && a.fontWeight === b.fontWeight && a.letterSpacing === b.letterSpacing
    console.log(`  ${key}: ${same ? '一致 ✓' : '不一致 ✗'}`)
    if (!same) {
      console.log(`    合并首页: ${JSON.stringify(a)}`)
      console.log(`    单靶点  : ${JSON.stringify(b)}`)
    }
  }
  console.log('\n=== 靶点单独评估页 vs 单靶点 ===')
  for (const key of ['title', 'eyebrow', 'subtitle', 'metaGrid', 'h2', 'body']) {
    const a = mergedTarget[key], b = single[key]
    if (!a && !b) { console.log(`  ${key}: 两边都缺`); continue }
    const same = a && b && a.fontFamily === b.fontFamily && a.fontSize === b.fontSize && a.fontWeight === b.fontWeight && a.letterSpacing === b.letterSpacing
    console.log(`  ${key}: ${same ? '一致 ✓' : '不一致 ✗'}`)
    if (!same) {
      console.log(`    靶点页: ${JSON.stringify(a)}`)
      console.log(`    单靶点: ${JSON.stringify(b)}`)
    }
  }
  console.log('\n=== 靶点单独评估页区块 ===')
  console.log('  score-card:', pdbLit.score, '| glance:', pdbLit.glance, '| score-rationale:', pdbLit.hasRationale, '| 返回钮:', pdbLit.back)
  console.log('  PDB 行数:', pdbLit.rows, '| 文献条数:', pdbLit.lit, '| 包 PDB 的折叠:', pdbLit.foldPdb, '| 包文献的折叠:', pdbLit.foldLit)
  console.log('\n=== 章节标题序列 ===')
  console.log('  合并首页 h2:', mergedHomeH2.join(' | '))
  console.log('  靶点单独页 h2:', mergedTargetH2.join(' | '))
  console.log('  单靶点 h2:', singleH2.join(' | '))

  await browser.close()
}

run().catch(e => { console.error('FATAL', e); process.exit(1) })
