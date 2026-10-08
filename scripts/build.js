// Build the browser / WebExtension bundle with esbuild.
// iconv-lite (used by msgreader for ANSI strings) is replaced by
// src/iconv-shim.js, which uses the WHATWG Encoding API, so the bundle needs
// no Node Buffer polyfill.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('..', import.meta.url));
const shim = fileURLToPath(new URL('../src/iconv-shim.js', import.meta.url));
const banner = `/*! msg-eml-core | Apache-2.0 | Copyright 2026 A. Caleb Ratliff
 * Includes @kenjiuno/msgreader (Apache-2.0, Copyright 2019 HIRAOKA HYPERS TOOLS, Inc.,
 * Copyright 2016 Yury Karpovich, kenjiuno)
 * and @kenjiuno/decompressrtf (BSD-2-Clause, Copyright (c) 2019, kenjiuno).
 * See NOTICE and THIRD_PARTY_LICENSES for the full licence texts.
 */`;
const outs = [];
for (const minify of [false, true]) {
  const outfile = `${root}dist/msg-eml-core${minify ? '.min' : ''}.js`;
  await build({
    entryPoints: [`${root}src/index.js`],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2020', 'firefox115'],
    minify,
    legalComments: 'eof',
    banner: { js: banner },
    alias: { 'iconv-lite': shim },
    outfile,
    logLevel: 'warning',
  });
  outs.push(outfile);
}
for (const f of outs) {
  const buf = readFileSync(f);
  console.log(`${f.replace(root, '')}: ${statSync(f).size} bytes, ${gzipSync(buf).length} gzipped`);
}
