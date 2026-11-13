/**
 * Word 评估表解析（mammoth）：
 *  - 文本：UniProt ID / FASTA 序列 / 基因名 / 客户目标语句
 *  - 图片：提取到磁盘（db/reports/{uploadId}/assets/），归一化后分类
 *    gel（SDS-PAGE 胶图）/ sec（分子筛/凝胶排阻色谱）/ other
 *  - 图片管线：EMF/WMF → PNG（LibreOffice）、TIFF/BMP 归一、大图降采样（sharp）、
 *    VLM 识别类型与读数（关键词分类兜底），支持/超限图片计入 skippedImages
 * 内存策略：
 *  - docx ≤20MB（路由层校验）；mammoth 一次转换，base64 图片立即转存释放
 *  - 原始单图 ≤6MB、处理后落盘 ≤12 张且每张有界；解析结果只保留元数据 + 文本摘要
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import mammoth from 'mammoth'
import { looksLikeProteinSequence, UNIPROT_RE, type AssetKind, type DocxParsed, type ParsedImage, type ParsedSequence } from './types'
import { detectAntibody } from './antibody'
import { classifyImagesVlm, convertMetafilesToPng, normalizeRasterImage, SOURCE_IMAGE_MAX_BYTES } from './image-process'

export const DOCX_MAX_BYTES = 20 * 1024 * 1024
export const IMAGE_MAX_BYTES = SOURCE_IMAGE_MAX_BYTES
export const MAX_IMAGES = 12

/** mammoth 阶段接受的图片 mime（原始缓冲，归一化前） */
const ACCEPT_MIME_RE = /^image\/(png|jpe?g|gif|webp|bmp|tiff?|x-emf|x-wmf|emf|wmf)$/i
const METAFILE_MIME_RE = /(?:^|\/)(?:x-)?(?:emf|wmf)$/i

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

/** CJK / 全角字符 — 出现即判定该行不是序列行（FASTA 正文终止），防止中文段落中的拉丁词混入序列 */
const CJK_RE = /[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/

/** 一次提取的序列条数上限（评估表通常 ≤ 4 条：靶点 + 抗体重轻链 + 构建） */
const MAX_SEQUENCES = 6
/** 裸序列单行最小长度（折行尾行可更短，由合并逻辑兜底） */
const MIN_BARE_LEN = 30
/** 典型折行宽度区间：上一行长度落在区间内 → 下一行视为同一序列的折行延续 */
const WRAP_MIN = 55
const WRAP_MAX = 110

/**
 * 裸序列候选行：仅字母 + 空格，允许结尾 1-2 个 `*`（终止符标记）。
 * 数字/标点/CJK 出现即排除 —— 防止英文句子、构建描述（"EBOV GPΔMuc 33-308;490-656"）混入。
 */
function isBareSequenceLine(raw: string): boolean {
  const s = raw.trim()
  if (s === '' || CJK_RE.test(s)) return false
  const stripped = s.replace(/\s/g, '')
  if (stripped.length < MIN_BARE_LEN) return false
  return /^[A-Za-z]+\*{0,2}$/.test(stripped)
}

/**
 * 序列标签：取序列行上方最近的非空行。
 * 合格标签：≤60 字、自身不是序列行、不含句读（。.！!？?）。
 * 如 "1C9-Fc"、"EBOV GPΔMuc 33-308;490-656 -GCN 4 -His-SA"、"GP序列："。
 */
function findSequenceLabel(lines: string[], seqIdx: number): string {
  for (let k = seqIdx - 1; k >= 0 && k >= seqIdx - 2; k--) {
    const s = lines[k]?.trim()
    if (!s) continue
    if (isBareSequenceLine(s) || s.startsWith('>')) return ''
    if (s.length > 60 || /[.。！!？?]/.test(s)) return ''
    return s.replace(/[：:]\s*$/, '').slice(0, 60)
  }
  return ''
}

/** 提取 FASTA / 裸蛋白序列块（支持多条、折行合并、`*` 终止符、重复去重） */
export function extractSequences(text: string): ParsedSequence[] {
  const out: ParsedSequence[] = []
  const seen = new Set<string>() // 完整序列去重（文档重复粘贴）
  const lines = text.split(/\r?\n/)

  const emit = (header: string, seqRaw: string): boolean => {
    // 去掉结尾终止符/间隔符（BLAST 与比对均不接受 `*`）
    const seq = seqRaw.toUpperCase().replace(/[\s]+/g, '').replace(/[*-]+$/, '')
    if (seq.length < 30 || !looksLikeProteinSequence(seq)) return false
    if (seen.has(seq)) return true // 重复序列：视为已处理，不再入列
    seen.add(seq)
    // 序列角色标记：抗体序列（Fab/Fc/scFv/VHH 等）自动跳过 BLAST，UI 徽标展示
    const ab = detectAntibody(seq, header)
    out.push({
      header: (header.trim() || `sequence_${out.length + 1}`).slice(0, 80),
      seq,
      length: seq.length,
      role: ab.isAntibody ? 'antibody' : 'antigen',
    })
    return true
  }

  let i = 0
  while (i < lines.length && out.length < MAX_SEQUENCES) {
    const line = lines[i].trim()
    if (line.startsWith('>')) {
      // FASTA 头 + 后续序列行（遇到中文/全角内容行或下一个头即终止）
      const header = line.slice(1).trim().slice(0, 120)
      const body: string[] = []
      let j = i + 1
      while (j < lines.length && !lines[j].trim().startsWith('>')) {
        const ln = lines[j].trim()
        if (ln !== '') {
          if (CJK_RE.test(ln)) break // 中文/全角行 → FASTA 正文结束
          body.push(ln)
        }
        j++
        if (body.join('').replace(/\s/g, '').length > 60000) break
      }
      if (!emit(header, body.join(''))) {
        i = i + 1 // body 无效 → 逐行重扫（body 内可能有裸序列）
        continue
      }
      i = j
      continue
    }
    if (isBareSequenceLine(line)) {
      // 裸序列块：连续候选行，若上一行长度是典型折行宽度（55-110）则视为同一序列折行合并；
      // 更长的行（如完整序列）之后的候选行按新序列处理（防表格相邻单元格两条独立序列被误合并）
      const block: string[] = [line]
      const blockIdx: number[] = [i]
      let j = i + 1
      while (j < lines.length && out.length < MAX_SEQUENCES) {
        const nxt = lines[j].trim()
        if (!nxt || !isBareSequenceLine(nxt)) break // 空行/非候选行 → 块终止
        const prevLen = block[block.length - 1].replace(/\s/g, '').length
        if (prevLen < WRAP_MIN || prevLen > WRAP_MAX) break
        block.push(nxt)
        blockIdx.push(j)
        j++
      }
      const label = findSequenceLabel(lines, i)
      if (!emit(label, block.join(''))) {
        // 合并后不是蛋白序列（可能是被折行的英文段落）→ 逐行独立判定，保住真实的单行序列
        block.forEach((ln, bi) => {
          if (out.length >= MAX_SEQUENCES) return
          if (ln.replace(/\s/g, '').length >= 40) emit(findSequenceLabel(lines, blockIdx[bi]), ln)
        })
      }
      i = j
      continue
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

/** 清理图注行的 HTML 残留（如 " /> 属性尾巴）与纯标点噪音；无有效内容返回 '' */
function cleanCaptionLine(line: string): string {
  const s = line
    .replace(/^[\s"'<>\/=]+/, '')
    .replace(/[\s"'<>\/=]+$/, '')
    .replace(/[         ]+/g, ' ')
    .trim()
  if (s.length < 4) return ''
  if (!/[\u4e00-\u9fff]|[A-Za-z]{3,}|\d/.test(s)) return ''
  return s
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
  /** 跳过 VLM 识别（仅关键词分类；测试/降级用） */
  noVlm?: boolean
}

/** 解析中的图片中间态（归一化前后字段可变） */
interface RawImage {
  token: string
  mime: string
  buf: Buffer
  alt: string
  prevText: string
  nextText: string
  /** 处理失败（转换/解码失败）→ 计入跳过 */
  skip: boolean
}

/**
 * 解析 .docx Buffer。图片归一化后写磁盘，返回精简解析结果。
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
          // mammoth Image 类型未声明 altText（部分版本存在），安全取值
          const altRaw = (image as { altText?: { value?: string } | string }).altText
          const alt = (typeof altRaw === 'string' ? altRaw : String(altRaw?.value ?? '')).trim().slice(0, 80)
          // 接受 png/jpg/gif/webp/bmp/tiff/emf/wmf（后两类归一化处理），原始 ≤6MB
          if (buf.length > 0 && buf.length <= SOURCE_IMAGE_MAX_BYTES && ACCEPT_MIME_RE.test(mime)) {
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
  const imageMeta: RawImage[] = []
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    const tokenMatch = p.match(/^__EVAL_IMG_(\d+)__$/)
    if (tokenMatch) {
      const img = images.find(x => x.idx === parseInt(tokenMatch[1], 10))
      if (img) {
        // 只取紧邻的前/后文本段（跨图片的旧文本会污染分类上下文）
        const prevText = stripHtml(parts[i - 1] ?? '')
        const nextText = stripHtml(parts[i + 1] ?? '')
        imageMeta.push({ token: img.token, prevText, nextText, alt: img.alt, mime: img.mime, buf: img.buf, skip: false })
      }
    } else {
      textChunks.push(p)
    }
  }

  const fullText = stripHtml(textChunks.join('\n'))

  // ── 图片归一化：EMF/WMF 批量转 PNG（LibreOffice）→ TIFF/BMP/大图 sharp 处理 ──
  const metaIdx = imageMeta
    .map((im, i) => ({ im, i }))
    .filter(x => METAFILE_MIME_RE.test(x.im.mime))
  if (metaIdx.length > 0) {
    const converted = await convertMetafilesToPng(
      metaIdx.map(x => ({ buf: x.im.buf, ext: /wmf/i.test(x.im.mime) ? 'wmf' : 'emf' })),
    )
    metaIdx.forEach((x, j) => {
      if (converted[j]) {
        x.im.buf = converted[j] as Buffer
        x.im.mime = 'image/png'
      } else {
        x.im.skip = true // 转换失败（soffice 不可用/超时/损坏）
      }
    })
  }
  for (const im of imageMeta) {
    if (im.skip) continue
    const norm = await normalizeRasterImage(im.buf, im.mime)
    if (!norm) {
      im.skip = true // 解码失败/格式不支持
      continue
    }
    im.buf = norm.buf
    im.mime = norm.mime
  }
  const skippedImages = imageMeta.filter(x => x.skip).length

  // ── 分类与落盘（保留前 MAX_IMAGES 张有效图）──
  const kept = imageMeta.filter(x => !x.skip).slice(0, MAX_IMAGES)
  const keywordKinds = kept.map(im => classifyImage(im.prevText, im.nextText, im.alt))
  // VLM 识别（类型 + 读数）；失败/不可用回退关键词分类
  const vlmVerdicts = opts.noVlm
    ? []
    : await classifyImagesVlm(kept.map(im => ({ buf: im.buf, mime: im.mime })))

  const parsedImages: ParsedImage[] = []
  for (let i = 0; i < kept.length; i++) {
    const im = kept[i]
    const verdict = vlmVerdicts[i]
    // 类型判定合并：VLM 明确识别为 gel/sec 时以视觉为准；
    // VLM 判 other（示意图/不确定）时尊重文档上下文关键词（图注标注，作者意图），
    // AI 读数仍保留在图注中；VLM 失败（null）回退关键词分类。
    const kind = verdict
      ? (verdict.kind !== 'other' ? verdict.kind : keywordKinds[i])
      : keywordKinds[i]
    const ext = im.mime.includes('png') ? 'png' : im.mime.includes('gif') ? 'gif' : im.mime.includes('webp') ? 'webp' : 'jpg'
    const id = `a_${randomUUID().slice(0, 12)}`
    await fs.writeFile(path.join(dir, `${id}.${ext}`), im.buf)
    const caption = buildCaption(im.prevText, im.nextText, im.alt, kind, verdict?.caption)
    parsedImages.push({ id, kind, caption, mime: im.mime, sizeKB: Math.round(im.buf.length / 1024), vlmKind: Boolean(verdict) })
  }

  const parsed: DocxParsed = {
    uniprotIds: extractUniprotIds(fullText),
    sequences: extractSequences(fullText),
    genes: extractGenes(fullText),
    docTextSummary: fullText.replace(/\s+/g, ' ').trim().slice(0, 500),
    images: parsedImages,
    skippedImages: skippedImages > 0 ? skippedImages : undefined,
    goalHints: extractGoalHints(fullText),
    docTitle: fullText.split('\n').map(s => s.trim()).find(s => s.length >= 4 && s.length <= 80) ?? undefined,
    fullText: fullText.slice(0, 14000),
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

/** 从图片上下文生成展示图注：类型 + 文档图注原文 + AI 读数 */
function buildCaption(prevText: string, nextText: string, alt: string, kind: AssetKind, vlmCaption?: string): string {
  const kindZh = kind === 'gel' ? 'SDS-PAGE 胶图' : kind === 'sec' ? 'SEC 分子筛色谱图' : '实验图片'
  const altText = alt && !/^(picture|image|img|图\d*|照片)$/i.test(alt) ? alt : ''
  // 图注行（classifyImage 同款逻辑）优先；清理 HTML 残留后无有效内容则不用
  const caption = extractCaptionLine(prevText, nextText)
  let cap = ''
  if (caption.line && caption.line.length <= 120) {
    cap = cleanCaptionLine(caption.line.replace(/[：:]\s*$/, ''))
  }
  if (!cap) cap = altText
  const parts: string[] = []
  if (cap) parts.push(cap.slice(0, 90))
  if (vlmCaption) parts.push(`AI 读数：${vlmCaption}`)
  return `${kindZh}${parts.length ? ` — ${parts.join('；')}` : ''}`
}
