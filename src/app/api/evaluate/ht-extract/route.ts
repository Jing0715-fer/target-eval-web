/**
 * POST /api/evaluate/ht-extract — 高通量评估 Excel/CSV 靶点表导入（v2.23）。
 *
 * multipart/form-data：file（.xlsx/.xlsm/.xls/.csv ≤ 10MB）+ llm（JSON 字符串，
 * v2.19 用户本地引擎配置内联携带，服务端不落盘）+ quick=1（跳过 LLM 直接规则提取）。
 * 返回 { ok, groups: string[][], invalid, source: 'llm'|'regex', note?, meta }。
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

/** LLM 墙钟预算：28s（网关非流式响应转发窗内；超时 abort → 规则兜底即刻返回） */
const LLM_BUDGET_MS = 28_000
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

  return runWithLlmOverride(sanitizeLlmOverride(llmRaw), async () => {
    // 墙钟预算：超时 abort → llmChat 判失败 → 规则兜底；客户端断开同样中止 LLM 空转
    const ctrl = new AbortController()
    const onCallerAbort = () => ctrl.abort()
    req.signal?.addEventListener('abort', onCallerAbort, { once: true })
    const timer = quick ? null : setTimeout(() => ctrl.abort(), LLM_BUDGET_MS)
    try {
      const result = await extractHtGroups(wb, { quick, signal: ctrl.signal })
      return NextResponse.json({
        ok: true,
        ...result,
        meta: {
          fileName,
          sheets: wb.sheetCount,
          rows: wb.rowCount,
          truncated: wb.truncated,
          bytes: file.size,
          // v2.23.1 序列兜底计数（行缺 UniProt 但有构建序列 → 按序列评估）
          seqGroups: result.seqGroups.length,
          seqTargets: result.seqGroups.reduce((n, g) => n + g.length, 0),
        },
      })
    } finally {
      if (timer) clearTimeout(timer)
      req.signal?.removeEventListener('abort', onCallerAbort)
    }
  })
}
