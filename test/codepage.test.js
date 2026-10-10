import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseAnsiCodepage, lcidToCodepage, decodeBytes, resolveLabel } from '../src/codepage.js';
import { decode as shimDecode, encode as shimEncode } from '../src/iconv-shim.js';

test('ANSI code page: message code page first', () => {
  assert.deepEqual(chooseAnsiCodepage({ messageCodepage: 1251, messageLocaleId: 1041, internetCodepage: 65001 }), { codepage: 1251, source: 'PidTagMessageCodepage' });
});
test('ANSI code page: locale before internet code page', () => {
  // Japanese locale with iso-2022-jp internet code page: ANSI strings are cp932
  assert.equal(chooseAnsiCodepage({ messageLocaleId: 1041, internetCodepage: 50220 }).codepage, 932);
  // German locale with utf-8 internet code page: ANSI strings are cp1252
  assert.equal(chooseAnsiCodepage({ messageLocaleId: 1031, internetCodepage: 65001 }).codepage, 1252);
});
test('ANSI code page: internet code page mapped to its ANSI page, then default', () => {
  assert.equal(chooseAnsiCodepage({ internetCodepage: 50220 }).codepage, 932);
  assert.equal(chooseAnsiCodepage({ internetCodepage: 1251 }).codepage, 1251);
  assert.deepEqual(chooseAnsiCodepage({}), { codepage: 1252, source: 'default' });
});
test('locale table', () => {
  assert.equal(lcidToCodepage(1049), 1251);
  assert.equal(lcidToCodepage(1028), 950);
  assert.equal(lcidToCodepage(2052), 936);
  assert.equal(lcidToCodepage(1042), 949);
  assert.equal(lcidToCodepage(1037), 1255);
  assert.equal(lcidToCodepage(1025), 1256);
  assert.equal(lcidToCodepage(1054), 874);
  assert.equal(lcidToCodepage(1045), 1250);
  assert.equal(lcidToCodepage(1032), 1253);
  assert.equal(lcidToCodepage(1055), 1254);
  assert.equal(lcidToCodepage(1062), 1257);
  assert.equal(lcidToCodepage(1066), 1258);
  assert.equal(lcidToCodepage(3098), 1251); // Serbian Cyrillic
  assert.equal(lcidToCodepage(2074), 1250); // Serbian Latin
  assert.equal(lcidToCodepage(1033), 1252);
  assert.equal(lcidToCodepage(undefined), null);
});
test('decoding in Windows code pages via the Encoding API', () => {
  assert.equal(decodeBytes(Uint8Array.from([0x93, 0xfa, 0x96, 0x7b]), 932), '日本');
  assert.equal(decodeBytes(Uint8Array.from([0xcf, 0xf0, 0xe8]), 'cp1251'), 'При');
  assert.equal(decodeBytes(Uint8Array.from([0xae, 0xe6, 0xa6, 0xa1]), 950), '格式');
  assert.equal(decodeBytes(Uint8Array.from([0x80]), 1252), '€');
  assert.equal(resolveLabel('windows1251'), 'windows-1251');
  assert.equal(resolveLabel('no-such-charset'), 'windows-1252');
});
test('iconv shim used by the browser bundle', () => {
  assert.equal(shimDecode(Uint8Array.from([0xb0, 0xa1]), 'cp949'), '가');
  assert.deepEqual([...shimEncode('A', 'utf16le')], [0x41, 0]);
  assert.throws(() => shimEncode('x', 'cp932'));
});

test('cp1252 0x80-0x9F decodes to the Windows characters, never to C1 controls', () => {
  // Outlook AutoCorrect output: curly quotes, en/em dashes, euro, ellipsis.
  const bytes = Uint8Array.from([0x91, 0x92, 0x93, 0x94, 0x96, 0x97, 0x80, 0x85]);
  const out = decodeBytes(bytes, 1252);
  assert.equal(out, '‘’“”–—€…');
  for (const ch of out) assert.ok(ch.charCodeAt(0) > 0x9f, `C1 control leaked: U+${ch.charCodeAt(0).toString(16)}`);
});
