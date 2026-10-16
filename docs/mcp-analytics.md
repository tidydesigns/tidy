# MCP service monitoring and optional account linking

Pinned `@posthog/mcp` manual capture emits one `$mcp_tool_call` event per registered
external tool invocation on `/api/mcp`, including failures returned as `isError`.
Internal agent tools, discovery and resource reads are not instrumented. There are
no wizard-generated schema changes, intent arguments or content capture.

## Data and purpose

Service monitoring measures call volume, failure rates, latency and release
regressions so Tidy can operate the MCP service and verify fixes. Successful calls
provide failure-rate denominators. This stream is not for advertising, behavioural
profiling or cross-product engagement analysis.

Without account-linking consent, all calls on a UTC day use the same
`mcp:service:YYYY-MM-DD` identifier and minute-rounded timestamps. Tidy stores no
mapping from these events to accounts. With consent, an event instead uses
`mcp:<consent UUID>` and the original timestamp; Tidy can resolve that identifier
through the consent record. `$mcp_account_linked` distinguishes the two forms.
**Count events, not distinct IDs, users or sessions** for service metrics: the
shared identifier is not a visitor, and opt-in does not produce a second event.

The outbound hook allows only tool name, timestamp, duration, failure flag/category,
release and linking status. The SDK adds its static library/version/server markers.
It never receives tool input/output, client headers, prompts, credentials, raw
errors, account IDs or emails. Person processing and geolocation are disabled.
Browser profiles, replay, models, client fingerprints and conversations are absent.
Do not claim that removing account identifiers guarantees legal anonymisation:
timing and surrounding information can still carry identification risk.

## Lawful-basis assessment

The baseline uses GDPR Article 6(1)(f), legitimate interests. Its specific interest
is reliable delivery of the requested MCP service. Per-tool outcomes and timings
locate failures and latency regressions that infrastructure-level errors alone
miss; successful calls are needed to measure the rate of failure. Simple aggregate
counters alone lose latency distributions. Precomputed histograms are an alternative, but
fix their time windows and dimensions in advance; the limited observations here
support exact percentile and release/window comparisons without account identity.
Account identification is not necessary for that baseline and is therefore omitted. Minute-rounded times
reduce correlation while preserving operational comparisons.

Users can reasonably expect limited server monitoring when requesting tools.
The balancing safeguards are restricted technical fields, shared daily identities,
no device storage/access added for tracking, no content or profiling, a defined
90-day deletion-review schedule, restricted operator access and clear disclosure.
We treat any residual personal-data risk under GDPR rather than assuming the stream
is anonymous. The privacy notice provides an online contact for Article 21
objections; the operator must assess and act on valid objections. Do not treat the
absence of an optional toggle for baseline monitoring as removal of that right.

Account linking is a separate consent purpose, off by default. Browser consent and
OAuth grants do not authorise it. This assessment applies only to the described
fields and purpose; adding identifiers, content or broader product analytics needs
reassessment before collection. Owner: the Tidy operator identified in the privacy
notice. Confirm these safeguards and provider arrangements before activation and
review the assessment if the processing changes.

References: [DPC lawful bases](https://www.dataprotection.ie/sites/default/files/uploads/2020-04/Guidance%20on%20Legal%20Bases.pdf),
[DPC cookies](https://www.dataprotection.ie/en/dpc-guidance/guidance-cookies-and-other-tracking-technologies),
[DPC objections](https://www.dataprotection.ie/en/individuals/know-your-rights/right-object-processing-personal-data-article-21-gdpr).

## Enable after review

1. Apply `20261016-mcp-analytics-consent.sql` and runtime grants to the explicitly
   approved database **before deploying the app**. Production changes need separate
   approval. Both local setup scripts and account fixtures include the migration.
2. Verify the ingestion key/host target project 289840 on EU Cloud. Local credentials
   may target a different project. Do not copy them into production. No private API
   key is required for collection. Confirm the existing DPA and transfer arrangements.
3. Assign an operator to process provider-erasure reviews and objections. Confirm
   event deletion works for shared daily IDs and consent IDs **without person
   profiles**, including provider assistance if required. Do not activate until this
   operational process is available. A PostHog event query window is not a deletion TTL.
4. Deploy the matching notice and controls, then set `POSTHOG_MCP_ANALYTICS_ENABLED=1`
   in the Worker runtime. The global rollout switch defaults off and runtime `0`
   overrides its environment fallback. Browser/error switches remain independent.
5. Check a test account with linking Off produces one unlinked event per tool call.
   Opt in at Settings → Preferences → Privacy → Link MCP monitoring to my account;
   subsequent calls should carry the consent ID. Turn it off and verify service
   monitoring continues without that identifier. Users without an organisation have
   the same control on their account privacy page.

## Delivery, retention and erasure

The initial linking lookup has a 500 ms cancellation budget. Unavailable, missing,
expired or withdrawn consent falls back to unlinked monitoring. The original
consent is rechecked under a database lock through bounded delivery after tool
execution. Re-opt-in cannot link an earlier in-flight call. A send that already
started is never retried as an unlinked event, preventing double-counting.

Before any unlinked event is sent, Tidy registers a deterministic daily erasure job
in the existing `privacyCleanup` outbox. Concurrent calls deduplicate that job; it
becomes due 90 days after the UTC day begins. A failed retention registration skips
that metric rather than sending an event without a deletion schedule. This is
best-effort telemetry, not an audit ledger or guaranteed complete billing record.

Linking consent expires after 90 days. Expiry, outdated notices, withdrawal and
account deletion queue the consent IDs for provider erasure. Re-opt-in rotates the
ID. Exports include consent evidence; it cascades on account deletion and expires
after one year. Historical versions are never interpreted as the new linking choice.

The privacy cleanup cron must run. Use `privacy-posthog-review.ts list` to inspect
jobs (due/review jobs appear before future schedules). The Tidy operator must
process due reviews promptly, verify deletion of **events**, then record completion
with `complete <job-uuid> <evidence-reference> --verified`. Do not mark future
retention jobs complete before their day has expired. Scheduling does not itself
delete provider events or guarantee physical deletion on day 90. Neither a missing
person profile nor resolving a PostHog error issue proves event erasure.

The Worker uses `waitUntil`, isolated SDK clients, no retries and bounded shutdown.
Responses do not wait for outbound delivery; monitoring failures cannot fail tools.
The global off switch performs no monitoring database queries. With it on, calls
use one indexed consent lookup; unlinked delivery adds a background idempotent
outbox insert, while linked delivery checks consent transactionally.

## Verification

Run `bun typecheck`, `bun lint`, `bun test`, `bun test:privacy:db`,
`bun test:account-controls`, `bun test:mcp:db` and the production builds.
`bun apps/web/scripts/test-mcp-analytics-worker.mjs` exercises real SDK transport
in workerd with synthetic credentials and intercepted outbound requests. Database
suites use disposable local clusters. Tests cover rejected/withdrawn/renewed consent,
metadata envelopes, retention scheduling and no duplicate fallback after a send.

SDK references: [TypeScript installation](https://posthog.com/docs/mcp-analytics/installation/typescript#custom-dispatchers),
[privacy controls](https://posthog.com/docs/mcp-analytics/privacy).
