// PidTagRtfCompressed (MS-OXRTFCP) decompression.
//
// The LZ decompression itself is done by @kenjiuno/decompressrtf
// (BSD-2-Clause, already a dependency of msgreader). That function trusts the
// header's size fields, so this wrapper validates the header first, as
// MS-OXRTFCP section 4.1 asks ("COMPSIZE and RAWSIZE might have been tampered
// with"), checks the CRC (section 2.1.3.2 / 2.2.3.2) and handles the
// UNCOMPRESSED type itself.

import decompressPkg from '@kenjiuno/decompressrtf';

const { decompressRTF } = decompressPkg;

const COMPRESSED = 0x75465a4c; // "LZFu"
const UNCOMPRESSED = 0x414c454d; // "MELA"

let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  // The 256-entry table in MS-OXRTFCP 2.1.2.2.1 is the standard reflected
  // CRC-32 table (polynomial 0xEDB88320); generate it rather than paste it.
  CRC_TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[n] = c >>> 0;
  }
  return CRC_TABLE;
}

/** MS-OXRTFCP 2.1.3.2: CRC over bytes, initial value 0, no final XOR. */
export function rtfCrc(bytes, start = 0, end = bytes.length) {
  const t = crcTable();
  let crc = 0;
  for (let i = start; i < end; i++) crc = t[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return crc >>> 0;
}

/**
 * Decompress compressed RTF.
 * @param {Uint8Array} input
 * @returns {{rtf: Uint8Array, warnings: string[]}}
 * @throws Error when the data is corrupt beyond use.
 */
export function decompressRtf(input) {
  const warnings = [];
  if (!input || input.length < 16) throw new Error('compressed RTF is shorter than its 16-byte header');
  const dv = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const compSize = dv.getUint32(0, true);
  const rawSize = dv.getUint32(4, true);
  const compType = dv.getUint32(8, true);
  const crc = dv.getUint32(12, true);

  if (compType === UNCOMPRESSED) {
    // 2.2.3.1: read to the end of the stream; RAWSIZE may be used as a limit.
    const end = Math.min(input.length, 16 + rawSize);
    return { rtf: trimNulBytes(input.slice(16, end)), warnings };
  }
  if (compType !== COMPRESSED) throw new Error('compressed RTF has an unknown COMPTYPE');
  if (compSize < 12) throw new Error('compressed RTF COMPSIZE is too small');
  if (compSize + 4 > input.length) {
    throw new Error(`compressed RTF claims ${compSize + 4} bytes but the property holds ${input.length}`);
  }
  // A 2-byte dictionary reference copies at most 17 bytes, so the output is
  // at most about 8.5 times the input; the bound below allows 9 times. A
  // RAWSIZE beyond that is a lie.
  if (rawSize > compSize * 9 + 4096) throw new Error('compressed RTF RAWSIZE is implausible');

  const actual = rtfCrc(input, 16, compSize + 4);
  if (actual !== crc) warnings.push('The formatted body failed a check. It is shown as found and may contain errors.');

  const out = decompressRTF(input.subarray(0, compSize + 4));
  const len = Math.min(out.length, rawSize);
  if (out.length < rawSize) warnings.push('The formatted body is shorter than the file says. Some text may be missing.');
  const rtf = new Uint8Array(len);
  for (let i = 0; i < len; i++) rtf[i] = out[i] & 0xff;
  return { rtf: trimNulBytes(rtf), warnings };
}

/**
 * RTF is 7-bit text, so NUL bytes after it are padding (seen in the RTF
 * sample files: one NUL after the final brace). Removed so the kept
 * body.rtf and the text taken from it carry no NUL (QA defect 1).
 */
function trimNulBytes(u8) {
  let end = u8.length;
  while (end > 0 && u8[end - 1] === 0) end--;
  return end === u8.length ? u8 : u8.subarray(0, end);
}
