// Reads an Outlook .msg (bytes) into a plain model using @kenjiuno/msgreader,
// with code page detection, a structural pre-check and recursion into
// embedded messages.

import MsgReaderPkg from '@kenjiuno/msgreader';
import { checkCompoundFile } from './cfb-guard.js';
import { chooseAnsiCodepage, decodeBytes, codepageLabel } from './codepage.js';
import { MsgError } from './errors.js';
import { stripTrailingNul } from './mime/encode.js';

const MsgReader = MsgReaderPkg.default || MsgReaderPkg;

// Extra MAPI properties read from raw values (tag without type -> name).
const EXTRA_MSG = {
  0x0042: 'sentRepresentingName',
  0x0064: 'sentRepresentingAddrType',
  0x0065: 'sentRepresentingEmail',
  0x1042: 'inReplyTo',
  0x1039: 'references',
  0x0017: 'importance',
  0x0036: 'sensitivity',
  0x0e07: 'messageFlagsRaw',
};
const EXTRA_RECIP = {
  0x3001: 'displayName',
  0x5ff6: 'recipientDisplayName',
  0x39fe: 'smtpAddress',
  0x3003: 'emailAddress',
  0x3002: 'addrType',
};
const EXTRA_ATTACH = {
  0x3705: 'attachMethod',
  0x3713: 'contentLocation',
  0x3716: 'contentDisposition',
  0x370e: 'mimeTag',
  0x7ffe: 'hidden',
  0x3714: 'attachFlags',
};

function toU8(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new MsgError('BAD_INPUT', 'Input must be a Uint8Array or ArrayBuffer.');
}

function decodeRaw(tag, raw, cp) {
  if (!raw) return undefined;
  const type = tag & 0xffff;
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  switch (type) {
    case 0x001f: return trimNul(decodeBytes(raw, 'utf-16le'));
    case 0x001e: return trimNul(decodeBytes(raw, cp));
    case 0x0003: return raw.length >= 4 ? dv.getInt32(0, true) : undefined;
    case 0x000b: return raw.length >= 2 ? dv.getUint16(0, true) !== 0 : undefined;
    case 0x0102: return raw;
    default: return undefined;
  }
}
function trimNul(s) {
  const i = s.indexOf('\0');
  return i >= 0 ? s.slice(0, i) : s;
}

function parseOnce(u8, ansiEncoding) {
  const extras = new Map(); // fields object -> Map(tag -> raw)
  let ansiHigh = false;
  const reader = new MsgReader(u8);
  reader.parserConfig = {
    ansiEncoding: ansiEncoding || undefined,
    propertyObserver(fields, tag, raw) {
      let m = extras.get(fields);
      if (!m) { m = new Map(); extras.set(fields, m); }
      // Keep the stream value over the 8-byte fixed-size entry when both exist.
      if (!m.has(tag) || (raw && raw.length !== 8)) m.set(tag, raw);
      // Any non-Unicode string property means the message must be read
      // with its code page (msgreader's default treats bytes as Latin-1).
      if ((tag & 0xffff) === 0x001e || (tag & 0xffff) === 0x101e) ansiHigh = true;
    },
  };
  const data = reader.getFileData();
  if (!data || data.error) {
    throw new MsgError('UNREADABLE', `The file could not be read as an Outlook message${data && data.error ? ` (${data.error})` : ''}.`);
  }
  return { reader, data, extras, ansiHigh };
}

function collect(extras, fields, table, cp) {
  const m = extras.get(fields);
  const out = {};
  if (!m) return out;
  for (const [tag, raw] of m) {
    const name = table[tag >>> 16];
    if (!name) continue;
    const type = tag & 0xffff;
    if (type === 0x0003 || type === 0x000b) {
      // fixed-size values arrive as the 8-byte entry value
      const v = decodeRaw(tag, raw, cp);
      if (v !== undefined) out[name] = v;
    } else {
      const v = decodeRaw(tag, raw, cp);
      if (v !== undefined && v !== '') out[name] = v;
    }
  }
  return out;
}

function decodeHtmlBytes(bytes, internetCodepage) {
  let label = internetCodepage ? codepageLabel(internetCodepage) : null;
  if (!label) {
    const head = decodeBytes(bytes.subarray(0, 2048), 'windows-1252');
    const m = /<meta[^>]+charset\s*=\s*["']?([A-Za-z0-9_\-:.]+)/i.exec(head);
    if (m) label = m[1];
  }
  if (!label) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      label = 'windows-1252';
    }
  }
  // A BOM wins over everything.
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) label = 'utf-8';
  return decodeBytes(bytes, label);
}

/**
 * The HTML body from PidTagHtml in any storage form MS-OXCMSG allows:
 * PT_BINARY (0x0102, bytes in the internet code page), PT_UNICODE (0x001F)
 * or PT_STRING8 (0x001E, the message's ANSI code page). msgreader maps only
 * the first two, so the 8-bit form is read from the raw property (review M6).
 */
function readHtmlBody(d, raw, cp) {
  const clean = (s) => {
    const t = typeof s === 'string' ? stripTrailingNul(s) : '';
    return t === '' ? null : t;
  };
  if (d.html && d.html.length) {
    const v = clean(decodeHtmlBytes(d.html, d.internetCodepage));
    if (v) return v;
  }
  if (typeof d.bodyHtml === 'string') {
    const v = clean(d.bodyHtml);
    if (v) return v;
  }
  if (raw) {
    for (const type of [0x0102, 0x001f, 0x001e]) {
      const bytes = raw.get((0x1013 << 16 | type) >>> 0);
      if (!bytes || !bytes.length) continue;
      let v;
      if (type === 0x0102) v = decodeHtmlBytes(bytes, d.internetCodepage);
      else if (type === 0x001f) v = decodeBytes(bytes, 'utf-16le');
      else v = decodeBytes(bytes, cp); // PT_STRING8: the message (ANSI) code page, as for every 8-bit string
      v = clean(v);
      if (v) return v;
    }
  }
  return null;
}

const toDate = (s) => {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
};

/**
 * @param {Uint8Array|ArrayBuffer} input
 * @param {{maxDepth?:number}} [opts]
 * @param {number} [depth]
 */
export function readMsg(input, opts = {}, depth = 0) {
  const maxDepth = opts.maxDepth ?? 16;
  if (depth > maxDepth) throw new MsgError('TOO_DEEP', `Embedded messages are nested more than ${maxDepth} levels deep.`);
  const u8 = toU8(input);
  checkCompoundFile(u8);

  let parsed;
  try {
    parsed = parseOnce(u8, null);
  } catch (e) {
    if (e instanceof MsgError) throw e;
    throw new MsgError('UNREADABLE', `The file could not be read as an Outlook message (${e && e.message ? e.message : e}).`, e);
  }
  const warnings = [];
  const cpChoice = chooseAnsiCodepage(parsed.data);
  let reparsed = false;
  if (parsed.ansiHigh) {
    try {
      parsed = parseOnce(u8, `cp${cpChoice.codepage}`);
      reparsed = true;
    } catch (e) {
      warnings.push(`Some text may show the wrong characters (code page ${cpChoice.codepage} could not be applied).`);
    }
  }
  const { reader, data: d, extras } = parsed;
  const cp = cpChoice.codepage;
  const x = collect(extras, d, EXTRA_MSG, cp);

  const model = {
    messageClass: d.messageClass || 'IPM.Note',
    subject: d.subject ?? null,
    codepage: { ...cpChoice, applied: reparsed },
    sender: {
      name: d.senderName || '',
      email: d.senderEmail || '',
      addrType: d.senderAddressType || '',
      smtp: d.senderSmtpAddress || '',
    },
    representing: {
      name: x.sentRepresentingName || '',
      email: x.sentRepresentingEmail || '',
      addrType: x.sentRepresentingAddrType || '',
      smtp: d.sentRepresentingSmtpAddress || '',
    },
    recipients: [],
    transportHeaders: stripTrailingNul(d.headers || ''),
    dates: {
      submit: toDate(d.clientSubmitTime),
      delivery: toDate(d.messageDeliveryTime),
      creation: toDate(d.creationTime),
      modification: toDate(d.lastModificationTime),
    },
    messageId: d.messageId || null,
    inReplyTo: x.inReplyTo || null,
    references: x.references || null,
    importance: typeof x.importance === 'number' ? x.importance : null,
    sensitivity: typeof x.sensitivity === 'number' ? x.sensitivity : null,
    messageFlags: d.messageFlags ?? null,
    // MS-OXMSG string and body streams are often padded with NULs after
    // the text (QA defect 1: about 7,400 after </html>); they are removed.
    body: d.body == null ? null : stripTrailingNul(d.body),
    html: null,
    htmlProperty: !!(d.html || d.bodyHtml) || [...(extras.get(d) || new Map()).keys()].some((t) => (t >>> 16) === 0x1013),
    compressedRtf: d.compressedRtf || null,
    internetCodepage: d.internetCodepage || null,
    appointment: {
      start: toDate(d.apptStartWhole),
      end: toDate(d.apptEndWhole),
      location: d.apptLocation || d.location || '',
      globalId: d.globalAppointmentID || null,
      recur: d.apptRecur || null,
      tzStart: d.apptTZDefStartDisplay || null,
      tzEnd: d.apptTZDefEndDisplay || null,
      tzRecur: d.apptTZDefRecur || null,
      tzStruct: d.timeZoneStruct || null,
      tzDesc: d.timeZoneDesc || '',
    },
    contact: d.messageClass && /^IPM\.Contact/i.test(d.messageClass) ? d : null,
    attachments: [],
    warnings,
  };
  model.html = readHtmlBody(d, extras.get(d), cp);
  if (model.htmlProperty && model.html == null) {
    warnings.push(`The HTML version of the body could not be read.${model.body ? ' The plain-text version is shown.' : ''}`);
  }

  for (const rc of d.recipients || []) {
    const rx = collect(extras, rc, EXTRA_RECIP, cp);
    model.recipients.push({
      type: rc.recipType || 'to',
      name: rc.name || rx.recipientDisplayName || rx.displayName || '',
      email: rc.email || rx.emailAddress || '',
      addrType: rc.addressType || rx.addrType || '',
      smtp: rc.smtpAddress || rx.smtpAddress || '',
    });
  }

  (d.attachments || []).forEach((a, index) => {
    const ax = collect(extras, a, EXTRA_ATTACH, cp);
    const att = {
      index,
      filename: a.fileName || a.fileNameShort || a.name || '',
      displayName: a.name || '',
      extension: a.extension || '',
      mime: a.attachMimeTag || ax.mimeTag || '',
      cid: a.pidContentId || null,
      contentLocation: ax.contentLocation || null,
      hidden: !!(a.attachmentHidden || ax.hidden),
      method: typeof ax.attachMethod === 'number' ? ax.attachMethod : null,
      data: null,
      embedded: null,
      error: null,
    };
    try {
      if (a.innerMsgContent) {
        const g = reader.getAttachment(a);
        att.embedded = readMsg(g.content, opts, depth + 1);
        att.filename = att.filename || g.fileName || '';
      } else if (att.method === 2 || att.method === 3 || att.method === 4 || att.method === 7) {
        att.error = 'it is only a link to a file outside the message';
      } else {
        const g = reader.getAttachment(a);
        att.data = g.content instanceof Uint8Array ? g.content : new Uint8Array(g.content || []);
      }
    } catch (e) {
      if (e instanceof MsgError && e.code === 'TOO_DEEP') throw e;
      att.error = e instanceof MsgError ? e.message : `it could not be read: ${e && e.message ? e.message : e}`;
    }
    model.attachments.push(att);
  });

  return model;
}
