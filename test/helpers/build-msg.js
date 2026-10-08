// Test helper: build synthetic Outlook .msg files (MS-OXMSG layout) so the
// tests need no third-party sample mail. Uses msgreader's own CFB writer.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { burn } = require('@kenjiuno/msgreader/lib/Burner.js');

const DIR = 1;
const DOC = 2;
const ROOT = 5;

const hex8 = (n) => (n >>> 0).toString(16).toUpperCase().padStart(8, '0');

function utf16z(s) {
  const out = new Uint8Array((s.length + 1) * 2);
  for (let i = 0; i < s.length; i++) {
    out[i * 2] = s.charCodeAt(i) & 0xff;
    out[i * 2 + 1] = s.charCodeAt(i) >> 8;
  }
  return out;
}

function fileTime(date) {
  const ft = BigInt(date.getTime()) * 10000n + 116444736000000000n;
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, ft, true);
  return b;
}

/**
 * props: array of [tag, value]
 *   tag type 0x001F: string; 0x001E: Uint8Array (raw ANSI bytes, NUL added) or ASCII string;
 *   0x0102: Uint8Array; 0x0003: number; 0x000B: boolean; 0x0040: Date
 */
function propsToStorage(props, headerSize, headerExtra) {
  const streams = [];
  const fixed = [];
  for (const [tag, value] of props) {
    const type = tag & 0xffff;
    if (type === 0x001f || type === 0x001e || type === 0x0102 || type === 0x000d) {
      let data;
      if (type === 0x001f) data = utf16z(value);
      else if (type === 0x001e) {
        const raw = value instanceof Uint8Array ? value : Uint8Array.from([...value].map((c) => c.charCodeAt(0)));
        data = new Uint8Array(raw.length + 1);
        data.set(raw);
      } else data = value;
      streams.push({ name: `__substg1.0_${hex8(tag)}`, data });
      const v = new Uint8Array(8);
      new DataView(v.buffer).setUint32(0, data.length, true);
      fixed.push([tag, 6, v]);
    } else {
      const v = new Uint8Array(8);
      const dv = new DataView(v.buffer);
      if (type === 0x0003) dv.setInt32(0, value, true);
      else if (type === 0x000b) dv.setUint16(0, value ? 1 : 0, true);
      else if (type === 0x0040) v.set(fileTime(value));
      fixed.push([tag, 6, v]);
    }
  }
  const ps = new Uint8Array(headerSize + 16 * fixed.length);
  if (headerExtra) ps.set(headerExtra, 0);
  fixed.forEach(([tag, flags, v], i) => {
    const dv = new DataView(ps.buffer, headerSize + i * 16, 16);
    dv.setUint32(0, tag, true);
    dv.setUint32(4, flags, true);
    ps.set(v, headerSize + i * 16 + 8);
  });
  streams.push({ name: '__properties_version1.0', data: ps });
  return streams;
}

function messageNodes(spec, embedded) {
  const recips = spec.recipients || [];
  const atts = spec.attachments || [];
  const header = new Uint8Array(embedded ? 24 : 32);
  const hdv = new DataView(header.buffer);
  hdv.setUint32(8, recips.length, true);
  hdv.setUint32(12, atts.length, true);
  hdv.setUint32(16, recips.length, true);
  hdv.setUint32(20, atts.length, true);
  const children = propsToStorage(spec.props || [], embedded ? 24 : 32, header).map((s) => ({ type: DOC, ...s }));
  recips.forEach((r, i) => {
    children.push({
      type: DIR,
      name: `__recip_version1.0_#${hex8(i)}`,
      children: propsToStorage(r.props || [], 8).map((s) => ({ type: DOC, ...s })),
    });
  });
  atts.forEach((a, i) => {
    const kids = propsToStorage(a.props || [], 8).map((s) => ({ type: DOC, ...s }));
    if (a.embedded) {
      kids.push({ type: DIR, name: '__substg1.0_3701000D', children: messageNodes(a.embedded, true) });
    }
    children.push({ type: DIR, name: `__attach_version1.0_#${hex8(i)}`, children: kids });
  });
  if (!embedded) {
    children.push({
      type: DIR,
      name: '__nameid_version1.0',
      children: [
        { type: DOC, name: '__substg1.0_00020102', data: new Uint8Array(0) },
        { type: DOC, name: '__substg1.0_00030102', data: new Uint8Array(0) },
        { type: DOC, name: '__substg1.0_00040102', data: new Uint8Array(0) },
      ],
    });
  }
  return children;
}

/** Build a .msg file (Uint8Array) from a spec. */
export function buildMsg(spec) {
  const entries = [{ name: 'Root Entry', type: ROOT, length: 0, children: [] }];
  const add = (node) => {
    const idx = entries.length;
    if (node.type === DOC) {
      const data = node.data;
      entries.push({ name: node.name, type: DOC, length: data.length, binaryProvider: () => data });
    } else {
      const e = { name: node.name, type: DIR, length: 0, children: [] };
      entries.push(e);
      e.children = node.children.map(add);
    }
    return idx;
  };
  entries[0].children = messageNodes(spec, false).map(add);
  return burn(entries);
}

export const T = {
  SUBJECT: 0x0037001f,
  SUBJECT_A: 0x0037001e,
  MESSAGE_CLASS: 0x001a001f,
  BODY: 0x1000001f,
  BODY_A: 0x1000001e,
  HTML: 0x10130102,
  RTF_COMPRESSED: 0x10090102,
  SENDER_NAME: 0x0c1a001f,
  SENDER_EMAIL: 0x0c1f001f,
  SENDER_ADDRTYPE: 0x0c1e001f,
  SENDER_SMTP: 0x5d01001f,
  SENT_REP_NAME: 0x0042001f,
  SENT_REP_EMAIL: 0x0065001f,
  SENT_REP_ADDRTYPE: 0x0064001f,
  SENT_REP_SMTP: 0x5d02001f,
  SUBMIT_TIME: 0x00390040,
  DELIVERY_TIME: 0x0e060040,
  CREATION_TIME: 0x30070040,
  INTERNET_MESSAGE_ID: 0x1035001f,
  IN_REPLY_TO: 0x1042001f,
  REFERENCES: 0x1039001f,
  TRANSPORT_HEADERS: 0x007d001f,
  MESSAGE_CODEPAGE: 0x3ffd0003,
  INTERNET_CODEPAGE: 0x3fde0003,
  LOCALE_ID: 0x3ff10003,
  IMPORTANCE: 0x00170003,
  // recipient
  DISPLAY_NAME: 0x3001001f,
  EMAIL_ADDRESS: 0x3003001f,
  ADDRTYPE: 0x3002001f,
  SMTP_ADDRESS: 0x39fe001f,
  RECIPIENT_TYPE: 0x0c150003,
  // attachment
  ATTACH_DATA: 0x37010102,
  ATTACH_LONG_FILENAME: 0x3707001f,
  ATTACH_FILENAME: 0x3704001f,
  ATTACH_MIME: 0x370e001f,
  ATTACH_CONTENT_ID: 0x3712001f,
  ATTACH_METHOD: 0x37050003,
  ATTACH_DISPLAY_NAME: 0x3001001f,
};
