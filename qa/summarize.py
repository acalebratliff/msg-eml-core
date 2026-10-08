"""Summarise a run_corpus.sh output folder as a Markdown table.

usage: python summarize.py <samples-dir> <out-dir> [baseline.md]
baseline.md: the earlier runtime-test report; its summary table's last
column is read as the "before" verdict.
"""
import glob
import json
import os
import re
import sys

samples, out = sys.argv[1], sys.argv[2]
baseline = {}
if len(sys.argv) > 3 and os.path.exists(sys.argv[3]):
    for line in open(sys.argv[3], encoding='utf-8'):
        cells = [c.strip() for c in line.strip().strip('|').split('|')]
        if len(cells) >= 8 and cells[-1] in ('PASS', 'PARTIAL', 'FAIL'):
            baseline[cells[0]] = cells[-1]

rows = []
counts = {'PASS': 0, 'PARTIAL': 0, 'FAIL': 0}
for f in sorted(glob.glob(os.path.join(samples, '*.msg'))):
    b = os.path.basename(f)[:-4]
    run = json.load(open(os.path.join(out, b + '.run.json')))
    cls = ''
    defects = '-'
    if run['rc'] != 0:
        err = open(os.path.join(out, b + '.stderr')).read().strip().splitlines()
        verdict = 'FAIL'
        label = 'FAIL'
        detail = (err[-1] if err else 'no output')[:160]
    else:
        rep = json.load(open(os.path.join(out, b + '.report.json')))
        cls = rep.get('messageClass', '')
        try:
            c = json.load(open(os.path.join(out, b + '.cmp.json')))
            ours = json.load(open(os.path.join(out, b + '.ours.json')))
            defects = str(len(ours.get('defects', [])))
            verdict = c['verdict']
            label = c.get('label') or verdict
            detail = '; '.join(c['mismatches'][:3]) if c['mismatches'] else '; '.join(n for n in c['notes'][:2])
        except Exception as e:  # noqa
            verdict = 'PARTIAL'
            label = 'PARTIAL'
            detail = 'comparison failed: %r' % e
    counts[verdict] += 1
    if label != verdict:
        counts.setdefault(label, 0)
        counts[label] += 1
    rows.append((b, cls, run['ms'], defects, baseline.get(b, '?'), label, detail.replace('|', '/')))

print('Result: %d files, %d PASS, %d PARTIAL, %d FAIL' % (len(rows), counts['PASS'], counts['PARTIAL'], counts['FAIL']))
extra = ['%d %s' % (v, k) for k, v in sorted(counts.items()) if k not in ('PASS', 'PARTIAL', 'FAIL')]
print(('of the PASS: ' + ', '.join(extra)) if extra else '')
print()
print('| File | Class | ms | Defects | Before | After | Detail |')
print('|---|---|---|---|---|---|---|')
for r in rows:
    print('| %s | %s | %s | %s | %s | %s | %s |' % r)
