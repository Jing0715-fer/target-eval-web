import { db } from '../src/lib/db'
async function main() {
  const jobs = await db.evaluationJob.findMany({ select: { id: true, summary: true, pdbs: true, blastHits: true, reportMarkdown: true, logs: true, status: true } })
  for (const j of jobs) {
    console.log(`${j.id} ${j.status}: summary=${j.summary?.length ?? 0} pdbs=${j.pdbs?.length ?? 0} blast=${j.blastHits?.length ?? 0} reportMd=${j.reportMarkdown?.length ?? 0} logs=${j.logs?.length ?? 0}`)
  }
}
main().finally(() => db.$disconnect())
