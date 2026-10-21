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

## Handled errors and UI notices

`@tidy/ui/errors` separates deliberate `UserFacingError` copy from a caught
`cause`. `handleError` maps known network, timeout, storage and auth failures to
reviewed text, otherwise uses the caller's fallback. It passes the original value
to the reporter without modifying its stack, cause or custom properties. Expected
validation messages do not create fake exceptions. Cancellation stays silent.

Web actions use `useErrorNotice` from `lib/use-error-notice`; editor components use
`useEditorErrorNotice`. Capture `const notifyError = setError("")` immediately before starting an
operation, then pass `notifyError(cause, fallback)` in the catch. Each returned
notifier keeps its original session binding when actions overlap. Passing a string alone means deliberate UI copy, not a technical failure.
Retry loops report once until a new operation starts. Forms and failed-content
sections may opt into inline presentation; other action failures use the shared
bottom-right toast. Notifications keep private text masked for replay. The
viewport moves into the active native modal to remain accessible.

Server `actionError`, file management and API failure helpers report caught values
before selecting public response copy. Original server errors stay on the server;
clients receive only reviewed messages. `readJsonResponse` retains response and
validation failures as causes, and the Figma worker uses structured cloning to
retain Error stacks and causes across its local message boundary. Existing
telemetry redaction, consent, collection switches and source-map uploads apply.

Desktop and extension UI reuse the toast and normalization primitives and retain
caught values locally. These hosts do not currently configure a PostHog reporter;
this change does not introduce native telemetry collection. Persisted failed jobs,
failed agent runs, field validation and retryable content keep their contextual UI.

The real-SDK local fixture also exercises `handleError` with a `UserFacingError`
and an original technical cause. It asserts original object identity and stack
integrity at reporter entry, separate UI copy, and the technical diagnosis and
application frames at the collector. This validates the installed SDK and
redaction pipeline without sending test events to production. It does not prove
that a deployed environment's collection switches or ingestion are enabled.

Preserving the original error at reporter entry does not mean uploading every
field unchanged. Browser diagnostics redact private messages and retain approved
application frames. Server diagnostics retain approved categories and root code
locations; raw cause messages, arbitrary properties and private payloads remain
excluded by the existing policy. Expected validation and cancellation do not
create synthetic diagnostic exceptions.
