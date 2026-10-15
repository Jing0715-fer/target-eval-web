/**
 * PubMed eutils — 靶点相关结构生物学文献检索。
 * 策略：基因名/蛋白名 + 结构方法关键词 esearch（按相关性，取 ~15 条）→ efetch 解析。
 * 内存策略：esearch retmax 20、efetch 每批 20 条、摘要截断 400 字。
 */
import type { LiteratureItem } from './types'

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils'

function decodeEntities(str: string): string {
  if (!str) return str
  return str
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
}

export async function searchPubmed(
  query: string,
  max = 18,
): Promise<LiteratureItem[]> {
  // 1) esearch
  const esearchUrl = new URL(`${EUTILS}/esearch.fcgi`)
  esearchUrl.searchParams.set('db', 'pubmed')
  esearchUrl.searchParams.set('term', query)
  esearchUrl.searchParams.set('retmax', String(max))
  esearchUrl.searchParams.set('retmode', 'json')
  esearchUrl.searchParams.set('sort', 'relevance')
  let pmids: string[] = []
  const searchRes = await fetch(esearchUrl.toString(), {
    headers: { 'User-Agent': 'target-eval-web/1.0' },
    signal: AbortSignal.timeout(25_000),
  })
  if (searchRes.ok) {
    const j = await searchRes.json() as { esearchresult?: { idlist?: string[] } }
    pmids = j.esearchresult?.idlist ?? []
  }
  if (pmids.length === 0) return []

  // 2) efetch（每批 20，批间 400ms 防 429）
  const out: LiteratureItem[] = []
  for (let i = 0; i < pmids.length; i += 20) {
    const batch = pmids.slice(i, i + 20)
    const url = new URL(`${EUTILS}/efetch.fcgi`)
    url.searchParams.set('db', 'pubmed')
    url.searchParams.set('id', batch.join(','))
    url.searchParams.set('rettype', 'xml')
    url.searchParams.set('retmode', 'xml')
    try {
      const res = await fetch(url.toString(), {
        headers: { 'User-Agent': 'target-eval-web/1.0' },
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) continue
      const xml = await res.text()
      const chunks = xml.split('<PubmedArticle>').slice(1)
      for (const chunk of chunks) {
        const end = chunk.indexOf('</PubmedArticle>')
        if (end < 0) continue
        const item = parseArticle(chunk.slice(0, end))
        if (item) out.push(item)
      }
    } catch { /* 批次失败忽略 */ }
    if (i + 20 < pmids.length) await new Promise(r => setTimeout(r, 400))
  }
  return out
}

function parseArticle(xml: string): LiteratureItem | null {
  const pmid = xml.match(/<PMID[^>]*>([\s\S]*?)<\/PMID>/)?.[1]?.trim()
  if (!pmid) return null
  const title = decodeEntities(
    xml.match(/<ArticleTitle[^>]*>([\s\S]*?)<\/ArticleTitle>/)?.[1]?.replace(/<[^>]+>/g, '').trim() ?? '',
  )
  const journal = decodeEntities(
    xml.match(/<Journal>[\s\S]*?<Title[^>]*>([\s\S]*?)<\/Title>/)?.[1]?.trim() ?? '',
  )
  const pubXml = xml.match(/<PubDate[^>]*>([\s\S]*?)<\/PubDate>/)?.[1] ?? ''
  const year = pubXml.match(/<Year[^>]*>(\d{4})</)?.[1]
    ?? pubXml.match(/<MedlineDate[^>]*>(\d{4})/)?.[1]
    ?? ''
  const doi = xml.match(/<ArticleId[^>]*IdType="doi"[^>]*>([\s\S]*?)<\/ArticleId>/)?.[1]?.trim() ?? ''
  const abstractMatch = xml.match(/<Abstract[^>]*>([\s\S]*?)<\/Abstract>/)
  let abstractExcerpt = ''
  if (abstractMatch) {
    const parts: string[] = []
    const txtRe = /<AbstractText(?:\s+Label="([^"]*)")?[^>]*>([\s\S]*?)<\/AbstractText>/g
    let mm: RegExpExecArray | null
    while ((mm = txtRe.exec(abstractMatch[1]))) {
      const text = decodeEntities(mm[2].replace(/<[^>]+>/g, '').trim())
      parts.push(mm[1] ? `${mm[1]}: ${text}` : text)
    }
    abstractExcerpt = parts.join(' ').slice(0, 400)
  }
  return { pmid, title, journal, year, doi, abstractExcerpt }
}

/** 构造靶点结构生物学文献检索式 */
export function buildLiteratureQuery(geneNames: string[], proteinName: string, organism: string): string {
  const primary = geneNames[0] || proteinName.split(/[ ,(]/)[0] || ''
  if (!primary) return ''
  const gene = primary.replace(/[^\w-]/g, '')
  // 种属限定（人/小鼠等常见模式生物直接映射，否则不限定）
  const orgTag = /Homo sapiens|human/i.test(organism) ? ' AND (human[Title/Abstract] OR "Homo sapiens"[Organism])' : ''
  return `(${gene}[Title/Abstract] OR ${gene} protein[All Fields])${orgTag} AND `
    + `(("protein structure"[Title/Abstract] OR "crystal structure"[Title/Abstract] OR "cryo-EM"[Title/Abstract] `
    + `OR "cryo-electron microscopy"[Title/Abstract] OR "X-ray crystallography"[Title/Abstract] `
    + `OR "NMR structure"[Title/Abstract] OR "structural basis"[Title/Abstract] `
    + `OR inhibitor[Title/Abstract] OR "structure-based design"[Title/Abstract]))`
}
