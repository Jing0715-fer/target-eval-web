/**
 * v2.5 配体提名 → 归一链路实测（真实评估表场景）：
 *  - Resmetirom（评估表目标行文中提名）→ 期望 PubChem 详情卡（CID 15981237）或 PDB 组分映射
 *  - ATP（字段式列表）→ direct-id / alias
 *  - Imatinib（邻接式）→ alias STI
 *  - 评估表全文 → extractLigandCandidatesFromText 提名后逐条 resolveLigandInput
 */
import { readFileSync } from 'node:fs'
import { resolveLigandInput, extractLigandCandidatesFromText } from '../src/lib/eval/ligand'

const FILE = 'upload/水木未来-结构解析评估表2026版-2026-11-10 何晓.docx'
const DOC_TEXT = readFileSync('db/reports/u_4f3d6ced-1a7/parsed.json', 'utf-8')
const fullText = (JSON.parse(DOC_TEXT) as { fullText: string }).fullText

async function main() {
  console.log('\n[1] 评估表全文提名（规则，无 LLM）')
  const names = extractLigandCandidatesFromText(fullText)
  console.log('  提名：', names)

  const targets = [...names]
  if (!targets.some(t => /resmetirom/i.test(t))) targets.unshift('Resmetirom')

  for (const raw of targets) {
    console.log(`\n[2] resolveLigandInput("${raw}")`)
    const r = await resolveLigandInput({ raw, source: 'eval-table' })
    console.log('   ok =', r.ok, '| compId =', r.compId || '(无 PDB 组分)', '| name =', r.name, '| formula =', r.formula, '| strategy =', r.strategy, '| MW =', r.weight)
    if (r.pubchem) console.log('   pubchem =', JSON.stringify({ cid: r.pubchem.cid, iupac: (r.pubchem.iupacName ?? '').slice(0, 60), smiles: (r.pubchem.smiles ?? '').slice(0, 40) + '…' }))
    if (r.error) console.log('   error =', r.error)
  }
}

main().catch(e => {
  console.error('FATAL', e)
  process.exit(1)
})
