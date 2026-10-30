# Remote machines over SSH

The remote backend, automatic SSH bootstrap, reconnection and machine-scoped IPC are implemented.
Open **Settings → Remote machines**, enter an SSH alias or `user@hostname`, and choose
**Connect**. Settings shows installation progress, authentication prompts, browser verification,
and connection status, with **Retry** and **Remove** actions. Connecting does not switch the current chat.

## Choose where a thread runs

In a new thread, use **Run on** beside the branch to select a connected machine. A matching
registered checkout opens automatically. Otherwise, choose an existing folder on that host or
clone the repository there. SSH and HTTPS URLs for the same repository match; forks remain
separate through their primary remote. Automatic matching also checks the folder path inside
the repository, so different folders in a monorepo stay separate. Multiple matching checkouts require a choice.
Matching folder associations are remembered on this desktop. A folder with a different repository
can open as a separate project after confirmation. Projects without a Git remote remain separate.
If the destination already has a draft, choose whether to keep it or replace it with the incoming draft.

The prompt and model selection stay with the draft. Selected design references, their images,
and attachments are copied into the destination project with new host-local IDs. No other
project files, environment files, credentials, dependencies or processes are transferred.

Reference transfers are limited to 28 MB per batch. The destination stages the complete batch
before publishing it with new IDs. Failed imports remove only their own files; private ownership
records let the backend clean up interrupted imports when the project is opened again. Project
access is checked again before publication and commit. Setup stays open during the final import.
If the connection drops, the existing command receipt recovers its result without repeating it.
Cloning uses Git credentials already configured on the destination and never replaces an
existing folder. Closing a cloning dialog leaves that operation running in the background.

Existing threads stay on their original machine. The workspace menu offers **Projects on…**
to navigate between machines without moving a thread. Workspace state and navigation are
isolated per machine; offline destinations never fall back to local execution.

The remote machine owns repositories, agent processes, CLI sign-ins and thread state:

`Desktop → loopback HTTP/WebSocket → OpenSSH forwarding over Tailscale → loopback backend → agents`

## Prerequisites

- macOS or Linux desktop client with OpenSSH and curl. The remote desktop/server can be
  macOS (Intel or Apple silicon), or Linux x64/arm64 with glibc. It needs a POSIX shell,
  tar, base64, curl or wget, and SHA-256 tools (shasum on macOS; sha256sum on Linux).
- Tailscale installed and signed in on both machines. Configure either
  [Tailscale SSH](https://tailscale.com/docs/features/tailscale-ssh) or
  [OpenSSH over Tailscale](https://tailscale.com/docs/reference/ssh-over-tailscale).
  Use the tailnet hostname/address or an alias that resolves to it.
- Codex or Claude Code installed and signed in as the remote user. Put repositories
  on that machine, or clone them through project setup. Tidy does not copy local CLI credentials.
- HTTPS access to nodejs.org on first installation. Node and Bun need not be installed
  beforehand on the host.

SSH aliases use the system SSH configuration, including identity files, users and ports.
Discovery APIs return SSH aliases, known hosts and macOS/Linux machines from the local
Tailscale client. Discovery is optional and never changes Tailscale settings. Password,
passphrase, host verification and Tailscale check-mode requests are exposed as connection
states in Settings. Changed host keys are rejected.
Verification links stay in the main process and only HTTPS links to the Tailscale login
verification path are accepted. Cancel or a five-minute expiry stops automatic retries.
Device login/key expiry is separate: open the Tailscale app to sign in again.
`ssh user@home-desktop` remains the diagnostic for access or policy problems.

## Setup and lifecycle

The desktop carries its backend bundle. Over SSH it uploads that bundle, validates its
SHA-256, downloads the pinned Node 24.22.1 runtime for the remote operating system and CPU, verifies the platform-specific
SHA-256 and smoke-tests the installation. A private staging directory and installation
lock prevent incomplete installs from being used. Runtime directories are keyed by the
backend bundle checksum under `~/.local/share/tidy/runtime`.

The launcher serializes startup, reuses a healthy backend, and otherwise starts a detached
process listening only on `127.0.0.1` at an automatically chosen port. It returns the
port, persistent host identity and a private session credential over SSH. The desktop
opens an SSH local forward, verifies the backend instance, authenticates with the session,
and exchanges a short-lived, single-use ticket for its WebSocket connection.

Managed backends upgrade automatically when idle. Active runs and in-flight requests
prevent an update; the connection status includes a deferred-update warning. Externally managed
backends are left running. A backend that is alive but unresponsive is also left running
rather than killed speculatively. The launcher never restarts agents to fix a client
connection.

Remote client disconnection leaves the backend and its agents running. Transport pings run
at five-second intervals; fifteen seconds without a frame triggers reconnection. Application
probes run on lifecycle signals rather than a second polling loop: becoming active allows
fifteen seconds, while an explicit retry, an offline notification, a network-path change or
a quick activation probe allows three seconds. A quick signal shortens an in-flight probe;
later signals never extend its deadline or launch duplicate probes. A reported-online signal
preserves an existing healthy connection. Sleep/resume replaces the session immediately.

Network events are forwarded by the preload bridge without adding visible UI. Offline reports
are treated as hints: an answering connection is retained. Authentication, identity and protocol
failures remain blocked until explicitly retried. Backoff uses equal jitter starting at one to
two seconds, doubles to a maximum range of 150–300 seconds, and resets after thirty stable
seconds. A healthy-session Retry probes without resetting the backoff of a later failure.

Opening the backend connection has a fifteen-second budget after SSH preparation. Initial
state synchronization has a separate seventy-five-second budget. Recovery cancels stale
connection generations, refreshes project/thread summaries, and reads at most the thirty-two
most recently observed thread histories with at most four reads in flight. Unobserved histories
are loaded on demand. Unavailable projects produce a partial-recovery warning.

Private versioned caches retain the last received bootstrap, project snapshots and observed
threads across client restarts. Each machine cache is pinned to backend identity, limited to
64 entries and 8 MiB, and stored with private permissions under the desktop user-data directory.
Cached reads are available while disconnected; mutations still require a synchronized live
connection. Live approvals and native session IDs are excluded from cached thread details.
Corrupt or incompatible caches are ignored, and forgetting a machine removes its cache.

Password and passphrase answers are cached only in memory and reused once per SSH command.
Rejected answers are discarded, with at most two fresh secret prompts per command. One-time
codes are never cached. Cancellation stops retries; Retry clears cached credentials. Backend
sessions are renewed through the authenticated SSH setup path. Tailscale account/device
reauthorization remains in the Tailscale app; SSH check-mode browser approval is exposed through the verification API. Provider CLI sign-in remains on the remote machine.

Mutations receive a UUID and a durable, private receipt before execution. Reconnecting
clients retrieve completed results instead of resending commands. Pending work continues
while the rest of the workspace becomes available. Receipts survive backend restart and
are scoped to the authenticated client. Project results carry their project ID and require
current project access on receipt lookup, identical resubmission and socket delivery.
Signing out, switching accounts or withdrawing workspace access also blocks stored results
once the desktop's account state reflects that change. Backend sessions authenticate the
machine connection separately from cloud permissions; signing out does not revoke SSH
access or local workspace access. Older receipts without a recorded scope withhold their
results while retaining replay protection. If the backend died between changing workspace
state and storing its result, the outcome is explicitly unconfirmed and is never replayed.
This is not an atomic transaction between workspace files and command receipts. Completed receipts are retained for twenty-four hours and pruned at startup and hourly.
Pending receipts remain available to identify interrupted operations. Expired results are
reported as unconfirmed; the client never resends those mutations automatically.

The backend is **not** installed as an OS boot service. Reconnecting starts it after a
reboot or crash, but active jobs do not survive backend or machine restarts. A small process
supervisor terminates an agent's process group when its controlling backend dies. Commands
that deliberately create their own sessions can escape that process group. Recovery marks
unfinished threads/tools interrupted, clears stale approvals and advances thread revisions.
Continuing after a backend restart requires a new message; no approvals or prompts are
replayed automatically. A machine
must remain awake and online. Boot supervision, mobile/browser clients and Windows clients
are outside this implementation. Remote macOS installation is implemented but still requires
validation on physical Intel and Apple silicon Macs.

## Local desktop and remote backend reuse

Both entry points publish the same private runtime descriptor. The desktop attaches to a
healthy existing backend instead of creating a second workspace service. If no server exists,
it hosts its local workspace service and publishes it so SSH clients can reuse it. Startup is
serialized with the same launch/host locks used by the headless entry point. A live but
unresponsive backend is left running.

The shared project registry and private thread authority live in the host state directory.
The first desktop start copies its legacy private registry/authority there only if no shared
registry exists. The original files are retained. Shared state is never overwritten by a later
migration. Both clients therefore see the same projects and running agents. Local requests retain their
direct IPC path when the desktop owns the service. Cloud sync and native update coordination
remain desktop-owned; attaching to a standalone backend does not move those coordinators
to the server. Cloud workspace opening, cloud file mutations and sync are unavailable
while attached to an independently managed local backend. Those operations fail before
accessing a second workspace store. Account and library metadata remain available. To use
cloud workspaces, let background agents finish, stop that local backend and reopen Tidy
so the desktop owns its workspace service. Agent and desktop update installation is also
blocked for a desktop started in attached mode: that process cannot reserve maintenance
against the authoritative backend. Version discovery still runs. These restrictions remain
until restart, even if reconnection later creates a desktop-owned backend.

Desktop IPC and remote workspace requests share a shutdown fence. Once closing begins,
new workspace requests are rejected. Accepted requests finish before the final service flush
and ownership release. A stalled request exhausts the shutdown drain deadline and leaves
ownership held until process exit. Desktop cloud coordination stops before backend teardown.

An attached desktop does not stop an independently managed backend when it exits. If the
desktop itself owns the backend, quitting it closes that service and its runs, matching its
existing local process lifetime. Use the detached headless backend when jobs must outlive
that desktop process. Headless hosts supervise their agent process groups; desktop-owned
services retain the existing local launcher behavior.

## Security and storage

- Backend traffic stays on loopback and crosses machines through SSH. No Tailscale Serve,
  public backend port, router forwarding or cloud relay is required. Tidy does not modify
  Tailscale policies, firewall rules or SSH server configuration.
- Browser origins are rejected. Workspace requests require an authenticated WebSocket;
  tickets expire after 30 seconds and cannot be reused. Sessions are revalidated for
  requests and periodically for open connections. Payloads and concurrent requests are bounded.
- Credentials remain in the Electron main process. SSH secrets are held only in memory
  for the connection lifetime. Backend session files are 0600 in private state directories.
  Saved desktop machine profiles contain destinations and identities, not session tokens.
- A changed backend identity blocks reconnection until the machine is verified and its
  saved entry removed and re-added. Forgetting closes the local connection; it does not
  stop the server, erase projects, or revoke SSH access.
- SSH access as a user already grants that user's filesystem and command privileges.
  This is a personal-machine connection, not a sandbox between mutually untrusted users.
- SQLite ownership locks prevent concurrent current Tidy runtimes from using the same
  canonical project path, and release on process exit. Older releases do not participate.
- Backend state and logs live in `~/.local/state/tidy-host`; project locks live in
  `~/.local/state/tidy-project-locks`. Project content stays in the project's `.tidy` directory.
  Desktop profiles are in `remote-machines.json` in Electron's user-data directory.

For diagnostics, inspect `~/.local/state/tidy-host/server.log`. The installed runtime
supports `version`, `serve`, `ensure CLIENT_UUID`, and `revoke CLIENT_UUID` commands.
`ensure` prints credentials: do not paste its output into issue reports or logs.

## Test connection recovery on one machine

Run the automated Electron integration test from the repository root:

```sh
bun run --cwd apps/desktop test:remote
```

It exercises the real preload bridge, validated IPC, authenticated HTTP/WebSocket transport,
private sessions, separate project stores and command receipts. SSH connection establishment and
agent execution are simulated in this test; the SSH integration investigation uses a real local
SSH server. Neither requires model credentials or a second physical computer.

The Electron test checks identical thread IDs on different machines, event isolation, rejected
remote mutations while disconnected, continued local work, unknown-machine rejection, continued
agent execution, reconnect without duplicate execution, and authentication recovery.

Workspace requests carry a stable saved machine ID through validated IPC. Unknown machines are
rejected rather than falling back to local execution. Events carry the same machine ID. The
connection layer separately pins backend identity. Project setup and draft transfer use the same
authenticated request boundary and project access checks.

Physical sleep/wake, platform-specific behavior and actual tailnet policies still require
cross-device testing.

## Shared browser on a remote host

The browser runs on the selected project's host, so `localhost:3000` reaches that
host's development server. Frames and input use an authenticated WebSocket over the
existing SSH forward; development-server ports need no additional forwarding.
Credentials stay in Electron main, and pages run in sandboxed Chrome outside the
Tidy renderer. Hosts advertise `browser-v2` and `browser-draft-discard`; older backends
show an update message.
Finish active runs and close browser tabs before restarting a backend to update it.

Disconnecting or switching machines leaves host tabs open. Reconnection restores a
fresh frame and requires taking control again. Old input is never replayed, and input
is bound to its tab and view. Hidden previews pause capture; bounded queues prevent
slow viewers from accumulating frames. Revoking a host session closes its viewers.

Uploads transfer only files selected on the client. Downloads stay in private host
temporary storage until saved to a client-side destination. Neither flow accepts
arbitrary host paths. Closing a tab removes its staged files. Threads have separate
browser contexts and do not import the host's normal browser profile.

Agent access uses a private, short-lived curl configuration referenced by the turn
prompt. Each turn receives fresh access; ending it revokes access and removes the
configuration. Dialog responses are bound to the pending dialog.

Integration checks cover local and authenticated remote Electron workflows, delayed
frames and reconnection over loopback. Physical macOS input, display scaling and
cross-device sleep/wake still require hardware validation.

Browser streams reuse successful credential checks for up to one second to avoid
reading the session file for every frame and input acknowledgement. Revoking a
session through the host invalidates that cache immediately, including checks
already in flight. External session-file changes are rechecked within one second
of subsequent stream traffic.
