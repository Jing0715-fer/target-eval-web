#!/usr/bin/env node
/**
 * 生成 v2.24 名称解析 E2E 用「非标准评估表」docx —— 只有靶点名称（TL1A 等），
 * 不含 UniProt ID 与序列（触发 resolveNames 名称→UniProt 解析链路）。
 * 运行：node scripts/make-name-only-docx.mjs [输出路径] [名称列表CSV]
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { execSync } from 'node:child_process'

const OUT = process.argv[2] ?? '/tmp/tl1a-only.docx'
const NAMES = (process.argv[3] ?? 'TL1A').split(',')

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const para = (text) => `<w:p><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`
const heading = (text) => `<w:p><w:pPr><w:rPr><w:b/></w:rPr></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`

const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
${heading('靶点结构解析可行性评估表（非标准表：仅靶点名称）')}
${para('一、评估靶点')}
${NAMES.map((n) => para(`靶点名称：${n}`)).join('\n')}
${para('二、客户目标')}
${para('评估上述靶点蛋白的可溶性表达、纯化与结构解析可行性，希望获得结晶与 Cryo-EM 方法的对比建议。')}
${para('三、实验数据')}
${para('大肠杆菌表达系统，Ni 柱纯化后纯度约 85%，SDS-PAGE 显示主带位置正确，SEC 有聚集峰需优化。')}
${para('四、备注')}
${para('客户未提供 UniProt 编号与构建序列，仅提供靶点名称。')}
</w:body>
</w:document>`

const tmpDir = '/tmp/docx-build-nameonly'
await fs.rm(tmpDir, { recursive: true, force: true })
await fs.mkdir(path.join(tmpDir, '_rels'), { recursive: true })
await fs.mkdir(path.join(tmpDir, 'word', '_rels'), { recursive: true })
await fs.writeFile(path.join(tmpDir, '[Content_Types].xml'), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`)
await fs.writeFile(path.join(tmpDir, '_rels/.rels'), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`)
await fs.writeFile(path.join(tmpDir, 'word/_rels/document.xml.rels'), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`)
await fs.writeFile(path.join(tmpDir, 'word/document.xml'), documentXml)
execSync(`cd ${tmpDir} && rm -f ${OUT} && zip -q -r -X ${OUT} '[Content_Types].xml' _rels word`, { shell: '/bin/bash' })
console.log(`✓ 生成 ${OUT}（${(await fs.stat(OUT)).size} bytes，靶点名称：${NAMES.join('/')}）`)
