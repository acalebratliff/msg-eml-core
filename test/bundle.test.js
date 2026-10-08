// Checks the built browser bundle (npm run build first; skipped if absent):
// it runs in a bare JS context with only the Encoding API, makes no network
// calls, and gives the same bytes as the source modules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import { buildMsg, T } from './helpers/build-msg.js';
import { convertMsgToEml } from '../src/index.js';

const path = new URL('../dist/msg-eml-core.js', import.meta.url);
const have = existsSync(path);

test('bundle runs without Node APIs and matches the source build', { skip: !have && 'dist not built' }, () => {
  const code = readFileSync(path, 'utf8');
  assert.ok(!/\brequire\(["']/.test(code), 'no require() of modules');
  assert.ok(!/["']node:/.test(code), 'no node: imports');
  assert.ok(!/\b(fetch|XMLHttpRequest|WebSocket|sendBeacon|importScripts)\b/.test(code), 'no network APIs');
  const m = /export\s*\{([^}]*)\};?\s*$/.exec(code.replace(/\/\*[\s\S]*?\*\/\s*$/, ''));
  assert.ok(m, 'ESM export list found');
  const exportsObj = m[1].split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const [local, as] = s.split(/\s+as\s+/);
    return `${as || local}: ${local}`;
  }).join(', ');
  const script = code.slice(0, m.index) + `\nglobalThis.__mec = { ${exportsObj} };`;
  // Bare context: JS built-ins plus the Encoding API only.
  const ctx = vm.createContext({ TextDecoder, TextEncoder, console: { debug() {}, log() {} } });
  vm.runInContext(script, ctx);
  const msg = buildMsg({ props: [[T.MESSAGE_CLASS, 'IPM.Note'], [T.SUBJECT_A, Uint8Array.from([0xcf, 0xf0, 0xe8])], [T.LOCALE_ID, 1049],
    [T.BODY, 'body'], [T.SUBMIT_TIME, new Date('2024-01-02T03:04:05Z')]] });
  const CtxU8 = vm.runInContext('Uint8Array', ctx);
  const inCtx = new CtxU8(msg.length);
  inCtx.set(msg);
  const a = ctx.__mec.convertMsgToEml(inCtx).eml;
  const b = convertMsgToEml(msg).eml;
  assert.equal(Buffer.from(a).toString('latin1'), Buffer.from(b).toString('latin1'));
  assert.match(Buffer.from(a).toString('latin1'), /Subject: =\?UTF-8\?B\?0J/);
});
