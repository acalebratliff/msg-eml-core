// Windows code page handling, built only on the WHATWG Encoding API
// (TextDecoder), which exists in browsers, Thunderbird and Node.

const CP_TO_LABEL = {
  437: 'x-cp437', // not in the Encoding Standard: decoded with SBCS_TABLES below
  708: 'iso-8859-6',
  720: 'x-cp720',
  850: 'x-cp850',
  866: 'ibm866',
  874: 'windows-874',
  932: 'shift_jis',
  936: 'gbk',
  949: 'euc-kr',
  950: 'big5',
  1200: 'utf-16le',
  1201: 'utf-16be',
  1250: 'windows-1250',
  1251: 'windows-1251',
  1252: 'windows-1252',
  1253: 'windows-1253',
  1254: 'windows-1254',
  1255: 'windows-1255',
  1256: 'windows-1256',
  1257: 'windows-1257',
  1258: 'windows-1258',
  10000: 'macintosh',
  10007: 'x-mac-cyrillic',
  20127: 'windows-1252', // US-ASCII; the Encoding Standard maps ASCII to windows-1252
  20866: 'koi8-r',
  21866: 'koi8-u',
  20932: 'euc-jp',
  28591: 'windows-1252',
  28592: 'iso-8859-2',
  28593: 'iso-8859-3',
  28594: 'iso-8859-4',
  28595: 'iso-8859-5',
  28596: 'iso-8859-6',
  28597: 'iso-8859-7',
  28598: 'iso-8859-8',
  28599: 'windows-1254',
  28603: 'iso-8859-13',
  28605: 'iso-8859-15',
  38598: 'iso-8859-8-i',
  50220: 'iso-2022-jp',
  50221: 'iso-2022-jp',
  50222: 'iso-2022-jp',
  51932: 'euc-jp',
  51936: 'gbk',
  51949: 'euc-kr',
  54936: 'gb18030',
  65001: 'utf-8',
};

// Internet (MIME) code pages that are 7-bit transfer forms of an ANSI code
// page. Used only when nothing better is known about how ANSI strings were
// stored: the ANSI strings in such files are in the ANSI code page, not in the
// 7-bit form.
const INTERNET_TO_ANSI = {
  50220: 932, 50221: 932, 50222: 932, 51932: 932, 20932: 932,
  51936: 936, 52936: 936, 54936: 936,
  51949: 949,
  20127: 1252, 28591: 1252, 28605: 1252, 65001: 1252, 1200: 1252,
  20866: 1251, 21866: 1251, 28595: 1251,
  28592: 1250, 28597: 1253, 28599: 1254, 28598: 1255, 38598: 1255, 28596: 1256,
  28594: 1257, 28603: 1257,
};

const ANSI_CPS = new Set([874, 932, 936, 949, 950, 1250, 1251, 1252, 1253, 1254, 1255, 1256, 1257, 1258]);

/** Windows default ANSI code page for a locale id (LCID), or null. */
export function lcidToCodepage(lcid) {
  if (!lcid || typeof lcid !== 'number') return null;
  const primary = lcid & 0x3ff;
  switch (lcid) {
    case 0x0404: case 0x0c04: case 0x1404: return 950; // zh-TW, zh-HK, zh-MO
    case 0x0804: case 0x1004: return 936; // zh-CN, zh-SG
    case 0x0c1a: case 0x1c1a: case 0x281a: case 0x201a: return 1251; // Serbian/Bosnian Cyrillic
    case 0x0843: case 0x082c: return 1251; // Uzbek, Azeri Cyrillic
    default: break;
  }
  if ([0x19, 0x22, 0x23, 0x02, 0x2f, 0x3f, 0x40, 0x44, 0x50, 0x6d, 0x85, 0x28].includes(primary)) return 1251;
  if ([0x05, 0x0e, 0x15, 0x18, 0x1b, 0x24, 0x1a, 0x1c, 0x42].includes(primary)) return 1250;
  if (primary === 0x08) return 1253;
  if ([0x1f, 0x2c, 0x43].includes(primary)) return 1254;
  if (primary === 0x0d) return 1255;
  if ([0x01, 0x29, 0x20, 0x8c].includes(primary)) return 1256;
  if ([0x25, 0x26, 0x27].includes(primary)) return 1257;
  if (primary === 0x2a) return 1258;
  if (primary === 0x1e) return 874;
  if (primary === 0x11) return 932;
  if (primary === 0x12) return 949;
  if (primary === 0x04) return 936;
  return 1252;
}

/**
 * Choose the code page for ANSI (PT_STRING8) properties.
 * Order: PidTagMessageCodepage, then the code page of PidTagMessageLocaleId,
 * then PidTagInternetCodepage mapped to its ANSI code page, then 1252.
 * The internet code page comes last because it describes the MIME body,
 * not how Outlook stored ANSI strings (tested: files with an iso-2022-jp
 * or utf-8 internet code page store ANSI strings as cp932 / cp1252).
 */
export function chooseAnsiCodepage({ messageCodepage, messageLocaleId, internetCodepage } = {}) {
  if (messageCodepage && codepageLabel(messageCodepage)) {
    return { codepage: messageCodepage, source: 'PidTagMessageCodepage' };
  }
  const fromLcid = lcidToCodepage(messageLocaleId);
  if (fromLcid) return { codepage: fromLcid, source: 'PidTagMessageLocaleId' };
  if (internetCodepage) {
    const cp = ANSI_CPS.has(internetCodepage) ? internetCodepage : (Object.hasOwn(INTERNET_TO_ANSI, internetCodepage) ? INTERNET_TO_ANSI[internetCodepage] : null);
    if (cp) return { codepage: cp, source: 'PidTagInternetCodepage' };
  }
  return { codepage: 1252, source: 'default' };
}

/** Encoding Standard label for a Windows code page number, or null. */
export function codepageLabel(cp) {
  return Object.hasOwn(CP_TO_LABEL, cp) ? CP_TO_LABEL[cp] : null;
}

// DOS code pages that the Encoding Standard lacks (so TextDecoder cannot
// decode them). Upper halves (0x80-0xFF) as Unicode, generated from the
// standard tables (Python's codecs); the lower half is ASCII. These give the
// same result as iconv-lite, which msgreader uses under Node (review minor 3).
const SBCS_TABLES = new Map([
  ['x-cp437', "\u00c7\u00fc\u00e9\u00e2\u00e4\u00e0\u00e5\u00e7\u00ea\u00eb\u00e8\u00ef\u00ee\u00ec\u00c4\u00c5\u00c9\u00e6\u00c6\u00f4\u00f6\u00f2\u00fb\u00f9\u00ff\u00d6\u00dc\u00a2\u00a3\u00a5\u20a7\u0192\u00e1\u00ed\u00f3\u00fa\u00f1\u00d1\u00aa\u00ba\u00bf\u2310\u00ac\u00bd\u00bc\u00a1\u00ab\u00bb\u2591\u2592\u2593\u2502\u2524\u2561\u2562\u2556\u2555\u2563\u2551\u2557\u255d\u255c\u255b\u2510\u2514\u2534\u252c\u251c\u2500\u253c\u255e\u255f\u255a\u2554\u2569\u2566\u2560\u2550\u256c\u2567\u2568\u2564\u2565\u2559\u2558\u2552\u2553\u256b\u256a\u2518\u250c\u2588\u2584\u258c\u2590\u2580\u03b1\u00df\u0393\u03c0\u03a3\u03c3\u00b5\u03c4\u03a6\u0398\u03a9\u03b4\u221e\u03c6\u03b5\u2229\u2261\u00b1\u2265\u2264\u2320\u2321\u00f7\u2248\u00b0\u2219\u00b7\u221a\u207f\u00b2\u25a0\u00a0"],
  ['x-cp720', "\u0080\u0081\u00e9\u00e2\u0084\u00e0\u0086\u00e7\u00ea\u00eb\u00e8\u00ef\u00ee\u008d\u008e\u008f\u0090\u0651\u0652\u00f4\u00a4\u0640\u00fb\u00f9\u0621\u0622\u0623\u0624\u00a3\u0625\u0626\u0627\u0628\u0629\u062a\u062b\u062c\u062d\u062e\u062f\u0630\u0631\u0632\u0633\u0634\u0635\u00ab\u00bb\u2591\u2592\u2593\u2502\u2524\u2561\u2562\u2556\u2555\u2563\u2551\u2557\u255d\u255c\u255b\u2510\u2514\u2534\u252c\u251c\u2500\u253c\u255e\u255f\u255a\u2554\u2569\u2566\u2560\u2550\u256c\u2567\u2568\u2564\u2565\u2559\u2558\u2552\u2553\u256b\u256a\u2518\u250c\u2588\u2584\u258c\u2590\u2580\u0636\u0637\u0638\u0639\u063a\u0641\u00b5\u0642\u0643\u0644\u0645\u0646\u0647\u0648\u0649\u064a\u2261\u064b\u064c\u064d\u064e\u064f\u0650\u2248\u00b0\u2219\u00b7\u221a\u207f\u00b2\u25a0\u00a0"],
  ['x-cp850', "\u00c7\u00fc\u00e9\u00e2\u00e4\u00e0\u00e5\u00e7\u00ea\u00eb\u00e8\u00ef\u00ee\u00ec\u00c4\u00c5\u00c9\u00e6\u00c6\u00f4\u00f6\u00f2\u00fb\u00f9\u00ff\u00d6\u00dc\u00f8\u00a3\u00d8\u00d7\u0192\u00e1\u00ed\u00f3\u00fa\u00f1\u00d1\u00aa\u00ba\u00bf\u00ae\u00ac\u00bd\u00bc\u00a1\u00ab\u00bb\u2591\u2592\u2593\u2502\u2524\u00c1\u00c2\u00c0\u00a9\u2563\u2551\u2557\u255d\u00a2\u00a5\u2510\u2514\u2534\u252c\u251c\u2500\u253c\u00e3\u00c3\u255a\u2554\u2569\u2566\u2560\u2550\u256c\u00a4\u00f0\u00d0\u00ca\u00cb\u00c8\u0131\u00cd\u00ce\u00cf\u2518\u250c\u2588\u2584\u00a6\u00cc\u2580\u00d3\u00df\u00d4\u00d2\u00f5\u00d5\u00b5\u00fe\u00de\u00da\u00db\u00d9\u00fd\u00dd\u00af\u00b4\u00ad\u00b1\u2017\u00be\u00b6\u00a7\u00f7\u00b8\u00b0\u00a8\u00b7\u00b9\u00b3\u00b2\u25a0\u00a0"],
]);

function decodeSbcs(u8, table) {
  let s = '';
  for (let i = 0; i < u8.length; i++) {
    const b = u8[i];
    s += b < 0x80 ? String.fromCharCode(b) : table[b - 0x80];
  }
  return s;
}

const decoders = new Map();
function getDecoder(label) {
  let d = decoders.get(label);
  if (!d) {
    d = new TextDecoder(label, { fatal: false });
    decoders.set(label, d);
  }
  return d;
}

/** Normalise a label such as "cp932", "windows1251", "932" or "shift_jis". */
export function resolveLabel(enc) {
  if (enc == null) return 'windows-1252';
  if (typeof enc === 'number') return codepageLabel(enc) || 'windows-1252';
  const s = String(enc).trim().toLowerCase();
  if (SBCS_TABLES.has(s)) return s;
  if (s === 'ibm437' || s === 'ibm850') return `x-cp${s.slice(3)}`;
  const m = /^(?:cp|windows-?|x-cp|ms|ibm)?(\d{3,5})$/.exec(s);
  if (m) return codepageLabel(Number(m[1])) || 'windows-1252';
  if (s === 'ucs2' || s === 'ucs-2' || s === 'utf16le' || s === 'utf-16le') return 'utf-16le';
  if (s === 'utf8') return 'utf-8';
  if (s === 'latin1' || s === 'binary' || s === 'ascii') return 'windows-1252';
  try {
    getDecoder(s);
    return s;
  } catch {
    return 'windows-1252';
  }
}

/** Decode bytes in a code page (number) or label (string). Never throws. */
export function decodeBytes(bytes, enc) {
  if (!bytes) return '';
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const label = resolveLabel(enc);
  if (SBCS_TABLES.has(label)) return decodeSbcs(u8, SBCS_TABLES.get(label));
  try {
    return getDecoder(label).decode(u8);
  } catch {
    return getDecoder('windows-1252').decode(u8);
  }
}

/** Font charset (RTF \fcharsetN) to Windows code page, per the RTF specification's charset table. */
export function charsetToCodepage(charset) {
  switch (charset) {
    case 0: return 1252; // ANSI
    case 1: return null; // DEFAULT: use the document default
    case 2: return null; // SYMBOL: not mapped; Symbol/Wingdings glyphs come out as their Latin byte values (known limit)
    case 77: return 10000; // Mac Roman
    case 128: return 932; // Shift JIS
    case 129: return 949; // Hangul
    case 130: return 1361; // Johab (not in the Encoding Standard; falls back)
    case 134: return 936; // GB2312
    case 136: return 950; // Big5
    case 161: return 1253; // Greek
    case 162: return 1254; // Turkish
    case 163: return 1258; // Vietnamese
    case 177: return 1255; // Hebrew
    case 178: return 1256; // Arabic
    case 186: return 1257; // Baltic
    case 204: return 1251; // Russian
    case 222: return 874; // Thai
    case 238: return 1250; // Eastern European
    case 254: return 437; // PC 437
    case 255: return 850; // OEM
    default: return null;
  }
}
