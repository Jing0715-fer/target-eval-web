/**
 * 配体输入解析（纯函数，客户端 / 服务端共用 — 无 Node 依赖）：
 *  - parseLigandFileText: SDF / MOL / PDB / SMILES 文本 → 名称 / 分子式 / 三位 ID 候选
 *  - 分子式 Hill 排序、元素计数、文件类型识别
 * 上传的配体文件在浏览器端读取文本后经此模块提取身份线索，
 * 服务端 resolveLigandInput 再做多策略归一（直接 ID / 别名 / PDBe Solr / LLM）。
 */

/** 常见结晶学添加剂/溶剂 — 视为无信息量配体（解析自 PDB 格式文件时排除） */
export const LIGAND_JUNK_IDS = new Set([
  'HOH', 'SO4', 'GOL', 'EDO', 'ACT', 'ACY', 'CL', 'NA', 'K', 'CA', 'TRS', 'MES',
  'EPE', 'CIT', 'PO4', 'PEG', 'DTT', 'IMD', 'NO3', 'NHE', 'FLC', 'IOD', 'BR',
  'FMT', 'ETH', 'EOH', 'MPD', '2PE', '1PE', 'P4G', 'PG4', 'PE4', 'TLA', 'MPO',
  'UNL', 'UNX',
])

/** 真实元素符号表（分子式校验 / 元素计数用） */
const ELEMENTS = new Set([
  'H', 'HE', 'LI', 'BE', 'B', 'C', 'N', 'O', 'F', 'NE', 'NA', 'MG', 'AL', 'SI', 'P', 'S', 'CL', 'AR',
  'K', 'CA', 'SC', 'TI', 'V', 'CR', 'MN', 'FE', 'CO', 'NI', 'CU', 'ZN', 'GA', 'GE', 'AS', 'SE', 'BR', 'KR',
  'RB', 'SR', 'Y', 'ZR', 'NB', 'MO', 'TC', 'RU', 'RH', 'PD', 'AG', 'CD', 'IN', 'SN', 'SB', 'TE', 'I', 'XE',
  'CS', 'BA', 'LA', 'HF', 'TA', 'W', 'RE', 'OS', 'IR', 'PT', 'AU', 'HG', 'TL', 'PB', 'BI', 'PO', 'AT', 'RN',
  'FR', 'RA', 'AC', 'TH', 'PA', 'U', 'NP', 'PU',
])

export interface LigandFileParsed {
  kind: 'sdf' | 'mol' | 'pdb' | 'smi' | 'unknown'
  /** SDF/MOL 首行名 或 PDB TITLE 或 .smi 名称部分（可空） */
  name: string
  /** 由原子块统计出的分子式（Hill 排序，如 C9H8O4）；PDB/SMI 无法统计时为空 */
  formula: string
  /** PDB 格式 HETATM 残基名（三位 comp ID 候选，排除添加剂） */
  compId: string
  /** .smi 的 SMILES 串（其他格式为空） */
  smiles: string
}

/** Hill 顺序分子式：C → H → 其余字母序 */
export function hillFormula(counts: Map<string, number>): string {
  const rest = [...counts.entries()].filter(([e]) => e !== 'C' && e !== 'H')
    .sort((a, b) => a[0].localeCompare(b[0]))
  const ordered: Array<[string, number]> = []
  if (counts.has('C')) ordered.push(['C', counts.get('C')!])
  if (counts.has('H')) ordered.push(['H', counts.get('H')!])
  ordered.push(...rest)
  return ordered.map(([e, n]) => (n > 1 ? `${e}${n}` : e)).join('')
}

function isEmptyParsed(): LigandFileParsed {
  return { kind: 'unknown', name: '', formula: '', compId: '', smiles: '' }
}

/**
 * 解析配体文件文本。
 * - SDF（可多 molblock，取第一个）、MOL：首行为名称；counts 行后为原子块，
 *   元素符号在宽版定长格式中位于第 4 个空白分隔 token（绝大多数现代 SDF 通用）；
 *   分子式由元素计数得出（Hill 排序）。
 * - PDB：HETATM 残基名（非添加剂）为三位 ID 候选；TITLE 记录为名称。
 * - .smi（SMILES）：首 token 为 SMILES，其余为名称。
 */
export function parseLigandFileText(fileName: string, text: string): LigandFileParsed {
  const lower = fileName.toLowerCase()
  const trimmed = text.replace(/\r\n/g, '\n').trim()
  if (!trimmed) return isEmptyParsed()

  // .smi（SMILES 文件）或「疑似 SMILES 的 .txt」：首 token 为 SMILES、其余为名称
  if (lower.endsWith('.smi') || (lower.endsWith('.txt') && /^\s*[A-Za-z@[\]()=#$+\-./\\0-9]{5,}\s+\S/.test(trimmed) && !trimmed.includes('V2000'))) {
    const m = trimmed.split(/\s+/)
    const smiles = m[0] ?? ''
    const name = trimmed.slice(smiles.length).trim().split(/\r?\n/)[0]?.trim() ?? ''
    return { kind: 'smi', name: name.slice(0, 60), formula: formulaFromSmiles(smiles), compId: '', smiles: smiles.slice(0, 200) }
  }

  if (lower.endsWith('.pdb') || lower.endsWith('.ent') || /(^|\n)\s*(ATOM|HETATM)/.test(trimmed)) {
    // PDB 格式：HETATM 残基名（cols 18-20）；元素在 cols 77-78（缺失时由原子名推断）
    const counts = new Map<string, number>()
    let compId = ''
    let title = ''
    for (const line of trimmed.split('\n')) {
      if (/^TITLE\s/.test(line)) {
        if (!title) title = line.slice(10).replace(/\s+/g, ' ').trim()
        continue
      }
      if (!/^HETATM/.test(line)) continue
      const resname = (line.slice(17, 20) || '').trim().toUpperCase()
      if (resname && !LIGAND_JUNK_IDS.has(resname) && /^[A-Z0-9]{1,3}$/.test(resname) && !compId) compId = resname
      let el = (line.slice(76, 78) || '').trim().toUpperCase()
      if (!el) {
        const atomName = (line.slice(12, 16) || '').trim().toUpperCase()
        el = atomName.replace(/[^A-Z]/g, '')
        el = el.slice(0, 1) + el.slice(1, 2).toLowerCase() // 数字后缀去掉 → 取 1-2 位
        el = el.toUpperCase()
      }
      if (ELEMENTS.has(el)) counts.set(el, (counts.get(el) ?? 0) + 1)
    }
    return { kind: 'pdb', name: title.slice(0, 60), formula: counts.size ? hillFormula(counts) : '', compId, smiles: '' }
  }

  // SDF / MOL（V2000）：counts 行（"aaabbblllfff..."，第 4-6 位字符为原子数）后逐原子行
  const v2 = trimmed.indexOf('V2000')
  if (v2 >= 0 || lower.endsWith('.sdf') || lower.endsWith('.mol')) {
    const lines = trimmed.split('\n')
    const name = (lines[0] ?? '').trim().slice(0, 60)
    const countsLineIdx = lines.findIndex(l => l.includes('V2000'))
    if (countsLineIdx < 0) return { kind: 'sdf', name, formula: '', compId: '', smiles: '' }
    const countsLine = lines[countsLineIdx]
    // 原子数在 counts 行第 1-3 字符（右对齐 3 位）
    const natoms = parseInt(countsLine.slice(0, 3).trim(), 10)
    if (!Number.isFinite(natoms) || natoms <= 0 || natoms > 1000) return { kind: 'sdf', name, formula: '', compId: '', smiles: '' }
    const counts = new Map<string, number>()
    for (let i = countsLineIdx + 1; i < Math.min(lines.length, countsLineIdx + 1 + natoms); i++) {
      const t = (lines[i] ?? '').trim().split(/\s+/)
      // [x, y, z, element, ...]
      const el = (t[3] ?? '').replace(/[^A-Za-z]/g, '').toUpperCase()
      if (ELEMENTS.has(el)) counts.set(el, (counts.get(el) ?? 0) + 1)
    }
    return { kind: lower.endsWith('.mol') ? 'mol' : 'sdf', name, formula: counts.size ? hillFormula(counts) : '', compId: '', smiles: '' }
  }

  return isEmptyParsed()
}

/** 从 SMILES 近似统计分子式（有机子集 B/C/N/O/P/S/F/Cl/Br/I + 括号形式） */
export function formulaFromSmiles(smiles: string): string {
  const counts = new Map<string, number>()
  const re = /([A-Z][a-z]?)(\d*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(smiles))) {
    const el = m[1]
    if (!ELEMENTS.has(el)) continue
    // 跳过键符号/电荷标记误配（Cl/Br 等两字母元素优先匹配，此处元素表过滤兜底）
    const before = smiles[m.index - 1] ?? ''
    if (/[a-z]/.test(before) && !/^[A-Z][a-z]?$/.test(el)) continue
    const n = m[2] ? parseInt(m[2], 10) : 1
    counts.set(el, (counts.get(el) ?? 0) + n)
  }
  // 去掉可能混入的电荷/氢计数噪音：结果少于 2 种元素时不输出
  if (counts.size < 2) return ''
  return hillFormula(counts)
}

/** 文件解析结果 → 用户可读的芯片描述（输入面板芯片展示用） */
export function describeParsedLigandFile(p: LigandFileParsed): string {
  const parts: string[] = []
  if (p.compId) parts.push(`三位 ID ${p.compId}`)
  if (p.name) parts.push(`名称 ${p.name}`)
  if (p.formula) parts.push(`分子式 ${p.formula}`)
  return parts.join(' · ')
}
