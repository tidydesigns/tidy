# Service request budgets

Service limits complement the existing Worker ingress ceilings. They apply before
provider work, retain charges on failed requests, and return `429` with
`Retry-After` when an HTTP allowance is exhausted. Unavailable admission guards
return `503` rather than allowing unmetered work. These are request ceilings, not
monthly spending guarantees.

## Images

Avatar updates reserve a service allowance per account across workspaces and,
for organization images, per workspace across administrators. Reads also share
the workspace allowance after authorization. The existing account limits are
240 reads/minute and 6,000/hour, and 10 updates/minute and 50/hour. Workspace
allowances are 1,200 reads/minute and 30,000/hour, and 30 updates/minute and
200/hour. Upload attempts have a separate allowance before multipart parsing.

R2 access also reserves a shared avatar allowance of 1,200 reads/minute and
30,000/hour, or 60 updates/minute and 1,000/hour. An update can perform an upload
and cleanup deletes; the allowance counts logical updates. The existing 5 MB
upload limit still applies. Monitor these shared ceilings as traffic grows.

## Presence

Existing per-socket, per-room and concurrent-connection limits are supplemented
by 3,600 presence messages/minute and 120,000/hour per account across rooms and
connections. Rooms prepay batches of ten messages and discard unused permits
after one second. Low-volume traffic therefore has a conservative accounting
overhead; a room uses at most one guard call for ten messages within that second.
Room restarts cannot reset the durable account counters.

Over-budget presence updates are dropped. The document mutation pipeline has its
own independent limits. A failed guard is retried after a short local cooldown,
and overlapping events within the same Durable Object reuse its pending
reservation before consuming separate permits. Socket authorization is checked
again after admission because revocation can interleave while waiting.

## Diagnostics

Routine request and operation console records use a server-generated 1% sample.
Stalls and failures retain their diagnostic records. PostHog tracing additionally
requires diagnostics consent, its existing enable switches, a 1% sample, and a
shared export allowance. Each admitted request prepays its ordinary export and
optional stalled snapshot: at most ten admitted requests/minute and 100/hour.
Each export contains at most 64 operation spans plus its root. Admission failure
suppresses tracing and adds at most 250 ms to a sampled request; it does not fail
the application request. Error reporting keeps its separate existing allowance.

The Worker template samples persisted logs at 10% and platform traces at 1%, with
automatic invocation logs disabled. Before deploying, mirror those settings (or
lower rates) in the operator's private `wrangler.deploy.jsonc`. Deployment
preflight rejects enabled log sampling above 10% or trace sampling above 1%.
This repository change does not modify an existing Worker configuration.

## Billing

Checkout and portal HTTP attempts share a per-account allowance of five/minute
and 20/hour before reading JSON bodies. Service calls independently share that
account allowance and, after owner authorization, a workspace allowance of
ten/minute and 40/hour.

Stripe calls use five-second timeouts and no automatic network retries. Checkout
allows ten provider calls within a 15-second admission window, and inspects at
most three pages of 100 subscriptions. An incomplete history check stops checkout
and directs the operator to support. A persisted open checkout is reused before
catalog requests. Checkout creation uses a stable, bounded idempotency key so
retrying after a failed local update can recover the same provider session.
Stripe's own idempotency retention window still applies.

No new SQL migration is required. Deploy after the service synchronization
migration already included on `main`; production configuration and deployment
remain separately approved operations.
