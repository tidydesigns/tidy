import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore } from "./project-store";
import type { Thread } from "../shared/contracts";

const cleanups: string[] = [];
afterEach(async () => {
  for (const directory of cleanups.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "tidy-project-store-"));
  cleanups.push(directory);
  const root = join(directory, "project");
  await mkdir(root);
  const store = new ProjectStore(join(directory, "app-data"));
  await store.initialize();
  return { directory, root, store };
}
function thread(projectId: string): Thread {
  return {
    revision: 0,
    id: randomUUID(),
    projectId,
    title: "Implement the design",
    harness: "codex",
    sessionId: randomUUID(),
    designIds: [],
    messages: [{ id: randomUUID(), role: "user", text: "Hello" }],
    status: "running",
    updatedAt: new Date().toISOString(),
  };
}

test("project designs and threads survive restart and moving the directory", async () => {
  const { directory, root, store } = await fixture();
  const first = await store.open(root);
  expect((await store.open(root)).project.id).toBe(first.project.id);
  const design = await store.createDesign(first.project.id);
  const conversation = thread(first.project.id);
  conversation.designIds = [design.id];
  await store.writeThread(conversation);
  const reopened = new ProjectStore(join(directory, "app-data"));
  await reopened.initialize();
  await reopened.recover();
  expect(reopened.activeProjectId).toBe(first.project.id);
  const recovered = await reopened.readThread(first.project.id, conversation.id);
  expect(recovered.status).toBe("interrupted");
  expect(recovered.sessionId).toBe(conversation.sessionId);
  expect(recovered.designIds).toEqual([design.id]);
  expect((await reopened.readDesign(first.project.id, design.id)).document.schemaVersion).toBe(1);
  const moved = join(directory, "renamed-project");
  await rename(root, moved);
  const snapshot = await reopened.open(moved);
  expect(snapshot.project.id).toBe(first.project.id);
  expect(snapshot.threads[0].id).toBe(conversation.id);
  expect(snapshot.designs[0].path.startsWith(snapshot.project.path)).toBe(true);
  expect(await readFile(join(moved, ".tidy/.gitignore"), "utf8")).toContain("/threads/");
});

test("project scope and identifiers cannot read another project's data or traverse paths", async () => {
  const { directory, root, store } = await fixture();
  const first = await store.open(root);
  const secondRoot = join(directory, "second");
  await mkdir(secondRoot);
  const second = await store.open(secondRoot);
  const conversation = thread(first.project.id);
  await store.writeThread(conversation);
  await expect(store.readThread(second.project.id, conversation.id)).rejects.toThrow();
  await expect(store.readThread(first.project.id, "../../projects")).rejects.toThrow();
  await expect(store.storagePath(randomUUID(), "threads", conversation.id)).rejects.toThrow(
    "Open this project",
  );
  await writeFile(
    await store.storagePath(second.project.id, "threads", conversation.id),
    JSON.stringify(conversation),
  );
  await expect(store.readThread(second.project.id, conversation.id)).rejects.toThrow(
    "another project",
  );
});

test("symlinked project storage and design files cannot escape into other directories", async () => {
  const { directory, root, store } = await fixture();
  const outside = join(directory, "outside");
  await mkdir(outside);
  await symlink(outside, join(root, ".tidy"));
  await expect(store.open(root)).rejects.toThrow("real directory");
  await rm(join(root, ".tidy"));
  const project = await store.open(root);
  const designId = randomUUID();
  const secret = join(outside, "data.json");
  await writeFile(secret, "{}");
  await symlink(secret, join(root, ".tidy/designs", `${designId}.json`));
  await expect(store.readDesign(project.project.id, designId)).rejects.toThrow("symbolic links");
  expect((await store.snapshot(project.project.id)).designs).toEqual([]);
  expect(await readFile(secret, "utf8")).toBe("{}");
});

test("invalid imported documents do not become design records and ordered writes retain the latest message", async () => {
  const { root, store } = await fixture();
  const project = await store.open(root);
  await expect(
    store.createDesign(project.project.id, { name: "Broken", document: { schemaVersion: 99 } }),
  ).rejects.toThrow();
  expect(await store.designs(project.project.id)).toEqual([]);
  const conversation = thread(project.project.id);
  const writes = [];
  for (let index = 0; index < 8; index++) {
    conversation.messages[0].text = String(index);
    writes.push(store.writeThread(structuredClone(conversation)));
  }
  await Promise.all(writes);
  expect((await store.readThread(project.project.id, conversation.id)).messages[0].text).toBe("7");
});

test("canvas commits preserve local images across restart and reject stale on-disk edits", async () => {
  const { directory, root, store } = await fixture();
  const { project } = await store.open(root);
  const original = await store.createDesign(project.id);
  const image = await store.uploadDesignAsset(project.id, "data:image/png;base64,aGVsbG8=");
  const document = structuredClone(original.document);
  document.nodes[0].name = "Edited frame";
  document.nodes.push({
    id: randomUUID(),
    type: "image",
    parentId: document.nodes[0].id,
    pageId: document.pages[0].id,
    name: "Image",
    visible: true,
    locked: false,
    box: { x: 10, y: 10, width: 100, height: 100 },
    layout: "absolute",
    style: {},
    assetId: image.assetId,
  });
  const edited = await store.updateDesign({
    projectId: project.id,
    designId: original.id,
    expectedVersion: original.version,
    document,
  });
  const restarted = new ProjectStore(join(directory, "app-data"));
  await restarted.initialize();
  const loaded = await restarted.readDesign(project.id, original.id);
  expect(loaded.document.nodes[0].name).toBe("Edited frame");
  expect(loaded.assets[image.assetId]).toBe(image.url);
  expect(loaded.version).toBe(edited.version);
  await expect(
    store.updateDesign({
      projectId: project.id,
      designId: original.id,
      expectedVersion: original.version,
      name: "Stale edit",
    }),
  ).rejects.toThrow("changed on disk");
  const external = JSON.parse(await readFile(edited.path, "utf8"));
  external.document.nodes[0].name = "Agent's change";
  await writeFile(edited.path, JSON.stringify(external));
  await expect(
    store.updateDesign({
      projectId: project.id,
      designId: original.id,
      expectedVersion: edited.version,
      document,
    }),
  ).rejects.toThrow("changed on disk");
  expect((await store.readDesign(project.id, original.id)).document.nodes[0].name).toBe(
    "Agent's change",
  );
});
