// 测试清理：把悬挂的 pending/running 作业标记为 error（仅本地 dev 用）
import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
const r = await db.evaluationJob.updateMany({
  where: { status: { in: ['pending', 'running'] } },
  data: { status: 'error', error: '本地测试清理', updatedAt: new Date() },
})
console.log('清理悬挂作业:', r.count)
await db.$disconnect()
