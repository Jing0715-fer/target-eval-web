/** 运维脚本：清理孤儿 pending 作业（进程重启后内存队列蒸发，DB 残留死行） */
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()

async function main() {
  const rows = await p.evaluationJob.findMany({
    where: { status: 'pending' },
    select: { id: true, createdAt: true },
  })
  console.log('pending before:', rows.length)
  for (const r of rows) {
    await p.evaluationJob.update({
      where: { id: r.id },
      data: {
        status: 'error',
        error: '服务器重启导致作业中断，请重新发起评估',
        updatedAt: new Date(),
      },
    })
    console.log('reaped:', r.id, r.createdAt.toISOString())
  }
  const g = await p.evaluationJob.groupBy({ by: ['status'], _count: { _all: true } })
  console.log('after:', JSON.stringify(g.map(x => [x.status, x._count._all])))
}

main()
  .catch(e => { console.error('ERR', e.message); process.exit(1) })
  .finally(() => p.$disconnect())
