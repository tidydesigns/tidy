# Tidy

Tidy is an open source canvas for designing interfaces together. Designers and
engineers can edit designs directly, while AI agents can read, create and edit
them in the same workspace.

[Try Tidy](https://app.tidydesign.co) · [Website](https://tidydesign.co) ·
[Changelog](https://tidydesign.co/changelog) · [Contribute](CONTRIBUTING.md)

[![Tidy's design canvas, editable layers and agent workflow](docs/demo/tidy-launch.gif)](docs/demo/tidy-launch.mp4)

Design interfaces, edit them with an agent and keep working on the same layers.
Click the preview to watch the full video with sound.

## What you can do

**Design interfaces.** Create and edit designs in a shared canvas.

**Work together.** Collaborate with teammates and see their presence in the workspace.

**Capture webpages.** Bring webpages into Tidy with the browser extension.

**Connect agents.** Let AI tools read, create and edit designs through MCP, a
protocol that connects agents to applications.

You can use the [hosted app](https://app.tidydesign.co), run Tidy locally or host
it on your own infrastructure.

## Local development

You'll need Bun 1.3.14, Git and Docker Compose. Database tests also require
PostgreSQL 17 command-line tools.

```sh
git clone https://github.com/tidydesigns/tidy.git
cd tidy

bun install --frozen-lockfile
docker compose up -d --wait
cp apps/web/.env.example apps/web/.env.local
```

In `apps/web/.env.local`, generate and set `BETTER_AUTH_SECRET` and a separate
`VAULT_ENCRYPTION_KEY`. The encryption key must be a base64-encoded, 32-byte value.

Password accounts require email verification. Before creating an account,
configure your own Cloudflare Email Sending token, account and sender. Disable
email previews that retain verification or password-reset links.

The [environment example](apps/web/.env.example) lists the available settings.
Social sign-in, connectors, analytics, billing and native agents are optional.

Start the app:

```sh
bun dev
```

In another terminal, start realtime collaboration:

```sh
bun dev:realtime
```

Open [localhost:3000](http://localhost:3000).

The local database runs on port `55432`. Fresh databases apply migrations
automatically. For an existing database, apply any missing files from
[`migrations/`](migrations/README.md). Use a development database and your own
provider accounts. Do not use a production database URL for local commands.

Stop the database with `docker compose down`. Adding `-v` also deletes its data.
See [self-hosting](#self-hosting) before making a deployment public.

## Importing Figma designs

On the Files screen or in a folder, choose **New file → Import from Figma…**
or drop a Figma Design `.fig` local copy. The dialog lets you choose the file
and select pages before creating a Tidy file in the current folder. Imported
files open immediately in the editor. To bring selected elements into an open
file, copy them in Figma and paste with the keyboard or Tidy's paste action.
No Figma plugin or account token is required.

The importer translates source records into editable native layers. It preserves
pages, hierarchy, paint order, supported vector geometry, images, text marks,
Auto Layout (including space-evenly), and resolvable component instances with overrides. Component masters
needed by a pasted instance live on an **Imported components** page. Color
variables become named snapshots; aliases and modes do not remain live bindings.

Alpha/luminance masks with supported vector sources or simple PNG image surfaces are
preserved as editable groups. Image masks use the original asset directly through
CSS masking, avoiding a second raster copy or per-frame image processing. Text
range bold, italic, underline and strikethrough marks remain editable.

This is a compatibility importer, not a guaranteed 1:1 round trip. Complex masks,
per-range font families/sizes/colors, complex component overrides/scales, variant axes, image crop transforms,
unsupported paints and effects can differ. Import notes identify approximations;
repeated notes are grouped. Fonts must be available to Tidy. FigJam and Slides are
not supported, and clipboard images without embedded bytes require a `.fig` copy.
The binary format is unofficial: decoder dependencies are pinned and regression
fixtures should be refreshed when Figma changes its exports.

Parsing runs in a disposable browser worker with a 20-second timeout. Limits are
32 MB input, 64 MB expanded data, 10,000 native layers, 100 images of up to 2 MB
and a 16 MB publication request. Documents retain the normal 5,000-unit layer
dimension ceiling. Oversized selections fail explicitly; choose fewer pages.
Published documents are bounded at 10 MB and pass the existing authorization,
asset quota and staged commit services. File publication uses one bounded staging
write rather than repeatedly rewriting a growing JSONB row. Off-screen free
frames use cached rendered overflow bounds for canvas culling; fonts and edits
invalidate those bounds conservatively.

For a database-free local prototype, run the web development server and open
`/dev/figma-import`. Use the Files creation menu to import a `.fig`, then open
the editor to paste native Figma elements.
The current draft, edits and image bytes are retained automatically in IndexedDB
and restored on reload. This is one local draft per browser origin; importing a
new file replaces it. The prototype route is unavailable in production builds.

Use `bun run test:figma:browser` against a local development server on port 3057
(or set `FIGMA_TEST_BASE_URL`). It checks real keyboard clipboard replay, native
hierarchy, source pixels, component dependency placement, undo/redo and recovery.
`bun run test:figma:publication:browser` uses an existing standalone build and owns
a disposable loopback PostgreSQL cluster. It checks authenticated import,
navigation, reload and access denial. PostgreSQL binaries must be on PATH, and
Node 22.18+ is required for the TypeScript publication runner. Run
`bun run test:files:db` for publication and folder permission regressions.
Optionally set `FIGMA_TEST_FILE` to a private multi-page design-system fixture
with over 5,000 layers to exercise the large-file checks in these suites. Keep it
outside the repository; browser screenshots and logs default to `/tmp`.

## Browser extension

The extension captures webpages for use in Tidy.

```sh
bun run build:extension
```

Open `chrome://extensions`, enable **Developer mode**, then choose
**Load unpacked** and select `apps/extension/.output/chrome-mv3`.

The extension connects to localhost by default. To build it for your own
deployment, set `WXT_BELLA_URL` to your app's HTTPS address.

Use `bun dev:extension` when developing the extension.

## Connect an agent

Tidy's MCP server lets agents work with the same files and designs you edit in
the canvas.

[Watch an agent edit a landing page](docs/demo/codex-canvas-teammate.mp4), with
its cursor visible on the canvas.

See the [agent plugin guide](apps/gpt-plugin/README.md) for setup, or the
[native runner guide](apps/web/agent-runner/README.md) for running agents
alongside Tidy.

## Self-hosting

Tidy's hosted architecture uses Cloudflare Workers, Hyperdrive for PostgreSQL
connections, private R2 storage, Images and Durable Objects for realtime
collaboration.

Copy `apps/web/wrangler.jsonc` to the ignored `apps/web/wrangler.deploy.jsonc`.
Configure your own Worker name, domain, database connection and storage bindings.
Set `WORKER_SELF_REFERENCE` to match the Worker name, and retain the Durable
Object bindings and migration tags.

Follow the [database setup guide](migrations/README.md). Apply the ordered
migrations and restricted runtime grants before starting the app. Use separate
database accounts for migrations and the running app.

Set `BETTER_AUTH_URL` to your app's HTTPS address. Use
[`apps/web/.env.example`](apps/web/.env.example) as the configuration reference,
and supply runtime settings and secrets through Cloudflare. Keep secrets out of
Wrangler files and `NEXT_PUBLIC_*` variables.

From the repository root:

```sh
bun run build:worker
TIDY_DEPLOY_CONFIG=./wrangler.deploy.jsonc bun run deploy:worker
```

The configuration path is relative to `apps/web`.

Use separate databases, storage and secrets for preview and production. Preserve
the authentication and encryption secrets when restoring an existing database.

Before accepting user data, test sign-in and workspace access with two users.
Node.js supports local development and bypasses some Worker-specific shared
rate limits. Public Node deployments need equivalent shared rate limits,
private storage and realtime transport.

## Contributing

Bug reports, documentation improvements and code contributions are welcome.
[Open an issue](https://github.com/tidydesigns/tidy/issues) to report a problem,
or read the [contribution guide](CONTRIBUTING.md) before opening a pull request.

Run workspace commands from the repository root:

```sh
bun typecheck
bun lint
bun test
bun run build
```

The contribution guide lists additional required checks. Database tests use
disposable PostgreSQL clusters and run separately; `bun test` skips those suites.
See [`package.json`](package.json) for available test commands.

### Repository layout

| Directory | Contents |
| --- | --- |
| `apps/web` | Canvas app, server and Cloudflare Worker |
| `apps/site` | Website and changelog |
| `apps/extension` | Webpage capture extension |
| `apps/gpt-plugin` | Agent plugin and design preview |
| `packages/design` | Shared design and capture formats |
| `packages/design-renderer` | Editor, preview and export rendering |
| `packages/ui` | Shared interface controls |

Use `bun dev:site` to run the website on port `3001`.

### MCP benchmarks

Run `bun run bench:mcp` to measure MCP request speed, throughput, database query
counts and response sizes against a disposable local database. These results
do not represent hosted Worker performance.

## Security

Please report vulnerabilities privately using the process in
[SECURITY.md](SECURITY.md). CI uses synthetic test data and a read-only token;
it does not deploy the app.

## License

Tidy is available under the [Apache License 2.0](LICENSE).

Bundled third-party assets retain their own licenses. See
[third-party notices](THIRD_PARTY_NOTICES.md).
