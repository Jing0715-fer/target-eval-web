/**
 * v2.8 配体解析准确度回归 — 抗体/蛋白类试剂拦截（客户反馈：评估表「027 scFv」抗体克隆被误判为配体）：
 *  1. isBiologicMention 强信号：抗体片段/克隆/免疫球蛋白/重轻链（拉丁 + CJK）
 *  2. 真实小分子配体不被误伤（ATP/Resmetirom/伊马替尼/Ferrocene 等）
 *  3. isLikelyCloneNumber 克隆编号弱信号（仅评估表提名过滤用）
 *  4. extractLigandCandidatesFromText 规则提名：抗体 token 不再进入候选
 *  5. resolveLigandInput 拦截链序：「027 scFv」明确排除；真实 chemcomp ID（FAB）
 *     仍走 direct-id 放行（RCSB 实测 FAB/VHH/VHL/IGM/CDR 为合法组分 ID）
 */
import { isBiologicMention, isLikelyCloneNumber } from '../src/lib/eval/ligand-parse'
import { extractLigandCandidatesFromText, resolveLigandInput } from '../src/lib/eval/ligand'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name}`, detail !== undefined ? JSON.stringify(detail) : '')
  }
}

async function main() {
  console.log('\n[1] isBiologicMention — 抗体强信号应全部命中')
  const biologic = ['027 scFv', '027-scFv', 'scFv', 'SCFV', 'Fab', 'Fab fragment', 'nanobody', 'VHH',
    'anti-PD-L1 nanobody', 'IgG', 'human IgG1', 'immunoglobulin', 'heavy chain', 'light chain',
    'CDR3', '鼠源抗体', '抗体重链', '纳米抗体', '免疫球蛋白']
  for (const v of biologic) check(`「${v}」判为生物试剂`, isBiologicMention(v))

  console.log('\n[2] isBiologicMention — 真实小分子配体不误伤')
  const smallMolecules = ['ATP', 'Resmetirom', 'Imatinib', 'staurosporine', 'Erlotinib', 'Glucose',
    'NAD', 'FAD', 'Zinc', '血红素', '伊马替尼', 'Ferrocene', 'Retinol', 'GTP']
  for (const v of smallMolecules) check(`「${v}」不判为生物试剂`, !isBiologicMention(v))

  console.log('\n[3] isLikelyCloneNumber — 克隆编号弱信号')
  check('「027」判为克隆编号', isLikelyCloneNumber('027'))
  check('「12」判为克隆编号', isLikelyCloneNumber('12'))
  check('「clone 12」判为克隆编号', isLikelyCloneNumber('clone 12'))
  check('「B12」不判（字母开头克隆名不猜）', !isLikelyCloneNumber('B12'))
  check('「ATP」不判', !isLikelyCloneNumber('ATP'))
  check('「A1H2J」不判（组分 ID 形态）', !isLikelyCloneNumber('A1H2J'))

  console.log('\n[4] extractLigandCandidatesFromText — 规则提名过滤')
  const t1 = '研究A蛋白与 nanobody 配体的结合模式\n配体：ATP、Resmetirom\n客户已有 027 scFv 抗体可与抗原结合'
  const c1 = extractLigandCandidatesFromText(t1)
  console.log('  提名：', c1)
  check('ATP 仍提名', c1.some(l => /^ATP$/i.test(l)))
  check('Resmetirom 仍提名', c1.some(l => /resmetirom/i.test(l)))
  check('nanobody 被拦截（isJunkMention 接入 isBiologicMention）', !c1.some(l => /nanobody/i.test(l)))
  check('027 scFv 未进入候选', !c1.some(l => /scfv/i.test(l)))

  console.log('\n[5] resolveLigandInput — 归一入口拦截（网络）')
  const r1 = await resolveLigandInput({ raw: '027 scFv', source: 'eval-table' })
  console.log('  027 scFv →', { ok: r1.ok, error: r1.error, strategy: r1.strategy })
  check('「027 scFv」被明确排除（ok=false）', r1.ok === false)
  check('排除原因说明含「抗体」', !!r1.error && r1.error.includes('抗体'))

  const r2 = await resolveLigandInput({ raw: 'anti-PD-L1 nanobody', source: 'text' })
  console.log('  anti-PD-L1 nanobody →', { ok: r2.ok, error: r2.error })
  check('「anti-PD-L1 nanobody」被排除', r2.ok === false)

  const r3 = await resolveLigandInput({ raw: 'FAB', source: 'text' })
  console.log('  FAB →', { ok: r3.ok, compId: r3.compId, strategy: r3.strategy })
  check('「FAB」真实 chemcomp ID 仍放行（direct-id）', r3.ok === true && r3.strategy === 'direct-id')

  const r4 = await resolveLigandInput({ raw: 'SCFV', source: 'text' })
  console.log('  SCFV →', { ok: r4.ok, error: r4.error })
  check('「SCFV」非真实组分（404）→ 按抗体拦截', r4.ok === false && !!r4.error && r4.error.includes('抗体'))

  const r5 = await resolveLigandInput({ raw: 'ATP', source: 'text' })
  console.log('  ATP →', { ok: r5.ok, compId: r5.compId, strategy: r5.strategy })
  check('「ATP」真实配体正常解析', r5.ok === true && r5.compId === 'ATP')

  console.log(`\n结果：${pass} 通过 · ${fail} 失败`)
  if (fail > 0) process.exit(1)
}

main().catch(e => {
  console.error('FATAL', e)
  process.exit(1)
})
