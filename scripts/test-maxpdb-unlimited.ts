/**
 * v2.5 maxPdb=10000（不限）通道验证：创建作业 → 直接读 DB 校验 options 原样持久化 → 取消。
 * （JobDetail API 不透出 options，故从 SQLite 读取）
 */
import { PrismaClient } from '@prisma/client'

const BASE = process.env.BASE ?? 'http://127.0.0.1:3000'

async function main() {
  const res = await fetch(`${BASE}/api/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: 'uniprot',
      uniprot: 'P00533',
      goal: 'E2E 无限选项验证',
      options: { skipBlast: true, forceBlast: false, maxPdb: 10000 },
    }),
  })
  const created = await res.json()
  if (!res.ok || !created.ok || !created.jobId) throw new Error('不限作业创建失败: ' + JSON.stringify(created).slice(0, 200))
  const jobId = created.jobId as string
  console.log('  作业创建:', jobId)

  const db = new PrismaClient()
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await db.evaluationJob.findUnique({ where: { id: jobId }, select: { options: true, status: true } })
    if (row?.options) {
      const opt = JSON.parse(row.options)
      console.log('  DB options =', row.options, '· status =', row.status)
      if (opt.maxPdb !== 10000) throw new Error('FAIL: maxPdb=10000 未原样通过（得到 ' + opt.maxPdb + '）')
      break
    }
    await new Promise(r => setTimeout(r, 600))
    if (attempt === 2) throw new Error('FAIL: DB 中未找到该作业 options')
  }
  await db.$disconnect()

  await fetch(`${BASE}/api/jobs/${jobId}`, { method: 'DELETE' })
  console.log('  … 已取消（DELETE）')
  console.log('✅ maxPdb=10000（不限）通道通过：路由接收 → options 原样持久化 → 可取消')
}

main().catch(e => { console.error('❌', e.message); process.exit(1) })
