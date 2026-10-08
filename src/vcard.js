// Minimal vCard 4.0 (RFC 6350) for IPM.Contact items, so contact fields are
// not lost when the item becomes an email.

import { foldLine } from './ical.js';

const esc = (s) => String(s ?? '').replace(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/g, '').replace(/\\/g, '\\\\').replace(/,/g, '\\,').replace(/;/g, '\\;').replace(/\r\n|\r|\n/g, '\\n');

/** @returns {{text:string, filename:string}|null} */
export function contactVcard(c) {
  const fn = c.email1DisplayName && !/@/.test(c.email1DisplayName) ? c.email1DisplayName
    : [c.displayNamePrefix, c.givenName, c.middleName, c.surname, c.generation].filter(Boolean).join(' ') || c.fileUnder || c.subject || '';
  if (!fn && !c.email1EmailAddress) return null;
  const L = ['BEGIN:VCARD', 'VERSION:4.0', `FN:${esc(fn || c.email1EmailAddress)}`];
  L.push(`N:${[c.surname, c.givenName, c.middleName, c.displayNamePrefix, c.generation].map(esc).join(';')}`);
  if (c.companyName || c.departmentName || c.department) L.push(`ORG:${esc(c.companyName)}${c.departmentName || c.department ? ';' + esc(c.departmentName || c.department) : ''}`);
  if (c.title) L.push(`TITLE:${esc(c.title)}`);
  if (c.email1EmailAddress && /@/.test(c.email1EmailAddress)) L.push(`EMAIL;TYPE=work:${esc(c.email1EmailAddress)}`);
  const tel = (type, v) => v && L.push(`TEL;TYPE=${type}:${esc(v)}`);
  tel('work,voice', c.businessTelephoneNumber);
  tel('home,voice', c.homeTelephoneNumber);
  tel('cell', c.mobileTelephoneNumber);
  tel('work,fax', c.businessFaxNumber);
  const adr = (type, street, city, region, code, country) => {
    if (street || city || region || code || country) L.push(`ADR;TYPE=${type}:;;${[street, city, region, code, country].map(esc).join(';')}`);
  };
  adr('work', c.workAddressStreet, c.workAddressCity, c.workAddressState, c.workAddressPostalCode, c.workAddressCountry);
  adr('home', c.streetAddress, c.addressCity, c.stateOrProvince, c.postalCode, c.country);
  if (c.businessHomePage) L.push(`URL:${esc(c.businessHomePage)}`);
  if (c.body) L.push(`NOTE:${esc(c.body)}`);
  L.push('END:VCARD');
  const base = (fn || 'contact').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 80);
  return { text: L.map(foldLine).join('\r\n') + '\r\n', filename: `${base}.vcf` };
}
