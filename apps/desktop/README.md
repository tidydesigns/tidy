# Tidy desktop

Standalone Electron application with a React and TypeScript renderer, built with
electron-vite. It runs independently of the Next.js web app and needs no database
or environment configuration. Its purpose is a local-first control pane for coding
harnesses, with Tidy's design canvas available for agents to design and iterate
before implementing UI.

This first scaffold includes the desktop runtime and branded React shell. Harness
connections, local document persistence and the editable canvas are not implemented
yet. These should share the existing document and canvas code rather than introduce
a separate desktop design format.

Use Bun 1.3.14 and Node.js 22.12+ (Node.js 24 recommended). From the repository root:

```sh
bun install --frozen-lockfile
bun dev:desktop
```

The development command starts the renderer on `127.0.0.1:5173` and opens Electron.
React changes update through Vite HMR. Restart the command after main process changes.

If an Electron-based terminal host sets `ELECTRON_RUN_AS_NODE=1`, clear that variable
before launching the app (on macOS/Linux: `env -u ELECTRON_RUN_AS_NODE bun dev:desktop`).

```sh
bun run build:desktop      # Compile into apps/desktop/out
bun run start:desktop      # Open the compiled app
bun run package:desktop    # Create an unpacked app in apps/desktop/release
```

Packaging uses Electron Packager to create an unsigned app for the current platform
and architecture. It stages only compiled output, package metadata and licence
notices; source code and local environment files are excluded. Packaging is separate
from the monorepo build. Release icons, installers, signing and notarization can be
configured when distribution is needed.

`src/main/index.ts` owns the native window and application lifecycle.
`src/renderer/` contains the browser-only React interface. The renderer is sandboxed,
with context isolation and no Node.js integration. Navigation, new windows and
permissions are denied. No preload bridge or IPC is exposed; add narrowly scoped,
typed APIs when a desktop feature needs native access. Keep database access and
server credentials in `apps/web`.

The root `bun typecheck`, `bun lint` and `bun run build` commands include this app.
Renderer bundles carry the repository's reviewed third-party licence notices;
packaged apps also include the project licence, bundled notices and font licences.

## Shared foundations

- Branding uses the same `TidyLogo` from `@tidy/ui/tidy-logo` as the web app.
  `@tidy/ui/fonts.css` bundles the existing Instrument Sans and Instrument Serif
  fonts locally, including their OFL licences. The interface uses Instrument Sans;
  the Tidy wordmark uses Instrument Serif. No network font requests are needed.
- `@bella/design` owns the browser-safe design document model and operations.
- `@tidy/design-renderer` owns the shared canvas rendering used by the web app.
  The full editing interactions currently live in `apps/web` and need extraction
  into a shared browser-safe package before the desktop editor can reuse them.
- Local workspace storage and coding harness processes belong in the Electron main
  process, exposed through narrow, validated preload APIs. The React renderer must
  not receive unrestricted filesystem, process execution or IPC access.
- A local document should be the source of truth for both canvas edits and agent
  changes. Cloud accounts and network services should remain optional; web sharing
  can synchronize documents without becoming a prerequisite for local design work.
