/**
 * v2.7 配体详情链路实测：
 *  - Resmetirom（无 PDB 组分）→ PubChem CID 15981237 → 性质 + 2D 结构式
 *  - ATP（PDB 组分 direct-id）→ RCSB InChIKey → PubChem 性质 + 2D 结构式
 *  - Imatinib（alias STI）→ 同上
 */
import { resolveLigandInput, enrichLigandDetail } from '../src/lib/eval/ligand'

async function main() {
  for (const raw of ['Resmetirom', 'ATP', 'Imatinib']) {
    const t0 = Date.now()
    const res = await resolveLigandInput({ raw, source: 'text' })
    await enrichLigandDetail(res)
    console.log(`\n${raw} → ${res.ok ? 'ok' : 'FAIL'} compId=${res.compId || '—'} strategy=${res.strategy} (${Date.now() - t0}ms)`)
    if (res.detail) {
      const d = res.detail
      console.log('  detail:', JSON.stringify({ ...d, structure2d: d.structure2d ? `[${d.structure2d.length} b64 chars]` : undefined }))
    } else {
      console.log('  detail: (none)')
    }
  }
}
main().catch(e => { console.error(e); process.exit(1) })
