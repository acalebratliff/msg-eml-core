// Sender and recipient address resolution.
//
// Exchange-type (EX) entries store an X.500 distinguished name
// ("/O=.../CN=...") where an SMTP address would be. A DN is not an email
// address and is never written into an address header. Sources tried, in
// order, are listed in resolveSender / resolveRecipient; when none gives an
// SMTP address the display name is kept on its own (RFC 5322 group syntax,
// "Name:;", which RFC 6854 also allows in From).

import { isSmtp, parseAddressList, headerValue } from './headers.js';

const norm = (s) => String(s || '').trim().toLowerCase();

/**
 * Parsed address list of a stored header, parsed once per message: with
 * thousands of recipients, re-parsing the To header for each one would make
 * the work grow with recipients x header size.
 */
function headerList(ctx, name) {
  if (!ctx.lists) ctx.lists = new Map();
  const key = name.toLowerCase();
  if (!ctx.lists.has(key)) ctx.lists.set(key, parseAddressList(headerValue(ctx.headers, name) || ''));
  return ctx.lists.get(key);
}

/** Map of X.500 DN (lower-case) to SMTP, from every entry that has both. */
export function buildDnMap(model) {
  const map = new Map();
  const add = (dn, smtp) => {
    if (dn && String(dn).startsWith('/') && isSmtp(smtp)) map.set(norm(dn), smtp.trim());
  };
  for (const r of model.recipients) add(r.email, r.smtp);
  add(model.sender.email, model.sender.smtp);
  add(model.representing.email, model.representing.smtp);
  return map;
}

function pick(...cands) {
  for (const c of cands) if (c && isSmtp(c.value)) return { email: c.value.trim(), source: c.source };
  return null;
}

const dnOf = (p) => (p.email && String(p.email).startsWith('/') ? String(p.email).trim() : null);

/**
 * Resolve one person (sender or represented sender).
 * @param {object} p {name, email, addrType, smtp}
 * @param {object} ctx {headers, dnMap}
 * @param {string|null} headerName stored header to look in ('From' or 'Sender')
 * @param {{author?:boolean}} [o] author: this person is the one the stored
 *   header names, so a lone mailbox in it may be used even when the display
 *   names differ (it is never used for anyone else; see minor 13 of the review)
 * @returns {{name:string, email:string|null, source:string, nameSource:string, dn:string|null}}
 */
export function resolvePerson(p, ctx, headerName, o = {}) {
  const dnMap = ctx.dnMap;
  const fromHeader = headerName ? headerList(ctx, headerName) : [];
  const hdr = fromHeader.find((a) => isSmtp(a.email) && (!p.name || norm(a.name) === norm(p.name))) ||
    (o.author && fromHeader.length === 1 && isSmtp(fromHeader[0].email) ? fromHeader[0] : null);
  const r = pick(
    { value: p.smtp, source: 'smtp-property' },
    { value: (norm(p.addrType) === 'smtp' || !p.addrType) ? p.email : null, source: 'email-address-property' },
    { value: hdr && hdr.email, source: 'transport-headers' },
    { value: p.email && dnMap.get(norm(p.email)), source: 'dn-matched-in-message' },
    { value: p.email, source: 'email-address-property' },
  );
  let name = (p.name && p.name.trim()) || (hdr && hdr.name) || '';
  let nameSource = p.name && p.name.trim() ? 'mapi' : (hdr && hdr.name ? 'transport-headers' : 'none');
  if (r) {
    // The stored header is the message as it was sent. When it names the
    // same address, its display name is used, so From agrees with the
    // other stored headers that are copied over (QA defect 2: MAPI held a
    // shortened "Bob" where the sent header said "Bob Sender").
    const same = fromHeader.find((a) => a.name && isSmtp(a.email) && a.email.trim().toLowerCase() === r.email.toLowerCase());
    if (same) { name = same.name; nameSource = 'transport-headers'; }
    return { name, email: r.email, source: r.source, nameSource, dn: dnOf(p) };
  }
  return { name, email: null, source: 'name-only', nameSource, dn: dnOf(p) };
}

/** Candidate SMTP list for a recipient that only has a display name, from headers. */
export function resolveRecipient(rc, ctx) {
  const headerName = rc.type === 'cc' ? 'Cc' : rc.type === 'bcc' ? 'Bcc' : 'To';
  const list = headerList(ctx, headerName);
  let hdr = list.find((a) => isSmtp(a.email) && rc.name && norm(a.name) === norm(rc.name));
  if (!hdr && rc.name && isSmtp(rc.name.replace(/^'+|'+$/g, ''))) hdr = { email: rc.name.replace(/^'+|'+$/g, '') };
  const r = pick(
    { value: rc.smtp, source: 'smtp-property' },
    { value: (norm(rc.addrType) === 'smtp' || !rc.addrType) ? rc.email : null, source: 'email-address-property' },
    { value: hdr && hdr.email, source: 'transport-headers' },
    { value: rc.email && ctx.dnMap.get(norm(rc.email)), source: 'dn-matched-in-message' },
    { value: rc.email, source: 'email-address-property' },
  );
  const name = (rc.name && rc.name.trim()) || '';
  if (r) return { name, email: r.email, source: r.source, dn: dnOf(rc) };
  return { name, email: null, source: 'name-only', dn: dnOf(rc) };
}
