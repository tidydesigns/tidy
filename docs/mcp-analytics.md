# MCP service monitoring and optional account linking

Pinned `@posthog/mcp` manual capture emits one `$mcp_tool_call` event per registered
external tool invocation on `/api/mcp`, including failures returned as `isError`.
Internal agent tools, discovery and resource reads are not instrumented. There are
no wizard-generated schema changes, intent arguments or content capture.

## Data and purpose

Service monitoring measures call volume, failure rates, latency and app/client release
regressions so Tidy can operate the MCP service, diagnose compatibility and verify fixes. Successful calls
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
app release, normalized MCP client application name/version and linking status.
The SDK adds its static library/version/server markers.
It never receives tool input/output, client headers, prompts, credentials, raw
errors, account IDs or emails. Person processing and geolocation are disabled.
Browser profiles, replay, models, client fingerprints and conversations are absent.
Do not claim that removing account identifiers guarantees legal anonymisation:
timing and surrounding information can still carry identification risk.

### Harness diagnostics

`$mcp_client_name` is a fixed product label: `codex`, `claude_code`, `opencode`,
`pi`, `gemini_cli`, `other` (an unrecognised name), or `unknown` (not reported).
Exact aliases are maintained in `apps/web/lib/mcp/client-diagnostics.ts`; matching is
case-insensitive, never a substring guess. Add a reviewed alias when integrating
another client. Unknown clients retain access and their raw names are discarded.
`$mcp_client_version` is optional and only emitted for a recognised product:
bounded numeric releases and known prerelease channels are accepted; custom build
metadata, hashes, paths and free text are dropped. No title, model, installation
identifier, raw user agent, OAuth identifier or fingerprint is sent.

Identity comes from the SDK's current request envelope
(`io.modelcontextprotocol/clientInfo`), falling back to its initialized connection
identity when available. It is copied before execution and normalized again at the
outbound boundary. Names and versions always come from the same source. Concurrent
requests cannot overwrite another call's attribution.

**Coverage limit:** production uses `createMcpHandler` with a fresh server per HTTP
request. Clients using the 2025 protocol that identify themselves only in
`initialize` will produce `unknown` on subsequent tool calls. This change does not
introduce session tokens, a persistent identity cache, OAuth-name inference or
extra client parameters to fill that gap. Newer clients can report identity in
each request's protocol metadata. Report the `unknown`/`other` share alongside
failure rates by client/version; do not claim complete attribution. Identity is
self-reported and may describe a bridge rather than the underlying harness or model.

Both successes and failures carry these fields, including without account linking.
Compare event counts, failure rate and latency by `$mcp_client_name` and
`$mcp_client_version`; do not use the shared daily distinct ID as a user count.

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

The additional client product/version dimensions identify failures isolated to a
particular harness release. Tool-level totals cannot distinguish a client
compatibility regression from a Tidy regression. Product labels alone lose the
ability to isolate faulty releases, so bounded public release versions are also
included. Raw client identity strings, device fingerprints and account identity
are unnecessary for these comparisons and are excluded. This is the operator's
documented necessity/balancing assessment, not a legal determination: even limited
release metadata can increase correlation risk in small cohorts.

Users can reasonably expect limited server monitoring when requesting tools.
The balancing safeguards are restricted technical fields, shared daily identities,
no additional device probes or tracking storage, no content or profiling, a defined
90-day deletion-review schedule, restricted operator access and clear disclosure.
We treat any residual personal-data risk under GDPR rather than assuming the stream
is anonymous. The privacy notice provides an online contact for Article 21
objections; the operator must assess and act on valid objections. Do not treat the
absence of an optional toggle for baseline monitoring as removal of that right.

Account linking is an individually controllable consent purpose, off until chosen.
The combined Privacy choices dialog offers Accept all optional and Reject all
optional for the three browser purposes and MCP linking. Its first layer discloses
the account scope and 90-day duration. Accepting under older browser-only notices,
changing only browser purposes, or authorising OAuth access does not grant it.
A pre-authentication choice is stored against a hashed HttpOnly intent token and
can bind once to the next authenticated account. It retains its original expiry,
never overrides a newer account decision, and cannot apply to another account
later. The same mechanism records an explicit pre-authentication refusal. Expired
unclaimed decisions produce no telemetry-erasure jobs because no linked events
were sent. Browser consent notice version 6 and MCP notice version 4 require fresh acknowledgement.
This assessment applies only to the described
fields and purpose; adding identifiers, content or broader product analytics needs
reassessment before collection. Owner: the Tidy operator identified in the privacy
notice. Confirm these safeguards and provider arrangements before activation and
review the assessment if the processing changes.

Before rollout, review the actual protocol-metadata collection against Irish
ePrivacy Regulation 5(3)/(5), including whether any applicable access is strictly
necessary for the requested service. A normal protocol field, absence of cookies,
or a GDPR legitimate-interests basis does not itself establish an exemption.
Publish the matching privacy notice with the release. Account-linking notice
version 4 records the combined consent flow and requires a fresh opt-in before
these fields are linked to an account; previous choices fall back to unlinked monitoring and the existing
privacy cleanup process queues outdated consent IDs for erasure. Browser telemetry
fields stay the same, but the combined consent notice requires a fresh choice.
Apply the combined privacy migration described below before the matching app release.

References: [DPC lawful bases](https://www.dataprotection.ie/sites/default/files/uploads/2020-04/Guidance%20on%20Legal%20Bases.pdf),
[DPC cookies](https://www.dataprotection.ie/en/dpc-guidance/guidance-cookies-and-other-tracking-technologies),
[DPC objections](https://www.dataprotection.ie/en/individuals/know-your-rights/right-object-processing-personal-data-article-21-gdpr).
Additional references: [Irish ePrivacy Regulation 5](https://www.irishstatutebook.ie/eli/2011/si/336/),
[EDPB technical scope guidance](https://www.edpb.europa.eu/system/files/documents/2024-10/edpb_guidelines_202302_technical_scope_art_53_eprivacydirective_v2_en_0.pdf).

## Enable after review

1. Apply `20261016-mcp-analytics-consent.sql`, its runtime grants, and
   `20261021-combined-privacy-consent.sql` to the explicitly
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
   Opt in at Settings → Preferences → Privacy → Privacy choices using Accept all
   optional or Account-linked MCP diagnostics;
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
Harness tests cover real concurrent HTTP requests, with/without account linking,
successful/failed tools, tools without input schemas, spoofed metadata inside tool
arguments, legacy stateless fallback, unknown/custom clients and outbound payload
allowlisting in Bun and workerd. For deployment verification, use a labelled
temporary file and a client that sends per-request identity; check both a success
and a harmless expected failure in PostHog, plus an unidentified-client request.

SDK references: [TypeScript installation](https://posthog.com/docs/mcp-analytics/installation/typescript#custom-dispatchers),
[privacy controls](https://posthog.com/docs/mcp-analytics/privacy).
