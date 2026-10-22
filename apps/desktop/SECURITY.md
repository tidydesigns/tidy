# Desktop security boundaries

Tidy's Electron renderer is an editor and control pane. Installed Codex and Claude
Code executables are trusted native programs with their own authentication,
configuration, hooks, MCP servers and permission systems. The renderer sandbox
does not sandbox those executables. Auto — Full access deliberately permits
commands, edits and network access without routine approvals; use it only for
projects and harness configurations you trust.

## Application boundaries

- The renderer has context isolation, Chromium sandboxing and web security enabled;
  Node integration and webviews are disabled. Its preload exposes named operations,
  not raw Electron, filesystem, shell or IPC APIs.
- Packaged content uses `tidy://app/index.html`. The protocol serves only renderer
  output, with no route to project files or arbitrary local paths. IPC accepts the
  exact entry document in a native window's main frame. Event broadcasts use the
  same document check. Development URLs must use loopback and are ignored by a
  packaged app.
- Navigation, redirects, subframes and new windows are denied. Browser permissions
  are denied except local font access for the trusted main frame. The CSP excludes
  remote scripts, frames, objects and form submissions. Font downloads may contact
  Google's font endpoints; project data is not uploaded by the editor.
- Project locations originate in native dialogs. Later requests use validated IDs.
  Project storage rejects symbolic links, JSON reads have size limits, and writes
  use private temporary files and atomic renames. Attachment bytes, types and
  per-message limits are checked. Shared design schemas bound document content.
- Harnesses use absolute executable paths, literal arguments and structured stdin,
  with no shell interpolation. Relative PATH entries and unrelated application
  secrets are excluded. Authentication remains owned by the installed harness.
- Permission responses refer to live native requests. Unknown, expired and repeated
  responses are rejected. Stopping, completion and shutdown invalidate pending
  requests. Unsupported interactive requests fail closed.

## Portable data and private authority

Designs, folders, asset records, transcripts and tool logs live under the project's
`.tidy` directory. Permission choices and native session IDs live separately in
Tidy's private application data, bound to the canonical project path, project ID,
thread ID and harness. Editing or importing project JSON cannot grant full access
or substitute a native session. Moving a project requires choosing any elevated
permission mode again and starts a new native session while retaining transcripts.

Threads from builds predating this separation also retain their transcripts but
start a new native session with standard permissions. The app does not adopt
authority from legacy project files.

Tidy appends ignore rules for threads, attachments and local project identity,
including when a project already has ignore rules. Git ignore rules cannot remove
files already tracked by Git or protect against a user explicitly uploading them.
Tool logs can contain sensitive command output; they are plain local text, not a
guaranteed secret-redaction mechanism. Protect project backups and the OS account.

An application running as the same OS user with unrestricted filesystem access
can alter private app data. These controls protect the renderer and project-data
boundaries; they are not a defense against an already compromised OS account or
a harness deliberately given full access.

## Harness maintenance

Harness maintenance is separate from the Tidy application updater. Discovery runs
installed CLIs with `--version` from the user's home directory and fetches bounded,
stable-version metadata only from fixed npm registry or Homebrew API endpoints.
Requests contain package identifiers only, without project data or authentication.
Remote responses cannot supply commands, executable paths, registries or downloads.
Prereleases and malformed versions are rejected. Offline checks do not install.

Only a trusted app window's main frame can request installation, supplying exactly
one allowlisted harness ID. The main process owns installation paths, versions and
argument arrays; the browser-development server exposes no install operation.
Tidy revalidates the installation, reserves the CLI against new turns, waits for
active/preparing Tidy runs, serializes installers and verifies `--version` afterward.
Discovery finishing after an install cannot overwrite the newer state. Shutdown
waits for an active installer, while queued requests are canceled.

Commands run without a shell, outside project directories, with closed stdin,
bounded output and a five-minute install timeout. On POSIX, timeouts terminate the
command's process group. Maintenance excludes inference API keys from its inherited
environment. Raw updater output, local paths and configuration are never broadcast.
Global npm/pnpm/Bun installs must match the resolved global package root; npm also
uses that manager's explicit global prefix. Unknown/project-local installations
are not overwritten and no privilege elevation is attempted.

The installed native updaters and package managers, their configuration, official
package/release publishers and OS account remain trusted. Package managers may run
their usual package lifecycle scripts and use their own credentials/configuration;
Tidy does not independently verify downloaded CLI code or supervise external CLI
sessions. Claude's user settings are read only for the update channel; managed
policies remain enforced by its native updater. These changes add no dependencies.

## Packaging and verification

Packaging stages compiled output, metadata and licenses only. It enables ASAR-only
loading and disables RunAsNode, Node options, Node CLI inspection and extra file
protocol privileges. Embedded ASAR integrity is enabled on macOS and Windows;
Electron does not support that validation on Linux. Packaging fails if a fuse is
missing, so Electron upgrades require reviewing the fuse configuration.

The default package is for local development. The opt-in `release:desktop:mac`
command signs, notarizes, staples and verifies a native-architecture macOS DMG
using the operator's local signing identity and notarization Keychain profile.
Public distribution still requires installer testing and a maintained release
process. The opt-in [beta workflow](RELEASING.md) separates source verification,
macOS signing, and publication into different jobs. Pull requests receive no
signing secrets or release-write token. Signing uses a temporary Keychain on a
GitHub-hosted runner, removed even on failure; only the publisher has
`contents: write`, and it never receives Apple credentials. Publication validates
the exact commit, version, allowed filenames, metadata and installer checksum.
Published releases are never overwritten, and betas never become GitHub's stable
Latest release. An unsigned package is not a public-release artifact.

Automatic macOS updates use Electron's native Squirrel updater, which requires the
replacement app to satisfy the running app's code-signing requirement. Discovery
runs only in packaged Apple Silicon macOS apps, at startup and every 30 minutes, using the public
GitHub releases API for the fixed `tidydesigns/tidy` repository. These requests send
no project data, credentials, account IDs or local paths. Release discovery requests
use an in-memory conditional-response cache; rate limits defer automatic and manual
checks with retry/reset deadlines and increasing backoff. Discovery requests still
share the public IP's unauthenticated GitHub quota. Version/channel checks
reject downgrades, drafts, unrelated tags and missing/wrong-architecture assets;
asset URLs must exactly match the selected release in that repository. The release
publisher verifies the ZIP checksum and the feed's version/URL before publication,
and the macOS builder extracts the ZIP and checks its signature, stapled ticket and
Gatekeeper acceptance. Repository release writers and the Apple signing identity
remain trusted. Runtime installation relies on native code-signature verification,
not on an unsigned checksum fetched from the same release.

The isolated renderer can only read update state, subscribe to sanitized state
changes, retry a check against the fixed release source, or request installation of an
already staged update. It cannot supply a
feed, version, path or download URL. Update IPC uses the same trusted top-frame and
window checks as workspace requests and rejects arguments. Browser development has
no update installation endpoint. Clicking install checkpoints/stops harness jobs
and flushes storage before the native updater closes windows; background checks do
not restart the app. Native restart errors restore the workspace admission state
and preserve the staged update for a retry; they cannot leave the UI in an
installing state. Recovery releases only its own update reservation and cannot
reopen harness admission or cancel an ordinary quit that began during preparation.
Native error details remain outside the renderer.

Run from the repository root:

```sh
bun typecheck
bun lint
bun test
bun run audit:dependencies
bun run build:desktop
bun run --cwd apps/desktop test:security
bun run package:desktop
```

The native security smoke uses synthetic projects and fixture harnesses, without
real model inference, provider accounts or credentials. It checks the actual
preload/IPC boundary, CSP and protocol, canvas, native SVG export injection rejection,
approvals, stale-response rejection,
private persistence, navigation and popup blocking. Linux CI runs it under Xvfb
with Chromium sandboxing enabled and configures the pinned sandbox helper's
required ownership and permissions. CI also packages macOS and Linux artifacts.
Report vulnerabilities using the repository's [security policy](../../SECURITY.md).

The controls follow Electron's [security recommendations](https://www.electronjs.org/docs/latest/tutorial/security),
[custom protocol guidance](https://www.electronjs.org/docs/latest/api/protocol),
[fuse configuration](https://www.electronjs.org/docs/latest/tutorial/fuses) and
[ASAR integrity guidance](https://www.electronjs.org/docs/latest/tutorial/asar-integrity).
