import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RecoveryCache } from "./recovery-cache";
import type { Thread } from "../../shared/contracts/desktop";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function thread(): Thread {
  return {
    id: randomUUID(),
    projectId: randomUUID(),
    revision: 1,
    title: "cached",
    harness: "codex",
    designIds: [],
    status: "running",
    messages: [{ id: randomUUID(), role: "assistant", text: "retained" }],
    updatedAt: new Date().toISOString(),
    sessionId: randomUUID(),
    pendingApprovals: [],
  };
}
test("private remote snapshots survive reopening without replayable approval or session authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "recovery-cache-"));
  roots.push(root);
  const path = join(root, "machine.json"),
    hostId = randomUUID(),
    value = thread();
  const input = { projectId: value.projectId, threadId: value.id };
  const cache = new RecoveryCache(path, hostId);
  await cache.ready;
  cache.capture("read-thread", input, value);
  await cache.close();
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  const text = await readFile(path, "utf8");
  expect(text).not.toContain(value.sessionId!);
  expect(text).not.toContain("pendingApprovals");
  const restored = new RecoveryCache(path, hostId);
  await restored.ready;
  expect(restored.read("read-thread", input)?.data).toMatchObject({ messages: value.messages });
  expect(
    restored.read("read-thread", { threadId: value.id, projectId: value.projectId })?.data,
  ).toMatchObject({ revision: value.revision });
  const other = new RecoveryCache(path, randomUUID());
  await other.ready;
  expect(other.read("read-thread", input)).toBeUndefined();
  await restored.close();
  await other.close();
});
test("corrupt caches are discarded and a closed cache cannot be repopulated by late events", async () => {
  const root = await mkdtemp(join(tmpdir(), "bad-cache-"));
  roots.push(root);
  const path = join(root, "machine.json");
  await writeFile(path, "{");
  const cache = new RecoveryCache(path, randomUUID());
  await cache.ready;
  const value = thread(),
    input = { projectId: value.projectId, threadId: value.id };
  expect(cache.read("read-thread", input)).toBeUndefined();
  await cache.close();
  cache.capture("read-thread", input, value);
  expect(cache.read("read-thread", input)).toBeUndefined();
});

test("cache entries with mismatched operation payloads are discarded", async () => {
  const root = await mkdtemp(join(tmpdir(), "invalid-cache-entry-"));
  roots.push(root);
  const path = join(root, "machine.json"),
    hostId = randomUUID();
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      hostId,
      entries: [{ name: "bootstrap", data: thread() }],
    }),
    { mode: 0o600 },
  );
  const cache = new RecoveryCache(path, hostId);
  await cache.ready;
  expect(cache.read("bootstrap", undefined)).toBeUndefined();
  await cache.close();
});

test("late read responses cannot overwrite newer cached thread or design events", async () => {
  const root = await mkdtemp(join(tmpdir(), "ordered-cache-"));
  roots.push(root);
  const cache = new RecoveryCache(join(root, "machine.json"), randomUUID());
  await cache.ready;
  const value = thread(),
    input = { projectId: value.projectId, threadId: value.id };
  cache.capture("read-thread", input, { ...value, revision: 3 });
  cache.capture("read-thread", input, { ...value, revision: 2 });
  expect(cache.read("read-thread", input)?.data).toMatchObject({ revision: 3 });
  const project = {
    id: value.projectId,
    name: "project",
    path: "/fixture",
    openedAt: new Date().toISOString(),
  };
  const before = cache.revision;
  const design = {
    id: randomUUID(),
    name: "new",
    path: "design.json",
    updatedAt: new Date().toISOString(),
  };
  cache.receive({ type: "designs", projectId: project.id, designs: [design], folders: [] });
  cache.capture(
    "project-snapshot",
    project.id,
    { project, threads: [], designs: [], folders: [] },
    before,
  );
  expect(cache.read("project-snapshot", project.id)?.data).toMatchObject({ designs: [design] });
  await cache.close();
});

test("an oversized history is omitted without evicting smaller usable cached histories", async () => {
  const root = await mkdtemp(join(tmpdir(), "bounded-cache-"));
  roots.push(root);
  const path = join(root, "machine.json"),
    cache = new RecoveryCache(path, randomUUID());
  await cache.ready;
  const small = thread(),
    large = thread();
  large.messages = Array.from({ length: 10 }, () => ({
    id: randomUUID(),
    role: "assistant" as const,
    text: "x".repeat(1_000_000),
  }));
  cache.capture("read-thread", { projectId: small.projectId, threadId: small.id }, small);
  cache.capture("read-thread", { projectId: large.projectId, threadId: large.id }, large);
  await cache.close();
  expect((await stat(path)).size).toBeLessThanOrEqual(8 * 1024 * 1024);
  expect(
    cache.read("read-thread", { projectId: small.projectId, threadId: small.id }),
  ).toBeDefined();
  expect(
    cache.read("read-thread", { projectId: large.projectId, threadId: large.id }),
  ).toBeUndefined();
});

test("the offline bootstrap remains available when project snapshots exceed the entry limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "catalog-cache-"));
  roots.push(root);
  const cache = new RecoveryCache(join(root, "machine.json"), randomUUID());
  await cache.ready;
  cache.capture("bootstrap", undefined, { projects: [], activeProject: null, harnesses: [] });
  for (let index = 0; index < 80; index++) {
    const project = {
      id: randomUUID(),
      name: String(index),
      path: "/fixture",
      openedAt: new Date().toISOString(),
    };
    cache.capture("project-snapshot", project.id, {
      project,
      threads: [],
      designs: [],
      folders: [],
    });
  }
  await cache.close();
  expect(cache.read("bootstrap", undefined)).toBeDefined();
});

test("removal clears only that project's offline data and ignores older responses", async () => {
  const root = await mkdtemp(join(tmpdir(), "remove-cache-"));
  roots.push(root);
  const path = join(root, "machine.json");
  const hostId = randomUUID();
  const cache = new RecoveryCache(path, hostId);
  await cache.ready;
  const value = thread();
  const project = {
    id: value.projectId,
    name: "Project",
    path: "/project",
    openedAt: new Date().toISOString(),
  };
  const other = { ...project, id: randomUUID(), path: "/other" };
  const snapshot = { project, threads: [], designs: [], folders: [] };
  const bootstrap = { projects: [project, other], activeProject: snapshot, harnesses: [] };
  cache.capture("bootstrap", undefined, bootstrap);
  const input = { projectId: value.projectId, threadId: value.id };
  cache.capture("read-thread", input, value);
  const earlier = cache.revision;
  cache.capture("remove-project", project.id, undefined);
  cache.capture("bootstrap", undefined, bootstrap, earlier);
  cache.capture("project-snapshot", project.id, snapshot, earlier);
  expect(cache.read("read-thread", input)).toBeUndefined();
  expect(cache.read("project-snapshot", project.id)).toBeUndefined();
  expect(cache.read("bootstrap", undefined)?.data).toMatchObject({
    projects: [other],
    activeProject: null,
  });
  await cache.close();
  const restored = new RecoveryCache(path, hostId);
  await restored.ready;
  expect(restored.read("bootstrap", undefined)?.data).toMatchObject({
    projects: [other],
    activeProject: null,
  });
  expect(restored.read("project-snapshot", project.id)).toBeUndefined();
  await restored.close();
});
