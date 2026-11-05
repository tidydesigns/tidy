import { z } from "zod";
import {
  HarnessNotSubmittedError,
  HarnessTransport,
  type HarnessChannel,
  type ProtocolMessage,
  object,
} from "./harness-transport";
import type { SessionContext } from "./session-types";

type ServerContext = SessionContext & { projectId: string };
const threadResponse = z.object({ thread: z.object({ id: z.string().min(1).max(512) }) });
const routing = z.object({
  threadId: z.string().optional(),
  requestId: z.union([z.string(), z.number()]).optional(),
});

class CodexChannel implements HarnessChannel {
  private closed = false;
  private completion = Promise.withResolvers<void>();
  readonly done = this.completion.promise;
  threadId?: string;
  onMessage: HarnessChannel["onMessage"] = () => {};
  onClose: HarnessChannel["onClose"] = () => {};

  constructor(
    private server: CodexAppServer,
    private context: ServerContext,
  ) {}
  private dispose() {
    this.context.mcp?.close();
    this.context.onExit?.();
  }
  get available() {
    return !this.closed && this.server.available;
  }
  async request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    if (!this.available) throw new HarnessNotSubmittedError("The harness connection closed.");
    if (method === "thread/resume") {
      const { threadId } = z.object({ threadId: z.string().min(1).max(512) }).parse(params);
      this.server.bind(this, threadId);
      this.threadId = threadId;
    }
    if (method !== "initialize" && method !== "thread/start" && method !== "thread/resume") {
      const { threadId } = z.object({ threadId: z.string() }).parse(params);
      if (threadId !== this.threadId)
        throw new Error("This request belongs to another Codex thread.");
    }
    if (method === "thread/start" || method === "thread/resume") {
      const input = object(params);
      params = {
        ...input,
        config: {
          ...object(input.config),
          ...(this.context.environment
            ? { "shell_environment_policy.set": this.context.environment }
            : {}),
          ...(this.context.mcp
            ? {
                "mcp_servers.tidy": {
                  url: this.context.mcp.url,
                  http_headers: { Authorization: `Bearer ${this.context.mcp.token}` },
                  default_tools_approval_mode: "approve",
                },
              }
            : {}),
        },
      };
    }
    const result = await (method === "initialize"
      ? this.server.initialize(params)
      : this.server.transport.request(method, params, timeoutMs));
    if (method === "thread/start" || method === "thread/resume") {
      const { thread } = threadResponse.parse(result);
      if (!this.available) {
        await this.server.unsubscribe(thread.id);
        throw new HarnessNotSubmittedError("The harness connection closed.");
      }
      this.server.bind(this, thread.id);
      this.threadId = thread.id;
    }
    return result;
  }
  // The shared server owns the connection handshake; adapters still own thread setup.
  write(value: unknown) {
    const notification = z.object({ method: z.literal("initialized") }).safeParse(value);
    return notification.success && this.available;
  }
  notify(method: string, params: unknown) {
    return this.write({ method, params });
  }
  respond(id: unknown, result: unknown) {
    return this.server.respond(this, id, result);
  }
  reject(id: unknown, message: string) {
    return this.server.reject(this, id, message);
  }
  close(force = false) {
    if (this.closed) return;
    if (force) this.server.close();
    else {
      this.closed = true;
      this.onClose(new Error("The harness session closed."));
      void this.server.release(this).finally(() => {
        this.dispose();
        this.completion.resolve();
      });
    }
  }
  disconnected(error: Error) {
    if (this.closed) return;
    this.closed = true;
    this.onClose(error);
    this.dispose();
    void this.server.transport.done.then(() => this.completion.resolve());
  }
}

class CodexAppServer {
  readonly transport: HarnessTransport;
  private channels = new Set<CodexChannel>();
  private threads = new Map<string, CodexChannel>();
  private requests = new Map<unknown, CodexChannel>();
  private initialization?: Promise<unknown>;
  private timer?: ReturnType<typeof setImmediate>;
  private spawn?: { pid: number; supervised?: boolean };
  private stopped = false;
  private retiring = false;
  constructor(readonly context: ServerContext) {
    this.transport = new HarnessTransport({
      executable: context.executable,
      cwd: context.cwd,
      superviseParent: context.superviseParent,
      args: ["app-server", "--listen", "stdio://"],
      protocol: "jsonrpc",
      onSpawn: (pid, supervised) => {
        this.spawn = { pid, supervised };
      },
    });
    // Resolve RPC promises before delivering notifications from the same stdout chunk.
    // No handler awaits work on the reader, and each stream chunk drains before the next.
    this.transport.onMessage = (message) => queueMicrotask(() => this.deliver(message));
    this.transport.onClose = (error) => {
      this.stopped = true;
      clearImmediate(this.timer);
      for (const channel of this.channels) channel.disconnected(error);
      this.channels.clear();
      this.threads.clear();
      this.requests.clear();
    };
  }
  get available() {
    return !this.stopped && this.transport.available;
  }
  get accepting() {
    return this.available && !this.retiring;
  }
  retire() {
    this.retiring = true;
    if (this.idle) this.close();
  }
  get idle() {
    return this.channels.size === 0;
  }
  acquire(context: ServerContext) {
    clearImmediate(this.timer);
    const channel = new CodexChannel(this, context);
    if (this.spawn) context.onSpawn?.(this.spawn.pid, this.spawn.supervised);
    this.channels.add(channel);
    return channel;
  }
  initialize(params: unknown) {
    return (this.initialization ??= this.transport
      .request("initialize", params)
      .then((result) => {
        this.transport.notify("initialized", {});
        return result;
      })
      .catch((error: unknown) => {
        this.close();
        throw error;
      }));
  }
  bind(channel: CodexChannel, id: string) {
    if (this.threads.has(id) && this.threads.get(id) !== channel)
      throw new Error("This native Codex thread is already open in another conversation.");
    this.threads.set(id, channel);
  }
  private deliver(message: ProtocolMessage) {
    if (!this.available) return;
    const params = routing.safeParse(message.params ?? {});
    if (!params.success) {
      if (message.id !== undefined) this.transport.reject(message.id, "Invalid thread routing.");
      return;
    }
    const channel =
      message.method === "serverRequest/resolved"
        ? this.requests.get(params.data.requestId)
        : params.data.threadId
          ? this.threads.get(params.data.threadId)
          : undefined;
    if (message.method === "serverRequest/resolved") this.requests.delete(params.data.requestId);
    if (channel?.available) {
      if (message.id !== undefined) this.requests.set(message.id, channel);
      try {
        channel.onMessage(message);
      } catch {
        this.close();
      }
    } else if (message.id !== undefined) {
      this.transport.reject(message.id, "No matching active Tidy thread.");
    }
    // Subagent status notifications name the child, not its owning root thread.
    if (message.id === undefined && message.method === "thread/status/changed") {
      for (const subscriber of this.channels)
        if (subscriber !== channel && subscriber.available) {
          try {
            subscriber.onMessage(message);
          } catch {
            this.close();
          }
        }
    }
  }
  respond(channel: CodexChannel, id: unknown, result: unknown) {
    if (!channel.available || this.requests.get(id) !== channel) return false;
    this.requests.delete(id);
    return this.transport.respond(id, result);
  }
  reject(channel: CodexChannel, id: unknown, reason: string) {
    if (!channel.available || this.requests.get(id) !== channel) return false;
    this.requests.delete(id);
    return this.transport.reject(id, reason);
  }
  async unsubscribe(threadId: string) {
    try {
      await this.transport.request("thread/unsubscribe", { threadId }, 2000);
    } catch {}
  }
  async release(channel: CodexChannel) {
    this.channels.delete(channel);
    if (channel.threadId && this.threads.get(channel.threadId) === channel)
      this.threads.delete(channel.threadId);
    for (const [id, owner] of this.requests)
      if (owner === channel) {
        this.transport.reject(id, "The conversation closed.");
        this.requests.delete(id);
      }
    if (this.idle && this.retiring) this.close();
    if (channel.threadId && this.available) await this.unsubscribe(channel.threadId);
    if (this.idle && this.available) {
      this.timer = setImmediate(() => this.close());
      this.timer.unref();
    }
  }
  close() {
    if (this.stopped) return;
    this.stopped = true;
    clearImmediate(this.timer);
    for (const channel of this.channels)
      channel.disconnected(new Error("The shared Codex connection closed."));
    this.channels.clear();
    this.threads.clear();
    this.requests.clear();
    this.transport.close();
  }
}

export class CodexAppServers {
  private servers = new Map<string, CodexAppServer>();
  private all = new Set<CodexAppServer>();
  acquire(context: ServerContext): HarnessChannel {
    const key = JSON.stringify([
      context.projectId,
      context.executable,
      context.cwd,
      context.additionalDirectories ?? [],
      !!context.superviseParent,
    ]);
    let server = this.servers.get(key);
    if (!server?.accepting) {
      server = new CodexAppServer(context);
      const current = server;
      this.servers.set(key, current);
      this.all.add(current);
      void current.transport.done.then(() => {
        this.all.delete(current);
        if (this.servers.get(key) === current) this.servers.delete(key);
      });
    }
    return server.acquire(context);
  }
  async clearEmpty(matches: (context: ServerContext) => boolean) {
    const selected = [...this.all].filter((server) => server.idle && matches(server.context));
    for (const server of selected) server.close();
    await Promise.all(selected.map((server) => server.transport.done));
  }
  async clear(matches: (context: ServerContext) => boolean, idleOnly: boolean) {
    const selected = [...this.all].filter((server) => matches(server.context));
    for (const server of selected) {
      if (idleOnly) server.retire();
      else server.close();
    }
    await Promise.all(
      selected.filter((server) => !server.available).map((server) => server.transport.done),
    );
  }
}
