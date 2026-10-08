// Model -> RFC 5322 / MIME message.

import { Part, serializeMessage } from './mime/part.js';
import { phrase, unstructured, stripTrailingNul } from './mime/encode.js';
import { isValidCid } from './mime/part.js';
import { parseHeaderBlock, headerValue, parseAddressList, isSmtp } from './headers.js';
import { buildDnMap, resolvePerson, resolveRecipient } from './address.js';
import { decompressRtf } from './rtf/decompress.js';
import { deEncapsulate, detectEncapsulation, rtfToText } from './rtf/rtf.js';
import { buildCalendar } from './ical.js';
import { contactVcard } from './vcard.js';

// A Map, not an object literal: a file name ending in ".constructor" or
// ".__proto__" must not find Object.prototype members (review M3).
const MIME_BY_EXT = new Map(Object.entries({
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', svg: 'image/svg+xml', webp: 'image/webp',
  txt: 'text/plain', htm: 'text/html', html: 'text/html', csv: 'text/csv', rtf: 'application/rtf',
  xml: 'application/xml', json: 'application/json', zip: 'application/zip', eml: 'message/rfc822',
  ics: 'text/calendar', vcf: 'text/vcard', doc: 'application/msword', xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  msg: 'application/vnd.ms-outlook', mp3: 'audio/mpeg', mp4: 'video/mp4', wav: 'audio/wav',
}));

const TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

function mimeTypeFor(att) {
  const tag = (att.mime || '').trim().toLowerCase();
  const m = /^([a-z0-9!#$&^_.+-]+)\/([a-z0-9!#$&^_.+-]+)$/.exec(tag);
  if (m && !tag.startsWith('multipart/') && tag !== 'message/rfc822') return tag;
  const ext = (att.filename.split('.').pop() || att.extension.replace(/^\./, '') || '').toLowerCase();
  const t = MIME_BY_EXT.get(ext);
  return t && t !== 'message/rfc822' ? t : 'application/octet-stream';
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');

/** RFC 5322 date-time in UTC (+0000). */
export function rfc5322Date(d) {
  return `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`;
}

// Applied to a value with whitespace runs collapsed, so no two adjacent
// quantifiers can match the same characters (linear time; review B2).
const DATE_RE = /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), ?)?\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}(?::\d{2})? [+-]\d{4}(?: \([^()]*\))?$/;

function chooseDate(m, hdrs) {
  const raw = headerValue(hdrs, 'Date');
  const h = raw && raw.length < 200 ? raw.replace(/\s+/g, ' ').trim() : null;
  if (h && DATE_RE.test(h)) {
    const value = h.replace(/ \([^()]*\)$/, '');
    const parsed = new Date(value);
    // Use the original header (keeps the sender's UTC offset) when it agrees
    // with the submit time, or when there is no submit time.
    if (!isNaN(parsed) && (!m.dates.submit || Math.abs(parsed - m.dates.submit) < 36 * 3600 * 1000)) {
      return { value, source: 'transport-headers' };
    }
  }
  for (const [k, src] of [['submit', 'PidTagClientSubmitTime'], ['delivery', 'PidTagMessageDeliveryTime'], ['creation', 'PidTagCreationTime'], ['modification', 'PidTagLastModificationTime']]) {
    const d = m.dates[k];
    if (d && d.getUTCFullYear() > 1601 && d.getUTCFullYear() < 4500) return { value: rfc5322Date(d), source: src };
  }
  return { value: null, source: 'none' };
}

// RFC 5322 msg-id: "<" id-left "@" id-right ">", printable ASCII only
// (review M1, minor 8). Whitespace inside is never squeezed out: a value
// such as "garbage\r\nX-Z: 1" is dropped, not turned into an id.
const MSG_ID = /^[\x21-\x3b\x3d\x3f-\x7e]+@[\x21-\x3b\x3d\x3f-\x7e]+$/;

function msgIdValue(v) {
  if (!v) return null;
  const s = stripTrailingNul(String(v)).trim();
  const inner = s.startsWith('<') && s.endsWith('>') ? s.slice(1, -1) : s;
  if (inner.length > 900 || !MSG_ID.test(inner)) return null;
  return `<${inner}>`;
}

function msgIdList(v) {
  if (!v) return null;
  const ids = [];
  for (const tok of String(v).split(/[\s,]+/)) {
    if (!tok) continue;
    const id = msgIdValue(tok);
    if (id) ids.push(id);
  }
  return ids.length ? ids.join(' ') : null;
}

export const UNRESOLVED_DOMAIN = 'unresolved.invalid';
/** @deprecated kept for callers of 0.1.0; A2 now uses a per-person local part. */
export const UNRESOLVED_ADDRESS = `unresolved@${UNRESOLVED_DOMAIN}`;

/** FNV-1a 32-bit, as 8 hex digits (stable across runs and platforms). */
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Per-person placeholder for option A2 (review focus 6): a slug of the
 * name plus a hash of the X.500 DN (or of the name when there is no DN), in
 * the reserved .invalid domain (RFC 2606/6761). The same person gets the
 * same address in every file; different people get different addresses.
 */
export function unresolvedPlaceholder(p) {
  const slug = String(p.name || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 40).replace(/\.+$/, '');
  const key = (p.dn || p.name || '').trim().toLowerCase();
  return `${slug || 'unresolved'}.${fnv1a(key)}@${UNRESOLVED_DOMAIN}`;
}

const DOT_ATOM = /^[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+)*$/;
const ASCII_DOMAIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.?$|^\[[\x21-\x5a\x5e-\x7e]+\]$/;

/** IDN domain to its ASCII (punycode) form with the WHATWG URL parser, or null. */
function toAsciiDomain(domain) {
  if (!/[^\x00-\x7f]/.test(domain)) return ASCII_DOMAIN.test(domain) ? domain : null;
  try {
    const host = new URL(`http://${domain}/`).hostname;
    return host && ASCII_DOMAIN.test(host) ? host : null;
  } catch {
    return null;
  }
}

/**
 * An addr-spec ready for a header, or null when it cannot be written.
 * ASCII addresses are written as they are (a local part that is not a
 * dot-atom is quoted). A non-ASCII domain becomes punycode. A non-ASCII
 * local part has no ASCII form (RFC 2047 cannot encode an addr-spec): it is
 * written as UTF-8 only with utf8Headers (RFC 6532); otherwise null.
 */
export function headerAddrSpec(addr, utf8Headers = false) {
  const a = String(addr || '').trim();
  const at = a.lastIndexOf('@');
  if (at <= 0 || at === a.length - 1 || /[\x00-\x20\x7f]/.test(a)) return null;
  let local = a.slice(0, at);
  const domain = a.slice(at + 1);
  const nonAsciiLocal = /[^\x00-\x7f]/.test(local);
  if (nonAsciiLocal) {
    if (!utf8Headers || /["\\]/.test(local)) return null;
    const d = /[^\x00-\x7f]/.test(domain) ? domain.normalize('NFC') : toAsciiDomain(domain);
    return d ? `${local.normalize('NFC')}@${d}` : null;
  }
  if (!DOT_ATOM.test(local)) {
    if (/[^\x20-\x7e]/.test(local)) return null;
    local = `"${local.replace(/(["\\])/g, '\\$1')}"`;
  }
  const d = toAsciiDomain(domain);
  return d ? `${local}@${d}` : null;
}

/**
 * Format one person for an address header. Without a usable SMTP address
 * the person is written by option unresolvedAddress:
 *  - 'name-only' (A1): the display name alone as an empty group,
 *    "Name:;" (RFC 5322 group syntax, allowed in From by RFC 6854);
 *  - 'invalid-domain' (A2, default): "Name <slug.hash@unresolved.invalid>", see
 *    unresolvedPlaceholder.
 * An X.500 DN is never written as an address.
 */
function makeFormatter(opts, warnings) {
  const mode = opts.unresolvedAddress || 'invalid-domain';
  const utf8 = !!opts.utf8Headers;
  const warned = new Set();
  return (p) => {
    let email = null;
    if (p.email) {
      email = headerAddrSpec(p.email, utf8);
      if (!email && !warned.has(p.email)) {
        warned.add(p.email);
        warnings.push(`address ${JSON.stringify(p.email)} cannot be written in a 7-bit header (non-ASCII local part); ` +
          'shown as unresolved (option utf8Headers writes it as UTF-8, RFC 6532)');
      }
    }
    if (email) return p.name ? `${phrase(p.name)} <${email}>` : email;
    const name = p.name || (p.email ? String(p.email) : '');
    if (!name) return null;
    if (mode === 'invalid-domain') return `${phrase(name)} <${unresolvedPlaceholder({ name, dn: p.dn })}>`;
    const ph = phrase(name);
    return ph.endsWith('?=') ? `${ph} :;` : `${ph}:;`; // encoded-word needs whitespace after it
  };
}

// Headers we generate ourselves; the stored copies are not replayed.
const GENERATED = new Set(['from', 'sender', 'to', 'cc', 'bcc', 'subject', 'date', 'message-id', 'in-reply-to',
  'references', 'mime-version', 'importance', 'x-priority', 'sensitivity']);
// Stored headers that would make the reader act on an old message (send a
// read receipt, set Mozilla folder flags on import): never replayed
// (review minor 9).
const UNSAFE = new Set(['disposition-notification-to', 'return-receipt-to', 'x-confirm-reading-to',
  'generate-delivery-report', 'read-receipt-to']);
// Address-list headers: re-emitted mailbox by mailbox, never encoded whole
// (RFC 2047 section 5 forbids an addr-spec inside an encoded-word; review M2).
const ADDRESS_HEADERS = new Set(['reply-to', 'mail-reply-to', 'mail-followup-to', 'resent-from', 'resent-sender',
  'resent-to', 'resent-cc', 'resent-bcc', 'errors-to', 'return-path']);

/** Re-emit a stored address-list value: each mailbox with an SMTP address, names as phrases. */
function addressListValue(value, fmt) {
  const list = parseAddressList(value).filter((a) => isSmtp(a.email)).map((a) => fmt({ name: a.name, email: a.email.trim() }));
  const kept = list.filter((x) => x && !x.endsWith(':;'));
  return kept.length ? kept.join(', ') : null;
}

function replayHeaders(hdrs, fmt, warnings) {
  const out = [];
  for (const [k, v] of hdrs) {
    const lk = k.toLowerCase();
    if (GENERATED.has(lk) || UNSAFE.has(lk) || lk.startsWith('content-') || lk.startsWith('x-mozilla-')) continue;
    if (!TOKEN.test(k) || k.length > 76) continue;
    if (ADDRESS_HEADERS.has(lk)) {
      if (lk === 'return-path') {
        // angle-addr or "<>" (RFC 5322 3.6.7); kept only in a clean ASCII form
        const inner = v.trim().replace(/^<|>$/g, '').trim();
        const spec = inner === '' ? '' : headerAddrSpec(inner, false);
        if (spec !== null && (inner === '' || isSmtp(inner))) out.push([k, `<${spec}>`]);
        continue;
      }
      const val = addressListValue(v, fmt);
      if (val) out.push([k, val]);
      else warnings.push(`stored ${k} header has no usable address; not copied`);
      continue;
    }
    out.push([k, unstructured(v)]);
  }
  return out;
}

/**
 * Rewrite the charset in <meta> tags to utf-8 (the HTML part is written as
 * UTF-8). One forward scan: each tag is looked at once, from "<meta" to the
 * next ">", so the work is linear in the size of the HTML (review B2).
 */
export function htmlCharsetToUtf8(html) {
  // ASCII-only lowercasing keeps every index equal to the original's;
  // String#toLowerCase can change the length (U+0130 becomes two units).
  const lower = html.replace(/[A-Z]+/g, (c) => c.toLowerCase());
  let out = '';
  let pos = 0;
  for (;;) {
    const start = lower.indexOf('<meta', pos);
    if (start < 0) break;
    const end = lower.indexOf('>', start);
    if (end < 0) break; // no later tag can close either
    const tag = html.slice(start, end);
    const fixed = tag.length > 2048 ? tag : tag.replace(/(\bcharset[ \t\r\n]*=[ \t\r\n]*["']?)[A-Za-z0-9_\-:.]+/i, '$1utf-8');
    out += html.slice(pos, start) + fixed;
    pos = end;
  }
  return pos === 0 ? html : out + html.slice(pos);
}

const SMIME_OIDS = [
  // contentType OIDs in DER (06 len value), RFC 5652 / RFC 8551
  { der: [0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02], type: 'signed-data' },
  { der: [0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x03], type: 'enveloped-data' },
  { der: [0x06, 0x0b, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x10, 0x01, 0x17], type: 'authEnveloped-data' },
  { der: [0x06, 0x0b, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x10, 0x01, 0x09], type: 'compressed-data' },
];

/**
 * smime-type of an opaque S/MIME blob (IPM.Note.SMIME is used by Outlook for
 * both encrypted and opaque-signed mail; review M5): from the attachment's
 * MIME tag when it says, else from the CMS ContentInfo's contentType OID,
 * which follows the outer SEQUENCE header in the first bytes.
 */
export function smimeType(data, mimeTag) {
  const m = /smime-type\s*=\s*"?([A-Za-z-]+)/i.exec(mimeTag || '');
  if (m) {
    const t = SMIME_OIDS.find((o) => o.type.toLowerCase() === m[1].toLowerCase());
    if (t) return t.type;
  }
  if (!data || data.length < 16 || data[0] !== 0x30) return null;
  // SEQUENCE length: short form, or long form with 1-4 length bytes, or indefinite (0x80).
  let i = 2;
  if (data[1] & 0x80) i = 2 + (data[1] & 0x7f);
  if (i > 6) return null;
  for (const o of SMIME_OIDS) {
    if (o.der.every((b, k) => data[i + k] === b)) return o.type;
  }
  return null;
}

/** True when `cid:<id>` occurs in the (lower-cased) HTML followed by a delimiter (review minor 6). */
function cidReferenced(lowerHtml, cid) {
  const needle = `cid:${cid.toLowerCase()}`;
  let at = lowerHtml.indexOf(needle);
  while (at >= 0) {
    const next = lowerHtml.charCodeAt(at + needle.length);
    if (Number.isNaN(next) || /[\s"'()<>\\]/.test(String.fromCharCode(next))) return true;
    at = lowerHtml.indexOf(needle, at + 1);
  }
  return false;
}

/**
 * Convert a model (from readMsg) to an RFC 5322 message.
 * @returns {{bytes:Uint8Array, report:object}}
 */
const cleanForReport = (s) => String(s).replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, 120);

export function buildEml(m, opts = {}, depth = 0) {
  const keepRtf = opts.keepRtf ?? 'auto';
  const ser = { utf8: !!opts.utf8Headers };
  const warnings = [...m.warnings];
  const report = { messageClass: m.messageClass, codepage: m.codepage, warnings, body: {}, addresses: {}, attachments: [] };

  const hdrs = parseHeaderBlock(m.transportHeaders);
  const ctx = { headers: hdrs, dnMap: buildDnMap(m) };
  const headers = [];

  // From / Sender
  const rep = m.representing;
  const hasRep = !!(rep.name || rep.email || rep.smtp);
  const norm = (x) => String(x || '').trim().toLowerCase();
  // When someone sends on behalf of another person, the stored From header
  // names the represented person, so only that person may take an address
  // from it; the actual sender is looked up in the Sender header instead.
  const onBehalf = hasRep && ((rep.name && norm(rep.name) !== norm(m.sender.name)) ||
    (rep.email && m.sender.email && norm(rep.email) !== norm(m.sender.email)));
  const sender = onBehalf ? resolvePerson(m.sender, ctx, 'Sender', { author: true }) : resolvePerson(m.sender, ctx, 'From', { author: true });
  let from = sender;
  if (hasRep) {
    const r = resolvePerson(rep, ctx, 'From', { author: true });
    if (r.email || r.name) from = r;
  }
  report.addresses.from = { name: from.name, email: from.email, source: from.source, nameSource: from.nameSource };
  const fmt = makeFormatter(opts, warnings);
  const fromStr = fmt(from);
  if (fromStr) headers.push(['From', fromStr]);
  if (from.email && sender.email && from.email.toLowerCase() !== sender.email.toLowerCase()) {
    headers.push(['Sender', fmt(sender)]);
  }
  if (fromStr && !from.email) warnings.push(`sender has no SMTP address in the file; From shows ${(opts.unresolvedAddress || 'invalid-domain') === 'name-only' ? 'the name only' : 'the name with a placeholder .invalid address'} ("${from.name}")`);

  // Recipients
  const people = { to: [], cc: [], bcc: [] };
  let unresolved = 0;
  for (const rc of m.recipients) {
    const r = resolveRecipient(rc, ctx);
    if (!r.email && !r.name) { warnings.push('a recipient with neither SMTP address nor name was dropped'); continue; }
    if (!r.email) unresolved++;
    (people[rc.type] || people.to).push({ ...r, type: rc.type });
  }
  if (unresolved) warnings.push(`${unresolved} recipient(s) have no SMTP address in the file; shown ${(opts.unresolvedAddress || 'invalid-domain') === 'name-only' ? 'by name only' : 'with a placeholder .invalid address'}`);
  report.addresses.recipients = [...people.to, ...people.cc, ...people.bcc].map((p) => ({ type: p.type, name: p.name, email: p.email, source: p.source }));
  // No recipient table but stored headers have the lists (e.g. some received mail).
  for (const [key, hn] of [['to', 'To'], ['cc', 'Cc']]) {
    const list = people[key].map(fmt).filter(Boolean);
    if (list.length) headers.push([hn, list.join(', ')]);
    else if (!m.recipients.length) {
      const hv = headerValue(hdrs, hn);
      const val = hv ? addressListValue(hv, fmt) : null;
      if (val) headers.push([hn, val]);
    }
  }
  if (people.bcc.length) headers.push(['Bcc', people.bcc.map(fmt).filter(Boolean).join(', ')]);

  if (m.subject != null && m.subject !== '') headers.push(['Subject', unstructured(m.subject)]);
  else if (m.subject === '') headers.push(['Subject', '']);

  const date = chooseDate(m, hdrs);
  report.date = date;
  if (date.value) headers.push(['Date', date.value]);
  else warnings.push('the file has no date; no Date header written');

  const mid = msgIdValue(m.messageId) || msgIdValue(headerValue(hdrs, 'Message-ID'));
  if (mid) headers.push(['Message-ID', mid]);
  const irt = msgIdList(m.inReplyTo) || msgIdList(headerValue(hdrs, 'In-Reply-To'));
  if (irt) headers.push(['In-Reply-To', irt]);
  const refs = msgIdList(m.references) || msgIdList(headerValue(hdrs, 'References'));
  if (refs) headers.push(['References', refs]);
  if (m.importance === 2) headers.push(['Importance', 'high'], ['X-Priority', '1']);
  else if (m.importance === 0) headers.push(['Importance', 'low'], ['X-Priority', '5']);
  if (m.sensitivity === 1) headers.push(['Sensitivity', 'Personal']);
  else if (m.sensitivity === 2) headers.push(['Sensitivity', 'Private']);
  else if (m.sensitivity === 3) headers.push(['Sensitivity', 'Company-Confidential']);
  if (opts.replayHeaders !== false) headers.push(...replayHeaders(hdrs, fmt, warnings));
  if (m.messageClass) headers.push(['X-MS-Message-Class', unstructured(m.messageClass)]);

  // S/MIME: the attachment holds the original signed/encrypted MIME entity.
  const cls = m.messageClass || '';
  if (/^IPM\.Note\.SMIME/i.test(cls) && m.attachments.length >= 1 && m.attachments[0].data) {
    const att = m.attachments[0];
    if (/^IPM\.Note\.SMIME\.MultipartSigned/i.test(cls)) {
      const text = new TextDecoder('latin1').decode(att.data.subarray(0, 4096));
      if (/^content-type:\s*multipart\/signed/im.test(text)) {
        report.body = { kind: 'smime-signed', htmlProperty: !!m.htmlProperty, note: 'original signed MIME entity passed through unchanged' };
        return { bytes: serializeMessage(headers, Part.rawEntity(att.data), depth, ser), report };
      }
      // Some writers store only the multipart body without its header.
      // Nothing can rebuild it, so the message is written as an ordinary
      // one with the stored entity as an attachment (review minor 12).
      warnings.push('signed message is stored without its MIME header; written as an ordinary message with the ' +
        'signed content as an attachment, and the signature cannot be checked');
    } else {
      const st = smimeType(att.data, att.mime);
      const fname = att.filename || 'smime.p7m';
      const p = Part.binary('application/pkcs7-mime', att.data, { filename: /\.p7[mz]$/i.test(fname) ? fname : 'smime.p7m' });
      if (st) p.params.unshift(['smime-type', st]);
      else warnings.push('S/MIME content type not recognised (neither signed nor enveloped); written without smime-type');
      report.body = { htmlProperty: !!m.htmlProperty, kind: st === 'signed-data' ? 'smime-opaque-signed' : st === 'enveloped-data' || st === 'authEnveloped-data' ? 'smime-encrypted' : 'smime-unknown', smimeType: st };
      return { bytes: serializeMessage(headers, p, depth, ser), report };
    }
  }

  // Bodies
  let text = m.body && m.body.length ? m.body : null;
  let html = m.html || null;
  let rtfBytes = null;
  let rtfKind = null;
  report.body.textSource = text ? 'PidTagBody' : null;
  report.body.htmlSource = html ? 'PidTagHtml' : null;
  // Whether the file has a PidTagHtml property in any storage form, so a
  // checker can tell "no HTML in the file" from "HTML lost" (review M6).
  report.body.htmlProperty = !!m.htmlProperty;
  if (m.compressedRtf && m.compressedRtf.length) {
    try {
      const r = decompressRtf(m.compressedRtf);
      warnings.push(...r.warnings);
      rtfBytes = r.rtf;
      rtfKind = detectEncapsulation(rtfBytes) || 'rtf';
      report.body.rtf = rtfKind;
      if (rtfKind === 'html' && !html) {
        html = stripTrailingNul(deEncapsulate(rtfBytes).content);
        report.body.htmlSource = 'RTF (de-encapsulated)';
      } else if (rtfKind === 'text' && !text) {
        text = stripTrailingNul(deEncapsulate(rtfBytes).content);
        report.body.textSource = 'RTF (de-encapsulated)';
      } else if (rtfKind === 'rtf' && !text && !html) {
        text = rtfToText(rtfBytes);
        report.body.textSource = 'RTF (converted to plain text)';
      }
    } catch (e) {
      warnings.push(`RTF body could not be decompressed (${e && e.message ? e.message : e})`);
    }
  }
  if (html) html = htmlCharsetToUtf8(html);

  // Calendar / contact
  let calendar = null;
  if (/^IPM\.(Appointment|Schedule\.Meeting)/i.test(cls)) {
    const organizer = from.email ? from : (sender.email ? sender : null);
    calendar = buildCalendar(m, { organizer, attendees: [...people.to, ...people.cc, ...people.bcc], body: text || '' }, warnings);
    if (!calendar) warnings.push('calendar item has no start time; no text/calendar part written');
  }
  let vcard = null;
  if (m.contact) vcard = contactVcard(m.contact);

  // Attachments
  const cidRefs = html ? html.toLowerCase() : '';
  const related = [];
  const attached = [];
  for (const att of m.attachments) {
    const name = att.filename || att.displayName || '';
    if (att.error) {
      warnings.push(`attachment "${name || att.index}" skipped: ${att.error}`);
      report.attachments.push({ name, skipped: att.error });
      continue;
    }
    if (att.embedded) {
      const inner = buildEml(att.embedded, opts, depth + 1);
      const fname = (name || att.embedded.subject || 'message').replace(/\.msg$/i, '') + '.eml';
      attached.push(Part.message(inner.bytes, { filename: fname }));
      report.attachments.push({ name: fname, type: 'message/rfc822', embedded: inner.report });
      continue;
    }
    const type = mimeTypeFor(att);
    let cid = null;
    if (att.cid) {
      const c = stripTrailingNul(String(att.cid)).trim();
      const inner = c.startsWith('<') && c.endsWith('>') ? c.slice(1, -1) : c;
      if (isValidCid(inner)) cid = inner;
      else warnings.push(`attachment "${cleanForReport(name || att.index)}" has an unusable Content-ID; it was left out`);
    }
    const referenced = cid && cidReferenced(cidRefs, cid);
    if (referenced) {
      related.push(Part.binary(type, att.data, { filename: name || undefined, cid, inline: true }));
      report.attachments.push({ name, type, inline: true, cid, size: att.data.length });
    } else {
      attached.push(Part.binary(type, att.data, { filename: name || `attachment-${att.index + 1}`, cid: cid || undefined }));
      report.attachments.push({ name, type, size: att.data.length });
    }
  }
  // 'auto' keeps real RTF only when it is the only formatted body and has text.
  const rtfUseful = rtfKind === 'rtf' && rtfBytes && !html && rtfToText(rtfBytes).trim().length > 0;
  if (rtfKind === 'rtf' && rtfBytes && (keepRtf === 'always' || (keepRtf === 'auto' && rtfUseful))) {
    attached.push(Part.binary('application/rtf', rtfBytes, { filename: 'body.rtf', description: 'Original RTF body' }));
    report.attachments.push({ name: 'body.rtf', type: 'application/rtf', generated: true });
    report.body.rtfKept = true;
  }
  if (vcard) {
    attached.push(Part.binary('text/vcard', new TextEncoder().encode(vcard.text), { filename: vcard.filename, description: 'Contact' }));
    report.attachments.push({ name: vcard.filename, type: 'text/vcard', generated: true });
  }

  // Assemble
  if (!text && !html && !calendar) text = '';
  if (!text && html === null && calendar) text = '';
  const alts = [];
  if (text !== null) alts.push(Part.text('plain', text));
  if (html) {
    const htmlPart = Part.text('html', html);
    alts.push(related.length ? Part.multipart('related', [htmlPart, ...related], [['type', '"text/html"']]) : htmlPart);
  } else if (related.length) {
    attached.unshift(...related);
  }
  if (calendar) alts.push(Part.text('calendar', calendar.ics, { method: calendar.method }));
  let body = alts.length === 1 ? alts[0] : Part.multipart('alternative', alts);
  if (attached.length) body = Part.multipart('mixed', [body, ...attached]);

  report.body.parts = { text: text !== null, html: !!html, calendar: !!calendar, inline: related.length };
  return { bytes: serializeMessage(headers, body, depth, ser), report };
}

