# Desktop analytics v1

Desktop remains usable without an account or optional reporting. This implementation
adds explicit usage and diagnostic choices in desktop Settings → Privacy. Both start
off and expire after 90 days. Authentication and cloud sync do not enable them.

## Storage and PostHog

Detailed usage records stay in Tidy's first-party PostgreSQL database for 90 days;
technical records expire after 30 days. Queries exclude expired records immediately,
and the existing five-minute privacy maintenance removes them. The provider's
query window is not an erasure mechanism, so raw desktop activity is **not** sent to
PostHog. Keep storage maintenance enabled when stopping new collection.

The existing EU PostHog production project can receive optional aggregate exports.
They use daily service identifiers and contain no installation/account identifiers,
emails, content or raw diagnostic records. Product breakdowns require ten observed
installations/accounts; small return counts are suppressed. Download counters are
public release-file totals and have no such visitor threshold. Aggregate output
still needs an operator assessment of re-identification risk and the applicable
processor/transfer arrangements before enabling export. EU storage alone is not
a complete compliance assessment.

Raw reports are available through the read-only operator command below; small
cohorts intentionally remain absent from PostHog. Aggregate exports use the existing
project's storage rules, not the raw first-party expiry rules. Existing browser
analytics and MCP monitoring remain separate and retain their existing controls.

## Event definitions

`packages/design/analytics.ts` is the browser-safe, strict schema shared by native
capture and ingestion. Unknown event names/properties are rejected again at storage.

| Purpose     | Events                                                                                                                                       |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Usage       | `desktop_first_seen`, `product_active_day`, `harness_turn_started`, `harness_turn_finished`, `design_file_created`, `design_cloud_connected` |
| Diagnostics | `desktop_update_result`, `desktop_harness_update_result`, `desktop_sync_result`, `desktop_error`, `desktop_performance`                      |

The envelope contains a random delivery ID, event timestamp, app release, platform
and architecture. Event-specific fields are bounded enums. Prompts, responses,
designs, filenames/paths, credentials, terminal text, raw errors, device fingerprints
and memory dumps cannot enter this schema. No desktop replay or autocapture SDK is
installed. The renderer has no bearer token or arbitrary capture/network capability.

- `desktop_first_seen` means first observed use under a consent receipt, not an
  original installation. Changing choices resets this reporting identity.
- Activity reports are at most one per UTC day/version and represent foreground availability;
  background updater polling is excluded. They are not a measure of time spent or
  completed work. Windows left in the foreground can count on a new day.
- Harness starts follow accepted native launches; installed-CLI detection is not a
  run. Terminal results distinguish success, failure and cancellation.
- Design creation is counted after local persistence. Cloud publication is a separate
  event after the coordinator persists the acknowledged initial cloud connection.
  Retry/discovery of existing files does not generate another local creation.
  Direct filesystem writes by external agents are not attributed as UI creations.
- Sync reports are sampled state transitions, at most one per outcome per minute,
  not file/edit counts, failure-rate denominators or every polling request.
- Update completion is observed on a subsequent launch of the staged target version;
  requesting restart alone is not success. Delivery and crash coverage are best effort.
- Local diagnostics contain at most 100 reviewed error categories, rate-limited per
  operation, and are pruned at startup/hourly to the preceding seven days. Logs are
  not uploaded wholesale. Interaction timing observation starts after opt-in.

## Consent and identity

Native consent has a separate, random bearer receipt; only its hash is stored on
the server. The receipt stays in private app data with restrictive file permissions,
outside projects and the renderer. Optional batches are memory-only, bounded to
100 events and 24 hours, and delivered in batches of at most 25. They never block
design/harness operations. Changing consent clears pending captures immediately,
persists the local choice, and durably queues the old receipt for server erasure.
Offline erasure retries after reconnect/restart. Raw expiry still applies meanwhile.

Server ingestion serializes receipt changes and event writes, checks the current
notice/revision/expiry and independently gates each purpose. Delivery IDs deduplicate
retries. Rate limits and body limits apply before work is admitted. Guest receipts
can export or erase their own records without account creation; oversized exports
require operator assistance rather than silent truncation.

Linking is a separate, five-minute one-time browser confirmation. The browser shows
the account being linked and requires an authenticated, same-origin confirmation.
Native cloud credentials are not reused or given new telemetry scopes. Linkage is
prospective: earlier records stay unlinked, and no PostHog profiles are merged.
Diagnostic records never receive the account alias.

The revised web notice uses browser consent version 7. Existing browser-only
choices must be renewed; renewing them does not turn on desktop collection.

Consenting web activity is included in first-party cross-surface reports only for
an explicitly linked account and with a current browser usage receipt. Browser
withdrawal and first-party ingestion share the existing consent lock. First-party
account aliases never replace or silently merge legacy web PostHog identities.
Signing out/switching desktop cloud accounts rotates a linked native reporting
context. Unlinking through account privacy controls deletes linked raw activity;
account deletion cascades through the private account mapping. Local projects remain
untouched. Account and guest exports exclude receipt tokens and token hashes.

## Reports and dashboards

The read-only SQL definitions are in `apps/web/lib/analytics/reports.ts`. With an
explicit intended database connection, run:

```sh
DATABASE_URL='<explicit intended read-only connection>' bun apps/web/scripts/analytics-report.ts
```

The command opens a read-only transaction and emits aggregate JSON: activity by
surface/harness, D1/D7/D30 installation retention, weekly retention, combined linked
account retention, active versions, diagnostic categories and download snapshots/deltas.
Do not check output containing internal reporting data into Git.

Retention cohorts use first activity in the retained observation window, not signup
or original installation dates. Interpret only mature cohorts; a D30 cell before
day 30 is not a zero-retention result. Native receipts expire after 90 days and
choice/reset gaps limit long-term continuity. Installations, linked accounts, MCP
tool calls, sync transitions and file downloads are different units.

Daily PostHog exports support three event families:

| Event                         | Dashboard interpretation                                                                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `product_usage_aggregate`     | Snapshot of 90-day event and installation totals, by surface, metric and harness. Select a snapshot day; never sum repeated cumulative windows. |
| `product_retention_aggregate` | Cohort size and mature D1/D7/D30 returns. `linked_account` is a separate surface/unit. Null return counts are immature/suppressed, not zero.    |
| `desktop_download_aggregate`  | Cumulative installer/update file counters by release and snapshot day; derive daily deltas. `includes_automation=true`.                         |

Use a separate test project for synthetic provider verification. No production
PostHog project, dashboard or setting is changed by this branch. Configure charts
from these event families after rollout; native PostHog person-based retention is
not the source for these first-party cohort calculations.

## Download history

The scheduled job queries only the fixed public `tidydesigns/tidy` GitHub release
API, without user credentials. DMG and ZIP counts remain separate. Counter snapshots
retain 400 days and are not unique people, confirmed full transfers, installations
or successful updates. CI downloads its own assets for verification; counts include
that traffic and retries. Do not subtract an assumed fixed baseline.

Historical per-release totals are available, but daily changes start at the first
snapshot. No download-to-install fingerprint or attribution token is introduced.
The first version bounds discovery to three pages of 100 releases; review/extend
that bound before the repository exceeds that release history.

## Migration and rollout

1. Review the shared privacy-policy change and the desktop wording against the
   shipped behavior. Confirm controller/processor roles, lawful bases, rights,
   backup expiry/restore deletion handling, DPA/subprocessors, transfer safeguards
   and whether a DPIA is required. This code is not a legal compliance certification.
2. With explicit operator approval, apply `migrations/20261024-desktop-analytics.sql`
   after `20261021-combined-privacy-consent.sql`, then reapply the reviewed runtime
   grants. No migration is run automatically. Local setup/fixtures include it.
3. Configure `DESKTOP_ANALYTICS_STORAGE_ENABLED=1` on the web Worker. Confirm the
   existing privacy cron/secret and self-reference binding run successful expiry
   maintenance. The separate analytics maintenance job cannot prevent raw expiry
   if GitHub or PostHog is unavailable.
4. After testing and deployment approval, set `DESKTOP_ANALYTICS_ENABLED=1` to allow
   new guest consent and ingestion. Ship the desktop build with its choices off.
5. Optionally enable `DESKTOP_ANALYTICS_POSTHOG_AGGREGATES=1` after reviewing actual
   synthetic outbound payloads and configuring the existing EU PostHog host/key.
   Sparse cohorts stay available only in private first-party reports.

All switches default to off in `.env.example`. Turning collection off does not
disable existing receipt export/erasure. Do not turn storage off while retained
records still need expiry. No production SQL writes, deployment, processor setting
change or collection enablement has been performed as part of implementation.

Verification commands:

```sh
bun typecheck
bun lint
bun test
bun test:analytics:db
bun test:privacy:db
bun test:runtime:db
bun run audit:dependencies
WXT_BELLA_URL=https://extension-build.invalid bun run build
bun run --cwd apps/desktop test:security
```

The database suites own disposable local PostgreSQL clusters and use restricted
runtime roles. The reserved extension origin is solely for local build validation;
it is not a deployment target. Never enable test collection against production.
