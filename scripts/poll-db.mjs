import { PrismaClient } from '@prisma/client'
import { readFileSync } from 'fs'
const p = new PrismaClient()
const id = readFileSync(process.argv[2] || '/tmp/egfr-ligand-job.txt', 'utf8').trim()
const t0 = Date.now()
while (Date.now() - t0 < 500_000) {
  const j = await p.evaluationJob.findUnique({ where: { id }, select: { status: true, error: true, updatedAt: true } })
  if (j.status !== 'running' || Date.now() - j.updatedAt.getTime() > 90_000) { console.log('状态:', j.status, j.error || ''); await p.$disconnect(); process.exit(j.status === 'done' ? 0 : 2) }
  await new Promise((r) => setTimeout(r, 5000))
}
console.log('超时（running 中）'); await p.$disconnect(); process.exit(1)
