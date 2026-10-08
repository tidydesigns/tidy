import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

export const CODEX_VERSION = "0.160.0";
const executeFile = promisify(execFile);

type RpcId = string | number;
export type RpcMessage = {
  id?: RpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
};
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
export type ToolSpec = {
  type: "function";
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

/** One native Codex auth store per person, owned entirely by Codex. No auth file
 * is read or copied by Tidy. Browser clients never receive this RPC transport. */
export class CodexAppServer extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<RpcId, Pending>();
  private buffer = "";
  private stopped = false;
  private starting: Promise<void> | undefined;
  constructor(
    readonly directory: string,
    private executable = "codex",
  ) {
    super();
  }

  async start() {
    if (this.starting) return this.starting;
    this.starting = this.boot().catch((error) => {
      this.starting = undefined;
      throw error;
    });
    return this.starting;
  }
  private async boot() {
    if (this.stopped) throw new Error("Codex runtime has stopped.");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const cwd = resolve(this.directory, "workspace");
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    const environment: Record<string, string> = {};
    for (const key of ["PATH", "SystemRoot", "TMPDIR", "LANG"])
      if (process.env[key]) environment[key] = process.env[key];
    // Standard Codex home override applies only to this isolated subprocess.
    // Deliberately exclude API keys, the runner service key, and Tidy DB credentials.
    environment.CODEX_HOME = this.directory;
    const version = await executeFile(this.executable, ["--version"], {
      env: environment as NodeJS.ProcessEnv,
      timeout: 5000,
    });
    if (version.stdout.trim() !== `codex-cli ${CODEX_VERSION}`)
      throw new Error(`Tidy requires Codex ${CODEX_VERSION}.`);
    const child = spawn(
      this.executable,
      [
        "app-server",
        "--listen",
        "stdio://",
        "-c",
        'cli_auth_credentials_store="file"',
        "-c",
        'sandbox_mode="read-only"',
        "-c",
        'approval_policy="never"',
        "-c",
        "features.shell_tool=false",
        "-c",
        "features.multi_agent=false",
        "-c",
        'web_search="disabled"',
      ],
      { cwd, env: environment as NodeJS.ProcessEnv, stdio: "pipe" },
    );
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.consume(String(chunk)));
    // Never forward raw stderr: auth links and provider diagnostics may contain
    // private values. Operational reporting uses typed exit/RPC errors only.
    child.stderr.resume();
    child.on("error", () => this.fail(new Error("Could not start Codex.")));
    child.on("exit", () => {
      this.starting = undefined;
      this.child = null;
      this.fail(new Error("Codex runtime disconnected."));
    });
    await this.request("initialize", {
      clientInfo: { name: "tidy", title: "Tidy", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized");
  }
  request<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    timeout = 30_000,
  ): Promise<T> {
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out.`));
      }, timeout);
      this.pending.set(id, { resolve: (value) => resolvePromise(value as T), reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  notify(method: string, params?: Record<string, unknown>) {
    this.send({ method, params });
  }
  respond(id: RpcId, result: unknown) {
    this.send({ id, result });
  }
  reject(id: RpcId) {
    this.send({ id, error: { code: -32601, message: "This operation is not available in Tidy." } });
  }
  private send(message: RpcMessage) {
    if (!this.child || this.stopped || !this.child.stdin.writable)
      throw new Error("Codex runtime is unavailable.");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  private consume(chunk: string) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 16 * 1024 * 1024) {
      this.fail(new Error("Codex message exceeded the size limit."));
      this.close();
      return;
    }
    let end: number;
    while ((end = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (!line.trim()) continue;
      let message: RpcMessage;
      try {
        message = JSON.parse(line) as RpcMessage;
      } catch {
        this.fail(new Error("Invalid Codex protocol message."));
        this.close();
        return;
      }
      if (message.method) {
        this.emit(message.id === undefined ? "notification" : "request", message);
        continue;
      }
      if (message.id === undefined) continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`Codex request failed (${message.error.code}).`));
      else pending.resolve(message.result);
    }
  }
  private fail(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit("disconnect", error);
  }
  close() {
    this.stopped = true;
    this.child?.kill("SIGTERM");
    this.fail(new Error("Codex runtime stopped."));
  }
}
