#!/usr/bin/env python3
"""Batch restyle of table components: stone/emerald -> Linear neutral/lavender tokens.
Only className strings are replaced; logic untouched."""

import re
from pathlib import Path

FILES = [
    "src/components/eval/pdb-table.tsx",
    "src/components/eval/blast-table.tsx",
    "src/components/eval/literature-list.tsx",
    "src/components/eval/asset-gallery.tsx",
    "src/components/eval/shared-pdb-table.tsx",
    "src/components/eval/interaction-structures.tsx",
]

# Ordered (longest first) literal replacements
REPL = [
    # outer card containers
    ("overflow-hidden rounded-lg border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900",
     "overflow-hidden rounded-xl border border-border bg-card"),
    ("rounded-lg border border-stone-200 bg-white p-4 sm:p-5 dark:border-stone-800 dark:bg-stone-900",
     "rounded-xl border border-border bg-card p-4 sm:p-5"),
    # shared structures green panel
    ("flex flex-col gap-2 rounded-lg border border-emerald-200 bg-gradient-to-b from-emerald-50/70 to-white p-3.5 dark:border-emerald-900 dark:from-emerald-950/30 dark:to-stone-900",
     "flex flex-col gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/[0.05] p-3.5"),
    # complex header pills
    ("rounded-sm bg-teal-800 px-2.5 py-1 font-mono text-[10.5px] font-bold tracking-wide text-white dark:bg-teal-700",
     "rounded-md bg-teal-600 px-2.5 py-1 font-mono text-[10.5px] font-bold tracking-wide text-white dark:bg-teal-700"),
    ("rounded-sm bg-emerald-900 px-2 py-0.5 font-mono text-[10.5px] font-bold text-white dark:bg-emerald-800",
     "rounded-md bg-emerald-600 px-2 py-0.5 font-mono text-[10.5px] font-bold text-white dark:bg-emerald-700"),
    # table row hover
    ("border-stone-100 dark:border-stone-800/60 hover:bg-stone-50/70 dark:hover:bg-stone-800/40",
     "border-border/60 hover:bg-accent/50"),
    # table head bg
    ("bg-stone-50 dark:bg-stone-900", "bg-muted/60"),
    ("bg-stone-50 dark:bg-stone-900/80", "bg-muted/60"),
    # links emerald -> primary
    ("text-emerald-800 underline-offset-2 hover:underline dark:text-emerald-400",
     "text-primary underline-offset-2 hover:underline"),
    ("font-semibold text-emerald-800 hover:underline dark:text-emerald-400",
     "font-semibold text-primary hover:underline"),
    ("hover:text-emerald-800 dark:text-stone-50 dark:hover:text-emerald-400",
     "hover:text-primary dark:text-stone-50 dark:hover:text-primary"),
    ("text-emerald-800 hover:underline dark:text-emerald-400",
     "text-primary hover:underline"),
    # cell text tones
    ("text-stone-600 dark:text-stone-400", "text-foreground/80"),
    ("text-stone-600 dark:text-stone-300", "text-foreground/80"),
    ("text-stone-700 dark:text-stone-300", "text-foreground/90"),
    ("text-stone-500 dark:text-stone-400", "text-muted-foreground"),
    ("text-stone-500 dark:text-stone-500", "text-muted-foreground"),
    ("text-stone-400 dark:text-stone-500", "text-muted-foreground/70"),
    ("text-stone-400 dark:text-stone-600", "text-muted-foreground/50"),
    ("text-stone-300 dark:text-stone-600", "text-muted-foreground/40"),
    ("text-stone-700 dark:text-stone-400", "text-muted-foreground"),
    ("text-stone-800 dark:text-stone-200", "text-foreground"),
    ("text-stone-900 dark:text-stone-50", "text-foreground"),
    # borders
    ("border-stone-100 dark:border-stone-800/60", "border-border/60"),
    ("border-stone-200 dark:border-stone-800", "border-border"),
    ("divide-stone-100 dark:divide-stone-800/60", "divide-border/60"),
    ("border-b border-stone-100 px-4 py-3 dark:border-stone-800",
     "border-b border-border/70 px-4 py-3"),
    ("border-t border-stone-100 px-3.5 py-2.5 dark:border-stone-800/60",
     "border-t border-border/70 px-3.5 py-2.5"),
    # fold / details summary
    ("border-b border-stone-200 bg-stone-50 px-3.5 py-2 text-[11px] font-medium text-emerald-800 list-none transition-colors hover:bg-stone-100 dark:border-stone-800 dark:bg-stone-900/80 dark:text-emerald-500 dark:hover:bg-stone-800/60",
     "border-b border-border bg-muted/50 px-3.5 py-2 text-[11px] font-medium text-primary list-none transition-colors hover:bg-muted [&::-webkit-details-marker]:hidden"),
    # focus rings
    ("focus-visible:ring-emerald-500/40", "focus-visible:ring-ring/30"),
    # neutral chips
    ("border-stone-200 bg-stone-50 px-2 py-0.5 font-mono text-[10.5px] text-stone-600 dark:border-stone-700 dark:bg-stone-800/60 dark:text-stone-300",
     "border-border bg-muted/60 px-2 py-0.5 font-mono text-[10.5px] text-foreground/80"),
    ("border-stone-200 bg-stone-50 text-stone-500 dark:border-stone-700 dark:bg-stone-800/60 dark:text-stone-400",
     "border-border bg-muted text-muted-foreground"),
    ("border-stone-200 bg-stone-50 px-1.5 py-px font-mono text-[10px] text-stone-500 dark:border-stone-700 dark:text-stone-400",
     "border-border bg-muted px-1.5 py-px font-mono text-[10px] text-muted-foreground"),
    # emerald chips -> primary tinted
    ("border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-400",
     "border-primary/30 bg-primary/[0.06] px-1.5 py-0.5 text-[10px] font-semibold text-primary"),
    ("border-emerald-200 bg-emerald-50 px-1.5 py-px text-[10px] font-semibold text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-400",
     "border-primary/30 bg-primary/[0.06] px-1.5 py-px text-[10px] font-semibold text-primary"),
    ("border-emerald-200 bg-emerald-50 px-1.5 py-0.5 font-mono text-[11px] text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-400",
     "border-primary/30 bg-primary/[0.06] px-1.5 py-0.5 font-mono text-[11px] text-primary"),
    # teal chips
    ("border-teal-300 bg-white/60 px-1.5 py-0.5 font-mono text-[10px] text-teal-700 dark:border-teal-800 dark:bg-teal-950/40 dark:text-teal-300",
     "border-teal-500/40 bg-card/60 px-1.5 py-0.5 font-mono text-[10px] text-teal-700 dark:text-teal-300"),
    # amber dashed chips
    ("border-dashed border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-400",
     "border-dashed border-amber-500/40 bg-amber-500/[0.07] px-1.5 py-0.5 text-[11px] text-amber-700 dark:text-amber-400"),
    # target highlight
    ("bg-emerald-50/80 dark:bg-emerald-950/30", "bg-primary/[0.05]"),
    ("text-emerald-800 dark:text-emerald-400", "text-primary"),
    ("text-emerald-800 dark:text-emerald-500", "text-primary"),
    # misc emerald icons
    ("text-emerald-700 dark:text-emerald-500", "text-primary"),
    ("text-emerald-800 dark:text-emerald-300", "text-emerald-700 dark:text-emerald-300"),
    ("text-emerald-900 dark:text-emerald-300", "text-emerald-700 dark:text-emerald-300"),
    ("text-emerald-800 dark:text-emerald-400", "text-primary"),
    # scaffold / secondary surfaces
    ("border-stone-100 bg-stone-50/40 p-2.5 dark:border-stone-800/60 dark:bg-stone-900/40",
     "border-border/70 bg-muted/40 p-2.5"),
    ("bg-stone-100 dark:bg-stone-800", "bg-muted"),
    ("border-stone-200 bg-white shadow-none transition-colors hover:border-emerald-300 focus-visible:ring-[3px] focus-visible:ring-emerald-500/40 focus-visible:outline-none dark:border-stone-800 dark:bg-stone-900 dark:hover:border-emerald-700",
     "border-border bg-card shadow-none transition-colors hover:border-ring/60 focus-visible:ring-[3px] focus-visible:ring-ring/30 focus-visible:outline-none"),
    ("border-stone-200 bg-white dark:border-stone-800", "border-border bg-card"),
    # gallery img dialog
    ("rounded-lg border border-stone-200 bg-stone-50 object-contain dark:border-stone-800 dark:bg-stone-950",
     "rounded-xl border border-border bg-muted object-contain"),
]

def main():
    root = Path("/home/z/my-project")
    for rel in FILES:
        p = root / rel
        src = p.read_text(encoding="utf-8")
        orig = src
        for old, new in REPL:
            src = src.replace(old, new)
        # specific: interaction-structures cxTh
        src = src.replace(
            "const cxTh = 'eval-eyebrow h-9 text-left text-stone-500 dark:text-stone-400'",
            "const cxTh = 'eval-eyebrow h-9 text-left text-muted-foreground'",
        )
        if src != orig:
            p.write_text(src, encoding="utf-8")
            print(f"restyled: {rel}")
        else:
            print(f"unchanged: {rel}")

if __name__ == "__main__":
    main()
