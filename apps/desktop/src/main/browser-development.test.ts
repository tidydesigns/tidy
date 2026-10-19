import { randomUUID } from "node:crypto";
import { parseWorkspaceResponse, type WorkspaceOperation } from "../shared/workspace-response";
import { browserRecovery } from "../shared/browser-recovery";
import { desktopEventSchema, storedThreadSchema } from "../shared/thread-schema";
import type { DesktopEvent, ProjectSnapshot, Thread } from "../shared/contracts";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { directoryResponseSchema } from "../shared/browser-directory";
import { browserDevelopment } from "./browser-development";
import { ProjectStore } from "./project-store";
import { WorkspaceService } from "./workspace-service";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "tidy-browser-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, "project");
  await mkdir(project);
  const store = new ProjectStore(join(directory, "state"));
  await store.initialize();
  const snapshot = await store.open(project);
  const service = new WorkspaceService(store);
  const server = createServer((request, response) => {
    void gateway.middleware(request, response, () => {
      response.end("renderer");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No server address.");
  const origin = new URL(`http://127.0.0.1:${address.port}`);
  const token = "private-development-token";
  let gateway = browserDevelopment(service, project, origin, token);
  cleanups.push(async () => {
    gateway.close();
    await service.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  async function login() {
    const response = await fetch(new URL("/__tidy/session", origin), {
      method: "POST",
      headers: { Origin: origin.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Max-Age=604800");
    return cookie.split(";")[0];
  }
  return {
    origin,
    token,
    gateway,
    service,
    store,
    directory,
    project,
    projectId: snapshot.project.id,
    login,
    restart(nextToken = token) {
      gateway.close();
      gateway = browserDevelopment(service, project, origin, nextToken);
    },
  };
}

test("browser gateway requires authentication for APIs, events, source files and HMR", async () => {
  const { origin, token, gateway } = await fixture();
  for (const path of ["/__tidy/request", "/__tidy/events", "/src/main.tsx", "/@fs/etc/passwd"]) {
    expect((await fetch(new URL(path, origin))).status).toBe(401);
  }
  const page = await (await fetch(origin)).text();
  expect(page).not.toContain(token);
  expect(page).toContain("location.hash");
  expect(
    gateway.authorizeUpgrade({
      headers: { host: origin.host, origin: origin.origin },
    } as Parameters<typeof gateway.authorizeUpgrade>[0]),
  ).toBe(false);
  const response = await fetch(new URL("/__tidy/session", origin), {
    method: "POST",
    headers: { Origin: "https://other.example", "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  expect(response.status).toBe(403);
});

test("authenticated browser requests retain origin, host and operation validation", async () => {
  const { origin, login } = await fixture();
  const cookie = await login();
  const request = (name: string, input?: unknown, requestOrigin = origin.origin) =>
    fetch(new URL("/__tidy/request", origin), {
      method: "POST",
      headers: { Cookie: cookie, Origin: requestOrigin, "Content-Type": "application/json" },
      body: JSON.stringify({ name, input }),
    });
  expect((await request("harnesses", undefined, "https://other.example")).status).toBe(403);
  expect((await request("create-design", { projectId: "not-a-project" })).status).toBe(400);
  expect((await request("run-arbitrary-command", {})).status).toBe(400);
  const response = await fetch(origin, { headers: { Cookie: cookie, Host: "untrusted.example" } });
  expect(response.status).toBe(403);
});

test("browser design edits persist through the shared backend and stream live events", async () => {
  const { origin, projectId, store, login } = await fixture();
  const cookie = await login();
  const abort = new AbortController();
  cleanups.push(async () => abort.abort());
  const response = await fetch(new URL("/__tidy/events", origin), {
    headers: { Cookie: cookie },
    signal: abort.signal,
  });
  const reader = response.body!.getReader();
  await reader.read();
  const result = await fetch(new URL("/__tidy/request", origin), {
    method: "POST",
    headers: { Cookie: cookie, Origin: origin.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "create-design", input: { projectId } }),
  });
  const created = (await result.json()) as { ok: boolean; data: { id: string; version: string } };
  expect(created.ok).toBe(true);
  expect((await store.readDesign(projectId, created.data.id)).version).toBe(created.data.version);
  let event = "";
  while (!event.includes('"type":"designs"')) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("Event stream closed before the design update.");
    event += new TextDecoder().decode(chunk.value);
  }
  expect(event).toContain(created.data.id);
  await reader.cancel();
});

test("browser picker lists Linux folders and opens a different persisted project", async () => {
  const { origin, login, directory, project, store, projectId } = await fixture();
  const other = join(directory, "other-project");
  await mkdir(other);
  await mkdir(join(directory, ".private"));
  await writeFile(join(directory, "ordinary-file"), "not a directory");
  await symlink(other, join(directory, "linked-folder"));
  const cookie = await login();
  const listURL = new URL(`/__tidy/directories?path=${encodeURIComponent(directory)}`, origin);
  expect((await fetch(listURL)).status).toBe(401);
  const list = directoryResponseSchema.parse(
    await (await fetch(listURL, { headers: { Cookie: cookie } })).json(),
  );
  if (!list.ok) throw new Error(list.error);
  const names = list.data.directories.map((entry) => entry.name);
  expect(names).toContain("other-project");
  expect(names).not.toContain("ordinary-file");
  expect(names).not.toContain(".private");
  expect(names).not.toContain("linked-folder");
  const open = (path: string, requestOrigin = origin.origin) =>
    fetch(new URL("/__tidy/request", origin), {
      method: "POST",
      headers: { Cookie: cookie, Origin: requestOrigin, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "open-project", projectPath: path }),
    });
  expect((await open(other, "https://other.example")).status).toBe(403);
  expect((await open("relative/path")).status).toBe(400);
  expect((await open(join(directory, "ordinary-file"))).status).toBe(400);
  expect(store.activeProjectId).toBe(projectId);
  const opened = (await (await open(other)).json()) as {
    ok: boolean;
    data: { project: { id: string; path: string } };
  };
  expect(opened.ok).toBe(true);
  expect(opened.data.project.path).toBe(other);
  expect(opened.data.project.path).not.toBe(project);
  const restored = new ProjectStore(join(directory, "state"));
  await restored.initialize();
  expect(restored.activeProjectId).toBe(opened.data.project.id);
  expect(restored.projects.map((project) => project.path)).toContain(project);
});

test("browser sign-in survives development restarts and is revoked by token rotation", async () => {
  const { origin, login, restart } = await fixture();
  const cookie = await login();
  const source = () => fetch(new URL("/src/main.tsx", origin), { headers: { Cookie: cookie } });
  expect((await source()).status).toBe(200);
  restart();
  expect((await source()).status).toBe(200);
  restart("rotated-private-development-token");
  expect((await source()).status).toBe(401);
});

test("directory responses reject malformed success and error payloads", () => {
  for (const value of [
    null,
    {},
    { ok: true },
    { ok: false, error: 42 },
    {
      ok: true,
      data: {
        path: "/tmp",
        parent: null,
        initialProject: "/tmp",
        directories: [{ name: "project", path: 42 }],
      },
    },
  ])
    expect(directoryResponseSchema.safeParse(value).success).toBe(false);
  expect(directoryResponseSchema.parse({ ok: false, error: "Folder not found" })).toEqual({
    ok: false,
    error: "Folder not found",
  });
});

function conversation(projectId: string): Thread {
  return {
    id: randomUUID(),
    projectId,
    revision: 1,
    title: "Review",
    harness: "codex",
    messages: [{ id: randomUUID(), role: "user", text: "Review this project" }],
    designIds: [],
    status: "completed",
    updatedAt: new Date().toISOString(),
  };
}
function deferred<T>() {
  let complete: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    complete = resolve;
  });
  return {
    promise,
    resolve(value: T) {
      complete?.(value);
    },
  };
}

test("recovery refreshes cached projects without selecting them and continues past unavailable projects", async () => {
  const { store, service, directory, projectId } = await fixture();
  const unavailable = join(directory, "unavailable");
  await mkdir(unavailable);
  const missing = await store.open(unavailable);
  const other = join(directory, "second");
  await mkdir(other);
  const active = await store.open(other);
  const originalThread = conversation(projectId);
  const activeThread = conversation(active.project.id);
  await store.writeThread(originalThread);
  await store.writeThread(activeThread);
  await rm(unavailable, { recursive: true });
  const events: DesktopEvent[] = [];
  const errors: unknown[] = [];
  const recovery = browserRecovery({
    bootstrap: async () => ({
      projects: store.projects,
      activeProject: await store.snapshot(active.project.id),
      harnesses: [],
    }),
    snapshot: (id) => store.snapshot(id),
    readThread: (id, threadId) => service.readThread(id, threadId),
    listener: (event) => events.push(event),
    onError: (error) => errors.push(error),
  });
  recovery.remember(missing);
  recovery.remember(await store.snapshot(projectId));
  await recovery.refresh();
  expect(errors).toHaveLength(1);
  expect(events.filter((event) => event.type === "thread").map((event) => event.thread.id)).toEqual(
    [originalThread.id, activeThread.id],
  );
  expect(store.activeProjectId).toBe(active.project.id);
  recovery.close();
});

test("unsubscribing suppresses delayed recovery and superseded recovery cannot overwrite a newer pass", async () => {
  const { store, service, projectId } = await fixture();
  const project = await store.snapshot(projectId);
  const wait = deferred<ProjectSnapshot>();
  const events: DesktopEvent[] = [];
  let reads = 0;
  const recovery = browserRecovery({
    bootstrap: async () => ({ projects: store.projects, activeProject: project, harnesses: [] }),
    snapshot: () => (++reads === 1 ? wait.promise : Promise.resolve(project)),
    readThread: (id, threadId) => service.readThread(id, threadId),
    listener: (event) => events.push(event),
    onError: (error) => {
      throw error;
    },
  });
  const first = recovery.refresh();
  await Promise.resolve();
  await recovery.refresh();
  expect(events).toHaveLength(1);
  wait.resolve(project);
  await first;
  expect(events).toHaveLength(1);

  const waiting = deferred<ProjectSnapshot>();
  const closed = browserRecovery({
    bootstrap: async () => ({ projects: store.projects, activeProject: project, harnesses: [] }),
    snapshot: () => waiting.promise,
    readThread: (id, threadId) => service.readThread(id, threadId),
    listener: (event) => events.push(event),
    onError: (error) => {
      throw error;
    },
  });
  const pending = closed.refresh();
  await Promise.resolve();
  closed.close();
  waiting.resolve(project);
  await pending;
  expect(events).toHaveLength(1);
  closed.receive({ type: "designs", projectId, designs: [], folders: [] });
  expect(events).toHaveLength(1);
  recovery.close();
});

test("live design events win over an older in-flight project snapshot", async () => {
  const { store, service, projectId } = await fixture();
  const project = await store.snapshot(projectId);
  const wait = deferred<ProjectSnapshot>();
  const events: DesktopEvent[] = [];
  const recovery = browserRecovery({
    bootstrap: async () => ({ projects: store.projects, activeProject: project, harnesses: [] }),
    snapshot: () => wait.promise,
    readThread: (id, threadId) => service.readThread(id, threadId),
    listener: (event) => events.push(event),
    onError: (error) => {
      throw error;
    },
  });
  const pending = recovery.refresh();
  await Promise.resolve();
  const file = await store.createDesign(projectId);
  const live: DesktopEvent = { type: "designs", projectId, designs: [file], folders: [] };
  recovery.receive(live);
  wait.resolve(project);
  await pending;
  expect(events).toEqual([live]);
  recovery.close();
});

test("stream schemas reject malformed events and keep live approvals out of persisted threads", async () => {
  const { projectId } = await fixture();
  const thread = conversation(projectId);
  thread.pendingApprovals = [{ id: "approval", title: "Run tests", choices: ["allow", "deny"] }];
  expect(desktopEventSchema.parse({ type: "thread", thread })).toEqual({ type: "thread", thread });
  expect(storedThreadSchema.parse(thread)).not.toHaveProperty("pendingApprovals");
  for (const value of [
    null,
    { type: "thread", thread: {} },
    { type: "designs", projectId, designs: "invalid", folders: [] },
    { type: "unknown" },
  ])
    expect(desktopEventSchema.safeParse(value).success).toBe(false);
});

test("project snapshot requests refresh an inactive project without changing selection", async () => {
  const { origin, login, directory, store, projectId } = await fixture();
  const other = join(directory, "second");
  await mkdir(other);
  const active = await store.open(other);
  const file = await store.createDesign(projectId);
  const response = await fetch(new URL("/__tidy/request", origin), {
    method: "POST",
    headers: { Cookie: await login(), Origin: origin.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "project-snapshot", input: projectId }),
  });
  expect(response.status).toBe(200);
  const result: unknown = await response.json();
  expect(result).toMatchObject({
    ok: true,
    data: { project: { id: projectId }, designs: [{ id: file.id }] },
  });
  expect(store.activeProjectId).toBe(active.project.id);
});

async function streamCursor(origin: URL, cookie: string, lastId?: string) {
  const abort = new AbortController();
  cleanups.push(async () => abort.abort());
  const response = await fetch(new URL("/__tidy/events", origin), {
    headers: { Cookie: cookie, ...(lastId ? { "Last-Event-ID": lastId } : {}) },
    signal: abort.signal,
  });
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No event stream.");
  let text = "";
  while (!/^id: /m.test(text)) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("Event stream ended without a cursor.");
    text += new TextDecoder().decode(chunk.value);
  }
  const cursor = [...text.matchAll(/^id: (.+)$/gm)].at(-1)?.[1];
  if (!cursor) throw new Error("No event cursor.");
  await reader.cancel();
  return { text, cursor };
}

test("reconnecting browsers replay missed thread events and request resync after a restart", async () => {
  const { origin, login, store, service, projectId, restart } = await fixture();
  const cookie = await login();
  const thread = conversation(projectId);
  await store.writeThread(thread);
  await service.setThreadDone(projectId, thread.id, true);
  const first = await streamCursor(origin, cookie);
  await service.setThreadDone(projectId, thread.id, false);
  const replay = await streamCursor(origin, cookie, first.cursor);
  expect(replay.cursor).not.toBe(first.cursor);
  const data = replay.text.match(/^data: (.+)$/m)?.[1];
  if (!data) throw new Error("Missed thread event was not replayed.");
  const event = desktopEventSchema.parse(JSON.parse(data));
  expect(event.type).toBe("thread");
  if (event.type === "thread") expect(event.thread.doneAt).toBeUndefined();
  restart();
  const restarted = await streamCursor(origin, cookie, replay.cursor);
  expect(restarted.text).toContain("event: resync");
  expect(restarted.cursor).not.toBe(replay.cursor);
});

test("browser and preload responses validate real file, folder, thread and attachment operations", async () => {
  const { origin, login, store, projectId } = await fixture();
  const cookie = await login();
  async function request<Name extends WorkspaceOperation>(name: Name, input?: unknown) {
    const response = await fetch(new URL("/__tidy/request", origin), {
      method: "POST",
      headers: { Cookie: cookie, Origin: origin.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ name, input }),
    });
    return parseWorkspaceResponse(name, await response.json());
  }
  const folder = await request("create-design-folder", { projectId, name: "Explorations" });
  const renamed = await request("rename-design-folder", {
    projectId,
    folderId: folder.id,
    name: "Product",
  });
  expect(renamed.name).toBe("Product");
  const created = await request("create-design", { projectId, folderId: folder.id });
  const updated = await request("update-design", {
    projectId,
    designId: created.id,
    expectedVersion: created.version,
    name: "Homepage",
    folderId: null,
  });
  const read = await request("read-design", { projectId, designId: created.id });
  expect(read).toEqual(updated);
  expect(read.folderId).toBeNull();
  const snapshot = await request("project-snapshot", projectId);
  expect(snapshot.designs[0].name).toBe("Homepage");
  expect(snapshot.folders[0].name).toBe("Product");
  const thread = conversation(projectId);
  await store.writeThread(thread);
  const done = await request("set-thread-done", { projectId, threadId: thread.id, done: true });
  expect(done.doneAt).toBeDefined();
  const reopened = await request("set-thread-done", {
    projectId,
    threadId: thread.id,
    done: false,
  });
  expect(reopened.doneAt).toBeUndefined();
  expect(await request("read-thread", { projectId, threadId: thread.id })).toEqual(reopened);
  expect(reopened.messages).toEqual(thread.messages);
  expect(await request("stop-thread", { projectId, threadId: thread.id })).toBeUndefined();
  const attached = await request("add-attachment", {
    projectId,
    name: "notes.txt",
    dataUrl: "data:text/plain;base64,aGVsbG8=",
  });
  expect(await request("read-attachment", { projectId, attachmentId: attached.id })).toEqual(
    attached,
  );
});

test("response schemas reject malformed successes and preserve useful server errors", () => {
  for (const value of [
    null,
    {},
    { ok: "true", data: {} },
    { ok: false, error: 42 },
    { ok: true, data: {} },
  ])
    expect(() => parseWorkspaceResponse("bootstrap", value)).toThrow("Invalid desktop response.");
  expect(() =>
    parseWorkspaceResponse("read-thread", { ok: false, error: "Thread not found." }),
  ).toThrow("Thread not found.");
  expect(() =>
    parseWorkspaceResponse("read-thread", {
      ok: true,
      data: { ...conversation(randomUUID()), messages: "invalid" },
    }),
  ).toThrow("Invalid desktop response.");
  expect(() =>
    parseWorkspaceResponse("upload-design-asset", {
      ok: true,
      data: { assetId: "asset", url: 42 },
    }),
  ).toThrow("Invalid desktop response.");
  expect(parseWorkspaceResponse("stop-thread", { ok: true })).toBeUndefined();
  expect(parseWorkspaceResponse("import-design", { ok: true, data: null })).toBeNull();
});
