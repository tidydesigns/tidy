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
rows. Recheck the manifest when adding tables or sequences. The operation also sets runtime defaults of 8 seconds per statement, 3 seconds
waiting for locks, and 30 seconds idle in a transaction. Review those values against
legitimate workload latency before production approval; reconnect pooled origin
sessions and verify the settings through Hyperdrive after applying them. Operator
connections keep their own settings. Runtime needs explicit
grants for new objects, including the file-history sequence. Keep migration
credentials out of app bindings and native agent environments. Run
`bun run test:runtime:db` for the disposable restricted-login suite.

## Collaboration event performance

`20261010-document-event-performance.sql` replaces the collaboration event
function after `20260928-file-multiplayer.sql`. It retains the same event and
property-path semantics, skips unchanged recursive branches, and writes changed
paths in one statement. JIT is disabled only within this short-lived trigger to
avoid recursive-plan compilation overhead on LLVM-enabled PostgreSQL; the caller's
setting is restored on return. Fresh local databases apply it automatically; existing
local databases must apply it before measuring phase-three database improvements.
Production application still requires an explicitly approved target and operation.

## Account privacy

`20261011-account-privacy.sql` follows the existing migrations. It adds anonymous
shared-work attribution, the durable external-erasure outbox, and consent-independent
feedback submissions. Reapply the runtime grant manifest after applying it to an
explicitly approved target.

## Analytics consent

`20261015-analytics-consent.sql` follows `20261011-account-privacy.sql`. It adds
versioned consent decisions, an external-erasure review job type and minimal
operator completion receipts. Apply it before deploying the PostHog restart code,
then reapply the runtime grants manifest. Local initialization includes it; no
production migration is automatic.

## MCP analytics consent

`20261016-mcp-analytics-consent.sql` follows `20261015-analytics-consent.sql`.
It adds consent decisions for optional MCP account linking, defaulting to off.
Service monitoring without account identifiers is independent of this choice.
Apply it before deploying the app changes and reapply the runtime grant manifest.
Both local setup scripts include it. Run `bun test:privacy:db` to verify consent,
expiry, withdrawal and deletion with a disposable database. Production migration
and deployment require separate approval. See [MCP analytics](../docs/mcp-analytics.md).

## File history capacity

`20261017-file-history-capacity.sql` follows the file-version and account-privacy
migrations. Apply it and the updated runtime-grant manifest before deploying the
history capacity changes. It backfills logical-byte and version-count accounting
without deleting existing versions. Each file is limited to 200 versions and
128 MB; each workspace to 1 GB of historical document JSON including per-row
allowance. These are safety limits, independent of the R2 storage plan.

Admissions replace the oldest automatic and pre-restore checkpoints when needed
for the file or workspace allowance. Named checkpoints are never pruned. The
active restore target and its new safety checkpoint are protected until commit.
Each admission prunes at most 200 versions and skips other files currently locked
by an editor; it may temporarily reject a checkpoint or skip an automatic one if
capacity cannot safely be made available. Normal document edits still continue.

The migration itself preserves existing versions. Older automatic/pre-restore
history can be replaced on subsequent writes, including in existing over-limit
workspaces. Restore receipts and asset references follow the lifetime of their
versions. If named checkpoints alone fill the allowance, new checkpoints and
restores return a capacity error; increasing the allowance or explicitly removing
named history requires a separate product/operator decision. Run
`bun test:versions:db` and `bun test:runtime:db` using disposable local fixtures.
Production migration requires explicit approval.
