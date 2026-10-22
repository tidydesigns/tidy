import { z } from "zod";
import { spawn } from "node:child_process";
import { harnessEnvironment } from "./harnesses";
import type { HarnessId } from "../shared/contracts";

const codexEnvelope = z.object({
  id: z.union([z.string(), z.number()]),
  error: z.unknown().optional(),
  result: z.unknown().optional(),
});
const claudeEnvelope = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("control_response"),
    response: z.object({
      request_id: z.string(),
      subtype: z.string(),
      response: z.unknown().optional(),
    }),
  }),
  z.object({ type: z.literal("control_request"), request_id: z.string() }),
]);

export async function withHarnessConnection<T>(
  input: { executable: string; harness: HarnessId; cwd: string },
  use: (request: (method: string, params?: unknown) => Promise<unknown>) => Promise<T>,
): Promise<T> {
  const { executable, harness, cwd } = input;
  const child = spawn(
    executable,
    harness === "codex"
      ? ["app-server", "--listen", "stdio://"]
      : [
          "-p",
          "--input-format",
          "stream-json",
          "--output-format",
          "stream-json",
          "--verbose",
          "--permission-mode",
          "dontAsk",
        ],
    {
      cwd,
      env: harnessEnvironment(),
      stdio: "pipe",
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
    },
  );
  const waiting = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  let serial = 0,
    buffer = "",
    closed = false;
  function stop() {
    if (closed) return;
    closed = true;
    child.stdin.destroy();
    try {
      if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
      else child.kill();
    } catch {}
    const force = setTimeout(() => {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {}
    }, 1000);
    force.unref();
    child.once("close", () => clearTimeout(force));
  }
  const fail = (message: string) => {
    for (const pending of waiting.values()) pending.reject(new Error(message));
    waiting.clear();
    stop();
  };
  child.stdout.setEncoding("utf8");
  child.stderr.resume();
  child.stdin.on("error", () => {});
  child.on("error", () => fail("Could not start the harness connection."));
  child.on("close", () => fail("The harness closed before returning its capabilities."));
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 4_000_000) {
      fail("Harness capabilities exceeded the response limit.");
      return;
    }
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      try {
        const raw: unknown = JSON.parse(line);
        const codex = codexEnvelope.safeParse(raw);
        const claude = claudeEnvelope.safeParse(raw);
        if (harness === "codex" && codex.success) {
          const value = codex.data;
          const pending = waiting.get(String(value.id));
          if (!pending) continue;
          waiting.delete(String(value.id));
          if (value.error)
            pending.reject(new Error("The installed Codex could not provide this information."));
          else pending.resolve(value.result);
        } else if (
          harness === "claude" &&
          claude.success &&
          claude.data.type === "control_response"
        ) {
          const response = claude.data.response,
            pending = waiting.get(response?.request_id);
          if (!pending) continue;
          waiting.delete(response.request_id);
          if (response.subtype === "error")
            pending.reject(
              new Error("The installed Claude Code could not provide this information."),
            );
          else pending.resolve(response.response);
        } else if (
          harness === "claude" &&
          claude.success &&
          claude.data.type === "control_request"
        ) {
          // Metadata discovery cannot approve tools or execute agent work.
          child.stdin.write(
            JSON.stringify({
              type: "control_response",
              response: {
                subtype: "error",
                request_id: claude.data.request_id,
                error: "No tools are allowed during capability discovery.",
              },
            }) + "\n",
          );
        }
      } catch {
        fail("The harness returned invalid capability data.");
        return;
      }
    }
  });
  function request(method: string, params?: unknown): Promise<unknown> {
    if (closed) return Promise.reject(new Error("The harness connection is closed."));
    const id = String(++serial);
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      child.stdin.write(
        JSON.stringify(
          harness === "codex"
            ? { id: serial, method, ...(params === undefined ? {} : { params }) }
            : { type: "control_request", request_id: id, request: { subtype: method } },
        ) + "\n",
      );
    });
  }
  const timer = setTimeout(
    () => fail("The harness connection timed out. Retry after checking its CLI sign-in."),
    15_000,
  );
  try {
    return await use(async (method, params) => {
      const result = await request(method, params);
      if (harness === "codex" && method === "initialize")
        child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
      return result;
    });
  } finally {
    clearTimeout(timer);
    stop();
  }
}
