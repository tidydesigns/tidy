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

## Packaging and verification

Packaging stages compiled output, metadata and licenses only. It enables ASAR-only
loading and disables RunAsNode, Node options, Node CLI inspection and extra file
protocol privileges. Embedded ASAR integrity is enabled on macOS and Windows;
Electron does not support that validation on Linux. Packaging fails if a fuse is
missing, so Electron upgrades require reviewing the fuse configuration.

The current package is for local development. Public distribution still requires
platform signing, macOS notarization, installer/update integrity and a maintained
release process. An unsigned package is not a public-release artifact.

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
