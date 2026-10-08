# Postgres migrations

Keep all database SQL changes in this directory. Existing `schema*.sql` files retain their original names and contents; the local database setup scripts list the order needed for their fixtures. Name new changes `YYYYMMDD-short-description.sql`, as with `20260928-file-multiplayer.sql`.

When adding a migration, update any local setup script or integration fixture that needs it and document any prerequisite migration. Do not run a migration against production without the approval required by `AGENTS.md`.

`20261005-connectors.sql` depends on `schema.sql` and `schema-organization.sql`. It adds encrypted personal connector accounts, organisation links, single-use OAuth states, webhook deduplication and external-operation records. Both local setup scripts include it.

`20261005-agent-threads.sql` requires the auth, organisation, design-file and design-folder schemas. It adds personal agent connections, shared threads, runs, worker identities, ordered events and tool receipts. The feature stays disabled until the migration and runner are configured. Run `bun test:agents` for a disposable local database test; production application requires separate approval.

`20261002-feedback-images.sql` depends on `schema.sql` and adds metadata for private R2 feedback images. Both local setup scripts include it.

`20261002-comment-thread-resolution.sql` depends on `schema-design-comments.sql` and keeps resolved threads in history while hiding canvas pins. Apply it before deploying comment resolution.

The performance rollout adds `20261003-design-object-storage.sql` (existing document/GitHub schemas), `20261003-file-thumbnails.sql` (object storage), and `20261003-editor-change-deltas.sql` (multiplayer). Apply them before deploying the corresponding app changes.

`20261003-plan-limits.sql` depends on organization billing, design/GitHub schemas, object storage and file thumbnails. It adds a configurable plan catalog and atomic file, editor and asset-storage gates. Register the real Pro Price before enforcing quotas for existing subscribers. Local initialization and multiplayer setup include it.

`20261006-mcp-call-limits.sql` requires `20261003-plan-limits.sql`. It adds Free (5,000) and Pro (100,000) monthly MCP call caps, per-workspace UTC calendar-month counters and atomic call reservations. Apply it before deploying MCP metering; production application requires separate approval. Counters start at zero. Local initialization and multiplayer setup include it.

## Runtime privileges

Use a separate non-administrative runtime login that owns no database objects.
After applying the schema, review [the runtime grant operation](operations/runtime-grants.sql)
against your database inventory. With the operator login, run it in a transaction
after setting `tidy.runtime_role` to the existing runtime role through
`SELECT set_config('tidy.runtime_role', '<runtime-role>', true)`. Roll back on any
failure. The operation never creates a login or rotates credentials, and it
rejects unreviewed schema drift. Production role changes require explicit approval.

Verify grants using the runtime login: application reads and intended writes
should work; protected catalog writes, DDL and TRUNCATE should fail. Tenant
authorization remains in application services; these grants do not isolate tenant
rows. Recheck the manifest when adding tables or sequences. Runtime needs explicit
grants for new objects, including the file-history sequence. Keep migration
credentials out of app bindings and native agent environments. Run
`bun run test:runtime:db` for the disposable restricted-login suite.
