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

Only a boolean `true` from the current consent-aware PostHog browser client
reveals a feature. Loading, missing flags, string variants, failed flag requests,
disabled browser collection and absent, declined or expired **Usage analytics**
consent keep the interfaces hidden. Replay or diagnostics consent alone does not
enable flags. Server rendering also starts with the interfaces hidden.

Consent changes, session revalidation, account switches and logout clear the
previous flags. SDK callbacks from an earlier session cannot restore them.
Settings deep links and loading skeletons respect the same visibility rules.

These are UI rollout controls. Existing API authorization and connector grants
still apply, and hiding the UI does not revoke an existing integration.
Vault continues to use its independent `VAULT_ENABLED` server switch.

Configure these flags separately in each PostHog project. Leave them disabled
until rollout is intended. No additional app environment variables are needed;
the existing `NEXT_PUBLIC_POSTHOG_ENABLED`, project key and host apply.
