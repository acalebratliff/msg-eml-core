// Parsing of stored internet headers (PidTagTransportMessageHeaders) and of
// address lists, plus RFC 2047 decoding for display names.

import { decodeBytes } from './codepage.js';

/** Split a header block into [name, value] pairs (unfolded). */
export function parseHeaderBlock(text) {
  if (!text) return [];
  const lines = String(text).replace(/\r\n|\r/g, '\n').split('\n');
  const out = [];
  for (const line of lines) {
    if (line === '') {
      if (out.length) break; // end of header section
      continue;
    }
    if (/^[ \t]/.test(line)) {
      if (out.length) out[out.length - 1][1] += ' ' + line.trim();
      continue;
    }
    const m = /^([!-9;-~]+):[ \t]*(.*)$/.exec(line);
    if (m) out.push([m[1], m[2].trim()]);
  }
  return out;
}

export function headerValue(pairs, name) {
  const n = name.toLowerCase();
  for (const [k, v] of pairs) if (k.toLowerCase() === n) return v;
  return null;
}

function b64decode(s) {
  const map = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = s.replace(/[^A-Za-z0-9+/]/g, '');
  const out = [];
  let buf = 0;
  let bits = 0;
  for (const ch of clean) {
    buf = (buf << 6) | map.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/** Decode RFC 2047 encoded-words in a header fragment. */
export function decodeWords(s) {
  if (!s || !s.includes('=?')) return s;
  return s
    .replace(/(=\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=)\s+(?==\?)/g, '$1')
    .replace(/=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g, (all, cs, enc, text) => {
      const charset = cs.split('*')[0];
      let bytes;
      if (enc.toUpperCase() === 'B') bytes = b64decode(text);
      else {
        const arr = [];
        const t = text.replace(/_/g, ' ');
        for (let i = 0; i < t.length; i++) {
          if (t[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(t.slice(i + 1, i + 3))) {
            arr.push(parseInt(t.slice(i + 1, i + 3), 16));
            i += 2;
          } else arr.push(t.charCodeAt(i) & 0xff);
        }
        bytes = Uint8Array.from(arr);
      }
      try {
        return decodeBytes(bytes, charset);
      } catch {
        return all;
      }
    });
}

/**
 * Parse an RFC 5322 address-list into [{name, email}] (groups flattened).
 * Tolerant: never throws.
 */
export function parseAddressList(value) {
  if (!value) return [];
  const items = [];
  let cur = '';
  let inQuote = false;
  let angle = 0;
  let paren = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (inQuote) {
      cur += c;
      if (c === '\\' && i + 1 < value.length) { cur += value[++i]; continue; }
      if (c === '"') inQuote = false;
      continue;
    }
    if (paren) {
      if (c === '(') paren++;
      else if (c === ')') paren--;
      cur += c;
      continue;
    }
    if (c === '"') { inQuote = true; cur += c; continue; }
    if (c === '(') { paren++; cur += c; continue; }
    if (c === '<') angle++;
    if (c === '>') angle = Math.max(0, angle - 1);
    if (!angle && (c === ',' || c === ';')) { items.push(cur); cur = ''; continue; }
    if (!angle && c === ':') { cur = ''; continue; } // group display name: drop
    cur += c;
  }
  items.push(cur);
  const out = [];
  for (const raw of items) {
    const { name, email } = parseMailbox(raw);
    if (name || email) out.push({ name, email });
  }
  return out;
}

/**
 * Split one mailbox ("Name <a@b>", "a@b (Name)", "a@b") into name and email
 * in a single pass. Comments (nested parentheses) are kept apart from the
 * rest, so no regular expression scans the value more than once; this
 * keeps parsing linear on hostile input (many "(" or "<" without a match).
 */
export function parseMailbox(raw) {
  let text = '';
  let comment = '';
  let depth = 0;
  let inQuote = false;
  let angleStart = -1;
  let angleEnd = -1;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (depth) {
      if (c === '\\' && i + 1 < raw.length) { comment += raw[++i]; continue; }
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (!depth) { comment += ' '; continue; } }
      if (depth) comment += c;
      continue;
    }
    if (inQuote) {
      text += c;
      if (c === '\\' && i + 1 < raw.length) { text += raw[++i]; continue; }
      if (c === '"') inQuote = false;
      continue;
    }
    if (c === '(') { depth = 1; continue; }
    if (c === '"') { inQuote = true; text += c; continue; }
    if (c === '<' && angleStart < 0) angleStart = text.length;
    else if (c === '>' && angleStart >= 0 && angleEnd < 0) angleEnd = text.length;
    text += c;
  }
  let name = '';
  let email = '';
  if (angleStart >= 0) {
    name = text.slice(0, angleStart).trim();
    email = text.slice(angleStart + 1, angleEnd >= 0 ? angleEnd : text.length).trim();
  } else {
    email = text.trim();
    name = comment.trim();
  }
  if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) {
    name = name.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  name = decodeWords(name.replace(/\s+/g, ' ')).trim();
  if (email.startsWith('mailto:')) email = email.slice(7);
  return { name, email };
}

/** A plausible SMTP address (and not an X.500 / Exchange DN). */
export function isSmtp(addr) {
  if (!addr || typeof addr !== 'string') return false;
  const a = addr.trim();
  if (a.startsWith('/')) return false;
  return /^[^\s@<>()",;:\x00-\x1f\x7f]+@[^\s@<>()",;:\x00-\x1f\x7f]+$/.test(a);
}
