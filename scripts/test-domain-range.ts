/**
 * v2.29 冒烟测试：结构域名提示 → UniProt domain 匹配（matchDomainHint 单元断言）。
 *
 * 覆盖：
 *  1. 别名类（胞外域/ECD/ectodomain → Extracellular 拓扑域取最长段；胞内域 → Cytoplasmic；
 *     跨膜区/TM → Transmembrane 并集；激酶域/kinase → Domain 含 kinase 最长段）
 *  2. 通用 token（SH2 → "SH2 domain" 注释；死亡 → 死亡结构域英译 death）
 *  3. 守卫：跨度 <10 aa 不采用；无命中 → null；空/短 token → null
 *  4. construct-range scanDomainMentions（中文剥后缀 token / 英文 X domain 前缀词）
 * 运行：npx -y tsx scripts/test-domain-range.ts
 */
import { matchDomainHint } from '../src/lib/eval/domain-range'
import { scanDomainMentions } from '../src/lib/eval/construct-range'
import type { UniprotFeature } from '../src/lib/eval/types'

function feat(type: string, description: string, begin: number, end: number): UniprotFeature {
  return { type, description, begin, end }
}

// EGFR P00533 的近似 feature 划分（真实条目口径：Extracellular 1-621 / Protein kinase 712-979）
const EGFR_FEATURES: UniprotFeature[] = [
  feat('Topological domain', 'Extracellular', 1, 621),
  feat('Transmembrane', 'TM helix 1', 646, 668),
  feat('Transmembrane', 'TM helix 2', 679, 701),
  feat('Topological domain', 'Cytoplasmic', 702, 710),
  feat('Domain', 'Protein kinase', 712, 979),
  feat('Domain', 'SH2', 1000, 1010),
]

let pass = 0
let fail = 0
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// ── 1. 别名类匹配 ──
const ecd = matchDomainHint('胞外', EGFR_FEATURES, 1210)
ok('胞外(裸词) → Extracellular 1-621', ecd?.range[0] === 1 && ecd?.range[1] === 621, JSON.stringify(ecd?.range))
const ecdFull = matchDomainHint('胞外域', EGFR_FEATURES, 1210)
ok('胞外域(全词) → 同上', ecdFull?.range[0] === 1 && ecdFull?.range[1] === 621)
const ecdEn = matchDomainHint('ECD', EGFR_FEATURES, 1210)
ok('ECD → Extracellular', ecdEn?.range[0] === 1 && ecdEn?.range[1] === 621)
const ecdEcto = matchDomainHint('ectodomain', EGFR_FEATURES, 1210)
ok('ectodomain → Extracellular', ecdEcto?.range[0] === 1)
const icd = matchDomainHint('胞内', EGFR_FEATURES, 1210)
ok('胞内(裸词) → Cytoplasmic 702-710', icd?.range[0] === 702 && icd?.range[1] === 710, JSON.stringify(icd?.range))
const tm = matchDomainHint('跨膜', EGFR_FEATURES, 1210)
ok('跨膜(裸词) → TM 并集 646-701', tm?.range[0] === 646 && tm?.range[1] === 701, JSON.stringify(tm?.range))
const tmEn = matchDomainHint('TM', EGFR_FEATURES, 1210)
ok('TM → TM 并集', tmEn?.range[0] === 646 && tmEn?.range[1] === 701)
const kin = matchDomainHint('kinase', EGFR_FEATURES, 1210)
ok('kinase → Protein kinase 712-979', kin?.range[0] === 712 && kin?.range[1] === 979, JSON.stringify(kin?.range))
const kinZh = matchDomainHint('激酶', EGFR_FEATURES, 1210)
ok('激酶(裸词) → Protein kinase', kinZh?.range[0] === 712 && kinZh?.range[1] === 979)
const kinPhrase = matchDomainHint('EGFR kinase', EGFR_FEATURES, 1210)
ok('「EGFR kinase」短语 → kinase 域', kinPhrase?.range[0] === 712)

// ── 2. 通用 token / 守卫 ──
ok('无命中 → null', matchDomainHint('nonexistentxyz', EGFR_FEATURES, 1210) === null)
ok('空 token → null', matchDomainHint('', EGFR_FEATURES, 1210) === null)
ok('无 features → null', matchDomainHint('胞外', [], 1210) === null)
// SH2 人工注释仅 11 aa（<10 不成立 — 1000-1010 = 11 aa ≥10 应命中）
const sh2 = matchDomainHint('SH2', EGFR_FEATURES, 1210)
ok('SH2 → 注释域命中', sh2 != null && sh2.range[0] === 1000, JSON.stringify(sh2?.range))
// 序列长度裁剪：seqLen=800 时 kinase 区间 712-979 → end 裁到 800
const kinClamp = matchDomainHint('kinase', EGFR_FEATURES, 800)
ok('区间上界裁剪到序列长度', kinClamp?.range[1] === 800, JSON.stringify(kinClamp?.range))

// ── 3. scanDomainMentions（construct-range）──
const zh1 = scanDomainMentions('CCR8 胞外域')
ok('「CCR8 胞外域」→ token 胞外', zh1.includes('胞外'), JSON.stringify(zh1))
const zh2 = scanDomainMentions('激酶结构域')
ok('「激酶结构域」→ token 激酶', zh2.includes('激酶'), JSON.stringify(zh2))
const zh3 = scanDomainMentions('跨膜区')
ok('「跨膜区」→ token 跨膜', zh3.includes('跨膜'))
const zh4 = scanDomainMentions('死亡结构域')
ok('「死亡结构域」→ token 死亡', zh4.includes('死亡'))
const en1 = scanDomainMentions('EGFR kinase domain (712-979)')
ok('「kinase domain」→ 前缀 token', en1.some(t => /kinase/i.test(t)), JSON.stringify(en1))
const en2 = scanDomainMentions('TM domain boundary unknown')
ok('「TM domain」→ token TM', en2.some(t => /^tm$/i.test(t)), JSON.stringify(en2))
const en3 = scanDomainMentions('ectodomain construct')
ok('「ectodomain」独立词 → token', en3.some(t => /ectodomain/i.test(t)))
const none = scanDomainMentions('纯数字 123-456')
ok('纯数字无域名 token', none.length === 0, JSON.stringify(none))

// 死亡域英译（有 Death 注释的 feature 集）
const DEATH_FEATURES: UniprotFeature[] = [feat('Domain', 'Death', 1, 92), feat('Domain', 'Death 2', 350, 440)]
const death = matchDomainHint('死亡', DEATH_FEATURES, 500)
ok('死亡(中译) → Death 域', death?.range[0] === 1 && death?.range[1] === 92, JSON.stringify(death?.range))

console.log(`\n${pass} passed · ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
