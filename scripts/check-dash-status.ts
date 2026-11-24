import { db } from '../src/lib/db'
async function main() {
  const ds = await db.htDashboard.findMany({ orderBy: { createdAt: 'desc' }, take: 6, select: { id: true, status: true, error: true, title: true, createdAt: true, updatedAt: true } })
  for (const d of ds) {
    console.log(`id=${d.id.slice(0, 14)} status=${d.status} created=${d.createdAt.toISOString()} updated=${d.updatedAt.toISOString()} dur=${Math.round((d.updatedAt.getTime() - d.createdAt.getTime()) / 1000)}s`)
    console.log(`  title=${d.title?.slice(0, 70) ?? ''}`)
    if (d.error) console.log(`  error=${d.error.slice(0, 400)}`)
  }
  const cnt = await db.htDashboard.count()
  console.log(`total dashboards: ${cnt}`)
  const imp = await db.importedReport.count().catch((e: unknown) => `ERR: ${e instanceof Error ? e.message : String(e)}`)
  console.log(`importedReport count: ${imp}`)
  await db.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })
