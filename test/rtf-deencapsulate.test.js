import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deEncapsulate, detectEncapsulation, rtfToText, tokenize } from '../src/rtf/rtf.js';

const b = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));

test('recognition: \\fromhtml1 within the first 10 tokens', () => {
  assert.equal(detectEncapsulation(b('{\\rtf1\\ansi\\fromhtml1 \\deff0 x}')), 'html');
  assert.equal(detectEncapsulation(b('{\\rtf1\\ansi\\fromtext \\deff0 x}')), 'text');
  assert.equal(detectEncapsulation(b('{\\rtf1\\ansi\\deff0 hello}')), null);
  // text before the marker ends inspection (2.2.3.1)
  assert.equal(detectEncapsulation(b('{\\rtf1 x\\fromhtml1}')), null);
  // beyond 10 tokens it is not recognised
  assert.equal(detectEncapsulation(b('{\\rtf1\\a\\b\\c\\d\\e\\f\\g\\h\\i\\fromhtml1}')), null);
  assert.equal(detectEncapsulation(b('not rtf')), null);
});

const HTML_RTF = [
  '{\\rtf1\\ansi\\ansicpg1252\\fromhtml1 \\deff0{\\fonttbl{\\f0\\fswiss Arial;}{\\f1\\fmodern\\fcharset128 MS Gothic;}}',
  '{\\colortbl\\red0\\green0\\blue0;}',
  '{\\*\\htmltag19 <html>}{\\*\\htmltag34 <head>}{\\*\\htmltag161 <meta charset="x">}{\\*\\htmltag41 </head>}',
  '{\\*\\htmltag50 <body>}\\htmlrtf {\\pard\\plain\\f0\\fs20 \\htmlrtf0 ',
  '{\\*\\htmltag64 <p>}Hello \\{world\\} caf\\\'e9 \\u8364?euro',
  '\\htmlrtf \\par \\htmlrtf0 {\\*\\htmltag72 </p>}\\par',
  '{\\*\\mhtmltag84 <img src="http://rewritten">}{\\*\\htmltag84 <img src="cid:image001.png@01D0">}',
  '{\\*\\unknowndest should vanish}\\tab end',
  '\\htmlrtf }\\htmlrtf0 {\\*\\htmltag58 </body>}{\\*\\htmltag27 </html>}}',
].join('\r\n');

test('HTML de-encapsulation (MS-OXRTFEX 2.2.3.2)', () => {
  const r = deEncapsulate(b(HTML_RTF));
  assert.equal(r.type, 'html');
  const h = r.content;
  assert.ok(h.startsWith('<html><head><meta charset="x"></head><body>'), h);
  assert.ok(h.includes('<p>Hello {world} café €euro'), h); // 荤 skips one fallback char
  assert.ok(h.includes('</p>\r\n'), 'par outside htmlrtf becomes CRLF');
  assert.ok(!h.includes('rewritten'), 'mhtmltag skipped');
  assert.ok(h.includes('<img src="cid:image001.png@01D0">'));
  assert.ok(!h.includes('should vanish'), 'ignorable destinations skipped');
  assert.ok(h.includes('\tend'));
  assert.ok(h.endsWith('</body></html>'));
  assert.ok(!h.includes('Arial') && !h.includes('red0'), 'font and colour tables skipped');
});

test('htmlrtf state is scoped to groups', () => {
  const r = deEncapsulate(b('{\\rtf1\\fromhtml1 {\\htmlrtf hidden}shown{\\*\\htmltag0 <b>}}'));
  assert.equal(r.content, 'shown<b>');
});

test('code page from \\ansicpg for escapes inside htmltag', () => {
  // cp1251: \\'cf\\'f0\\'e8 = "При"
  const r = deEncapsulate(b("{\\rtf1\\ansi\\ansicpg1251\\fromhtml1 {\\*\\htmltag0 <p title=\"\\'cf\\'f0\\'e8\">}}"));
  assert.equal(r.content, '<p title="При">');
});

test('font charset selects the code page for text outside htmltag (DBCS pairs kept together)', () => {
  // Shift_JIS 0x93 0xfa 0x96 0x7b = "日本"
  const rtf = "{\\rtf1\\ansi\\ansicpg1252\\fromhtml1 {\\fonttbl{\\f1\\fcharset128 MS Gothic;}}{\\f1 \\'93\\'fa\\'96\\'7b}}";
  assert.equal(deEncapsulate(b(rtf)).content, '日本');
});

test('\\uc0 and negative \\u values, surrogate pairs', () => {
  const r = deEncapsulate(b('{\\rtf1\\fromhtml1 \\uc0\\u-10179\\u-8704 x}'));
  assert.equal(r.content, '\u{1F600}x'.replace('\u{1F600}', String.fromCharCode(0xd83d, 0xde00)));
});

test('plain text de-encapsulation (\\fromtext)', () => {
  const r = deEncapsulate(b('{\\rtf1\\ansi\\fromtext {\\fonttbl{\\f0 Courier;}}\\f0 line one\\par line two\\tab x}'));
  assert.deepEqual(r, { type: 'text', content: 'line one\r\nline two\tx' });
});

test('pure RTF is not de-encapsulated; rtfToText gives readable text', () => {
  const rtf = b('{\\rtf1\\ansi{\\fonttbl{\\f0 Times;}}{\\info{\\title T}}\\pard Hello {\\b bold}\\par {\\field{\\*\\fldinst HYPERLINK "x"}{\\fldrslt link}}\\par\\lquote q\\rquote}');
  assert.equal(deEncapsulate(rtf), null);
  assert.equal(rtfToText(rtf), 'Hello bold\nlink\n‘q’');
});

test('tokenizer: \\bin data is skipped and never read past the end', () => {
  const toks = [];
  tokenize(b('{\\bin999 abc}'), (t) => toks.push(t));
  assert.deepEqual(toks.map((t) => t.t), ['{', 'bin']);
});

test('unbalanced groups and garbage do not throw', () => {
  assert.doesNotThrow(() => deEncapsulate(b('{\\rtf1\\fromhtml1 }}}}{{{{\\\'zz\\')));
  assert.doesNotThrow(() => rtfToText(b('{\\rtf1 {{{{{{{')));
});
