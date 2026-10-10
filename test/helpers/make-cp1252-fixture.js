// Builds test/fixtures/synthetic-cp1252.msg (reproducible; run: node test/helpers/make-cp1252-fixture.js).
//
// Recipe: start from msgreader's nonUnicodeCP932.msg, overwrite one ANSI string
// stream in place with cp1252 text of exactly the same byte length, and patch
// the 4-byte values of PR_INTERNET_CPID (0x3FDE) and PR_MESSAGE_LOCALE_ID
// (0x3FF1) in __properties_version1.0 to 1252 and 1033.
//
// Caveat: only the subject stream is rewritten. The compressed RTF (and any other
// stream) still carries the original Japanese.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, '..', 'fixtures', 'nonUnicodeCP932.msg');
const OUT = path.join(here, '..', 'fixtures', 'synthetic-cp1252.msg');
const STREAM = '__substg1.0_0037001E'; // PR_SUBJECT, ANSI
const PROPS = '__properties_version1.0';
// 0x91 0x92 0x93 0x94 0x96 0x97 0x80 0x85 = ' ' " " - -- euro ellipsis in cp1252
const SPECIAL = [0x91, 0x92, 0x93, 0x94, 0x96, 0x97, 0x80, 0x85];

const buf = Uint8Array.from(fs.readFileSync(SRC));
const dv = new DataView(buf.buffer);
const secSize = 1 << dv.getUint16(30, true);
const miniSize = 1 << dv.getUint16(32, true);
const sectorOff = (s) => (s + 1) * secSize;

// FAT
const difat = [];
for (let i = 0; i < 109; i++) { const v = dv.getUint32(76 + i * 4, true); if (v < 0xfffffffa) difat.push(v); }
if (dv.getUint32(72, true) !== 0) throw new Error('DIFAT chain not supported');
const fat = [];
for (const s of difat) for (let i = 0; i < secSize / 4; i++) fat.push(dv.getUint32(sectorOff(s) + i * 4, true));
const chain = (start, table) => {
  const out = [];
  for (let s = start; s < 0xfffffffa; s = table[s]) { out.push(s); if (out.length > table.length) throw new Error('loop'); }
  return out;
};

// Directory
const dirChain = chain(dv.getUint32(48, true), fat);
const entries = [];
for (const s of dirChain) {
  for (let i = 0; i < secSize / 128; i++) {
    const o = sectorOff(s) + i * 128;
    const nlen = dv.getUint16(o + 64, true);
    const name = new TextDecoder('utf-16le').decode(buf.subarray(o, o + Math.max(0, nlen - 2)));
    entries.push({ name, type: buf[o + 66], start: dv.getUint32(o + 116, true), size: dv.getUint32(o + 120, true) });
  }
}
const root = entries[0];
const miniCutoff = dv.getUint32(56, true);
const miniFat = [];
for (const s of chain(dv.getUint32(60, true), fat)) for (let i = 0; i < secSize / 4; i++) miniFat.push(dv.getUint32(sectorOff(s) + i * 4, true));
const miniStream = chain(root.start, fat);

// Absolute file offsets of each piece of a stream, in order.
function pieces(e) {
  if (e.size >= miniCutoff) return chain(e.start, fat).map((s) => ({ off: sectorOff(s), len: secSize }));
  return chain(e.start, miniFat).map((m) => {
    const abs = m * miniSize;
    return { off: sectorOff(miniStream[Math.floor(abs / secSize)]) + (abs % secSize), len: miniSize };
  });
}
function writeStream(e, bytes, at = 0) {
  let pos = 0;
  for (const p of pieces(e)) {
    for (let i = 0; i < p.len && pos < e.size; i++, pos++) {
      if (pos >= at && pos - at < bytes.length) buf[p.off + i] = bytes[pos - at];
    }
  }
}
function readStream(e) {
  const out = new Uint8Array(e.size);
  let pos = 0;
  for (const p of pieces(e)) for (let i = 0; i < p.len && pos < e.size; i++, pos++) out[pos] = buf[p.off + i];
  return out;
}
const find = (name) => {
  const e = entries.find((x) => x.name === name && x.type === 2);
  if (!e) throw new Error(`stream not found: ${name}`);
  return e;
};

// 1. Subject text: same byte length as the original (NUL included).
const subj = find(STREAM);
const text = [...Buffer.from('Quotes ')];
const body = [...SPECIAL];
const pad = subj.size - 1 - text.length - body.length;
if (pad < 0) throw new Error('subject stream too short');
const fresh = Uint8Array.from([...text, ...body, ...Buffer.from(' '.repeat(pad)), 0]);
if (fresh.length !== subj.size) throw new Error('length mismatch');
writeStream(subj, fresh);

// 2. Property table: 32-byte header (top-level message), then 16-byte entries
// [tag u32][flags u32][8-byte value]. Patch the value's first 4 bytes.
const props = find(PROPS);
const ptab = readStream(props);
const pdv = new DataView(ptab.buffer);
const patch = (tag, value) => {
  for (let o = 32; o + 16 <= ptab.length; o += 16) {
    if (pdv.getUint32(o, true) === tag) {
      const v = new Uint8Array(4);
      new DataView(v.buffer).setUint32(0, value, true);
      writeStream(props, v, o + 8);
      return;
    }
  }
  throw new Error(`property 0x${tag.toString(16)} not found`);
};
patch(0x3fde0003, 1252); // PR_INTERNET_CPID
patch(0x3ff10003, 1033); // PR_MESSAGE_LOCALE_ID

fs.writeFileSync(OUT, buf);
console.log(`wrote ${OUT} (${buf.length} bytes)`);
