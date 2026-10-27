# Website desktop demo

This entry renders the actual desktop `App`, shared editor, live design dock and
`ThreadDesignWindow` animation. Keep that UI and motion in the renderer; do not
create a second implementation here.

`host.ts` implements `DesktopAPI` with an in-memory sample project. Edits survive
thread/canvas navigation until reload. Agent replies are explicitly simulated.
No Electron preload, filesystem gateway, credentials, cloud connection or model
process is included. Unsupported host-only actions explain that they require the
installed app. Font selection uses the same allowlisted Google Fonts endpoints as
the desktop app; the initial sample uses bundled Instrument Sans.

From the repository root, `bun run dev:site` builds and copies the renderer before
starting Next. `bun run build:site` builds it through the explicit Turbo dependency.
The iframe loads near the viewport and receives same-origin theme messages.
With the website’s `scroll=website` option, ordinary vertical wheel gestures over
the thread preview scroll the website. Opening a canvas or app overlay restores
all native desktop scrolling, pan, zoom and panel behavior. Minimising the canvas
returns scrolling to the website. Pinch/modified wheel gestures remain native.
This relay only runs when embedded; the standalone renderer is unchanged. Its
canvas dialog stays inside the sample macOS window; the decorative traffic lights
sit above the iframe just as native window controls sit above Electron's renderer.

Generated `demo-dist` and `public/desktop-demo` directories are ignored. Re-run
`bunx turbo run build:demo --filter=@tidy/desktop` and
`node apps/site/scripts/copy-desktop-demo.mjs` after changing desktop source during
an existing site development session. Run host tests with
`bun test apps/desktop/src/website-demo/host.test.ts`.
