/**
 * v1.11 ≥90% 高一致组（BLAST 委托）单元测试 — bun run scripts/test-blast-groups.ts
 * 覆盖：单组提取 / 传递连通（A-B 97、B-C 91、A-C 85 → 同组且 minIdentity=85）/
 *       低于阈值不分组 / 多组并存 / 空输入
 */
import { groupHighIdentity } from '../src/lib/eval/homology'
import type { HomologPair } from '../src/lib/eval/types'

let failed = 0
function check(name: string, cond: boolean, detail?: string) {
  console.log(`${cond ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failed++
}

function p(a: string, b: string, identity: number): HomologPair {
  return { a, b, identity, method: 'seed-diagonal' }
}

// ① 基本组：人/鼠 EGFR 97% → 一组；HER2 75% 不入组
{
  const pairs = [p('P00533', 'Q01279', 97), p('P00533', 'P04626', 75), p('Q01279', 'P04626', 74), p('P00533', 'P04637', 0)]
  const groups = groupHighIdentity(pairs, 'hgTEST')
  check('① 97% 对成组（1 组）', groups.length === 1, `got ${groups.length}`)
  check('① 组成员 = 人/鼠 EGFR', groups[0]?.members.join(',') === 'P00533,Q01279', groups[0]?.members.join(','))
  check('① minIdentity = 97', groups[0]?.minIdentity === 97, String(groups[0]?.minIdentity))
  check('① groupKey 带前缀', groups[0]?.groupKey.startsWith('hgTEST_') === true, groups[0]?.groupKey)
}

// ② 传递连通：A-B 97、B-C 91、A-C 85 → 同一组（连通判据 ≥90），minIdentity 诚实取 85
{
  const pairs = [p('A', 'B', 97), p('B', 'C', 91), p('A', 'C', 85)]
  const groups = groupHighIdentity(pairs, 'hgT2')
  check('② 传递连通成一组', groups.length === 1 && groups[0].members.join(',') === 'A,B,C', JSON.stringify(groups))
  check('② minIdentity = 85（全部两两最小值，非仅连通边）', groups[0]?.minIdentity === 85, String(groups[0]?.minIdentity))
}

// ③ 全部低于阈值 → 无组
{
  const pairs = [p('P00533', 'P04626', 75), p('P00533', 'Q01279', 89)]
  const groups = groupHighIdentity(pairs, 'hgT3')
  check('③ 89% 不入组（阈值 90）', groups.length === 0, `got ${groups.length}`)
}

// ④ 多组并存 + 边界值 90 恰好成组
{
  const pairs = [
    p('A1', 'A2', 95), p('B1', 'B2', 90), p('A1', 'B1', 30),
  ]
  const groups = groupHighIdentity(pairs, 'hgT4')
  check('④ 两组并存', groups.length === 2, `got ${groups.length}`)
  check('④ 90% 恰好达阈值', groups.some(g => g.minIdentity === 90), groups.map(g => g.minIdentity).join(','))
}

// ⑤ 空输入 / 单成员
{
  check('⑤ 空输入无组', groupHighIdentity([], 'hgT5').length === 0)
  check('⑤ 无强对无组', groupHighIdentity([p('A', 'B', 5)], 'hgT5').length === 0)
}

console.log(failed === 0 ? '\nALL PASSED' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
