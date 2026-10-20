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
- `desktop-release.json`: schema version, beta channel, app/build versions, tag,
  source commit, workflow run, release URL and platform download URL/hash/size.

These are direct downloads; no TestFlight or App Store listing is needed. The
application currently uses manual updates. An installed-app updater, Intel/Windows/
Linux installers, and website/sidebar UI are separate changes.

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
Only the selected installer, checksum and metadata leave that job. Its temporary
Keychain and `.p12` are removed on success or failure.

The isolated Linux publisher downloads the signing job's exact artifact ID from
the same workflow run. It validates all filenames, regular-file boundaries,
version/commit/run metadata and the actual installer hash before using its write
token. It stages a **draft release**, uploads all three files, verifies their
sizes, and only then publishes a prerelease with `--latest=false`. Release drafts
are internal staging; pull requests remain ready for review.

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
verify installation and project compatibility, and add the installed-app updater.

## Workflow security checks

Run the repository security audit and secret scan before opening release PRs.
For workflow changes, also run zizmor and actionlint. Actionlint `1.7.12` does not
yet recognize GitHub's supported `concurrency.queue` key; when using that version,
ignore only its exact `unexpected key "queue" for "concurrency" section` diagnostic.
All other diagnostics must pass. The queue setting is documented by
[GitHub](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).
