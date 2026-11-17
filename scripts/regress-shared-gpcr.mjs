#!/usr/bin/env node
/**
 * regress-shared-gpcr.mjs — v2.26 两大修复的回归。
 *
 * A. 共有结构全量交集事实链（在线 RCSB 实测 — 复现用户 CCR8+Gαi1+Gβ1 批次）：
 *    A1 P62873（GNB1）条目总数 > 1000（500 截断必然丢失高位条目的事实前提）
 *    A2 500 行截断（旧 fetchPdbIdsForUniprot 口径）不含 8KFX（CCR8-Gi 复合物，
 *        实测排位 ~765）→ 3 靶点旧口径交集为空（根因复现）
 *    A3 全量分页（1000 行×页）3 靶点交集含 8KFX/8KFY/8KFZ（CCR8-Gi 系列复合物）
 *    A4 8KFX 实体注记权威校验：entity 覆盖 P51685/P63096/P62873（GraphQL uniprot_ids）
 *
 * B. GPCR 受体主导批次判定算法（与 src/lib/eval/report-merged.ts 同语义 JS 复刻 —
 *    TS 实现由 tsc/E2E 覆盖，此处验证算法语义与映射表）：
 *    B1 G 蛋白组分判定：GNA、GNB、GNG 前缀基因名精确匹配 + 蛋白名特征词
 *    B2 偶联类型归类：GNAI1/GNAO→Gi/o、GNAS→Gs、GNAQ→Gq/11、GNA12→G12/13、仅 Gβγ
 *    B3 批次形态：恰 1 个非 G 蛋白 + ≥1 G 蛋白 → 受体主导；2 个非 G 蛋白 → null
 *
 * 运行：node scripts/regress-shared-gpcr.mjs（依赖外网 RCSB；B 组纯本地）
 */
const SEARCH_URL = 'https://search.rcsb.org/rcsbsearch/v2/query'
const GRAPHQL_URL = 'https://data.rcsb.org/graphql'

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// ─── A. RCSB 全量交集事实链（在线）────────────────────────────────────────────
console.log('── A. 共有结构全量交集事实链（在线 RCSB）──')

/** 与 rcsb.ts requestPdbIdPage 同口径的 entry 级检索（按 release_date desc） */
async function searchPage(acc, start, rows) {
  const body = {
    query: {
      type: 'terminal', service: 'text',
      parameters: {
        attribute: 'rcsb_polymer_entity_container_identifiers.reference_sequence_identifiers.database_accession',
        operator: 'exact_match', value: acc,
      },
    },
    return_type: 'entry',
    request_options: {
      paginate: { start, rows },
      sort: [{ sort_by: 'rcsb_accession_info.initial_release_date', direction: 'desc' }],
    },
  }
  const res = await fetch(SEARCH_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const d = await res.json()
  return { total: d.total_count ?? 0, ids: (d.result_set ?? []).map(r => (r.identifier ?? '').toUpperCase()) }
}

/** 与 fetchAllPdbIdsForUniprot 同口径：分页拉全量（每页 1000，硬上限 3000） */
async function fetchAllIds(acc) {
  const out = []
  for (let start = 0; start < 3000; start += 1000) {
    const page = await searchPage(acc, start, 1000)
    if (!page.ids.length) break
    out.push(...page.ids)
    if (page.ids.length < 1000) break
  }
  return [...new Set(out)]
}

try {
  const ACCS = ['P51685', 'P63096', 'P62873']
  const gnbFirst = await searchPage('P62873', 0, 500) // 旧口径：max=500 截断
  ok('A1 GNB1（P62873）条目总数 > 1000（500 截断必然丢高位条目）',
    gnbFirst.total > 1000, `total=${gnbFirst.total}`)

  // 旧口径（各 ≤500 截断）3 靶点交集 — 根因复现（无 8KFX）
  const oldCap = new Set(gnbFirst.ids)
  const oldGai = new Set((await searchPage('P63096', 0, 500)).ids)
  const oldCcr8 = new Set((await searchPage('P51685', 0, 500)).ids)
  const oldInter = [...oldCcr8].filter(id => oldGai.has(id) && oldCap.has(id))
  ok('A2 旧 500 截断口径：3 靶点交集不含 8KFX（共有结构漏检根因复现）',
    !oldInter.includes('8KFX'), `oldInter=[${oldInter.join(',')}]`)

  // 全量口径交集
  const [ccr8All, gaiAll, gnbAll] = await Promise.all(ACCS.map(fetchAllIds))
  const gaiSet = new Set(gaiAll)
  const gnbSet = new Set(gnbAll)
  const fullInter = ccr8All.filter(id => gaiSet.has(id) && gnbSet.has(id))
  ok('A3 全量分页口径：交集含 CCR8-Gi 系列复合物 8KFX/8KFY/8KFZ',
    ['8KFX', '8KFY', '8KFZ'].every(id => fullInter.includes(id)),
    `fullInter=[${fullInter.join(',')}] ccr8=${ccr8All.length} gai=${gaiAll.length} gnb=${gnbAll.length}`)

  // 8KFX 实体 UniProt 注记权威校验（augment 的 uniprotAccs 归属依据）
  const gql = `query($ids:[String!]!){ entries(entry_ids:$ids){
    rcsb_id
    polymer_entities { rcsb_polymer_entity_container_identifiers { uniprot_ids } }
  } }`
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: gql, variables: { ids: ['8KFX'] } }),
    signal: AbortSignal.timeout(20_000),
  })
  const data = await res.json()
  const accs8kfx = new Set()
  for (const e of data?.data?.entries ?? []) {
    for (const pe of e.polymer_entities ?? []) {
      for (const a of pe.rcsb_polymer_entity_container_identifiers?.uniprot_ids ?? []) accs8kfx.add(String(a).toUpperCase())
    }
  }
  ok('A4 8KFX 实体 UniProt 注记覆盖全部 3 靶点（augment 归属权威校验）',
    ['P51685', 'P63096', 'P62873'].every(a => accs8kfx.has(a)),
    `8KFX uniprots=[${[...accs8kfx].slice(0, 12).join(',')}]`)
} catch (err) {
  ok('A 组网络请求可达（RCSB search/data API）', false, String(err?.message ?? err))
}

// ─── B. GPCR 受体主导批次判定（算法语义 — 与 TS 实现同语义复刻）────────────────
console.log('── B. GPCR 受体主导批次判定（算法语义）──')

const G_PROTEIN_GENE_RE = /^(GNAS|GNAL|GNAI[1-3]?|GNAO|GNAT[1-3]?|GNAQ|GNA11|GNA12|GNA13|GNAZ|GNA15|GNB[1-5]|GNG[1-9]|GNG1[0-2])$/i
const isGProteinComponent = (t) => {
  const genes = (t.geneNames ?? []).map(g => g.trim()).filter(Boolean)
  if (genes.some(g => G_PROTEIN_GENE_RE.test(g))) return true
  const name = (t.proteinName ?? '').toLowerCase()
  return name.includes('guanine nucleotide-binding protein')
    || (/\bg protein\b/.test(name) && /subunit|alpha|beta|gamma/.test(name))
}
const gCouplingLabel = (gproteins) => {
  const genes = gproteins.flatMap(t => (t.geneNames ?? []).map(g => g.trim().toUpperCase()).filter(g => G_PROTEIN_GENE_RE.test(g)))
  if (!genes.length) return 'G 蛋白伴侣'
  const types = new Set()
  // display 与 TS gGeneDisplay 同语义
  const disp = genes.map(g => g.startsWith('GNA') ? `Gα${g.slice(3).toLowerCase()}` : g.startsWith('GNB') ? `Gβ${g.slice(3)}` : g.startsWith('GNG') ? `Gγ${g.slice(3)}` : g)
  for (const g of genes) {
    if (/^GNAS$|^GNAL$/.test(g)) types.add('Gs')
    else if (/^GNAI[1-3]?$|^GNAO$|^GNAZ$|^GNAT[1-3]?$/.test(g)) types.add('Gi/o')
    else if (/^GNAQ$|^GNA11$/.test(g)) types.add('Gq/11')
    else if (/^GNA12$|^GNA13$/.test(g)) types.add('G12/13')
  }
  const typeStr = types.size ? [...types].join('/') : 'Gβγ'
  return `${typeStr} 型（${disp.slice(0, 4).join(' · ')}${disp.length > 4 ? ' …' : ''}）`
}
const detectBatch = (targets) => {
  if (targets.length < 2) return null
  const gproteins = targets.filter(t => isGProteinComponent(t))
  const others = targets.filter(t => !isGProteinComponent(t))
  if (gproteins.length < 1 || others.length !== 1) return null
  return { receptor: others[0], gproteins, couplingLabel: gCouplingLabel(gproteins) }
}

{
  const T = (geneNames, proteinName) => ({ geneNames, proteinName })
  ok('B1 G 蛋白组分判定：GNA*/GNB*/GNG* 基因精确匹配 + 蛋白名特征词',
    isGProteinComponent(T(['GNAI1'], '')) && isGProteinComponent(T(['GNB1'], '')) &&
      isGProteinComponent(T(['GNG2'], '')) && isGProteinComponent(T(['GNAS'], '')) &&
      isGProteinComponent(T([], 'Guanine nucleotide-binding protein G(i) subunit alpha-1')) &&
      !isGProteinComponent(T(['CCR8'], 'C-C chemokine receptor type 8')) &&
      !isGProteinComponent(T(['EGFR'], 'Epidermal growth factor receptor')) &&
      !isGProteinComponent(T(['GNB'], '')) && !isGProteinComponent(T(['GNG13X'], '')))
}
{
  const T = (g) => ({ geneNames: g, proteinName: '' })
  ok('B2 偶联类型归类：GNAI1+GNB1 → Gi/o 型；GNAS → Gs 型；GNAQ → Gq/11 型；GNA12 → G12/13 型；仅 Gβγ → Gβγ 型',
    gCouplingLabel([T(['GNAI1']), T(['GNB1'])]).startsWith('Gi/o 型（Gαi1 · Gβ1') &&
      gCouplingLabel([T(['GNAS'])]).startsWith('Gs 型（Gαs') &&
      gCouplingLabel([T(['GNAQ'])]).startsWith('Gq/11 型（Gαq') &&
      gCouplingLabel([T(['GNA12'])]).startsWith('G12/13 型（Gα12') &&
      gCouplingLabel([T(['GNB1']), T(['GNG2'])]).startsWith('Gβγ 型（Gβ1 · Gγ2'))
}
{
  const ccr8 = { geneNames: ['CCR8'], proteinName: 'C-C chemokine receptor type 8', uniprotId: 'P51685' }
  const gai = { geneNames: ['GNAI1'], proteinName: 'G(i) alpha', uniprotId: 'P63096' }
  const gnb = { geneNames: ['GNB1'], proteinName: 'G beta', uniprotId: 'P62873' }
  const egfr = { geneNames: ['EGFR'], proteinName: 'Epidermal growth factor receptor', uniprotId: 'P00533' }
  const b1 = detectBatch([ccr8, gnb, gai])
  ok('B3a 批次形态：CCR8+Gβ1+Gαi1 → 受体主导（receptor=CCR8 · Gi/o 型伴侣）',
    b1?.receptor === ccr8 && b1.gproteins.length === 2 && b1.couplingLabel.startsWith('Gi/o 型'),
    JSON.stringify(b1?.couplingLabel))
  ok('B3b 批次形态：2 个非 G 蛋白靶点（CCR8+EGFR+Gβ1）→ 不启用受体主导',
    detectBatch([ccr8, egfr, gnb]) === null)
  ok('B3c 批次形态：纯 G 蛋白组合（无受体）→ null',
    detectBatch([gai, gnb]) === null)
  ok('B3d 批次形态：受体 + 4 个 G 蛋白组分（Gs+Gi 混合）→ 受体主导，类型 / 连接',
    detectBatch([ccr8, { geneNames: ['GNAS'], proteinName: 'Gs alpha' }, gai, gnb, { geneNames: ['GNG2'], proteinName: 'G gamma' }]) !== null)
}

console.log(`\n${pass} 通过 · ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
