# Third-party notices

Tidy is licensed under the [Apache License 2.0](LICENSE). Third-party code
and assets retain their original licenses and copyright notices.

- **ghostty-web**, **Ghostty/libghostty-vt**, and **@lydell/node-pty**: MIT.
  Notices are retained in `licenses/bundled/ghostty-web.txt`, `Ghostty.txt` and
  `node-pty.txt`. Native PTY packages retain their bundled licences as well.

- **Paper.js** and **Zod**: MIT. Full upstream license texts are retained at
  `licenses/bundled/Paper.js.txt` and `licenses/bundled/Zod.txt`.
- **React**, **React DOM** and **Scheduler**: MIT, copyright Meta Platforms, Inc.
  and affiliates. Their shared upstream license is retained at
  `licenses/bundled/React.txt`.

- **fflate**, **fzstd** and **kiwi-schema**: MIT. Their upstream notices are
  retained in `licenses/bundled/fflate.txt`, `fzstd.txt` and `Kiwi.txt`.
- **openfig-core 0.4.1**: its package metadata declares MIT and names rcoenen
  as author. It omits a standalone license file; the declaration and MIT terms
  are retained in `licenses/bundled/OpenFig.txt`, with that limitation recorded.

- **pdf-lib**, **@pdf-lib/standard-fonts** and **@pdf-lib/upng**: MIT. Their upstream
  notices are retained in `licenses/bundled/`. **pako** retains its MIT and Zlib
  notices in `licenses/bundled/pako.txt`; **tslib** retains its 0BSD notice there.
- **ImageTracerJS**: Unlicense; retained in `licenses/bundled/imagetracerjs.txt`.
- **Iconoir** icons: MIT, copyright Iconoir contributors. The full license is
  retained at `apps/web/public/icons/LICENSE.iconoir` and beside the shared editor
  icons in `packages/editor/src/assets/icons/LICENSE.iconoir`.
- **Instrument Serif**: SIL Open Font License 1.1, copyright the Instrument Serif
  Project Authors. Existing `OFL.txt` files accompany copies under `apps/web`,
  `apps/site` and `apps/extension`. Shared offline fonts for desktop are accompanied
  by `packages/ui/fonts/OFL-InstrumentSerif.txt`.
- **Instrument Sans**: SIL Open Font License 1.1, copyright the Instrument Sans
  Project Authors. Its license accompanies the site font as `OFL-InstrumentSans.txt`
  and the shared offline font as `packages/ui/fonts/OFL-InstrumentSans.txt`.
- Provider logos and names (Google, GitHub, Linear, OpenAI, Codex, Claude and OpenCode) identify integrations.
  Their owners retain trademark rights. Follow the attribution and source notes
  in `apps/web/public/connectors/README.md` and `apps/web/public/agents/README.md`;
  desktop copies retain the notice in `packages/ui/harness-icons/README.md`,
  packaged as `licenses/harness-marks.txt`. Do not imply provider endorsement.
- **Simple Icons 16.35.0**: CC0-1.0. The package licence is retained at
  `licenses/bundled/simple-icons.txt`. Individual marks retain their applicable
  licences and trademark rights.
- **JavaScript logo**: MIT, copyright 2011 Christopher Williams. The full notice
  is retained at `licenses/bundled/javascript-logo.txt`.
- The desktop OpenAI mark in `apps/desktop/src/renderer/src/openai.svg` is sourced
  from Simple Icons 13.21.0 (`icons/openai.svg`), distributed under CC0-1.0.
  OpenAI retains its trademark rights; the mark identifies the connected provider.
- Tidy branding and application icons are project assets. The Apache License 2.0
  does not grant rights to Tidy trademarks.

Review notices whenever adding or replacing vendored fonts, icons, logos or code.

The code runtime, offline visual preview and plugin HTML include full applicable
licenses in JavaScript comments so they accompany standalone handoffs. Preview
notices are also readable outside the compressed runtime payload. These notices
cover runtime code; they do not license a user's design data or imported assets.

`scripts/bundle-licenses.ts` checks actual bundled modules against
`licenses/bundled/manifest.json` and their installed upstream license files.
Regeneration fails if a bundled dependency has no reviewed notice or its license
text changed. Update the retained text after reviewing an upstream license change.
