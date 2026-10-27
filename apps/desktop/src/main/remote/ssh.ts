import { VerificationOutput } from "./tailscale-verification";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile, glob } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { remoteTargetSchema } from "../../shared/remote";

import { RemoteFailure, sshFailure } from "./errors";
export type AuthenticationPrompt = (input: {
  question: string;
  secret: boolean;
}) => Promise<string | null>;
export function sshArguments({
  target,
  configPath,
  args = [],
}: {
  target: string;
  configPath?: string;
  args?: string[];
}) {
  return [
    ...(configPath ? ["-F", configPath] : []),
    "-T",
    "-o",
    "BatchMode=no",
    "-o",
    "StrictHostKeyChecking=ask",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ForwardX11=no",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "ControlPersist=no",
    ...args,
    "--",
    remoteTargetSchema.parse(target),
  ];
}
export class SshSession {
  private directory = "";
  private server?: ReturnType<typeof createServer>;
  private children = new Set<ChildProcessWithoutNullStreams>();
  private cache = new Map<string, { answer: string; generation: number }>();
  private generation = 0;
  private verification = false;
  get awaitingVerification() {
    return this.verification;
  }
  private promptCount = 0;
  private promptFailure?: RemoteFailure;
  resetAuthentication() {
    this.cache.clear();
    this.promptCount = 0;
    this.promptFailure = undefined;
  }
  failure(message: string) {
    return this.promptFailure ?? sshFailure(message);
  }
  constructor(
    private options: {
      target: string;
      temporaryDirectory: string;
      prompt: AuthenticationPrompt;
      configPath?: string;
      verify?: (url: string) => void;
    },
  ) {}
  async initialize() {
    await mkdir(this.options.temporaryDirectory, { recursive: true, mode: 0o700 });
    this.directory = await mkdtemp(join(this.options.temporaryDirectory, "ssh-"));
    const socket = join(this.directory, "ask.sock");
    if (Buffer.byteLength(socket) > 100)
      throw new Error("The desktop data path is too long for SSH authentication.");
    const server = createServer((request, response) => {
      void (async () => {
        if (request.method !== "POST" || request.url !== "/ask") {
          response.writeHead(404).end();
          return;
        }
        let question = "";
        for await (const chunk of request) {
          question += chunk.toString();
          if (question.length > 4096) throw new Error("SSH prompt too large.");
        }
        const secret = !/yes\/no|fingerprint/i.test(question);
        const cacheable =
          secret &&
          /password|passphrase/i.test(question) &&
          !/code|otp|token|verification/i.test(question);
        const cached = cacheable ? this.cache.get(question) : undefined;
        let answer: string | null;
        if (cached && cached.generation !== this.generation) {
          cached.generation = this.generation;
          answer = cached.answer;
        } else {
          this.cache.delete(question);
          if (secret && ++this.promptCount > 2) {
            this.promptFailure = new RemoteFailure(
              "authentication",
              "SSH rejected the credentials. Retry to enter fresh credentials.",
            );
            response.writeHead(403).end();
            return;
          }
          answer = await this.options.prompt({ question, secret });
        }
        if (answer === null) {
          this.promptFailure = new RemoteFailure(
            "cancelled",
            "Authentication was cancelled or expired. Retry when you’re ready.",
          );
          this.cache.clear();
          response.writeHead(403).end();
          return;
        }
        if (cacheable) this.cache.set(question, { answer, generation: this.generation });
        response.end(answer);
      })().catch(() => response.writeHead(403).end());
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, resolve);
    });
    await writeFile(
      join(this.directory, "askpass"),
      '#!/bin/sh\nprintf "%s" "$1" | /usr/bin/curl --silent --show-error --fail --max-time 120 --unix-socket "$TIDY_ASKPASS_SOCKET" --data-binary @- http://localhost/ask\n',
      { mode: 0o700 },
    );
  }
  launch({ args, command = [] }: { args: string[]; command?: string[] }) {
    this.generation++;
    const generation = this.generation;
    this.verification = false;
    this.promptCount = 0;
    this.promptFailure = undefined;
    const child = spawn(
      "ssh",
      [
        ...sshArguments({ target: this.options.target, configPath: this.options.configPath, args }),
        ...command,
      ],
      {
        stdio: "pipe",
        windowsHide: true,
        env: {
          ...process.env,
          SSH_ASKPASS: join(this.directory, "askpass"),
          SSH_ASKPASS_REQUIRE: "force",
          TIDY_ASKPASS_SOCKET: join(this.directory, "ask.sock"),
          DISPLAY: process.env.DISPLAY ?? ":0",
        },
      },
    );
    const verificationOutput = new VerificationOutput((url) => {
      if (generation !== this.generation) return;
      this.verification = true;
      this.options.verify?.(url);
    });
    child.stderr.on("data", (chunk: Buffer) => verificationOutput.receive(chunk.toString()));
    child.once("close", () => {
      if (generation !== this.generation) return;
      if (this.verification && !this.promptFailure)
        this.promptFailure = new RemoteFailure(
          "authentication",
          "Tailscale verification did not finish. Retry to request a fresh link.",
        );
      this.verification = false;
    });
    this.children.add(child);
    child.once("close", () => this.children.delete(child));
    child.stdin.on("error", () => {});
    return child;
  }
  async execute({
    script,
    signal,
    timeout = 600_000,
    progress,
  }: {
    script: string;
    signal: AbortSignal;
    timeout?: number;
    progress?: (phase: string) => void;
  }) {
    signal.throwIfAborted();
    const child = this.launch({ args: ["-o", "ClearAllForwardings=yes"], command: ["/bin/sh -s"] });
    let stdout = "",
      stderr = "",
      lines = "";
    const abort = () => child.kill();
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, timeout);
    try {
      const exited = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
          if (stdout.length > 1024 * 1024) child.kill();
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr = (stderr + chunk.toString()).slice(-16_384);
          lines += chunk.toString();
          let end: number;
          while ((end = lines.indexOf("\n")) !== -1) {
            const line = lines.slice(0, end);
            lines = lines.slice(end + 1);
            if (line.startsWith("TIDY_PHASE:")) progress?.(line.slice(11));
          }
          if (lines.length > 16_384) lines = lines.slice(-16_384);
        });
      });
      child.stdin.end(script);
      const code = await exited;
      signal.throwIfAborted();
      if (code !== 0) {
        this.cache.clear();
        throw this.failure(
          stderr.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trim() ||
            "SSH setup failed. Check the destination and access permissions.",
        );
      }
      return stdout;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }
  async close() {
    this.cache.clear();
    for (const child of this.children) child.kill();
    this.server?.closeAllConnections();
    const server = this.server;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
  }
}
export async function discoverSshHosts(directory = join(homedir(), ".ssh")) {
  const hosts = new Set<string>();
  const visited = new Set<string>();
  async function read(path: string, depth: number) {
    if (depth > 8 || visited.has(path)) return;
    visited.add(path);
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch {
      return;
    }
    for (const line of content.split(/\r?\n/)) {
      const [key, ...values] = line.trim().split(/\s+/);
      if (key?.toLowerCase() === "host")
        for (const alias of values)
          if (remoteTargetSchema.safeParse(alias).success) hosts.add(alias);
      if (key?.toLowerCase() === "include")
        for (const pattern of values) {
          const expanded = pattern.startsWith("~/")
            ? join(homedir(), pattern.slice(2))
            : resolve(dirname(path), pattern);
          for await (const file of glob(expanded)) await read(file, depth + 1);
        }
    }
  }
  await read(join(directory, "config"), 0);
  try {
    const content = await readFile(join(directory, "known_hosts"), "utf8");
    for (const line of content.split(/\r?\n/))
      for (const alias of (line.split(" ")[0] ?? "").split(","))
        if (remoteTargetSchema.safeParse(alias).success) hosts.add(alias);
  } catch {}
  return [...hosts]
    .sort()
    .slice(0, 100)
    .map((alias) => ({ alias }));
}
