import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base64, base64Body, quotedPrintable, encodeWords, unstructured, phrase, param, foldHeader } from '../src/mime/encode.js';
import { decodeWords } from '../src/headers.js';

test('base64', () => {
  assert.equal(base64(new TextEncoder().encode('Man')), 'TWFu');
  assert.equal(base64(new TextEncoder().encode('Ma')), 'TWE=');
  assert.equal(base64(new TextEncoder().encode('M')), 'TQ==');
  const body = base64Body(new Uint8Array(200));
  assert.ok(body.split('\r\n').every((l) => l.length <= 76));
});

test('quoted-printable: CRLF line ends, soft breaks, trailing space, dots', () => {
  const qp = quotedPrintable('é' + 'x'.repeat(100) + ' \n.dot\r\nend');
  const lines = qp.split('\r\n');
  assert.ok(lines.every((l) => l.length <= 76), qp);
  assert.ok(qp.startsWith('=C3=A9'));
  assert.ok(qp.includes('=20\r\n'), 'trailing space encoded');
  assert.ok(qp.includes('\r\n=2Edot'));
  assert.ok(qp.endsWith('end\r\n'));
});

test('encoded-words stay <= 75 chars, never split a character, round-trip', () => {
  const s = '日本語のテキスト😀 '.repeat(8);
  const w = encodeWords(s);
  for (const word of w.split(' ')) assert.ok(word.length <= 75, word);
  assert.equal(decodeWords(w), s);
  assert.equal(unstructured('plain ascii'), 'plain ascii');
  assert.equal(decodeWords(unstructured('a =?b?= c')), 'a =?b?= c');
});

test('display-name phrase', () => {
  assert.equal(phrase('Alice Smith'), 'Alice Smith');
  assert.equal(phrase('Allison, Timothy B.'), '"Allison, Timothy B."');
  assert.equal(phrase('say "hi"'), '"say \\"hi\\""');
  assert.match(phrase('Zoë'), /^=\?UTF-8\?B\?/);
});

test('RFC 2231 parameters with continuations split on character boundaries', () => {
  assert.equal(param('filename', 'a.pdf'), 'filename="a.pdf"');
  const p = param('filename', 'Mr. コム ドット イグザンプル 殿.vcf');
  assert.match(p, /^filename\*0\*=UTF-8''/);
  for (const piece of p.split(';\r\n ')) {
    const val = piece.replace(/^[^=]*=(UTF-8'')?/, '');
    assert.doesNotThrow(() => decodeURIComponent(val), piece);
  }
});

test('header folding keeps lines short and unfolds to the same value', () => {
  const v = Array.from({ length: 30 }, (_, i) => `person${i}@example.test`).join(', ');
  const f = foldHeader('To', v);
  assert.ok(f.split('\r\n').every((l) => l.length <= 78));
  assert.equal(f.replace(/\r\n /g, ' '), 'To: ' + v);
});
