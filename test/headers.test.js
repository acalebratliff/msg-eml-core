import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHeaderBlock, parseAddressList, isSmtp, headerValue } from '../src/headers.js';
import { resolvePerson, resolveRecipient, buildDnMap } from '../src/address.js';

test('header block parsing unfolds and stops at the blank line', () => {
  const h = parseHeaderBlock('Received: a\r\n  b\r\nFrom: "X Y" <x@y.test>\r\nSubject: s\r\n\r\nbody: no');
  assert.deepEqual(h, [['Received', 'a b'], ['From', '"X Y" <x@y.test>'], ['Subject', 's']]);
  assert.equal(headerValue(h, 'subject'), 's');
});

test('address lists', () => {
  assert.deepEqual(parseAddressList('"Doe, Jane" <jane@x.test>, bob@x.test (Bob), =?UTF-8?B?w4lsaWU=?= <e@x.test>'), [
    { name: 'Doe, Jane', email: 'jane@x.test' },
    { name: 'Bob', email: 'bob@x.test' },
    { name: 'Élie', email: 'e@x.test' },
  ]);
  assert.deepEqual(parseAddressList('Team: a@x.test, b@x.test;, c@x.test').map((a) => a.email), ['a@x.test', 'b@x.test', 'c@x.test']);
});

test('X.500 DNs are never treated as SMTP', () => {
  assert.equal(isSmtp('/O=ORG/OU=EXCHANGE/CN=RECIPIENTS/CN=JDOE'), false);
  assert.equal(isSmtp('jdoe@example.test'), true);
  assert.equal(isSmtp('Unknown'), false);
});

const model = (over = {}) => ({
  sender: { name: 'Jane', email: '/O=ORG/CN=JANE', addrType: 'EX', smtp: '' },
  representing: { name: '', email: '', addrType: '', smtp: '' },
  recipients: [],
  ...over,
});

test('sender SMTP sources in order, DN never emitted', () => {
  const ctxFor = (m, headers = []) => ({ headers, dnMap: buildDnMap(m) });
  let m = model();
  assert.deepEqual(resolvePerson(m.sender, ctxFor(m), 'From'), { name: 'Jane', email: null, source: 'name-only', nameSource: 'mapi', dn: '/O=ORG/CN=JANE' });
  m = model({ sender: { name: 'Jane', email: '/O=ORG/CN=JANE', addrType: 'EX', smtp: 'jane@x.test' } });
  assert.equal(resolvePerson(m.sender, ctxFor(m), 'From').source, 'smtp-property');
  m = model();
  assert.equal(resolvePerson(m.sender, ctxFor(m, [['From', 'Jane <jane@hdr.test>']]), 'From').email, 'jane@hdr.test');
  m = model({ recipients: [{ type: 'to', name: 'Jane', email: '/o=org/cn=jane', addrType: 'EX', smtp: 'jane@dn.test' }] });
  const r = resolvePerson(m.sender, ctxFor(m), 'From');
  assert.deepEqual([r.email, r.source], ['jane@dn.test', 'dn-matched-in-message']);
  m = model({ sender: { name: 'S', email: 's@smtp.test', addrType: 'SMTP', smtp: '' } });
  assert.equal(resolvePerson(m.sender, ctxFor(m), 'From').email, 's@smtp.test');
});

test('recipient resolution falls back to headers by display name, then name only', () => {
  const m = model();
  const ctx = { headers: [['To', '"Bob B" <bob@x.test>, Carol <carol@x.test>']], dnMap: buildDnMap(m) };
  assert.equal(resolveRecipient({ type: 'to', name: 'Carol', email: '/O=X/CN=C', addrType: 'EX', smtp: '' }, ctx).email, 'carol@x.test');
  const none = resolveRecipient({ type: 'cc', name: 'Dan', email: '/O=X/CN=D', addrType: 'EX', smtp: '' }, ctx);
  assert.deepEqual(none, { name: 'Dan', email: null, source: 'name-only', dn: '/O=X/CN=D' });
});
