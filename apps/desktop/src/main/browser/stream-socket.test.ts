import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { browserEventSchema } from "../../shared/contracts/browser";
import { z } from "zod";
import { WebSocket } from "ws";
import { ProjectStore } from "../workspace/project-store";
import { WorkspaceService } from "../workspace/workspace-service";
import { createRemoteHost } from "../remote/host";
import { SessionStore } from "../remote/session-store";
import { RequestReceipts } from "../remote/receipts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tidy-browser-stream-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const store = new ProjectStore(join(root, "state"));
  await store.initialize();
  await mkdir(join(root, "project"));
  const project = (await store.open(join(root, "project"))).project;
  const service = new WorkspaceService(store);
  cleanups.push(() => service.close());
  const sessions = new SessionStore(join(root, "sessions"));
  const clientId = randomUUID(),
    token = await sessions.issue(clientId);
  const host = createRemoteHost({
    service,
    sessions,
    identity: { hostId: randomUUID(), instanceId: randomUUID(), buildId: "browser-test" },
    receipts: new RequestReceipts(join(root, "receipts")),
  });
  const port = await host.listen();
  cleanups.push(() => host.close());
  const origin = `http://127.0.0.1:${port}`;
  const ticket = async () => {
    const response = await fetch(`${origin}/auth/ticket`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "X-Tidy-Client": clientId },
    });
    return z.object({ ticket: z.string() }).parse(await response.json()).ticket;
  };
  const open = async () => {
    const params = new URLSearchParams({
      ticket: await ticket(),
      projectId: project.id,
      threadId: randomUUID(),
      viewerId: randomUUID(),
    });
    const socket = new WebSocket(`${origin.replace("http:", "ws:")}/browser-stream?${params}`);
    cleanups.push(async () => {
      socket.terminate();
    });
    const messages: string[] = [];
    socket.on("message", (data) => messages.push(data.toString()));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return { socket, messages };
  };
  return { sessions, clientId, host, open };
}

test("remote browser stream requires a session ticket and stops on revocation", async () => {
  const { sessions, clientId, open } = await fixture();
  const { socket, messages } = await open();
  await new Promise<void>((resolve) => {
    if (messages.length) resolve();
    else socket.once("message", () => resolve());
  });
  expect(messages[0]).toContain('"kind":"state"');
  await sessions.revoke(clientId);
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  socket.send(JSON.stringify({ tabId: null, viewId: null, input: { kind: "take-control" } }));
  await closed;
  expect(messages).toHaveLength(1);
}, 5000);

test("backend shutdown closes upgraded browser sockets without waiting on the viewer", async () => {
  const { host, open } = await fixture();
  const { socket } = await open();
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  await host.close();
  await closed;
  expect(socket.readyState).toBe(WebSocket.CLOSED);
}, 5000);

test("remote permission checks preserve take-control and release-control ordering", async () => {
  const { sessions, open } = await fixture();
  const { socket, messages } = await open();
  if (!messages.length)
    await new Promise<void>((resolve) => socket.once("message", () => resolve()));
  const validate = sessions.validate.bind(sessions);
  const permission = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  let checks = 0;
  sessions.validate = async (...args) => {
    if (++checks === 1) {
      started.resolve();
      await permission.promise;
    }
    return validate(...args);
  };
  socket.send(JSON.stringify({ tabId: null, viewId: null, input: { kind: "take-control" } }));
  await started.promise;
  socket.send(JSON.stringify({ tabId: null, viewId: null, input: { kind: "release-control" } }));
  const timer = setTimeout(() => permission.resolve(), 30);
  try {
    const deadline = Date.now() + 2000;
    while (messages.length < 3 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    const controls = messages
      .map((message) => browserEventSchema.parse(JSON.parse(message)))
      .flatMap((event) => (event.kind === "state" ? [event.state.control] : []));
    expect(controls).toEqual(["available", "you", "available"]);
  } finally {
    clearTimeout(timer);
    permission.resolve();
  }
}, 5000);
