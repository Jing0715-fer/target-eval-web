import { db } from '@/lib/db'

/**
 * v2.70：ImportedReport 表自愈（幂等 DDL，进程内缓存一次）。
 *
 * 背景（v2.69 用户实测「报告都载入了，但弹出页全是重建页」的根因）：本地部署
 * 拉取新版本后通常只跑 `bun run dev`（不会自动执行 `prisma db push`）— v2.69
 * 新增的 ImportedReport 表在既有库里不存在，上传路由 `db.importedReport.create`
 * 抛 P2021（unhandled → 500），客户端静默降级 → 所有导入靶点都拿不到原文
 * reportId → 汇总报告「完整报告」弹出页全部退化为重建页 / 评分行连按钮都没有。
 *
 * 这里在首次使用前用 `CREATE TABLE IF NOT EXISTS` 补建表与索引（与 Prisma
 * `db push` 生成的 DDL 完全同构 — 之后用户手动 push 不会产生 schema 漂移；
 * 表已存在时零开销）。失败时清空缓存允许下次重试，并由调用方走各自降级。
 */
let ensurePromise: Promise<void> | null = null

export function ensureImportedReportTable(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      await db.$executeRawUnsafe(
        'CREATE TABLE IF NOT EXISTS "ImportedReport" (' +
        '"id" TEXT NOT NULL PRIMARY KEY, ' +
        '"fileName" TEXT NOT NULL, ' +
        '"htmlPath" TEXT NOT NULL, ' +
        '"size" INTEGER NOT NULL, ' +
        '"ownerKey" TEXT, ' +
        '"ownerMask" TEXT, ' +
        '"createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)',
      )
      await db.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "ImportedReport_createdAt_idx" ON "ImportedReport"("createdAt")')
      await db.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "ImportedReport_ownerKey_createdAt_idx" ON "ImportedReport"("ownerKey", "createdAt")')
    })().catch((err: unknown) => {
      ensurePromise = null // 本次失败不缓存 — 下次调用重试
      throw err
    })
  }
  return ensurePromise
}
