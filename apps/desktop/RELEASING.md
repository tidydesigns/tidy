# Desktop beta releases

`.github/workflows/desktop-release.yml` builds Apple Silicon macOS betas from
pushes to `main` that affect desktop code, shared packages, dependencies, licences
or release tooling. Website-only and web-only changes do not trigger it. A manual
Actions run can retry a release from `main`; other refs cannot sign or publish.

The workflow is opt-in. Until `DESKTOP_BETA_RELEASES_ENABLED` is `true`, it runs
verification and reports the setup requirement, without signing or publishing.
Merging this workflow does not export local credentials or publish the existing
local candidate.

## One-time setup

1. In repository Settings → Environments, create `desktop-beta`. Restrict its
   deployment branches to `main`. Leave required reviewers disabled for automatic
   beta releases, or enable them if each signing run should require approval.
2. Export the Developer ID Application identity **and its private key** from
   Keychain Access as a password-protected `.p12`. A downloaded `.cer` alone is not
   enough. Store the base64-encoded `.p12` as the environment secret
   `DESKTOP_MAC_CERTIFICATE_P12`, and its password as
   `DESKTOP_MAC_CERTIFICATE_PASSWORD`. Never commit either file or value.
3. Add environment secrets `DESKTOP_APPLE_ID` (the Apple account email) and
   `DESKTOP_APPLE_APP_SPECIFIC_PASSWORD` (a dedicated app-specific password for
   notarization). The workflow validates and stores these in its temporary
   Keychain. The local `tidy-notarization` profile is not available on hosted runners.
4. Add repository Actions variables `DESKTOP_MAC_SIGN_IDENTITY` (the full
   `Developer ID Application: Your Name (TEAMID)` identity name) and
   `DESKTOP_APPLE_TEAM_ID` (the matching team ID).
5. Choose `DESKTOP_BETA_VERSION_OFFSET`, a repository variable defaulting to `1`.
   The beta/build number is the workflow's run number plus this fixed offset.
   Seed it so the first CI number exceeds previously distributed builds. Keep it
   fixed afterwards; increase it if recreating or renaming the workflow resets
   the counter. The workflow fails rather than replacing a conflicting tag.
6. Set repository Actions variable `DESKTOP_BETA_RELEASES_ENABLED` to `true` when
   ready to authorize automated beta publishing. Run **Desktop beta release**
   manually from `main` for the first verification. Disabling the variable stops
   signing/publishing in future runs; cancel active or queued runs separately.

No personal GitHub token is needed. The publisher uses its job-scoped
`GITHUB_TOKEN` with `contents: write`. Repository rules that restrict tag creation
must permit this workflow's `desktop-v*` tags. Use GitHub-hosted runners, not a
shared developer Mac. Prefer protecting `main` with review and required PR checks.

## Versions and artifacts

The desktop manifest owns the human-selected base version. For example,
`0.1.0-beta.1` plus workflow run `41` and offset `1` produces
`0.1.0-beta.42`, build `42`, and tag `desktop-v0.1.0-beta.42`. Only the disposable
build checkout is stamped; no bot commits or pushes to `main` are made. Retries of
the same workflow run retain the version. Build numbers are limited to `9999` to
respect macOS bundle-version limits; plan a numbering migration before reaching it.

Each published GitHub prerelease contains exactly:

- `Tidy-<version>-mac-arm64.dmg`: signed, notarized, stapled installer.
- `Tidy-<version>-mac-arm64.dmg.sha256`: SHA-256 checksum of the final DMG.
- `Tidy-<version>-mac-arm64.zip`: ZIP of the final signed, notarized, stapled app.
- `Tidy-<version>-mac-arm64.zip.sha256`: SHA-256 checksum of the update ZIP.
- `desktop-update-arm64.json`: Electron/Squirrel feed pointing to that release's ZIP.
- `desktop-release.json`: schema version, beta channel, app/build versions, tag,
  source commit, workflow run, release URL, installer and update URL/hash/size.

These are direct downloads; no TestFlight or App Store listing is needed.
Intel/Windows/Linux installers remain separate work.

## In-app updates

Installed Apple Silicon macOS apps check the public `tidydesigns/tidy` GitHub releases API at
startup and every 30 minutes. Discovery reads up to three pages of 100 releases,
ignores drafts, unrelated tags, incomplete assets and other architectures, and
selects the highest compatible version rather than the last publication. Beta
installs can receive newer betas or stable releases; stable installs ignore betas.
Failed checks and downloads retry on the next interval without interrupting work;
the sidebar also offers an immediate retry using the same update control.
Discovery caches each page's ETag and parsed releases for conditional requests.
GitHub rate-limit responses quietly defer checks, including manual retries, until
the server's retry/reset deadline or an increasing backoff of at least 30 minutes.
An app restart clears this in-memory cache and backoff. Unauthenticated requests
still share GitHub's public-IP quota, so large shared networks can delay discovery.
Intel builds remain disabled until the release pipeline publishes matching feeds
and ZIPs. Development builds and the browser development gateway never check or install.
They display a preview of the sidebar update icon; its tooltip identifies the
development preview, and clicking it does not install or restart anything.

Electron's native Squirrel updater downloads the ZIP in the background and checks
its code signature against the installed app. The Iconoir circular refresh icon at the bottom of the workspace sidebar spins
while checking, downloading or preparing a restart. Reduced-motion preferences
disable rotation. A small green check-circle badge appears only after staging
succeeds; failures use an amber warning-circle badge. Colors match thread status
indicators. Status, version and retry details appear in a compact tooltip above
the control on hover or keyboard focus, dismissible with Escape. No status or
error text reserves space beside the icon. Busy controls remain focusable for
inspection and ignore activation until the operation completes. Clicking it stops
active harness runs, checkpoints their threads, flushes local storage, and restarts
to install. Squirrel also applies staged updates on the next normal quit/relaunch.
Every update replaces the installed app and requires a restart. There is no
automatic restart or extra menu entry. Download/check failures expose sanitized
retry feedback. If native restart fails, the staged update remains retryable and
the workspace reopens for new work; stopped harness runs require a follow-up
message to continue.

Older builds without this updater need one manual DMG installation. Install Tidy
in Applications before updating; running from a mounted DMG or a read-only folder
cannot be updated in place. Keep the bundle ID and Developer ID signing identity
consistent between releases. The versioned update feed uses Squirrel's default
format; version/channel comparison happens in the main process using the full
package version, including the numeric beta suffix.

Before distributing the first updater-enabled release, verify a signed two-version
upgrade on macOS: install version A from its DMG, publish a higher version B with
all six assets, leave A running until its icon appears, then click it and confirm
B launches with projects and interrupted thread history intact. Also verify an
ordinary quit/relaunch after staging. Unit and native security tests use synthetic
fixtures and do not replace this signed distribution check.
On Apple Silicon, `test:security` also runs the built main process with synthetic
release discovery and native installer events. It checks trusted update-state
delivery, restart failure recovery/retry, and ordinary quit cleanup. Other
architectures skip this updater-specific fixture.

Production sign-off is still pending. Exercise signed distribution on a fresh Mac
and an existing installation, including an offline launch, network interruption
and sleep/resume during download, low disk space, a read-only or translocated app,
a rejected signature/corrupted archive, and quitting with pending design edits or
active harness runs. Verify a failure preserves the installed version and local
project files, and that a subsequent retry or manual reinstall recovers. Native
download timeouts/resume and filesystem failure recovery require testing in the
actual bundled Electron/Squirrel version; unit mocks do not establish them.
Windows/Linux auto-updates and an Intel release pipeline are outside this release.

The future download page can select the highest beta version from published
`desktop-v*` prereleases and consume that release's `desktop-release.json`.
Ignore drafts and stable/unrelated releases; do not use GitHub's stable-only
`releases/latest` endpoint. Metadata and asset URLs are versioned, so there is no
mutable tag, overwritten installer, or website deployment for every beta. Cache
discovery briefly and preserve the last successful download if discovery fails.

## Verification and publication

The Linux verification job audits dependencies, exports/scans committed source
for secrets, and runs type checks, lint, unit tests and release regressions. The
macOS job stamps/builds the same commit, runs the native security smoke before
importing credentials, then signs and notarizes the app and DMG. It verifies
signatures, stapled tickets and Gatekeeper acceptance before uploading artifacts.
Only the selected installer, update ZIP, checksums and metadata leave that job. Its temporary
Keychain and `.p12` are removed on success or failure.
The signing step registers that temporary Keychain in the runner's user search
list: `codesign --keychain` alone does not make its certificate chain discoverable.

The isolated Linux publisher downloads the signing job's exact artifact ID from
the same workflow run. It validates all filenames, regular-file boundaries,
version/commit/run metadata and the actual installer hash before using its write
token. It stages a **draft release**, uploads all six files, verifies their
sizes, downloads them into a fresh directory, and compares all six SHA-256
digests against the validated local files before publishing a prerelease with
`--latest=false`. After publication it repeats the asset readback and requires
the release tag to resolve to the expected source commit. Release drafts
are internal staging; pull requests remain ready for review.

Enable GitHub release immutability before activation so published assets and tags
cannot be replaced. Repository contents-write users and admins remain trusted
release writers. Do not manually edit an active release draft: GitHub's release
update API provides no documented conditional operation covering asset validation
and publication, and workflow concurrency only serializes this workflow. Readback
checks detect conflicting writes; they do not provide a lock against other writers.
A failed post-publication check can leave a public release, so inspect that release
before distributing its link and issue a new version rather than overwriting it.
See GitHub's [release API](https://docs.github.com/en/rest/releases/releases#update-a-release)
and [immutable release guarantees](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases).

The workflow uses `concurrency.queue: max` and does not cancel active runs.
GitHub can queue up to 100 pending runs; release discovery must select versions,
not assume publication order. No beta release changes the stable channel.

## Failures and retries

- A failed audit/test/build/notarization leaves the previous public beta intact.
- A failed upload leaves an unpublished draft. Re-run the failed job, or the full
  workflow run, to finish it. Only matching drafts may have assets replaced.
- Re-running a successful run downloads and verifies its published artifacts,
  then returns without editing or overwriting them. A newly signed candidate
  cannot silently replace already distributed bytes.
- A tag/release for another commit, stable release, damaged published asset set,
  unexpected file, missing credential or failed GitHub request fails closed.
- Apple notarization can take longer than the 15-minute per-submission wait.
  Inspect the printed submission ID with the operator's notarization profile;
  expired Actions artifacts may require a fresh run/build number. No unaccepted
  installer is published. Notify maintainers through normal Actions failure emails.

Before marking a release stable, use a separately reviewed stable release process,
verify installation, update-channel behavior and project compatibility.

## Workflow security checks

Run the repository security audit and secret scan before opening release PRs.
For workflow changes, also run zizmor and actionlint. Actionlint `1.7.12` does not
yet recognize GitHub's supported `concurrency.queue` key; when using that version,
ignore only its exact `unexpected key "queue" for "concurrency" section` diagnostic.
All other diagnostics must pass. The queue setting is documented by
[GitHub](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).
