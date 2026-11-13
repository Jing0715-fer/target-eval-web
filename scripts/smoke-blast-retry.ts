/**
 * v1.28 BLAST last-resort 整周期重试冒烟测试：
 *  - runBlastWithRetry 通道 A（RCSB 直连，真实网络）应快速返回（命中或空皆为成功）
 *  - 结构证据守门错误信息格式（pipeline 拦截文案）通过代码审查验证
 */
import { runBlastWithRetry } from '../src/lib/eval/blast'

// 人血红蛋白 α（P69905）成熟链前 60 aa — 有大量同源结构，RCSB 应秒级返回命中
const seq =
  'MVLSPADKTNVKAAWGKVGAHAGEYGAEALERMFLSFPTTKTYFPHFDLSHGSAQVKGHGKKVADALTNAVAHVDDMPNALSALSDLHAHKLRVDPVNFKLLSHCLLVTLAAHLPAEFTPAVHASLDKFLASVSTVLTSKYR'

const t0 = Date.now()
const result = await runBlastWithRetry(
  seq,
  msg => console.log(`  [progress] ${msg}`),
  undefined,
  { attempts: 2, attemptWallMs: 90_000, backoffMs: 5_000 },
)
const elapsed = ((Date.now() - t0) / 1000).toFixed(1)

console.log(`\nprovider=${result.provider} hits=${result.hits.length} elapsed=${elapsed}s`)
console.log(`note=${result.note}`)
if (result.hits.length > 0) {
  console.log(`top hit: ${result.hits[0].pdbId} identity=${result.hits[0].identity}%`)
}

const ok = result.provider === 'rcsb' && result.hits.length > 0 && Number(elapsed) < 60
console.log(ok ? '\nPASS: RCSB 通道正常返回同源命中' : '\nFAIL: 未见预期命中')
if (!ok) process.exit(1)
