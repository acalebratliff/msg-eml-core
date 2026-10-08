#!/usr/bin/env node
// Thin Node CLI for testing: msg2eml <in.msg> [out.eml] [--report out.json]
// Exit codes: 0 ok, 1 bad usage, 2 conversion error (message on stderr).
import { readFileSync, writeFileSync } from 'node:fs';
import { convertMsgToEml } from '../src/index.js';

const args = process.argv.slice(2);
let reportPath = null;
const ri = args.indexOf('--report');
if (ri >= 0) {
  reportPath = args[ri + 1];
  args.splice(ri, 2);
}
const opts = {};
for (const a of [...args]) {
  if (a.startsWith('--keep-rtf=')) { opts.keepRtf = a.split('=')[1]; args.splice(args.indexOf(a), 1); }
  else if (a.startsWith('--unresolved=')) { opts.unresolvedAddress = a.split('=')[1]; args.splice(args.indexOf(a), 1); }
  else if (a === '--utf8-headers') { opts.utf8Headers = true; args.splice(args.indexOf(a), 1); }
}
if (args.length < 1 || args.length > 2) {
  process.stderr.write('usage: msg2eml <in.msg> [out.eml] [--report report.json] [--keep-rtf=auto|always|never] [--unresolved=name-only|invalid-domain] [--utf8-headers]\n');
  process.exit(1);
}
const [input, output] = args;
try {
  const { eml, report } = convertMsgToEml(readFileSync(input), opts);
  if (output) writeFileSync(output, eml);
  else process.stdout.write(eml);
  if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2));
  for (const w of report.warnings) process.stderr.write(`warning: ${w}\n`);
} catch (e) {
  process.stderr.write(`error${e.code ? ` [${e.code}]` : ''}: ${e.message}\n`);
  if (reportPath) writeFileSync(reportPath, JSON.stringify({ error: { code: e.code || null, message: e.message } }, null, 2));
  process.exit(2);
}
