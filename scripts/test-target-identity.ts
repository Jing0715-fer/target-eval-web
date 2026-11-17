/**
 * v2.16 序列靶点身份识别 — 单元验证脚本（无网络，纯函数）：
 *  1. parseNrDefline / parseBlastNrXml：nr defline 解析（sp|ACC|ENTRY + OS/GN 字段）
 *  2. uniprotFromSequenceHeader：FASTA 头 / 评估表标签的 UniProt accession 提取
 *  3. cleanHomologDescription：PDB 同源描述清洗（Chain A, 前缀等）
 *  4. buildEvalTableIdentity / 标题格式（targetIdentityTitleSuffix）
 *  5. 防御：伪造/畸形输入不崩溃
 */
import { parseBlastNrXml, parseNrDefline } from '../src/lib/eval/blast'
import { cleanHomologDescription, uniprotFromSequenceHeader } from '../src/lib/eval/pipeline'
import { describeTargetIdentitySource, targetIdentityTitleSuffix, type TargetIdentityInfo } from '../src/lib/eval/types'

let pass = 0
let fail = 0
function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.error(`  ✗ ${name}\n      actual   = ${a}\n      expected = ${b}`) }
}

// ─── 1. nr defline 解析 ───────────────────────────────────────────────────
console.log('【parseNrDefline】')
const d1 = parseNrDefline('sp|P04637|P53_HUMAN Tumor suppressor p53 OS=Homo sapiens OX=9606 GN=TP53 PE=1 SV=4')
eq('SwissProt accession', d1.accession, 'P04637')
eq('SwissProt entry', d1.entryName, 'P53_HUMAN')
eq('organism', d1.organism, 'Homo sapiens')
eq('geneName', d1.geneName, 'TP53')
eq('description（OS/GN 等字段剥离）', d1.description, 'Tumor suppressor p53')
eq('db', d1.db, 'sp')

const d2 = parseNrDefline('tr|A0A8G0KJC2|A0A8G0KJC2_HUMAN Uncharacterized protein OS=Homo sapiens OX=9606 GN=TP53-AS1 PE=4 SV=1')
eq('TrEMBL accession', d2.accession, 'A0A8G0KJC2')
eq('TrEMBL db', d2.db, 'tr')

const d3 = parseNrDefline('Chain A, human epidermal growth factor receptor')
eq('非 UniProt 形态 db=other', d3.db, 'other')
eq('非 UniProt 形态 accession 为空（调用方取 Hit_accession）', d3.accession, '')

// ─── 2. nr XML 解析 ───────────────────────────────────────────────────────
console.log('【parseBlastNrXml】')
const xml = `<?xml version="1.0"?>
<!DOCTYPE BlastOutput>
<BlastOutput>
  <BlastOutput_iterations>
    <Iteration>
      <Iteration_hits>
        <Hit>
          <Hit_num>1</Hit_num>
          <Hit_id>gi|57163773|ref|NP_000539.1|</Hit_id>
          <Hit_def>sp|P00533|EGFR_HUMAN Epidermal growth factor receptor OS=Homo sapiens OX=9606 GN=EGFR PE=1 SV=4</Hit_def>
          <Hit_accession>P00533</Hit_accession>
          <Hit_len>1210</Hit_len>
          <Hit_hsps>
            <Hsp>
              <Hsp_num>1</Hsp_num>
              <Hsp_bit-score>1456</Hsp_bit-score>
              <Hsp_score>3</Hsp_score>
              <Hsp_evalue>0.0</Hsp_evalue>
              <Hsp_query-from>1</Hsp_query-from>
              <Hsp_query-to>980</Hsp_query-to>
              <Hsp_hit-from>1</Hsp_hit-from>
              <Hsp_hit-to>980</Hsp_hit-to>
              <Hsp_identity>970</Hsp_identity>
              <Hsp_positive>980</Hsp_positive>
              <Hsp_gaps>0</Hsp_gaps>
              <Hsp_align-len>980</Hsp_align-len>
            </Hsp>
          </Hit_hsps>
        </Hit>
        <Hit>
          <Hit_num>2</Hit_num>
          <Hit_def>sp|P04637|P53_HUMAN Tumor suppressor p53 OS=Homo sapiens OX=9606 GN=TP53 PE=1 SV=4</Hit_def>
          <Hit_accession>P04637</Hit_accession>
          <Hit_len>393</Hit_len>
          <Hit_hsps>
            <Hsp>
              <Hsp_num>1</Hsp_num>
              <Hsp_evalue>1e-45</Hsp_evalue>
              <Hsp_query-from>10</Hsp_query-from>
              <Hsp_query-to>100</Hsp_query-to>
              <Hsp_identity>55</Hsp_identity>
              <Hsp_align-len>100</Hsp_align-len>
            </Hsp>
          </Hit_hsps>
        </Hit>
        <Hit>
          <Hit_num>3</Hit_num>
          <Hit_def>gb|AAA12345| unnamed protein product</Hit_def>
          <Hit_accession>AAA12345</Hit_accession>
          <Hit_len>200</Hit_len>
          <Hit_hsps>
            <Hsp>
              <Hsp_evalue>3e-20</Hsp_evalue>
              <Hsp_query-from>5</Hsp_query-from>
              <Hsp_query-to>60</Hsp_query-to>
              <Hsp_identity>40</Hsp_identity>
              <Hsp_align-len>56</Hsp_align-len>
            </Hsp>
          </Hit_hsps>
        </Hit>
      </Iteration_hits>
    </Iteration>
  </BlastOutput_iterations>
</BlastOutput>`
const hits = parseBlastNrXml(xml)
eq('命中数', hits.length, 3)
eq('首位 SwissProt 命中 accession', hits[0].accession, 'P00533')
eq('首位 identity（970/980）', hits[0].identity, 99)
eq('首位 queryCoverage', hits[0].queryCoverage, 980)
eq('首位 entryName', hits[0].entryName, 'EGFR_HUMAN')
eq('首位 description', hits[0].description, 'Epidermal growth factor receptor')
eq('gb| 形态 db=other', hits[2].db, 'other')
eq('gb| 形态 accession 取 Hit_accession', hits[2].accession, 'AAA12345')
eq('空 XML → 空数组', parseBlastNrXml('<?xml version="1.0"?>\nStatus=SEARCHING').length, 0)

// ─── 3. 序列标签头 UniProt 提取 ───────────────────────────────────────────
console.log('【uniprotFromSequenceHeader】')
eq('sp|P00533|EGFR_HUMAN', uniprotFromSequenceHeader('sp|P00533|EGFR_HUMAN'), 'P00533')
eq('tr 形态', uniprotFromSequenceHeader('tr|A0A8G0KJC2|A0A8G0KJC2_HUMAN'), 'A0A8G0KJC2')
eq('裸 accession（短头）', uniprotFromSequenceHeader('P00533'), 'P00533')
eq('裸 accession _HUMAN 后缀', uniprotFromSequenceHeader('P04637_HUMAN'), 'P04637')
eq('长句不误判', uniprotFromSequenceHeader('Human epidermal growth factor receptor kinase domain construct 1-646 with GST tag'), null)
eq('构建标签（非 accession）', uniprotFromSequenceHeader('EBOV GPΔMuc 33-308;490-656 -GCN 4 -His-SA'), null)
eq('空', uniprotFromSequenceHeader(''), null)

// ─── 4. PDB 同源描述清洗 ──────────────────────────────────────────────────
console.log('【cleanHomologDescription】')
eq('Chain A, 前缀剥离', cleanHomologDescription('Chain A, Human epidermal growth factor receptor'), 'Human epidermal growth factor receptor')
eq('多链前缀', cleanHomologDescription('Chain A/B, Human serum albumin'), 'Human serum albumin')
eq('链段截取', cleanHomologDescription('Chain A, Hemoglobin alpha | Chain B, Hemoglobin beta'), 'Hemoglobin alpha')
eq('apo 尾巴清理', cleanHomologDescription('Chain A, Insulin receptor apo form'), 'Insulin receptor')
eq('超长截断（≤90）', cleanHomologDescription('Chain A, ' + 'x'.repeat(120)).length <= 90, true)

// ─── 5. 标题格式 ──────────────────────────────────────────────────────────
console.log('【targetIdentityTitleSuffix / describeTargetIdentitySource】')
const tEval: TargetIdentityInfo = { name: '表皮生长因子受体', source: 'eval-table', sourceLabel: '评估表' }
const tNr: TargetIdentityInfo = { name: 'Tumor suppressor p53', source: 'blast-nr', sourceLabel: 'BLAST nr 识别', identity: 98.4 }
const tHom: TargetIdentityInfo = { name: 'Human EGFR kinase domain', source: 'blast-homolog', sourceLabel: 'PDB 同源推断', identity: 45.2 }
eq('评估表来源无后缀', targetIdentityTitleSuffix(tEval), '')
eq('nr 识别后缀（四舍五入）', targetIdentityTitleSuffix(tNr), ' · nr 识别 98%')
eq('同源推断后缀', targetIdentityTitleSuffix(tHom), ' · 同源 45%')
eq('来源标签', describeTargetIdentitySource('eval-table'), '评估表')
eq('来源标签 nr', describeTargetIdentitySource('blast-nr'), 'BLAST nr 识别')
eq('来源标签 homolog', describeTargetIdentitySource('blast-homolog'), 'PDB 同源推断')

// 标题组装（与 report-html 同构逻辑）
const titleOf = (ti: TargetIdentityInfo | undefined, rangeSuffix = ''): string =>
  ti ? `${ti.name}（序列靶点${targetIdentityTitleSuffix(ti)}${rangeSuffix}）` : '序列靶点评估'
eq('题目：评估表', titleOf(tEval), '表皮生长因子受体（序列靶点）')
eq('题目：nr 识别', titleOf(tNr), 'Tumor suppressor p53（序列靶点 · nr 识别 98%）')
eq('题目：同源推断 + 区间', titleOf(tHom, ' · 残基 33-308'), 'Human EGFR kinase domain（序列靶点 · 同源 45% · 残基 33-308）')
eq('题目：无身份回退', titleOf(undefined), '序列靶点评估')

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
