/**
 * v2.82 fixture：EBI UniProt 库序列匹配命中展示渲染验证（身份级联 v2.44 通道）。
 * 场景：NCBI 全停（blastStatus failed、无 PDB 同源、无 nr 命中）→ EBI Swiss-Prot
 *       序列匹配回填身份（targetIdentity source uniprot-blast）— 用户实测「搜索了
 *       库但报告不显示检索结果」的典型态（此前 upHits 只用于身份处理从不展示）。
 * 断言：BLAST 章节渲染（uniBlastCount>0 即展示）/ UniProt 匹配面板 h3 标题与副标 /
 *       全量行数 / Swiss-Prot chips / UniProt 链接 / 排序属性 / 不参与 PDB-nr 切换。
 */
import * as fs from 'node:fs/promises'
import { renderReportHtml } from '../src/lib/eval/report-html'
import type { ReportContext } from '../src/lib/eval/report'
import type { BlastNrHit, PdbEntry, Scores, TargetIdentityInfo } from '../src/lib/eval/types'

const scores: Scores & { rationale: { xray: string; cryoem: string; nmr: string; overall: string } } = {
  xray: { score: 5, maxScore: 10, rating: '中等' },
  cryoem: { score: 4, maxScore: 10, rating: '中等' },
  nmr: { score: 5, maxScore: 10, rating: '可行' },
  overall: { score: 5, maxScore: 10, rating: '中等' },
  rationale: { xray: 'mock', cryoem: 'mock', nmr: 'mock', overall: 'mock' },
}
const ti: TargetIdentityInfo = {
  name: 'LAG-3 extracellular domain', source: 'uniprot-blast', sourceLabel: 'UniProt 匹配', identity: 98.7,
  uniprotId: 'P18627', uniprotEntry: 'LAG3_HUMAN', organism: 'Homo sapiens', geneName: 'LAG3',
  note: 'UniProt 序列匹配（一致性 98.7%）→ 已归属 UniProt P18627',
}
const uniHits: BlastNrHit[] = [
  { accession: 'P18627', entryName: 'LAG3_HUMAN', description: 'Lymphocyte activation gene 3 protein', organism: 'Homo sapiens', geneName: 'LAG3', identity: 98.7, evalue: 1e-87, evalueRaw: '1e-87', queryCoverage: 249, queryFrom: 1, queryTo: 249, hitFrom: 23, hitTo: 271, db: 'sp' },
  { accession: 'A0A8G0KJC2', entryName: 'LAG3_PONAB', description: 'Lymphocyte activation gene 3 protein-like', organism: 'Pongo abelii', geneName: 'LAG3', identity: 91.2, evalue: 4e-79, evalueRaw: '4e-79', queryCoverage: 249, queryFrom: 1, queryTo: 249, hitFrom: 23, hitTo: 271, db: 'sp' },
  { accession: 'F7DX19', entryName: 'LAG3_CALJA', description: 'Uncharacterized protein (Fragment)', organism: 'Callithrix jacchus', identity: 88.4, evalue: 2e-75, evalueRaw: '2e-75', queryCoverage: 230, queryFrom: 5, queryTo: 234, hitFrom: 27, hitTo: 256, db: 'tr' },
  { accession: 'XP_016868902.1', description: 'PREDICTED: lymphocyte activation gene 3-like isoform X2', organism: 'Macaca fascicularis', identity: 85.1, evalue: 8e-72, evalueRaw: '8e-72', queryCoverage: 249, queryFrom: 1, queryTo: 249, hitFrom: 23, hitTo: 271, db: 'other' },
]
const ctx: ReportContext = {
  uniprot: null,
  sequence: 'LQPGAEVPVVWAQEGAPAQLPCSPTIPLQDLSLLRRAGVTWQHQPDSGPPAAAPGHPLAPGPHPAAPSSWGPRPRRY',
  sequenceHeader: 'uniblast-fixture 构建样本',
  goal: '验证 UniProt 库序列匹配命中展示（v2.82）',
  goalHints: [],
  targetIdentity: ti,
  directPdbs: [] as PdbEntry[],
  blastHits: [],
  blastStatus: { status: 'failed', note: 'NCBI pdbaa 提交失败；RCSB 兜底亦失败' },
  uniprotBlastHits: uniHits,
  coverage: null,
  coverageText: '',
  gapText: '',
  literature: [],
  images: [],
  scores,
}

function assert(cond: boolean, msg: string): void {
  if (!cond) { console.error('ASSERT FAIL:', msg); process.exitCode = 1 }
  else console.log('ok -', msg)
}

async function main() {
  const html = await renderReportHtml({
    ctx,
    methodStats: { xrayCount: 0, cryoemCount: 0, nmrCount: 0, bestResolution: null },
    llmMarkdown: '## 执行摘要\n**UniProt 库序列匹配命中块渲染样例（v2.82）。**',
    llmOk: true, llmErrors: [], jobId: 'sample_uniblast', durationMs: 42000, totalPdbFound: 0,
    engineSummary: 'sample-engine', resolveImagePath: () => '',
  })
  await fs.mkdir('/tmp/render', { recursive: true })
  await fs.writeFile('/tmp/render/uniblast-report.html', html, 'utf-8')
  console.log('written /tmp/render/uniblast-report.html', html.length)

  assert(html.includes('Homologs · 0 · UniProt 匹配 4'), '章节头计数含「UniProt 匹配 4」')
  assert(html.includes('UniProt 库序列匹配'), '面板 h3 标题渲染')
  assert(html.includes('EBI BLAST · Swiss-Prot · 4 hits · 靶点身份识别'), '面板副标（来源 + 计数）')
  assert((html.match(/data-tbl="uniblast"/g) ?? []).length === 1, 'uniblast 表恰好一张')
  const tblAt = html.indexOf('data-tbl="uniblast"')
  const tbl = html.slice(tblAt, html.indexOf('</table>', tblAt))
  assert((tbl.match(/<tr /g) ?? []).length === 4, '表数据行 = 4（全量直出）')
  assert(tbl.includes('href="https://www.uniprot.org/uniprotkb/P18627"'), 'sp 命中 UniProt 链接')
  assert(tbl.includes('LAG3_HUMAN'), 'entryName 副行')
  assert(tbl.includes('Swiss-Prot</span>'), 'Swiss-Prot chip')
  assert(tbl.includes('TrEMBL</span>'), 'TrEMBL chip')
  assert(tbl.includes('data-ident="98.7"'), '行携带排序属性 data-ident')
  assert(!html.includes('class="lib-toggle"'), '无 PDB/nr 切换按钮（UniProt 面板独立展示、始终可见）')
  // data-libpanel 仅应出现在注入的切换 JS 里（属性形态 data-libpanel=" 为 0 —
  // uniblast 面板不挂切换容器，始终可见）
  assert(!html.includes('data-libpanel="'), '面板不挂 libpanel 属性（不参与切换隐藏）')
  assert(html.includes('已自动改查 EBI BLAST'), '说明文案（检索路径证据链）')
  // 题目「UniProt 匹配 98.7%」标注（v2.44 既有行为不回归）
  assert(html.includes('UniProt 匹配 99%') || html.includes('UniProt 匹配 98.7%') || html.includes('UniProt 匹配'), '题目/刊头同源度标注保留')
}

void main()
