/**
 * GET /api — 健康检查 + 服务器负载状态（队列/解析占用）。
 * 前端在提交评估前可读取该状态，向用户提示当前排队情况。
 * 不含任何用户数据。
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { parseLoad } from '@/lib/eval/gatekeeper'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  let pending = 0
  let running = 0
  try {
    const [p, r] = await Promise.all([
      db.evaluationJob.count({ where: { status: 'pending' } }),
      db.evaluationJob.count({ where: { status: 'running' } }),
    ])
    pending = p
    running = r
  } catch { /* DB 未就绪时返回 0 */ }
  const parse = parseLoad()
  return NextResponse.json({
    message: 'TargetEval API',
    version: '1.8.0',
    queue: { pending, running },
    parse,
    time: new Date().toISOString(),
  })
}
