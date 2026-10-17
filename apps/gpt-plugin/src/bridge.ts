import { z } from "zod";

const toolResultSchema = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
  _meta: z.record(z.string(), z.unknown()).optional(),
});
const hostContextSchema = z.object({
  theme: z.enum(["light", "dark"]).optional(),
  locale: z.string().optional(),
});
const messageSchema = z.looseObject({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});
type ToolResult = z.infer<typeof toolResultSchema>;
type HostContext = z.infer<typeof hostContextSchema>;
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** MCP Apps JSON-RPC bridge. Only messages from the embedding host are accepted. */
export class HostBridge {
  private id = 0;
  private pending = new Map<number, Pending>();
  private origin: string | null = null;
  private ready: Promise<void> | null = null;
  onResult?: (result: ToolResult) => void;
  onContext?: (context: HostContext) => void;
  onError?: (error: Error) => void;
  constructor(private host: Window = window.parent) {
    window.addEventListener("message", this.receive);
  }
  private receive = (event: MessageEvent) => {
    if (event.source !== this.host || (this.origin && event.origin !== this.origin)) return;
    const input = messageSchema.safeParse(event.data);
    if (!input.success) return;
    const message = input.data;
    if (message.method === "ui/resource-teardown" && message.id !== undefined) {
      this.host.postMessage({ jsonrpc: "2.0", id: message.id, result: {} }, this.targetOrigin());
      this.dispose();
    } else if (typeof message.id === "number" && !message.method) {
      const request = this.pending.get(message.id);
      if (!request) return;
      if (!this.origin) this.origin = event.origin;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error !== undefined) {
        const error = z.object({ message: z.string().optional() }).safeParse(message.error);
        request.reject(
          new Error(
            error.success
              ? (error.data.message ?? "ChatGPT could not complete the request.")
              : "Invalid host response.",
          ),
        );
      } else if ("result" in message) request.resolve(message.result);
      else request.reject(new Error("Invalid host response."));
    } else if (message.method === "ui/notifications/tool-result") {
      const result = toolResultSchema.safeParse(message.params);
      if (result.success) this.onResult?.(result.data);
      else this.onError?.(new Error("The preview response could not be read."));
    } else if (message.method === "ui/notifications/host-context-changed") {
      const context = hostContextSchema.safeParse(message.params);
      if (context.success) this.onContext?.(context.data);
    } else if (message.method === "ui/notifications/tool-cancelled")
      this.onError?.(new Error("The request was cancelled."));
  };
  private targetOrigin() {
    return this.origin && this.origin !== "null" ? this.origin : "*";
  }
  private notify(method: string, params: unknown) {
    this.host.postMessage({ jsonrpc: "2.0", method, params }, this.targetOrigin());
  }
  private request(method: string, params: unknown) {
    const id = ++this.id;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("ChatGPT did not respond. Try again."));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.host.postMessage({ jsonrpc: "2.0", id, method, params }, this.targetOrigin());
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  connect() {
    return (this.ready ??= this.request("ui/initialize", {
      appInfo: { name: "tidy", version: "0.1.0" },
      appCapabilities: {},
      protocolVersion: "2026-01-26",
    })
      .then((value) => {
        const result = z.object({ hostContext: hostContextSchema.optional() }).safeParse(value);
        if (!result.success) throw new Error("Invalid host initialization response.");
        this.onContext?.(result.data.hostContext ?? {});
        this.notify("ui/notifications/initialized", {});
      })
      .catch((error) => {
        this.ready = null;
        throw error;
      }));
  }
  async callTool(name: string, args: Record<string, unknown>) {
    await this.connect();
    const result = toolResultSchema.safeParse(
      await this.request("tools/call", { name, arguments: args }),
    );
    if (!result.success) throw new Error("The preview response could not be read.");
    return result.data;
  }
  async select(fileId: string, rootId: string, revision: number) {
    await this.connect();
    await this.request("ui/update-model-context", {
      content: [
        {
          type: "text",
          text: `Selected Tidy design root ${rootId} in file ${fileId} at revision ${revision}. Read get_document before editing.`,
        },
      ],
    });
  }
  async openLink(url: string) {
    await this.connect();
    await this.request("ui/open-link", { url });
  }
  resize(height: number) {
    this.notify("ui/notifications/size-changed", { height });
  }
  dispose() {
    window.removeEventListener("message", this.receive);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Preview closed."));
    }
    this.pending.clear();
  }
}
