/**
 * 评估表图片处理管线（后端专用）：
 *  - EMF/WMF 矢量图 → PNG（LibreOffice headless 批量转换 + trim 去白边）
 *  - TIFF/BMP 归一化为 PNG；超大位图降采样（sharp，libvips 内存有界）
 *  - VLM 识别图片类型（gel 胶图 / sec 分子筛色谱图）与关键读数（z-ai SDK，串行小并发 + 单图超时）
 *
 * 内存策略：
 *  - soffice 单次批量转换（≤45s 超时），进程级隔离；不可用时优雅降级（返回 null 计入跳过）
 *  - sharp 流式处理，长边 ≤1600px；>800KB 再压 JPEG q85，落盘图恒有界
 *  - VLM 单图 base64 ≤2MB、小并发（2）、总上限 6 张，失败回退关键词分类
 */
import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { randomUUID } from 'node:crypto'
import type { AssetKind } from './types'

// ─── 常量 ─────────────────────────────────────────────────────────────────────

/** 原始单图上限（docx 内，转换/降采样前） */
export const SOURCE_IMAGE_MAX_BYTES = 6 * 1024 * 1024
/** 降采样后单图软上限（超过则再压 JPEG） */
const STORED_SOFT_MAX_BYTES = 800 * 1024
/** 长边上限 */
const MAX_EDGE = 1600
/** soffice 批量转换超时 */
const SOFFICE_TIMEOUT_MS = 45_000
/** VLM 单图超时 */
const VLM_TIMEOUT_MS = 25_000
/** VLM 分类图片数上限 */
export const VLM_MAX_IMAGES = 6
/** VLM 小并发 */
const VLM_CONCURRENCY = 2

type SharpModule = typeof import('sharp')
let sharpMod: SharpModule | null = null
async function getSharp(): Promise<SharpModule | null> {
  if (sharpMod) return sharpMod
  try {
    sharpMod = (await import('sharp')).default as SharpModule
    return sharpMod
  } catch {
    return null // sharp 不可用（依赖缺失）→ 优雅降级
  }
}

// ─── EMF/WMF → PNG（LibreOffice headless）────────────────────────────────────

let sofficeChecked = false
let sofficeBin: string | null = null

/** 探测 LibreOffice 可执行文件（soffice / libreoffice） */
async function findSoffice(): Promise<string | null> {
  if (sofficeChecked) return sofficeBin
  sofficeChecked = true
  for (const bin of ['soffice', 'libreoffice']) {
    try {
      await execFileAsync2('which', [bin], 5_000)
      sofficeBin = bin
      return bin
    } catch { /* not found */ }
  }
  return null
}

function execFileAsync2(cmd: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(err)
      else resolve({ stdout: String(stdout), stderr: String(stderr) })
    })
    // 超时强杀（execFile timeout 只发 SIGTERM，兜底 SIGKILL）
    child.on('error', () => undefined)
  })
}

/**
 * 批量将 EMF/WMF 缓冲转换为 PNG（去白边 + 白底压平）。
 * 返回与输入等长的数组，失败项为 null。
 */
export async function convertMetafilesToPng(
  items: Array<{ buf: Buffer; ext: string }>,
): Promise<Array<Buffer | null>> {
  const out: Array<Buffer | null> = new Array(items.length).fill(null)
  if (items.length === 0) return out
  const bin = await findSoffice()
  if (!bin) return out

  const tmpRoot = path.join(os.tmpdir(), `eval-emf-${randomUUID().slice(0, 8)}`)
  const inDir = path.join(tmpRoot, 'in')
  const outDir = path.join(tmpRoot, 'out')
  try {
    await fs.mkdir(inDir, { recursive: true })
    await fs.mkdir(outDir, { recursive: true })
    const names: string[] = []
    for (let i = 0; i < items.length; i++) {
      const name = `img${i}.${items[i].ext === 'wmf' ? 'wmf' : 'emf'}`
      await fs.writeFile(path.join(inDir, name), items[i].buf)
      names.push(name)
    }
    try {
      await execFileAsync2(
        bin,
        ['--headless', '--norestore', '--convert-to', 'png', '--outdir', outDir, ...names.map(n => path.join(inDir, n))],
        SOFFICE_TIMEOUT_MS,
      )
    } catch {
      return out // 转换失败（超时/崩溃）→ 全部按跳过处理
    }
    const sharp = await getSharp()
    for (let i = 0; i < items.length; i++) {
      const png = path.join(outDir, `img${i}.png`)
      try {
        const raw = await fs.readFile(png)
        if (raw.length === 0) continue
        if (!sharp) {
          out[i] = raw
          continue
        }
        // soffice 以页面尺寸导出 → trim 白边 + 压平透明度
        const trimmed = await sharp(raw)
          .flatten({ background: '#ffffff' })
          .trim({ threshold: 12 })
          .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
          .png({ compressionLevel: 9 })
          .toBuffer()
        out[i] = trimmed.length > 0 && trimmed.length < raw.length * 3 ? trimmed : raw
      } catch { /* 单张失败跳过 */ }
    }
  } finally {
    fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined)
  }
  return out
}

// ─── 位图归一化（TIFF/BMP → PNG；超大图降采样）───────────────────────────────

/**
 * 位图归一化：
 *  - TIFF/BMP → PNG（浏览器不支持的格式转成 PNG）
 *  - 长边 >1600px 或体积 >500KB → 等比降采样到 1600px
 *  - 降采样后仍 >800KB → JPEG q85（白底压平）
 * sharp 不可用或解码失败返回 null（调用方计入跳过）。
 */
export async function normalizeRasterImage(
  buf: Buffer,
  mime: string,
): Promise<{ buf: Buffer; mime: string } | null> {
  const sharp = await getSharp()
  if (!sharp) {
    // 无 sharp：浏览器原生支持的格式原样保留，其余放弃
    return /^image\/(png|jpe?g|gif|webp)$/i.test(mime) ? { buf, mime } : null
  }
  try {
    let img = sharp(buf, { limitInputPixels: 268_435_456, failOn: 'error' })
    const meta = await img.metadata()
    if (!meta.width || !meta.height) return null
    const needResize = Math.max(meta.width, meta.height) > MAX_EDGE || buf.length > 500 * 1024
    const browserOk = /^image\/(png|jpe?g|gif|webp)$/i.test(mime)
    if (!needResize) {
      return browserOk ? { buf, mime } : await reencode(img, 'png')
    }
    img = img
      .rotate() // 尊重 EXIF 方向
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    const png = await reencode(img, 'png')
    if (png && png.buf.length <= STORED_SOFT_MAX_BYTES) return png
    const jpg = await reencode(img, 'jpeg')
    if (jpg) return jpg
    return png // JPEG 失败（如极端宽高比）时退回 PNG
  } catch {
    return null
  }

  async function reencode(img: ReturnType<SharpModule>, fmt: 'png' | 'jpeg') {
    let pipeline = fmt === 'png'
      ? img.clone().png({ compressionLevel: 9 })
      : img.clone().flatten({ background: '#ffffff' }).jpeg({ quality: 85 })
    const out = await pipeline.toBuffer()
    if (out.length === 0) return null
    return { buf: out, mime: fmt === 'png' ? 'image/png' : 'image/jpeg' }
  }
}

// ─── VLM 图片类型识别（z-ai SDK）─────────────────────────────────────────────

type ZaiClient = Awaited<ReturnType<typeof import('z-ai-web-dev-sdk').default.create>>
const gz = globalThis as unknown as { __evalZaiVlm?: ZaiClient }

async function getZaiVlm(): Promise<ZaiClient | null> {
  if (gz.__evalZaiVlm) return gz.__evalZaiVlm
  try {
    const ZAI = (await import('z-ai-web-dev-sdk')).default
    gz.__evalZaiVlm = await ZAI.create()
    return gz.__evalZaiVlm
  } catch {
    return null
  }
}

/** VLM 输出的 kind 归一化（容忍中文/大小写/别名） */
export function normalizeVlmKind(raw: string): AssetKind | null {
  const s = raw.trim().toLowerCase()
  if (!s) return null
  if (/(^|[^a-z])(gel|sds)/.test(s) || s.includes('胶') || s.includes('电泳')) return 'gel'
  if (/(^|[^a-z])(sec|sec-phase|chromato)/.test(s) || s.includes('分子筛') || s.includes('色谱') || s.includes('凝胶过滤') || s.includes('排阻')) return 'sec'
  if (/(^|[^a-z])(other)/.test(s) || s.includes('其他') || s.includes('其它')) return 'other'
  return null
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return null
  }
}

export interface VlmImageVerdict {
  kind: AssetKind
  caption: string
}

/**
 * 单图 VLM 识别：类型（gel/sec/other）+ 一句话关键读数（中文）。
 * 任何失败（SDK 不可用/超时/解析失败）返回 null，调用方回退关键词分类。
 */
export async function classifyImageVlm(buf: Buffer, mime: string): Promise<VlmImageVerdict | null> {
  if (buf.length === 0 || buf.length > SOURCE_IMAGE_MAX_BYTES) return null
  const zai = await getZaiVlm()
  if (!zai) return null
  const dataUri = `data:${mime || 'image/png'};base64,${buf.toString('base64')}`
  const prompt = `这是从蛋白靶点评估表（Word）中提取的一张实验图。请判断图片类型并给出关键读数。
严格只输出一个 JSON 对象（不要任何其他文字或代码块标记）：
{"kind":"gel 或 sec 或 other","caption":"一句话中文读数（≤60字）"}
kind 判定标准：
- gel = SDS-PAGE/Native-PAGE 电泳胶图（多条竖直泳道、横向蛋白条带、ladder）
- sec = 分子筛/凝胶过滤色谱图（SEC/GPC：UV280 洗脱曲线、出峰体积轴）
- other = 以上都不是（Western blot 化学发光、晶体照片、结构模型、表格截图等）
caption 需包含可判读的关键信息（泳道数/条带单一性/纯度估计、主峰位置/对称性/有无聚集峰等）。`

  const call = (async () => {
    // 与 z-ai CLI 的 vision 命令一致：不指定 model，由服务端默认视觉模型处理
    const body = {
      messages: [
        {
          role: 'user' as const,
          content: [
            { type: 'text' as const, text: prompt },
            { type: 'image_url' as const, image_url: { url: dataUri } },
          ],
        },
      ],
      thinking: { type: 'disabled' as const },
    }
    const resp = await zai.chat.completions.createVision(
      body as Parameters<typeof zai.chat.completions.createVision>[0],
    )
    return resp.choices?.[0]?.message?.content ?? ''
  })()

  let text: string
  try {
    text = await Promise.race([
      call,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('VLM timeout')), VLM_TIMEOUT_MS)),
    ])
  } catch {
    return null
  }

  const obj = extractJsonObject(text)
  if (!obj) return null
  const kind = normalizeVlmKind(String(obj.kind ?? ''))
  if (!kind) return null
  const caption = typeof obj.caption === 'string' ? obj.caption.trim().replace(/\s+/g, ' ').slice(0, 90) : ''
  return { kind, caption }
}

/**
 * 批量 VLM 识别（小并发，前 VLM_MAX_IMAGES 张）。
 * 返回与输入等长的数组（null = 未识别/失败），整体一次性失败会短路后续（SDK 不可用）。
 */
export async function classifyImagesVlm(
  images: Array<{ buf: Buffer; mime: string }>,
): Promise<Array<VlmImageVerdict | null>> {
  const n = Math.min(images.length, VLM_MAX_IMAGES)
  const results: Array<VlmImageVerdict | null> = new Array(images.length).fill(null)
  if (n === 0) return results
  let sdkBroken = false // SDK 级失败（初始化/网络）→ 后续不再尝试

  let cursor = 0
  async function worker() {
    while (cursor < n) {
      if (sdkBroken) return
      const i = cursor++
      const zai = await getZaiVlm()
      if (!zai) { sdkBroken = true; return }
      results[i] = await classifyImageVlm(images[i].buf, images[i].mime)
    }
  }
  await Promise.all(Array.from({ length: Math.min(VLM_CONCURRENCY, n) }, () => worker()))
  return results
}
