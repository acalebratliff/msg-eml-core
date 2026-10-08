// MIME encodings: base64 (RFC 2045), quoted-printable (RFC 2045),
// encoded-words (RFC 2047), parameter values (RFC 2231), header folding
// (RFC 5322). Pure functions over strings and Uint8Array; no Node APIs.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const utf8 = new TextEncoder();

export function utf8Bytes(s) {
  return utf8.encode(s);
}

/** Base64 without line breaks. */
export function base64(u8) {
  let out = '';
  const n = u8.length;
  let i = 0;
  for (; i + 2 < n; i += 3) {
    const v = (u8[i] << 16) | (u8[i + 1] << 8) | u8[i + 2];
    out += B64[v >> 18] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63];
  }
  if (i < n) {
    const v = (u8[i] << 16) | ((i + 1 < n ? u8[i + 1] : 0) << 8);
    out += B64[v >> 18] + B64[(v >> 12) & 63] + (i + 1 < n ? B64[(v >> 6) & 63] : '=') + '=';
  }
  return out;
}

/** Base64 body: lines of 76 characters, CRLF separated, trailing CRLF. */
export function base64Body(u8) {
  const s = base64(u8);
  const lines = [];
  for (let i = 0; i < s.length; i += 76) lines.push(s.slice(i, i + 76));
  return lines.join('\r\n') + (lines.length ? '\r\n' : '');
}

const HEX = '0123456789ABCDEF';

/**
 * Quoted-printable body for text (UTF-8). Line breaks in the text become
 * CRLF hard breaks; long lines get soft breaks at 76 characters.
 */
export function quotedPrintable(text) {
  const lines = String(text).replace(/\r\n|\r|\n/g, '\n').split('\n');
  const out = [];
  for (const line of lines) {
    const bytes = utf8.encode(line);
    let cur = '';
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      let tok;
      const last = i === bytes.length - 1;
      if ((b === 0x20 || b === 0x09) && last) tok = '=' + HEX[b >> 4] + HEX[b & 15];
      else if ((b >= 33 && b <= 126 && b !== 61) || b === 0x20 || b === 0x09) tok = String.fromCharCode(b);
      else tok = '=' + HEX[b >> 4] + HEX[b & 15];
      // A dot alone at line start is safe in files but some transports mangle it; encode it.
      if (cur === '' && tok === '.' ) tok = '=2E';
      if (cur.length + tok.length > 75) {
        out.push(cur + '=');
        cur = '';
      }
      cur += tok;
    }
    out.push(cur);
  }
  return out.join('\r\n') + '\r\n';
}

/** True when text can go as 7bit: ASCII, no NUL, lines <= 998 octets. */
export function is7bitSafe(text) {
  if (/[^\x01-\x7f]/.test(text)) return false;
  const lines = text.split(/\r\n|\r|\n/);
  for (const l of lines) if (l.length > 900) return false;
  return true;
}

/** Text as a 7bit body with CRLF line endings. */
export function crlf(text) {
  const t = String(text).replace(/\r\n|\r|\n/g, '\r\n');
  return t.endsWith('\r\n') ? t : t + '\r\n';
}

/** Needs RFC 2047 encoding in a header (non-ASCII, controls, or "=?"). */
export function needsEncoding(s) {
  return /[^\x20-\x7e]/.test(s) || s.includes('=?');
}

/**
 * RFC 2047 B-encoded words for a UTF-8 string, each word <= 75 characters,
 * never splitting a character. Returns the words joined by a space.
 */
export function encodeWords(s) {
  const words = [];
  const maxBytes = 45; // 45 bytes -> 60 base64 chars; with "=?UTF-8?B?" and "?=" = 72
  let chunk = [];
  let chunkLen = 0;
  const flush = () => {
    if (chunkLen) {
      const buf = new Uint8Array(chunkLen);
      let o = 0;
      for (const c of chunk) { buf.set(c, o); o += c.length; }
      words.push(`=?UTF-8?B?${base64(buf)}?=`);
      chunk = [];
      chunkLen = 0;
    }
  };
  for (const ch of s) { // iterates code points
    const b = utf8.encode(ch);
    if (chunkLen + b.length > maxBytes) flush();
    chunk.push(b);
    chunkLen += b.length;
  }
  flush();
  return words.join(' ');
}

/**
 * Clean text that will go into a header: CR, LF and TAB runs become one
 * space, every other C0 control, DEL and NUL is removed. This is the one
 * place where values read from the .msg lose characters that could break a
 * header line (header injection); every header-bound string passes here or
 * through a stricter validator (addresses, msg-ids, content-ids).
 */
export function cleanHeaderText(s) {
  return String(s ?? '').replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '');
}

/** Remove trailing NUL characters (padding after MS-OXMSG string and body values). */
export function stripTrailingNul(s) {
  if (typeof s !== 'string') return s;
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 0) end--;
  return end === s.length ? s : s.slice(0, end);
}

const needsWordEncoding = (w) => /[^\x20-\x7e]/.test(w) || w.includes('=?');

/**
 * Unstructured header value (Subject, X-*, replayed free-text headers).
 * Only the words that need it become RFC 2047 encoded-words; a run of
 * adjacent such words (and the spaces between them) is encoded together,
 * because whitespace between two encoded-words is not displayed.
 */
export function unstructured(s) {
  const clean = cleanHeaderText(s);
  if (!needsEncoding(clean)) return clean;
  const words = clean.split(' ');
  const out = [];
  let run = null;
  const flush = () => { if (run !== null) { out.push(encodeWords(run)); run = null; } };
  for (const w of words) {
    if (w !== '' && needsWordEncoding(w)) {
      run = run === null ? w : `${run} ${w}`;
    } else if (w === '' && run !== null) {
      run += ' ';
    } else {
      flush();
      out.push(w);
    }
  }
  flush();
  return out.join(' ');
}

const ATEXT = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~ ]*$/;

/** Display name as phrase: atoms, quoted-string, or encoded-words. */
export function phrase(name) {
  const n = cleanHeaderText(name).replace(/ {2,}/g, ' ').trim();
  if (!n) return '';
  if (needsEncoding(n)) return encodeWords(n);
  if (ATEXT.test(n) && !/^ | $|  /.test(n)) return n;
  return '"' + n.replace(/(["\\])/g, '\\$1') + '"';
}

/**
 * Header parameter, e.g. filename. ASCII token-safe values stay as a quoted
 * string; others use RFC 2231 extended notation, split into continuations
 * so no line gets long. Returns e.g. 'filename="a.pdf"' or
 * "filename*0*=UTF-8''...;\r\n filename*1*=...".
 */
export function param(name, value) {
  const v = cleanHeaderText(value);
  if (!/[^\x20-\x7e]/.test(v) && v.length <= 60) {
    return `${name}="${v.replace(/(["\\])/g, '\\$1')}"`;
  }
  const pieces = [];
  let cur = '';
  for (const ch of v) {
    // percent-encode per character so no continuation splits a UTF-8 sequence
    let tok = '';
    for (const b of utf8.encode(ch)) {
      const c = String.fromCharCode(b);
      tok += b < 128 && /[A-Za-z0-9!#$&+\-.^_`|~]/.test(c) ? c : '%' + HEX[b >> 4] + HEX[b & 15];
    }
    if (cur.length + tok.length > 50) { pieces.push(cur); cur = ''; }
    cur += tok;
  }
  pieces.push(cur);
  if (pieces.length === 1) return `${name}*=UTF-8''${pieces[0]}`;
  return pieces.map((p, i) => (i === 0 ? `${name}*0*=UTF-8''${p}` : `${name}*${i}*=${p}`)).join(';\r\n ');
}

export class HeaderInjectionError extends Error {}

const HEADER_NAME = /^[!-9;-~]+$/;

/**
 * Last line of defence against header injection: a value may hold only
 * printable ASCII, spaces and tabs (plus the encoder's own "\r\n " forced
 * folds). With utf8 (RFC 6532 output) non-ASCII is also allowed, but never
 * a control character. Anything else means a value skipped sanitising: that
 * is a bug, so conversion stops instead of writing a broken header.
 */
export function assertHeaderSafe(name, value, utf8 = false) {
  if (!HEADER_NAME.test(name)) throw new HeaderInjectionError(`invalid header name ${JSON.stringify(name)}`);
  const bad = utf8 ? /[\x00-\x08\x0a-\x1f\x7f]/ : /[^\x09\x20-\x7e]/;
  for (const seg of String(value).split('\r\n ')) {
    if (bad.test(seg)) throw new HeaderInjectionError(`unsafe character in ${name} header`);
  }
}

const MAX_LINE = 998;

/**
 * Fold a header line at spaces so lines stay under 78 characters where
 * possible (RFC 5322 2.2.3). A "\r\n " already in the value is a forced fold.
 * A fold is never placed so that a line holds only whitespace, and a single
 * word longer than the 998-octet limit is split hard (that inserts a space,
 * which is the lesser harm next to an invalid message).
 */
export function foldHeader(name, value, { utf8 = false } = {}) {
  assertHeaderSafe(name, value, utf8);
  const segments = String(value).split('\r\n ');
  let out = name + ':';
  let curLen = out.length;
  segments.forEach((segment, i) => {
    if (i > 0) { out += '\r\n'; curLen = 0; }
    // Empty words (from double spaces) stay attached to the previous word.
    const words = [];
    for (const w of segment.split(' ')) {
      if (w === '' && words.length) words[words.length - 1] += ' ';
      else words.push(w);
    }
    words.forEach((word, j) => {
      let piece = ' ' + word;
      if (j > 0 && curLen > 1 && curLen + piece.length > 76) { out += '\r\n'; curLen = 0; }
      while (curLen + piece.length > MAX_LINE - 2) {
        const room = Math.max(1, MAX_LINE - 2 - curLen);
        out += piece.slice(0, room) + '\r\n';
        piece = ' ' + piece.slice(room);
        curLen = 0;
      }
      out += piece;
      curLen += piece.length;
    });
  });
  return out;
}
