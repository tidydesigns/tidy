import { z } from "zod";
import { remoteFrameSchema, type RemoteRequest } from "@tidy/agent-protocol/remote";
import {
  parseMobileResponse,
  type MobileOperation,
  type MobileResponse,
  type MobilePairing,
} from "@tidy/agent-protocol/mobile";
import type { DesktopEvent } from "@tidy/agent-protocol/contracts/desktop";

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "paused" | "blocked";
type Socket = Pick<WebSocket, "send" | "close" | "onopen" | "onmessage" | "onerror" | "onclose">;
type Pending = {
  request: RemoteRequest;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};
export class RemoteConnection {
  private socket?: Socket;
  private generation = 0;
  private active = false;
  private ready = false;
  private attempts = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private helloTimer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private pending = new Map<string, Pending>();
  private abort?: AbortController;
  constructor(
    readonly pairing: MobilePairing,
    private callbacks: {
      state(state: ConnectionState, message?: string): void;
      event(event: DesktopEvent): void;
      ready(): void;
    },
    private dependencies: { uuid(): string; fetch: typeof fetch; socket(url: string): Socket },
  ) {}
  start() {
    this.active = true;
    this.attempts = 0;
    void this.connect();
  }
  pause() {
    this.active = false;
    this.reset();
    this.callbacks.state("paused");
    // Accepted runs continue on the host. Pending requests retain their receipt IDs.
  }
  close() {
    this.pause();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Disconnected."));
    }
    this.pending.clear();
  }
  private reset() {
    this.generation++;
    this.ready = false;
    this.abort?.abort();
    clearTimeout(this.retryTimer);
    clearTimeout(this.helloTimer);
    clearInterval(this.heartbeat);
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }
  private reconnect(message = "Reconnecting to your machine…") {
    this.reset();
    if (!this.active) return;
    this.callbacks.state("reconnecting", message);
    this.retryTimer = setTimeout(
      () => void this.connect(),
      Math.min(15_000, 500 * 2 ** Math.min(this.attempts++, 5)),
    );
  }
  private block(message: string) {
    this.active = false;
    this.reset();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
    this.callbacks.state("blocked", message);
  }
  private async connect() {
    this.reset();
    if (!this.active) return;
    const generation = this.generation;
    this.callbacks.state(this.attempts ? "reconnecting" : "connecting");
    const abort = new AbortController();
    this.abort = abort;
    const timeout = setTimeout(() => abort.abort(), 10_000);
    try {
      const response = await this.dependencies.fetch(`${this.pairing.origin}/auth/ticket`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.pairing.token}`,
          "X-Tidy-Client": this.pairing.clientId,
        },
        signal: abort.signal,
        redirect: "error",
        credentials: "omit",
      });
      if (generation !== this.generation) return;
      if (response.status === 401 || response.status === 403) {
        this.block("Access was revoked or the host address changed. Pair this phone again.");
        return;
      }
      if (!response.ok) throw new Error("Host unavailable.");
      const { ticket } = z
        .object({ ticket: z.string().regex(/^[a-f0-9]{64}$/) })
        .parse(await response.json());
      if (generation !== this.generation) return;
      const socket = this.dependencies.socket(
        `${this.pairing.origin.replace(/^https:/, "wss:")}/events?ticket=${ticket}`,
      );
      this.socket = socket;
      this.helloTimer = setTimeout(() => this.reconnect(), 10_000);
      socket.onmessage = (message) => {
        if (generation !== this.generation) return;
        try {
          if (typeof message.data !== "string" || message.data.length > 32 * 1024 * 1024)
            throw new Error("Invalid frame.");
          const frame = remoteFrameSchema.parse(JSON.parse(message.data));
          if (frame.type === "hello") {
            if (frame.hostId !== this.pairing.hostId) {
              this.block("The machine identity changed. Pair again from the trusted machine.");
              return;
            }
            if (this.ready) return;
            clearTimeout(this.helloTimer);
            this.ready = true;
            this.attempts = 0;
            this.callbacks.state("connected");
            // Reuse request IDs: the host's durable receipts prevent duplicate mutations.
            for (const pending of this.pending.values())
              socket.send(JSON.stringify(pending.request));
            this.callbacks.ready();
            this.heartbeat = setInterval(() => {
              void this.request("ping", undefined, undefined, 10_000).catch(() => {
                if (generation === this.generation) this.reconnect();
              });
            }, 15_000);
          } else if (!this.ready) throw new Error("Missing host handshake.");
          else if (frame.type === "event") this.callbacks.event(frame.event);
          else {
            const pending = this.pending.get(frame.id);
            if (!pending) return;
            clearTimeout(pending.timer);
            this.pending.delete(frame.id);
            pending.resolve(frame.response);
          }
        } catch {
          this.block("This host uses an incompatible protocol. Update Tidy on both devices.");
        }
      };
      socket.onerror = () => {
        if (generation === this.generation) this.reconnect();
      };
      socket.onclose = () => {
        if (generation === this.generation) this.reconnect();
      };
    } catch {
      if (generation === this.generation)
        this.reconnect("Machine unreachable. Check Tailscale on both devices.");
    } finally {
      clearTimeout(timeout);
    }
  }
  request<N extends MobileOperation>(
    name: N,
    input?: unknown,
    options?: { id?: string; projectPath?: string },
    timeout = 90_000,
  ): Promise<MobileResponse<N>> {
    if (!this.active) return Promise.reject(new Error("Connect to your machine first."));
    if (this.pending.size >= 48)
      return Promise.reject(new Error("Too many requests. Try again shortly."));
    const id = options?.id ?? this.dependencies.uuid();
    if (this.pending.has(id)) return Promise.reject(new Error("This request is already pending."));
    return new Promise<unknown>((resolve, reject) => {
      const request = {
        id,
        name,
        input,
        ...(options?.projectPath ? { projectPath: options.projectPath } : {}),
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            "The machine has not confirmed this request. Reconnect and retry to check its receipt.",
          ),
        );
      }, timeout);
      this.pending.set(id, { request, resolve, reject, timer });
      if (this.ready) {
        try {
          this.socket?.send(JSON.stringify(request));
        } catch {
          this.reconnect();
        }
      }
    }).then((value) => parseMobileResponse(name, value));
  }
}
