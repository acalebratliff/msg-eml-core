# msg-eml-core

Convert Outlook `.msg` files to standards-correct `.eml` (RFC 5322 / MIME). A browser- and WebExtension-safe ES module, with a small CLI.

- Reads the `.msg` with [msgreader](https://github.com/HiraokaHyperTools/msgreader) (Apache-2.0) and decompresses RTF with [decompressrtf](https://github.com/HiraokaHyperTools/decompressrtf).
- Carries over headers, text and HTML bodies (including HTML held only inside RTF), inline images, attachments and embedded messages (recursively), calendar and contact items where present.
- Returns a report of everything it could not carry over, so a caller can show it rather than hide it.
- No network, no dependencies beyond the two readers.

## Use

```js
import { convertMsgToEml } from 'msg-eml-core';
const { eml, report } = convertMsgToEml(bytes);   // bytes: Uint8Array; eml: Uint8Array
```

CLI: `node cli/msg2eml.js in.msg out.eml`

## Tests

`npm test` runs the unit tests on synthetic fixtures. `qa/` holds the corpus comparison used before release (an independent reader and a headless Thunderbird check); see the scripts there.

## Status

Used by [MSG Opener for Thunderbird](https://github.com/acalebratliff/msg-for-thunderbird). Written and tested with AI assistance (Claude). The author reviews and publishes.

## Licence

Apache-2.0. Third-party notices in `NOTICE` and `THIRD_PARTY_LICENSES`.
