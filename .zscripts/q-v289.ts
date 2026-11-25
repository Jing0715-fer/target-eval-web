import { db } from '../src/lib/db'
async function main() {
  const d = await db.htDashboard.findMany({ orderBy: { createdAt: 'desc' }, take: 3, select: { id: true, status: true, htmlPath: true, error: true } })
  console.log(JSON.stringify(d, null, 1))
  const imp = await db.importedReport.findMany({ where: { fileName: { contains: 'v289' } }, select: { id: true, fileName: true, size: true } })
  console.log('v289 imports:', JSON.stringify(imp))
  await (db as unknown as { $disconnect: () => Promise<void> }).$disconnect()
}
main()
