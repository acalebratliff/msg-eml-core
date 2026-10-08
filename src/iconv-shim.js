// Drop-in replacement for the parts of iconv-lite that @kenjiuno/msgreader
// uses (decode, encode). The browser bundle aliases 'iconv-lite' to this
// module so that no Node Buffer polyfill is needed. Decoding uses the
// WHATWG Encoding API.
import { decodeBytes } from './codepage.js';

export function decode(bytes, encoding) {
  return decodeBytes(bytes, encoding);
}

// msgreader only encodes when writing (Burner, used to rebuild embedded
// messages); the strings it writes there are property names, which are ASCII
// or UTF-16. Support those; refuse anything else loudly.
export function encode(str, encoding) {
  const enc = String(encoding || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (enc === 'utf16le' || enc === 'ucs2') {
    const out = new Uint8Array(str.length * 2);
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      out[i * 2] = c & 0xff;
      out[i * 2 + 1] = c >> 8;
    }
    return out;
  }
  if (enc === 'utf8') return new TextEncoder().encode(str);
  if (enc === 'ascii' || enc === 'latin1' || enc === 'binary') {
    const out = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
    return out;
  }
  throw new Error(`iconv-shim: encoding to ${encoding} is not supported`);
}

export function encodingExists() {
  return true;
}

export default { decode, encode, encodingExists };
