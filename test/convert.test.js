import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMsg, T } from './helpers/build-msg.js';
import { convertMsgToEml } from '../src/index.js';
import { decodeWords } from '../src/headers.js';

const td = new TextDecoder('latin1');
const conv = (spec, opts) => {
  const { eml, report } = convertMsgToEml(buildMsg(spec), opts);
  return { text: td.decode(eml), report };
};
const headerBlock = (t) => t.slice(0, t.indexOf('\r\n\r\n')).replace(/\r\n[ \t]/g, ' ');
const header = (t, name) => {
  const m = new RegExp(`^${name}: (.*)$`, 'mi').exec(headerBlock(t));
  return m ? m[1] : null;
};
const qpDecode = (s) => new TextDecoder().decode(Uint8Array.from(
  s.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})|[\s\S]/g, (m, h) => String.fromCharCode(h ? parseInt(h, 16) : m.charCodeAt(0))),
  (c) => c.charCodeAt(0)));
const uncompressedRtf = (s) => {
  const body = Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
  const u8 = new Uint8Array(16 + body.length);
  const dv = new DataView(u8.buffer);
  dv.setUint32(0, body.length + 12, true);
  dv.setUint32(4, body.length, true);
  dv.setUint32(8, 0x414c454d, true);
  u8.set(body, 16);
  return u8;
};
const base = [[T.MESSAGE_CLASS, 'IPM.Note'], [T.SUBMIT_TIME, new Date('2024-05-06T07:08:09Z')]];

test('gap 1: HTML only inside RTF becomes a text/html part; cid images go into multipart/related', () => {
  const rtf = '{\\rtf1\\ansi\\ansicpg1252\\fromhtml1 \\deff0{\\fonttbl{\\f0 Arial;}}{\\*\\htmltag19 <html><body>}Hi {\\*\\htmltag0 <img src="cid:img1@x">}{\\*\\htmltag0 </body></html>}}';
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
  const { text, report } = conv({
    props: [...base, [T.SUBJECT, 'rtf'], [T.BODY, 'Hi'], [T.RTF_COMPRESSED, uncompressedRtf(rtf)]],
    attachments: [{ props: [[T.ATTACH_METHOD, 1], [T.ATTACH_LONG_FILENAME, 'image.png'], [T.ATTACH_MIME, 'image/png'], [T.ATTACH_CONTENT_ID, 'img1@x'], [T.ATTACH_DATA, png]] }],
  });
  assert.equal(report.body.htmlSource, 'RTF (de-encapsulated)');
  assert.match(text, /Content-Type: multipart\/alternative/);
  assert.match(text, /Content-Type: multipart\/related; type="text\/html"/);
  assert.match(text, /Content-Type: text\/html; charset=utf-8/);
  const m = /Content-Type: text\/html; charset=utf-8\r\nContent-Transfer-Encoding: (\S+)\r\n\r\n([\s\S]*?)\r\n--/.exec(text);
  const html = m[1] === 'quoted-printable' ? qpDecode(m[2]) : m[2];
  assert.equal(html, '<html><body>Hi <img src="cid:img1@x"></body></html>');
  assert.match(text, /Content-ID: <img1@x>/);
  assert.match(text, /Content-Disposition: inline; filename="image.png"/);
});

test('gap 1: real RTF without HTML gives plain text and keeps the RTF as an attachment', () => {
  const rtf = '{\\rtf1\\ansi{\\fonttbl{\\f0 Times;}}\\f0 Formatted {\\b body}\\par second}';
  const { text, report } = conv({ props: [...base, [T.SUBJECT, 'r'], [T.RTF_COMPRESSED, uncompressedRtf(rtf)]] });
  assert.equal(report.body.textSource, 'RTF (converted to plain text)');
  assert.ok(text.includes('Formatted body\r\nsecond'));
  assert.match(text, /Content-Type: application\/rtf; name="body.rtf"/);
  assert.match(text, /Content-Description: Original RTF body/);
  const never = conv({ props: [...base, [T.SUBJECT, 'r'], [T.RTF_COMPRESSED, uncompressedRtf(rtf)]] }, { keepRtf: 'never' });
  assert.ok(!never.text.includes('body.rtf'));
  const withHtml = conv({ props: [...base, [T.SUBJECT, 'r'], [T.HTML, new TextEncoder().encode('<p>x</p>')], [T.RTF_COMPRESSED, uncompressedRtf(rtf)]] });
  assert.ok(!withHtml.text.includes('body.rtf'), 'HTML body present: RTF not duplicated');
});

test('gap 2: ANSI strings decoded with the message code page / locale', () => {
  const cyr = Uint8Array.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]); // "Привет" in cp1251
  const { text, report } = conv({ props: [...base, [T.SUBJECT_A, cyr], [T.BODY_A, cyr], [T.LOCALE_ID, 1049]] });
  assert.equal(report.codepage.codepage, 1251);
  assert.equal(decodeWords(header(text, 'Subject')), 'Привет');
  const sjis = Uint8Array.from([0x93, 0xfa, 0x96, 0x7b]);
  const j = conv({ props: [...base, [T.SUBJECT_A, sjis], [T.MESSAGE_CODEPAGE, 932], [T.INTERNET_CODEPAGE, 50220]] });
  assert.equal(decodeWords(header(j.text, 'Subject')), '日本');
});

test('gap 3: no X.500 DN ever reaches an address header; fallbacks in order', () => {
  const dn = '/O=EXAMPLE/OU=EXCHANGE ADMINISTRATIVE GROUP/CN=RECIPIENTS/CN=JDOE';
  const { text, report } = conv({
    props: [...base, [T.SUBJECT, 's'], [T.SENDER_NAME, 'Jane Doe'], [T.SENDER_EMAIL, dn], [T.SENDER_ADDRTYPE, 'EX']],
    recipients: [
      { props: [[T.DISPLAY_NAME, 'Bob'], [T.EMAIL_ADDRESS, '/O=EXAMPLE/CN=BOB'], [T.ADDRTYPE, 'EX'], [T.SMTP_ADDRESS, 'bob@example.test'], [T.RECIPIENT_TYPE, 1]] },
      { props: [[T.DISPLAY_NAME, 'Carol, C.'], [T.EMAIL_ADDRESS, '/O=EXAMPLE/CN=CAROL'], [T.ADDRTYPE, 'EX'], [T.RECIPIENT_TYPE, 2]] },
    ],
  }, { unresolvedAddress: 'name-only' });
  assert.ok(!/\/O=/i.test(headerBlock(text)), headerBlock(text));
  assert.equal(header(text, 'From'), 'Jane Doe:;');
  assert.equal(header(text, 'To'), 'Bob <bob@example.test>');
  assert.equal(header(text, 'Cc'), '"Carol, C.":;');
  assert.equal(report.addresses.from.source, 'name-only');
  const inv = conv({ props: [...base, [T.SUBJECT, 's'], [T.SENDER_NAME, 'Jane Doe'], [T.SENDER_EMAIL, dn], [T.SENDER_ADDRTYPE, 'EX']] });
  // A2 is the default (Aaron, 2026-10-07): per-person placeholder (slug of the name + hash of the DN) in .invalid
  assert.match(header(inv.text, 'From'), /^Jane Doe <jane\.doe\.[0-9a-f]{8}@unresolved\.invalid>$/);
  // transport headers recover the sender
  const h = conv({ props: [...base, [T.SUBJECT, 's'], [T.SENDER_NAME, 'Jane Doe'], [T.SENDER_EMAIL, dn], [T.SENDER_ADDRTYPE, 'EX'],
    [T.TRANSPORT_HEADERS, 'From: Jane Doe <jane@example.test>\r\nDate: Mon, 6 May 2024 09:08:09 +0200\r\nReceived: by mx\r\n\r\n']] });
  assert.equal(header(h.text, 'From'), 'Jane Doe <jane@example.test>');
  assert.equal(header(h.text, 'Date'), 'Mon, 6 May 2024 09:08:09 +0200', 'original Date with its offset');
  assert.equal(header(h.text, 'Received'), 'by mx');
  // sent on behalf of
  const b = conv({ props: [...base, [T.SUBJECT, 's'], [T.SENDER_NAME, 'Assistant'], [T.SENDER_SMTP, 'asst@example.test'],
    [T.SENT_REP_NAME, 'Boss'], [T.SENT_REP_SMTP, 'boss@example.test']] });
  assert.equal(header(b.text, 'From'), 'Boss <boss@example.test>');
  assert.equal(header(b.text, 'Sender'), 'Assistant <asst@example.test>');
});

test('gap 4: embedded messages become message/rfc822, recursively', () => {
  const leaf = { props: [[T.MESSAGE_CLASS, 'IPM.Note'], [T.SUBJECT, 'Level 3'], [T.BODY, 'deepest']] };
  const mid = { props: [[T.MESSAGE_CLASS, 'IPM.Note'], [T.SUBJECT, 'Level 2'], [T.BODY, 'middle']],
    attachments: [{ props: [[T.ATTACH_METHOD, 5], [T.ATTACH_DISPLAY_NAME, 'leaf']], embedded: leaf }] };
  const { text, report } = conv({ props: [...base, [T.SUBJECT, 'Level 1'], [T.BODY, 'top']],
    attachments: [{ props: [[T.ATTACH_METHOD, 5], [T.ATTACH_DISPLAY_NAME, 'mid']], embedded: mid }] });
  assert.equal((text.match(/Content-Type: message\/rfc822/g) || []).length, 2);
  assert.ok(text.includes('Subject: Level 3'));
  assert.ok(text.includes('deepest'));
  assert.equal(report.attachments[0].embedded.attachments[0].name, 'leaf.eml');
});

test('gap 6: Date from submit time, Message-ID, In-Reply-To, References kept', () => {
  const { text } = conv({ props: [...base, [T.SUBJECT, 's'], [T.INTERNET_MESSAGE_ID, '<id1@x.test>'], [T.IN_REPLY_TO, '<id0@x.test>'],
    [T.REFERENCES, '<a@x.test> <id0@x.test>'], [T.IMPORTANCE, 2]] });
  assert.equal(header(text, 'Date'), 'Mon, 6 May 2024 07:08:09 +0000');
  assert.equal(header(text, 'Message-ID'), '<id1@x.test>');
  assert.equal(header(text, 'In-Reply-To'), '<id0@x.test>');
  assert.equal(header(text, 'References'), '<a@x.test> <id0@x.test>');
  assert.equal(header(text, 'Importance'), 'high');
  const noDate = conv({ props: [[T.MESSAGE_CLASS, 'IPM.Note'], [T.SUBJECT, 'n']] });
  assert.equal(header(noDate.text, 'Date'), null);
  assert.match(noDate.report.warnings.join(), /no date/);
});

test('S/MIME signed: original entity passed through byte for byte', () => {
  const entity = 'Content-Type: multipart/signed; protocol="application/pkcs7-signature"; micalg=sha-256; boundary="b1"\r\nMIME-Version: 1.0\r\n\r\n--b1\r\nContent-Type: text/plain\r\n\r\nsigned text \xe9\r\n--b1\r\nContent-Type: application/pkcs7-signature\r\n\r\nAAAA\r\n--b1--\r\n';
  const bytes = Uint8Array.from([...entity].map((c) => c.charCodeAt(0)));
  const { text } = conv({ props: [[T.MESSAGE_CLASS, 'IPM.Note.SMIME.MultipartSigned'], [T.SUBJECT, 'signed']],
    attachments: [{ props: [[T.ATTACH_METHOD, 1], [T.ATTACH_LONG_FILENAME, 'smime.p7m'], [T.ATTACH_MIME, 'multipart/signed'], [T.ATTACH_DATA, bytes]] }] });
  assert.equal((text.match(/^MIME-Version:/gm) || []).length, 1);
  assert.ok(text.endsWith(entity.slice(entity.indexOf('\r\n\r\n'))));
  assert.match(headerBlock(text), /Content-Type: multipart\/signed/);
});

test('non-ASCII attachment names use RFC 2231; output is 7-bit with CRLF only', () => {
  const { text } = conv({ props: [...base, [T.SUBJECT, 'Grüße'], [T.BODY, 'Grüße\nzweite Zeile']],
    attachments: [{ props: [[T.ATTACH_METHOD, 1], [T.ATTACH_LONG_FILENAME, 'Prüfbericht 2024.pdf'], [T.ATTACH_DATA, new Uint8Array([1, 2, 3])]] }] });
  assert.match(text, /filename\*=UTF-8''Pr%C3%BCfbericht%202024\.pdf/);
  assert.match(text, /Content-Type: application\/pdf/);
  assert.ok(!/[^\x00-\x7f]/.test(text), 'all 7-bit');
  assert.ok(!/(?<!\r)\n/.test(text), 'no bare LF');
  assert.ok(text.split('\r\n').every((l) => l.length <= 998));
  assert.equal(qpDecode(text.split('quoted-printable\r\n\r\n')[1].split('\r\n--')[0]), 'Grüße\r\nzweite Zeile');
});

test('attachments stored by reference are reported, not invented', () => {
  const { text, report } = conv({ props: [...base, [T.SUBJECT, 's'], [T.BODY, 'b']],
    attachments: [{ props: [[T.ATTACH_METHOD, 2], [T.ATTACH_LONG_FILENAME, 'link.doc']] }] });
  assert.ok(!text.includes('link.doc'));
  assert.match(report.warnings.join(), /by reference/);
});

test('the unresolved-sender warning names the From form actually written', () => {
  const dn = '/O=EXAMPLE/CN=JDOE';
  const props = [...base, [T.SUBJECT, 's'], [T.SENDER_NAME, 'Jane Doe'], [T.SENDER_EMAIL, dn], [T.SENDER_ADDRTYPE, 'EX']];
  const a = conv({ props });
  assert.ok(a.report.warnings.some(w => w.includes('placeholder .invalid address')), a.report.warnings.join('\n'));
  const b = conv({ props }, { unresolvedAddress: 'name-only' });
  assert.ok(b.report.warnings.some(w => w.includes('the name only')), b.report.warnings.join('\n'));
});
