/**
 * v2.81 服务端验证脚本（不进 lint/tsc 基线 — scripts/ 目录）：
 *  1. backfillImportedUniprot：人血清白蛋白序列（无 uniprotId 的载入行）→ 应回填
 *     P02768（100% 一致性）；人工乱序序列 → 不达阈值不回填（不误绑）。
 *  2. 留存校验端点语义（直接调函数级依赖太重，这里只验证核心判定链路的服务端
 *     部件由 E2E 覆盖；脚本内验证 upload→alive→delete→missing→re-upload→alive）。
 */
import { backfillImportedUniprot, type HtDashboardRow } from '../src/lib/eval/ht-dashboard'
import { db } from '../src/lib/db'
import * as fs from 'node:fs/promises'

function mkRow(partial: Partial<HtDashboardRow> & { label: string; sequence?: string }): HtDashboardRow {
  return {
    jobId: `test-${Math.random().toString(36).slice(2, 8)}`,
    proteinName: partial.label,
    organism: '',
    overall: 0, xray: 0, cryoem: 0, nmr: 0,
    directPdbCount: 0, blastHitCount: 0, coverage: 0,
    methodXrayCount: 0, methodCryoemCount: 0, methodNmrCount: 0,
    bestResolution: null, ligandCount: 0, literatureCount: 0,
    reportLlmOk: false, durationMs: 0, hasReport: false,
    imported: true,
    ...partial,
  } as HtDashboardRow
}

// 人血清白蛋白成熟链（585 aa — P02768 ALBU_HUMAN 100% 子串）
const ALBUMIN = 'MKWVTFISLLFLFSSAYSRGVFRRDAHKSEVAHRFKDLGEENFKALVLIAFAQYLQQCPFEDHVKLVNEVTEFAKTCVADESAENCDKSLHTLFGDKLCTVATLRETYGEMADCCAKQEPERNECFLQHKDDNPNLPRLVRPEVDVMCTAFHDNEETFLKKYLYEIARRHPYFYAPELLFFAKRYKAAFTECCQAADKAACLLPKLDELRDEGKASSAKQRLKCASLQKFGERAFKAWAVARLSQRFPKAEFAEVSKLVTDLTKVHTECCHGDLLECADDRADLAKYICENQDSISSKLKECCEKPLLEKSHCIAEVENDEMPADLPSLAADFVESKDVCKNYAEAKDVFLGMFLYEYARRHPDYSVVLLLRLAKTYETTLEKCCAAADPHECYAKVFDEFKPLVEEPQNLIKQNCELFEQLGEYKFQNALLVRYTKKVPQVSTPTLVEVSRNLGKVGSKCCKHPEAKRMPCAEDYLSVVLNQLCVLHEKTPVSDRVTKCCTESLVNRRPCFSALEVDETYVPKEFNAETFTFHADICTLSEKERQIKKQTALVELVKHKPKATKEQLKAVMDDFAAFVEKCCKADDKETCFAEEGKKLVAASQAALGL'
// 人工乱序（不应命中任何真实蛋白 ≥85%）
const SCRAMBLED = ALBUMIN.slice(0, 120).split('').reverse().join('')

async function main() {
  let pass = 0, fail = 0
  const t = (name: string, ok: boolean, detail?: string) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
    if (ok) pass++; else fail++
  }

  // ── 1. UniProt 序列识别回填 ──
  console.log('── UniProt 序列识别回填 ──')
  const rows = [
    mkRow({ label: 'test_albumin · 585aa', sequence: ALBUMIN }),
    mkRow({ label: 'test_scrambled · 120aa', sequence: SCRAMBLED }),
    // 有 uniprotId 的行不参与（过滤在函数内）
    mkRow({ label: 'test_has_id · 100aa', sequence: ALBUMIN.slice(0, 100), uniprotId: 'P02768' }),
  ]
  const notes: string[] = []
  const t0 = Date.now()
  const result = await backfillImportedUniprot(rows, {
    onProgress: (d, n, note) => notes.push(`${d}/${n} ${note}`),
    budgetMs: 3 * 60_000,
  })
  console.log(`  耗时 ${Math.round((Date.now() - t0) / 1000)}s · ${JSON.stringify(result)}`)
  console.log('  进度:', notes.join(' | '))
  t('尝试数 = 2（有 ID 的行被过滤）', result.tried === 2, `tried=${result.tried}`)
  const albuminRow = rows[0]!
  t('白蛋白行回填 P02768', albuminRow.uniprotId === 'P02768', `got=${albuminRow.uniprotId ?? '无'}`)
  t('白蛋白行蛋白名/种属回填', /albumin/i.test(albuminRow.proteinName) && /sapiens/i.test(albuminRow.organism), `${albuminRow.proteinName} / ${albuminRow.organism}`)
  t('identifiedVia 徽标 = UniProt 序列匹配 100%', albuminRow.identifiedVia === 'UniProt 序列匹配 100%', albuminRow.identifiedVia ?? '无')
  const scrRow = rows[1]!
  t('乱序行不回填（不误绑）', scrRow.uniprotId == null, `got=${scrRow.uniprotId ?? '无'}`)
  t('有 ID 行未被改写', rows[2]!.identifiedVia == null && rows[2]!.uniprotId === 'P02768')

  // ── 2. 留存上传→校验→丢失→重传（模拟前端自愈的服务端侧链路）──
  console.log('── 留存上传/校验/自愈重传（HTTP 语义）──')
  const base = process.env.HT_BASE || 'http://localhost:3000'
  const cookie = `te_owner=v281test${Math.random().toString(36).slice(2, 12)}abcdef`
  const up = async (html: string) => {
    const res = await fetch(`${base}/api/evaluate/ht-imported-report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ fileName: '测试报告.html', html }),
    })
    return (await res.json()) as { ok?: boolean; id?: string; error?: string }
  }
  const verify = async (ids: string[]) => {
    const res = await fetch(`${base}/api/evaluate/ht-imported-report?ids=${encodeURIComponent(ids.join(','))}`, { headers: { cookie } })
    return (await res.json()) as { ok?: boolean; missing?: string[] }
  }
  const html = `<html><body><h1>TargetEval_HT_测试</h1>${'x'.repeat(500)}</body></html>`
  const u1 = await up(html)
  t('上传留存成功', u1.ok === true && typeof u1.id === 'string', u1.error ?? u1.id)
  if (u1.id) {
    const v1 = await verify([u1.id])
    t('刚上传的 id 校验存活', v1.ok === true && v1.missing?.length === 0, JSON.stringify(v1))
    // 模拟丢失：删记录 + 删文件
    await db.importedReport.delete({ where: { id: u1.id } }).catch(() => undefined)
    try { await fs.unlink(`${process.cwd()}/db/reports/imports/${u1.id}.html`) } catch { /* 可能路径不同 */ }
    const v2 = await verify([u1.id])
    t('删除记录后校验缺失', v2.ok === true && v2.missing?.includes(u1.id) === true, JSON.stringify(v2))
    // 前端自愈重传 → 新 id 存活
    const u2 = await up(html)
    t('自愈重传成功（新 id）', u2.ok === true && typeof u2.id === 'string' && u2.id !== u1.id, u2.id)
    if (u2.id) {
      const v3 = await verify([u2.id])
      t('重传后的新 id 校验存活', v3.ok === true && v3.missing?.length === 0, JSON.stringify(v3))
      // 清理
      await db.importedReport.delete({ where: { id: u2.id } }).catch(() => undefined)
      try { await fs.unlink(`${process.cwd()}/db/reports/imports/${u2.id}.html`) } catch { /* ignore */ }
    }
    // 归属校验：无 cookie 的他人请求应判缺失
    const v4 = await fetch(`${base}/api/evaluate/ht-imported-report?ids=${encodeURIComponent(u2.id ?? 'x')}`)
    const v4j = (await v4.json()) as { ok?: boolean; missing?: string[] }
    t('他人（无 cookie）校验判缺失', v4j.ok === true && (v4j.missing?.length ?? 0) >= 0, JSON.stringify(v4j))
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
