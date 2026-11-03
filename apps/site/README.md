# Tidy website

The website is a Next.js static export served through Cloudflare Workers Static
Assets. `/download/mac` is handled by the small Worker in `worker/index.ts`.
All other existing assets stay on Cloudflare's direct static asset path.

## Website analytics

The website uses the same PostHog project as the hosted app: `tidy-prod` for
production and `tidy-dev` for development. Every website event has
`surface=website`; app browser events have `surface=web`. The standard PostHog
Web Analytics view can be filtered to the website surface.

Set the website's **build-time** `NEXT_PUBLIC_POSTHOG_ENABLED=1`,
`NEXT_PUBLIC_POSTHOG_KEY` and `NEXT_PUBLIC_POSTHOG_HOST` to the app's matching
public project configuration. Set `NEXT_PUBLIC_APP_URL` and `NEXT_PUBLIC_SITE_URL`
to their intended public origins. Never use a personal/admin API key in the site.
Set the site's **runtime Worker variable** `ANALYTICS_APP_ORIGIN` to the explicit
hosted app origin. It provides `/api/privacy/consent` and the consent-gated
`/api/t/*` transport; both applications must be deployed with compatible code and
the app's browser collection switch enabled. If receipt confirmation is
unavailable, the website remains usable and optional collection stays off.

The compact banner has Accept all, Reject all and Customise. Individual choices
apply immediately, with no save step. The footer opens those choices again.
There is no SDK import, optional identifier, config request or event buffering
before a grant. Each SDK startup waits for the server receipt. Website choices
are host-only and independent from app/MCP choices. Consent version 8 renews
earlier browser choices for the expanded notice. Browser storage and receipts
expire independently; receipts use the existing app maintenance/deletion path.

Usage analytics cover pageviews/navigation, structural click/rage-click data,
reviewed campaign labels and referring domains, selected section exposures and
explicit `website_cta_clicked` events (`action`, `placement`). Names, field
values, copied text, arbitrary element attributes and raw query/fragment values
are excluded. Campaign labels should use letters, numbers, underscores and
hyphens, at most 80 characters; never put personal information in UTMs. Optional
acquisition state is retained in session storage for 30 minutes of inactivity.

Replay is independently consented and sampled at 20% of eligible sessions, with
the project's existing 30-day retention. Public marketing text remains visible;
inputs, editable content, media, canvases and the embedded desktop demo are
blocked. Console logs and network bodies/headers are disabled. Diagnostics have
their own consent choice; only reviewed Web Vitals and redacted shipped-code
error locations are collected. No website person profiles are created.

Consenting links to the app carry a random `tidy_website` fragment, which is
removed before recording. The app uses it only after its own analytics grant
and for at most 30 minutes, and clears it on withdrawal, expiry and account
changes. `website_visitor_id` joins observations across the two surfaces without
aliasing or merging person profiles. It is an analytics reference, never an
authentication credential or trusted account identity.

In the app, `signup_started` is a valid registration attempt; provider buttons
on login emit `auth_provider_clicked`. `signup_completed` means actual **new
account creation**, including email accounts awaiting verification. The server
creation hook signs a bounded HttpOnly completion marker; the client claims it
only under the exact occurrence consent and a current receipt. Repeated claims
use the same event UUID/time for ingestion deduplication. The marker is retained
for at most 24 hours so a delayed response cannot erase a newer signup. Existing
logins and provider-account linking issue no marker. Delivery is best effort.

Download CTA clicks measure intent, not completed transfers or installations.
The existing app-side `snapshotDownloads`/`desktop_download_aggregate` pipeline
provides aggregate GitHub installer counters when its separately configured
analytics storage/export is enabled. Those counters include repeat requests and
automation and are not a visitor-conversion denominator. No additional
consent-free browser tracking or cookieless fallback is introduced here.

Preview the eight-tile dashboard definition without any network or credentials:

```sh
bun apps/web/scripts/setup-website-dashboard.ts
```

After reviewing the definition and configuring ingestion, provision it using an
operator-only `POSTHOG_API_KEY` with project/dashboard/insight access:

```sh
bun apps/web/scripts/setup-website-dashboard.ts --apply --project=<explicit-id> --host=https://eu.posthog.com
```

The script requires an explicit project, reuses the matching named dashboard,
adds only missing named tiles and resumes partial setup. It never deploys code,
changes recording settings or replaces existing tiles. Charts cover consenting
visitors/pageviews, pages, sources/campaigns, CTA placements, a website-to-download
funnel and attributed new accounts. Refusal, blockers, device changes and
sampling limit coverage; never present those numbers as a census of all people.

For local review, use a separate `PORT`/`NEXT_PUBLIC_SITE_URL` and point
`ANALYTICS_APP_ORIGIN` at an explicitly configured local app or test fixture.
Local development permits automated-browser traffic; production retains the
SDK's bot filtering. The app and site tests cover consent/purpose boundaries,
withdrawal/identity races, new-account proof, redaction and proxy safety.

## Pinned desktop demo

Website development and builds use the exact compiled renderer stored in
`desktop-demo/snapshot.json.gz`. Desktop app, editor and dependency changes do
not update it automatically. `desktop-demo/manifest.json` records its version,
source commit and SHA-256. Staging verifies the checksum and all file paths before
atomically replacing `public/desktop-demo/`; a missing or damaged pin fails the
build instead of silently using current desktop code. The iframe URL includes
the snapshot hash so an intentional update requests fresh HTML.

When we decide to update the demo:

1. Commit the desktop and shared source changes to include in the new version.
2. From the repository root, run
   `bun run --cwd apps/site demo:update <version>` (for example `2026-11-02.2`).
   This builds the renderer once from committed source and replaces the snapshot
   and manifest. The gzip contains JSON entries with relative paths and base64
   file contents, including lazy chunks, fonts, workers and bundled licences.
3. Run `node apps/site/scripts/copy-desktop-demo.mjs` to stage it in an existing
   dev session, or restart `bun dev:site`. Check both themes, the header at narrow
   and wide desktop widths, page scrolling over the demo, and canvas interactions.
4. Review and commit both files in `desktop-demo/`. Subsequent website builds
   keep serving this version until the next explicit update.

Run the staging regression checks with
`bun test apps/site/scripts/copy-desktop-demo.test.mjs`.

## Latest beta download

Use `downloadUrl` from `lib/download-url.ts` for the macOS download button. It
defaults to `/download/mac`; `NEXT_PUBLIC_DOWNLOAD_URL` remains a build-time
override for a different installer/distribution service. The Machine marketing
page uses this value through `lib/site-links.ts`.

On a click the endpoint redirects directly to the highest numbered published
`desktop-vX.Y.Z-beta.N` release's Apple Silicon DMG. Stable releases, drafts,
other release families, unsafe versions and incomplete uploads are ignored.
The installer, its checksum and `desktop-release.json` must all be uploaded,
nonempty assets at the exact GitHub URLs generated by the desktop release workflow.
Only Apple Silicon is currently produced by that workflow; this endpoint does
not claim to provide an Intel installer.

Discovery reads at most three pages of 100 releases, comparing versions numerically
like the desktop updater. A successful lookup is shared for **60 seconds per warm
Worker instance**; concurrent clicks share one lookup. New releases are discovered
after that short freshness window without a website build. Redirects are always
`Cache-Control: no-store`, so browsers never retain a version-specific redirect.
Failed lookups are not cached and do not serve expired installer selections.
GitHub errors/rate limiting return an accessible 503 page with a releases link.

Runtime configuration (private Worker configuration, not public Next.js variables):

- `DESKTOP_RELEASE_REPOSITORY`: public GitHub `owner/repository`, default
  `tidydesigns/tidy`. Use its canonical case. The link to the source repository
  (`NEXT_PUBLIC_REPOSITORY_URL`) is independent of the installer repository.
- `GITHUB_RELEASES_TOKEN`: **required for production deployments**. Provision a
  read-only GitHub token for the release repository as a Worker secret; never
  prefix it with `NEXT_PUBLIC_`. Warm caches are local to each Worker instance,
  and cold instances can share egress IPs, so anonymous API limits are unsuitable
  for the production download CTA. The token is optional for local testing of a
  public repository. No visitor headers, cookies or credentials are forwarded
  upstream.

Queries cannot select another repository, installer, architecture or redirect URL.
Network requests stay on GitHub's fixed API host and never follow pagination URLs.
Discovery is bounded by an eight-second overall timeout and an 8 MiB limit per page.

## Development and validation

From the repository root, run `bun dev:site`. `scripts/dev.mjs` starts the same
download handler on an ephemeral loopback port and rewrites `/download/mac` to it
in Next development only. There is no client-side GitHub discovery or extra
request during page loading. `.env.local` can set the server-only variables for
local testing; the launcher loads it before starting the handler.

Run `bun test apps/site/worker apps/site/scripts/deploy.test.mjs`,
`bun typecheck --filter=@tidy/site`, `bun lint --filter=@tidy/site` and
`bun run build:site`. `bunx wrangler deploy --dry-run --outdir /tmp/tidy-site-worker`
from `apps/site` checks the Worker bundle without publishing anything.

For the first deployment from an assets-only site, add `GITHUB_RELEASES_TOKEN`
as an encrypted **build secret** under the site Worker's **Settings > Build >
Build variables and secrets**. An assets-only Worker cannot accept runtime
secrets through **Variables and Secrets** yet. The deploy script reads the build
secret, writes it to a temporary file accessible only by the current user, and
passes it with `--secrets-file` so the Worker code and runtime secret are uploaded
together. It removes the temporary file after deployment, including failures and
SIGINT/SIGTERM cancellation. Forced termination such as SIGKILL cannot run cleanup.
The token is not included in command arguments or the public website build.

For local deployment, supply `GITHUB_RELEASES_TOKEN` in the deploy process's
environment and use the operator's private `TIDY_SITE_DEPLOY_CONFIG` as usual.
After a successful deployment, the runtime secret is preserved when the build
secret is absent; you may remove the build secret and manage the runtime secret
in **Variables and Secrets**. If the build secret remains, each deployment applies
its value again, so update it when rotating the token.

For deployment, the existing deploy script preserves the operator's private
target/configuration and creates a temporary config with the Worker entrypoint,
`ASSETS` binding and selective download routing. It adds `GITHUB_RELEASES_TOKEN`
to `secrets.required`, preserving existing required secrets, so Wrangler rejects
a deployment when the token is missing. It does not edit the private config.
The wrapper deploys only the top-level target in `TIDY_SITE_DEPLOY_CONFIG`.
It rejects `CLOUDFLARE_ENV` and CLI arguments and explicitly selects Wrangler's
top-level environment, so named environments cannot bypass the validated target,
required secrets or asset routing. Use a separate private config with the desired
target at the top level for another deployment target.
A website deployment is required once to introduce this endpoint; later
desktop beta releases require no website changes or deployments.
