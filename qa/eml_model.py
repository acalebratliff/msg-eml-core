"""Read an .eml back with Python's email package and reduce it to the fields
the comparison uses. Also lists every parser defect.

Usage: python eml_model.py in.eml out.json
"""
import hashlib
import json
import re
import sys
from email import message_from_bytes, policy

GENERATED = {'Original RTF body', 'Contact'}


def sha(b):
    return hashlib.sha256(b).hexdigest()


def addrs(msg, name):
    out = []
    h = msg[name]
    if h is None:
        return out
    try:
        for g in h.groups:
            if g.display_name is not None and not g.addresses:
                out.append({'name': g.display_name, 'email': None, 'group': True})
            for a in g.addresses:
                out.append({'name': a.display_name, 'email': a.addr_spec or None})
    except Exception as e:  # noqa
        out.append({'error': repr(e)})
    return out


def defects_of(msg):
    out = []
    for part in msg.walk():
        out += [type(d).__name__ + ':' + str(d) for d in part.defects]
        for k, v in part.items():
            for d in getattr(v, 'defects', []):
                out.append('%s header: %s: %s' % (k, type(d).__name__, d))
    return out


def model(msg, depth=0):
    m = {
        'subject': str(msg['subject']) if msg['subject'] is not None else None,
        'from': addrs(msg, 'from'),
        'to': addrs(msg, 'to'),
        'cc': addrs(msg, 'cc'),
        'date': str(msg['date']) if msg['date'] is not None else None,
        'message_id': str(msg['message-id']) if msg['message-id'] is not None else None,
        'content_type': msg.get_content_type(),
        'text': None, 'has_html': False, 'html': None, 'calendar': None, 'atts': [],
        'inline': [], 'generated': [], 'defects': [],
    }
    if depth == 0:
        m['defects'] = defects_of(msg)
    nested = {id(p) for p in _embedded_parts(msg)}
    for part in msg.walk():
        ctype = part.get_content_type()
        disp = part.get_content_disposition()
        desc = str(part.get('content-description') or '')
        if ctype == 'message/rfc822' and id(part) not in nested:
            inner = part.get_payload()[0] if isinstance(part.get_payload(), list) else None
            m['atts'].append({'embedded': True, 'name': part.get_filename(), 'sub': model(inner, depth + 1) if inner else None})
            continue
        # skip parts inside an embedded message (walk() descends into them)
        if id(part) in nested or part.is_multipart():
            continue
        if desc in GENERATED:
            m['generated'].append({'name': part.get_filename(), 'type': ctype})
            continue
        if ctype == 'text/plain' and disp != 'attachment' and m['text'] is None and not part.get_filename():
            m['text'] = part.get_content()
            continue
        if ctype == 'text/html' and disp != 'attachment' and not part.get_filename():
            m['has_html'] = True
            m['html'] = part.get_content()
            continue
        if ctype == 'text/calendar' and disp != 'attachment':
            m['calendar'] = part.get_content()
            continue
        data = part.get_payload(decode=True) or b''
        rec = {'name': part.get_filename(), 'sha': sha(data), 'size': len(data), 'type': ctype,
               'cid': (part.get('content-id') or '').strip('<>') or None}
        if disp == 'inline' and rec['cid']:
            m['inline'].append(rec)
        m['atts'].append(rec)
    return m


def _embedded_parts(msg):
    """All parts that live inside message/rfc822 parts of msg."""
    out = []
    for part in msg.walk():
        if part.get_content_type() == 'message/rfc822':
            for inner in part.get_payload():
                out.extend(inner.walk())
    return out


if __name__ == '__main__':
    raw = open(sys.argv[1], 'rb').read()
    msg = message_from_bytes(raw, policy=policy.default)
    out = model(msg)
    out['raw_bytes'] = len(raw)
    out['max_line'] = max((len(l) for l in raw.split(b'\r\n')), default=0)
    out['bare_lf'] = len(re.findall(rb'(?<!\r)\n', raw))
    json.dump(out, open(sys.argv[2], 'w'), default=str)
