# Security

Please report vulnerabilities privately through the repository's **Security →
Report a vulnerability** feature. If it is unavailable, contact a maintainer
privately before sharing reproduction details. Do not post credentials, customer
records or exploitable details in public issues.

Security fixes target the current default branch. Deployments should keep their
lockfile current and run `bun run audit:dependencies`. Public source does not
certify a particular deployment or replace review of its credentials, privileges,
provider configuration, abuse controls and backups.

Tenant authorization lives in server services and is tested with separate actors,
role changes and revocation. The shared runtime database credential can access
multiple tenants; keep it server-side and use the restricted grants documented in
[database setup](migrations/README.md#runtime-privileges). Browser code and native
agent execution must never receive migration credentials or database secrets.

The supported hosted architecture is Cloudflare Workers, Hyperdrive, private R2
buckets and Durable Objects. Node.js is a local development path: several shared
rate limits are Worker-specific. A public Node deployment requires equivalent
shared admission controls and a separate security review. See
[self-hosting](README.md#self-hosting).

Never connect pull-request CI or preview deployments to production credentials,
provider accounts, customer data or storage buckets. Review third-party patches
when updating authentication dependencies.

The dependency audit permits the braces advisory GHSA-vfj7-8cjw-p6xm only through
the reviewed development dependency chain
`eslint-config-next → @next/eslint-plugin-next → fast-glob → micromatch → braces`
in the web and site workspaces. This tooling exposure concerns malicious glob
configuration; keep untrusted repository configuration out of privileged CI.
The audit blocks other advisories and changes to that consumer chain. Reassess
the exception when updating dependencies.

Hosted public endpoints use separate Durable Object budget shards so telemetry
cannot consume login, email or privacy-choice budgets. Telemetry attempts are
limited before session/consent database reads (600/minute and 10,000/hour per
edge-provided IP; 12,000/minute and 500,000/hour globally). Valid consent receipts
also share a 20 MB/minute and 200 MB/hour payload allowance, with a minimum 64 KiB
charge per request. Across receipts, forwarding is capped at 500 MB/minute and
5 GB/hour. These are safety ceilings, not usage targets or billing guarantees;
monitor provider usage independently. Over-budget telemetry returns 429 with
`Retry-After`; it does not block editing or consent withdrawal. Guard outages
fail closed with 503. Node development does not have these hosted controls.

`/api/health` continues to report database readiness. Hosted results, including
failures, are cached internally for five seconds per deployment and cache
location; callers still receive `Cache-Control: no-store`. Cache misses share a
120/minute query budget globally. A denied check returns 429 with `Retry-After`,
and a failed database check returns 503. Cache failures cannot bypass admission.
Edge request filtering is still needed for volumetric traffic, and public-source
checks do not certify the live deployment's configuration.
