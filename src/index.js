// msg-eml-core: Outlook .msg -> RFC 5322 / MIME .eml
// Browser, WebExtension and Node safe: no Node-only APIs, no network access.

import { readMsg } from './reader.js';
import { buildEml } from './convert.js';
import { MsgError } from './errors.js';

/**
 * Convert an Outlook .msg file to an .eml message.
 *
 * @param {Uint8Array|ArrayBuffer} msgBytes the .msg file contents
 * @param {object} [options]
 * @param {'auto'|'always'|'never'} [options.keepRtf='auto'] attach the RTF
 *   body as body.rtf when it is real RTF (not encapsulated HTML/text); 'auto'
 *   does so only when there is no HTML body and the RTF has text
 * @param {boolean} [options.replayHeaders=true] copy stored internet headers
 *   (Received, Reply-To, List-*, ...) that the converter does not generate
 * @param {number} [options.maxDepth=16] maximum nesting of embedded messages
 * @param {'name-only'|'invalid-domain'} [options.unresolvedAddress='invalid-domain']
 *   how to write a person with no usable SMTP address in the file: the
 *   display name alone (A1, RFC 5322 group syntax "Name:;"), or the name with
 *   a per-person placeholder address in the reserved .invalid domain (A2,
 *   "Name <slug.hash@unresolved.invalid>", the hash taken from the X.500 DN so
 *   one person always gets the same address). An X.500 DN is never written.
 * @param {boolean} [options.utf8Headers=false] write an address whose local
 *   part is not ASCII as UTF-8 (RFC 6532). Off: the output is 7-bit and such
 *   an address is written as unresolved, with a warning. A non-ASCII domain
 *   alone is always written in its ASCII (punycode) form.
 * @returns {{eml: Uint8Array, report: object}} report lists sources used and
 *   warnings about anything that could not be carried over
 * @throws {MsgError} with a stable `code` for unreadable input
 */
export function convertMsgToEml(msgBytes, options = {}) {
  let model;
  try {
    model = readMsg(msgBytes, options);
  } catch (e) {
    if (e instanceof MsgError) throw e;
    throw new MsgError('UNREADABLE', `The file could not be read as an Outlook message (${e && e.message ? e.message : e}).`, e);
  }
  try {
    const { bytes, report } = buildEml(model, options);
    return { eml: bytes, report };
  } catch (e) {
    if (e instanceof MsgError) throw e;
    throw new MsgError('UNREADABLE', `The message could not be converted (${e && e.message ? e.message : e}).`, e);
  }
}

export { MsgError, readMsg, buildEml };
export { decompressRtf } from './rtf/decompress.js';
export { deEncapsulate, detectEncapsulation, rtfToText } from './rtf/rtf.js';
