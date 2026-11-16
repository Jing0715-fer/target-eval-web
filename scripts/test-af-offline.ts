/**
 * v2.7.4 AlphaFold 磁盘优先（离线可用）实测：
 *
 * 两个独立进程分别模拟「联网首评」与「部署节点断网重启」：
 *  1) bun scripts/test-af-offline.ts --populate   （联网）下载 O94952 元数据+PDB，
 *     落盘 db/cache/alphafold/pdb/{id}.meta.json + {id}.pdb
 *  2) bun scripts/test-af-offline.ts --offline   （断网模拟：进程启动即毒化
 *     globalThis.fetch — LRU 为空，等价于重启实例无外网）断言：
 *      a. 新鲜 sidecar 快路径：alphafoldMetaFor / alphafoldStructureFor 零网络返回
 *      b. sidecar 过期（savedAt 回拨 8 天）+ 断网：回退本地缓存仍返回（降级不丢区块）
 *      c. 结束后恢复 savedAt
 *      d. safeAfId 注入防御：路径遍历串直接视为无预测
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { alphafoldMetaFor, alphafoldStructureFor } from '../src/lib/eval/alphafold'

const ID = 'O94952'
const CACHE_DIR = path.join(process.cwd(), 'db', 'cache', 'alphafold', 'pdb')
const META_FILE = path.join(CACHE_DIR, `${ID}.meta.json`)
const PDB_FILE = path.join(CACHE_DIR, `${ID}.pdb`)

let failed = 0
function assert(ok: boolean, label: string, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`)
  if (!ok) failed++
}

async function sidecarSavedAt(): Promise<number | null> {
  try {
    const raw = await fs.readFile(META_FILE, 'utf-8')
    return (JSON.parse(raw) as { savedAt: number }).savedAt ?? null
  } catch {
    return null
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? ''

  if (mode === '--populate') {
    // ─── 联网首评：填充磁盘缓存（元数据 sidecar + 模型 PDB）───
    const t0 = Date.now()
    const struct = await alphafoldStructureFor(ID)
    const ms = Date.now() - t0
    assert(struct != null, '联网首评：alphafoldStructureFor 返回结构', `${ms}ms`)
    assert(!!struct && struct.embeddable, '模型 ≤ 2.5MB 内嵌预算（embeddable）')
    assert(!!struct && struct.pdbText.includes('ATOM'), 'PDB 文本含 ATOM 记录')
    assert(!!struct && struct.meta.pdbUrl.includes('alphafold.ebi.ac.uk'), '元数据含 pdbUrl')
    assert((await sidecarSavedAt()) != null, 'sidecar {id}.meta.json 已落盘')
    const pdb = await fs.readFile(PDB_FILE, 'utf-8').catch(() => null)
    assert(pdb != null && pdb.includes('ATOM'), '模型 {id}.pdb 已落盘')
    process.exit(failed === 0 ? 0 : 1)
  }

  if (mode === '--offline') {
    // ─── 断网模拟：进程启动即毒化 fetch（重启实例 + 无外网）───
    const poisonedFetch = () => { throw new Error('simulated offline') }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).fetch = poisonedFetch

    // a. 新鲜 sidecar 快路径 — 全程零网络
    const meta = await alphafoldMetaFor(ID)
    assert(meta != null, '断网·新鲜窗口：alphafoldMetaFor 零网络返回元数据',
      meta ? `${meta.modelId} v${meta.latestVersion} pLDDT ${meta.globalPlddt}` : '')

    const struct = await alphafoldStructureFor(ID)
    assert(struct != null, '断网·新鲜窗口：alphafoldStructureFor 零网络返回结构')
    assert(!!struct && struct.embeddable && struct.pdbText.includes('ATOM'),
      '断网·新鲜窗口：结构完整可内嵌（ATOM + embeddable）')
    const diskPdb = await fs.readFile(PDB_FILE, 'utf-8').catch(() => '')
    assert(!!struct && struct.pdbText === diskPdb, '返回 PDB 与磁盘缓存一致')

    // b. sidecar 过期（回拨 8 天）+ 断网 → 回退本地（降级不丢区块）
    const raw = await fs.readFile(META_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as { savedAt: number; meta: unknown }
    const savedAtOrig = parsed.savedAt
    parsed.savedAt = Date.now() - 8 * 24 * 3600 * 1000
    await fs.writeFile(META_FILE, JSON.stringify(parsed), 'utf-8')

    const metaStale = await alphafoldMetaFor(ID)
    assert(metaStale != null, '断网·sidecar 过期：alphafoldMetaFor 回退本地缓存')

    const structStale = await alphafoldStructureFor(ID)
    assert(structStale != null && structStale.pdbText.includes('ATOM'),
      '断网·sidecar 过期：alphafoldStructureFor 成对回退（meta+PDB）')

    // c. 恢复 savedAt（留缓存供后续真实验证）
    parsed.savedAt = savedAtOrig
    await fs.writeFile(META_FILE, JSON.stringify(parsed), 'utf-8')
    assert((await sidecarSavedAt()) === savedAtOrig, 'sidecar savedAt 已恢复')

    // d. safeAfId 注入防御
    const evil = await alphafoldMetaFor('../../etc/passwd')
    assert(evil == null, 'safeAfId：路径遍历串被拒绝（视为无预测）')
    const evil2 = await alphafoldStructureFor('..\\..\\win')
    assert(evil2 == null, 'safeAfId：反斜杠穿越串被拒绝')

    process.exit(failed === 0 ? 0 : 1)
  }

  console.log('用法：bun scripts/test-af-offline.ts --populate | --offline')
  process.exit(2)
}

main()
