const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()
async function main() {
  const tabs = await p.$queryRawUnsafe("SELECT name FROM sqlite_master WHERE type='table'")
  console.log('tables:', tabs.map(t => t.name).join(', '))
  const brs = await p.$queryRawUnsafe("SELECT id, status, title, uploadId, jobIds FROM BatchReport")
  for (const r of brs) console.log(r.id, '|', r.status, '|', (r.title||'').slice(0,40), '|', r.uploadId, '|', r.jobIds?.slice(0,120))
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) }).finally(() => p.$disconnect())
