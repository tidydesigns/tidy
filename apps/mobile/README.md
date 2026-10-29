# Tidy mobile

An Expo app for iOS and Android. Browse remote projects, start and continue agent
threads, stream responses and tool activity, queue follow-ups, answer approvals,
choose an agent/model/access level, and stop runs. It uses the same protocol v3
workspace host and durable mutation receipts as Tidy desktop. Agent processes run
on the connected computer; the phone is the native client. Runs survive phone
sleep, app termination, and network loss.

The Files tab is a compact design workspace. Create frames, rectangles, and text;
pan, pinch to zoom, select and move layers; change bounds, fills and text; browse
pages/layers; and undo/redo. The bundled Expo DOM canvas uses the same
`@tidy/design-renderer` as desktop and web. Existing advanced document properties
remain intact; the phone inspector exposes a smaller set of editing controls.

## Cloud design files

Build the installed iOS or Android app with `bun mobile:ios` or
`bun mobile:android`, then choose **Files → Connect cloud → Sign in**. Use the
same Tidy account and workspace as desktop/web. Cloud OAuth requires this native
build because Expo Go cannot register the app's private callback scheme. The
browser preview supports local files through IndexedDB, but does not store cloud
tokens or offer cross-origin cloud sign-in.

- Cloud workspace files use the existing `/api/desktop` API, OAuth PKCE, and
  audience-bound `desktop:sync` scope. No new server deployment or database
  migration is required when running against the cloud implementation in main.
- Files created in a selected editable cloud workspace sync automatically.
  Device-only files can be connected with **Sync to workspace**.
- Opened files and downloaded images are durable in SQLite on native devices.
  They remain editable offline. Sync resumes while the app is active; the OS
  does not need to keep the app alive in the background.
- Local persistence precedes cloud mutations. The journal retains operation IDs
  across restarts and lost acknowledgements. Revision deltas merge independent
  changes; overlapping edits preserve the phone document for review. **Keep
  phone copy** creates a separately synced file, including its downloaded images.
- Cloud files and conflict copies stay bound to their cloud origin and account.
  Sign-out clears credentials and hides those cached files. Device-only files
  remain available. Credentials stay in SecureStore and never enter the canvas.
- Pull the file list to refresh it. The active file refreshes incrementally every
  five seconds; dirty files upload in the background. Closed clean documents
  are not polled.

**Run agent** attaches the current design and its images as a snapshot in the
selected remote machine project, then opens a new thread composer. This is an
explicit reference copy: agent changes to that remote copy are not automatically
written back into the original cloud file. Existing cloud editing sync remains
independent of Tailscale and the remote machine being awake.

## Run locally

From the repository root:

```sh
bun install
bun dev:mobile
```

Open the QR code using an Expo Go version supporting SDK 58, or build a native
development app with `bun mobile:ios` / `bun mobile:android` (requires Xcode /
Android Studio). The Metro development server must also be reachable from the
phone, usually over the same Wi-Fi. For access over the tailnet, set
`REACT_NATIVE_PACKAGER_HOSTNAME` to the development machine's Tailscale IP before
starting Metro. Metro serves development code, not agent credentials.

The web target (`bun run --cwd apps/mobile web`) is useful for layout review. It
does not persist pairing keys and is not a replacement for the native client:
the gateway does not allow cross-origin browser connections.

## Connect the existing remote machine

Use the computer you already connect to with Tidy over Tailscale. Sign in to
Tailscale on the phone using the same tailnet, and ensure its ACLs permit access
to the computer. Agent CLIs must be installed and signed in on that computer.

1. Keep Tidy desktop open on the computer, or run the existing standalone host.
   The mobile gateway discovers the existing runtime in
   `~/.local/state/tidy-host`; it does not create a second workspace. Set
   `TIDY_HOST_STATE` consistently when using a custom host state directory.
2. Start the loopback gateway **on that computer**, replacing the example with
   its actual MagicDNS HTTPS name (no trailing path):

   ```sh
   bun mobile:host serve https://computer.your-tailnet.ts.net
   ```

3. As the machine's operator, configure private HTTPS forwarding with
   [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve):

   ```sh
   tailscale serve --bg --https=443 http://127.0.0.1:4319
   ```

   This changes the machine's network configuration. Check existing Serve
   routes first and choose a separate HTTPS port if needed (use that same port
   in the gateway and pairing URLs). Serve requires tailnet HTTPS certificates.
   Use private Serve, never public Funnel. The implementation does not run this
   command or alter your existing Tailscale configuration automatically.

4. Generate a separate key for the phone:

   ```sh
   bun mobile:host pair https://computer.your-tailnet.ts.net
   ```

   Paste the complete JSON code into **Pairing code** in the app and tap
   **Connect machine**. Treat it as a password: it grants the same machine-level
   workspace access as a desktop SSH client. It is stored using iOS Keychain /
   Android encrypted storage. Do not commit, log, or share it. Use one pairing
   per phone; retain its non-secret `clientId` for revocation.

5. Choose a project, or open an absolute folder on the remote machine. Tap
   **+ Thread**, select your agent in **Options**, and send a prompt. Approval
   decisions and follow-ups operate on that same thread in desktop and mobile.

The gateway binds only `127.0.0.1:4319`, forwards only ticket authentication and
WebSocket traffic, checks the configured hostname and Origin, and leaves the
existing SSH host's trust rules unchanged. The app verifies the paired host ID.
Tickets are single-use; every operation still goes through the host's session,
project authorization, and receipt checks. No hosted API, database migration,
cloud deployment, or provider secret is needed on the phone.

## Disconnect and revoke

The connection indicator opens **Connection**. Disconnecting removes the local
credential and in-memory conversations. To revoke a lost phone or a copied key,
run on the host:

```sh
bun mobile:host revoke CLIENT_ID
```

The host invalidates the session on subsequent requests and heartbeats. Agent
runs continue until explicitly stopped. Stopping the gateway also disconnects
phones without stopping runs. It follows host port changes across restarts and
refuses a different host identity.

## Recovery and limitations

- Reconnect uses the same request ID for unconfirmed mutations. Retry delivery
  checks the host's durable receipt rather than submitting duplicate work.
- Returning to the app refreshes the selected project and conversation. Cached
  content stays visible during refresh and older replies cannot replace newer
  streaming revisions.
- Drafts and unconfirmed messages survive navigation and ordinary backgrounding
  in memory. Force-quitting discards those local drafts; accepted messages remain
  on the host. Reopen a thread before resending after a force quit.
- One machine connection is stored per phone. Background push notifications and
  arbitrary local filesystem access are not implemented.
- This checkout includes JavaScript exports for native builds; device signing,
  distribution, and Tailscale configuration remain operator setup steps.

## Checks

```sh
bun typecheck --filter=@tidy/mobile --filter=@tidy/desktop
bun lint --filter=@tidy/mobile --filter=@tidy/desktop --filter=@tidy/agent-protocol
bun run test --filter=@tidy/mobile --filter=@tidy/desktop
bun run build --filter=@tidy/mobile
bun run audit:dependencies
```

The integration tests connect the actual phone client through the gateway to a
temporary real workspace host, with a fake agent process. They cover streaming,
queueing, stop, reconnect, request deduplication, host pinning, and revocation.
They never use the operator's real workspace or Tailscale configuration.

With Bun 1.3.14's isolated linker, Expo Doctor can report two physical copies of
`expo-font@58.0.11` with identical peer versions. The app explicitly enables
[Expo's autolinking module resolution](https://docs.expo.dev/modules/autolinking/#working-around-duplicates)
so Metro and native builds use the same selected copy. React and React Native
resolve to one version in this app. Keep this compatibility check visible rather
than disabling it; reassess when upgrading Bun or Expo. On macOS, run tests with
`TMPDIR=/private/tmp` if `/tmp` symlink canonicalization affects existing desktop
filesystem assertions.
