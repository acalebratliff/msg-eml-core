// A small MIME tree and serializer. Output is CRLF-terminated; every part is
// 7bit-clean (quoted-printable or base64) except raw entities passed through
// unchanged (signed S/MIME content, which must stay byte-exact).

import { base64Body, quotedPrintable, is7bitSafe, crlf, param, foldHeader, phrase, unstructured } from './encode.js';

export class Part {
  constructor(type) {
    this.type = type; // e.g. 'text/plain'
    this.params = []; // [name, value] already formatted by encode.param or raw tokens
    this.headers = []; // extra headers [name, value] (ASCII, unfolded)
    this.body = null; // string (ASCII) or Uint8Array (raw)
    this.cte = null;
    this.children = null;
    this.raw = null; // complete raw entity (headers + body), Uint8Array
  }

  static text(subtype, text, extra = {}) {
    const p = new Part(`text/${subtype}`);
    p.params.push(['charset', 'utf-8']);
    if (extra.method) p.params.push(['method', extra.method]);
    const t = String(text);
    if (is7bitSafe(t)) {
      p.cte = '7bit';
      p.body = crlf(t);
    } else {
      p.cte = 'quoted-printable';
      p.body = quotedPrintable(t);
    }
    return p;
  }

  static binary(type, bytes, { filename, cid, inline, description } = {}) {
    const p = new Part(type);
    if (filename) p.params.push([null, param('name', filename)]);
    p.cte = 'base64';
    p.body = base64Body(bytes);
    if (filename || !inline) {
      const disp = inline ? 'inline' : 'attachment';
      p.headers.push(['Content-Disposition', filename ? `${disp}; ${param('filename', filename)}` : disp]);
    } else {
      p.headers.push(['Content-Disposition', 'inline']);
    }
    if (cid) {
      if (!isValidCid(cid)) throw new Error('invalid Content-ID reached the serializer');
      p.headers.push(['Content-ID', `<${cid}>`]);
    }
    if (description) p.headers.push(['Content-Description', unstructured(description)]);
    return p;
  }

  static multipart(subtype, children, params = []) {
    const p = new Part(`multipart/${subtype}`);
    p.children = children;
    p.params.push(...params);
    return p;
  }

  /** message/rfc822 wrapping an already serialized message (Uint8Array). */
  static message(bytes, { filename } = {}) {
    const p = new Part('message/rfc822');
    p.cte = hasHighBytes(bytes) ? '8bit' : '7bit';
    p.body = bytes;
    const disp = filename ? `attachment; ${param('filename', filename)}` : 'attachment';
    p.headers.push(['Content-Disposition', disp]);
    return p;
  }

  /** A complete entity (headers and body) used verbatim. */
  static rawEntity(bytes) {
    const p = new Part(null);
    p.raw = bytes;
    return p;
  }
}

/** A Content-ID value (without <>) that is safe to write: printable ASCII, no <, > or whitespace. */
export function isValidCid(cid) {
  return typeof cid === 'string' && cid.length > 0 && cid.length <= 900 && /^[\x21-\x3b\x3d\x3f-\x7e]+$/.test(cid);
}

function hasHighBytes(u8) {
  for (let i = 0; i < u8.length; i++) if (u8[i] > 0x7f) return true;
  return false;
}

function contentTypeValue(part, boundary) {
  const ps = part.params.map(([k, v]) => (k === null ? v : `${k}=${v}`));
  if (boundary) ps.push(`boundary="${boundary}"`);
  return [part.type, ...ps].join('; ');
}

function chunksToLatin1(chunks) {
  let s = '';
  for (const c of chunks) {
    if (typeof c === 'string') s += c;
    else for (let i = 0; i < c.length; i += 8192) s += String.fromCharCode.apply(null, c.subarray(i, i + 8192));
  }
  return s;
}

/**
 * Serialize a part (headers + body) into chunks (strings and Uint8Arrays).
 * @param {Part} part
 * @param {{n:number}} ctx boundary counter
 */
export function serializePart(part, ctx, extraHeaders = []) {
  if (part.raw) return [part.raw];
  const out = [];
  const head = [...extraHeaders];
  if (part.children) {
    const childChunks = part.children.map((c) => serializePart(c, ctx));
    const all = chunksToLatin1(childChunks.flat());
    let boundary;
    do {
      ctx.n++;
      boundary = `=_mec_${ctx.n.toString(36)}_${(ctx.salt || 0).toString(36)}`;
    } while (all.includes('--' + boundary));
    head.push(['Content-Type', contentTypeValue(part, boundary)]);
    head.push(...part.headers);
    for (const [k, v] of head) out.push(foldHeader(k, v, ctx) + '\r\n');
    out.push('\r\n');
    for (const cc of childChunks) {
      out.push(`--${boundary}\r\n`);
      out.push(...cc);
    }
    out.push(`--${boundary}--\r\n`);
    return out;
  }
  head.push(['Content-Type', contentTypeValue(part)]);
  if (part.cte) head.push(['Content-Transfer-Encoding', part.cte]);
  head.push(...part.headers);
  for (const [k, v] of head) out.push(foldHeader(k, v, ctx) + '\r\n');
  out.push('\r\n');
  out.push(part.body);
  const last = part.body;
  const endsCrlf = typeof last === 'string'
    ? last.endsWith('\r\n')
    : last.length >= 2 && last[last.length - 2] === 13 && last[last.length - 1] === 10;
  if (!endsCrlf) out.push('\r\n');
  return out;
}

const utf8enc = new TextEncoder();

/**
 * Join chunks into one Uint8Array. Strings are ASCII (bodies are always
 * QP or base64); a string with non-ASCII can only be a header that passed
 * foldHeader's check with RFC 6532 (utf8) output on, and is written as UTF-8.
 */
export function concatChunks(chunks) {
  const conv = chunks.map((c) => (typeof c === 'string' && /[^\x00-\x7f]/.test(c) ? utf8enc.encode(c) : c));
  let len = 0;
  for (const c of conv) len += c.length;
  const u8 = new Uint8Array(len);
  let o = 0;
  for (const c of conv) {
    if (typeof c === 'string') {
      for (let i = 0; i < c.length; i++) u8[o++] = c.charCodeAt(i);
    } else {
      u8.set(c, o);
      o += c.length;
    }
  }
  return u8;
}

/** Split a raw MIME entity into header lines (folds kept) and body offset. */
export function splitEntity(u8) {
  const n = Math.min(u8.length, 65536);
  let end = -1;
  let bodyStart = 0;
  for (let i = 0; i < n; i++) {
    if (u8[i] === 10 && u8[i + 1] === 10) { end = i; bodyStart = i + 2; break; }
    if (u8[i] === 13 && u8[i + 1] === 10 && u8[i + 2] === 13 && u8[i + 3] === 10) { end = i; bodyStart = i + 4; break; }
  }
  if (end < 0) return { headerLines: [], bodyStart: 0 };
  const text = String.fromCharCode.apply(null, u8.subarray(0, end));
  const headerLines = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && headerLines.length) headerLines[headerLines.length - 1] += '\n' + line;
    else if (line.includes(':')) headerLines.push(line);
  }
  return { headerLines, bodyStart };
}

/** Serialize a whole message: top-level headers then the root part. */
export function serializeMessage(headers, root, salt = 0, { utf8 = false } = {}) {
  const ctx = { n: 0, salt, utf8 };
  const top = [...headers, ['MIME-Version', '1.0']];
  if (root.raw) {
    // Root is a verbatim entity (e.g. multipart/signed). Its own header block
    // follows ours, minus MIME-Version and any field we already wrote; its
    // body bytes are copied unchanged so signatures still verify.
    const { headerLines, bodyStart } = splitEntity(root.raw);
    const have = new Set(top.map(([k]) => k.toLowerCase()));
    const chunks = top.map(([k, v]) => foldHeader(k, v, ctx) + '\r\n');
    for (const line of headerLines) {
      const name = line.slice(0, line.indexOf(':')).trim().toLowerCase();
      if (have.has(name)) continue;
      // The stored entity's own header lines are copied as they are, except
      // any line holding a control character (a bare CR, NUL, ...), which
      // could split the header block; such a line is left out.
      if (/[\x00-\x08\x0b-\x1f\x7f]/.test(line.replace(/\r?\n(?=[ \t])/g, '')) || !/^[!-9;-~]+$/.test(line.slice(0, line.indexOf(':')))) continue;
      chunks.push(line.replace(/\r?\n/g, '\r\n') + '\r\n');
    }
    chunks.push('\r\n');
    chunks.push(root.raw.subarray(bodyStart));
    return concatChunks(chunks);
  }
  return concatChunks(serializePart(root, ctx, top));
}

export { phrase };
