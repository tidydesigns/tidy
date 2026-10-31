import { agentSupervisor } from "../remote/agent-supervisor";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { harnessEnvironment } from "./harnesses";
import { parseOpenCodeUsage } from "./usage-protocol";
import type { HarnessUsage } from "../../shared/contracts/harness-usage";

const execute = promisify(execFile);
const unavailable = (note: string): HarnessUsage => ({
  windows: [],
  state: "unknown",
  note,
  updatedAt: new Date().toISOString(),
  usagePage: "api",
});

/** Use a disposable authenticated loopback server. No sessions, model requests, or credentials cross IPC. */
export async function readOpenCodeUsage(executable: string, cwd: string): Promise<HarnessUsage> {
  const env = harnessEnvironment("opencode");
  const version = await execute(executable, ["--version"], {
    cwd,
    env,
    timeout: 4000,
    maxBuffer: 4096,
    windowsHide: true,
  });
  const major = Number(version.stdout.trim().match(/^(\d+)\./)?.[1]);
  if (!major || major < 2)
    return unavailable(
      "Update OpenCode to view Console allowances here. Other providers manage their own usage.",
    );
  const password = randomBytes(32).toString("base64url");
  const supervised = process.platform !== "win32";
  const args = ["--pure", "serve", "--hostname", "127.0.0.1", "--port", "0"];
  const child = spawn(
    supervised ? process.execPath : executable,
    supervised
      ? [
          "-e",
          `delete process.env.ELECTRON_RUN_AS_NODE;\n${agentSupervisor}`,
          String(process.pid),
          executable,
          ...args,
        ]
      : args,
    {
      cwd,
      env: {
        ...env,
        ...(supervised && process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          experimental: { schedules: false },
          server: { mdns: false },
        }),
        OPENCODE_SERVER_USERNAME: "opencode",
        OPENCODE_SERVER_PASSWORD: password,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
      detached: supervised,
    },
  );
  const signal = (value: NodeJS.Signals) => {
    try {
      if (supervised && child.pid) process.kill(-child.pid, value);
      else child.kill(value);
    } catch {
      /* The process group has already exited. */
    }
  };
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 8000);
  let force: ReturnType<typeof setTimeout> | undefined;
  try {
    const origin = await new Promise<string>((resolve, reject) => {
      let output = "";
      const stop = () => reject(new Error("OpenCode usage discovery timed out."));
      controller.signal.addEventListener("abort", stop, { once: true });
      const receive = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-8192);
        const match = output.match(/http:\/\/127\.0\.0\.1:(\d{1,5})(?:\s|$|\/)/);
        if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) return;
        controller.signal.removeEventListener("abort", stop);
        resolve(`http://127.0.0.1:${match[1]}`);
      };
      child.stdout.on("data", receive);
      child.stderr.on("data", receive);
      child.once("error", () => reject(new Error("Could not read OpenCode usage.")));
      child.once("exit", () => reject(new Error("OpenCode usage discovery stopped.")));
    });
    const target = new URL("/api/experimental/usage/limits", origin);
    target.searchParams.set("location", JSON.stringify({ directory: cwd }));
    const anonymous = await fetch(target, { redirect: "error", signal: controller.signal });
    await anonymous.body?.cancel();
    if (anonymous.status !== 401)
      return unavailable(
        "This OpenCode version doesn't expose authenticated account usage. Check OpenCode Console.",
      );
    const response = await fetch(target, {
      headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
      redirect: "error",
      signal: controller.signal,
    });
    if (response.status === 404)
      return unavailable("This OpenCode version doesn't expose Console usage yet.");
    if (!response.ok) throw new Error("OpenCode couldn't refresh account usage.");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("OpenCode returned no usage details.");
    let body = "";
    let bytes = 0;
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        body += decoder.decode(value, { stream: true });
        if (bytes > 256_000) throw new Error("OpenCode usage details exceeded the size limit.");
      }
    } finally {
      await reader.cancel();
    }
    const envelope = JSON.parse(body + decoder.decode());
    if (envelope?.data === null)
      return unavailable(
        "Connect OpenCode Console to view its allowances. Other providers manage their own usage.",
      );
    return parseOpenCodeUsage(envelope?.data);
  } finally {
    clearTimeout(deadline);
    controller.abort();
    signal("SIGTERM");
    if (child.exitCode === null) {
      force = setTimeout(() => signal("SIGKILL"), 1000);
      force.unref();
      child.once("close", () => clearTimeout(force));
    }
  }
}
