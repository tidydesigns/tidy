import { expect, test } from "bun:test";
import { request } from "node:http";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { SshSession } from "./ssh";

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
