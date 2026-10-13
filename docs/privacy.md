# Account data export and deletion

Settings provides personal-data JSON export and confirmed account deletion. This change is extracted from PR #44 and does not add cookie consent or public legal pages. The existing PostHog collection pause remains in effect; erasure calls remove historical data.

## User flows

- Settings → Profile → Account privacy and data opens `/account/privacy`. This page also works without an organization.
- JSON export and deletion require same-origin POST with a custom header, a verified account, and a persisted session created within five minutes. An older session offers sign-out/sign-in with a return path.
- Export uses explicit column lists in one consistent transaction. It excludes passwords, encrypted vault values, provider secrets, bearer tokens and other members' profile/session records. It contains personal records and accessible documents created by the requester. Complete design files/images have their existing editor export. Broader access requests, including processor-held history and embedded personal information, require the operator’s support workflow.
- Deletion requires an email confirmation. The last owner must transfer ownership or explicitly delete the organization first using the existing Settings flow (including billing checks). Shared files/folders/reviews remain attributed to one non-authenticating `Deleted user` record. Personal comments, imports, replay operations and messages are deleted; historical author names are cleared. Sessions, OAuth tokens/consents, personal provider connections, vault entries and memberships cascade atomically.
- Feedback submissions are stored independently of analytics consent. Operators can read `feedbackSubmission` in their private support workflow; its UUID matches any `feedbackUpload`. New feedback is included in export and cascades on account deletion. PostHog survey forwarding has been removed; feedback stays first-party while analytics is paused.

## Required rollout (not performed by this change)

1. Approve an explicit database target, then apply `migrations/20261011-account-privacy.sql` after existing migrations and reapply the reviewed runtime grants manifest. Local setup scripts include it. Do not deploy application code before this migration.
2. Configure these server-side Worker secrets/variables in the operator's private deployment config:
   - `PRIVACY_CLEANUP_SECRET`: at least 32 random characters.
   - `PRIVACY_POSTHOG_HOST`: the explicit PostHog API origin (not the ingestion proxy).
   - `PRIVACY_POSTHOG_PROJECT_ID` and `PRIVACY_POSTHOG_API_KEY`: project and scoped key supporting person erasure (`person:write`); verification through the deletion-status API also requires `person:read`. Keep separate from the public ingestion key and build-time source-map credentials.
   - Only installations that have **never** stored PostHog data may set `PRIVACY_POSTHOG_DISABLED=1` instead.
3. Deploy the runner's authenticated `erase` action together with the web change. It closes the runtime and removes the account's isolated private directory. Existing `AGENT_RUNNER_URL`/`AGENT_RUNNER_SECRET` configure delivery.
4. Add the example five-minute cron trigger to the **private** `wrangler.deploy.jsonc`, retaining `WORKER_SELF_REFERENCE`, `DESIGN_OBJECTS` and `FEEDBACK_IMAGES`. The scheduled handler calls the authenticated cleanup route in a regular OpenNext request context. A non-Worker host can schedule an authenticated POST to `/api/privacy/cleanup` every five minutes instead.
5. Verify sign-in, re-authentication, export, deletion and each external cleanup path with disposable staging accounts before enabling the controls in production. No production schema, data, bindings or deployment are changed by this branch.

## Erasure operations

`privacyCleanup` is a durable outbox committed with deletion. It contains only the object key or user ID required to erase the remaining data, has no user FK, and removes that value on completed synchronous erasure. Asynchronous PostHog requests retain it until verified. Workers atomically lease jobs for five minutes. Failures retry with bounded backoff and log only kind/attempt count; unavailable configuration never silently completes a job. Monitor `privacy_cleanup_failed`, `privacy_cleanup_unavailable` and jobs older than one day:

```sql
select kind, "nextAttemptAt" = 'infinity'::timestamptz as awaiting_verification,
       count(*), min("createdAt") as oldest, max(attempts) as attempts
from "privacyCleanup" group by kind, awaiting_verification;
```

All versions under the account’s user-avatar prefix (including failed replacement cleanup) and referenced feedback objects are deleted from R2. Legacy single-object avatar jobs remain supported. The runner removes its private account directory. Configured runners are queued even without an `agentConnection` row, because login can touch the runner before its database transaction commits. If an installation removes its runner configuration, historical runner erasure still needs its private operator workflow. PostHog receives `distinct_ids`, `delete_events=true` and `delete_recordings=true`; acceptance means processing was queued by PostHog, not that its asynchronous erasure has finished. Accepted PostHog jobs remain in `privacyCleanup` with `nextAttemptAt = infinity` and emit `privacy_cleanup_awaiting_verification`; they are not counted as completed or submitted repeatedly. An operator must verify person, event and recording erasure with the provider, record the outcome in the private deletion register, and only then remove that job through an explicitly approved operator write. PostHog’s `persons/deletion_status/` endpoint verifies event deletion; recording and person completion must also be checked. Do not discard jobs merely to clear an alert. This is an operational verification handoff, not an automated provider-completion poller.

Existing short-lived realtime presence/activity and security rate-limit records expire via their current alarms/TTL. Immutable organization assets and version content may contain personal information supplied as design content; review requests concerning that content separately, respecting other members' rights. Third-party GitHub/Linear content, required billing records, backups, security logs and historical feedback/analytics need the operator's access/retention workflow. The automated export clearly identifies its scope; it is not represented as a complete subject-access response.

Before restoring a backup, replay erasures from the restricted operational deletion register before reopening access. Define backup/log/billing retention and the process for access, objection, restriction and erasure requests, and confirm processor agreements and international-transfer safeguards. These are operational decisions that cannot be inferred from the repository. Record requests privately; do not commit personal records or request logs.

## Validation

Run `bun typecheck`, `bun lint`, `bun test`, `bun run test:privacy:db`, `bun run test:account-controls` and `bun run build` (extension builds require an explicit HTTPS `WXT_BELLA_URL`). The database harnesses own disposable localhost PostgreSQL clusters and exercise the restricted runtime role. No shared or production database is used.

The privacy suite covers export scope and secret exclusion, recent sessions, origin/header checks, confirmation, last-owner protection, transactional rollback and cleanup retries. The account suite also covers orphan runner data, avatar versions and retained PostHog erasure verification. Runner tests verify authenticated, idempotent deletion and shutdown before directory removal.

Complete staging and manual keyboard/screen-reader acceptance separately. Automated checks do not establish whole-site accessibility or legal compliance.

Monitor cleanup capacity as well as failures and jobs awaiting verification. The scheduled endpoint processes one job per invocation; a five-minute schedule processes at most 288 jobs/day, plus deletion-triggered work. Account closures can create multiple jobs.
