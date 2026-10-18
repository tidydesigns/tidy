# Tidy desktop

Standalone Electron application with a React and TypeScript renderer, built with
electron-vite. It runs independently of the Next.js web app and needs no database
or environment configuration. Its purpose is a local-first control pane for coding
harnesses, with Tidy's design canvas available for agents to design and iterate
before implementing UI.

Open a local directory as a project. Tidy restores the last opened project and
keeps its design materials and engineering threads together. No cloud account or
database is needed for project storage.

The top-level Design and Code tabs switch between separate workspace views, with
Design selected initially. Both views stay mounted while switching, and each project
retains its selected thread, design and composer drafts during the app session.
The tabs support arrow keys, Home and End.

## Projects and threads

1. Open a project directory, or choose a recent project from the top-left picker.
2. Design opens the project's Files browser, with the same cards, view switcher and
   preview renderer as web. Create files and folders, rename items, or move files
   between folders. Grid view opens folders; list view expands their preloaded
   contents immediately. New file's menu imports a Tidy design JSON document. Documents use
   the same full editor as the web app. Edits, names and placed images persist
   immediately to local project storage. Web asset downloads are not yet an import path.
3. In Code, choose Codex or Claude Code, optionally attach design references, and
   start a thread. The harness runs in the project root and receives the attached
   design file paths. Follow-up messages resume that thread's exact harness session.
4. Stop cancels the active process and its commands. Closing the app stops active
   runs; an interrupted run is never silently restarted. Send a message to continue.

Tidy uses the installed CLIs and their existing sign-ins. Install and sign in to
Codex (`codex login`) or Claude Code (`claude auth login`), then use Check connection
in the composer. Credentials remain owned by each CLI and are never read or copied
by Tidy. The current integration uses Codex App Server over stdio and Claude Code
bidirectional streaming JSON; tests exercise both protocols with fixture executables, without paid inference.

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

Each thread card shows its last activity as `3m`, `6h` or `2d`. Use its tick-and-Done
action to move it into the collapsed Done section at the bottom of the sidebar.
Completed threads remain readable; click Done again to reopen one and continue
its original harness session. A harness finishing a turn does not mark a thread Done.

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

Press Enter to send; Shift+Enter adds a new line. Cmd/Ctrl+Enter also sends.
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
thread and apply to its next message while retaining its native session. Leave
the model or effort on Default to use the CLI's configuration. Settings cannot
change during a run. Checking models and limits never starts an inference turn.

Usage shows Codex account limits when available and recorded thread token counts
for either harness. Claude Code does not expose live account limits through its
connection; Open provider usage opens the appropriate provider page instead.
Reported API cost is an estimate, not a subscription charge or billing statement.
Hover or keyboard-focus a sidebar thread to see its title, latest reply, model,
effort, design references, activity and recorded usage without opening it.

The composer's Permissions menu applies to the selected thread and its next run.
Existing threads use Codex Default or Claude Accept edits unless explicitly changed.
Changing the model retains the permission selection. Settings cannot change while
the harness is running.

- Codex Default uses the workspace-write sandbox with on-request approvals routed
  to the user. Read only uses the read-only sandbox with on-request approvals.
- Claude Default prompts for actions needing permission; Accept edits allows file
  edits; Plan explores and asks before changes.
- Auto — Full access explicitly selects Codex's danger-full-access sandbox with
  approval policy never, or Claude's bypassPermissions with the required opt-in
  flag. Tidy's Auto label means full access, rather than Claude's separate native
  classifier-based auto mode. Native administrator requirements, deny rules and
  mandatory confirmation checks still apply; Tidy never silently answers prompts.

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
    threads/<id>.json  # Transcript, tool logs, native session ID and attachment references
    .gitignore        # Ignores local identity and private thread history
```

Design files and folder metadata can be versioned with the project. Moving a design
between folders retains its file path and existing thread references. Existing files
without folder metadata remain in Files.

Thread history stays on disk locally and is ignored by Git. The app's private user-data directory stores only recent
project locations. Agent changes to design JSON refresh the open canvas. Local
commits check the last disk version so an older edit cannot overwrite those changes.

Use Bun 1.3.14 and Node.js 22.12+ (Node.js 24 recommended). From the repository root:

```sh
bun install --frozen-lockfile
bun dev:desktop
```

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
notices; source code and local environment files are excluded. Packaging is separate
from the monorepo build. Release icons, installers, signing and notarization can be
configured when distribution is needed.

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
