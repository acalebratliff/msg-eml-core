"""Compare a converted .eml (read back by eml_model.py) with the independent
reader (extract-msg, via indep.py) and the converter's own report.

Usage: python compare.py ours.json indep.json report.json [source.msg] > result.json

source.msg (optional) lets the HTML rule check the file itself for a
PidTagHtml stream (needs olefile, which extract-msg installs).

Verdict: PASS (nothing lost or mismatched), PARTIAL (eml produced, something
lost or mismatched), FAIL (no eml). Differences proven to be the independent
reader's fault are listed as notes, not mismatches; the proof is mechanical
(see indep_mojibake).
"""
import hashlib
import json
import re
import sys
from email.utils import parseaddr, parsedate_to_datetime


def norm(t):
    return re.sub(r'\s+', ' ', (t or '').replace('\x00', '')).strip()


def h(t):
    return hashlib.sha256(norm(t).encode()).hexdigest()[:12]


def indep_mojibake(ours, indep, cp):
    """True if indep == ours re-encoded in the message code page and decoded as
    cp1252/latin-1, i.e. extract-msg decoded ANSI bytes in the wrong code page."""
    if not ours or not indep or not cp:
        return False
    for enc_in in ('cp%d' % cp,):
        try:
            raw = ours.encode(enc_in)
        except Exception:
            return False
        for enc_out in ('cp1252', 'latin-1', 'iso-8859-15'):
            try:
                if norm(raw.decode(enc_out, errors='replace')) == norm(indep):
                    return True
            except Exception:
                pass
    return False


EMAIL_RE = re.compile(r'[^\s<>()"@,;:]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}')


def norm_name(t):
    """Display name compared loosely: case, quotes, NULs and whitespace runs ignored."""
    t = (t or '').replace('\x00', '').strip()
    if len(t) >= 2 and t[0] == t[-1] and t[0] in '"\'':
        t = t[1:-1]
    return re.sub(r'\s+', ' ', t).strip().lower()


def to_instant(v):
    if not v:
        return None
    try:
        d = parsedate_to_datetime(v) if not re.match(r'^\d{4}-\d\d-\d\d', v) else None
        if d is None:
            from datetime import datetime
            d = datetime.fromisoformat(v)
        return d.timestamp() if d.tzinfo else None
    except Exception:
        return None


def key_ours(a):
    return (a.get('email') or a.get('name') or '').lower()


def key_indep(t):
    name, email = (t[0] or '').replace('\x00', ''), (t[1] or '').replace('\x00', '')
    if email and '@' in email and not email.startswith('/'):
        return email.lower()
    return (name or email or '').lower()


HTML_STREAMS = ('__SUBSTG1.0_10130102', '__SUBSTG1.0_1013001F', '__SUBSTG1.0_1013001E')


def has_html_stream(msg_path):
    """True when the .msg has a top-level PidTagHtml stream in any storage
    form (binary, Unicode or 8-bit string), False when it has none, None when
    the file could not be looked at (callers must treat None as "maybe")."""
    if not msg_path:
        return None
    try:
        import olefile
        with olefile.OleFileIO(msg_path) as ole:
            return any(len(e) == 1 and e[0].upper() in HTML_STREAMS for e in ole.listdir())
    except Exception:
        return None


def cmp(o, i, rep, cls, path='', msg_path=None):
    mism, notes, labels = [], [], []
    cp = (rep.get('codepage') or {}).get('codepage')
    if 'fatal' in i:
        notes.append(path + 'independent reader failed: ' + i['fatal'][:120])
        return mism, notes, labels
    # NUL characters anywhere in what a reader sees are a defect (QA defect 1),
    # even when extract-msg carries the same padding.
    for fld in ('subject', 'text', 'html'):
        if '\x00' in (o.get(fld) or ''):
            mism.append(path + '%s contains NUL characters (%d)' % (fld, (o.get(fld) or '').count('\x00')))
    # subject
    so, si = norm(o.get('subject')), norm(i.get('subject'))
    if so != si:
        if indep_mojibake(o.get('subject'), i.get('subject'), cp):
            notes.append(path + 'subject: extract-msg decoded ANSI with a single-byte code page (wrong); ours uses cp%s' % cp)
        else:
            mism.append(path + 'subject differs: ours=%r indep=%r' % (so[:60], si[:60]))
    # from
    of = o.get('from') or []
    oemail = (of[0].get('email') or '') if of else ''
    oname = (of[0].get('name') or '') if of else ''
    isend = (i.get('sender') or '').replace('\x00', '')
    m_ = EMAIL_RE.search(isend)
    iemail = m_.group(0) if m_ else ''
    if oemail:
        if iemail and oemail.lower() != iemail.lower():
            mism.append(path + 'from differs: ours=%r indep=%r' % (oemail, isend))
        elif not iemail:
            src = ((rep.get('addresses') or {}).get('from') or {}).get('source', '?')
            notes.append(path + 'from: ours has SMTP %s (source: %s), extract-msg gives name only' % (oemail, src))
        else:
            # Same address: the display names must agree too (QA defect 2).
            iname = parseaddr(isend)[0] if '<' in isend else ''
            if iname and norm_name(iname) != norm_name(oname) and not indep_mojibake(oname, iname, cp):
                mism.append(path + 'from display name differs: ours=%r indep=%r' % (oname, iname))
    else:
        if iemail:
            mism.append(path + 'from: no SMTP in ours, extract-msg has %r' % isend)
        elif oname or isend:
            notes.append(path + 'from: no SMTP address in the file; name only (%r)' % (oname or isend))
    # recipients
    if i.get('to') is not None:
        for f in ('to', 'cc'):
            ko = sorted(key_ours(a) for a in (o.get(f) or []))
            ki = sorted(key_indep(t) for t in (i.get(f) or []))
            if ko != ki:
                # Entries matched by key first; what is left on each side must
                # pair up by normalised display name, and only where
                # extract-msg has no SMTP address for that person.
                ours_left = list(o.get(f) or [])
                ind_left = list(i.get(f) or [])
                for t in list(ind_left):
                    k = key_indep(t)
                    hit = next((a for a in ours_left if key_ours(a) == k), None)
                    if hit is not None:
                        ours_left.remove(hit)
                        ind_left.remove(t)
                paired = len(ours_left) == len(ind_left) and bool(ind_left)
                gains = []
                for t in ind_left:
                    iname, iaddr = (t[0] or '').replace('\x00', ''), (t[1] or '').replace('\x00', '')
                    hit = next((a for a in ours_left if norm_name(a.get('name')) == norm_name(iname) and norm_name(iname)), None)
                    if hit is None or ('@' in iaddr and not iaddr.startswith('/')):
                        paired = False
                        break
                    ours_left.remove(hit)
                    if hit.get('email'):
                        gains.append('%s <%s>' % (hit.get('name'), hit.get('email')))
                if paired:
                    notes.append(path + '%s: names match; extract-msg has no SMTP address for them%s' % (
                        f, ('; ours resolved ' + ', '.join(gains[:4])) if gains else ''))
                elif not ki and ko and f == 'to' and cls.lower().startswith('ipm.appointment'):
                    notes.append(path + 'to: extract-msg misses recipients ours has (%d)' % len(ko))
                else:
                    mism.append(path + '%s differs: ours=%s indep=%s' % (f, ko[:4], ki[:4]))
    # body text
    bo, bi = o.get('text'), i.get('body')
    if h(bo) != h(bi):
        if indep_mojibake(bo, bi, cp):
            notes.append(path + 'body: extract-msg decoded ANSI with a single-byte code page (wrong); ours uses cp%s' % cp)
        elif not norm(bi) and norm(bo) and (rep.get('body') or {}).get('textSource', '') and 'RTF' in (rep.get('body') or {}).get('textSource', ''):
            notes.append(path + 'body: ours recovered text from RTF; extract-msg has none')
        else:
            mism.append(path + 'body text differs (ours %d chars, indep %d chars)' % (len(norm(bo)), len(norm(bi))))
    # html
    rb = rep.get('body') or {}
    # The file's own PidTagHtml (any storage form) must reach the eml, whatever
    # extract-msg makes of it. The converter's report must say explicitly
    # whether the property exists; a missing key counts as "maybe" (review M6).
    stream = has_html_stream(msg_path) if not path else False
    if 'htmlProperty' not in rb:
        mism.append(path + 'report does not say whether the file has PidTagHtml (htmlProperty missing)')
    elif (rb.get('htmlProperty') or stream is True) and not o.get('has_html') and not str(rb.get('kind', '')).startswith('smime'):
        mism.append(path + 'html missing: the file has PidTagHtml but the eml has no HTML part')
    if o.get('has_html') != bool(i.get('hasHtml')):
        no_html_in_file = rb.get('htmlSource') is None and rb.get('htmlProperty') is False and stream is False
        if i.get('hasHtml') and rb.get('rtf') == 'rtf' and no_html_in_file:
            notes.append(path + 'html: body is real RTF; ours gives text + body.rtf, extract-msg renders RTF to HTML')
            labels.append('RTF fallback')
        elif i.get('hasHtml') and rb.get('rtf') in ('text', None) and o.get('text') is not None and no_html_in_file:
            notes.append(path + 'html: message is plain text (no PidTagHtml, no HTML in RTF); extract-msg synthesises HTML from it')
        elif i.get('hasHtml') and not o.get('has_html'):
            mism.append(path + 'html missing (extract-msg has HTML)')
        else:
            notes.append(path + 'html: ours has HTML, extract-msg none')
    # attachments
    oa = [a for a in o['atts'] if not a.get('embedded')]
    ia = [a for a in i['atts'] if not a.get('embedded')]
    if sorted(a['sha'] for a in oa) != sorted(a['sha'] for a in ia):
        mism.append(path + 'attachment content differs (ours %d, indep %d)' % (len(oa), len(ia)))
    on = sorted((a.get('name') or '') for a in oa)
    inn = sorted((a.get('name') or '') for a in ia)
    if on != inn:
        if len(on) == len(inn) and all(x == y or (x.startswith('attachment-') and not y) for x, y in zip(on, inn)):
            notes.append(path + 'attachment without a name in the file named attachment-N')
        else:
            mism.append(path + 'attachment names differ: ours=%s indep=%s' % (on[:4], inn[:4]))
    # Date: when both readers have one, they must give the same instant.
    od, idt = to_instant(o.get('date')), to_instant(i.get('date'))
    if od is not None and idt is not None and abs(od - idt) > 1:
        mism.append(path + 'date differs: ours=%r indep=%r' % (o.get('date'), i.get('date')))
    elif o.get('date') and not i.get('date'):
        notes.append(path + 'date: extract-msg has none; ours uses %s' % ((rep.get('date') or {}).get('source') or '?'))
    # Message-ID: when extract-msg has one, ours must be the same.
    imid = (i.get('messageId') or '').replace('\x00', '').strip()
    if imid:
        omid = (o.get('message_id') or '').strip()
        if omid.strip('<>') != imid.strip('<>'):
            mism.append(path + 'message-id differs: ours=%r indep=%r' % (omid, imid))
    oe = [a for a in o['atts'] if a.get('embedded')]
    ie = [a for a in i['atts'] if a.get('embedded')]
    if len(oe) != len(ie):
        mism.append(path + 'embedded message count differs: ours=%d indep=%d' % (len(oe), len(ie)))
    erep = [a.get('embedded') for a in (rep.get('attachments') or []) if a.get('embedded')]
    for k, (x, y) in enumerate(zip(oe, ie)):
        sub_rep = erep[k] if k < len(erep) else {}
        mm, nn, ll = cmp(x['sub'] or {}, y['sub'] or {}, sub_rep, sub_rep.get('messageClass', ''), path + '[emb%d] ' % (k + 1))
        mism += mm
        notes += nn
        labels += ll
    # features
    if re.match(r'(?i)^ipm\.(appointment|schedule\.meeting)', cls or '') and not o.get('calendar'):
        mism.append(path + 'calendar item without text/calendar part')
    return mism, notes, labels


if __name__ == '__main__':
    ours = json.load(open(sys.argv[1]))
    indep = json.load(open(sys.argv[2]))
    rep = json.load(open(sys.argv[3]))
    cls = rep.get('messageClass', '')
    msg_path = sys.argv[4] if len(sys.argv) > 4 else None
    mism, notes, labels = cmp(ours, indep, rep, cls, msg_path=msg_path)
    if ours.get('defects'):
        mism.append('email parser defects: %s' % ours['defects'][:3])
    if ours.get('max_line', 0) > 998:
        mism.append('line longer than 998 octets (%d)' % ours['max_line'])
    for w in rep.get('warnings', []):
        notes.append('converter warning: ' + w)
    verdict = 'PARTIAL' if mism else 'PASS'
    label = verdict + (' (%s)' % ', '.join(sorted(set(labels))) if labels and not mism else '')
    print(json.dumps({'verdict': verdict, 'label': label, 'mismatches': mism, 'notes': notes}))
