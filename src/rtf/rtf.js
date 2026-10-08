// RTF reading for mail bodies: recognising and de-encapsulating HTML or plain
// text (MS-OXRTFEX section 2.2.3), and a plain-text fallback for RTF that
// carries no encapsulated content.
//
// Clean-room implementation written from the published Microsoft Open
// Specifications [MS-OXRTFEX] (sections 2.1.3.1.1-2.1.3.1.6, 2.2.3.1-2.2.3.3)
// and the RTF 1.9.1 specification [MSFT-RTF]; no code from other RTF
// libraries was consulted or copied.

import { decodeBytes, charsetToCodepage } from '../codepage.js';

const BACKSLASH = 0x5c;
const LBRACE = 0x7b;
const RBRACE = 0x7d;
const CR = 0x0d;
const LF = 0x0a;

const isLetter = (b) => (b >= 0x61 && b <= 0x7a) || (b >= 0x41 && b <= 0x5a);
const isDigit = (b) => b >= 0x30 && b <= 0x39;
const hexVal = (b) => {
  if (b >= 0x30 && b <= 0x39) return b - 0x30;
  if (b >= 0x61 && b <= 0x66) return b - 0x57;
  if (b >= 0x41 && b <= 0x46) return b - 0x37;
  return -1;
};

/**
 * Tokenise RTF bytes. Calls `emit(token)` for each token. Tokens:
 *   {t:'{'} {t:'}'} {t:'w', w:name, p:param|null} {t:'s', s:char}
 *   {t:'x', b:byte} for \'hh   {t:'b', bytes:Uint8Array} for text runs
 *   {t:'bin', n} for \binN (data skipped)
 * Linear in input size; never looks beyond the end of input.
 */
export function tokenize(u8, emit) {
  const n = u8.length;
  let i = 0;
  while (i < n) {
    const c = u8[i];
    if (c === LBRACE) { emit({ t: '{' }); i++; continue; }
    if (c === RBRACE) { emit({ t: '}' }); i++; continue; }
    if (c === CR || c === LF) { i++; continue; }
    if (c === BACKSLASH) {
      i++;
      if (i >= n) break;
      const d = u8[i];
      if (isLetter(d)) {
        const start = i;
        while (i < n && isLetter(u8[i]) && i - start < 32) i++;
        let name = '';
        for (let k = start; k < i; k++) name += String.fromCharCode(u8[k]);
        let param = null;
        if (i < n && (u8[i] === 0x2d || isDigit(u8[i]))) {
          let neg = false;
          if (u8[i] === 0x2d) { neg = true; i++; }
          let v = 0;
          let digits = 0;
          while (i < n && isDigit(u8[i]) && digits < 10) { v = v * 10 + (u8[i] - 0x30); i++; digits++; }
          param = neg ? -v : v;
        }
        if (i < n && u8[i] === 0x20) i++; // delimiter space belongs to the control word
        if (name === 'bin' && param && param > 0) {
          const skip = Math.min(param, n - i);
          emit({ t: 'bin', n: skip });
          i += skip;
          continue;
        }
        emit({ t: 'w', w: name, p: param });
        continue;
      }
      if (d === 0x27) { // \'hh
        const h1 = i + 1 < n ? hexVal(u8[i + 1]) : -1;
        const h2 = i + 2 < n ? hexVal(u8[i + 2]) : -1;
        if (h1 >= 0 && h2 >= 0) { emit({ t: 'x', b: h1 * 16 + h2 }); i += 3; } else { i += 1; }
        continue;
      }
      if (d === CR || d === LF) { emit({ t: 'w', w: 'par', p: null }); i++; continue; }
      emit({ t: 's', s: String.fromCharCode(d) });
      i++;
      continue;
    }
    const start = i;
    while (i < n) {
      const e = u8[i];
      if (e === BACKSLASH || e === LBRACE || e === RBRACE || e === CR || e === LF) break;
      i++;
    }
    emit({ t: 'b', bytes: u8.subarray(start, i) });
  }
}

/**
 * MS-OXRTFEX 2.2.3.1: look at no more than the first 10 tokens.
 * @returns {'html'|'text'|null} null = pure RTF (no encapsulation).
 */
export function detectEncapsulation(u8) {
  if (!u8 || u8.length < 6) return null;
  const head = String.fromCharCode(...u8.subarray(0, 6));
  if (head !== '{\\rtf1') return null;
  let count = 0;
  let result = null;
  let done = false;
  const STOP = {};
  try {
    tokenize(u8.subarray(0, Math.min(u8.length, 4096)), (tok) => {
      if (done) throw STOP;
      count++;
      if (tok.t === 'w') {
        if (tok.w === 'fromhtml') { result = 'html'; done = true; }
        else if (tok.w === 'fromtext') { result = 'text'; done = true; }
      } else if (tok.t !== '{') {
        done = true; // any other token type ends inspection: pure RTF
      }
      if (count >= 10) done = true;
      if (done) throw STOP;
    });
  } catch (e) {
    if (e !== STOP) throw e;
  }
  return result;
}

// Destinations that never produce visible text and are skipped whole
// (MS-OXRTFEX 2.2.3.2: "standard RTF destination groups that do not produce
// visible text"). \fonttbl is processed separately.
const SKIP_DESTINATIONS = new Set([
  'colortbl', 'stylesheet', 'info', 'pict', 'object', 'objdata', 'themedata', 'colorschememapping',
  'datastore', 'latentstyles', 'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'xmlnstbl',
  'header', 'headerl', 'headerr', 'headerf', 'footer', 'footerl', 'footerr', 'footerf',
  'author', 'operator', 'title', 'subject', 'keywords', 'comment', 'doccomm', 'creatim', 'revtim', 'printim', 'buptim',
  'pntext', 'pntxta', 'pntxtb', 'listtext', 'fldinst', 'filetbl', 'revtbl', 'pgdsctbl', 'protusertbl',
  'xe', 'tc', 'txe', 'bkmkstart', 'bkmkend', 'footnote', 'annotation', 'atnid', 'atnauthor', 'mmathPr',
  'nonshppict', 'shppict', 'shpinst', 'sp', 'sn', 'sv', 'template', 'userprops', 'wgrffmtfilter', 'docvar',
  'factoidname', 'ftnsep', 'ftnsepc', 'ftncn', 'aftnsep', 'aftnsepc', 'aftncn', 'fchars', 'lchars',
]);

// Control words that stand for a character (RTF spec; MS-OXRTFEX 2.1.3.1.4.2 table).
// Maps, not object literals: a control word such as \constructor or
// \toString must not find Object.prototype members (review M3).
const CHAR_WORDS = new Map(Object.entries({
  lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”',
  bullet: '•', endash: '–', emdash: '—', enspace: ' ', emspace: ' ',
  qmspace: ' ', zwj: '‍', zwnj: '‌', ltrmark: '‎', rtlmark: '‏',
}));
const CHAR_SYMBOLS = new Map(Object.entries({ '\\': '\\', '{': '{', '}': '}', '~': ' ', '_': '­', '-': '­' }));

/**
 * Core walker. mode:
 *   'html' / 'text' - de-encapsulate (MS-OXRTFEX 2.2.3.2 / 2.2.3.3)
 *   'plain'         - pure RTF to plain text (fallback; not a format conversion)
 */
function walk(u8, mode) {
  const out = [];
  let pending = [];
  let pendingCp = null;
  const flush = () => {
    if (pending.length) {
      out.push(decodeBytes(Uint8Array.from(pending), pendingCp || 1252));
      pending = [];
    }
  };
  const pushBytes = (bytes, cp) => {
    if (pendingCp !== cp) { flush(); pendingCp = cp; }
    for (let k = 0; k < bytes.length; k++) pending.push(bytes[k]);
  };
  const pushText = (s) => { flush(); out.push(s); };

  let defaultCp = 1252;
  let defaultFont = null;
  const fontCp = new Map();
  let fontDefId = null;

  let st = { skip: false, fonttbl: false, htmltag: false, htmlrtf: false, font: null, uc: 1, first: false, star: false };
  const stack = [];
  let ucSkip = 0;
  let depth = 0;

  const cpForFont = (f) => {
    const id = f == null ? defaultFont : f;
    const cp = id == null ? undefined : fontCp.get(id);
    return cp || defaultCp;
  };

  const suppressed = () => mode !== 'plain' && !st.htmltag && st.htmlrtf;
  let ended = false;

  tokenize(u8, (tok) => {
    // Nothing after the document's outermost group is RTF content (often a
    // NUL pad left by the compressor; QA defect 1).
    if (ended) return;
    if (tok.t === '{') {
      stack.push(st);
      st = { ...st, first: true, star: false };
      depth++;
      ucSkip = 0;
      return;
    }
    if (tok.t === '}') {
      if (stack.length) st = stack.pop();
      depth--;
      ucSkip = 0;
      if (depth <= 0) ended = true;
      return;
    }

    // Destination recognition: the first control word of a group.
    if (st.first) {
      if (tok.t === 's' && tok.s === '*') { st.star = true; return; }
      st.first = false;
      if (tok.t === 'w') {
        const w = tok.w;
        if (w === 'htmltag' && mode === 'html' && !st.skip) { flush(); st.htmltag = true; return; }
        if (st.star) { st.skip = true; return; }
        if (w === 'fonttbl') { st.fonttbl = true; st.skip = true; return; }
        if (SKIP_DESTINATIONS.has(w)) { st.skip = true; return; }
      } else if (st.star) {
        st.skip = true;
      }
    }

    if (st.fonttbl) {
      if (tok.t === 'w') {
        if (tok.w === 'f' && tok.p != null) fontDefId = tok.p;
        else if (tok.w === 'fcharset' && fontDefId != null && tok.p != null) {
          const cp = charsetToCodepage(tok.p);
          if (cp && !fontCp.has(fontDefId)) fontCp.set(fontDefId, cp);
        } else if (tok.w === 'cpg' && fontDefId != null && tok.p) fontCp.set(fontDefId, tok.p);
      }
      return;
    }

    if (tok.t === 'w') {
      const w = tok.w;
      // Header and state words are tracked even inside skipped or suppressed regions.
      if (w === 'ansicpg' && tok.p) { defaultCp = tok.p; return; }
      if (w === 'ansi' && depth <= 1) { return; }
      if (w === 'mac' && depth <= 1) { defaultCp = 10000; return; }
      if (w === 'pc' && depth <= 1) { defaultCp = 437; return; }
      if (w === 'pca' && depth <= 1) { defaultCp = 850; return; }
      if (w === 'deff' && tok.p != null) { defaultFont = tok.p; return; }
      if (w === 'f' && tok.p != null) { st.font = tok.p; return; }
      if (w === 'htmlrtf') { st.htmlrtf = tok.p !== 0; return; }
      if (w === 'uc' && tok.p != null && tok.p >= 0) { st.uc = tok.p; return; }
      if (st.skip) return;
      if (w === 'u' && tok.p != null) {
        if (suppressed()) { ucSkip = st.uc; return; }
        let code = tok.p;
        if (code < 0) code += 65536;
        pushText(String.fromCharCode(code & 0xffff));
        ucSkip = st.uc;
        return;
      }
      if (ucSkip > 0) { ucSkip--; return; }
      if (suppressed()) return;
      if (w === 'par' || w === 'line') { pushText('\r\n'); return; }
      if (w === 'tab') { pushText('\t'); return; }
      if (mode === 'plain') {
        if (w === 'row' || w === 'page' || w === 'sect') { pushText('\r\n'); return; }
        if (w === 'cell') { pushText('\t'); return; }
      }
      if (CHAR_WORDS.has(w)) { pushText(CHAR_WORDS.get(w)); return; }
      return; // any other control word: ignored
    }

    if (tok.t === 'bin') return;
    if (st.skip) return;

    if (tok.t === 's') {
      if (ucSkip > 0) { ucSkip--; return; }
      if (suppressed()) return;
      const ch = CHAR_SYMBOLS.get(tok.s);
      if (ch !== undefined) pushText(ch);
      return;
    }

    // Text bytes and \'hh escapes.
    const cp = st.htmltag ? defaultCp : cpForFont(st.font);
    if (tok.t === 'x') {
      if (ucSkip > 0) { ucSkip--; return; }
      if (suppressed()) return;
      pushBytes([tok.b], cp);
      return;
    }
    if (tok.t === 'b') {
      let bytes = tok.bytes;
      if (ucSkip > 0) {
        const k = Math.min(ucSkip, bytes.length);
        ucSkip -= k;
        bytes = bytes.subarray(k);
        if (!bytes.length) return;
      }
      if (suppressed()) return;
      pushBytes(bytes, cp);
    }
  });
  flush();
  return out.join('');
}

/**
 * De-encapsulate HTML or plain text from RTF bytes.
 * @param {Uint8Array} rtf decompressed RTF
 * @returns {{type:'html'|'text', content:string}|null} null if not encapsulated.
 */
export function deEncapsulate(rtf) {
  const kind = detectEncapsulation(rtf);
  if (!kind) return null;
  return { type: kind, content: walk(rtf, kind) };
}

/** Plain-text rendering of pure RTF (for when there is no other body). */
export function rtfToText(rtf) {
  return walk(rtf, 'plain').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
