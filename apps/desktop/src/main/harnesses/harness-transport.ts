import { spawn } from "node:child_process";
import { z } from "zod";
import { agentSupervisor } from "../remote/agent-supervisor";
import { harnessEnvironment } from "./harnesses";

export const protocolObject = z.record(z.string(), z.unknown());
export const object = (value: unknown) => protocolObject.parse(value ?? {});
export const text = (value: unknown) => (typeof value === "string" ? value : "");
export class HarnessRequestError extends Error {}
export class HarnessNotSubmittedError extends Error {}
const envelope = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    method: z.string().optional(),
    params: z.unknown().optional(),
    result: z.unknown().optional(),
    error: z.unknown().optional(),
    type: z.string().optional(),
    request_id: z.string().optional(),
    request: z.unknown().optional(),
    response: z.unknown().optional(),
  })
  .passthrough();
export type ProtocolMessage = z.infer<typeof envelope>;
export type TransportInput = {
  executable: string;
  args: string[];
  cwd: string;
  superviseParent?: boolean;
  protocol: "jsonrpc" | "claude";
  env?: NodeJS.ProcessEnv;
};

export class HarnessTransport {
  private child;
  private buffer = "";
  private serial = 0;
  private closed = false;
  private stopping = false;
  private force?: ReturnType<typeof setTimeout>;
  private waiting = new Map<
    string,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();
  readonly done: Promise<void>;
  onMessage: (message: ProtocolMessage) => void = () => {};
  onClose: (error: Error) => void = () => {};

  constructor(private input: TransportInput) {
    const supervised = input.superviseParent && process.platform !== "win32";
    this.child = spawn(
      supervised ? process.execPath : input.executable,
      supervised
        ? ["-e", agentSupervisor, String(process.pid), input.executable, ...input.args]
        : input.args,
      {
        cwd: input.cwd,
        env: input.env ?? harnessEnvironment(),
        stdio: "pipe",
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
      },
    );
    this.done = new Promise((resolve) => {
      this.child.once("close", () => {
        this.closed = true;
        this.signal("SIGKILL");
        clearTimeout(this.force);
        const error = new Error("The harness connection closed.");
        for (const pending of this.waiting.values()) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        this.waiting.clear();
        this.onClose(error);
        resolve();
      });
    });
    this.child.stderr.resume();
    this.child.stdout.setEncoding("utf8");
    this.child.stdin.on("error", () =>
      this.fail(new Error("The harness input connection closed.")),
    );
    this.child.once("error", () =>
      this.fail(new Error("Could not start the harness. Check its installation.")),
    );
    this.child.stdout.on("data", (chunk: string) => {
      if (this.stopping) return;
      this.buffer += chunk;
      let end: number;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        if (line.length > 4 * 1024 * 1024) {
          this.fail(new Error("The harness output exceeded the message limit."));
          return;
        }
        if (!line.trim()) continue;
        try {
          this.consume(envelope.parse(JSON.parse(line)));
        } catch {
          this.fail(new Error("The harness returned an invalid event."));
          return;
        }
      }
      if (this.buffer.length > 4 * 1024 * 1024)
        this.fail(new Error("The harness output exceeded the message limit."));
    });
  }
  get available() {
    return !this.closed && !this.stopping;
  }
  private consume(message: ProtocolMessage) {
    if (this.input.protocol === "claude" && message.type === "control_response") {
      const response = object(message.response);
      this.settle(
        text(response.request_id),
        response.response,
        response.subtype === "error"
          ? new HarnessRequestError(text(response.error) || "The harness rejected the request.")
          : undefined,
      );
    } else if (
      this.input.protocol === "jsonrpc" &&
      message.method === undefined &&
      message.id !== undefined
    ) {
      this.settle(
        String(message.id),
        message.result,
        message.error
          ? new HarnessRequestError(
              text(object(message.error).message) || "The harness rejected this request.",
            )
          : undefined,
      );
    } else this.onMessage(message);
  }
  private settle(id: string, value: unknown, error?: Error) {
    const pending = this.waiting.get(id);
    if (!pending) return;
    this.waiting.delete(id);
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve(value);
  }
  write(value: unknown) {
    if (!this.available || this.child.stdin.destroyed || !this.child.stdin.writable) return false;
    try {
      this.child.stdin.write(JSON.stringify(value) + "\n");
      return true;
    } catch {
      return false;
    }
  }
  request(method: string, params: unknown = {}, timeoutMs = 15_000): Promise<unknown> {
    if (!this.available) return Promise.reject(new Error("The harness connection closed."));
    const id = String(++this.serial);
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(
              () => this.settle(id, undefined, new Error("The harness connection timed out.")),
              timeoutMs,
            )
          : undefined;
      this.waiting.set(id, { resolve, reject, timer });
      if (
        !this.write(
          this.input.protocol === "claude"
            ? {
                type: "control_request",
                request_id: id,
                request: { subtype: method, ...object(params) },
              }
            : { jsonrpc: "2.0", id: this.serial, method, params },
        )
      )
        this.settle(id, undefined, new HarnessNotSubmittedError("The harness connection closed."));
    });
  }
  notify(method: string, params: unknown) {
    return this.write({ jsonrpc: "2.0", method, params });
  }
  respond(id: unknown, result: unknown) {
    return this.write(
      this.input.protocol === "claude"
        ? {
            type: "control_response",
            response: { subtype: "success", request_id: id, response: result },
          }
        : { jsonrpc: "2.0", id, result },
    );
  }
  reject(id: unknown, message: string) {
    return this.write(
      this.input.protocol === "claude"
        ? {
            type: "control_response",
            response: { subtype: "error", request_id: id, error: message },
          }
        : { jsonrpc: "2.0", id, error: { code: -32601, message } },
    );
  }
  private fail(error: Error) {
    this.onClose(error);
    this.close();
  }
  private signal(value: NodeJS.Signals) {
    try {
      if (this.child.pid && process.platform !== "win32") process.kill(-this.child.pid, value);
      else this.child.kill(value);
    } catch {}
  }
  close() {
    if (!this.available) return;
    this.stopping = true;
    this.signal("SIGTERM");
    this.force = setTimeout(() => this.signal("SIGKILL"), 2000);
    this.force.unref();
  }
}
