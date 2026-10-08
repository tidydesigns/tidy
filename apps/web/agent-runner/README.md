# Tidy Codex runner

The web app stores shared threads and authorises all tools. This separate Bun
service runs Codex app-server **0.160.0**, with a private native Codex account
store for each Tidy user. The web Worker does not spawn processes.

This runner supports native device-code sign-in. Commercial ChatGPT plan sharing
is not implemented.

## Local setup

1. Use a disposable local Postgres database and the repository's local setup
   script, including `migrations/20261005-agent-threads.sql`.
2. Install Bun 1.3.14 and `npm install --global @openai/codex@0.160.0`.
3. Copy this directory's `.env.example` to `.env.local`. Choose an empty, private
   absolute `AGENT_RUNTIME_DIRECTORY`. Never point it at your personal Codex home.
4. Generate a random service secret of at least 32 characters and set the same
   `AGENT_RUNNER_SECRET` in the runner and `apps/web/.env.local`. Set
   `AGENT_RUNNER_URL=http://127.0.0.1:8790` in the web app and
   `AGENT_TIDY_URL=http://localhost:3000` in the runner.
5. Set web `TIDY_AGENTS_ENABLED=true` and `AGENT_MODEL` to an identifier supported
   by the connected account. The runtime rejects fallback to an unrelated model.
6. From the repo root, run `bun agents:runner`, then `bun dev` separately.
7. Open Settings → Agents → Connect Codex. Enter the displayed code on the
   official Codex sign-in page. Threads can then start runs on attached files.

The native sign-in flow uses `account/login/start` (`chatgptDeviceCode`),
`account/read`, and `account/logout`. Codex owns its credential files and renewal.
No existing personal credential files are copied or parsed by Tidy. No API key is
requested. Settings → Agents is the connection's only management home.

## Runtime boundary

- Deploy one runner service with its own encrypted persistent volume. Account
  directories are private (`0700`). Do not mount application secrets or the
  personal/home directory of an operator into this container.
- The Dockerfile is built from the repository root. Supply runner variables at
  runtime; exclude local environment files from the Docker build context. Run
  behind a private HTTPS endpoint reachable by the web app. No browser accesses
  this endpoint, and every request requires the runner-specific secret.
- The secret grants the trusted orchestration service access to the internal
  agent API, not database or general Tidy APIs. Codex subprocesses receive neither
  this secret nor database credentials. Tool arguments cannot choose a user.
- Every model thread disables environment access, shell tools and native child
  agents. Unknown server-initiated operations are rejected. Managed children are
  separate threads, all bound to the run owner. This is not a general shell or
  repository execution environment.
- Every tool checks current membership, connection, immutable file scope and
  execution generation. A tool write and its duplicate-call receipt commit in
  the same database transaction. Stop waits for any already admitted commit,
  then fences all later commits. Inference is interrupted at the next heartbeat.
- Six agents includes the lead. Reserve at most twelve agents per owner and
  thirty-six per organisation; each owner can have at most three active threads.
  Viewing work never triggers inference. Messages and cursor activity contain no
  credentials or hidden reasoning.
- A runner outage expires its lease after 45 seconds. Interrupted runs retain
  output and committed edits, and require an explicit new prompt; they are not
  silently replayed. No API billing or teammate-account fallback exists.

## Capabilities and limits

The canvas integration reuses the shared MCP registry, scoped to attached files.
The composer’s collapsed Tool access option explicitly permits new files and
folder changes in the organisation. Created files become part of that run’s
scope. GitHub tools retain their existing connection and repository checks; they
record local review data and do not post externally. Repository execution and
rendering a fresh screenshot need separate runtime capabilities. `get_file_image` returns
existing referenced assets; it is not a live canvas screenshot. Structural
validation must not be described as visual verification.

Threads use ordered, authorised event polling, coalesced text checkpoints and
snapshot recovery. Canvas presence uses the existing realtime file rooms. Worker
questions go through the lead. Instructions are delivered at a turn boundary or
in response to a lead question. There is no token streaming into React artwork.

## Verification

- `bun test:agents`: owns and removes a disposable local Postgres cluster; covers
  scope, admission, receipts, rollback, revocation, stopping and expiry.
- `bun test apps/web/agent-runner`: fake Codex protocol drives a six-agent swarm
  and two teammate threads; checks routing, visible messages and image results.
- `bun test:agents:browser`: uses a built app and disposable Postgres to check two
  viewers, owner controls, updates, stopping, drafts and the mobile editor panel.
- `bun typecheck`, `bun lint`, `bun test`, `bun build`: repository checks.
