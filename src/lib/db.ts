import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
  __dbWalReady?: Promise<unknown>
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['query'],
  })

// v2.103：SQLite 切换 WAL 日志模式（幂等 — 已是 WAL 时无操作）。
// 事故：默认 DELETE 模式下写事务（作业状态 UPDATE / TTL 清理 DELETE）独占库锁，
// 并发读（checkJobQuota 的 3 个 evaluationJob.count）直接被锁阻塞抛错 → evaluate
// 路由 500「配额检查失败」→ 前端误判限流整场暂停（用户实测 TI_CM006_17_B3）。
// 重启窗口新旧两个实例短暂并存操作同一 db 文件时锁竞争尤甚（dev.log 实证
// EADDRINUSE 瞬间）。WAL 下读不阻塞写、写不阻塞读，跨进程并发安全。
// journal_mode 是数据库级持久属性（写进文件头，一次生效）；沙箱重置新建库时
// 模块重新加载会再次执行。fire-and-forget：失败（库忙/只读）静默 — DELETE 模式
// 行为兜底，不比修复前差。
globalForPrisma.__dbWalReady ??= db
  .$queryRawUnsafe('PRAGMA journal_mode=WAL')
  .catch(() => undefined)

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
