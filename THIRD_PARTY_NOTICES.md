# Third-party notices

Tidy is licensed under the [Apache License 2.0](LICENSE). Third-party code
and assets retain their original licenses and copyright notices.

- **Paper.js** and **Zod**: MIT. Full upstream license texts are retained at
  `licenses/bundled/Paper.js.txt` and `licenses/bundled/Zod.txt`.
- **React**, **React DOM** and **Scheduler**: MIT, copyright Meta Platforms, Inc.
  and affiliates. Their shared upstream license is retained at
  `licenses/bundled/React.txt`.

- **Iconoir** icons: MIT, copyright Iconoir contributors. The full license is
  retained at `apps/web/public/icons/LICENSE.iconoir`.
- **Instrument Serif**: SIL Open Font License 1.1, copyright the Instrument Serif
  Project Authors. Existing `OFL.txt` files accompany copies under `apps/web`,
  `apps/site` and `apps/extension`.
- **Instrument Sans**: SIL Open Font License 1.1, copyright the Instrument Sans
  Project Authors. Its license accompanies the site font as `OFL-InstrumentSans.txt`.
- Provider logos and names (Google, GitHub and Linear) identify integrations.
  Their owners retain trademark rights. Follow the attribution and source notes
  in `apps/web/public/connectors/README.md`; do not imply provider endorsement.
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
