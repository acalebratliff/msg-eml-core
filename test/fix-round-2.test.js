// Regression tests for the re-review of 76093c2: M6 (PidTagHtml stored as a
// string type was dropped) and minor 1 (length-changing lowercase in
// htmlCharsetToUtf8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMsg, T } from './helpers/build-msg.js';
import { convertMsgToEml } from '../src/index.js';
import { htmlCharsetToUtf8 } from '../src/convert.js';

const td = new TextDecoder('latin1');
const utf8d = new TextDecoder();
const base = [[T.MESSAGE_CLASS, 'IPM.Note'], [T.SUBMIT_TIME, new Date('2024-05-06T07:08:09Z')]];
const HTML_A = 0x1013001e;
const HTML_W = 0x1013001f;

// Decoded text of the text/html part, or null when there is none.
function htmlPart(eml) {
  const t = td.decode(eml);
  const m = /Content-Type: text\/html[^\r\n]*(?:\r\n[ \t][^\r\n]*)*\r\n((?:[^\r\n]+\r\n)*)\r\n([\s\S]*?)\r\n--/i.exec(t);
  if (!m) return null;
  const cte = (/Content-Transfer-Encoding: *(\S+)/i.exec(m[1]) || [])[1] || '7bit';
  let bytes;
  if (/base64/i.test(cte)) bytes = Uint8Array.from(atob(m[2].replace(/\s+/g, '')), (c) => c.charCodeAt(0));
  else if (/quoted-printable/i.test(cte)) {
    const s = m[2].replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})|[\s\S]/g, (x, h) => String.fromCharCode(h ? parseInt(h, 16) : x.charCodeAt(0)));
    bytes = Uint8Array.from(s, (c) => c.charCodeAt(0));
  } else bytes = Uint8Array.from(m[2], (c) => c.charCodeAt(0));
  return utf8d.decode(bytes);
}

// "HTML автоматически" in cp1251, as in poi__ASCII_CP1251_LCID1049.msg
const cp1251 = (s) => Uint8Array.from([...s].map((c) => {
  const k = c.charCodeAt(0);
  if (k < 0x80) return k;
  if (k >= 0x410 && k <= 0x44f) return k - 0x410 + 0xc0;
  throw new Error('test helper: ' + c);
}));

test('M6: PidTagHtml stored as PT_STRING8 is decoded with the message code page and kept', () => {
  const html = '<html><meta charset="windows-1251"><body>HTML автоматически</body></html>';
  const { eml, report } = convertMsgToEml(buildMsg({ props: [...base,
    [T.MESSAGE_CODEPAGE, 1251],
    [T.BODY, 'Body автоматически Body'],
    [HTML_A, cp1251(html)],
  ] }));
  const got = htmlPart(eml);
  assert.ok(got, 'eml has an HTML part');
  assert.match(got, /HTML автоматически/);
  assert.match(got, /charset="utf-8"/);
  assert.equal(report.body.htmlSource, 'PidTagHtml');
  assert.equal(report.body.htmlProperty, true);
});

test('M6: PidTagHtml stored as PT_UNICODE is kept', () => {
  const { eml, report } = convertMsgToEml(buildMsg({ props: [...base,
    [T.BODY, 'plain'],
    [HTML_W, '<html><body>Ünïcode HTML ✓</body></html>'],
  ] }));
  assert.match(htmlPart(eml) || '', /Ünïcode HTML ✓/);
  assert.equal(report.body.htmlProperty, true);
});

test('M6: PidTagHtml stored as PT_BINARY is still kept; plain messages report htmlProperty false', () => {
  const r1 = convertMsgToEml(buildMsg({ props: [...base,
    [T.BODY, 'plain'], [T.HTML, new TextEncoder().encode('<html><body>binary html</body></html>')], [T.INTERNET_CODEPAGE, 65001],
  ] }));
  assert.match(htmlPart(r1.eml) || '', /binary html/);
  assert.equal(r1.report.body.htmlProperty, true);
  const r2 = convertMsgToEml(buildMsg({ props: [...base, [T.BODY, 'plain only']] }));
  assert.equal(htmlPart(r2.eml), null);
  assert.equal(r2.report.body.htmlProperty, false);
});

test('M6: an empty PidTagHtml is reported (htmlProperty true) with a warning, so a checker cannot pass it as plain text', () => {
  const { report } = convertMsgToEml(buildMsg({ props: [...base, [T.BODY, 'plain'], [HTML_A, new Uint8Array(0)]] }));
  assert.equal(report.body.htmlProperty, true);
  assert.ok(report.warnings.some((w) => /^The HTML version of the body could not be read\./.test(w)), report.warnings.join('\n'));
});

test('minor 1: characters whose lowercase changes length do not shift the charset rewrite', () => {
  for (const ch of ['İ', 'ẞ', 'Ω', 'K']) {
    const pre = ch.repeat(40);
    const out = htmlCharsetToUtf8(`${pre}<meta charset="windows-1252"><p>charset=keep</p>`);
    assert.equal(out, `${pre}<meta charset="utf-8"><p>charset=keep</p>`, `prefix ${ch}`);
  }
  // A large shift must not reach a later "charset=" in the text.
  const pre = 'İ'.repeat(5000);
  assert.equal(htmlCharsetToUtf8(`${pre}<meta x><b>charset=keep</b>`), `${pre}<meta x><b>charset=keep</b>`);
  assert.equal(htmlCharsetToUtf8(`İİ<META CHARSET=ISO-8859-9>`), 'İİ<META CHARSET=utf-8>');
});
