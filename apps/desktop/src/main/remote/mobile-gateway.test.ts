import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { createMobileGateway } from "./mobile-gateway";
import { createRemoteHost } from "./host";
import { SessionStore } from "./session-store";
import { RequestReceipts } from "./receipts";
import { ProjectStore } from "../workspace/project-store";
import { WorkspaceService } from "../workspace/workspace-service";
import { RemoteConnection, type ConnectionState } from "../../../../mobile/src/connection";
import type { DesktopEvent } from "../../shared/contracts/desktop";
import type { HarnessUpdate } from "../harnesses/harnesses";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function until(condition: () => boolean) {
  const deadline = Date.now() + 6000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out.");
    await Bun.sleep(10);
  }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tidy-mobile-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new ProjectStore(join(root, "workspace"));
  await store.initialize();
  await mkdir(join(root, "project"));
  const project = (await store.open(join(root, "project"))).project;
  let runs = 0;
  let output: ((text: string) => void) | undefined;
  let update: ((event: HarnessUpdate) => void) | undefined;
  const service = new WorkspaceService(
    store,
    (options) => {
      runs++;
      update = options.onUpdate;
      output = (text) => options.onUpdate({ type: "message", id: "assistant", text });
      let finish!: () => void;
      return {
        done: new Promise<void>((resolve) => {
          finish = resolve;
        }),
        stop: () => finish(),
        respondToApproval: () => true,
      };
    },
    async () => "/fixture/agent",
    async () => {},
  );
  const sessions = new SessionStore(join(root, "sessions"));
  const hostId = randomUUID();
  const clientId = randomUUID();
  const token = await sessions.issue(clientId);
  const host = createRemoteHost({
    service,
    identity: { hostId, instanceId: randomUUID(), buildId: "test" },
    sessions,
    receipts: new RequestReceipts(join(root, "receipts")),
  });
  const hostPort = await host.listen();
  cleanup.push(async () => {
    await host.close();
    await service.close();
  });
  const origin = "https://fixture.example.ts.net";
  const gateway = createMobileGateway(origin, async () => hostPort);
  const port = await gateway.listen(0);
  cleanup.push(() => gateway.close());
  const headers = {
    Host: "fixture.example.ts.net",
    Authorization: `Bearer ${token}`,
    "X-Tidy-Client": clientId,
  };
  const url = `http://127.0.0.1:${port}`;
  const states: ConnectionState[] = [];
  const events: DesktopEvent[] = [];
  let socket: WebSocket;
  const pairing = { version: 1 as const, origin, hostId, clientId, token };
  const connection = new RemoteConnection(
    pairing,
    { state: (state) => states.push(state), event: (event) => events.push(event), ready() {} },
    {
      uuid: randomUUID,
      fetch: ((input: string | URL | Request, init?: RequestInit) =>
        fetch(String(input).replace(origin, url), {
          ...init,
          headers: {
            ...Object.fromEntries(new Headers(init?.headers).entries()),
            Host: headers.Host,
          },
        })) as typeof fetch,
      socket: (target) => {
        socket = new WebSocket(
          target.replace("wss://fixture.example.ts.net", `ws://127.0.0.1:${port}`),
          { headers: { Host: headers.Host, Origin: origin } },
        );
        return socket as unknown as globalThis.WebSocket;
      },
    },
  );
  cleanup.push(() => connection.close());
  return {
    project,
    connection,
    states,
    events,
    headers,
    url,
    pairing,
    sessions,
    service,
    runs: () => runs,
    drop: () => socket.terminate(),
    output: (text: string) => output?.(text),
    update: (event: HarnessUpdate) => update?.(event),
  };
}

test("gateway exposes only authenticated tickets and sockets, rejects arbitrary hosts and browser origins", async () => {
  const f = await fixture();
  for (const path of ["/health", "/maintenance/restart", "/", "/auth/ticket?next=evil"]) {
    expect((await fetch(f.url + path, { method: "POST", headers: f.headers })).status).toBe(403);
  }
  for (const headers of [
    { ...f.headers, Host: "evil.test" },
    { ...f.headers, Origin: "https://evil.test" },
  ])
    expect((await fetch(f.url + "/auth/ticket", { method: "POST", headers })).status).toBe(403);
  expect(
    (await fetch(f.url + "/auth/ticket", { method: "POST", headers: { Host: f.headers.Host } }))
      .status,
  ).toBe(401);
  expect((await fetch(f.url + "/auth/ticket", { method: "POST", headers: f.headers })).status).toBe(
    200,
  );
});

test("phone uses the real host to start, stream, queue, stop, resume and deduplicate requests", async () => {
  const f = await fixture();
  f.connection.start();
  await until(() => f.states.at(-1) === "connected");
  const snapshot = await f.connection.request("select-project", f.project.id);
  expect(snapshot.project.id).toBe(f.project.id);
  const id = randomUUID();
  const input = {
    projectId: f.project.id,
    threadId: randomUUID(),
    messageId: randomUUID(),
    harness: "codex",
    prompt: "Test task",
    designIds: [],
  };
  const started = await f.connection.request("start-thread", input, { id });
  expect(started.status).toBe("running");
  expect(f.runs()).toBe(1);
  f.output("Hello from the remote agent");
  await until(() =>
    f.events.some((event) => event.type === "thread-patch" || event.type === "thread"),
  );
  f.drop();
  await until(() => f.states.at(-1) === "reconnecting");
  const replay = await f.connection.request("start-thread", input, { id });
  expect(replay.id).toBe(started.id);
  expect(f.runs()).toBe(1);
  const approvalId = randomUUID();
  f.update({
    type: "approval",
    request: { id: approvalId, title: "Run checks?", choices: ["allow", "deny"] },
  });
  const awaiting = await f.connection.request("read-thread", {
    projectId: f.project.id,
    threadId: started.id,
  });
  expect(awaiting.pendingApprovals?.[0].id).toBe(approvalId);
  await expect(
    f.connection.request("respond-approval", {
      projectId: f.project.id,
      threadId: started.id,
      approvalId,
      decision: "allow-session",
    }),
  ).rejects.toThrow("no longer available");
  const approved = await f.connection.request("respond-approval", {
    projectId: f.project.id,
    threadId: started.id,
    approvalId,
    decision: "allow",
  });
  expect(approved.pendingApprovals).toEqual([]);
  const queued = await f.connection.request("send-message", {
    projectId: f.project.id,
    threadId: started.id,
    messageId: randomUUID(),
    text: "Follow-up",
    delivery: "queue",
  });
  expect(queued.queuedMessages?.[0].text).toBe("Follow-up");
  await f.connection.request("message-queue", {
    projectId: f.project.id,
    threadId: started.id,
    action: { kind: "remove", messageId: queued.queuedMessages![0].id },
  });
  f.connection.pause();
  expect(f.service.activeRunCount).toBe(1);
  f.connection.start();
  await until(() => f.states.at(-1) === "connected");
  const resumed = await f.connection.request("read-thread", {
    projectId: f.project.id,
    threadId: started.id,
  });
  expect(
    resumed.messages.some((message) => message.text.includes("Hello from the remote agent")),
  ).toBe(true);
  await f.connection.request("stop-thread", { projectId: f.project.id, threadId: started.id });
  await until(() => f.service.activeRunCount === 0);
});

test("phone blocks changed host identity and revoked credentials", async () => {
  const f = await fixture();
  f.pairing.hostId = randomUUID();
  f.connection.start();
  await until(() => f.states.at(-1) === "blocked");
  await f.sessions.revoke(f.pairing.clientId);
  f.connection.start();
  await until(() => f.states.at(-1) === "blocked");
  expect(f.runs()).toBe(0);
});
