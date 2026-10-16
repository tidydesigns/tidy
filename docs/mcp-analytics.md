# Optional MCP analytics

Tidy uses pinned `@posthog/mcp` manual capture with the existing PostHog project
token and ingestion host. It emits `$mcp_tool_call` events for registered tools
on `/api/mcp`, including failures returned as `isError`. Internal agent tools,
discovery and resource reads are not instrumented. There is no wizard-generated
schema modification or content capture.

## Enable after review

1. Apply `20261016-mcp-analytics-consent.sql` and the runtime grants manifest to
   the explicitly approved database. Production changes require separate approval.
2. Verify `NEXT_PUBLIC_POSTHOG_KEY` and `NEXT_PUBLIC_POSTHOG_HOST` target the intended
   project (hosted Tidy: project 289840, EU Cloud). Local development credentials
   may target a different project; do not copy them into production. A project ID is not an ingestion
   credential. No private API key is needed to collect events.
3. Deploy the matching policy and controls, then set `POSTHOG_MCP_ANALYTICS_ENABLED=1`
   in the Worker runtime. It defaults off; an explicit runtime `0` overrides the
   environment fallback. Browser collection and server error switches are independent.
4. Opt in with a test account in Settings → Preferences → Privacy → MCP usage analytics.
   Invoke a tool and inspect `$mcp_tool_call` events in PostHog. Check a rejected
   account produces no events. The preference remains accessible on the account
   page for users without an organisation.

The SDK is used only to construct the event. It never receives tool input/output,
client headers, prompts, OAuth tokens or errors. The outbound hook rebuilds the
envelope from tool name, timestamp, duration, failure flag/category, app version
and a random consent identifier. Person processing and geolocation are disabled;
browser profiles and replay are not linked. There is no intent, model, client
fingerprinting or conversation collection. No unknown tool names are reported.

An account must explicitly opt in; browser consent and OAuth access grants do not
qualify. The original decision is checked before the tool and retained through
bounded delivery after execution. Withdrawal/re-opt-in cannot authorise an older
in-flight call. The Worker uses `waitUntil` with a request-local SDK client, no
retries and bounded shutdown. A consent/transport failure cannot fail the tool.

## Retention and erasure

Consent lasts 90 days. Expiry/version changes, withdrawal and account deletion
queue the dedicated `mcp:<consent UUID>` identifiers in the existing `posthog-review`
outbox. Re-opt-in uses a new identifier. Consent evidence is included in account
exports, cascades on account deletion and expires after one year.

The existing privacy cleanup cron must run and the operator must process its
pending reviews promptly. Follow the existing `privacy-posthog-review.ts` workflow
to verify erasure of **events**, not just person profiles (MCP does not create
profiles). Record provider completion only after verification. These jobs do not
automatically delete PostHog events or guarantee a 90-day provider deletion time.
Do not enable collection without an operational review/deletion process. Existing
PostHog DPA, EU Cloud and transfer disclosures also apply to these events.

## Verification

Run `bun typecheck`, `bun lint`, `bun test`, `bun test:privacy:db` and `bun run build`.
Run `bun apps/web/scripts/test-mcp-analytics-worker.mjs` to check the SDK transport
in workerd with synthetic credentials and an intercepted outbound service.
The privacy database suite creates its own disposable local cluster. Unit tests
inspect actual SDK payloads using a mocked transport, and exercise rejected,
withdrawn, renewed and failed calls without production requests.

References: [TypeScript SDK](https://posthog.com/docs/mcp-analytics/installation/typescript#custom-dispatchers),
[privacy controls](https://posthog.com/docs/mcp-analytics/privacy).
