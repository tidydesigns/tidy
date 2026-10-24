# Tidy desktop

Standalone Electron application with a React and TypeScript renderer, built with
electron-vite. It runs independently of the Next.js web app and needs no database
or environment configuration. Its purpose is a local-first control pane for coding
harnesses, with Tidy's design canvas available for agents to design and iterate
before implementing UI.

Open a local directory as a project. Tidy restores the last opened project and
keeps its design materials and engineering threads together. No cloud account or
database is needed for project storage.

The sidebar Design and Code tabs switch between separate workspace views, with
Design selected initially. Both views stay mounted while switching, and each project
retains its selected thread, design and composer drafts during the app session.
The tabs support arrow keys, Home and End.

## Optional cloud sync

Open the **Settings** gear at the bottom of the sidebar, then choose **Sign in**
under Account. Sign-in opens the system browser and requests a separate desktop
authorization. Settings has its own sidebar; **Back to app** returns to the same
workspace without resetting its state. Choose a cloud workspace from the workspace
switcher to browse its files, folders, search, and lightweight previews. Workspaces
currently require editing access. Account sign-in and sign-out live only in Settings.

Open a file to download it and start editing. Downloads happen in private,
account-scoped application storage without choosing a project directory. Cached
files reopen from disk; file lists stay visible during background refreshes.
**New file** opens locally immediately and publishes in the background. The canvas
status shows whether work is synced, stored locally while offline, or needs attention.

Cloud workspaces also have a **Threads** tab. Start a thread with **Design only**
to run against the workspace's private local design cache, or choose a local project
in the composer to run its harness in that repository. Any number of local projects
can use the same workspace. Select workspace design references before starting;
only selected files download, and edits use their existing sync bindings. The
project choice is fixed for that thread, including follow-ups, queues and native
session resumption. Start another thread to use a different project. Project skills,
model discovery and branch controls use the selected execution directory.

Conversations, attachments, native session authority and repository files stay local.
Workspace threads return when the same account reopens the workspace on this machine;
web conversations and remote execution are separate. Signing out stops workspace
runs and blocks further cloud thread actions, while independent local threads continue.
Workspace design access is limited to the signed-in account's editable workspaces.

Signing in never uploads a local project. To publish an existing local design,
choose **Add to workspace…** in its file actions and choose the destination. Its
local path stays unchanged. Connected documents, images, and file names sync both
ways; threads, attachments, repository files, and local folder moves remain local.

Local saves never await network requests. The main-process coordinator batches
work over 250 ms with a one-second maximum wait, uses a separate worker for document
comparisons and local-file decoding, sends patches, and limits transfers to two designs
at once. Active and locally changed files take priority, with capacity reserved so a
slow background transfer cannot block the open design. Images
upload before patches and reuse the server's content-hash deduplication. Sync
baselines, asset aliases, initial file-creation IDs and unacknowledged operations
persist in private application data. Restart reconciliation also discovers edits
made by agents while the app was closed. Local asset IDs represent immutable
images; replacing an image requires a new asset ID, as editor uploads already do.

Incoming changes use a single bounded revision manifest for up to 1,000 downloaded
files, checked every two seconds while editing, every fifteen seconds while browsing,
and every minute when the app is in the background. Only changed designs fetch
incremental patches, with snapshot fallback when server history has expired.
Returning to the app or reconnecting triggers catch-up immediately. Unchanged
files skip document decoding and comparison; metadata fingerprints detect edits
on disk even if an external writer restores the modification time. A lightweight
minute scan recovers missed filesystem events. Validated documents are cached
privately with a bound of eight full documents and 1,000 summaries.
Transient failures retry with bounded backoff, and Retry-After pauses account-wide
requests instead of letting individual files overwhelm the service. File-list metadata
refreshes in the background every thirty seconds while the cloud workspace is open.
Thumbnails load only near the visible viewport, with at most three transfers at
once and one cached image per file. Browsing files does not download every document.

Conflicting edits or names preserve both versions and pause automatic sync. Open
the canvas status and choose **Keep both copies** to retain the local edits as a
separately synced cloud file and open the current cloud version. File renames use
an expected-name check and durable pending state so retries cannot overwrite a
concurrent rename or clear newer local changes.

Signing out stops account-bound transfers and removes local tokens. Server
revocation is attempted; an offline sign-out cannot guarantee remote revocation
until the server is reachable. Signing back into the same account resumes its
files; another account or a copied project path cannot inherit upload authority.

Refresh tokens are protected using Electron `safeStorage`, outside projects and the
renderer. Cloud login is unavailable when protected storage is unavailable,
including Linux's `basic_text` fallback. Tokens have a dedicated `/api/desktop`
audience and `desktop:sync` scope, and the API rechecks current OAuth consent,
session, verified account and workspace membership. The existing database and R2
services enforce document, asset, quota and role limits. No database credentials
are shipped to desktop and no schema migration is needed for this increment.

To test against a local or self-hosted web app running this branch:

```sh
TIDY_CLOUD_URL=http://localhost:3000 bun dev:desktop
```

The default service origin is `https://app.tidydesign.co`; self-hosted services must
use HTTPS, with HTTP permitted for loopback development. The browser-only desktop
development gateway does not expose native cloud credentials or login. Both web
and desktop code must be running this implementation before cloud sync is usable.
No deployment happens during development or tests.

Live push notifications, project folder/name/deletion sync, automatic three-way
merges and large-document latency measurements remain follow-up work.

## Projects and threads

1. Open a project directory, or choose a recent project from the top-left picker.
2. Design lists folders in the sidebar and files in the main browser. All files
   includes every design, labeled with its folder or Unfiled. New folder creates
   folders inline in the sidebar. New file, import, and grid/list controls share
   the browser header. New files belong to the selected folder. File menus support
   renaming and moving. Documents use the same editor as web and persist edits
   immediately. Opening a canvas hides the project sidebar; Back restores the
   previous folder. Connected cloud files cache their images for offline use.
3. In Code, choose Codex or Claude Code, optionally attach design references, and
   start a thread. The harness runs in the project root and receives the attached
   design file paths. Follow-up messages resume the locally bound native harness session.
4. Stop cancels the active process and its commands. Closing the app stops active
   runs; an interrupted run is never silently restarted. Send a message to continue.

Tidy uses the installed CLIs and their existing sign-ins. Install and sign in to
Codex (`codex login`) or Claude Code (`claude auth login`), then use Check connection
in the composer. Credentials remain owned by each CLI; Tidy does not access their
sign-in stores or copy their credentials. The current integration uses Codex App Server over stdio and Claude Code
bidirectional streaming JSON; tests exercise both protocols with fixture executables, without paid inference.

### Harness updates

The desktop app checks installed Codex, Claude Code and OpenCode CLIs at startup,
every 30 minutes, and when the app regains focus after that interval. Checks run in
the background and do not delay the workspace. A bottom-right notification shows
the installed and available versions in one compact card, with Codex, Claude Code
and OpenCode marks and an **Update** action for each recognized installation.
Queued rows explain whether they are waiting for active responses or another
installer. Only a running update shows a spinner; completed rows retain their
provider mark and show a checkmark. Dismissing availability hides that version until a newer release
is found. Offline checks stay quiet and preserve known updates.

Updates start immediately when possible. Claude's native updater can install in
the background during an active response; its versioned installer leaves the
running process intact and the next launch uses the updated version. Other update
methods wait only for active/preparing responses on that same harness. Idle
conversations stay open and other harnesses can continue working. New turns for
the updating CLI are blocked briefly during installation.
Package-manager installs run sequentially. Tidy verifies the installed version
before reporting success and offers Retry after a failure. Quitting cancels queued
updates and waits for an active installer to finish. Runs outside Tidy are managed
by their own CLI, not tracked by this queue.

Supported update methods are the standard native Codex, Claude Code and OpenCode
installations, matching global npm/pnpm/Bun installations, and Homebrew casks or
formulae. Tidy preserves Homebrew's installed cask/channel, uses Claude's user
`autoUpdatesChannel` setting for discovery, and keeps OpenCode 1 and 2 on their
respective release lines. Native updaters still enforce their own policies.
Custom, project-local, unrecognized or shell-wrapper installations receive an
availability notice with instructions to use their existing package manager;
Tidy never replaces them with a second global copy or requests administrator
privileges. Prerelease versions are left to their existing updater.

OpenCode update discovery does not add OpenCode conversation support. Browser
development exposes no harness-installation API. Update commands follow the
[Codex CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli),
[Claude Code setup guide](https://code.claude.com/docs/en/setup#update-claude-code),
and [OpenCode CLI reference](https://opencode.ai/docs/cli/#upgrade).

Tool activity appears inline with the conversation in collapsed groups. Expand a
group and a step to inspect commands, searches, reads, file changes, tool inputs
and output, including test logs and reported exit codes. Output updates as the
harness supplies events; native aggregate snapshots replace earlier output rather
than duplicating it. Expansion stays under the user's control during streaming.
A failed tool does not make the entire turn fail. Stopped and interrupted tools
retain their partial output and are never labeled as successfully completed.

Tool logs persist privately with the thread. Each input retains its first 8,000
characters and each output its latest 32,000 characters. A thread retains up to
250 steps and 1,000,000 characters of tool logs; shortened inputs, omitted output
and older discarded steps are indicated. Existing transcripts remain readable,
but activity discarded by earlier app versions cannot be recovered. File edits
show the paths and patch/input details actually supplied by the harness: Codex
JSON events can report paths without a patch. Test results display the harness's
output; the app does not infer passed-test counts from exit codes.

Thread cards show activity as `3m`, `6h` or `2d`. Drag cards to reorder them, or
use Alt + Up/Down. Hover or focus a card to mark it Done. Done stays at the bottom
of the sidebar; expand it and choose Reopen to continue a thread's original session.
Finishing a turn changes Working to Ready without marking the thread Done.

Chat renders Markdown and code blocks. It follows streaming output until you
scroll up; Latest resumes following. The left rail previews and jumps to turns.

Sending paints the user message and thread immediately, before native preparation
or disk acknowledgement. Client-generated thread/message IDs are reconciled with
the native records so acknowledgement and streaming cannot duplicate a turn.
Failures restore the submitted text and attachments alongside any new draft text;
navigating to another thread is preserved. Stop also cancels a turn still preparing.

Sending does not refresh model catalogs or account usage. Settings changes still
validate against the connected catalog; the native harness validates model/effort
at launch. Reference files are read once without loading their image assets.
The hidden canvas, file overview and transcript are isolated from composer typing.
Streaming sends changed messages and tool rows instead of copying full thread
history on each update. Notifications are coalesced separately from disk checkpoints, with an
immediate durable write before launch and a final flush on completion/shutdown.
Harness process startup and provider generation time still determine response latency.

Start a message with `/` to search the selected harness's skills. Arrow keys
navigate; Enter or Tab selects; Escape closes the picker. Add arguments after the
skill name, then send. One skill can be explicitly selected per message. Paths,
URLs and slash text elsewhere in the message remain ordinary text.

Skills come from the harness's native catalog for the current project. Codex uses
its enabled skill catalog; Claude Code exposes callable skills and custom commands.
Discovery runs in the background, caches for one minute and refreshes when the
window regains focus. Sending a selected skill uses the last successful catalog
while an expired catalog refreshes in the background. A failed refresh does not
block that selection; a successful refresh replaces the cached catalog, including
removed or disabled entries. A failed lookup can be retried in the picker.
Selecting a skill does not change the thread's permissions.

Queued follow-ups retain their selected skill through persistence and delivery.
Editing arguments preserves the selection; changing the opening command clears it.
Send now carries the native skill invocation into steering or a resumed turn.
Discovery uses the installed provider's project and global skill configuration.
Tidy sends no user turn during discovery and rejects tool approval requests, but
provider initialization and native skill validation remain provider-controlled.

The renderer receives only skill IDs, names and descriptions. The main process
resolves IDs against the project and harness before sending native file references
or command blocks. `HarnessSkills` owns catalog caching and provider discovery;
new harness integrations provide an adapter without changing the slash picker.

Press Enter to send; Shift+Enter adds a new line. While the agent is working,
Enter or Queue adds a follow-up for the next turn. Send now or Cmd/Ctrl+Enter sends
the message into the active turn. Codex uses native steering; Claude interrupts
and resumes its existing session. Sending into an active turn is available once a native session is ready.
Cmd/Ctrl+Shift+Enter sends the oldest queued message into the active turn without changing your draft.

The collapsed queue above the composer shows the waiting message count. Expand it
to edit, reorder, remove, or send individual messages immediately. Drag a message by its grip
to reorder it, focus the grip and use the up/down arrow keys, or click its grip
and then another message's grip to move it there. Escape cancels a selected grip.
Edits apply on Enter or leaving
the field; Escape cancels. If a message starts while being edited, unfinished
changes return to the composer. Up to 20 follow-ups, including attachments, can
wait in each thread. They run one at a time after successful turns. Stop, errors,
and app restarts hold remaining messages. Send now on a waiting message starts it
and continues the remaining queue automatically. Queue contents are
persisted locally; opening a project never executes a saved queue.

Use the paperclip to attach files, drop them onto the composer, or paste an image.
Attachments have previews and can be removed before sending. A message can contain
attachments without text. Images use Codex's native local-image input or Claude's
structured streaming image input; other files are supplied as local paths for the
harness's file tools. New and resumed sessions support attachments.

Up to 10 attachments are accepted per message, totaling 25 MB. Each raster image
(PNG, JPEG, WebP or GIF) is limited to 5 MB; other files are limited to 20 MB. SVGs
are treated as source files. Selected files are copied into private project storage
and sent to the selected harness only when the message is sent. Sent messages keep
their attachment references and restore image previews after reopening the thread.

The composer uses the same Codex and Claude marks as the web app. Choose a model
and supported effort level from the connected CLI's catalog. Settings persist per
thread and apply to its next message while retaining its native session. The
composer shows the resolved model name and effort. If the harness does not report
a value, choose it from the menu. Settings cannot change during a run. Checking
models and limits never starts an inference turn.

Usage shows Codex account limits when available and recorded thread token counts
for either harness. Claude Code does not expose live account limits through its
connection; Open provider usage opens the appropriate provider page instead.
Reported API cost is an estimate, not a subscription charge or billing statement.
Hover or keyboard-focus a sidebar thread to see its title, latest reply, model,
effort, design references, activity and recorded usage without opening it.

The composer's Permissions menu applies to the selected thread and its next run.
Threads use Codex Project access or Claude Accept edits unless explicitly changed.
Changing the model retains the permission selection. Settings cannot change while
the harness is running.

- Codex Project access uses the workspace-write sandbox with on-request approvals routed
  to the user. Read only uses the read-only sandbox with on-request approvals.
- Claude Ask before changes prompts for actions needing permission; Accept edits allows file
  edits; Plan explores and asks before changes.
- Full access selects Codex's danger-full-access sandbox with
  approval policy never, or Claude's bypassPermissions with the required opt-in
  flag. Claude's classifier-based auto mode is a separate setting.
  Native administrator requirements, deny rules and mandatory confirmation checks
  still apply; Tidy never silently answers prompts.

When a harness requests permission, its command/input, reason and supplied paths
appear above the composer. Allow once or Deny answers only that live request.
Codex also offers Allow for session where supported. Explicit network/filesystem
permission grants use Allow for turn or Allow for session, matching their native
scope. Claude approvals do not create persistent rules or echo rule suggestions.
Requests are marked in the thread sidebar and remain available after a renderer
reload or project switch. They expire on native cancellation, stopping, completion
or app shutdown, and are never replayed from stored transcripts. Unsupported
interactive forms/questions return a protocol error rather than granting access.

The native mode mappings and approval protocol follow the
[Codex App Server documentation](https://developers.openai.com/codex/app-server)
and [Claude Agent SDK permission documentation](https://code.claude.com/docs/en/agent-sdk/permissions).
Installed harness sign-ins, project instructions, tools and native sessions remain
owned by the harness. Legacy Codex exec session IDs resume through App Server.

Project-owned files are stored in:

```text
your-project/
  .tidy/
    project.json       # Stable local project identity, retained when moving the folder
    designs/<id>.json  # { id, name, folderId, document: DesignDocument }
    folders/<id>.json  # { id, name }; project-local design organization
    assets/<id>.json   # Local image data, referenced by designs
    attachments/      # Private copied files and metadata, ignored by Git
    threads/<id>.json  # Transcript, tool logs and attachment references
    .gitignore        # Ignores local identity and private thread history
```

Design files and folder metadata can be versioned with the project. Moving a design
between folders retains its file path and existing thread references. Existing files
without folder metadata appear as Unfiled in All files.

Thread history stays on disk locally and is ignored by Git. The app's private
user-data directory stores recent project locations and authoritative thread
permissions/native session IDs, bound to a project location and harness. Project
JSON cannot grant access or replace those native sessions. Moving or importing
thread history starts a new native session with standard permissions. Agent
changes to design JSON refresh the open canvas. Local
commits check the last disk version so an older edit cannot overwrite those changes.

Use Bun 1.3.14 and Node.js 22.12+ (Node.js 24 recommended). From the repository root:

```sh
bun install --frozen-lockfile
bun dev:desktop
```

### Browser development

For remote UI development, run the same renderer and workspace backend without an
Electron window:

```sh
bun dev:desktop:browser --project /absolute/path/to/project
```

Open the private link printed by the command in a browser. The server binds only to
`127.0.0.1:5173`. For access from another machine, use an SSH tunnel or a private
HTTPS proxy and pass its external origin, for example:

```sh
bun dev:desktop:browser --project /absolute/path/to/project \
  --origin https://your-machine.your-tailnet.ts.net:8443
```

Configure the private proxy separately to forward that origin to `127.0.0.1:5173`.
Use HTTPS for remote browser access so clipboard, images and other browser APIs
have a secure context. Keep the development link private: it authorizes access to
project files and coding harnesses. Its token is removed from the address bar after
being exchanged for an HttpOnly session cookie. Sign-in lasts seven days across
server restarts. Rotating the token file and restarting revokes existing sessions.
Source files, API requests, event streams
and hot reload all require that session; mutation requests also validate their origin.
The server is a development tool, not a production hosting mode.

The command initially opens the project specified on the host. Use the top-left
project menu and **Open project…** to browse Linux folders or type a path
(`~/` starts at the host home folder). Results filter as you type; use arrow keys
to navigate, Enter to browse, or Tab to complete a folder. Choose **Open folder**
to open the path shown in the footer. Previously opened projects stay in the
menu, and the last selected project is restored after restarting the server.
This opens existing directories; it does not create a folder or clone a repository.
Import uses your browser's file picker. Project data and
harness processes stay on the host. Browser registry/session-authority state is
separate from Electron, under `$XDG_STATE_HOME/tidy-browser` (by default
`~/.local/state/tidy-browser`), so do not run both modes on the same project at once.
The project itself still stores its files in `.tidy/` as described above.

Renderer changes use Vite hot reload. Restart the command after backend changes;
reopen the private link if the seven-day browser session expires. `--token-file` can select a
private token file for a managed development process. Native dialogs, window
behavior, permissions and packaging still need Electron testing.

The development command starts the renderer on `127.0.0.1:5173` and opens Electron.
React changes update through Vite HMR. Restart the command after main process changes.

If an Electron-based terminal host sets `ELECTRON_RUN_AS_NODE=1`, clear that variable
before launching the app (on macOS/Linux: `env -u ELECTRON_RUN_AS_NODE bun dev:desktop`).

```sh
bun run build:desktop      # Compile into apps/desktop/out
bun run start:desktop      # Open the compiled app
bun run package:desktop    # Create an unpacked app in apps/desktop/release
```

Packaging uses Electron Packager to create an unsigned app for the current platform
and architecture. It stages only compiled output, package metadata and licence
notices and a runtime icon on Linux; source code and local environment files are excluded. Packaging is separate
from the monorepo build. Native icons come from [the Tidy logo export](resources/README.md).
Installers, signing and notarization can be
configured before public distribution. Packaging enables the Electron security
fuses described in [desktop security](SECURITY.md).

`src/main/index.ts` owns the native window and application lifecycle.
`src/renderer/` contains the browser-only React interface. The renderer is sandboxed,
with context isolation and no Node.js integration. Navigation, new windows and
permissions are denied except installed-font access for the font picker. The sandboxed preload exposes only typed project, design
and thread operations. Native IPC validates the main-frame sender and every input;
paths come from the native directory/file dialogs and are subsequently addressed
by project and document IDs. Filesystem and harness subprocess access stays in the
main process. Keep web database access and server credentials in `apps/web`.

The root `bun typecheck`, `bun lint` and `bun run build` commands include this app.
`bun test apps/desktop/src/main` checks project persistence, project boundaries,
session resumption, reference context, process cancellation and event parsing.
Renderer bundles carry the repository's reviewed third-party licence notices;
packaged apps also include the project licence, bundled notices and font licences.
`bun run --cwd apps/desktop test:security` checks the built app in a real Electron
process, using only synthetic projects and fixture harnesses. On headless Linux,
run it with `xvfb-run --auto-servernum`.

## Local macOS release candidate

Desktop versions are independent of the web app. `package.json` owns the SemVer
version (initially `0.1.0-beta.1`) and `desktopBuildNumber`, a numeric string that
must increase for each published desktop release. macOS bundle metadata uses the
numeric release version and build number; About and harness clients retain the
full beta version. Use tags such as `desktop-v0.1.0-beta.1` when publishing.

Install a Developer ID Application signing identity and validate a notarization
Keychain profile using `xcrun notarytool store-credentials`. Then run from the root:

```sh
TIDY_MAC_SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
TIDY_NOTARY_PROFILE="your-notarization-profile" \
bun run release:desktop:mac
```

This opt-in command builds for the current Mac's architecture. It applies the
existing security fuses, signs with Hardened Runtime and the JIT entitlement,
notarizes and staples the app, then creates a signed, notarized and stapled DMG
with an Applications shortcut. It verifies signatures, tickets and Gatekeeper
acceptance, creates a ZIP of the final stapled app for in-app updates, and writes
SHA-256 sidecars in `apps/desktop/release/`. Keychain may
prompt to authorize the signing key. No private keys or passwords are exported.

Notarization uploads the compiled app and DMG to Apple. Submission IDs are printed
before waiting (up to 15 minutes for each submission). If Apple takes longer,
inspect the submission with `xcrun notarytool info <id> --keychain-profile <profile>`;
an incomplete or rejected run is not a verified release candidate.

Stapling and ticket validation retry known transient Apple network failures up to
three total attempts, waiting 5 and 10 seconds between attempts. Invalid tickets,
signature failures and other permanent errors stop immediately; exhausted retries
also fail the release. Successful verification is still required before publishing.

If app notarization has completed and the app is already stapled, append `--resume`
to recreate the update ZIP and retry the DMG stage without rebuilding or re-uploading the app. This
requires the existing app's version/build metadata, signature, notarization ticket
and Gatekeeper assessment to pass. Keep the source and build number unchanged.

The command does not publish, install, or deploy anything. Test the DMG on another
Mac before public distribution. The [desktop beta release workflow](RELEASING.md)
can automate signing and publishing after merges to `main` once its environment
is configured and enabled. Installed Apple Silicon macOS apps check at startup and every 30
minutes; once an update is staged, click the icon at the bottom of the sidebar to
restart and install. Older builds need one manual DMG update to get the updater.
See [in-app updates](RELEASING.md#in-app-updates) for channels and release verification.
Website download links remain separate work. Existing `package:desktop` remains an
unsigned local development package, including in pull-request CI.

## Shared foundations

- Branding uses the same `TidyLogo` from `@tidy/ui/tidy-logo` as the web app.
  `@tidy/ui/fonts.css` bundles the existing Instrument Sans and Instrument Serif
  fonts locally, including their OFL licences. The interface uses Instrument Sans;
  the Tidy wordmark uses Instrument Serif. No network font requests are needed.
- `@tidy/ui/harness-icon` uses copies of the web app's approved provider SVGs in
  `packages/ui/harness-icons`, with the original trademark notice included in
  packaged apps.
- `@tidy/design` owns the browser-safe design document model and operations.
- `@tidy/design-renderer` owns the shared canvas rendering used by the web app.
  `@tidy/editor` contains the full canvas, editing interactions and inspectors used
  by both web and desktop. Web supplies navigation, room synchronization and hosted
  integrations; desktop supplies immediate local document, name and image writes.
- Local workspace storage and coding harness processes belong in the Electron main
  process, exposed through narrow, validated preload APIs. The React renderer must
  not receive unrestricted filesystem, process execution or IPC access.
- A local document should be the source of truth for both canvas edits and agent
  changes. Cloud accounts and network services should remain optional; web sharing
  can synchronize documents without becoming a prerequisite for local design work.
