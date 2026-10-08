# Tidy GPT plugin

The ChatGPT plugin UI and installable package live here. Authentication, database
access and MCP tools remain in `apps/web`. It uses the same accounts, organizations,
files and document revisions as the editor and browser extension.

The UI shows a saved design, lets users switch between visible frames/components,
refreshes through MCP, and opens the editable file in Tidy. Frame selection updates
the model's context. Edits use the existing authoring/import and revisioned patch
tools; there is no second document store or additional model API dependency.

## Development

From the repository root:

```sh
bun install
bun build:gpt-plugin
bun dev:gpt-plugin
```

Open `http://127.0.0.1:3102/` for the local MCP Apps host simulator. It uses sample
data and exercises model updates, refresh, frame selection and theme changes.
The `/widget` endpoint rebuilds the bundle on each load. Set `GPT_PLUGIN_PORT`
to change the port. This harness does not connect to a database or authenticate
with ChatGPT.

With the preview server running:

```sh
bun run --cwd apps/gpt-plugin test:browser
```

Browser checks use Playwright Chromium and write screenshots to `.artifacts/gpt-plugin/`.
Run `bunx playwright install chromium` from this workspace if Chromium is missing.
Run the usual root `bun typecheck`, `bun lint`, `bun test`, and `bun run build`
for workspace validation.

## Connect to ChatGPT

1. Build and run the web app against a nonproduction database, using the normal
   local setup. All existing MCP/OAuth migrations must already be applied there.
2. Expose the web app through a development HTTPS tunnel. Set
   `apps/web/.env.local`'s `BETTER_AUTH_URL` to that same externally reachable origin
   so OAuth discovery and the resource audience agree. Keep production credentials
   out of this environment.
3. In ChatGPT, enable developer mode in **Settings → Security and login** if your
   account/workspace allows it. Add the tunnel's `/api/mcp` URL in **Plugins** and
   complete Tidy sign-in and consent. A normal logged-in browser session alone is
   not enough for MCP authorization.
4. Ask ChatGPT to create a screen in Tidy and call `preview_design` after committing
   it. For example: “Create an onboarding screen in Tidy and show it here.”
5. Check follow-up edits, frame selection, refresh, and **Open in Tidy**. After tool
   or UI changes, refresh the MCP connection metadata and start a new conversation.

See [OpenAI's connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt)
and [MCP Apps UI guide](https://developers.openai.com/plugins/build/chatgpt-ui).

## Build and deploy

`bun build:gpt-plugin` emits a self-contained HTML bundle and a generated JS module
at `dist/widget.js`. `apps/web` imports that module and serves its HTML through
`resources/read` using `text/html;profile=mcp-app`. The resource URI includes a
content hash, so changed bundles cannot reuse an old cached UI.

Turborepo builds the plugin before the web app, including before web typechecks,
tests and development. The direct Worker build script also builds it first.
Everything deploys with the existing web Worker; there is no separate plugin
server. Browser-safe layout, paint, text, image and variant rendering live in
`packages/design-renderer`; controls live in `packages/ui`. The existing editor,
thumbnails, GitHub snapshots, exported React runtime, and plugin use those sources.

Private asset bytes are authorized server-side and delivered only in tool-result
`_meta`, as data URLs. The widget does not fetch session-cookie-protected assets or
receive OAuth tokens. Model-visible results contain the file URL, revision and
root metadata. Fonts use the existing curated Google Fonts catalog; local fonts
need a fallback in the sandbox. Preview assets share the existing export limit
of 12 MB per request; oversized or inaccessible assets produce an explicit error.
The rendered preview is visible to the user, not an image supplied to the model.

## Installable package

```sh
bun zip:gpt-plugin
```

This creates `apps/gpt-plugin/dist/tidy-plugin.zip` containing `plugin.json`,
`mcp.json`, the design workflow skill, and brand assets. Source code, bundles,
credentials, and local environment files are excluded. The package points to
`https://app.tidydesign.co/api/mcp`. To use an alternate deployment,
change the packaged `mcp.json` URL to its `/api/mcp` endpoint.
