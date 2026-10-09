# msg-eml-core

Convert Outlook `.msg` files to standard `.eml` messages (RFC 5322 / MIME). A browser- and WebExtension-safe ES module, with a small CLI.

- Reads the `.msg` with [msgreader](https://github.com/HiraokaHyperTools/msgreader) (Apache-2.0) and decompresses RTF with [decompressrtf](https://github.com/HiraokaHyperTools/decompressrtf).
- Carries over headers, text and HTML bodies (including HTML held only inside RTF), inline images, attachments and embedded messages (recursively), calendar and contact items where present.
- Returns a report of everything it could not carry over, so a caller can show it to the user.
- No network, no dependencies beyond the two readers.

## Use

```js
import { convertMsgToEml } from 'msg-eml-core';
const { eml, report } = convertMsgToEml(bytes);   // bytes: Uint8Array; eml: Uint8Array
```

CLI: `node cli/msg2eml.js in.msg out.eml`

## Tests

`npm test` runs the unit tests on synthetic fixtures. `qa/` holds the corpus comparison used before release (an independent reader and a headless Thunderbird check); see the scripts there. On a 65-file public and synthetic corpus, 63 files converted and the 2 damaged files were refused with a message.

## Limitations

- A body that is true RTF comes out as plain text, with the original attached as `body.rtf`.
- A sender or recipient with no email address in the file gets a placeholder address ending in `@unresolved.invalid` (or the name only, with the `unresolvedAddress: 'name-only'` option).
- A file with no date gets no Date header.
- Encrypted (S/MIME) `.msg` files have not been tested. Outlook `.olm` and `.pst` files are not supported.

## Status

Used by [MSG Opener for Thunderbird](https://github.com/acalebratliff/msg-for-thunderbird). Written and tested with AI assistance (Claude). The author reviews and publishes.

## Licence

Apache-2.0. Third-party notices in `NOTICE` and `THIRD_PARTY_LICENSES`.
