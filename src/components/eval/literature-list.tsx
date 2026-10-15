'use client'

import { motion } from 'framer-motion'
import { BookOpen, ExternalLink } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import type { LiteratureItem } from './types'

/** 文献列表：标题（PubMed 链接）· 期刊年份 · DOI · PMID badge */
export function LiteratureList({ items }: { items: LiteratureItem[] }) {
  return (
    <Card className="gap-0 overflow-hidden rounded-xl border-stone-200 bg-white shadow-sm dark:border-stone-800 dark:bg-stone-900">
      <CardContent className="divide-y divide-stone-100 px-0 dark:divide-stone-800">
        {items.map((it, i) => (
          <motion.a
            key={it.pmid || `${it.title}-${i}`}
            href={it.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${it.pmid}/` : undefined}
            target="_blank"
            rel="noreferrer"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, delay: Math.min(i * 0.035, 0.35), ease: 'easeOut' }}
            className="flex items-start gap-3 px-5 py-3.5 transition-colors hover:bg-stone-50/80 dark:hover:bg-stone-900/60"
          >
            <BookOpen className="mt-0.5 size-4 shrink-0 text-stone-300 dark:text-stone-600" />
            <div className="min-w-0 flex-1">
              <p className="text-sm leading-snug font-medium text-stone-800 hover:text-emerald-700 dark:text-stone-200 dark:hover:text-emerald-400">
                {it.title || '无标题文献'}
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-stone-500 dark:text-stone-500">
                {it.journal && <span className="italic">{it.journal}</span>}
                {it.year && <span>{it.journal ? '· ' : ''}{it.year}</span>}
                {it.doi && (
                  <span className="truncate font-mono text-[11px] text-stone-400" title={it.doi}>
                    DOI: {it.doi}
                  </span>
                )}
                {it.pmid && (
                  <Badge
                    variant="outline"
                    className="ml-auto border-stone-300 bg-stone-50 text-[10px] font-mono text-stone-600 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-400"
                  >
                    PMID {it.pmid}
                  </Badge>
                )}
              </div>
            </div>
            <ExternalLink className="mt-1 size-3.5 shrink-0 text-stone-300 dark:text-stone-600" />
          </motion.a>
        ))}
      </CardContent>
    </Card>
  )
}
