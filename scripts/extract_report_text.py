#!/usr/bin/env python3
"""Extract readable text from the uploaded TargetEval report HTML (strip base64 imgs + tags)."""
import re, sys

src = '/home/z/my-project/upload/TargetEval_O94952_2026-11-14.html'
out = '/home/z/my-project/scripts/report_text.txt'

h = open(src, encoding='utf-8').read()
h = re.sub(r'data:image/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+', '[IMG_B64]', h)
h = re.sub(r'<style[\s\S]*?</style>', '[STYLE]', h)
# keep img tags with attributes for later inspection
h = re.sub(r'<img([^>]*)>', r'<img\1 />', h)
t = re.sub(r'</(div|p|li|h[1-6]|tr|table|figure|figcaption|section|header|footer|blockquote|details|summary)>', '\n', h)
t = re.sub(r'<(br|hr)\s*/?>', '\n', t)
t = re.sub(r'<[^>]+>', ' ', t)
t = re.sub(r'[ \t]+', ' ', t)
lines = [ln.strip() for ln in t.splitlines() if ln.strip()]

open(out, 'w', encoding='utf-8').write('\n'.join(lines))
print(f'lines={len(lines)} chars={sum(map(len, lines))}')
print('IMG tags:')
for m in re.finditer(r'<img[^>]*>', h):
    tag = m.group(0)
    if '[IMG_B64]' in tag:
        tag = tag[:200]
    print(' ', tag)
