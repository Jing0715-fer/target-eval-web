/**
 * Word 评估表解析（mammoth）：
 *  - 文本：UniProt ID / FASTA 序列 / 基因名 / 客户目标语句
 *  - 图片：提取到磁盘（db/reports/{uploadId}/assets/），按上下文关键词分类
 *    gel（SDS-PAGE 胶图）/ sec（分子筛/凝胶排阻色谱）/ other
 * 内存策略：
 *  - docx ≤20MB（路由层校验）；mammoth 一次转换，base64 图片立即落盘释放
 *  - 单图 ≤2MB、最多保留 12 张；解析结果只保留元数据 + 文本摘要
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import mammoth from 'mammoth'
import { cleanSequence, looksLikeProteinSequence, UNIPROT_RE, type AssetKind, type DocxParsed, type ParsedImage, type ParsedSequence } from './types'

export const DOCX_MAX_BYTES = 20 * 1024 * 1024
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024
export const MAX_IMAGES = 12

const GEL_KEYWORDS = /sds[- ]?page|胶图|凝胶电泳|电泳|考马斯|coomassie|kda.*purity|purity.*kda|纯度.*%|%\s*纯度|gel\s*image|跑胶|western|wb\s*图/i
const SEC_KEYWORDS = /size[- ]?exclusion|分子筛|凝胶过滤|gel\s*filtration|superdex|increase\s*\d+|akta|fplc|sec\s*profile|sec\s*结果|sec\s*图|色谱|chromatogra|单体峰|单分散|monodisper|体积排阻|uv\s*280|mAU/i

/** 图片资产磁盘根目录 */
export function assetsRoot(uploadId: string): string {
  return path.join(process.cwd(), 'db', 'reports', uploadId, 'assets')
}

/** 提取文本中的 UniProt accession（去重，保序） */
export function extractUniprotIds(text: string): string[] {
  const found = new Set<string>()
  const re = new RegExp(UNIPROT_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    found.add(m[0].toUpperCase())
    if (found.size >= 10) break
  }
  return [...found]
}

/** 提取 FASTA / 裸蛋白序列块 */
export function extractSequences(text: string): ParsedSequence[] {
  const out: ParsedSequence[] = []
  const lines = text.split(/\r?\n/)
  let i = 0
  while (i < lines.length && out.length < 5) {
    const line = lines[i].trim()
    if (line.startsWith('>') ) {
      // FASTA 头 + 后续序列行
      const header = line.slice(1).trim().slice(0, 120)
      const body: string[] = []
      let j = i + 1
      while (j < lines.length && !lines[j].trim().startsWith('>')) {
        body.push(lines[j])
        j++
        if (body.join('').replace(/\s/g, '').length > 60000) break
      }
      const { seq } = cleanSequence(body.join(''))
      if (seq.length >= 30) {
        out.push({ header: header || `sequence_${out.length + 1}`, seq, length: seq.length })
        i = j
        continue
      }
    } else if (line.replace(/\s/g, '').length >= 40 && /^[A-Za-z\s]+$/.test(line)) {
      // 裸序列长行
      const { seq } = cleanSequence(line)
      if (seq.length >= 40 && looksLikeProteinSequence(line)) {
        out.push({ header: `sequence_${out.length + 1}`, seq, length: seq.length })
      }
    }
    i++
  }
  return out
}

/** 提取基因名：中英文字段标签后的短 token */
export function extractGenes(text: string): string[] {
  const genes = new Set<string>()
  const labelRe = /(?:基因名|基因名称|基因|gene\s*name|gene|靶点|target)\s*[:：=]\s*([A-Za-z0-9][A-Za-z0-9\-_. ]{0,30})/gi
  let m: RegExpExecArray | null
  while ((m = labelRe.exec(text))) {
    const token = m[1].trim().split(/[\s,，;；/、(|（]/)[0]
    if (token && token.length >= 2 && token.length <= 12 && /[A-Za-z]/.test(token)) {
      genes.add(token.toUpperCase())
    }
    if (genes.size >= 8) break
  }
  return [...genes]
}

/** 提取客户目标/项目需求类语句 */
export function extractGoalHints(text: string): string[] {
  const hints: string[] = []
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const goalRe = /目的|目标|需求|客户|要求|希望|拟|计划|project.*goal|objective|aim/i
  for (const line of lines) {
    if (goalRe.test(line) && line.length >= 6 && line.length <= 400) {
      hints.push(line.slice(0, 300))
      if (hints.length >= 8) break
    }
  }
  return hints
}

/** 提取紧邻图片的图注行（中文实验文档惯例：图注在图片上方、以"："结尾） */
function extractCaptionLine(prevText: string, nextText: string): { line: string; side: 'prev' | 'next' } {
  const prevLines = prevText.split('\n').map(s => s.trim()).filter(Boolean)
  const lastPrev = prevLines[prevLines.length - 1] ?? ''
  // 上方最近一行以冒号结尾 → 图注
  if (lastPrev && /[：:]\s*$/.test(lastPrev)) return { line: lastPrev, side: 'prev' }
  const nextLines = nextText.split('\n').map(s => s.trim()).filter(Boolean)
  const firstNext = nextLines[0] ?? ''
  // 下方以"图N/Fig"开头 → 图注在下方
  if (/^(图|Fig|Figure)\s*\d*/i.test(firstNext)) return { line: firstNext, side: 'next' }
  return { line: lastPrev || firstNext, side: lastPrev ? 'prev' : 'next' }
}

function firstMatchPos(re: RegExp, s: string): number {
  const m = new RegExp(re.source, re.flags).exec(s)
  return m ? m.index : -1
}

function lastMatchPos(re: RegExp, s: string): number {
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
  let last = -1
  let m: RegExpExecArray | null
  while ((m = r.exec(s))) {
    last = m.index
    if (m.index === r.lastIndex) r.lastIndex++
    if (m.index > s.length) break
  }
  return last
}

/** 根据图片上下文判定类型：图注行优先，否则按最近关键词距离 */
function classifyImage(prevText: string, nextText: string, alt: string): AssetKind {
  // 1) alt 文本（Word 里的人工替代文字，可信度最高）
  if (GEL_KEYWORDS.test(alt) && !SEC_KEYWORDS.test(alt)) return 'gel'
  if (SEC_KEYWORDS.test(alt) && !GEL_KEYWORDS.test(alt)) return 'sec'

  // 2) 图注行
  const caption = extractCaptionLine(prevText, nextText)
  const gelInCaption = GEL_KEYWORDS.test(caption.line)
  const secInCaption = SEC_KEYWORDS.test(caption.line)
  if (gelInCaption && !secInCaption) return 'gel'
  if (secInCaption && !gelInCaption) return 'sec'

  // 3) 就近关键词距离（prev 从右向左，next 从左向右）
  const dist = (re: RegExp): number => {
    const candidates: number[] = []
    const lp = lastMatchPos(re, prevText)
    if (lp >= 0) candidates.push(prevText.length - lp)
    const fp = firstMatchPos(re, nextText)
    if (fp >= 0) candidates.push(fp)
    return candidates.length ? Math.min(...candidates) : Infinity
  }
  const dGel = dist(GEL_KEYWORDS)
  const dSec = dist(SEC_KEYWORDS)
  if (dGel === Infinity && dSec === Infinity) return 'other'
  if (dGel === dSec) return 'gel'
  return dGel < dSec ? 'gel' : 'sec'
}

export interface DocxParseOptions {
  /** 已有 uploadId（复用目录）；不传则内部生成 */
  uploadId?: string
}

/**
 * 解析 .docx Buffer。图片写入磁盘，返回精简解析结果。
 * 失败抛 Error（路由层兜底）。
 */
export async function parseDocx(buffer: Buffer, opts: DocxParseOptions = {}): Promise<{ uploadId: string; parsed: DocxParsed }> {
  const uploadId = opts.uploadId ?? `u_${randomUUID().slice(0, 12)}`
  const dir = assetsRoot(uploadId)
  await fs.mkdir(dir, { recursive: true })

  // mammoth：图片转成占位 token，转完再按 token 切分 HTML 取上下文
  const images: Array<{ token: string; mime: string; buf: Buffer; alt: string; idx: number }> = []
  let imgIdx = 0
  const { value: html } = await mammoth.convertToHtml(
    { buffer },
    {
      convertImage: mammoth.images.imgElement(async (image) => {
        const idx = imgIdx++
        const token = `__EVAL_IMG_${idx}__`
        try {
          // readAsBase64String 返回纯 base64（无 data: 前缀），mime 在 contentType
          const b64 = await image.readAsBase64String()
          const mime = String(image.contentType || 'image/png')
          const buf = Buffer.from(String(b64 || ''), 'base64')
          const altRaw = image.altText
          const alt = (typeof altRaw === 'string' ? altRaw : String((altRaw as { value?: string })?.value ?? '')).trim().slice(0, 80)
          if (buf.length > 0 && buf.length <= IMAGE_MAX_BYTES && /^image\/(png|jpe?g|gif|webp|bmp|tiff)$/i.test(mime)) {
            images.push({ token, mime, buf, alt, idx })
          }
        } catch { /* 图片读取失败跳过 */ }
        return { src: token }
      }),
    },
  )

  // 按 token 切分 → [text, IMG, text, IMG, ...]
  const parts = html.split(/(__EVAL_IMG_\d+__)/)
  const textChunks: string[] = []
  const imageMeta: Array<{ token: string; prevText: string; nextText: string; alt: string; mime: string; buf: Buffer }> = []
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    const tokenMatch = p.match(/^__EVAL_IMG_(\d+)__$/)
    if (tokenMatch) {
      const img = images.find(x => x.idx === parseInt(tokenMatch[1], 10))
      if (img) {
        // 只取紧邻的前/后文本段（跨图片的旧文本会污染分类上下文）
        const prevText = stripHtml(parts[i - 1] ?? '')
        const nextText = stripHtml(parts[i + 1] ?? '')
        imageMeta.push({ token: img.token, prevText, nextText, alt: img.alt, mime: img.mime, buf: img.buf })
      }
    } else {
      textChunks.push(p)
    }
  }

  const fullText = stripHtml(textChunks.join('\n'))

  // 图片落盘（仅保留前 MAX_IMAGES 张有效图，gel/sec 优先）
  const kept = imageMeta.slice(0, MAX_IMAGES)
  const parsedImages: ParsedImage[] = []
  for (let i = 0; i < kept.length; i++) {
    const im = kept[i]
    const kind = classifyImage(im.prevText, im.nextText, im.alt)
    const ext = im.mime.includes('png') ? 'png' : im.mime.includes('gif') ? 'gif' : im.mime.includes('webp') ? 'webp' : 'jpg'
    const id = `a_${randomUUID().slice(0, 12)}`
    await fs.writeFile(path.join(dir, `${id}.${ext}`), im.buf)
    const caption = buildCaption(im.prevText, im.nextText, im.alt, kind)
    parsedImages.push({ id, kind, caption, mime: im.mime, sizeKB: Math.round(im.buf.length / 1024) })
  }

  const parsed: DocxParsed = {
    uniprotIds: extractUniprotIds(fullText),
    sequences: extractSequences(fullText),
    genes: extractGenes(fullText),
    docTextSummary: fullText.replace(/\s+/g, ' ').trim().slice(0, 500),
    images: parsedImages,
    goalHints: extractGoalHints(fullText),
  }
  return { uploadId, parsed }
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|tr|li)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')          // 完整标签
    .replace(/<[a-zA-Z][^>]*$/g, ' ')  // 末尾未闭合标签片段（如 '<img src="'）
    .replace(/^\s*"[^"]*"\s*\/?>/g, ' ') // 开头残留属性尾巴（如 '" />'）
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
}

/** 从图片上下文生成 caption（图注行优先） */
function buildCaption(prevText: string, nextText: string, alt: string, kind: AssetKind): string {
  const kindZh = kind === 'gel' ? 'SDS-PAGE 胶图' : kind === 'sec' ? 'SEC 分子筛色谱图' : '图片'
  const altText = alt && !/^(picture|image|img|图\d*|照片)$/i.test(alt) ? alt : ''
  // 图注行（classifyImage 同款逻辑）优先
  const caption = extractCaptionLine(prevText, nextText)
  let cap = ''
  if (caption.line && caption.line.length <= 120) {
    cap = caption.line.replace(/[：:]\s*$/, '').trim()
  }
  if (!cap) cap = altText
  return `${kindZh}${cap ? ` — ${cap.slice(0, 80)}` : ''}`
}
