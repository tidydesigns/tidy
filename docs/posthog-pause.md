# PostHog collection pause

The app does not initialize the PostHog browser SDK. Browser event, identity,
exception and reset calls use an inert local facade; nothing is queued for later
submission. Server exception reporting, request tracing, feature-flag evaluation
and build-time source-map uploads are disabled by `lib/posthog-policy.ts`.
Existing environment settings cannot override the pause.

Request deadlines, local operation tracking and platform diagnostic logs still
work. This change concerns PostHog traffic from this repository, not all data
processing performed by the application or its other providers.

## Product effects

- Product events, pageviews, web vitals, autocapture, session replay and browser
  and server error reporting no longer reach PostHog from the updated app.
- Vault is unavailable because its access flag is evaluated through PostHog.
  Existing Vault records remain stored; the pause does not grant access or
  delete records.
- Feedback uses PostHog surveys, so the dialog shows that feedback is temporarily
  unavailable. The form cannot submit or upload attachments.
- PostHog data already collected is unchanged. Existing browser analytics
  cookies and storage are not erased, but the updated app does not use them for
  PostHog collection. Auth sessions continue to work.

## Rollout and follow-up

1. Review, merge and deploy this change using the normal approved release
   process. Creating or merging a PR alone does not update the running app.
   There are no migrations or new secrets.
2. Check a fresh page load, login, navigation and representative server requests
   for PostHog network traffic. Old open tabs or older deployments may continue
   running their previous SDK until replaced or refreshed. Check all live
   deployments that share the project.
3. PostHog's project settings can disable session recording as an additional
   measure. That setting does not replace the application pause for custom
   events, identities, server reporting or flags.
4. Handle historical data review and any deletion separately. This change does
   not certify legal compliance or perform deletion in PostHog.
5. Preserve the pause when integrating the separate privacy/consent work in
   PR #44. Resolve the instrumentation and feedback changes deliberately; merging
   consent UI must not silently reactivate collection. A reviewed resumption
   must cover browser and server consent, permitted fields, replay/error
   settings, provider retention and stale browser storage/queues. Restoring
   feedback or Vault independently needs a replacement for their PostHog dependency.

Transport tests explicitly override the policy only inside isolated fixtures
with fake credentials and intercepted HTTP. The default-policy tests and the
Worker smoke test verify zero PostHog delivery with credentials configured.
