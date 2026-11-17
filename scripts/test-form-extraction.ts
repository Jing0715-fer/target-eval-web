/**
 * v2.5 表单结构化提取单元验证：
 *  1. 真实评估表（upload/水木未来…docx）→ parseDocx → extractGoalHints（结构化目标）
 *  2. extractLigandCandidatesFromText（配体模式提名：Resmetirom 应命中）
 *  3. fallbackInsights（LLM 不可用时的规则兜底完整性）
 *  4. 边界样例：模板段剔除 / 标签-值错行 / 空目标字段 / 字段式配体列表
 */
import { readFileSync } from 'node:fs'
import { parseDocx } from '../src/lib/eval/docx'
import { extractGoalHints } from '../src/lib/eval/docx'
import { extractLigandCandidatesFromText } from '../src/lib/eval/ligand'
import { fallbackInsights } from '../src/lib/eval/docx-llm'

const FILE = process.argv[2] ?? 'upload/水木未来-结构解析评估表2026版-2026-11-10 何晓.docx'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name}`, detail !== undefined ? JSON.stringify(detail, null, 2) : '')
  }
}

async function main() {
  // ── 真实评估表 ──
  const buf = readFileSync(FILE)
  const { parsed } = await parseDocx(buf, { noVlm: true })
  const text = parsed.fullText ?? ''

  console.log('\n[1] 真实评估表 → 结构化目标提取')
  const goals = extractGoalHints(text)
  console.log('  goals =', JSON.stringify(goals, null, 2))
  check('包含「预期目标一」值（三维结构）', goals.some(g => g.includes('整体三维结构') && g.includes('FBX021')))
  check('包含「预期目标二」值（Resmetirom 结合）', goals.some(g => g.includes('Resmetirom') && g.includes('结合模式')))
  check('包含「项目目的」值（蛋白-药物复合物）', goals.some(g => g.includes('蛋白-药物复合物')))
  check('无空标签行（「预期目标一：」不再作为目标）', !goals.some(g => /^预期目标/.test(g) && g.length <= 8))
  check('无模板示例段内容（填写范例说明已剔除）', !goals.some(g => g.includes('例如') || g.includes('简要介绍目标蛋白')))

  console.log('\n[2] 真实评估表 → 配体候选提名')
  const ligands = extractLigandCandidatesFromText(text)
  console.log('  ligands =', JSON.stringify(ligands, null, 2))
  check('Resmetirom 命中', ligands.some(l => /resmetirom/i.test(l)))
  check('无技术名词误报（AlphaFold/BLAST/UniProt 等）', !ligands.some(l => /alphafold|blast|uniprot|skp1|scf|pdb/i.test(l)))

  console.log('\n[3] fallbackInsights（LLM 不可用时）')
  const fb = fallbackInsights(text, parsed.goalHints ?? [])
  console.log('  fallback =', JSON.stringify({ goals: fb.goals, ligands: fb.ligands, source: fb.source }, null, 2))
  check('兜底 goals ≥ 3 条（含两条预期目标）', (fb.goals ?? []).length >= 3)
  check('兜底 ligands 含 Resmetirom', (fb.ligands ?? []).some(l => /resmetirom/i.test(l)))

  // ── 边界样例 ──
  console.log('\n[4] 边界样例')
  const s1 = '一、项目目的：解析apo与复合物结构\n项目目标：\n预期目标一：\n获得apo蛋白结构\n预期目标二：\n解析复合物结构\n填写范例说明\n一、项目目的：\n例如：确定抗原-抗体结合模式\n四、项目目标：\n1. 预期目标一：\n解析蛋白的整体三维结构。'
  const g1 = extractGoalHints(s1)
  console.log('  样例1 goals =', JSON.stringify(g1))
  check('样例1：两组标签-错行值全部提取', g1.includes('获得apo蛋白结构') && g1.includes('解析复合物结构'))
  check('样例1：模板段「例如」未混入', !g1.some(g => g.startsWith('例如') || g.includes('解析蛋白的整体三维结构')))

  const s2 = '预期目标一：解析X蛋白结构\n预期目标二：\n（客户未填写）\n其他项目相关胶图、分子筛图可直接粘贴\n配体：Resmetirom、ATP\n研究A蛋白与Imatinib抑制剂结合模式'
  const g2 = extractGoalHints(s2)
  const l2 = extractLigandCandidatesFromText(s2)
  console.log('  样例2 goals =', JSON.stringify(g2), ' ligands =', JSON.stringify(l2))
  check('样例2：行内值提取（预期目标一）', g2.includes('解析X蛋白结构'))
  check('样例2：顿号列表配体全提名（Resmetirom + ATP）', l2.some(l => /resmetirom/i.test(l)) && l2.some(l => /^ATP$/i.test(l)))
  check('样例2：邻接式提名（Imatinib）', l2.some(l => /imatinib/i.test(l)))

  const s3 = '项目目的：解析蛋白-药物复合物结构以指导药物优化\n研究FBX021蛋白与Resmetirom配体结合模式，揭示其功能机制'
  const l3 = extractLigandCandidatesFromText(s3)
  console.log('  样例3 ligands =', JSON.stringify(l3))
  check('样例3：泛化「蛋白-药物」不误报', !l3.some(l => /药物|蛋白/i.test(l)))
  check('样例3：Resmetirom 仍命中', l3.some(l => /resmetirom/i.test(l)))

  console.log(`\n结果：${pass} 通过 · ${fail} 失败`)
  if (fail > 0) process.exit(1)
}

void main().catch(e => {
  console.error('测试异常：', e)
  process.exit(1)
})
