// Structural pre-check of a Compound File (MS-CFB) before it is handed to
// @kenjiuno/msgreader.
//
// msgreader follows sector chains and directory sibling links without loop
// detection, so a crafted or damaged file can make it loop for a very long
// time or allocate huge buffers. This guard walks the same structures the same
// way msgreader does (header, FAT from the header and DIFAT, directory chain,
// mini FAT, mini stream, every stream chain, the red-black tree links) and
// rejects anything that loops, points outside the file or claims a size the
// file cannot hold. Every loop here is bounded by the file size.

import { MsgError } from './errors.js';

const END_OF_CHAIN = -2;
const FREE = -1;
const NO_INDEX = -1;
const MINI_CUTOFF = 0x1000;
const MINI_SECTOR = 64;
const DIR_ENTRY = 128;
const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function corrupt(detail) {
  return new MsgError('CORRUPT_CFB', `The file is damaged and cannot be read (detail: ${detail}).`);
}

/**
 * @param {Uint8Array} u8
 * @returns {{sectorSize:number, entries:number, streams:number}}
 */
export function checkCompoundFile(u8) {
  if (!(u8 instanceof Uint8Array)) throw new MsgError('BAD_INPUT', 'Input must be a Uint8Array or ArrayBuffer.');
  if (u8.length < 512) throw new MsgError('NOT_MSG', 'The file is too small to be an Outlook .msg file.');
  for (let i = 0; i < 8; i++) {
    if (u8[i] !== SIGNATURE[i]) throw new MsgError('NOT_MSG', 'The file is not an Outlook .msg file (no Compound File signature).');
  }
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const i32 = (off) => {
    if (off < 0 || off + 4 > u8.length) throw corrupt(`read outside the file at offset ${off}`);
    return dv.getInt32(off, true);
  };

  // Same sector size rule as msgreader: shift 12 means 4096, anything else 512.
  const sectorSize = u8[30] === 12 ? 4096 : 512;
  const perSector = sectorSize / 4;
  const maxSectors = Math.ceil(u8.length / sectorSize) + 1; // upper bound for any chain length

  const batCount = i32(0x2c);
  const dirStart = i32(0x30);
  const sbatStart = i32(0x3c);
  const sbatCount = i32(0x40);
  const xbatStart = i32(0x44);
  const xbatCount = i32(0x48);
  for (const [name, v] of [['FAT count', batCount], ['mini FAT count', sbatCount], ['DIFAT count', xbatCount]]) {
    if (v < 0 || v > maxSectors) throw corrupt(`${name} ${v} is impossible for a ${u8.length}-byte file`);
  }

  const sectorOffset = (s) => (s + 1) * sectorSize;

  // FAT sector list: header part, then the DIFAT chain (msgreader's batDataReader / xbatDataReader).
  const bat = [];
  const inHeader = Math.min(batCount, (512 - 0x4c) / 4);
  for (let i = 0; i < inHeader; i++) bat.push(i32(0x4c + 4 * i));
  if (xbatCount > 0) {
    let remaining = batCount - inHeader;
    let next = xbatStart;
    const seen = new Set();
    for (let i = 0; i < xbatCount; i++) {
      if (seen.has(next)) throw corrupt('DIFAT chain loops');
      seen.add(next);
      const base = sectorOffset(next);
      const n = Math.min(remaining, perSector - 1);
      for (let j = 0; j < n; j++) {
        const v = i32(base + 4 * j);
        if (v === FREE || v === END_OF_CHAIN) break;
        bat.push(v);
      }
      remaining -= n;
      next = i32(base + 4 * (perSector - 1));
      if (next === FREE || next === END_OF_CHAIN) break;
    }
  }

  // Next-sector lookup exactly as msgreader's getNextBlockInner.
  const nextIn = (table) => (offset) => {
    const block = Math.floor(offset / perSector);
    const idx = offset % perSector;
    const start = table[block];
    if (start === undefined) return END_OF_CHAIN;
    return i32(sectorOffset(start) + 4 * idx);
  };
  const nextBig = nextIn(bat);

  // Follow a chain with loop and length checks; returns the sector list.
  function chain(start, next, what, limit = maxSectors) {
    const out = [];
    const seen = new Set();
    let cur = start;
    while (cur !== END_OF_CHAIN) {
      if (seen.has(cur)) throw corrupt(`${what} sector chain loops`);
      if (out.length >= limit) throw corrupt(`${what} sector chain is longer than the file`);
      seen.add(cur);
      out.push(cur);
      cur = next(cur);
    }
    return out;
  }

  // Directory chain and entries.
  const dirSectors = chain(dirStart, nextBig, 'directory');
  const entries = [];
  for (const s of dirSectors) {
    const base = sectorOffset(s);
    for (let i = 0; i < sectorSize / DIR_ENTRY; i++) {
      const off = base + i * DIR_ENTRY;
      if (u8.length < off + 0x42) break; // msgreader stops here too
      const type = u8[off + 0x42];
      if (type === 1 || type === 2 || type === 5) {
        entries.push({
          type,
          left: i32(off + 0x44),
          right: i32(off + 0x48),
          child: i32(off + 0x4c),
          start: i32(off + 0x74),
          size: i32(off + 0x78),
        });
      } else {
        entries.push({ type, left: NO_INDEX, right: NO_INDEX, child: NO_INDEX, start: 0, size: 0 });
      }
    }
  }
  if (entries.length === 0 || entries[0].type !== 5) throw corrupt('no root entry');

  // Mini FAT (msgreader's sbatDataReader stops on a zero start).
  const sbat = [];
  {
    let cur = sbatStart;
    const seen = new Set();
    for (let i = 0; i < sbatCount && cur && cur !== END_OF_CHAIN; i++) {
      if (seen.has(cur)) throw corrupt('mini FAT chain loops');
      seen.add(cur);
      sbat.push(cur);
      cur = nextBig(cur);
    }
  }
  const nextSmall = nextIn(sbat);
  const root = entries[0];
  const miniStreamSectors = chain(root.start, nextBig, 'mini stream');
  const miniStreamBytes = miniStreamSectors.length * sectorSize;

  // Directory tree: every reachable index must exist and be visited once.
  const visited = new Set([0]);
  let streams = 0;
  const stack = [];
  if (root.child !== NO_INDEX) stack.push(root.child);
  while (stack.length) {
    const idx = stack.pop();
    if (idx === NO_INDEX) continue;
    if (idx < 0 || idx >= entries.length) throw corrupt(`directory entry ${idx} does not exist`);
    if (visited.has(idx)) throw corrupt('directory tree loops');
    visited.add(idx);
    const e = entries[idx];
    if (e.left !== NO_INDEX) stack.push(e.left);
    if (e.right !== NO_INDEX) stack.push(e.right);
    if (e.type === 1 && e.child !== NO_INDEX) stack.push(e.child);
    if (e.type === 2) {
      streams++;
      if (e.size < 0 || e.size > u8.length) throw corrupt(`stream size ${e.size} is larger than the file`);
      if (e.size === 0) continue;
      if (e.size < MINI_CUTOFF) {
        if (e.size > miniStreamBytes) throw corrupt('mini stream is smaller than a stream it holds');
        const c = chain(e.start, nextSmall, 'mini stream', Math.ceil(miniStreamBytes / MINI_SECTOR) + 1);
        for (const ms of c) {
          const big = Math.floor((ms * MINI_SECTOR) / sectorSize);
          if (ms < 0 || big >= miniStreamSectors.length) throw corrupt('mini sector outside the mini stream');
        }
      } else {
        // msgreader reads ceil(size / sectorSize) sectors following the FAT.
        const need = Math.ceil(e.size / sectorSize);
        let cur = e.start;
        const seen = new Set();
        for (let k = 0; k < need; k++) {
          if (cur < 0 || sectorOffset(cur) + Math.min(sectorSize, e.size - k * sectorSize) > u8.length) {
            throw corrupt('stream data outside the file');
          }
          if (seen.has(cur)) throw corrupt('stream sector chain loops');
          seen.add(cur);
          cur = nextBig(cur);
        }
      }
    }
  }
  return { sectorSize, entries: entries.length, streams };
}
