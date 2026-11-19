/**
 * POST /api/evaluate/ht-extract — 高通量评估 Excel/CSV 靶点表导入（v2.23）。
 *
 * multipart/form-data：file（.xlsx/.xlsm/.xls/.csv ≤ 10MB）+ llm（JSON 字符串，
 * v2.19 用户本地引擎配置内联携带，服务端不落盘）+ quick=1（跳过 LLM 直接规则提取）。
 *
 * v2.26 流式版（NDJSON 心跳保活）：旧版一次性 JSON 响应在 LLM 慢/限流重试时
 * 超出公网网关 ~30s 空闲转发窗 → 网关 502（用户实测「Excel 解析失败（HTTP 502）」，
 * 本地 dev server 实测 9.4s 正常 — 502 为网关层切断）。对齐 insights 路由
 * v2.6.3 的成熟口径：
 *  - 心跳 beat（1.2s 首拍 + 3s 间隔 + ~1.4KB pad，防小帧被中间层缓冲吞没）
 *  - LLM 墙钟预算 12s（网关对流式响应的**转发窗实测仅 ~24-28s** — done 事件必须
 *    落窗内才能到达客户端；超时 abort → 规则兜底即刻 done）
 *  - 前端三级降级：流式 → 断流重试 → quick 兜底（组件 api.ts）
 * 校验类错误（400/413/422）仍走普通 JSON（流尚未建立，前端先查 res.ok）。
 * 成功响应为 application/x-ndjson：行 {"type":"ping"}（心跳）与终态
 * {"type":"done", ok, groups, seqGroups, invalid, source, note?, meta}。
 *
 * 设计口径与 docx insights 一致：LLM 墙钟预算内出结果，超时/失败静默回退规则提取
 * （保证导入通道永不卡死）；无状态 — 不写盘、不留缓存，重复上传即重复解析。
 */
import { NextResponse } from 'next/server'
import { runWithLlmOverride, sanitizeLlmOverride } from '@/lib/eval/llm-provider'
import { extractHtGroups, HT_EXCEL_MAX_BYTES, parseHtWorkbook } from '@/lib/eval/ht-excel'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * LLM 墙钟预算：12s（对齐 insights v2.6.3 — 网关流转发窗实测 ~24-28s，done 必须
 * 落窗内；勿超过 ~15s，否则 done 可能再次落窗）。EVAL_HT_EXTRACT_BUDGET_MS
 * 可调（>10s 生效）。
 */
const LLM_BUDGET_MS = Number(process.env.EVAL_HT_EXTRACT_BUDGET_MS) > 10_000 ? Number(process.env.EVAL_HT_EXTRACT_BUDGET_MS) : 12_000
/** 心跳间隔（复刻 insights/sync 已验证穿透的事件节奏） */
const HEARTBEAT_MS = 3_000
/** 心跳 pad 体积：对齐 sync 首个进度事件 ~1.4KB —— 防小帧被中间层缓冲吞没 */
const BEAT_PAD = 'p'.repeat(1400)
const ALLOWED_EXT = /\.(xlsx|xlsm|xls|csv)$/i

export async function POST(req: Request) {
  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return NextResponse.json({ ok: false, error: '请求体不是合法的表单上传' }, { status: 400 })
  }

  const file = form.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json({ ok: false, error: '缺少 Excel 文件（表单字段名应为 file）' }, { status: 400 })
  }
  const fileName = file.name || '未命名文件'
  if (!ALLOWED_EXT.test(fileName)) {
    return NextResponse.json({ ok: false, error: '仅支持 .xlsx / .xlsm / .xls / .csv 格式的靶点表' }, { status: 422 })
  }
  if (file.size > HT_EXCEL_MAX_BYTES) {
    return NextResponse.json(
      { ok: false, error: `文件超过 10MB 上限（当前 ${(file.size / 1048576).toFixed(1)}MB），请拆分表格后分次导入` },
      { status: 413 },
    )
  }

  const quick = form.get('quick') === '1'
  // v2.19 用户本地引擎配置（localStorage → 请求内联携带；解析失败按无覆写处理，回退内置引擎）
  let llmRaw: unknown = null
  const llmField = form.get('llm')
  if (typeof llmField === 'string' && llmField.trim()) {
    try {
      llmRaw = JSON.parse(llmField)
    } catch {
      llmRaw = null
    }
  }

  let wb
  try {
    wb = parseHtWorkbook(Buffer.from(await file.arrayBuffer()))
  } catch {
    return NextResponse.json({ ok: false, error: '无法解析该文件（可能已损坏或不是有效的 Excel/CSV 文件）' }, { status: 422 })
  }
  if (wb.rowCount === 0) {
    return NextResponse.json({ ok: false, error: '表格内容为空（未读取到任何非空行），无法提取靶点' }, { status: 422 })
  }

  // ── v2.26 流式执行（NDJSON 心跳 — 网关 ~30s 空闲切断对策）──────────────────
  const encoder = new TextEncoder()
  const t0 = Date.now()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      const send = (obj: Record<string, unknown>) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'))
        } catch { closed = true }
      }
      const sendBeat = () => send({
        type: 'ping',
        elapsedMs: Date.now() - t0,
        budgetMs: LLM_BUDGET_MS,
        pad: BEAT_PAD,
      })
      const firstBeat = setTimeout(sendBeat, 1_200)
      const ping = setInterval(sendBeat, HEARTBEAT_MS)
      const cleanup = () => { clearTimeout(firstBeat); clearInterval(ping) }
      const closeStream = () => {
        cleanup()
        if (!closed) {
          closed = true
          try { controller.close() } catch { /* already closed */ }
        }
      }

      void runWithLlmOverride(sanitizeLlmOverride(llmRaw), async () => {
        try {
          // 墙钟预算：超时 abort → llmChat 判失败 → 规则兜底；客户端断开同样中止 LLM 空转
          const ctrl = new AbortController()
          const onCallerAbort = () => ctrl.abort()
          req.signal?.addEventListener('abort', onCallerAbort, { once: true })
          const timer = quick ? null : setTimeout(() => ctrl.abort(), LLM_BUDGET_MS)
          try {
            const result = await extractHtGroups(wb, { quick, signal: ctrl.signal })
            send({
              type: 'done',
              ok: true,
              ...result,
              meta: {
                fileName,
                sheets: wb.sheetCount,
                rows: wb.rowCount,
                truncated: wb.truncated,
                bytes: file.size,
                // v2.23.1 序列兜底计数（v2.34 行级语义：行=组，链级提取）
                seqGroups: result.seqGroups.length,
                seqTargets: result.seqGroups.reduce((n, g) => n + g.length, 0),
                // v2.34：行→组口径统计（抗体链忽略 / 同源多聚体合并 / 跳过行）
                seqRows: result.seqInfo?.groups,
                seqAntibodyChains: result.seqInfo?.antibodyChains,
                seqHomologMerged: result.seqInfo?.homologMerged,
                seqSkippedRows: result.seqInfo?.skippedRows.length,
                // v2.35：跨行去重统计（所有链 ≥95% 同源的重复交付行并入代表组）
                seqCrossRowMerged: result.seqInfo?.crossRowMerged,
                // v2.35：序列兜底覆盖的数据行总数（组 + 跨行并入 + 跳过行 — 全量核算口径）
                seqDataRows:
                  result.seqInfo != null
                    ? result.seqInfo.groups + result.seqInfo.crossRowMerged + result.seqInfo.skippedRows.length
                    : undefined,
                // v2.27：携带构建区间的靶点数（截短构建感知 — 仅保留链范围重叠的结构）
                rangeTargets: result.groups.reduce(
                  (n, g, gi) => n + (result.groupRanges[gi] ?? []).filter(Boolean).length,
                  0,
                ),
                // v2.29：携带结构域名提示的靶点数（管线内与 UniProt domain 匹配推导区间）
                domainHintTargets: result.groups.reduce(
                  (n, g, gi) => n + (result.groupDomainHints[gi] ?? []).filter(Boolean).length,
                  0,
                ),
              },
            })
          } finally {
            if (timer) clearTimeout(timer)
            req.signal?.removeEventListener('abort', onCallerAbort)
          }
        } catch (err) {
          send({ type: 'done', ok: false, error: err instanceof Error ? err.message : '解析异常' })
        } finally {
          closeStream()
        }
      })
    },
  })
  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}
