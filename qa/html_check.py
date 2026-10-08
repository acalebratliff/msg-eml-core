"""For messages whose HTML the converter de-encapsulated from RTF, compare the
visible text of that HTML with extract-msg's HTML for the same file
(extract-msg de-encapsulates with its own RTF code). Run after run_corpus.sh.

usage: python html_check.py <samples-dir> <run-dir>  (python with extract-msg)
"""
import glob, html, json, os, re, sys, warnings, logging
logging.disable(logging.CRITICAL); warnings.filterwarnings('ignore')
import extract_msg

def visible(h):
    if isinstance(h, bytes):
        h = h.decode('utf-8', 'replace')
    h = re.sub(r'(?is)<(script|style|head|xml)\b.*?</\1>', ' ', h)
    h = re.sub(r'(?s)<!--.*?-->', ' ', h)
    h = re.sub(r'<[^>]+>', ' ', h)
    h = html.unescape(h).replace('\xa0', ' ')
    return re.sub(r'\s+', ' ', h).strip()

samples, run = sys.argv[1:3]
rows = []
for rep_path in sorted(glob.glob(os.path.join(run, '*.report.json'))):
    b = os.path.basename(rep_path)[:-len('.report.json')]
    rep = json.load(open(rep_path))
    if 'error' in rep or (rep.get('body') or {}).get('htmlSource') != 'RTF (de-encapsulated)':
        continue
    ours = json.load(open(os.path.join(run, b + '.ours.json')))
    try:
        m = extract_msg.openMsg(os.path.join(samples, b + '.msg'))
        theirs = m.htmlBody
        m.close()
    except Exception as e:
        rows.append((b, 'extract-msg failed: %r' % e)); continue
    a, t = visible(ours.get('html') or ''), visible(theirs or b'')
    rows.append((b, 'identical' if a == t else 'differs (ours %d chars, extract-msg %d chars)' % (len(a), len(t))))
same = sum(1 for _, r in rows if r == 'identical')
print('HTML from RTF: %d messages, visible text identical to extract-msg in %d' % (len(rows), same))
for b, r in rows:
    print(' -', b, ':', r)
