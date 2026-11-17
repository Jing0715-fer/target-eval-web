import { PrismaClient } from '../src/generated/prisma/client'

const db = new PrismaClient()

async function main() {
  const jobs = await db.$queryRawUnsafe(
    'SELECT id, status, error, uniprotId, summary, reportPath FROM EvaluationJob ORDER BY createdAt DESC LIMIT 3',
  ) as Array<{ id: string; status: string; error: string | null; uniprotId: string | null; summary: string | null; reportPath: string | null }>
  for (const j of jobs) {
    console.log(`\n=== ${j.id} status=${j.status}${j.error ? ` err=${j.error.slice(0, 200)}` : ''} uniprot=${j.uniprotId ?? '-'} report=${j.reportPath ?? '-'}`)
    if (j.summary) {
      try {
        const s = JSON.parse(j.summary) as Record<string, unknown>
        console.log('alphafold:', JSON.stringify(s.alphafold))
        console.log('esmfold  :', JSON.stringify(s.esmfold))
        console.log('phase-ish keys:', Object.keys(s).slice(0, 40).join(','))
      } catch { console.log('(summary parse failed)') }
    }
  }
}

main()
  .catch((e) => { console.error('ERR:', e.message); process.exit(1) })
  .finally(() => db.$disconnect())
