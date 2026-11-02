import { expect, test } from "bun:test";
import { request } from "node:http";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { SshSession } from "./ssh";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

class LocalShellSession extends SshSession {
  override launch({ command = [] }: { args: string[]; command?: string[] }) {
    const child = spawn("/bin/sh", ["-c", `exec ${command.join(" ")}`], { stdio: "pipe" });
    child.stdin.on("error", () => {});
    return child;
  }
}

test("SSH binary input is separate from the shell command and preserves arbitrary bytes", async () => {
  const session = new LocalShellSession({
    target: "fixture",
    temporaryDirectory: "unused",
    prompt: async () => null,
  });
  const input = randomBytes(2 * 1024 * 1024);
  const { execFileSync } = await import("node:child_process");
  const node = execFileSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).trim();
  const { shellQuote } = await import("./ssh");
  const output = await session.execute({
    script: `exec ${shellQuote(node)} -e 'const crypto = require("node:crypto"); const h = crypto.createHash("sha256"); process.stdin.on("data", b => h.update(b)); process.stdin.on("end", () => process.stdout.write(h.digest("hex")));'`,
    input,
    signal: AbortSignal.timeout(5000),
  });
  expect(output).toBe(createHash("sha256").update(input).digest("hex"));
});

test("SSH timeout and cancellation remain distinct and terminate an active command", async () => {
  const session = new LocalShellSession({
    target: "fixture",
    temporaryDirectory: "unused",
    prompt: async () => null,
  });
  await expect(
    session.execute({ script: "exec sleep 10", signal: new AbortController().signal, timeout: 20 }),
  ).rejects.toThrow("timed out");
  const controller = new AbortController();
  const pending = session.execute({ script: "exec sleep 10", signal: controller.signal });
  controller.abort(new Error("Attempt replaced"));
  await expect(pending).rejects.toThrow("Attempt replaced");
});

test("concurrent retries share authentication setup and closing waits for that setup", async () => {
  const root = await mkdtemp(join(homedir(), ".tidy-ssh-initialize-"));
  const session = new SshSession({
    target: "unused",
    temporaryDirectory: root,
    prompt: async () => null,
  });
  try {
    await Promise.all([session.initialize(), session.initialize()]);
    expect(await readdir(root)).toHaveLength(1);
    await session.close();
    expect(await readdir(root)).toHaveLength(0);
    await expect(session.initialize()).rejects.toThrow("closed");
    const starting = new SshSession({
      target: "unused",
      temporaryDirectory: root,
      prompt: async () => null,
    });
    await Promise.all([starting.initialize(), starting.close()]);
    expect(await readdir(root)).toHaveLength(0);
  } finally {
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("SSH reuses accepted passwords once per command, refreshes rejected secrets and bounds prompts", async () => {
  const root = await mkdtemp(join(homedir(), ".tidy-ssh-ask-"));
  const answers = ["first", "second", "third", "fourth"];
  let prompts = 0;
  const session = new SshSession({
    target: "unused",
    temporaryDirectory: root,
    prompt: async () => answers[prompts++] ?? null,
  });
  try {
    await session.initialize();
    const socketPath = join(root, (await readdir(root))[0], "ask.sock");
    const ask = (question: string) =>
      new Promise<{ status: number | undefined; answer: string }>((resolve, reject) => {
        const req = request({ socketPath, path: "/ask", method: "POST" }, (res) => {
          let answer = "";
          res.on("data", (chunk) => {
            answer += chunk;
          });
          res.on("end", () => resolve({ status: res.statusCode, answer }));
        });
        req.on("error", reject);
        req.end(question);
      });
    const nextCommand = async () => {
      const child = session.launch({ args: ["-V"] });
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", () => resolve());
      });
    };
    expect((await ask("Password:")).answer).toBe("first");
    await nextCommand();
    expect((await ask("Password:")).answer).toBe("first");
    expect(prompts).toBe(1);
    expect((await ask("Password:")).answer).toBe("second");
    expect((await ask("Password:")).answer).toBe("third");
    expect((await ask("Password:")).status).toBe(403);
    expect(session.failure("denied").kind).toBe("authentication");
    session.resetAuthentication();
    expect((await ask("Verification code:")).answer).toBe("fourth");
    await nextCommand();
    expect((await ask("Verification code:")).status).toBe(403);
    expect(prompts).toBe(5);
    expect(session.failure("denied").kind).toBe("cancelled");
  } finally {
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("SSH surfaces browser verification and stops automatic retries when approval fails", async () => {
  const root = await mkdtemp(join(homedir(), ".tidy-ssh-verify-"));
  const configPath = join(root, "config");
  const { writeFile } = await import("node:fs/promises");
  const urls: string[] = [];
  const session = new SshSession({
    target: "fixture",
    temporaryDirectory: root,
    configPath,
    prompt: async () => null,
    verify: (url) => urls.push(url),
  });
  try {
    await writeFile(
      configPath,
      "Host fixture\n ProxyCommand /bin/sh -c 'echo https://login.tailscale.com/a/fixture >&2; exit 1'\n",
    );
    await session.initialize();
    await expect(
      session.execute({ script: "true", signal: AbortSignal.timeout(5000) }),
    ).rejects.toThrow("Tailscale verification did not finish");
    expect(urls).toEqual(["https://login.tailscale.com/a/fixture"]);
    expect(session.failure("failed").kind).toBe("authentication");
  } finally {
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});
