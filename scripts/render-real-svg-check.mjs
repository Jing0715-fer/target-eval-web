/** v2.7.6 人工目检辅助：用真实 RCSB CCD SVG 替换 fixture 图源并截灯箱 6× 缩放图 */
import { rcsbCcdDepictionSvg } from '../src/lib/eval/ligand.ts'
import fs from 'node:fs'

const real394 = await rcsbCcdDepictionSvg('394')
const realIre = await rcsbCcdDepictionSvg('IRE')
let html = fs.readFileSync('/tmp/ux-fixtures/report-new.html', 'utf-8')
const svgSrcs = [real394, realIre]
let idx = 0
html = html.replace(/<img src="data:image\/svg\+xml;base64,[^"]*" alt="2D 化学结构式（SVG 矢量）">/g, () => {
  return `<img src="${svgSrcs[idx++] ?? real394}" alt="2D 化学结构式（SVG 矢量）">`
})
fs.writeFileSync('/tmp/ux-fixtures/report-real-svg.html', html)
console.log('written', html.length, 'real svg lens:', real394?.length, realIre?.length)
