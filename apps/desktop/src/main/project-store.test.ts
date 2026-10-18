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

test("local design folders persist with stable design paths and thread references", async () => {
  const { directory, root, store } = await fixture();
  const project = (await store.open(root)).project;
  const folder = await store.createFolder(project.id, "Explorations");
  const file = await store.createDesign(project.id, undefined, folder.id);
  const conversation = thread(project.id);
  conversation.designIds = [file.id];
  await store.writeThread(conversation);
  const moved = await store.updateDesign({
    projectId: project.id,
    designId: file.id,
    expectedVersion: file.version,
    folderId: null,
  });
  expect(moved.path).toBe(file.path);
  expect(moved.folderId).toBeNull();
  const renamed = await store.updateDesign({
    projectId: project.id,
    designId: file.id,
    expectedVersion: moved.version,
    name: "Homepage",
    folderId: folder.id,
  });
  expect(renamed.folderId).toBe(folder.id);
  await store.renameFolder(project.id, folder.id, "Website");
  const reopened = new ProjectStore(join(directory, "app-data"));
  await reopened.initialize();
  const snapshot = await reopened.select(project.id);
  expect(snapshot.folders[0].name).toBe("Website");
  expect(snapshot.designs[0].folderId).toBe(folder.id);
  expect(snapshot.designs[0].nodeCount).toBe(1);
  expect(snapshot.threads[0].designIds).toEqual([file.id]);
  expect((await reopened.readDesign(project.id, file.id)).path).toBe(file.path);
});

test("legacy design files remain readable and folder membership survives canvas edits", async () => {
  const { root, store } = await fixture();
  const project = (await store.open(root)).project;
  const original = await store.createDesign(project.id);
  const legacyPath = await store.storagePath(project.id, "designs", original.id);
  await writeFile(
    legacyPath,
    JSON.stringify({ id: original.id, name: original.name, document: original.document }),
  );
  const legacy = await store.readDesign(project.id, original.id);
  expect(legacy.folderId).toBeNull();
  const folder = await store.createFolder(project.id, "Screens");
  const moved = await store.updateDesign({
    projectId: project.id,
    designId: legacy.id,
    expectedVersion: legacy.version,
    folderId: folder.id,
  });
  await expect(
    store.updateDesign({
      projectId: project.id,
      designId: legacy.id,
      expectedVersion: legacy.version,
      document: legacy.document,
    }),
  ).rejects.toThrow("changed on disk");
  const edited = await store.updateDesign({
    projectId: project.id,
    designId: legacy.id,
    expectedVersion: moved.version,
    document: moved.document,
    name: "Updated canvas",
  });
  expect(edited.folderId).toBe(folder.id);
  expect((await store.readDesign(project.id, legacy.id)).folderId).toBe(folder.id);
});

test("folders obey project boundaries and reject symbolic links and invalid destinations", async () => {
  const { directory, root, store } = await fixture();
  const project = (await store.open(root)).project;
  const other = join(directory, "other-project");
  await mkdir(other);
  const otherProject = (await store.open(other)).project;
  const folder = await store.createFolder(otherProject.id, "Other");
  await expect(store.createDesign(project.id, undefined, folder.id)).rejects.toThrow();
  const design = await store.createDesign(project.id);
  await expect(
    store.updateDesign({
      projectId: project.id,
      designId: design.id,
      expectedVersion: design.version,
      folderId: folder.id,
    }),
  ).rejects.toThrow();
  await expect(store.renameFolder(project.id, folder.id, "Invalid")).rejects.toThrow();
  const outside = join(directory, "outside.json");
  await writeFile(outside, JSON.stringify({ id: folder.id, name: "Private" }));
  await symlink(outside, join(root, ".tidy/folders", `${folder.id}.json`));
  await expect(store.readFolder(project.id, folder.id)).rejects.toThrow("symbolic links");
  expect(await store.folders(project.id)).toEqual([]);
  await expect(store.createFolder(project.id, " ")).rejects.toThrow();
});

test("attachments persist privately, retain literal bytes and cannot escape their project", async () => {
  const { directory, root, store } = await fixture();
  const project = (await store.open(root)).project;
  const bytes = Buffer.from("Read this source literally: $(touch injected)\n");
  const file = await store.addAttachment(
    project.id,
    "../plan.txt",
    `data:text/plain;base64,${bytes.toString("base64")}`,
  );
  expect(file.name).not.toContain("/");
  expect(file.previewUrl).toBeUndefined();
  const resolved = await store.resolveAttachment(project.id, file.id);
  expect(await readFile(resolved.path)).toEqual(bytes);
  expect(resolved.path.startsWith(join(project.path, ".tidy/attachments/"))).toBe(true);
  expect(await readFile(join(root, ".tidy/.gitignore"), "utf8")).toContain("/attachments/");
  const json = await store.addAttachment(
    project.id,
    "settings.json",
    `data:application/json;base64,${Buffer.from('{"theme":"dark"}').toString("base64")}`,
  );
  expect(await readFile((await store.resolveAttachment(project.id, json.id)).path, "utf8")).toBe(
    '{"theme":"dark"}',
  );
  const reopened = new ProjectStore(join(directory, "app-data"));
  await reopened.initialize();
  expect((await reopened.readAttachment(project.id, file.id)).name).toBe(file.name);
  const otherRoot = join(directory, "other");
  await mkdir(otherRoot);
  const other = (await store.open(otherRoot)).project;
  await expect(store.resolveAttachment(other.id, file.id)).rejects.toThrow();
  await rm(resolved.path);
  await symlink(join(root, ".tidy/project.json"), resolved.path);
  await expect(store.resolveAttachment(project.id, file.id)).rejects.toThrow("regular files");
});

test("image attachments use verified raster MIME types and reject invalid or oversized data", async () => {
  const { root, store } = await fixture();
  const project = (await store.open(root)).project;
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jSkcAAAAASUVORK5CYII=";
  const image = await store.addAttachment(
    project.id,
    "screenshot.png",
    `data:application/octet-stream;base64,${png}`,
  );
  expect(image.mimeType).toBe("image/png");
  expect((await store.readAttachment(project.id, image.id)).previewUrl).toBe(
    `data:image/png;base64,${png}`,
  );
  const svg = Buffer.from('<svg onload="alert(1)"></svg>').toString("base64");
  const source = await store.addAttachment(
    project.id,
    "icon.svg",
    `data:image/svg+xml;base64,${svg}`,
  );
  expect(source.previewUrl).toBeUndefined();
  expect(source.mimeType).toBe("application/octet-stream");
  await expect(
    store.addAttachment(project.id, "bad.txt", "https://example.com/secret"),
  ).rejects.toThrow();
  await expect(
    store.addAttachment(project.id, "bad.txt", "data:text/plain;base64,%%%"),
  ).rejects.toThrow();
  const oversized = Buffer.alloc(5 * 1024 * 1024 + 1);
  Buffer.from(png, "base64").copy(oversized);
  await expect(
    store.addAttachment(
      project.id,
      "big.png",
      `data:image/png;base64,${oversized.toString("base64")}`,
    ),
  ).rejects.toThrow("5 MB");
});
