import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { buildMsg, T } from './helpers/build-msg.js';
import { convertMsgToEml, MsgError } from '../src/index.js';

const sample = () => buildMsg({
  props: [[T.MESSAGE_CLASS, 'IPM.Note'], [T.SUBJECT, 'fuzz base'], [T.BODY, 'body '.repeat(300)], [T.SENDER_NAME, 'S'], [T.SENDER_SMTP, 's@x.test']],
  recipients: [{ props: [[T.DISPLAY_NAME, 'R'], [T.SMTP_ADDRESS, 'r@x.test'], [T.RECIPIENT_TYPE, 1]] }],
  attachments: [
    { props: [[T.ATTACH_METHOD, 1], [T.ATTACH_LONG_FILENAME, 'big.bin'], [T.ATTACH_DATA, new Uint8Array(9000).fill(7)]] },
    { props: [[T.ATTACH_METHOD, 5], [T.ATTACH_DISPLAY_NAME, 'in']], embedded: { props: [[T.SUBJECT, 'inner'], [T.BODY, 'x']] } },
  ],
});

const code = (fn) => {
  try { fn(); return 'ok'; } catch (e) { assert.ok(e instanceof MsgError, `not a MsgError: ${e && e.stack}`); return e.code; }
};

test('non-msg input fails with a clear error', () => {
  assert.equal(code(() => convertMsgToEml(new TextEncoder().encode('From: x\r\n\r\nnot a msg'))), 'NOT_MSG');
  assert.equal(code(() => convertMsgToEml(new Uint8Array(0))), 'NOT_MSG');
  assert.equal(code(() => convertMsgToEml('a string')), 'BAD_INPUT');
});

test('truncated file fails with a clear error', () => {
  const m = sample();
  for (const len of [512, 1024, 1536, Math.floor(m.length / 2)]) {
    const c = code(() => convertMsgToEml(m.slice(0, len)));
    assert.notEqual(c, undefined);
  }
});

function dirEntryOffset(u8, index) {
  const dv = new DataView(u8.buffer, u8.byteOffset);
  const sectorSize = 1 << dv.getUint16(30, true);
  const dirStart = dv.getInt32(0x30, true);
  return (dirStart + 1) * sectorSize + index * 128; // first directory sector only
}

test('directory tree loop is rejected quickly (no hang)', () => {
  const m = sample();
  const dv = new DataView(m.buffer);
  const child = dv.getInt32(dirEntryOffset(m, 0) + 0x4c, true);
  dv.setInt32(dirEntryOffset(m, child) + 0x44, child, true); // left sibling = itself
  const t0 = Date.now();
  assert.equal(code(() => convertMsgToEml(m)), 'CORRUPT_CFB');
  assert.ok(Date.now() - t0 < 2000);
});

test('FAT chain loop is rejected quickly (no hang)', () => {
  const m = sample();
  const dv = new DataView(m.buffer);
  const sectorSize = 1 << dv.getUint16(30, true);
  const fat0 = dv.getInt32(0x4c, true);
  const dirStart = dv.getInt32(0x30, true);
  dv.setInt32((fat0 + 1) * sectorSize + dirStart * 4, dirStart, true); // directory sector points to itself
  assert.equal(code(() => convertMsgToEml(m)), 'CORRUPT_CFB');
});

test('huge declared stream size is rejected before allocation', () => {
  const m = sample();
  const dv = new DataView(m.buffer);
  for (let i = 1; i < 10; i++) {
    const off = dirEntryOffset(m, i);
    if (m[off + 0x42] === 2) { dv.setInt32(off + 0x78, 0x7ff00000, true); break; }
  }
  assert.equal(code(() => convertMsgToEml(m)), 'CORRUPT_CFB');
});

test('fuzz: 400 mutated files each finish (ok or MsgError) inside a time limit', async () => {
  const src = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { convertMsgToEml, MsgError } = await import(workerData.index);
      const base = workerData.base;
      let seed = 12345;
      const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
      const results = { ok: 0, err: {}, other: [] , slowest: 0 };
      for (let k = 0; k < 400; k++) {
        const m = base.slice();
        const flips = 1 + rnd(8);
        for (let f = 0; f < flips; f++) m[rnd(m.length)] = rnd(256);
        if (k % 10 === 0) { const v = new DataView(m.buffer); v.setInt32(rnd(m.length - 4) & ~3, rnd(2) ? -2 : rnd(64), true); }
        const t0 = Date.now();
        try { convertMsgToEml(m); results.ok++; }
        catch (e) { if (e instanceof MsgError) results.err[e.code] = (results.err[e.code] || 0) + 1; else results.other.push(String(e)); }
        results.slowest = Math.max(results.slowest, Date.now() - t0);
      }
      parentPort.postMessage(results);
    })();`;
  const w = new Worker(src, { eval: true, workerData: { base: sample(), index: new URL('../src/index.js', import.meta.url).href } });
  const res = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { w.terminate(); reject(new Error('fuzz run did not finish in 120 s (hang)')); }, 120000);
    w.on('message', (m) => { clearTimeout(timer); resolve(m); });
    w.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
  await w.terminate();
  assert.deepEqual(res.other, [], 'every failure is a MsgError');
  assert.ok(res.slowest < 5000, `slowest case ${res.slowest} ms`);
});
