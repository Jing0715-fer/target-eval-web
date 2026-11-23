/**
 * v2.72 验证：Excel 行内抗体链 → antibodyPartner（fallbackHtGroups 序列兜底组）。
 */
import { fallbackHtGroups } from '../src/lib/eval/ht-excel'
import { detectAntibody } from '../src/lib/eval/antibody'

// 构造 IgG 恒定区片段（触发强基序）+ RBD 抗原序列
const HC = 'ASTKGPSVFPLAPSSKSTSGGTAALGCLVKDYFPEPVTVSWNSGALTSGVHTFPAVLQSSGLYSLSSVVTVPSSSLGTQTYICNVNHKPSNTKVDKKVEPKSCDKTHTCPPCPAPELLGGPSVFLFPPKPKDTLMISRTPEVTCVVVDVSHEDPEVKFNWYVDGVEVHNAKTKPREEQYNSTYRVVSVLTVLHQDWLNGKEYKCKVSNKALPAPIEKTISKAK'.slice(0, 220)
const AG = 'NITNLCPFGEVFNATRFASVYAWNRKRISNCVADYSVLYNSASFSTFKCYGVSPTKLNDLCFTNVYADSFVIRGDEVRQIAPGQTGKIADYNYKLPDDFTGCVIAWNSNNLDSKVGGNYNYLYRLFRKSNLKPFERDISTEIYQAGSTPCNGVEGFNCYFPLQSYGFQPTNGVGYQPYRVVVLSFELLHAPATVCGPKKSTNLVKNKCVNFNFNGLTGTGVLTESNKKFLPFQQFGRDIADTTDAVRDPQTLEILDITPCSFGGVSVITPGTNTSNQVAVLYQDVNCTEVPVAIHADQLTPTWRVYSTGSNVFQTRAGCLIGAEHVNNSYECDIPIGAGICASYQTQTNSPRRARSVASQSIIAYTMSLGAENSVAYSNNSIAIPTNFTISVTTEILPVSMTKTSVDCTMYICGDSTECSNLLLQYGSFCTQLNRALTGIAVEQDKNTQEVFAQVKQIYKTPPIKDFGGFNFSQILPDPSKPSKRSFIEDLLFNKVTLADAGFIKQYGDCLGDIAARDLICAQKFNGLTVLPPLLTDEMIAQYTSALLAGTITSGWTFGAGAALQIPFAMQMAYRFNGIGVTQNVLYENQKLIANQFNAKNIIKVFSELQAY'.slice(0, 196)
console.log('抗体链检测（IgG 恒定区片段）:', detectAntibody(HC).isAntibody, '| 抗原:', detectAntibody(AG).isAntibody)

const sheets = [{
  name: 'Sheet1',
  rows: [
    ['靶点', '序列'],
    // 抗原 + 抗体重链（FASTA 双链 — 复合物交付行）
    ['/Volumes/One Touch/杰库/RBD-fab.pdb', `>Chain_A\n${AG}\n>HC\n${HC}`],
  ],
}]
const r = fallbackHtGroups(sheets)
console.log('seqGroups 组数:', r.seqGroups.length)
for (const g of r.seqGroups) {
  for (const t of g) {
    console.log(`  靶点: ${t.header.slice(0, 40)} · ${t.length}aa | antibodyPartner:`, t.antibodyPartner)
  }
}
console.log('note:', r.seqInfo?.note ?? r.note ?? '(无)')
const ok = r.seqGroups.some(g => g.some(t => t.antibodyPartner && t.antibodyPartner.lengthAa >= 90))
console.log(ok ? '✓ 抗体链已忽略并作为复合物分子量证据携带' : '✗ antibodyPartner 未携带')
process.exit(ok ? 0 : 1)
