import { db } from '../src/lib/db'
async function main() {
  const jobs = await db.evaluationJob.findMany({ select: { id: true, status: true, ownerKey: true, createdAt: true, title: true } })
  console.log('=== EvaluationJob total:', jobs.length)
  const byDay: Record<string, number> = {}
  const byStatus: Record<string, number> = {}
  for (const j of jobs) {
    const d = j.createdAt.toISOString().slice(0, 10)
    byDay[d] = (byDay[d] ?? 0) + 1
    byStatus[j.status] = (byStatus[j.status] ?? 0) + 1
  }
  console.log('byDay:', JSON.stringify(byDay))
  console.log('byStatus:', JSON.stringify(byStatus))
  const dashes = await db.htDashboard.findMany({ orderBy: { createdAt: 'desc' }, take: 10 })
  console.log('=== HtDashboard count:', await db.htDashboard.count())
  for (const d of dashes) console.log(`dash ${d.id} ${d.status} err=${(d.error ?? '').slice(0, 80)} jobIds=${(d.jobIds ?? '').slice(0, 300)} created=${d.createdAt.toISOString()}`)
  const batches = await db.batchReport.findMany({ orderBy: { createdAt: 'desc' }, take: 10 })
  console.log('=== BatchReport count:', await db.batchReport.count())
  for (const b of batches) console.log(`batch ${b.id} ${b.status} err=${(b.error ?? '').slice(0, 60)} created=${b.createdAt.toISOString()}`)
}
main().finally(() => db.$disconnect())
