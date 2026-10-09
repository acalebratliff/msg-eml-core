// Regression tests for the review (B1, B2, M1-M5, minors) and QA defects
// of the first fix round. Each test names the finding it covers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMsg, T } from './helpers/build-msg.js';
import { convertMsgToEml } from '../src/index.js';
import { decodeWords, parseAddressList } from '../src/headers.js';
import { foldHeader, HeaderInjectionError, unstructured } from '../src/mime/encode.js';
import { htmlCharsetToUtf8, smimeType, headerAddrSpec, unresolvedPlaceholder } from '../src/convert.js';
import { buildCalendar, makeZone } from '../src/ical.js';
import { decodeBytes } from '../src/codepage.js';
import { rtfToText, deEncapsulate } from '../src/rtf/rtf.js';

const td = new TextDecoder('latin1');
const utf8d = new TextDecoder();
const conv = (spec, opts) => {
  const { eml, report } = convertMsgToEml(buildMsg(spec), opts);
  return { eml, text: td.decode(eml), report };
};
const headerBlock = (t) => t.slice(0, t.indexOf('\r\n\r\n')).replace(/\r\n[ \t]/g, ' ');
const header = (t, name) => {
  const m = new RegExp(`^${name}: (.*)$`, 'mi').exec(headerBlock(t));
  return m ? m[1] : null;
};
const qpDecode = (s) => utf8d.decode(Uint8Array.from(
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
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);

/** Structural invariants every output must keep, whatever the input. */
function assertWellFormed(eml, { ascii = true } = {}) {
  for (let i = 0; i < eml.length; i++) {
    const b = eml[i];
    assert.notEqual(b, 0, `NUL byte at ${i}`);
    if (b === 13) assert.equal(eml[i + 1], 10, `bare CR at ${i}`);
    if (b === 10) assert.equal(eml[i - 1], 13, `bare LF at ${i}`);
    if (ascii) assert.ok(b < 0x80, `8-bit byte at ${i}`);
  }
  const text = td.decode(eml);
  for (const line of text.split('\r\n')) assert.ok(line.length <= 998, `line of ${line.length} octets`);
  assert.ok(!/(^|\r\n)X-Injected:/i.test(text), 'injected header line present');
  assert.ok(!/(^|\r\n)INJECTED BODY/.test(text), 'injected body line present');
}

// ---------------------------------------------------------------- B1
const EVIL = 'a\r\nX-Injected: yes\r\n\r\nINJECTED BODY';
const EVIL_NUL = 'n\u0000u\u0007l\rX-Injected: 1\nINJECTED BODY';

test('B1: CR/LF in PidTagAttachContentId never reaches a header; Content-ID dropped with a warning', () => {
  const html = new TextEncoder().encode('<html><body><img src="cid:a"></body></html>');
  const { eml, text, report } = conv({
    props: [...base, [T.SUBJECT, 's'], [T.HTML, html]],
    attachments: [{ props: [[T.ATTACH_METHOD, 1], [T.ATTACH_LONG_FILENAME, 'i.png'], [T.ATTACH_MIME, 'image/png'], [T.ATTACH_CONTENT_ID, EVIL], [T.ATTACH_DATA, png]] }],
  });
  assertWellFormed(eml);
  assert.ok(!/Content-ID:/i.test(text));
  assert.ok(report.warnings.some((w) => /could not be placed in the text, so it is attached as an ordinary file\./.test(w)), report.warnings.join('\n'));
});

test('B1: CR/LF/NUL in every string that reaches a header is neutralised', () => {
  for (const evil of [EVIL, EVIL_NUL]) {
    const { eml, text } = conv({
      props: [...base, [T.SUBJECT, evil], [T.SENDER_NAME, evil], [T.SENDER_SMTP, 'ok@example.test'],
        [T.INTERNET_MESSAGE_ID, `<id@x>${evil}`], [T.IN_REPLY_TO, evil], [T.REFERENCES, `<r@x> ${evil}`],
        [T.MESSAGE_CLASS, `IPM.Note${evil}`],
        [T.TRANSPORT_HEADERS, `X-Stored: v\u0000\u0001${evil.replace(/[\r\n]/g, '')}\r\nReply-To: ${evil.replace(/[\r\n]/g, ' ')} <r@example.test>\r\n\r\n`]],
      recipients: [{ props: [[T.DISPLAY_NAME, evil], [T.SMTP_ADDRESS, 'to@example.test'], [T.RECIPIENT_TYPE, 1]] }],
      attachments: [
        { props: [[T.ATTACH_METHOD, 1], [T.ATTACH_LONG_FILENAME, evil], [T.ATTACH_MIME, `text/plain${evil}`], [T.ATTACH_CONTENT_ID, evil], [T.ATTACH_DATA, png]] },
        { props: [[T.ATTACH_METHOD, 1], [T.ATTACH_DISPLAY_NAME, evil], [T.ATTACH_DATA, png]] },
      ],
    });
    assertWellFormed(eml);
    assert.ok(header(text, 'Subject'));
    assert.match(header(text, 'From'), /<ok@example\.test>$/);
  }
});

test('B1: the serializer refuses a header value with CR, LF, NUL or 8-bit data (defence in depth)', () => {
  assert.throws(() => foldHeader('Content-ID', '<a\r\nX-Injected: yes>'), HeaderInjectionError);
  assert.throws(() => foldHeader('X-A', 'a\u0000b'), HeaderInjectionError);
  assert.throws(() => foldHeader('X-A', 'café'), HeaderInjectionError);
  assert.throws(() => foldHeader('X-A\r\nB', 'v'), HeaderInjectionError);
  assert.equal(foldHeader('X-A', 'café', { utf8: true }), 'X-A: café');
  assert.throws(() => foldHeader('X-A', 'a\nb', { utf8: true }), HeaderInjectionError);
  // the encoder's own forced folds are allowed
  assert.equal(foldHeader('X-A', 'a;\r\n b'), 'X-A: a;\r\n b');
});

// ---------------------------------------------------------------- B2
const timed = (fn) => { const t0 = performance.now(); const r = fn(); return { r, ms: performance.now() - t0 }; };

test('B2: a 300 KB+ From header of unclosed comments converts in well under 1 s', () => {
  const hdr = `From: Bob ${'('.repeat(320000)}\r\nTo: x@example.test\r\n\r\n`;
  const spec = { props: [...base, [T.SUBJECT, 's'], [T.SENDER_NAME, 'Bob'], [T.TRANSPORT_HEADERS, hdr]] };
  const msg = buildMsg(spec);
  assert.ok(msg.length > 300000);
  const { ms } = timed(() => convertMsgToEml(msg));
  assert.ok(ms < 1000, `took ${ms} ms`);
  assert.ok(timed(() => parseAddressList('<'.repeat(300000) + '('.repeat(300000))).ms < 300);
});

test('B2: 360 KB of "<meta " without ">" in the HTML body converts in well under 1 s', () => {
  const html = new TextEncoder().encode('<html><head>' + '<meta name=x '.repeat(28000));
  const msg = buildMsg({ props: [...base, [T.SUBJECT, 's'], [T.HTML, html]] });
  assert.ok(msg.length > 300000);
  const { ms } = timed(() => convertMsgToEml(msg));
  assert.ok(ms < 1000, `took ${ms} ms`);
  assert.ok(timed(() => htmlCharsetToUtf8('<meta '.repeat(80000))).ms < 300);
  assert.equal(htmlCharsetToUtf8('<META http-equiv="Content-Type" content="text/html; charset=iso-8859-1"><p>charset=x</p>'),
    '<META http-equiv="Content-Type" content="text/html; charset=utf-8"><p>charset=x</p>');
});

test('B2: hostile Date, Reply-To, References and RTF fields (300 KB+) stay fast', () => {
  const ws = ' '.repeat(100000);
  const hdr = `Date: 1 Jan 2020 00:00 +0000${ws}x\r\nReply-To: ${'<'.repeat(100000)}\r\nReferences: ${'<a@b'.repeat(30000)}\r\nX-Big: ${'=?x?'.repeat(30000)}\r\n\r\n`;
  const rtf = '{\\rtf1\\ansi\\fromhtml1 {\\*\\htmltag ' + '{'.repeat(150000) + '}';
  const msg = buildMsg({ props: [...base, [T.SUBJECT, 's'], [T.TRANSPORT_HEADERS, hdr], [T.RTF_COMPRESSED, uncompressedRtf(rtf)]] });
  assert.ok(msg.length > 300000);
  const { r, ms } = timed(() => convertMsgToEml(msg));
  assert.ok(ms < 1000, `took ${ms} ms`);
  assertWellFormed(r.eml);
});

// ---------------------------------------------------------------- M1
test('M1: a non-ASCII local part is never corrupted; it is written as unresolved with a warning', () => {
  const spec = { props: [...base, [T.SUBJECT, 's'], [T.SENDER_NAME, 'Zoe'], [T.SENDER_SMTP, '用户@例子.中国']] };
  const { eml, text, report } = conv(spec, { unresolvedAddress: 'name-only' });
  assertWellFormed(eml);
  assert.equal(header(text, 'From'), 'Zoe:;');
  assert.ok(report.warnings.some((w) => /has characters that a mail header cannot carry\. It is shown with a placeholder address\./.test(w)), report.warnings.join('\n'));
  const a2 = conv(spec, { unresolvedAddress: 'invalid-domain' });
  assert.match(header(a2.text, 'From'), /^Zoe <zoe\.[0-9a-f]{8}@unresolved\.invalid>$/);
});

test('M1: RFC 6532 option writes the address as UTF-8; an IDN domain alone becomes punycode', () => {
  const spec = { props: [...base, [T.SUBJECT, 's'], [T.SENDER_NAME, 'Zoe'], [T.SENDER_SMTP, '用户@例子.中国']] };
  const { eml } = convertMsgToEml(buildMsg(spec), { utf8Headers: true });
  assertWellFormed(eml, { ascii: false });
  assert.match(headerBlock(utf8d.decode(eml)), /^From: Zoe <用户@例子\.中国>$/m);
  const idn = conv({ props: [...base, [T.SUBJECT, 's'], [T.SENDER_NAME, 'Zoe'], [T.SENDER_SMTP, 'zoe@例子.中国']] });
  assert.equal(header(idn.text, 'From'), 'Zoe <zoe@xn--fsqu00a.xn--fiqs8s>');
  assert.equal(headerAddrSpec('a b@x.test'), null);
  assert.equal(headerAddrSpec('a..b@x.test'), '"a..b"@x.test');
});

test('M1 / minor 8: msg-ids are ASCII and need an @; garbage is dropped, not squeezed into an id', () => {
  const { text } = conv({ props: [...base, [T.SUBJECT, 's'], [T.INTERNET_MESSAGE_ID, '<ok@x.test>'],
    [T.IN_REPLY_TO, 'garbage\r\nX-Z: 1'], [T.REFERENCES, '<cé@d> <good@x.test> <nodomain>']] });
  assert.equal(header(text, 'Message-ID'), '<ok@x.test>');
  assert.equal(header(text, 'In-Reply-To'), null);
  assert.equal(header(text, 'References'), '<good@x.test>');
});

// ---------------------------------------------------------------- M2
test('M2: Reply-To and stored To/Cc are re-emitted mailbox by mailbox, address kept outside encoded-words', () => {
  const { eml, text } = conv({ props: [...base, [T.SUBJECT, 's'],
    [T.TRANSPORT_HEADERS, 'To: Jörg Müller <jm@example.com>, plain@example.com\r\nReply-To: Jörg Müller <jm@example.com>\r\nX-Note: Grüße from Jörg\r\n\r\n']] });
  assertWellFormed(eml);
  const rt = header(text, 'Reply-To');
  assert.match(rt, /^=\?UTF-8\?B\?[^?]+\?= <jm@example\.com>$/);
  assert.equal(decodeWords(rt), 'Jörg Müller <jm@example.com>');
  assert.match(header(text, 'To'), /^=\?UTF-8\?B\?[^?]+\?= <jm@example\.com>, plain@example\.com$/);
  const note = header(text, 'X-Note');
  assert.match(note, / from /, 'ASCII words stay literal');
  assert.equal(decodeWords(note), 'Grüße from Jörg');
  assert.equal(decodeWords(unstructured('a  é b')), 'a  é b');
  const rp = conv({ props: [...base, [T.SUBJECT, 's'], [T.TRANSPORT_HEADERS, 'Return-Path: bounce@example.com\r\n\r\n']] });
  assert.equal(header(rp.text, 'Return-Path'), '<bounce@example.com>');
});

// ---------------------------------------------------------------- M3
test('M3: prototype keys in file extensions and RTF control words give no junk', () => {
  const { text } = conv({ props: [...base, [T.SUBJECT, 's']], attachments: [
    { props: [[T.ATTACH_METHOD, 1], [T.ATTACH_LONG_FILENAME, 'a.constructor'], [T.ATTACH_DATA, png]] },
    { props: [[T.ATTACH_METHOD, 1], [T.ATTACH_LONG_FILENAME, 'b.__proto__'], [T.ATTACH_DATA, png]] },
    { props: [[T.ATTACH_METHOD, 1], [T.ATTACH_LONG_FILENAME, 'c.toString'], [T.ATTACH_DATA, png]] },
  ] });
  assert.ok(!/native code|\[object Object\]/.test(text));
  assert.equal((text.match(/Content-Type: application\/octet-stream/g) || []).length, 3);
  const rtf = new TextEncoder().encode('{\\rtf1\\ansi x \\toString y \\constructor z \\valueOf w\\hasOwnProperty}');
  assert.equal(rtfToText(rtf), 'x y z w');
  const html = new TextEncoder().encode('{\\rtf1\\ansi\\fromhtml1 {\\*\\htmltag <p>}\\toString\\hasOwnProperty{\\*\\htmltag </p>}}');
  assert.equal(deEncapsulate(html).content, '<p></p>');
});

// ---------------------------------------------------------------- M4
test('M4: CR/LF in display names, TZID and UID cannot add iCalendar properties', () => {
  const evil = 'Eve\r\nATTACH:http://evil.test/x\r\nURL:http://evil.test';
  const tz = { keyName: `Zone${evil}`, rules: [{ bias: 0, standardBias: 0, daylightBias: -60, standardDate: { month: 0 }, daylightDate: { month: 0 } }] };
  const m = {
    messageClass: 'IPM.Schedule.Meeting.Request', subject: `Meet${evil}`, messageId: `<id${evil}@x>`,
    dates: { submit: new Date('2024-01-01T00:00:00Z') },
    appointment: { start: new Date('2024-01-02T10:00:00Z'), end: new Date('2024-01-02T11:00:00Z'), location: evil, globalId: null, recur: null, tzStart: tz },
  };
  const cal = buildCalendar(m, { organizer: { name: evil, email: 'o@x.test' }, attendees: [{ name: evil, email: 'a@x.test', type: 'to' }], body: evil }, []);
  const lines = cal.ics.replace(/\r\n /g, '').split('\r\n');
  assert.ok(!lines.some((l) => /^(ATTACH|URL)[:;]/.test(l)), cal.ics);
  assert.ok(lines.every((l) => l === '' || /^[A-Z-]+[:;]/.test(l)), cal.ics);
  assert.ok(makeZone(tz, 2024).id.indexOf('\n') < 0);
});

// ---------------------------------------------------------------- M5
const der = (oidTail, extra = 32) => {
  const oid = oidTail.length === 2 ? [0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, ...oidTail]
    : [0x06, 0x0b, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, ...oidTail];
  const body = [...oid, 0xa0, 0x80, ...new Array(extra).fill(0x05)];
  return Uint8Array.from([0x30, 0x80, ...body]);
};

test('M5: IPM.Note.SMIME is labelled signed-data or enveloped-data from the CMS content type', () => {
  const mk = (data, mime) => conv({ props: [[T.MESSAGE_CLASS, 'IPM.Note.SMIME'], [T.SUBJECT, 's'], [T.SUBMIT_TIME, new Date()]],
    attachments: [{ props: [[T.ATTACH_METHOD, 1], [T.ATTACH_LONG_FILENAME, 'smime.p7m'], ...(mime ? [[T.ATTACH_MIME, mime]] : []), [T.ATTACH_DATA, data]] }] });
  const signed = mk(der([0x07, 0x02]));
  assert.match(headerBlock(signed.text), /Content-Type: application\/pkcs7-mime; smime-type=signed-data; name="smime.p7m"/);
  assert.equal(signed.report.body.kind, 'smime-opaque-signed');
  assert.match(mk(der([0x07, 0x03])).text, /smime-type=enveloped-data/);
  assert.match(mk(der([0x09, 0x10, 0x01, 0x17])).text, /smime-type=authEnveloped-data/);
  assert.match(mk(der([0x07, 0x03]), 'application/pkcs7-mime; smime-type=signed-data').text, /smime-type=signed-data/);
  const unknown = mk(Uint8Array.from(new Array(40).fill(7)));
  assert.ok(!/smime-type/.test(unknown.text));
  assert.ok(unknown.report.warnings.some((w) => /encryption or signature type was not recognised/.test(w)));
  // long-form DER length
  assert.equal(smimeType(Uint8Array.from([0x30, 0x82, 0x01, 0x00, ...der([0x07, 0x02]).subarray(2)])), 'signed-data');
});

// ---------------------------------------------------------------- QA defect 1
test('QA defect 1: trailing NUL padding is removed from HTML, text and RTF bodies; attachments untouched', () => {
  const html = new Uint8Array(60 + 7400);
  html.set(new TextEncoder().encode('<html><body><p>Test email body.</p></body></html>'));
  const att = Uint8Array.from([1, 2, 0, 0, 0]);
  const { eml, text } = conv({ props: [...base, [T.SUBJECT, 's'], [T.BODY, 'Body.\r\n\u0000\u0000\u0000'], [T.HTML, html]],
    attachments: [{ props: [[T.ATTACH_METHOD, 1], [T.ATTACH_LONG_FILENAME, 'a.bin'], [T.ATTACH_DATA, att]] }] });
  assertWellFormed(eml);
  assert.ok(!/=00/.test(text), 'no QP-escaped NUL');
  assert.match(text, /AQIAAAA=/, 'binary attachment keeps its trailing zero bytes');
  const rtf = uncompressedRtf('{\\rtf1\\ansi{\\fonttbl{\\f0 Times;}}\\f0 Formatted {\\b body}\\par end}\u0000');
  const r = conv({ props: [...base, [T.SUBJECT, 'r'], [T.RTF_COMPRESSED, rtf]] });
  assertWellFormed(r.eml);
  assert.ok(!/=00/.test(r.text));
  const b64 = /filename="body.rtf"\r\n[^\r]*\r\n\r\n([\s\S]*?)\r\n--/.exec(r.text)[1].replace(/\s/g, '');
  assert.ok(atob(b64).endsWith('end}'), 'body.rtf ends at the final brace');
  const enc = uncompressedRtf('{\\rtf1\\ansi\\fromhtml1 {\\*\\htmltag <p>}x{\\*\\htmltag </p>}}\u0000\u0000');
  const h = conv({ props: [...base, [T.SUBJECT, 'h'], [T.RTF_COMPRESSED, enc]] });
  assert.ok(!/=00/.test(h.text));
});

// ---------------------------------------------------------------- QA defect 2
test('QA defect 2: From takes the display name of the stored From header when it names the same address', () => {
  const { text, report } = conv({ props: [...base, [T.SUBJECT, 's'], [T.SENDER_NAME, 'Bob'], [T.SENDER_EMAIL, 'bob@example.com'], [T.SENDER_ADDRTYPE, 'SMTP'],
    [T.SENT_REP_NAME, 'Bob'], [T.SENT_REP_EMAIL, 'bob@example.com'],
    [T.TRANSPORT_HEADERS, 'From: Bob Sender <bob@example.com>\r\nReceived: by mx\r\n\r\n']] });
  assert.equal(header(text, 'From'), 'Bob Sender <bob@example.com>');
  assert.equal(report.addresses.from.nameSource, 'transport-headers');
  // a different address in the header does not rename the sender
  const other = conv({ props: [...base, [T.SUBJECT, 's'], [T.SENDER_NAME, 'Bob'], [T.SENDER_SMTP, 'bob@example.com'],
    [T.TRANSPORT_HEADERS, 'From: Someone Else <else@example.com>\r\n\r\n']] });
  assert.equal(header(other.text, 'From'), 'Bob <bob@example.com>');
});

// ---------------------------------------------------------------- minors
test('minor 13: on-behalf sender never takes the represented person\'s address from the From header', () => {
  const { text } = conv({ props: [...base, [T.SUBJECT, 's'],
    [T.SENDER_NAME, 'Assistant'], [T.SENDER_EMAIL, '/O=ORG/CN=ASSIST'], [T.SENDER_ADDRTYPE, 'EX'],
    [T.SENT_REP_NAME, 'Boss'], [T.SENT_REP_EMAIL, 'boss@example.test'], [T.SENT_REP_ADDRTYPE, 'SMTP'],
    [T.TRANSPORT_HEADERS, 'From: The Boss <boss@example.test>\r\n\r\n']] });
  assert.equal(header(text, 'From'), 'The Boss <boss@example.test>');
  assert.ok(!/^Sender: .*boss@/mi.test(headerBlock(text)));
});

test('minor 6: a cid must be followed by a delimiter to count as referenced', () => {
  const html = new TextEncoder().encode('<img src="cid:image001.png@01D0">');
  const { text } = conv({ props: [...base, [T.SUBJECT, 's'], [T.HTML, html]],
    attachments: [{ props: [[T.ATTACH_METHOD, 1], [T.ATTACH_LONG_FILENAME, 'image001.png'], [T.ATTACH_CONTENT_ID, 'image001.png'], [T.ATTACH_DATA, png]] }] });
  assert.ok(!/multipart\/related/.test(text));
  assert.match(text, /Content-Disposition: attachment; filename="image001.png"/);
});

test('minor 9: read-receipt and X-Mozilla-* headers are not replayed', () => {
  const { text } = conv({ props: [...base, [T.SUBJECT, 's'],
    [T.TRANSPORT_HEADERS, 'Disposition-Notification-To: a@x.test\r\nReturn-Receipt-To: a@x.test\r\nX-Mozilla-Status: 0001\r\nX-Kept: yes\r\n\r\n']] });
  const hb = headerBlock(text);
  assert.ok(!/Disposition-Notification-To|Return-Receipt-To|X-Mozilla/i.test(hb));
  assert.match(hb, /^X-Kept: yes$/m);
});

test('minor 10: a meeting REPLY carries ORGANIZER (the person it is sent to) and the answering ATTENDEE', () => {
  const m = { messageClass: 'IPM.Schedule.Meeting.Resp.Pos', subject: 'Accepted: x', dates: {},
    appointment: { start: new Date('2024-01-02T10:00:00Z'), end: new Date('2024-01-02T11:00:00Z'), location: '', recur: null } };
  const cal = buildCalendar(m, { organizer: { name: 'Att', email: 'att@x.test' }, attendees: [{ name: 'Org', email: 'org@x.test', type: 'to' }], body: '' }, []);
  assert.match(cal.ics, /\r\nORGANIZER;CN="Org":mailto:org@x\.test\r\n/);
  assert.match(cal.ics, /\r\nATTENDEE;CN="Att";PARTSTAT=ACCEPTED:mailto:att@x\.test\r\n/);
});

test('minor 11: folding never makes a whitespace-only line and hard-splits a token over 998 octets', () => {
  const f = foldHeader('X-A', `${'w'.repeat(70)}  ${'v'.repeat(10)}`);
  assert.ok(f.split('\r\n').every((l) => l.trim() !== ''));
  const long = foldHeader('X-B', 'x'.repeat(3000));
  assert.ok(long.split('\r\n').every((l) => l.length <= 998));
  assert.equal(long.replace(/\r\n /g, ''), `X-B: ${'x'.repeat(3000)}`);
});

test('minor 3: CP437 and CP850 decode as DOS Latin, not Cyrillic', () => {
  assert.equal(decodeBytes(Uint8Array.from([0x80, 0x81, 0x9b, 0xe1]), 437), 'Çü¢ß');
  assert.equal(decodeBytes(Uint8Array.from([0x80, 0xd0]), 'cp850'), 'Çð');
});

// ---------------------------------------------------------------- X.500 options A1 / A2
test('X.500 senders: A1 writes "Name:;"; A2 (default) writes a per-person .invalid address, stable and distinct', () => {
  const mk = (name, dn, o) => conv({ props: [...base, [T.SUBJECT, 's'], [T.SENDER_NAME, name], [T.SENDER_EMAIL, dn], [T.SENDER_ADDRTYPE, 'EX']],
    recipients: [{ props: [[T.DISPLAY_NAME, 'Allison, Timothy B.'], [T.EMAIL_ADDRESS, '/O=ORG/CN=TALLISON'], [T.ADDRTYPE, 'EX'], [T.RECIPIENT_TYPE, 1]] }] }, o);
  const a1 = mk('Angela Deng', '/O=ORG/CN=ADENG', { unresolvedAddress: 'name-only' });
  assert.match(header(mk('Angela Deng', '/O=ORG/CN=ADENG').text, 'From'), /@unresolved\.invalid>$/, 'A2 is the default');
  assert.equal(header(a1.text, 'From'), 'Angela Deng:;');
  assert.equal(header(a1.text, 'To'), '"Allison, Timothy B.":;');
  const o = { unresolvedAddress: 'invalid-domain' };
  const a2 = mk('Angela Deng', '/O=ORG/CN=ADENG', o);
  const from = header(a2.text, 'From');
  assert.match(from, /^Angela Deng <angela\.deng\.[0-9a-f]{8}@unresolved\.invalid>$/);
  assert.match(header(a2.text, 'To'), /^"Allison, Timothy B\." <allison\.timothy\.b\.[0-9a-f]{8}@unresolved\.invalid>$/);
  assert.equal(header(mk('Angela Deng', '/o=org/cn=adeng', o).text, 'From'), from, 'same person (DN case-insensitive) -> same address');
  assert.notEqual(header(mk('Angela Deng', '/O=ORG/CN=ADENG2', o).text, 'From'), from, 'different DN -> different address');
  assert.ok(!/\/O=/i.test(headerBlock(a2.text)));
  assert.match(unresolvedPlaceholder({ name: '王小明', dn: '/O=X/CN=W' }), /^unresolved\.[0-9a-f]{8}@unresolved\.invalid$/);
  assert.match(unresolvedPlaceholder({ name: 'Jörg Müller' }), /^jorg\.muller\.[0-9a-f]{8}@unresolved\.invalid$/);
});
