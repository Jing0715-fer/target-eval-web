/**
 * 生成 v1.11 e2e 测试评估表（OOXML 手工构建 + sharp 合成胶图/SEC 图）
 * 内容：人 EGFR P00533 + 小鼠 Egfr Q01279（≥90% 一致 → BLAST 委托组）+ HER2 P04626（75% 旁系）
 *      + 人/小鼠激酶域构建序列 + Fc 抗体 + 目标 + 实验图片（SDS-PAGE / SEC — 验证多靶点页共享图片）
 * 运行：bun scripts/make-eval-docx.ts [输出路径]
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { execSync } from 'node:child_process'
import sharp from 'sharp'

const OUT = process.argv[2] ?? '/tmp/homolog-family-v11.docx'

// ── 1. 合成实验图片（SVG → PNG）──────────────────────────────────────────────
const gelSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="520" height="380">
  <rect width="520" height="380" fill="#f4f2ef"/>
  <rect x="40" y="30" width="440" height="320" fill="#0a0a0a"/>
  <text x="60" y="24" font-size="13" font-family="monospace" fill="#333">SDS-PAGE reducing, 12%</text>
  <!-- 泳道 -->
  ${[1, 2, 3, 4].map((lane, li) => {
    const x = 80 + li * 100
    const bands = [[60, 3, 0.95], [95, 5, 0.35], [150, 8, 0.8], [210, 4, 0.6], [280, 10, 0.25]]
    return bands.map(([y, h, o]) =>
      `<rect x="${x - 28}" y="${y}" width="56" height="${h}" fill="#e8e8e8" opacity="${o}"/>`,
    ).join('') + `<text x="${x - 10}" y="365" font-size="11" font-family="monospace" fill="#666">C${lane}</text>`
  }).join('')}
  <rect x="80" y="145" width="56" height="9" fill="#ffffff" opacity="0.95"/>
  <text x="410" y="62" font-size="10" font-family="monospace" fill="#aaa">~66 kDa</text>
  <text x="410" y="216" font-size="10" font-family="monospace" fill="#aaa">~35 kDa</text>
</svg>`

const secSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="520" height="360">
  <rect width="520" height="360" fill="#ffffff"/>
  <line x1="55" y1="20" x2="55" y2="310" stroke="#333" stroke-width="1.5"/>
  <line x1="55" y1="310" x2="500" y2="310" stroke="#333" stroke-width="1.5"/>
  <text x="270" y="340" font-size="12" font-family="monospace" fill="#333">Retention volume (mL)</text>
  <text x="18" y="170" font-size="12" font-family="monospace" fill="#333" transform="rotate(-90 18 170)">A280 (mAU)</text>
  <!-- 主峰 + 小肩峰 -->
  <path d="M 60 305 C 110 303, 130 300, 150 290 C 175 275, 185 60, 205 45 C 225 60, 235 275, 260 290 C 285 302, 320 304, 360 305 C 400 306, 440 292, 455 268 C 465 250, 475 280, 495 304"
        fill="none" stroke="#1a7f5a" stroke-width="2.5"/>
  <text x="185" y="38" font-size="11" font-family="monospace" fill="#1a7f5a">main peak 96%</text>
  <text x="430" y="252" font-size="11" font-family="monospace" fill="#888">aggregate 2%</text>
  <text x="60" y="30" font-size="12" font-family="monospace" fill="#333">SEC Superdex 200</text>
</svg>`

const gelPng = await sharp(Buffer.from(gelSvg)).png().toBuffer()
const secPng = await sharp(Buffer.from(secSvg)).png().toBuffer()

// ── 2. 文档正文（段落 + 内联图片）───────────────────────────────────────────
const KINASE_HUMAN = 'KKIKVLGSGAFGTVYKGLWIPEGEKVKIPVAIKELREATSPKANKEILDEAYVMASVDNPHVCRLLGICLTSTVQLITQLMPFGCLLDYVREHKDNIGSQYLLNWCVQIAKGMNYLEDRRLVHRDLAARNVLVKTPQHVKITDFGLAKLLGAEEKEYHAEGGKVPIKWMALESILHRIYTHQSDVWSYGVTVWELMTFGSKPYDGIPASEISSILEKGERLPQPPICTIDVYMIMVKCWMIDADSRPKFRELIIEFSKMARDPQRYL'
const KINASE_MOUSE = 'EFKKIKVLGSGAFGTVYKGLWIPEGEKVKIPVAIKEILKATSPKANKEILDEAYVMASVDNPHVCRLLGICLTSTVQLITQLMPYGCLLDYVREHKDNIGSQYLLNWCVQIAKGMNYLEDRRLVHRDLAARNVLVKTPQHVKITDFGLAKLLGAEEKEYHAEGGKVPIKWMALESILHRIYTHQSDVWSYGVTVWELMTFGSKPYDGIPASDISSILEKGERLPQPPICTIDVYMIMVKCWMIDADSRPKFRELILEFSKMARDPQR'
const FC = 'GGGSPPCPPCPAPELLGGPSVFLFPPKPKDTLMISRTPEVTCVVVDVSQEDPEVQFNWYVDGVEVHNAKTKPREEQYNSTYRVVSVLTVLHQDWLNGKEYKCKVSNKALPAPIEKTISKAKGQPREPQVYTLPPSRDELTKNQVSLTCLVKGFYPSDIAVEWESNGQPENNYKTTPPVLDSDGSFFLYSKLTVDKSRWQQGNVFSCSVMHEALHNHYTQKSLSLSPGK'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const para = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`
const heading = (text: string) => `<w:p><w:pPr><w:rPr><w:b/></w:rPr></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`
const img = (id: number, rId: string, name: string, cx: number, cy: number) => `<w:p><w:r><w:drawing>
<wp:inline distT="0" distB="0" distL="0" distR="0">
<wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="${name}" descr="${name}"/>
<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<pic:nvPicPr><pic:cNvPr id="${id}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr>
<pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
</pic:pic>
</a:graphicData>
</a:graphic>
</wp:inline>
</w:drawing></w:r></w:p>`

// 图片像素 520×380 / 520×360 → EMU (96dpi: px * 9525)
const gelEmu = { cx: 520 * 9525, cy: 380 * 9525 }
const secEmu = { cx: 520 * 9525, cy: 360 * 9525 }

const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:body>
${heading('靶点结构解析可行性评估表（同源家族测试 v1.11）')}
${para('一、评估靶点')}
${para('人源 EGFR（UniProt: P00533，Epidermal growth factor receptor，1210 aa）')}
${para('小鼠 Egfr（UniProt: Q01279，Epidermal growth factor receptor，1210 aa）')}
${para('人源 HER2/ERBB2（UniProt: P04626，Receptor tyrosine-protein kinase erbB-2，1255 aa）')}
${para('二、客户构建序列')}
${para('人 EGFR 激酶域构建（aa 713-979）')}
${para(KINASE_HUMAN)}
${para('小鼠 Egfr 激酶域构建')}
${para(KINASE_MOUSE)}
${para('三、伴随抗体（辅助结晶用 Fab 的 Fc 区）')}
${para('抗 EGFR 抗体 1C9-Fc（人 IgG1 Fc，228 aa）')}
${para(FC)}
${para('四、客户目标')}
${para('评估 EGFR 家族（人 EGFR、小鼠 Egfr、HER2）三个同源成员的结构解析可行性；希望借鉴家族内已有结构指导各成员激酶域构建的设计，并确认哪些成员可直接复用家族结构证据。')}
${para('五、实验数据')}
${para('SDS-PAGE：激酶域构建经 Ni 柱纯化后纯度 >90%，主带位于 35 kDa 附近，无明显降解条带。')}
${img(1, 'rId1', 'SDS-PAGE gel of kinase domain constructs', gelEmu.cx, gelEmu.cy)}
${para('SEC：Superdex 200 主峰占比约 96%，峰形对称，聚集峰 <2%，洗脱体积与单体分子量一致。')}
${img(2, 'rId2', 'SEC chromatogram of kinase domain construct', secEmu.cx, secEmu.cy)}
${para('六、备注')}
${para('请重点关注家族内序列一致性对结构证据复用的影响。')}
</w:body>
</w:document>`

// ── 3. 打包为 docx ──────────────────────────────────────────────────────────
const tmpDir = '/tmp/docx-build-v11'
await fs.rm(tmpDir, { recursive: true, force: true })
await fs.mkdir(path.join(tmpDir, 'word', 'media'), { recursive: true })
await fs.mkdir(path.join(tmpDir, '_rels'), { recursive: true })
await fs.mkdir(path.join(tmpDir, 'word', '_rels'), { recursive: true })

await fs.writeFile(path.join(tmpDir, '[Content_Types].xml'), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`)
await fs.writeFile(path.join(tmpDir, '_rels/.rels'), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`)
await fs.writeFile(path.join(tmpDir, 'word/_rels/document.xml.rels'), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image2.png"/>
</Relationships>`)
await fs.writeFile(path.join(tmpDir, 'word/document.xml'), documentXml)
await fs.writeFile(path.join(tmpDir, 'word/media/image1.png'), gelPng)
await fs.writeFile(path.join(tmpDir, 'word/media/image2.png'), secPng)

execSync(`cd ${tmpDir} && rm -f ${OUT} && zip -q -r -X ${OUT} '[Content_Types].xml' _rels word`, { shell: '/bin/bash' })
console.log(`✓ 生成 ${OUT}（${(await fs.stat(OUT)).size} bytes）`)

// 验证 mammoth 能解析出图片
const mammoth = (await import('mammoth')).default
const result = await mammoth.extractRawText({ path: OUT })
console.log(`✓ mammoth 解析文本 ${result.value.length} 字符`)
const html = await mammoth.convertToHtml({ path: OUT, convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: 'data:' })) })
const imgCount = (html.value.match(/<img/g) ?? []).length
console.log(`✓ mammoth 提取图片 ${imgCount} 张（预期 2）`)
if (imgCount !== 2) { console.error('✗ 图片数量不符'); process.exit(1) }
