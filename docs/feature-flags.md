# Optional interface rollouts

These PostHog boolean flags default to off:

| Key                   | Interface                                                                 |
| --------------------- | ------------------------------------------------------------------------- |
| `mcp-pi-gemini`       | Pi, Gemini CLI and Other MCP client options and setup instructions in MCP |
| `github-connector`    | GitHub connector settings and file pull-request reviews                   |
| `settings-connectors` | The settings Connectors tab, including Linear                             |

GitHub settings require both `settings-connectors` and `github-connector`.
The editor's pull-request UI requires `github-connector`; its settings link also
requires `settings-connectors`. GitHub sign-in is independent of the connector.

Tidy evaluates these flags on the server through PostHog's `/flags/?v=2` API.
Requests contain only the project token, these three keys and a fixed
`tidy-functional-rollout` service identifier. No account, workspace, browser,
session or device identifier is supplied. No cookies, visitor headers, URLs,
person profiles, analytics events or exposure events are sent for evaluation.
PostHog receives the server connection information. The browser receives only
three booleans through a page-scoped React provider, without additional storage
or browser SDK requests.

These are global on/off switches. Configure 0% or 100% rollouts; user, cohort,
group targeting and per-user percentage rollouts are not supported by this
fixed service identifier. All visitors receive the same evaluation inputs.

Only an explicit enabled boolean result without a variant reveals a feature.
Missing configuration/flags, timeouts, HTTP/provider errors, malformed responses,
quota limits and string variants fail closed. Evaluations have a 1.5-second
deadline and no retries or stale enabled fallback. Each Worker isolate retains
at most one successful completed evaluation for up to 60 seconds, keyed by the
project token and host. Provider admission is charged only on cache misses;
expired results are discarded and failed evaluations invalidate the cache.
Pending I/O is never shared across requests. React also memoizes within the
current server render. Changes to global switches can therefore take up to
60 seconds to appear on new renders. An already rendered or restored
page keeps its snapshot until a new server render; flags are not a live security
boundary.

Analytics acceptance, rejection, withdrawal and expiry do not affect functional
availability. Browser collection can be disabled while functional flags work.
The browser analytics SDK does not evaluate flags; its proxy rejects flag/decide
requests and telemetry redaction drops exposure events. Analytics, replay,
diagnostics and surveys retain their existing purpose-specific consent checks.
Settings deep links respect the same flags. Loading skeletons and components
outside a server flag provider default to off.

These are UI rollout controls. Existing API authorization and connector grants
still apply, and hiding the UI does not revoke an existing integration.
Vault continues to use its independent `VAULT_ENABLED` server switch.

Configure these flags separately in each PostHog project. Leave them disabled
until rollout is intended. No additional app environment variables are needed;
the existing `NEXT_PUBLIC_POSTHOG_KEY` and `NEXT_PUBLIC_POSTHOG_HOST` apply.
`NEXT_PUBLIC_POSTHOG_ENABLED` controls optional browser collection only. Unset
the project key/host to disable functional evaluation. The supported hosts match
the existing telemetry proxy: regional PostHog ingestion hosts and the managed
`t.tidydesign.co` host. No operator or source-map API credential is used.
