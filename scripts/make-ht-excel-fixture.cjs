/** 生成高通量浏览器 E2E 用测试 Excel（两组 + 3 靶点） */
const XLSX = require('xlsx')
const wb = XLSX.utils.book_new()
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
  ['组号', 'UniProt ID', '蛋白名称'],
  ['1', 'P04637', 'TP53'],
  ['1', 'P00533', 'EGFR'],
  ['2', 'O14746', 'PDPK1'],
]), '靶点表')
XLSX.writeFile(wb, '/tmp/ht-e2e.xlsx')
console.log('✓ /tmp/ht-e2e.xlsx')
