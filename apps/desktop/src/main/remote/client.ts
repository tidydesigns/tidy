import { decodeBrowserFrame } from "../browser/frame-codec";
import {
  browserEventSchema,
  type BrowserScope,
  type BrowserOutput,
  type BrowserWatch,
} from "../../shared/contracts/browser";
import { RecoveryCache } from "./recovery-cache";
import { tailscaleVerificationSchema } from "./tailscale-verification";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { WebSocket } from "ws";
import { z } from "zod";
import {
  remoteFrameSchema,
  isRemoteMutation,
  requestReceiptSchema,
  type ConnectionStatus,
  type RemoteRequest,
  type RemoteMachine,
  type PreparedHost,
} from "../../shared/remote";
import type { DesktopEvent } from "../../shared/contracts/desktop";
import {
  parseWorkspaceResponse,
  WorkspaceRequestError,
  type WorkspaceOperation,
} from "../../shared/contracts/workspace-response";
import { browserRecovery } from "../../shared/runtime/browser-recovery";
import { SshSession } from "./ssh";
import { prepareHost } from "./bootstrap";
import { openTunnel } from "./tunnel";
import { MAX_REMOTE_BYTES } from "./host";
import { RemoteFailure, remoteFailure } from "./errors";

const CONNECTION_PROBE_TIMEOUT_MS = 15_000;
const QUICK_CONNECTION_PROBE_TIMEOUT_MS = 3_000;

export type RemoteConnection = {
  host: PreparedHost;
  origin: string;
  close(): void;
  onClose(listener: () => void): void;
};
export class RemoteClient {
  private socket?: WebSocket;
  private connection?: RemoteConnection;
  private pending = new Map<
    string,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
      mutation: boolean;
      recovering: boolean;
    }
  >();
  private retryTimer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private controller?: AbortController;
  private ssh?: SshSession;
  private prompt?: { id: string; resolve(value: string | null): void };
  private verification?: { id: string; url: string; timer: ReturnType<typeof setTimeout> };
  private stableTimer?: ReturnType<typeof setTimeout>;
  private online = true;
  private probeState?: {
    controller: AbortController;
    promise: Promise<void>;
    deadline: number;
    timer?: ReturnType<typeof setTimeout>;
    refresh: boolean;
    expire(): void;
  };
  private establishmentTimer?: ReturnType<typeof setTimeout>;
  private synchronizationTimer?: ReturnType<typeof setTimeout>;
  private suspendedAt?: number;
  private closed = false;
  private attempt = 0;
  private current: ConnectionStatus;
  private statusListeners = new Set<() => void>();
  private recovery;
  private recoveryWarning?: string;
  private hostId: string | null;
  private cache: RecoveryCache;
  constructor(
    private options: {
      machine: RemoteMachine;
      bundlePath: string;
      temporaryDirectory: string;
      event(event: DesktopEvent): void;
      statusChanged(status: ConnectionStatus): void;
      connected(hostId: string): Promise<void>;
      connector?: (input: {
        signal: AbortSignal;
        verify(url: string): void;
      }) => Promise<RemoteConnection>;
      sshConfigPath?: string;
      cachePath?: string;
    },
  ) {
    this.hostId = options.machine.hostId;
    this.cache = new RecoveryCache(options.cachePath, this.hostId);
    this.current = { kind: "preparing", target: options.machine.target, phase: "checking" };
    this.recovery = browserRecovery({
      bootstrap: () => this.operation("bootstrap"),
      snapshot: (id) => this.operation("project-snapshot", id),
      readThread: (projectId, threadId) => this.operation("read-thread", { projectId, threadId }),
      listener: (event) => {
        if (event.type !== "thread-summary") this.cache.receive(event);
        options.event(event);
      },
      trackedThreadsOnly: true,
      onError: () => {
        this.recoveryWarning =
          "Some project data could not be refreshed. Check that its folder is still available.";
      },
    });
  }
  watchBrowser(
    scope: BrowserScope,
    viewerId: string,
    receive: (event: BrowserOutput) => void,
  ): BrowserWatch {
    let closed = false;
    let socket: WebSocket | undefined;
    let connection: RemoteConnection | undefined;
    let generation = 0;
    let visible = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let opening: AbortController | undefined;
    const connect = () => {
      if (closed) return;
      if (this.current.kind !== "connected" || !this.connection) {
        generation++;
        opening?.abort();
        opening = undefined;
        socket?.terminate();
        socket = undefined;
        connection = undefined;
        receive({ kind: "disconnected", message: "Waiting for the remote machine…" });
        return;
      }
      if (connection && connection === this.connection) return;
      connection = this.connection;
      const active = connection;
      const version = ++generation;
      opening?.abort();
      const attempt = new AbortController();
      opening = attempt;
      socket?.terminate();
      socket = undefined;
      void (async () => {
        const health = await fetch(`${active.origin}/health`, {
          signal: AbortSignal.any([attempt.signal, AbortSignal.timeout(10000)]),
          redirect: "error",
        });
        const capabilities = z
          .object({ capabilities: z.array(z.string()).optional() })
          .parse(await health.json()).capabilities;
        if (closed || version !== generation) return;
        if (
          !capabilities?.includes("browser-v2") ||
          !capabilities.includes("browser-draft-discard")
        ) {
          receive({
            kind: "error",
            message:
              "This host needs a backend update for browser previews. Finish active work and reconnect the machine.",
          });
          receive({ kind: "disconnected", message: "Browser previews need a host update." });
          return;
        }
        const response = await fetch(`${active.origin}/auth/ticket`, {
          method: "POST",
          redirect: "error",
          headers: {
            Authorization: `Bearer ${active.host.token}`,
            "X-Tidy-Client": active.host.clientId,
          },
          signal: AbortSignal.any([attempt.signal, AbortSignal.timeout(10000)]),
        });
        if (!response.ok) throw new Error("Browser authentication expired. Reconnect the machine.");
        const { ticket } = z
          .object({ ticket: z.string().regex(/^[a-f0-9]{64}$/) })
          .parse(await response.json());
        if (closed || version !== generation) return;
        const params = new URLSearchParams({ ...scope, viewerId, ticket });
        const next = new WebSocket(
          `${active.origin.replace("http:", "ws:")}/browser-stream?${params}`,
          { maxPayload: 8 * 1024 * 1024, perMessageDeflate: false, handshakeTimeout: 15000 },
        );
        socket = next;
        let lastReceived = performance.now();
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        const received = () => {
          lastReceived = performance.now();
        };
        next.on("ping", received);
        next.on("pong", received);
        next.once("close", () => clearInterval(heartbeat));
        next.once("open", () => {
          if (closed || version !== generation) {
            next.terminate();
            return;
          }
          received();
          heartbeat = setInterval(() => {
            if (performance.now() - lastReceived >= 45000) next.terminate();
          }, 15000);
          heartbeat.unref();
          if (!closed && version === generation)
            next.send(
              JSON.stringify({
                tabId: null,
                viewId: null,
                input: { kind: "visibility", visible },
              }),
            );
        });
        next.on("message", (data, binary) => {
          if (closed || version !== generation) return;
          received();
          if (binary) {
            const frame = Array.isArray(data)
              ? Buffer.concat(data)
              : data instanceof ArrayBuffer
                ? Buffer.from(data)
                : data;
            const decoded = decodeBrowserFrame(frame);
            if (!decoded) next.terminate();
            else receive(decoded);
            return;
          }
          try {
            receive(browserEventSchema.parse(JSON.parse(data.toString())));
          } catch {
            next.terminate();
          }
        });
        const disconnected = () => {
          if (closed || version !== generation) return;
          generation++;
          socket = undefined;
          connection = undefined;
          receive({ kind: "disconnected", message: "Reconnecting to the browser…" });
          clearTimeout(retry);
          retry = setTimeout(connect, 1500);
        };
        next.once("close", disconnected);
        next.once("error", () => next.terminate());
      })().catch((error: unknown) => {
        if (closed || version !== generation) return;
        connection = undefined;
        receive({
          kind: "disconnected",
          message: error instanceof Error ? error.message : "Browser unavailable.",
        });
        clearTimeout(retry);
        retry = setTimeout(connect, 3000);
      });
    };
    this.statusListeners.add(connect);
    connect();
    return {
      input: (input) => {
        if (input.input.kind === "visibility") visible = input.input.visible;
        if (socket?.readyState !== WebSocket.OPEN) return;
        const bufferLimit = input.input.kind === "text" ? 4 * 1024 * 1024 : 128 * 1024;
        if (socket.bufferedAmount > bufferLimit) {
          socket.terminate();
          return;
        }
        socket.send(JSON.stringify(input));
      },
      close: () => {
        closed = true;
        generation++;
        opening?.abort();
        clearTimeout(retry);
        this.statusListeners.delete(connect);
        socket?.terminate();
      },
    };
  }

  get status() {
    return this.current;
  }
  private setStatus(value: ConnectionStatus) {
    this.current = value;
    this.options.statusChanged(value);
    for (const listener of this.statusListeners) listener();
  }
  private clearVerification() {
    if (this.verification) clearTimeout(this.verification.timer);
    this.verification = undefined;
  }
  private verify(url: string) {
    const controller = this.controller;
    if (!controller || this.closed) return;
    this.clearVerification();
    const id = randomUUID();
    this.verification = {
      id,
      url: tailscaleVerificationSchema.parse(url),
      timer: setTimeout(() => {
        this.fail(
          controller,
          new RemoteFailure(
            "authentication",
            "Tailscale verification expired. Retry to request a fresh link.",
          ),
        );
      }, 300_000),
    };
    this.setStatus({ kind: "verification", target: this.options.machine.target, requestId: id });
  }
  verificationURL(id: string) {
    if (this.current.kind !== "verification" || this.verification?.id !== id)
      throw new Error("This verification request has expired.");
    return tailscaleVerificationSchema.parse(this.verification.url);
  }
  cancelVerification(id: string) {
    this.verificationURL(id);
    if (this.controller)
      this.fail(
        this.controller,
        new RemoteFailure("cancelled", "Verification cancelled. Retry when you’re ready."),
      );
  }
  private phase(phase: Extract<ConnectionStatus, { kind: "preparing" }>["phase"]) {
    this.clearVerification();
    this.setStatus({ kind: "preparing", target: this.options.machine.target, phase });
  }
  authenticate({ promptId, answer }: { promptId: string; answer: string | null }) {
    if (!this.prompt || this.prompt.id !== promptId)
      throw new Error("This authentication request has expired.");
    this.prompt.resolve(answer);
    this.prompt = undefined;
  }
  private ask({ question, secret }: { question: string; secret: boolean }) {
    return new Promise<string | null>((resolve) => {
      const id = randomUUID();
      const previous = this.current;
      this.prompt?.resolve(null);
      const timer = setTimeout(() => {
        if (this.prompt?.id === id) {
          this.prompt.resolve(null);
          this.prompt = undefined;
        }
      }, 120_000);
      this.prompt = {
        id,
        resolve: (answer) => {
          clearTimeout(timer);
          if (!this.closed) this.setStatus(previous);
          resolve(answer);
        },
      };
      this.setStatus({
        kind: "authentication",
        target: this.options.machine.target,
        promptId: id,
        question,
        secret,
      });
    });
  }
  async operation<Name extends WorkspaceOperation>(
    name: Name,
    input?: unknown,
    context?: Pick<RemoteRequest, "projectPath" | "file">,
  ) {
    if (name !== "remove-project") return this.operationNow(name, input, context);
    const removal = await this.cache.prepareProjectRemoval(input);
    try {
      let result: ReturnType<typeof parseWorkspaceResponse<Name>>;
      try {
        result = await this.operationNow(name, input, context);
      } catch (error) {
        if (error instanceof WorkspaceRequestError) {
          let registered = false;
          try {
            const snapshot = parseWorkspaceResponse(
              "project-snapshot",
              await this.request("project-snapshot", input),
            );
            registered = snapshot.project.id === input && !snapshot.project.cloud;
          } catch {}
          if (registered) await removal.rollback();
        }
        throw error;
      }
      if (typeof input === "string") this.recovery.forget(input);
      return result;
    } finally {
      removal.finish();
    }
  }
  private async operationNow<Name extends WorkspaceOperation>(
    name: Name,
    input?: unknown,
    context?: Pick<RemoteRequest, "projectPath" | "file">,
  ) {
    await this.cache.ready;
    const cacheRevision = this.cache.revision;
    let result: ReturnType<typeof parseWorkspaceResponse<Name>>;
    try {
      result = parseWorkspaceResponse(name, await this.request(name, input, context));
    } catch (error) {
      const cached =
        !this.closed &&
        this.socket?.readyState !== WebSocket.OPEN &&
        ["preparing", "reconnecting", "offline"].includes(this.current.kind)
          ? this.cache.read(name, input)
          : undefined;
      if (!cached) throw error;
      const result = parseWorkspaceResponse(name, { ok: true, data: cached.data });
      if (name === "read-thread")
        this.recovery.rememberThread(
          parseWorkspaceResponse("read-thread", { ok: true, data: result }),
        );
      if (name === "bootstrap")
        this.recovery.remember(
          parseWorkspaceResponse("bootstrap", { ok: true, data: result }).activeProject,
        );
      if (name === "project-snapshot")
        this.recovery.remember(
          parseWorkspaceResponse("project-snapshot", { ok: true, data: result }),
        );
      return result;
    }
    this.cache.capture(name, input, result, cacheRevision);
    if (name === "bootstrap")
      this.recovery.remember(
        parseWorkspaceResponse("bootstrap", { ok: true, data: result }).activeProject,
      );
    if (
      [
        "read-thread",
        "start-thread",
        "send-message",
        "thread-settings",
        "rename-thread",
        "regenerate-thread-title",
        "set-thread-done",
        "respond-approval",
      ].includes(name)
    )
      this.recovery.rememberThread(
        parseWorkspaceResponse("read-thread", { ok: true, data: result }),
      );
    if (name === "open-project" || name === "select-project" || name === "project-snapshot")
      this.recovery.remember(parseWorkspaceResponse("open-project", { ok: true, data: result }));
    return result;
  }
  request(
    name: string,
    input?: unknown,
    context?: Pick<RemoteRequest, "projectPath" | "file">,
  ): Promise<unknown> {
    if (isRemoteMutation(name) && this.current.kind !== "connected")
      return Promise.reject(
        new Error(
          "Wait until the remote machine reconnects and finishes syncing before making changes.",
        ),
      );
    if (this.closed || this.socket?.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("Remote machine is disconnected. Wait for reconnection."));
    if (
      [...this.pending.values()].filter((item) => !item.recovering).length >= 64 ||
      this.pending.size >= 128
    )
      return Promise.reject(new Error("Too many pending requests."));
    const socket = this.socket;
    const id = randomUUID();
    const frame = JSON.stringify({ id, name, input, ...context });
    if (Buffer.byteLength(frame) > MAX_REMOTE_BYTES || socket.bufferedAmount > MAX_REMOTE_BYTES)
      return Promise.reject(new Error("The remote request is too large."));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(
            new Error(
              "Request timed out. It may have completed; check refreshed state before retrying.",
            ),
          );
          socket.terminate();
        },
        name === "setup-project" ? 330_000 : isRemoteMutation(name) ? 120_000 : 60_000,
      );
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        mutation: isRemoteMutation(name),
        recovering: false,
      });
      socket.send(frame, (error) => {
        if (error) socket.terminate();
      });
    });
  }
  private async prepare(signal: AbortSignal): Promise<RemoteConnection> {
    if (this.options.connector)
      return this.options.connector({ signal, verify: (url) => this.verify(url) });
    if (!this.ssh) {
      this.ssh = new SshSession({
        target: this.options.machine.target,
        temporaryDirectory: this.options.temporaryDirectory,
        prompt: (input) => this.ask(input),
        verify: (url) => this.verify(url),
        ...(this.options.sshConfigPath ? { configPath: this.options.sshConfigPath } : {}),
      });
      try {
        await this.ssh.initialize();
      } catch (error) {
        await this.ssh.close();
        this.ssh = undefined;
        throw error;
      }
    }
    const host = await prepareHost({
      ssh: this.ssh,
      bundlePath: this.options.bundlePath,
      clientId: this.options.machine.id,
      signal,
      progress: (phase) => {
        const parsed = z.enum(["checking", "installing", "starting"]).safeParse(phase);
        if (parsed.success) this.phase(parsed.data);
      },
    });
    if (this.hostId && this.hostId !== host.hostId)
      throw new RemoteFailure(
        "identity",
        "Backend identity changed. Verify the machine before removing and adding it again.",
      );
    this.phase("connecting");
    const tunnel = await openTunnel({ ssh: this.ssh, host, signal });
    return { host, ...tunnel };
  }
  start() {
    if (this.closed || this.controller) return;
    clearTimeout(this.retryTimer);
    const controller = new AbortController();
    this.controller = controller;
    this.phase("checking");
    void this.connect(controller).catch((error: unknown) => {
      if (this.closed || this.controller !== controller) return;
      this.fail(controller, remoteFailure(error));
    });
  }
  private async connect(controller: AbortController) {
    const connection = await this.prepare(controller.signal);
    if (controller.signal.aborted) {
      connection.close();
      return;
    }
    if (this.hostId && connection.host.hostId !== this.hostId) {
      connection.close();
      throw new RemoteFailure(
        "identity",
        "Backend identity changed. Verify this machine before reconnecting.",
      );
    }
    try {
      await this.options.connected(connection.host.hostId);
    } catch (error) {
      connection.close();
      throw error;
    }
    if (controller.signal.aborted) {
      connection.close();
      return;
    }
    await this.cache.ready;
    this.cache.identify(connection.host.hostId);
    this.hostId = connection.host.hostId;
    this.connection = connection;
    connection.onClose(() => {
      if (this.controller === controller)
        this.fail(controller, new RemoteFailure("unavailable", "SSH connection closed."));
    });
    this.establishmentTimer = setTimeout(() => {
      this.fail(
        controller,
        new RemoteFailure("unavailable", "The backend connection did not open in time."),
      );
    }, 15_000);
    const response = await fetch(`${connection.origin}/auth/ticket`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.host.token}`,
        "X-Tidy-Client": connection.host.clientId,
      },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      redirect: "error",
    });
    if (!response.ok)
      throw new RemoteFailure(
        response.status === 401 || response.status === 403 ? "authentication" : "unavailable",
        "Backend authentication failed. Retry to renew the SSH session.",
      );
    const { ticket } = z
      .object({ ticket: z.string().regex(/^[a-f0-9]{64}$/) })
      .parse(await response.json());
    const socket = new WebSocket(
      `${connection.origin.replace("http:", "ws:")}/events?ticket=${ticket}`,
      { maxPayload: MAX_REMOTE_BYTES, perMessageDeflate: false, handshakeTimeout: 15_000 },
    );
    this.socket = socket;
    controller.signal.addEventListener("abort", () => socket.terminate(), { once: true });
    socket.on("error", () => {});
    socket.once("close", () => {
      if (this.controller === controller)
        this.fail(
          controller,
          new RemoteFailure("unavailable", "Remote connection lost. Reconnecting…"),
        );
    });
    let greeted = false;
    let lastFrameAt = performance.now();
    const received = () => {
      lastFrameAt = performance.now();
    };
    socket.on("pong", received);
    socket.on("ping", received);
    socket.on("message", (data, binary) => {
      if (this.closed || this.controller !== controller) return;
      received();
      try {
        if (binary) throw new Error("Unexpected binary frame.");
        const frame = remoteFrameSchema.parse(JSON.parse(data.toString()));
        if (frame.type === "hello") {
          if (greeted || frame.hostId !== this.hostId)
            throw new Error("Unexpected remote identity.");
          greeted = true;
          clearTimeout(this.establishmentTimer);
          this.phase("syncing");
          this.heartbeat = setInterval(() => {
            if (performance.now() - lastFrameAt >= CONNECTION_PROBE_TIMEOUT_MS) {
              this.fail(
                controller,
                new RemoteFailure("unavailable", "The remote transport stopped responding."),
              );
            } else if (socket.readyState === WebSocket.OPEN) socket.ping();
          }, 5_000);
          this.synchronizationTimer = setTimeout(() => {
            this.fail(
              controller,
              new RemoteFailure("unavailable", "Remote state synchronization timed out."),
            );
          }, 75_000);
          this.recoveryWarning = connection.host.updatePending
            ? "A backend update is pending. Finish active runs, then reconnect to apply it."
            : undefined;
          void this.recovery
            .refresh(true)
            .then(async () => {
              void this.recoverRequests(controller);
              if (this.controller !== controller || this.closed) return;
              clearTimeout(this.synchronizationTimer);
              this.stableTimer = setTimeout(() => {
                if (this.controller === controller) this.attempt = 0;
              }, 30_000);
              this.setStatus({
                kind: "connected",
                target: this.options.machine.target,
                ...(this.recoveryWarning ? { warning: this.recoveryWarning } : {}),
              });
            })
            .catch((error: unknown) => {
              if (this.controller === controller) this.fail(controller, remoteFailure(error));
            });
        } else if (!greeted) throw new Error("Missing handshake.");
        else if (frame.type === "event") this.recovery.receive(frame.event);
        else {
          const item = this.pending.get(frame.id);
          if (item) {
            clearTimeout(item.timer);
            this.pending.delete(frame.id);
            item.resolve(frame.response);
          }
        }
      } catch {
        this.fail(
          controller,
          new RemoteFailure(
            "protocol",
            "The backend protocol or identity changed. Verify the installation before retrying.",
          ),
        );
      }
    });
  }
  private fail(controller: AbortController, failure: RemoteFailure, immediate = false) {
    if (this.controller !== controller) return;
    this.controller = undefined;
    clearTimeout(this.establishmentTimer);
    clearTimeout(this.synchronizationTimer);
    clearTimeout(this.probeState?.timer);
    this.probeState = undefined;
    this.recovery.cancel();
    this.clearVerification();
    clearTimeout(this.stableTimer);
    this.prompt?.resolve(null);
    this.prompt = undefined;
    controller.abort();
    this.socket?.terminate();
    this.socket = undefined;
    this.connection?.close();
    this.connection = undefined;
    clearInterval(this.heartbeat);
    for (const [id, item] of this.pending) {
      if (item.mutation && !this.closed && failure.kind === "unavailable") {
        item.recovering = true;
        continue;
      }
      this.pending.delete(id);
      clearTimeout(item.timer);
      item.reject(
        new Error(
          "Connection lost. The operation may have completed; check refreshed state before retrying.",
        ),
      );
    }
    if (this.closed) return;
    const message = failure.message;
    if (failure.kind !== "unavailable") {
      this.setStatus({
        kind: "blocked",
        target: this.options.machine.target,
        message,
        reason: failure.kind,
      });
      return;
    }
    if (!this.online) {
      this.setStatus({
        kind: "offline",
        target: this.options.machine.target,
        message: "You’re offline. Reconnecting when the network returns.",
      });
      return;
    }

    this.setStatus({
      kind: "reconnecting",
      target: this.options.machine.target,
      message,
      attempt: ++this.attempt,
    });
    this.retryTimer = setTimeout(
      () => this.start(),
      immediate
        ? 0
        : Math.round(
            Math.min(300_000, 1000 * 2 ** Math.min(this.attempt, 9)) * (0.5 + Math.random() * 0.5),
          ),
    );
  }
  private async recoverRequests(controller: AbortController) {
    const pending = [...this.pending].filter(([, request]) => request.recovering);
    await Promise.all(
      pending.map(async ([id, item]) => {
        try {
          while (this.controller === controller && this.pending.get(id) === item) {
            const envelope = z
              .object({ ok: z.literal(true), data: requestReceiptSchema })
              .parse(await this.request("receipt", id));
            const receipt = envelope.data;
            if (receipt.kind === "complete") {
              clearTimeout(item.timer);
              this.pending.delete(id);
              item.resolve(receipt.response);
              return;
            }
            if (receipt.kind === "missing" || receipt.kind === "interrupted")
              throw new Error(
                "The operation’s result could not be confirmed. Check the refreshed workspace before retrying.",
              );
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        } catch (error) {
          if (this.controller !== controller || this.pending.get(id) !== item) return;
          clearTimeout(item.timer);
          this.pending.delete(id);
          item.reject(
            error instanceof Error ? error : new Error("Could not recover the operation."),
          );
        }
      }),
    );
  }
  suspend() {
    this.suspendedAt = Date.now();
    clearInterval(this.heartbeat);
  }
  wake(
    reason: "active" | "active-probe" | "resume" | "network" | "network-changed",
    online = true,
  ) {
    if (this.closed) return;
    if (reason === "network") this.online = online;
    const slept = this.suspendedAt !== undefined;
    this.suspendedAt = undefined;
    if (
      this.current.kind === "blocked" ||
      this.current.kind === "authentication" ||
      this.current.kind === "verification"
    )
      return;
    if (reason !== "network" || online) this.attempt = 0;
    if (this.current.kind === "connected") {
      if (slept || reason === "resume") {
        this.online = true;
        if (this.controller)
          this.fail(
            this.controller,
            new RemoteFailure("unavailable", "Restoring the connection after sleep…"),
            true,
          );
      } else if (reason !== "network" || !online) {
        void this.probe(
          reason === "active" || reason === "active-probe",
          reason === "active" ? CONNECTION_PROBE_TIMEOUT_MS : QUICK_CONNECTION_PROBE_TIMEOUT_MS,
        );
      }
    } else if (!this.controller) {
      clearTimeout(this.retryTimer);
      if (this.online || reason === "resume") {
        this.online = true;
        this.start();
      } else
        this.setStatus({
          kind: "offline",
          target: this.options.machine.target,
          message: "You’re offline. Reconnecting when the network returns.",
        });
    }
  }
  private probe(refresh = true, timeoutMs = CONNECTION_PROBE_TIMEOUT_MS): Promise<void> {
    const controller = this.controller;
    if (!controller || this.socket?.readyState !== WebSocket.OPEN) return Promise.resolve();
    const deadline = performance.now() + timeoutMs;
    const previous = this.probeState;
    if (previous?.controller === controller) {
      previous.refresh ||= refresh;
      if (deadline < previous.deadline) {
        previous.deadline = deadline;
        clearTimeout(previous.timer);
        previous.timer = setTimeout(previous.expire, Math.max(0, deadline - performance.now()));
      }
      return previous.promise;
    }
    let expire = () => {};
    const timedOut = new Promise<never>((_resolve, reject) => {
      expire = () => reject(new Error("Connection probe timed out."));
    });
    const state = {
      controller,
      deadline,
      refresh,
      expire,
      timer: setTimeout(expire, timeoutMs),
      promise: Promise.resolve(),
    };
    this.probeState = state;
    state.promise = Promise.race([this.request("ping"), timedOut])
      .then(async () => {
        clearTimeout(state.timer);
        if (this.probeState === state) this.probeState = undefined;
        if (this.controller === controller) {
          this.online = true;
          if (state.refresh) await this.recovery.refresh();
        }
      })
      .catch(() => {
        if (this.controller === controller)
          this.fail(
            controller,
            new RemoteFailure("unavailable", "Restoring the remote connection…"),
          );
      })
      .finally(() => {
        clearTimeout(state.timer);
        if (this.probeState === state) this.probeState = undefined;
      });
    return state.promise;
  }
  retry() {
    if (this.closed) return;
    if (this.current.kind === "connected") {
      void this.probe(false, QUICK_CONNECTION_PROBE_TIMEOUT_MS);
      return;
    }
    this.attempt = 0;
    this.ssh?.resetAuthentication();
    this.online = true;
    if (!this.controller) this.start();
  }
  flush() {
    return this.cache.flush();
  }
  close() {
    void this.cache.close().catch(() => {});
    this.closed = true;
    this.prompt?.resolve(null);
    this.prompt = undefined;
    clearTimeout(this.establishmentTimer);
    clearTimeout(this.synchronizationTimer);
    clearTimeout(this.probeState?.timer);
    this.probeState = undefined;
    this.recovery.close();
    clearTimeout(this.retryTimer);
    if (this.controller) this.fail(this.controller, new RemoteFailure("cancelled", "Closed."));
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(
        new Error("The window closed. Check the remote workspace for the operation’s result."),
      );
    }
    this.pending.clear();
    void this.ssh?.close();
    this.setStatus({ kind: "closed", target: this.options.machine.target });
  }
}
