import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, rm, stat, readdir } from "node:fs/promises";
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

import { type ConnectionStatus } from "../../shared/remote";
import type { DesktopEvent } from "../../shared/contracts/desktop";
import { parseWorkspaceResponse } from "../../shared/contracts/workspace-response";
import { directoryResponseSchema } from "../../shared/contracts/browser-directory";

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
    first.claim(process.argv[2]);
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
  expect(await readdir(join(f.root, "receipts"))).toEqual(before);
});
