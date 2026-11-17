import { PrismaClient } from '../src/generated/prisma/client'

const db = new PrismaClient()

async function main() {
  const rows = await db.$queryRawUnsafe(
    'SELECT id, uniprotId, status, createdAt FROM EvaluationJob ORDER BY createdAt DESC LIMIT 10',
  ) as Array<{ id: string; uniprotId: string; status: string; createdAt: Date }>
  for (const r of rows) {
    console.log(`${r.id} | ${r.uniprotId} | ${r.status} | ${r.createdAt?.toISOString?.() ?? r.createdAt}`)
  }
  if (!rows.length) console.log('(no jobs)')
}

main()
  .catch((e) => { console.error('ERR:', e.message); process.exit(1) })
  .finally(() => db.$disconnect())
