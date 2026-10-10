- Always implement changes in a new conventionally named branch and worktree based on the latest `main`, and symlink `apps/web/.env.local` from the primary checkout into the worktree.
- Keep Git history linear; never create merge commits.
- Keep separate commits on pull request branches. Add follow-up changes as new commits instead of amending or squashing published commits. Squash only when merging the pull request into its target branch.
- Rebase branches onto the latest target branch when needed. If a rebase rewrites a published branch, use `--force-with-lease`; do not force-push merely to keep a pull request at one commit.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Monorepo

- The Next.js app and its `node_modules/next/dist/docs/` are in `apps/web`. Resolve the Next.js documentation rule above from that workspace.
- Run workspace commands from the repository root: `bun typecheck`, `bun lint`, `bun test`, `bun run build`.
- The WXT extension is in `apps/extension`; browser-safe schemas are in `packages/design`. Keep server code, database access, and credentials in `apps/web`.
- Environment files belong to the app that consumes them, such as `apps/web/.env.local`.
- Put all new Postgres migration SQL files in `migrations/`; do not add SQL files at the repository root. Update local setup scripts and documentation when adding a migration.

## Database and deployment safety

- PostgreSQL migrations live in `migrations/`; keep operator credentials separate from runtime credentials.
- Keep diagnostics read-only. Never infer production targets from repository examples.
- Obtain explicit approval before production SQL writes, schema/role changes, deployments, restores, credential rotation or network changes.
- Use the operator's private `wrangler.deploy.jsonc` and their explicit database target for production operations.
- Do not commit credentials, real deployment bindings, customer records or internal incident reports.

## UX

- Check for existing custom UI components and reuse them instead of native controls, including `SelectMenu` for dropdowns.
- Build minimal interfaces for designers: use purposeful labels and functional controls; omit redundant headings and UI fluff.
- Show panels only when they contain actionable content; collapse empty panels instead of reserving space for instructional messages.
- Use progressive disclosure for secondary lists and imported details: collapse them by default and bound expanded content so primary work areas such as layers and tokens remain usable at smaller viewport heights.
- Give each action or destination one UI home; do not duplicate it across menus, panels, or buttons.
- Implement only requested interactions; do not infer extra behavior from the presence of a UI element.
- No save buttons anywhere.
- Apply each interaction immediately; avoid delayed cleanup or refreshes that undo the user's next action, and update only the affected UI.
- Keep file and folder hover states subtle, using light surfaces and grey borders instead of dark outlines.
- For in-page disclosures such as folder expansion, preload the contents and toggle them instantly; avoid click-time loading states and flashes.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
