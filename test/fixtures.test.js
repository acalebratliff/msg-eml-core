import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { convertMsgToEml } from '../src/index.js';
import { decodeWords } from '../src/headers.js';

const load = (name) => new Uint8Array(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const latin1 = new TextDecoder('latin1');
const subjectOf = (eml) => {
  const t = latin1.decode(eml);
  const head = t.slice(0, t.indexOf('\r\n\r\n')).replace(/\r\n[ \t]/g, ' ');
  return decodeWords(/^Subject: (.*)$/m.exec(head)[1]);
};
const qpDecode = (s) => new TextDecoder().decode(Uint8Array.from(
  s.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})|[\s\S]/g, (m, h) => String.fromCharCode(h ? parseInt(h, 16) : m.charCodeAt(0))),
  (c) => c.charCodeAt(0)));
const utf16 = (s) => Buffer.from(s, 'utf16le');

test('Hello +CJK.msg (msgreader): Unicode-only, so the ANSI code page is ignored', () => {
  const msg = load('Hello +CJK.msg');
  // No ANSI string streams (type 001E) anywhere in the file.
  assert.equal(Buffer.from(msg).includes(utf16('__substg1.0_0037001E')), false);
  assert.equal(Buffer.from(msg).includes(utf16('001E')), false);
  assert.equal(Buffer.from(msg).includes(utf16('__substg1.0_0037001F')), true);

  const outputs = [{}, { unresolvedAddress: 'name-only' }, { unresolvedAddress: 'invalid-domain' }, { utf8Headers: true }, { keepRtf: 'always' }]
    .map((o) => convertMsgToEml(msg, o));
  const subjects = outputs.map((r) => subjectOf(r.eml));
  assert.equal(subjects[0], 'Hello +CJK');
  for (const s of subjects) assert.equal(s, subjects[0]);
  // The reader never needed to re-parse with an ANSI code page.
  for (const r of outputs) assert.equal(r.report.codepage.applied, false);
  // Same text whichever address option is used (those options only change addresses).
  const body = (r) => latin1.decode(r.eml).split('\r\n\r\n').slice(1).join('\r\n\r\n');
  assert.equal(body(outputs[0]), body(outputs[1]));
  // The text itself is CJK, decoded from the UTF-16 strings.
  const text = qpDecode(/Content-Type: text\/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n([\s\S]*?)\r\n--/.exec(latin1.decode(outputs[0].eml))[1]);
  assert.match(text, /[\u3000-\u9fff\uff00-\uffef]/);
  assert.ok(!text.includes('\ufffd'));
});
