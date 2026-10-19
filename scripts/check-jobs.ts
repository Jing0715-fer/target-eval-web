import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
const jobs = await db.evaluationJob.findMany({
  orderBy: { createdAt: 'desc' },
  take: 10,
  select: { id: true, uniprotId: true, status: true, createdAt: true, title: true }
})
for (const j of jobs) console.log(JSON.stringify(j))
const total = await db.evaluationJob.count()
console.log('total jobs:', total)
await db.$disconnect()
