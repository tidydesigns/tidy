import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, rm, stat, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { WebSocket } from "ws";
import { spawn } from "node:child_process";
import { ProjectStore } from "../workspace/project-store";
import { WorkspaceService } from "../workspace/workspace-service";
import { createRemoteHost } from "./host";
import { RemoteClient } from "./client";
import { RemoteFailure } from "./errors";
import { sshArguments } from "./ssh";
import { RequestReceipts } from "./receipts";
import { SessionStore } from "./session-store";
import * as sessionStore from "./session-store";

import { remoteFrameSchema, type ConnectionStatus } from "../../shared/remote";
import { desktopEventSchema, type DesktopEvent } from "../../shared/contracts/desktop";
import { parseWorkspaceResponse } from "../../shared/contracts/workspace-response";
import { directoryResponseSchema } from "../../shared/contracts/browser-directory";
import type { BrowserOutput } from "../../shared/contracts/browser";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function until(check: () => boolean, timeout = 5000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error("Timed out waiting for remote state.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tidy-remote-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const store = new ProjectStore(join(root, "state"));
  await store.initialize();
  const projectPath = join(root, "project");
  await mkdir(projectPath);
  const project = (await store.open(projectPath)).project;
  let stopped = false;
  let finishRun: (() => void) | undefined;
  const service = new WorkspaceService(
    store,
    () => ({
      done: new Promise<void>((resolve) => {
        finishRun = resolve;
      }),
      respondToApproval: () => true,
      stop: () => {
        stopped = true;
        finishRun?.();
      },
    }),
    async () => "/fixture/harness",
    async () => {},
  );
  const sessions = new SessionStore(join(root, "sessions"));
  let identity = { hostId: randomUUID(), instanceId: randomUUID(), buildId: "fixture" };
  let host = createRemoteHost({
    service,
    identity,
    sessions,
    receipts: new RequestReceipts(join(root, "receipts")),
  });
  let port = await host.listen();
  cleanups.push(async () => {
    await host.close();
    await service.close();
  });
  function client(verification?: { approved: Promise<void>; url: string }, cachePath?: string) {
    const events: DesktopEvent[] = [];
    const statuses: ConnectionStatus[] = [];
    const drops: (() => void)[] = [];
    const clientId = randomUUID();
    const client = new RemoteClient({
      machine: { id: clientId, target: "user@home", hostId: null, lastConnectedAt: null },
      bundlePath: "unused",
      cachePath,
      temporaryDirectory: root,
      event: (event) => events.push(event),
      statusChanged: (status) => statuses.push(status),
      connected: async () => {},
      connector: async ({ signal, verify }) => {
        if (verification) {
          verify(verification.url);
          await verification.approved;
          signal.throwIfAborted();
        }
        return {
          host: {
            ...identity,
            protocol: 3,
            pid: process.pid,
            port,
            managed: true,
            clientId,
            token: await sessions.issue(clientId),
          },
          origin: `http://127.0.0.1:${port}`,
          close() {},
          onClose: (listener) => {
            drops.push(listener);
          },
        };
      },
    });
    cleanups.push(() => client.close());
    client.start();
    return { client, events, statuses, drops };
  }
  return {
    root,
    project,
    projectPath,
    store,
    service,
    client,
    sessions,
    origin: () => `http://127.0.0.1:${port}`,
    stopped: () => stopped,
    closeHost: () => host.close(),
    async restart(identityChanged = false) {
      await host.close();
      identity = {
        ...identity,
        instanceId: randomUUID(),
        ...(identityChanged ? { hostId: randomUUID() } : {}),
      };
      host = createRemoteHost({
        service,
        identity,
        sessions,
        receipts: new RequestReceipts(join(root, "receipts")),
      });
      port = await host.listen();
    },
  };
}

test("SSH destinations cannot inject options or commands; host checks and keepalives are mandatory", () => {
  for (const value of [
    "-oProxyCommand=bad",
    "host;touch /tmp/a",
    "user@host\ncommand",
    "$(id)",
    "a b",
    "user@-host",
  ])
    expect(() => sshArguments({ target: value })).toThrow();
  const args = sshArguments({ target: "developer@omarchy.example.ts.net" });
  expect(args).toContain("StrictHostKeyChecking=ask");
  expect(args).toContain("BatchMode=no");
  expect(args).toContain("ServerAliveInterval=15");
  expect(args.at(-1)).toBe("developer@omarchy.example.ts.net");
});

for (const namingSupported of [false, true]) {
  test(`thread starts remain compatible with ${namingSupported ? "naming-capable" : "legacy"} remote hosts`, async () => {
    const f = await fixture();
    const parse = remoteFrameSchema.parse.bind(remoteFrameSchema);
    const frames = spyOn(remoteFrameSchema, "parse").mockImplementation((...args) => {
      const frame = parse(...args);
      // An older protocol-3 backend sends the same hello without the optional capabilities.
      return !namingSupported && frame.type === "hello"
        ? { ...frame, capabilities: undefined }
        : frame;
    });
    const start = spyOn(f.service, "startThread");
    try {
      const { client } = f.client();
      await until(() => client.status.kind === "connected");
      const input = {
        projectId: f.project.id,
        harness: "codex" as const,
        prompt: "Improve the sidebar",
        designIds: [],
        naming: {
          mode: "prompt" as const,
          provider: "thread" as const,
          instructions: "Keep it brief",
        },
      };
      const thread = await client.operation("start-thread", input);
      expect(thread.status).toBe("running");
      expect(start.mock.calls[0][0].naming).toEqual(namingSupported ? input.naming : undefined);
      expect(input.naming.instructions).toBe("Keep it brief");
      if (namingSupported) {
        expect(
          (
            await client.operation("rename-thread", {
              projectId: f.project.id,
              threadId: thread.id,
              title: "Sidebar polish",
            })
          ).title,
        ).toBe("Sidebar polish");
      } else {
        await expect(
          client.operation("rename-thread", {
            projectId: f.project.id,
            threadId: thread.id,
            title: "Unsupported",
          }),
        ).rejects.toThrow("backend update");
        await expect(
          client.operation("regenerate-thread-title", {
            projectId: f.project.id,
            threadId: thread.id,
            naming: input.naming,
          }),
        ).rejects.toThrow("backend update");
      }
    } finally {
      frames.mockRestore();
      start.mockRestore();
    }
  });
}

test("authenticated WebSocket serves validated requests and remote directory selection", async () => {
  const f = await fixture();
  const { client } = f.client();
  await until(() => client.status.kind === "connected");
  const initial = await client.operation("bootstrap");
  expect(initial.activeProject?.project.path).toBe(f.projectPath);
  const directories = directoryResponseSchema.parse(
    await client.request("directories", undefined, { projectPath: f.root }),
  );
  expect(
    directories.ok && directories.data.directories.some((entry) => entry.path === f.projectPath),
  ).toBe(true);
  const other = join(f.root, "other");
  await mkdir(other);
  const opened = await client.operation("open-project", undefined, { projectPath: other });
  expect(opened?.project.path).toBe(other);
  const invalid = await client.request("create-design", { projectId: "bad" });
  expect(() => parseWorkspaceResponse("create-design", invalid)).toThrow("Invalid desktop request");
});

test("disconnecting a client leaves agent runs alive and reconnect refreshes missed state", async () => {
  const f = await fixture();
  const { client, events, drops } = f.client();
  await until(() => client.status.kind === "connected");
  const thread = await client.operation("start-thread", {
    projectId: f.project.id,
    harness: "claude",
    prompt: "Keep running",
    designIds: [],
  });
  expect(thread.status).toBe("running");
  events.length = 0;
  drops[0]();
  await until(() => client.status.kind === "reconnecting");
  expect(f.stopped()).toBe(false);
  const design = await f.store.createDesign(f.project.id);
  await until(() => client.status.kind === "connected");
  expect(
    events.some(
      (event) =>
        event.type === "thread" &&
        event.thread.id === thread.id &&
        event.thread.status === "running",
    ),
  ).toBe(true);
  expect(
    events.some(
      (event) => event.type === "designs" && event.designs.some((item) => item.id === design.id),
    ),
  ).toBe(true);
  client.close();
  expect(f.stopped()).toBe(false);
});

test("replaced host identity stops reconnect", async () => {
  const f = await fixture();
  const { client } = f.client();
  await until(() => client.status.kind === "connected");
  await f.restart(true);
  await until(() => client.status.kind === "blocked");
  expect(client.status.kind === "blocked" && client.status.message).toContain("identity changed");
  await expect(client.operation("bootstrap")).rejects.toThrow("disconnected");
});

test("authentication rejects unknown sessions and browser origins; tickets are single use", async () => {
  const f = await fixture();
  const clientId = randomUUID();
  const token = await f.sessions.issue(clientId);
  expect((await stat(join(f.root, "sessions", clientId))).mode & 0o777).toBe(0o600);
  expect((await fetch(`${f.origin()}/auth/ticket`, { method: "POST" })).status).toBe(401);
  const headers = { Authorization: `Bearer ${token}`, "X-Tidy-Client": clientId };
  expect(
    (
      await fetch(`${f.origin()}/auth/ticket`, {
        method: "POST",
        headers: { ...headers, Origin: "https://evil.example" },
      })
    ).status,
  ).toBe(403);
  const response = await fetch(`${f.origin()}/auth/ticket`, { method: "POST", headers });
  const { ticket } = z.object({ ticket: z.string() }).parse(await response.json());
  const url = `${f.origin().replace("http:", "ws:")}/events?ticket=${ticket}`;
  const socket = new WebSocket(url);
  cleanups.push(() => socket.terminate());
  await new Promise<void>((resolve, reject) => {
    socket.once("message", () => resolve());
    socket.once("error", reject);
  });
  const replay = new WebSocket(url);
  await new Promise<void>((resolve) => replay.on("error", () => resolve()));
  expect(replay.readyState).not.toBe(WebSocket.OPEN);
  await f.sessions.revoke(clientId);
  expect((await fetch(`${f.origin()}/auth/ticket`, { method: "POST", headers })).status).toBe(401);
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  socket.send(JSON.stringify({ id: randomUUID(), name: "bootstrap" }));
  await closed;
});

test("project ownership excludes other runtimes and releases on close", async () => {
  const f = await fixture();
  const child = spawn(
    "node",
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    import {projectLocks} from "./src/main/remote/project-locks.ts";
    import assert from "node:assert/strict";
    const first = projectLocks(process.argv[1]);
    const second = projectLocks(process.argv[1]);
    const release = first.claim(process.argv[2]);
    const releaseAgain = first.claim(process.argv[2]);
    release(); release();
    assert.throws(() => second.claim(process.argv[2]), /another Tidy backend/);
    releaseAgain();
    const other = second.claim(process.argv[2]);
    other();
    first.claim(process.argv[2]);
    assert.throws(() => second.claim(process.argv[2]), /another Tidy backend/);
    first.close();
    second.claim(process.argv[2]);
    second.close();
  `,
      join(f.root, "locks"),
      f.projectPath,
    ],
    { cwd: new URL("../../..", import.meta.url), stdio: "pipe" },
  );
  const exitCode = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  expect(exitCode).toBe(0);
});

test("an unavailable project reports incomplete recovery without looping SSH reconnects", async () => {
  const f = await fixture();
  const { client, drops } = f.client();
  await until(() => client.status.kind === "connected");
  await client.operation("bootstrap");
  await rm(f.projectPath, { recursive: true, force: true });
  drops[0]();
  await until(() => client.status.kind === "reconnecting");
  await until(() => client.status.kind === "connected");
  expect(client.status.kind === "connected" && client.status.warning).toContain(
    "could not be refreshed",
  );
  expect(drops).toHaveLength(2);
});

test("accepted mutations are not replayed after a lost acknowledgement", async () => {
  const f = await fixture();
  const { client, drops } = f.client();
  await until(() => client.status.kind === "connected");
  await client.operation("bootstrap");
  let dropped = false;
  const unsubscribe = f.service.subscribe((event) => {
    if (event.type === "designs" && !dropped) {
      dropped = true;
      drops[0]();
    }
  });
  cleanups.push(() => {
    unsubscribe();
  });
  await client.operation("create-design", { projectId: f.project.id });
  await until(() => client.status.kind === "connected");
  expect(await f.store.designs(f.project.id)).toHaveLength(1);
});

test("managed backend refuses an update while an agent is running", async () => {
  const f = await fixture();
  const clientId = randomUUID();
  const token = await f.sessions.issue(clientId);
  let stopped = false;
  const host = createRemoteHost({
    service: f.service,
    sessions: f.sessions,
    receipts: new RequestReceipts(join(f.root, "receipts")),
    identity: { hostId: randomUUID(), instanceId: randomUUID(), buildId: "fixture" },
    shutdown: () => {
      stopped = true;
    },
  });
  const port = await host.listen();
  cleanups.push(() => host.close());
  const { client } = f.client();
  await until(() => client.status.kind === "connected");
  await client.operation("start-thread", {
    projectId: f.project.id,
    harness: "claude",
    prompt: "Stay running",
    designIds: [],
  });
  const response = await fetch(`http://127.0.0.1:${port}/maintenance/restart`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "X-Tidy-Client": clientId },
  });
  expect(response.status).toBe(409);
  expect(stopped).toBe(false);
  expect(f.service.activeRunCount).toBeGreaterThan(0);
});

test("wake probes healthy connections and replaces the tunnel after sleep", async () => {
  const f = await fixture();
  const { client, drops } = f.client();
  await until(() => client.status.kind === "connected");
  client.wake("active");
  await client.operation("bootstrap");
  expect(drops).toHaveLength(1);
  client.suspend();
  client.wake("resume");
  await until(() => drops.length === 2 && client.status.kind === "connected");
  expect(drops).toHaveLength(2);
});

test("offline recovery waits for network availability and does not unblock identity failures", async () => {
  const f = await fixture();
  const { client, drops } = f.client();
  await until(() => client.status.kind === "connected");
  client.suspend();
  drops[0]();
  client.wake("network", false);
  expect(client.status.kind).toBe("offline");
  client.wake("network", true);
  await until(() => drops.length === 2 && client.status.kind === "connected");
  await f.restart(true);
  await until(() => client.status.kind === "blocked");
  const attempts = drops.length;
  client.wake("resume");
  client.wake("network", true);
  expect(client.status.kind).toBe("blocked");
  expect(drops).toHaveLength(attempts);
});

test("browser verification survives focus changes and resumes automatically after approval", async () => {
  const f = await fixture();
  let approve = () => {};
  const approved = new Promise<void>((resolve) => {
    approve = resolve;
  });
  const url = "https://login.tailscale.com/a/fixture";
  const { client } = f.client({ approved, url });
  await until(() => client.status.kind === "verification");
  const status = client.status;
  if (status.kind !== "verification") throw new Error("Missing verification");
  expect(client.verificationURL(status.requestId)).toBe(url);
  expect(() => client.verificationURL(randomUUID())).toThrow("expired");
  client.wake("active");
  expect(client.status.kind).toBe("verification");
  approve();
  await until(() => client.status.kind === "connected");
  expect(() => client.verificationURL(status.requestId)).toThrow("expired");
});

test("cancelling verification prevents a late approval from reopening the connection", async () => {
  const f = await fixture();
  let approve = () => {};
  const approved = new Promise<void>((resolve) => {
    approve = resolve;
  });
  const { client, drops } = f.client({ approved, url: "https://login.tailscale.com/a/fixture" });
  await until(() => client.status.kind === "verification");
  const status = client.status;
  if (status.kind !== "verification") throw new Error("Missing verification");
  client.cancelVerification(status.requestId);
  approve();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(client.status.kind).toBe("blocked");
  expect(drops).toHaveLength(0);
  expect(() => client.verificationURL(status.requestId)).toThrow("expired");
});

test("normal probes tolerate a slow response while explicit retries use the quick deadline", async () => {
  const f = await fixture();
  const { client, drops } = f.client();
  await until(() => client.status.kind === "connected");
  const original = client.request.bind(client);
  let answer: (() => void) | undefined;
  const request = spyOn(client, "request").mockImplementation((name, input, context) =>
    name === "ping"
      ? new Promise((resolve) => {
          answer = () => resolve({ ok: true, data: null });
        })
      : original(name, input, context),
  );
  cleanups.push(() => request.mockRestore());
  client.wake("active");
  await new Promise((resolve) => setTimeout(resolve, 3200));
  expect(client.status.kind).toBe("connected");
  expect(drops).toHaveLength(1);
  answer?.();
  await new Promise((resolve) => setTimeout(resolve, 100));
  client.retry();
  await until(() => drops.length > 1, 6500);
  expect(drops).toHaveLength(2);
}, 15_000);

test("a quick probe shortens an existing probe without starting a second request", async () => {
  const f = await fixture();
  const { client, drops } = f.client();
  await until(() => client.status.kind === "connected");
  const original = client.request.bind(client);
  let pings = 0;
  const request = spyOn(client, "request").mockImplementation((name, input, context) => {
    if (name !== "ping") return original(name, input, context);
    pings++;
    return new Promise(() => {});
  });
  cleanups.push(() => request.mockRestore());
  client.wake("active");
  client.retry();
  client.wake("active");
  await until(() => drops.length === 2, 6500);
  expect(pings).toBe(1);
}, 8000);

test("an online notification preserves a healthy connection without an application probe", async () => {
  const f = await fixture();
  const { client, drops } = f.client();
  await until(() => client.status.kind === "connected");
  const request = spyOn(client, "request");
  client.wake("network", true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(request.mock.calls.filter(([name]) => name === "ping")).toHaveLength(0);
  expect(drops).toHaveLength(1);
  request.mockRestore();
});

test("a restarted offline client can read its private cache but cannot mutate or restart an agent", async () => {
  const f = await fixture();
  const cachePath = join(f.root, "machine-cache.json");
  const first = f.client(undefined, cachePath).client;
  await until(() => first.status.kind === "connected");
  const thread = await first.operation("start-thread", {
    projectId: f.project.id,
    harness: "claude",
    prompt: "Keep running",
    designIds: [],
  });
  await first.flush();
  first.close();
  const offline = new RemoteClient({
    machine: { id: randomUUID(), target: "fixture", hostId: null, lastConnectedAt: null },
    bundlePath: "unused",
    temporaryDirectory: f.root,
    cachePath,
    event() {},
    statusChanged() {},
    connected: async () => {},
    connector: async () => {
      throw new RemoteFailure("unavailable", "Offline fixture");
    },
  });
  cleanups.push(() => offline.close());
  offline.start();
  await until(() => offline.status.kind === "reconnecting");
  const cached = await offline.operation("read-thread", {
    threadId: thread.id,
    projectId: f.project.id,
  });
  expect(cached.id).toBe(thread.id);
  expect(cached.pendingApprovals).toBeUndefined();
  expect((await offline.operation("bootstrap")).projects).toHaveLength(1);
  await expect(offline.operation("create-design", { projectId: f.project.id })).rejects.toThrow(
    "reconnects",
  );
  expect(f.service.activeRunCount).toBe(1);
  offline.close();
  await offline.flush();
});

test("failed initial synchronization retries before reporting the new connection ready", async () => {
  const f = await fixture();
  const { client, statuses, drops } = f.client();
  await until(() => client.status.kind === "connected");
  const original = client.request.bind(client);
  let rejected = false;
  const request = spyOn(client, "request").mockImplementation((name, input, context) => {
    if (name === "bootstrap" && !rejected) {
      rejected = true;
      return Promise.reject(new Error("Temporary bootstrap failure"));
    }
    return original(name, input, context);
  });
  cleanups.push(() => request.mockRestore());
  statuses.length = 0;
  drops[0]();
  await until(() => rejected);
  expect(statuses.some((status) => status.kind === "connected")).toBe(false);
  await until(() => client.status.kind === "connected", 7000);
  expect(drops).toHaveLength(3);
}, 10000);

test("workspace reads bypass durable mutation receipts", async () => {
  const f = await fixture();
  const { client } = f.client();
  await until(() => client.status.kind === "connected");
  const design = await client.operation("create-design", { projectId: f.project.id });
  const before = await readdir(join(f.root, "receipts"));
  await client.operation("preview-design", { projectId: f.project.id, designId: design.id });
  await client.operation("refresh-design", {
    projectId: f.project.id,
    designId: design.id,
    version: design.version,
  });
  await client.operation("repository-context", { projectId: f.project.id });
  expect(
    await client.operation("thread-ports", { projectId: f.project.id, threadId: randomUUID() }),
  ).toEqual([]);
  await writeFile(join(f.project.path, "sample.txt"), "local fixture\n");
  const directory = await client.operation("repository-directory", {
    projectId: f.project.id,
    path: "",
  });
  expect(directory.entries.some((entry) => entry.path === "sample.txt")).toBe(true);
  expect(await client.operation("repository-changes", { projectId: f.project.id })).toEqual({
    repository: false,
    head: null,
    changes: [],
  });
  expect(
    await client.operation("repository-file", { projectId: f.project.id, path: "sample.txt" }),
  ).toEqual({ kind: "text", text: "local fixture\n", view: "file", comparison: "none" });
  await expect(
    client.operation("repository-file", { projectId: f.project.id, path: "../outside.txt" }),
  ).rejects.toThrow();
  expect(await readdir(join(f.root, "receipts"))).toEqual(before);
});

test("revoked sockets receive no new workspace data while valid clients retain ordered updates", async () => {
  const f = await fixture();
  async function connect() {
    const id = randomUUID(),
      token = await f.sessions.issue(id);
    const headers = { Authorization: `Bearer ${token}`, "X-Tidy-Client": id };
    const response = await fetch(`${f.origin()}/auth/ticket`, { method: "POST", headers });
    const { ticket } = z.object({ ticket: z.string() }).parse(await response.json());
    const socket = new WebSocket(`${f.origin().replace("http:", "ws:")}/events?ticket=${ticket}`);
    cleanups.push(() => socket.terminate());
    await new Promise<void>((resolve, reject) => {
      socket.once("message", () => resolve());
      socket.once("error", reject);
    });
    const events: DesktopEvent[] = [];
    socket.on("message", (data) => {
      const frame = z
        .object({ type: z.string(), event: z.unknown().optional() })
        .parse(JSON.parse(data.toString()));
      if (frame.type === "event") events.push(desktopEventSchema.parse(frame.event));
    });
    return { id, headers, socket, events };
  }
  const revoked = await connect(),
    valid = await connect();
  await f.sessions.revoke(revoked.id);
  const closed = new Promise<void>((resolve) => revoked.socket.once("close", () => resolve()));
  for (let index = 0; index < 3; index++) {
    await f.store.createDesign(f.project.id);
    await f.service.refreshDesigns(f.project.id);
  }
  await closed;
  await until(() => valid.events.length === 3);
  expect(revoked.events).toEqual([]);
  expect(
    valid.events.map((event) => (event.type === "designs" ? event.designs.length : -1)),
  ).toEqual([1, 2, 3]);
  expect(valid.socket.readyState).toBe(WebSocket.OPEN);
  expect(
    (await fetch(`${f.origin()}/auth/ticket`, { method: "POST", headers: valid.headers })).status,
  ).toBe(200);
});

test("host shutdown drains accepted mutations and durable receipts before returning", async () => {
  const f = await fixture();
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;
  const createDesign = f.store.createDesign.bind(f.store);
  const intercepted = spyOn(f.store, "createDesign").mockImplementation(async (...args) => {
    started = true;
    await held;
    return createDesign(...args);
  });
  const { client } = f.client();
  await until(() => client.status.kind === "connected");
  const result = client
    .request("create-design", { projectId: f.project.id })
    .catch(() => undefined);
  try {
    await until(() => started);
    client.close();
    let closed = false;
    const first = f.closeHost();
    const second = f.closeHost();
    expect(first).toBe(second);
    void first.then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closed).toBe(false);
    release();
    await first;
    expect((await f.store.designs(f.project.id)).length).toBe(1);
    const receipts = new RequestReceipts(join(f.root, "receipts"));
    const files = await readdir(join(f.root, "receipts"));
    const completed = files.filter((name) => name.endsWith(".json"));
    expect(completed.length).toBe(1);
    const receipt = z.string().parse(completed[0]);
    const clientId = z.string().uuid().parse(receipt.slice(0, 36));
    const requestId = z.string().uuid().parse(receipt.slice(37, -5));
    const status = await receipts.status(clientId, requestId);
    expect(status.kind).toBe("complete");
  } finally {
    release();
    intercepted.mockRestore();
    await result;
  }
});

test("cloud access withdrawal suppresses queued and stopping-thread events without revoking the backend session", async () => {
  const f = await fixture();
  const cloudPath = join(f.root, "cloud");
  await mkdir(cloudPath);
  const cloud = (await f.store.open(cloudPath, "Cloud workspace")).project;
  let allowed = true;
  f.service.canAccessCloudProject = () => allowed;
  f.service.authorizeCloudProject = async () => {
    if (!allowed) throw new Error("Cloud access withdrawn");
  };
  await f.service.startThread({
    projectId: cloud.id,
    executionProjectId: f.project.id,
    harness: "codex",
    prompt: "Private cloud work",
    designIds: [],
  });
  const clientId = randomUUID();
  const token = await f.sessions.issue(clientId);
  const headers = { Authorization: `Bearer ${token}`, "X-Tidy-Client": clientId };
  const response = await fetch(`${f.origin()}/auth/ticket`, { method: "POST", headers });
  const { ticket } = z.object({ ticket: z.string() }).parse(await response.json());
  const socket = new WebSocket(`${f.origin().replace("http:", "ws:")}/events?ticket=${ticket}`);
  cleanups.push(() => socket.terminate());
  await new Promise<void>((resolve, reject) => {
    socket.once("message", () => resolve());
    socket.once("error", reject);
  });
  const events: DesktopEvent[] = [];
  socket.on("message", (data) => {
    const frame = z
      .object({ type: z.string(), event: z.unknown().optional() })
      .parse(JSON.parse(data.toString()));
    if (frame.type === "event") events.push(desktopEventSchema.parse(frame.event));
  });
  await f.service.refreshDesigns(cloud.id);
  await until(() => events.length === 1);
  expect(events[0].type === "designs" && events[0].projectId).toBe(cloud.id);
  events.length = 0;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const validate = f.sessions.validate.bind(f.sessions);
  const validation = spyOn(f.sessions, "validate").mockImplementation(async (...args) => {
    entered.resolve();
    await release.promise;
    return validate(...args);
  });
  try {
    await f.service.refreshDesigns(cloud.id);
    await entered.promise;
    allowed = false;
    await f.service.stopCloudThreads();
    release.resolve();
    await until(() => f.service.activeRunCount === 0);
    await f.service.refreshDesigns(cloud.id);
    await f.service.refreshDesigns(f.project.id);
    await until(() => events.length === 1);
    expect(events[0].type === "designs" && events[0].projectId).toBe(f.project.id);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect((await fetch(`${f.origin()}/auth/ticket`, { method: "POST", headers })).status).toBe(
      200,
    );
    allowed = true;
    await f.service.refreshDesigns(cloud.id);
    await until(() => events.length === 2);
    expect(events[1].type === "designs" && events[1].projectId).toBe(cloud.id);
  } finally {
    release.resolve();
    validation.mockRestore();
  }
});

test("remote receipts reauthorize historical results and queued delivery without replay", async () => {
  const f = await fixture();
  const cloudPath = join(f.root, "receipt-cloud");
  await mkdir(cloudPath);
  const cloud = (await f.store.open(cloudPath, "Private cloud workspace")).project;
  let allowed = true;
  f.service.canAccessCloudProject = () => allowed;
  f.service.authorizeCloudProject = async () => {
    if (!allowed) throw new Error("Cloud access withdrawn");
  };
  const clientId = randomUUID();
  const token = await f.sessions.issue(clientId);
  const headers = { Authorization: `Bearer ${token}`, "X-Tidy-Client": clientId };
  const ticketResponse = await fetch(`${f.origin()}/auth/ticket`, { method: "POST", headers });
  const { ticket } = z.object({ ticket: z.string() }).parse(await ticketResponse.json());
  const socket = new WebSocket(`${f.origin().replace("http:", "ws:")}/events?ticket=${ticket}`);
  cleanups.push(() => socket.terminate());
  await new Promise<void>((resolve, reject) => {
    socket.once("message", () => resolve());
    socket.once("error", reject);
  });
  const frames = new Map<string, unknown>();
  socket.on("message", (data) => {
    const frame = z
      .object({ type: z.string(), id: z.string().optional(), response: z.unknown().optional() })
      .parse(JSON.parse(data.toString()));
    if (frame.type === "result" && frame.id) frames.set(frame.id, frame.response);
  });
  const request = {
    id: randomUUID(),
    name: "create-design-folder",
    input: { projectId: cloud.id, name: "Private folder" },
  };
  async function exchange(command: typeof request | { id: string; name: string; input: string }) {
    frames.delete(command.id);
    socket.send(JSON.stringify(command));
    await until(() => frames.has(command.id));
    return frames.get(command.id);
  }
  const original = await exchange(request);
  expect(original).toMatchObject({ ok: true });
  const receipt = () => ({ id: randomUUID(), name: "receipt", input: request.id });
  allowed = false;
  const denied = {
    ok: false,
    error: expect.stringContaining("access to its stored result is unavailable"),
  };
  expect(await exchange(receipt())).toEqual({
    ok: true,
    data: { kind: "complete", response: denied },
  });
  expect(await exchange(request)).toEqual(denied);
  allowed = true;
  expect(await exchange(receipt())).toEqual({
    ok: true,
    data: { kind: "complete", response: original },
  });
  for (const command of [
    receipt(),
    request,
    { id: randomUUID(), name: "project-snapshot", input: cloud.id },
  ]) {
    allowed = true;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const validate = f.sessions.validate.bind(f.sessions);
    let validations = 0;
    const intercepted = spyOn(f.sessions, "validate").mockImplementation(async (...args) => {
      if (++validations === 2) {
        entered.resolve();
        await release.promise;
      }
      return validate(...args);
    });
    try {
      const queued = exchange(command);
      await entered.promise;
      allowed = false;
      release.resolve();
      expect(await queued).toEqual(
        command.name === "receipt"
          ? { ok: true, data: { kind: "complete", response: denied } }
          : denied,
      );
    } finally {
      release.resolve();
      intercepted.mockRestore();
    }
  }
  expect(socket.readyState).toBe(WebSocket.OPEN);
  expect((await fetch(`${f.origin()}/auth/ticket`, { method: "POST", headers })).status).toBe(200);
  allowed = true;
  expect(await exchange(request)).toEqual(original);
  expect((await f.store.folders(cloud.id)).length).toBe(1);
});

test("remote removal persists its cache purge before reaching the host", async () => {
  const f = await fixture();
  const cachePath = join(f.root, "removal-cache.json");
  const { client } = f.client(undefined, cachePath);
  await until(() => client.status.kind === "connected");
  await client.operation("bootstrap");
  await client.flush();
  expect(await readFile(cachePath, "utf8")).toContain(f.project.id);
  const remove = f.service.removeProject.bind(f.service);
  const removal = spyOn(f.service, "removeProject").mockImplementation(async (id) => {
    expect(await readFile(cachePath, "utf8")).not.toContain(id);
    return remove(id);
  });
  try {
    await client.operation("remove-project", f.project.id);
    expect(removal).toHaveBeenCalledTimes(1);
    expect(f.store.projects).toHaveLength(0);
  } finally {
    removal.mockRestore();
  }
});

test("a failed cache purge prevents the remote removal request", async () => {
  const f = await fixture();
  const cachePath = join(f.root, "failed-removal-cache.json");
  const { client } = f.client(undefined, cachePath);
  await until(() => client.status.kind === "connected");
  await client.operation("bootstrap");
  await client.flush();
  const removal = spyOn(f.service, "removeProject");
  const write = sessionStore.writePrivateJSON;
  const failure = spyOn(sessionStore, "writePrivateJSON").mockImplementation(
    (path, value, options) => {
      if (options?.durable) return Promise.reject(new Error("Cache purge write failed"));
      return write(path, value, options);
    },
  );
  try {
    await expect(client.operation("remove-project", f.project.id)).rejects.toThrow(
      "Cache purge write failed",
    );
    expect(removal).not.toHaveBeenCalled();
    expect(f.store.projects.map((project) => project.id)).toContain(f.project.id);
    expect(await readFile(cachePath, "utf8")).toContain(f.project.id);
    await client.flush();
    expect(await readFile(cachePath, "utf8")).toContain(f.project.id);
  } finally {
    failure.mockRestore();
    removal.mockRestore();
  }
});

test("a rejected removal preserves tracked thread recovery across reconnect", async () => {
  const f = await fixture();
  const cachePath = join(f.root, "tracked-cache.json");
  const { client, events, drops } = f.client(undefined, cachePath);
  await until(() => client.status.kind === "connected");
  const thread = await client.operation("start-thread", {
    projectId: f.project.id,
    harness: "claude",
    prompt: "Keep running",
    designIds: [],
  });
  await expect(client.operation("remove-project", f.project.id)).rejects.toThrow("active work");
  expect(await readFile(cachePath, "utf8")).toContain(thread.id);
  expect(await readFile(cachePath, "utf8")).toContain(f.project.id);
  events.length = 0;
  drops[0]();
  await until(() => client.status.kind === "reconnecting");
  await until(() => client.status.kind === "connected");
  expect(events.some((event) => event.type === "thread" && event.thread.id === thread.id)).toBe(
    true,
  );
});

test("a lost removal acknowledgement does not restore purged offline data", async () => {
  const f = await fixture();
  const cachePath = join(f.root, "lost-removal-cache.json");
  const { client } = f.client(undefined, cachePath);
  await until(() => client.status.kind === "connected");
  await client.operation("bootstrap");
  await client.flush();
  const request = client.request.bind(client);
  const disconnect = spyOn(client, "request").mockImplementation(async (...args) => {
    const result = await request(...args);
    if (args[0] === "remove-project")
      throw new RemoteFailure("unavailable", "Lost acknowledgement");
    return result;
  });
  try {
    await expect(client.operation("remove-project", f.project.id)).rejects.toThrow(
      "Lost acknowledgement",
    );
    expect(f.store.projects).toHaveLength(0);
    expect(await readFile(cachePath, "utf8")).not.toContain(f.project.id);
  } finally {
    disconnect.mockRestore();
  }
});

test("browser queries reject mutations and do not create durable command receipts", async () => {
  const f = await fixture();
  const { client } = f.client();
  await until(() => client.status.kind === "connected");
  const directory = join(f.root, "receipts");
  await mkdir(directory, { recursive: true });
  const scope = { projectId: f.project.id, threadId: randomUUID() };
  await expect(
    client.operation("browser-query", {
      ...scope,
      action: { kind: "console", tabId: randomUUID() },
    }),
  ).rejects.toThrow("no longer open");
  await expect(
    client.operation("browser-query", { ...scope, action: { kind: "open", url: "about:blank" } }),
  ).rejects.toThrow();
  expect(await readdir(directory)).toEqual([]);
  await expect(
    client.operation("browser-command", { ...scope, action: { kind: "open", url: "about:blank" } }),
  ).rejects.toThrow("Open the browser preview");
  expect(f.service.browser.activeCount).toBe(0);
});

test("hosts without draft cleanup support disable previews without blocking project work", async () => {
  const f = await fixture();
  const { client } = f.client();
  await until(() => client.status.kind === "connected");
  const fetch = globalThis.fetch;
  const health = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      (...args: Parameters<typeof fetch>) => {
        if (String(args[0]) === `${f.origin()}/health`)
          return Promise.resolve(Response.json({ capabilities: ["browser-v2"] }));
        return fetch(...args);
      },
      { preconnect: fetch.preconnect },
    ),
  );
  const events: BrowserOutput[] = [];
  const watch = client.watchBrowser(
    { projectId: f.project.id, threadId: randomUUID() },
    randomUUID(),
    (event) => events.push(event),
  );
  try {
    await until(() => events.some((event) => event.kind === "disconnected"));
    expect(events).toContainEqual({
      kind: "disconnected",
      message: "Browser previews need a host update.",
    });
    expect(
      events.some((event) => event.kind === "error" && event.message.includes("backend update")),
    ).toBe(true);
    expect((await client.operation("bootstrap")).activeProject?.project.id).toBe(f.project.id);
    expect(f.service.browser.activeCount).toBe(0);
  } finally {
    watch.close();
    health.mockRestore();
  }
});

test("browser paste tolerates bounded socket pressure while other input remains bounded", async () => {
  const f = await fixture();
  const { client } = f.client();
  await until(() => client.status.kind === "connected");
  const scope = { projectId: f.project.id, threadId: randomUUID() };
  const received: string[] = [];
  const attach = f.service.browser.watch.bind(f.service.browser);
  const observe = spyOn(f.service.browser, "watch").mockImplementation(async (...args) => {
    const watch = await attach(...args);
    return {
      ...watch,
      input(value) {
        if (value.input.kind === "text") received.push(value.input.text);
        watch.input(value);
      },
    };
  });
  let ready = false;
  let disconnected = false;
  const watch = client.watchBrowser(scope, randomUUID(), (event) => {
    if (event.kind === "state") ready = true;
    if (event.kind === "disconnected") disconnected = true;
  });
  const pressure = Object.getOwnPropertyDescriptor(WebSocket.prototype, "bufferedAmount");
  if (!pressure) throw new Error("Socket buffer accessor is unavailable.");
  try {
    await until(() => ready);
    Object.defineProperty(WebSocket.prototype, "bufferedAmount", {
      ...pressure,
      get: () => 256 * 1024,
    });
    const chunk = "界".repeat(15998) + "😀";
    for (let i = 0; i < 32; i++)
      watch.input({ tabId: null, viewId: null, input: { kind: "text", text: chunk } });
    await until(() => received.length === 32);
    expect(received.join("")).toBe(chunk.repeat(32));
    expect(disconnected).toBe(false);
    watch.input({ tabId: null, viewId: null, input: { kind: "release-control" } });
    await until(() => disconnected);
  } finally {
    Object.defineProperty(WebSocket.prototype, "bufferedAmount", pressure);
    watch.close();
    observe.mockRestore();
  }
});

test("remote video previews transfer external host files and enforce thread ownership", async () => {
  const f = await fixture();
  const { client } = f.client();
  await until(() => client.status.kind === "connected");
  const thread = await client.operation("start-thread", {
    projectId: f.project.id,
    harness: "claude",
    prompt: "Record a feature",
    designIds: [],
  });
  const data = Buffer.alloc(512 * 1024 + 13, 21);
  const href = join(f.root, "temporary recording.webm");
  await writeFile(href, data);
  const input = { projectId: f.project.id, threadId: thread.id, href, offset: 0 };
  const first = await client.operation("read-video-chunk", input);
  const second = await client.operation("read-video-chunk", {
    ...input,
    offset: 512 * 1024,
    revision: first.revision,
  });
  expect(
    Buffer.concat([Buffer.from(first.data, "base64"), Buffer.from(second.data, "base64")]),
  ).toEqual(data);
  await expect(
    client.operation("read-video-chunk", { ...input, threadId: randomUUID() }),
  ).rejects.toThrow();
  const otherPath = join(f.root, "other");
  await mkdir(otherPath);
  const other = (await f.store.open(otherPath)).project;
  await expect(
    client.operation("read-video-chunk", { ...input, projectId: other.id }),
  ).rejects.toThrow("another project");
});

test("repository notifications require per-connection capability opt-in", async () => {
  const f = await fixture();
  const legacy = f.client();
  const modern = f.client();
  await until(() => [legacy, modern].every(({ client }) => client.status.kind === "connected"));
  await modern.client.operation("repository-directory", { projectId: f.project.id, path: "" });
  await writeFile(join(f.projectPath, "changed.txt"), "fixture\n");
  await until(() => modern.events.some((event) => event.type === "repository-change"));
  await legacy.client.operation("project-snapshot", f.project.id);
  expect(legacy.events.some((event) => event.type === "repository-change")).toBe(false);
  expect(legacy.client.status.kind).toBe("connected");
});
