// Mutation fuzz over a local folder of .msg files, plus content-level fuzz
// on synthetic messages. Each file's mutations run in a child process with
// a hard timeout, so a hang shows up as a timeout.
//
// usage: node qa/fuzz-corpus.js <samples-dir> <mutations-per-file> [content-cases] > out.json
//
// Byte mutations (flips, int overwrites, truncation) find structural bugs;
// they cannot find slow parsing of well-formed but hostile *content*
// (review B2), so the content phase builds valid .msg files whose header,
// address, HTML, RTF and attachment fields are large runs drawn from
// characters that parsers treat specially.
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [dir, nArg, contentArg] = process.argv.slice(2);
const SLOW_MS = 2000;

function makeRnd(seedStr) {
  let seed = 0;
  for (const c of seedStr) seed = (seed * 31 + c.charCodeAt(0)) & 0x7fffffff;
  return (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
}

function runCase(convertMsgToEml, MsgError, input, res, label) {
  const t0 = Date.now();
  try { convertMsgToEml(input); res.ok++; } catch (e) {
    if (e instanceof MsgError) res.errors[e.code] = (res.errors[e.code] || 0) + 1;
    else res.unexpected.push(`${label}: ${String(e).slice(0, 200)}`);
  }
  const ms = Date.now() - t0;
  res.slowestMs = Math.max(res.slowestMs, ms);
  if (ms > SLOW_MS) res.slow.push({ label, ms });
}

if (process.env.FUZZ_CHILD) {
  const { convertMsgToEml, MsgError } = await import('../src/index.js');
  const res = { ok: 0, errors: {}, unexpected: [], slowestMs: 0, slow: [] };
  if (process.env.FUZZ_CHILD === 'content') {
    const { buildMsg, T } = await import('../test/helpers/build-msg.js');
    const rnd = makeRnd('content');
    const ALPHA = ['(', ')', '<', '>', '"', '\\', '=?', '?=', ',', ';', ':', '@', ' ', '\t', '\r\n', '\0', '{', '}', '\\u-1', "\\'", 'a', 'é', '用', '<meta ', 'charset=', 'cid:', '\\htmltag', '\\bin9 '];
    const blob = (n) => { let s = ''; const pick = ALPHA[rnd(ALPHA.length)]; const pick2 = ALPHA[rnd(ALPHA.length)]; while (s.length < n) s += rnd(4) ? pick : (rnd(2) ? pick2 : ALPHA[rnd(ALPHA.length)]); return s; };
    const rtfOf = (s) => { const body = Uint8Array.from([...s].map((c) => c.charCodeAt(0) & 0xff)); const u8 = new Uint8Array(16 + body.length); const dv = new DataView(u8.buffer); dv.setUint32(0, body.length + 12, true); dv.setUint32(4, body.length, true); dv.setUint32(8, 0x414c454d, true); u8.set(body, 16); return u8; };
    const HEADERS = ['From', 'To', 'Cc', 'Reply-To', 'Date', 'Message-ID', 'References', 'In-Reply-To', 'Subject', 'X-Any', 'Return-Path'];
    for (let k = 0; k < Number(contentArg || 0); k++) {
      const size = 50000 + rnd(400000);
      const kind = k % 6;
      const props = [[T.MESSAGE_CLASS, ['IPM.Note', 'IPM.Note.SMIME', 'IPM.Schedule.Meeting.Request', 'IPM.Contact'][rnd(4)]], [T.SUBMIT_TIME, new Date(1700000000000)]];
      const atts = [];
      const recips = [];
      if (kind === 0) props.push([T.TRANSPORT_HEADERS, `${HEADERS[rnd(HEADERS.length)]}: ${blob(size)}\r\n${HEADERS[rnd(HEADERS.length)]}: ${blob(1000)}\r\n\r\n`]);
      if (kind === 1) props.push([T.HTML, new TextEncoder().encode(blob(size))]);
      if (kind === 2) props.push([T.RTF_COMPRESSED, rtfOf(`{\\rtf1\\ansi${rnd(2) ? '\\fromhtml1 ' : ' '}${blob(size)}`)]);
      if (kind === 3) props.push([T.SENDER_NAME, blob(size)], [T.SENDER_SMTP, blob(2000)], [T.SUBJECT, blob(size)]);
      if (kind === 4) for (let r = 0; r < 20; r++) recips.push({ props: [[T.DISPLAY_NAME, blob(size / 20)], [T.EMAIL_ADDRESS, blob(500)], [T.RECIPIENT_TYPE, 1 + rnd(3)]] });
      if (kind === 5) {
        props.push([T.HTML, new TextEncoder().encode(blob(size / 2))]);
        for (let a = 0; a < 5; a++) atts.push({ props: [[T.ATTACH_METHOD, 1], [T.ATTACH_LONG_FILENAME, blob(5000)], [T.ATTACH_MIME, blob(500)], [T.ATTACH_CONTENT_ID, blob(2000)], [T.ATTACH_DATA, Uint8Array.from([0x30, 0x80, 6, 9])]] });
      }
      let msg;
      try { msg = buildMsg({ props, recipients: recips, attachments: atts }); } catch { continue; }
      runCase(convertMsgToEml, MsgError, msg, res, `content#${k} kind${kind} ${size}B`);
    }
  } else {
    const base = readFileSync(process.env.FUZZ_CHILD);
    const rnd = makeRnd(process.env.FUZZ_CHILD);
    for (let k = 0; k < Number(nArg); k++) {
      const m = new Uint8Array(base);
      const mode = k % 4;
      if (mode === 0) for (let f = 0; f < 1 + rnd(16); f++) m[rnd(m.length)] = rnd(256);
      else if (mode === 1) { const dv = new DataView(m.buffer); for (let f = 0; f < 4; f++) dv.setInt32(rnd(m.length - 4) & ~3, [-2, -1, 0, rnd(4096), 0x7fffffff][rnd(5)], true); }
      else if (mode === 2) { for (let f = 0; f < 64; f++) m[rnd(m.length)] ^= 1 << rnd(8); }
      const input = mode === 3 ? m.subarray(0, 512 + rnd(Math.max(1, m.length - 512))) : m;
      runCase(convertMsgToEml, MsgError, input, res, `mut#${k} mode${mode}`);
    }
  }
  process.stdout.write(JSON.stringify(res));
} else {
  const self = fileURLToPath(import.meta.url);
  const out = {};
  const jobs = readdirSync(dir).filter((x) => x.endsWith('.msg')).sort().map((f) => [f, `${dir}/${f}`]);
  if (Number(contentArg || 0) > 0) jobs.push(['(content fuzz)', 'content']);
  for (const [name, target] of jobs) {
    const r = spawnSync(process.execPath, [self, dir, nArg, contentArg || '0'], { env: { ...process.env, FUZZ_CHILD: target }, timeout: 600000, encoding: 'utf8', maxBuffer: 1 << 24 });
    out[name] = r.error ? { timeout: true, error: String(r.error) } : (r.status === 0 ? JSON.parse(r.stdout) : { crashed: r.status, stderr: r.stderr.slice(-400) });
  }
  const sum = { files: 0, cases: 0, ok: 0, msgErrors: 0, unexpected: 0, timeouts: 0, crashed: 0, slowestMs: 0, slowCases: 0 };
  for (const v of Object.values(out)) {
    sum.files++;
    if (v.timeout) { sum.timeouts++; continue; }
    if (v.crashed !== undefined) { sum.crashed++; continue; }
    sum.ok += v.ok; sum.msgErrors += Object.values(v.errors).reduce((a, b) => a + b, 0);
    sum.unexpected += v.unexpected.length; sum.slowestMs = Math.max(sum.slowestMs, v.slowestMs);
    sum.slowCases += v.slow.length;
  }
  sum.cases = sum.ok + sum.msgErrors + sum.unexpected;
  process.stdout.write(JSON.stringify({ summary: sum, perFile: out }, null, 1));
}
