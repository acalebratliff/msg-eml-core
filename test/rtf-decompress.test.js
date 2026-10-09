import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decompressRtf, rtfCrc } from '../src/rtf/decompress.js';

const hex = (s) => Uint8Array.from(s.trim().split(/\s+/).map((h) => parseInt(h, 16)));
const latin1 = (u8) => String.fromCharCode(...u8);

// Test vectors published in MS-OXRTFCP section 3.1.1 and 3.1.2.
const EX1 = hex(`2d 00 00 00 2b 00 00 00 4c 5a 46 75 f1 c5 c7 a7 03 00 0a 00 72 63 70 67 31 32 35 42 32 0a f3 20
  68 65 6c 09 00 20 62 77 05 b0 6c 64 7d 0a 80 0f a0`);
const EX2 = hex('1a 00 00 00 1c 00 00 00 4c 5a 46 75 e2 d4 4b 51 41 00 04 20 57 58 59 5a 0d 6e 7d 01 0e b0');

test('MS-OXRTFCP example 1 decompresses', () => {
  const r = decompressRtf(EX1);
  assert.equal(latin1(r.rtf), '{\\rtf1\\ansi\\ansicpg1252\\pard hello world}\r\n');
  assert.deepEqual(r.warnings, []);
});

test('MS-OXRTFCP example 2 (reference crossing the write position)', () => {
  assert.equal(latin1(decompressRtf(EX2).rtf), '{\\rtf1 WXYZWXYZWXYZWXYZWXYZ}');
});

test('CRC matches the header value of the spec example', () => {
  assert.equal(rtfCrc(EX1, 16, EX1.length), 0xa7c7c5f1);
});

test('CRC mismatch is reported, content still returned', () => {
  const bad = EX1.slice();
  bad[12] ^= 0xff;
  const r = decompressRtf(bad);
  assert.match(r.warnings.join(), /The formatted body failed a check/);
  assert.match(latin1(r.rtf), /hello world/);
});

test('UNCOMPRESSED type is copied as-is', () => {
  const body = new TextEncoder().encode('{\\rtf1 plain}');
  const u8 = new Uint8Array(16 + body.length);
  const dv = new DataView(u8.buffer);
  dv.setUint32(0, body.length + 12, true);
  dv.setUint32(4, body.length, true);
  dv.setUint32(8, 0x414c454d, true);
  u8.set(body, 16);
  assert.equal(latin1(decompressRtf(u8).rtf), '{\\rtf1 plain}');
});

test('corrupt headers throw instead of reading past the input', () => {
  assert.throws(() => decompressRtf(new Uint8Array(10)), /16-byte header/);
  const unknown = EX1.slice();
  unknown[8] = 0;
  assert.throws(() => decompressRtf(unknown), /COMPTYPE/);
  const tooBig = EX1.slice();
  new DataView(tooBig.buffer).setUint32(0, 0x7fffffff, true);
  assert.throws(() => decompressRtf(tooBig), /claims/);
  const rawLie = EX1.slice();
  new DataView(rawLie.buffer).setUint32(4, 0x7fffffff, true);
  assert.throws(() => decompressRtf(rawLie), /RAWSIZE/);
});

test('truncated stream (no end marker) terminates', () => {
  const cut = EX1.slice(0, EX1.length - 3);
  new DataView(cut.buffer).setUint32(0, cut.length - 4, true);
  const r = decompressRtf(cut);
  assert.ok(r.rtf.length > 0);
});
