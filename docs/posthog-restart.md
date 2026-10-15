# PostHog restart and privacy operations

The website `/privacy` is the only public notice. App links and its `/privacy`
redirect point there. This document is an engineering runbook, not another notice
or a claim of legal certification. Signing evidence, provider settings, customer
identifiers and request/completion records belong in restricted operator storage.

## Scope and defaults

All collection switches default off. Browser usage analytics (including flags and
voluntary surveys), masked replay and browser diagnostics have separate choices.
Consent version 4 requires a fresh explicit choice. Reject/accept have equal
presentation; closing is not a grant. Account ID/email identification is limited
to purposes selected by a signed-in user. Core server fault reporting is a separate,
minimised legitimate-interest path; it never reuses browser/account identity.
Request tracing, console recording, network bodies, heatmaps and unreviewed remote
extensions remain off. Product access, including Vault, is independent of analytics.

Before SDK initialization, `/api/privacy/consent` commits the choice and notice
version with a random browser identifier and any current account ID. A separate
HttpOnly receipt token is stored hashed in the database. The transport checks the
current receipt, purpose revision and persisted authentication. Auth changes stop
the previous SDK and resolve identity again. Receipt delivery failure keeps optional
collection off and offers retry; withdrawal stops capture immediately. Cookie
clearing cannot itself identify or erase records already held by a provider.

## Required deployment sequence

1. Review the public notice, purposes, minimisation, current provider inventory and
   replay risk screening. Retain the executed PostHog DPA and applicable
   subprocessor/transfer review privately. Confirm the production project's region,
   IP settings, replay configuration and applicable retention settings.
2. With explicit approval for the database target, apply
   `migrations/20261015-analytics-consent.sql` after `20261011-account-privacy.sql`,
   then reapply `migrations/operations/runtime-grants.sql`. The new tables are
   required before this code is deployed. This PR does not apply production SQL.
3. Publish the website notice. Configure the app's public `NEXT_PUBLIC_SITE_URL`
   and production `BETTER_AUTH_URL` correctly. Deploy the application initially
   with browser, server-error and tracing switches off.
4. Configure `PRIVACY_CLEANUP_SECRET` (32+ random characters), preserve the existing
   storage/self-reference bindings and schedule the authenticated cleanup endpoint
   every five minutes in the private deployment configuration. Confirm query-string
   redaction there, and inspect application log fields separately.
5. Select `PRIVACY_POSTHOG_MODE=manual` for the interim operator workflow below.
   API mode additionally requires the separate scoped management credentials
   described in [account privacy operations](privacy.md); API acceptance still
   requires completion review. Do not use `PRIVACY_POSTHOG_DISABLED=1` on a service
   that collects or has collected PostHog data.
6. Exercise missing/old/expired consent, every purpose combination, withdrawal,
   multiple tabs, login/logout/account switching, small screens, keyboard and
   screen-reader operation. Inspect decoded synthetic events and editor replay for
   private text, input values, attributes, images, URLs and console contents. Test
   an account deletion and verify actual provider event/recording removal.
7. After accepting these results, build with `NEXT_PUBLIC_POSTHOG_ENABLED=1`, the
   reviewed public project key and EU ingestion host. Enable
   `POSTHOG_SERVER_ERRORS_ENABLED=1` separately only after accepting its necessity,
   proportionality and operational safeguards. Keep `POSTHOG_TRACING_ENABLED=0`.
   Source-map uploads additionally require explicit `POSTHOG_UPLOAD_SOURCEMAPS=1`
   and private build credentials; they are optional. Verify the actual release
   revision and repeat a controlled production check, then remove test data.

The hosting operator approves deployments/settings separately from PR review.
Code tests do not establish provider deletion completion or executed agreements.

## Manual deletion and retention

Review the privacy inbox and the cleanup queue each working day. Withdrawal of a
purpose queues `posthog-review` with the affected purpose(s), remaining choices
and identifiers. Expiry also queues review through the cron without another visit.
Account deletion queues the account ID and linked browser identifiers. Partial
withdrawal must be reviewed by purpose; do not blindly delete a whole person if
doing so would disregard other still-selected purposes or another account's data.
If the authentication context has changed, the review explicitly requires identity
verification before acting on the earlier account's records.

Use an explicitly selected operator database URL; do not infer it from examples.
Commands can display identifiers, so keep terminal output private. Production
inspection/completion writes require the normal operator authorization.

```sh
# PRIVACY_OPERATIONS_DATABASE_URL is supplied privately by the operator.
bun apps/web/scripts/privacy-posthog-review.ts list
bun apps/web/scripts/privacy-posthog-review.ts complete <job-uuid> <private-evidence-reference> --verified
```

The list shows up to 100 oldest pending jobs. Refresh it until all jobs are handled.
In PostHog, inspect all associated distinct IDs and perform applicable event,
profile and recording erasure. Anonymous records and separate error issues may
require dedicated controls or provider support. An empty person lookup, hidden
events, or accepted/queued API response is not proof of completed erasure. Verify
the provider outcome first; then the command transactionally records a hashed
subject/evidence reference and removes the pending job. No public endpoint can
mark completion. Never clear a job just to silence monitoring.

Monitor `privacy_consent_unavailable`, `privacy_cleanup_failed`,
`privacy_cleanup_unavailable` and `privacy_review_pending` (including its overdue
count). Jobs more than one day old require investigation. Missing configuration
and failed delivery retain jobs; manual reviews remain pending until confirmed.

Keep 30-day replay retention. Review retained identifiable events, surveys,
profiles and diagnostic records at least monthly against the notice's purpose
criteria, and arrange earlier erasure when required. Provider event availability
is not a deletion schedule. Review unlinked server fault reports and separate
error-issue records independently of person deletion. Consent evidence and cleanup
receipts expire after one year through the cron; account deletion also removes
linked consent records. Keep the restricted erasure register needed to reapply
deletions before restored backups are reopened. Assess any legal retention
exception individually rather than treating all historical data as indefinite.

## Server monitoring assessment and replay screening

Server fault reporting serves detection of failed/stalled requests and restoration
of the requested service. Before enablement, confirm why existing operational logs
do not meet the same need equally effectively with less processing. Reports are
restricted to fixed categories, normalised routes, code locations, bounded timings,
release details and transient server correlation. They exclude account/email,
browser/session/replay identifiers, IPs, cookies, headers, bodies and raw error
messages. This path accesses no browser storage. Retention, restricted access,
objection and erasure handling still apply wherever records are personal data.
Adding user association or broader data requires a new assessment.

Replay can otherwise expose confidential designs and third-party information.
This implementation masks text and attributes and blocks authentication, forms,
media, images, embedded pages and design canvases before transmission. Verify these
safeguards on realistic synthetic content before enabling replay; consider scale,
vulnerable users, sensitive content and linkage when screening for a DPIA. Complete
a DPIA before any processing likely to create high risks. Consent is not a
substitute for this assessment. Future recording/content changes need new review.

## Validation

Run root typecheck/tests/build and the disposable `bun run test:privacy:db`,
`bun run test:account-controls` and `bun run test:runtime:db` suites. The latter
own localhost PostgreSQL clusters and exercise restricted runtime privileges.
Lint/format changed files and package the Worker with source-map uploads disabled.
Record release-specific browser/provider acceptance privately. Automatic provider
completion polling and broader retention tooling can follow the tested manual
process; a working request and erasure workflow cannot be deferred.

References: [DPC cookies](https://www.dataprotection.ie/en/dpc-guidance/guidance-cookies-and-other-tracking-technologies),
[GDPR](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng),
[PostHog data controls](https://posthog.com/docs/privacy/data-storage),
[replay privacy](https://posthog.com/docs/session-replay/privacy).
