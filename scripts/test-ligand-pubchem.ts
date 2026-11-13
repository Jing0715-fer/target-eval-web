/**
 * v2.2 配体归一链路实测（PubChem 集成后）：
 *  - Resmetirom（品牌药名，PDB 无对应）→ 期望 PubChem CID 15981237 详情卡
 *  - imatinib（英文通用名，PDB 有 STI）→ 期望 Solr/ PubChem 图精确映射 STI
 *  - 伊马替尼（中文别名）→ 期望别名表 STI
 *  - aspirin（英文，PDB 有对应）→ 期望命中 PDB 组分
 *  - 999x 未知词 → 期望走完链路后失败（错误信息含 PubChem）
 * 之后实测 AF2 截图去白边（P00533）。
 */
import { alphafoldFigureFor } from '../src/lib/eval/alphafold'
import * as fs from 'node:fs/promises'

async function main() {
  // AF2 截图去白边验证（配体链路已在前次运行验证通过）
  console.log('\n[AF2 P00533 去白边]')
  const fig = await alphafoldFigureFor('P00533')
  if (!fig) {
    console.log('  ✗ 生成失败')
    return
  }
  await fs.writeFile('/tmp/af2-trimmed.png', fig.png)
  console.log(`  png=${fig.png.length} bytes → /tmp/af2-trimmed.png`)
}

main().catch(e => {
  console.error('FATAL', e)
  process.exit(1)
})
