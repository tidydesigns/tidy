import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const gateway = browserDevelopment(service, project, origin, token);
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
    return cookie.split(";")[0];
  }
  return {
    origin,
    token,
    gateway,
    store,
    directory,
    project,
    projectId: snapshot.project.id,
    login,
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
  const list = (await (await fetch(listURL, { headers: { Cookie: cookie } })).json()) as {
    data: { directories: { name: string }[] };
  };
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
