# App error diagnostics

Browser diagnostics report failures with shipped Tidy JavaScript frames and explicitly
instrumented page rendering, Figma import, file synchronization, edit persistence and
sign-in failures. Dependencies bundled with Tidy remain in scope. Unrelated extension
and third-party errors without Tidy frames are discarded. Console capture is disabled.

`lib/privacy/error-diagnostics.ts` retains reviewed static messages and normalizes
runtime templates (including React error numbers). Unknown text becomes the error
type, with the operation label and stack retained. Add reviewed messages here when a
new failure needs more detail; never interpolate design content or provider responses.
`appErrorReporter` binds a caught operation to the account and consent at its start.
It drops reports after either changes, and ignores cancellation. Retry loops report
once per failed operation or continuous synchronization failure, rather than every retry.

## Privacy and replay

Browser reports require diagnostics consent. Account ID/email support investigation
and follow-up; session/window IDs link errors to replay only when replay is also
enabled. Replay and analytics retain their independent choices and existing masking.
Consent version 5 requests a fresh choice because the previous notice promised to
remove every browser error message. No collection starts on a dismissed notice.

Core server fault reports remain independent: no account, email, browser cookies or
replay linkage. They retain reviewed technical messages/categories, sanitized code
locations and source-map chunk IDs. Source maps describe application code, not user
content. Avoid putting secrets in source code or build artifacts.

Both browser and server stack frames include `function: "<redacted>"`. PostHog's
raw JavaScript frame schema requires a string here, even for anonymous frames.
Omitting the field prevents Error Tracking from processing the exception. The fixed
placeholder contains no original function name or user data; locations and chunk IDs
remain available for source-map resolution. This preserves the existing notice and
consent scope without collecting additional information about users.

## Build and Worker configuration

No new variables, Worker bindings or database migrations are required.

| Existing variable                                           | Where / purpose                                                                                                                 |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_POSTHOG_ENABLED=1`                             | Build and runtime: enables consent-controlled browser collection.                                                               |
| `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST`       | Matching environment's project token and ingestion host, at build and runtime.                                                  |
| `POSTHOG_SERVER_ERRORS_ENABLED=1`                           | Enables independent server fault reporting; an explicit Worker value overrides the fallback.                                    |
| `POSTHOG_UPLOAD_SOURCEMAPS=1`                               | Build only; also requires browser or server reporting enabled at build time.                                                    |
| `POSTHOG_API_KEY`, `POSTHOG_PROJECT_ID`, `POSTHOG_API_HOST` | Build-only upload credentials and matching project's API host. Never expose the personal API key in browser or Worker bindings. |
| `NEXT_PUBLIC_APP_VERSION`                                   | Optional build release override; defaults to the commit being built.                                                            |

Keep request tracing disabled. Changing only Worker variables cannot change an
already-built browser bundle. Use the operator's private deployment configuration;
do not copy bindings from repository examples. Source-map uploads must target the
same project as ingestion and run before deployment. The upload plugin removes maps
after upload. A localhost development URL is not fetchable by PostHog; use a local
production build with maps uploaded to the development project to validate symbolication.

## Validation

Run `bun typecheck`, `bun lint`, `bun test`, `bun run test:telemetry-worker`,
`POSTHOG_UPLOAD_SOURCEMAPS=0 bun run build:worker`, and `bun run build` with the
extension build origin configured. Uploads are deliberately disabled for local CI-style checks.

For the actual browser SDK, run
`bun apps/web/scripts/serve-error-diagnostics-fixture.ts`. Open the printed loopback
URL in a visible browser, click **Run diagnostics checks**, then **Generate activity**
when prompted. The fixture checks messages, frames, private-value filtering, unrelated
extension suppression, independent consent, and matching error/replay session IDs.
Its collector and account are synthetic and local; it sends nothing to PostHog.

After an authorised deployment, inspect fresh consented errors using PostHog MCP:
verify app version, distinct issue grouping, readable source locations and a matching
symbol set for each application `chunk_id`. Check replay linkage where both purposes
are enabled. Old stripped events cannot be repaired. Existing production symbols
alone do not prove the new release is deployed or that its errors resolve correctly.
