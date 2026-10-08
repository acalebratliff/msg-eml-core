"""For every message whose .msg has a top-level PidTagHtml stream, in any
storage form (__substg1.0_1013 + 0102, 001F or 001E), read that stream
directly with olefile and check that the eml's HTML part has the same
visible text. Independent of the converter and of extract-msg: a lost or
mis-decoded HTML body is a FAIL here (re-review of 76093c2, M6).
Run after run_corpus.sh.

usage: python html_stream_check.py <samples-dir> <run-dir>
Exit status 1 when any file fails.
"""
import glob, html, json, os, re, sys
import olefile

STREAMS = {'__SUBSTG1.0_10130102': 'binary', '__SUBSTG1.0_1013001F': 'unicode', '__SUBSTG1.0_1013001E': 'string8'}


def visible(h):
    h = re.sub(r'(?is)<(script|style|head|xml)\b.*?</\1>', ' ', h)
    h = re.sub(r'(?s)<!--.*?-->', ' ', h)
    h = re.sub(r'<[^>]+>', ' ', h)
    h = html.unescape(h).replace('\xa0', ' ').replace('\x00', '')
    return re.sub(r'\s+', ' ', h).strip()


def internet_codepage(ole):
    """PidTagInternetCodepage (0x3FDE0003) from the top-level property stream."""
    try:
        ps = ole.openstream('__properties_version1.0').read()
    except Exception:
        return None
    for off in range(32, len(ps) - 15, 16):
        if int.from_bytes(ps[off:off + 4], 'little') == 0x3FDE0003:
            return int.from_bytes(ps[off + 8:off + 12], 'little')
    return None


def decode(data, kind, ansi_cp, inet_cp=None):
    if kind == 'unicode':
        return data.decode('utf-16-le', 'replace')
    if kind == 'string8':
        return data.decode('cp%s' % ansi_cp if ansi_cp else 'cp1252', 'replace')
    if inet_cp:
        try:
            return data.decode('utf-8' if inet_cp == 65001 else 'cp%d' % inet_cp)
        except Exception:
            pass
    m = re.search(rb'<meta[^>]+charset\s*=\s*["\']?([A-Za-z0-9_\-:.]+)', data[:2048], re.I)
    for enc in ([m.group(1).decode('ascii')] if m else []) + ['utf-8', 'cp1252']:
        try:
            return data.decode(enc)
        except Exception:
            continue
    return data.decode('cp1252', 'replace')


samples, run = sys.argv[1:3]
bad = 0
rows = []
for msg in sorted(glob.glob(os.path.join(samples, '*.msg'))):
    b = os.path.basename(msg)[:-4]
    try:
        with olefile.OleFileIO(msg) as ole:
            inet = internet_codepage(ole)
            found = [(STREAMS[e[0].upper()], ole.openstream(e).read()) for e in ole.listdir() if len(e) == 1 and e[0].upper() in STREAMS]
    except Exception as e:
        rows.append((b, '-', 'not a readable OLE file (%s)' % str(e)[:60], 'SKIP'))
        continue
    found = [(k, d) for k, d in found if d.strip(b'\x00')]
    if not found:
        continue
    rep_path, ours_path = os.path.join(run, b + '.report.json'), os.path.join(run, b + '.ours.json')
    rep = json.load(open(rep_path)) if os.path.exists(rep_path) else {'error': 'no report'}
    if 'error' in rep or not os.path.exists(ours_path):
        rows.append((b, found[0][0], 'converter produced no eml', 'FAIL'))
        bad += 1
        continue
    ours = json.load(open(ours_path))
    cp = (rep.get('codepage') or {}).get('codepage')
    kind, data = found[0]
    want = visible(decode(data.rstrip(b'\x00'), kind, cp, inet))
    got = visible(ours.get('html') or '')
    if not ours.get('has_html'):
        rows.append((b, kind, 'eml has no HTML part', 'FAIL'))
        bad += 1
    elif want == got:
        rows.append((b, kind, 'visible text equal (%d chars)' % len(want), 'PASS'))
    else:
        rows.append((b, kind, 'visible text differs (stream %d chars, eml %d chars)' % (len(want), len(got)), 'FAIL'))
        bad += 1

print('| file | PidTagHtml type | result | verdict |')
print('|---|---|---|---|')
for r in rows:
    print('| %s | %s | %s | %s |' % r)
print()
print('PidTagHtml stream check: %d files with a PidTagHtml stream, %d FAIL' % (len([r for r in rows if r[3] != 'SKIP']), bad))
sys.exit(1 if bad else 0)
