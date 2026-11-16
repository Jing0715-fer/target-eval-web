/**
 * v2.7.6 live 冒烟：RCSB CCD 矢量结构式通道（真实网络）：
 *  - rcsbCcdDepictionSvg：compId → cdn.rcsb.org/images/ccd/unlabeled/{首字母}/{compId}.svg
 *    → 规范化（去 xml/DOCTYPE/固定宽高，viewBox 保留）→ 磁盘缓存 → data URI
 *  - 二次调用命中磁盘缓存；404（无描述的组分）确定性缓存不重试；PNG 回落通道不受影响
 *  - enrichLigandDetail 集成：compId 配体出 SVG、PubChem-only 配体出 PNG
 * 运行：bun scripts/test-ligand-svg-v276.ts
 */
import * as fs from 'node:fs'
import { rcsbCcdDepictionSvg, enrichLigandDetail } from '../src/lib/eval/ligand'
import { pubchem2dStructure } from '../src/lib/eval/pubchem'

const out: Array<[string, boolean]> = []

async function check(compId: string): Promise<string | undefined> {
  const t0 = Date.now()
  const svg = await rcsbCcdDepictionSvg(compId)
  out.push([`${compId} SVG 返回 data URI（${Date.now() - t0}ms）`, !!svg && svg.startsWith('data:image/svg+xml;base64,')])
  if (svg) {
    const text = Buffer.from(svg.slice(svg.indexOf('base64,') + 7), 'base64').toString('utf-8')
    const root = text.match(/<svg[^>]*>/i)?.[0] ?? ''
    out.push([`${compId} 无 xml/DOCTYPE 声明`, !/^<\?xml|^<!DOCTYPE/i.test(text)])
    out.push([`${compId} 根元素无固定 width/height`, !/\s(width|height)="/i.test(root)])
    out.push([`${compId} viewBox 存在`, /viewBox="/i.test(root)])
    out.push([`${compId} 无 <script> 注入面`, !/<script/i.test(text)])
    out.push([`${compId} 缓存落盘 db/cache/ligand2d/${compId}.svg`, fs.existsSync(`db/cache/ligand2d/${compId}.svg`)])
  }
  return svg
}

await check('394')  // erlotinib
const t0 = Date.now()
const again = await rcsbCcdDepictionSvg('394')
out.push([`394 二次调用命中缓存（<20ms）`, !!again && Date.now() - t0 < 20])
await check('ATP') // 大分子量辅因子
await check('HEM') // 血红素（芳香大环）
const miss = await rcsbCcdDepictionSvg('ZZZZZ') // 不存在的组分 → undefined
out.push(['无效组分返回 undefined（不抛错）', miss === undefined])

// PubChem PNG 回落通道不受影响
const png = await pubchem2dStructure(176870)
out.push(['PNG 回落通道不受影响', !!png && png.startsWith('data:image/png;base64,')])

// enrichLigandDetail 集成：compId 配体 → SVG
const lig: Parameters<typeof enrichLigandDetail>[0] = {
  raw: 'erlotinib', source: 'text', ok: true, compId: '394', name: 'ERLOTINIB',
  formula: 'C22H23N3O4', weight: 393.4, strategy: 'alias', totalStructures: 1, structures: [],
}
await enrichLigandDetail(lig)
out.push(['enrichLigandDetail：compId 配体产出 structure2dSvg', !!lig.detail?.structure2dSvg])
out.push(['enrichLigandDetail 幂等（二次不重取）', await enrichLigandDetail(lig) === undefined])

let pass = 0
for (const [n, ok] of out) { console.log(`${ok ? '✓' : '✗'} ${n}`); if (ok) pass++ }
console.log(`${pass}/${out.length} passed`)
if (pass !== out.length) process.exit(1)
