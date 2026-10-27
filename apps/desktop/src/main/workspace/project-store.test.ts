import { afterEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore } from "./project-store";
import { CloudCompute } from "../cloud/cloud-compute";
import type { Thread } from "../../shared/contracts/desktop";

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

test("cached design reads detect external equal-length edits with restored modification times", async () => {
  const f = await fixture();
  const { project } = await f.store.open(f.root);
  const design = await f.store.createDesign(project.id);
  const original = await f.store.readDesign(project.id, design.id);
  const before = await stat(original.path);
  const text = await readFile(original.path, "utf8");
  await Bun.sleep(2);
  await writeFile(original.path, text.replace('"Frame"', '"Other"'));
  await utimes(original.path, before.atime, before.mtime);
  const next = await f.store.readDesign(project.id, design.id);
  expect(next.document.nodes[0].name).toBe("Other");
  expect(next.version).not.toBe(original.version);
  // A renderer-facing caller cannot mutate the private cached document.
  next.document.nodes[0].name = "Caller mutation";
  expect((await f.store.readDesign(project.id, design.id)).document.nodes[0].name).toBe("Other");
});

test("unchanged canvas refreshes return no document and changed files still load", async () => {
  const f = await fixture();
  const { project } = await f.store.open(f.root);
  const original = await f.store.createDesign(project.id);
  expect(await f.store.readDesignIfChanged(project.id, original.id, original.version)).toBeNull();
  const text = await readFile(original.path, "utf8");
  await writeFile(original.path, text.replace('"Frame"', '"Other"'));
  const changed = await f.store.readDesignIfChanged(project.id, original.id, original.version);
  expect(changed?.document.nodes[0].name).toBe("Other");
  expect(changed?.version).not.toBe(original.version);
});

test("concurrent card and canvas reads decode one shared disk state", async () => {
  const f = await fixture();
  const { project } = await f.store.open(f.root);
  const original = await f.store.createDesign(project.id);
  const text = await readFile(original.path, "utf8");
  await writeFile(original.path, text.replace('"Frame"', '"Other"'));
  let decodes = 0;
  const read = CloudCompute.prototype.readFile;
  CloudCompute.prototype.readFile = function (path, background) {
    if (path === original.path) decodes++;
    return read.call(this, path, background);
  };
  try {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        f.store.readDesign(project.id, original.id, true, index !== 0),
      ),
    );
    expect(decodes).toBe(1);
    expect(results.every((result) => result.document.nodes[0].name === "Other")).toBe(true);
    results[0].document.nodes[0].name = "Caller edit";
    expect(results[1].document.nodes[0].name).toBe("Other");
  } finally {
    CloudCompute.prototype.readFile = read;
  }
});

test("project files cannot grant permissions or replace a native session, including after restart", async () => {
  const { directory, root, store } = await fixture();
  const { project } = await store.open(root);
  const original = thread(project.id);
  original.settings = { model: "fixture-codex", permissionMode: "read-only" };
  await store.writeThread(original);
  const path = await store.storagePath(project.id, "threads", original.id);
  const portable = JSON.parse(await readFile(path, "utf8"));
  expect(portable.sessionId).toBeUndefined();
  expect(portable.settings.permissionMode).toBeUndefined();
  await writeFile(
    path,
    JSON.stringify({
      ...portable,
      sessionId: randomUUID(),
      settings: { ...portable.settings, permissionMode: "auto" },
    }),
  );
  const reopened = new ProjectStore(join(directory, "app-data"));
  await reopened.initialize();
  const trusted = await reopened.readThread(project.id, original.id);
  expect(trusted.settings?.permissionMode).toBe("read-only");
  expect(trusted.sessionId).toBe(original.sessionId);
  expect(trusted.settings?.model).toBe("fixture-codex");

  const imported = { ...original, id: randomUUID(), settings: { permissionMode: "auto" } };
  await writeFile(
    await store.storagePath(project.id, "threads", imported.id),
    JSON.stringify(imported),
  );
  const untrusted = await reopened.readThread(project.id, imported.id);
  expect(untrusted.settings?.permissionMode).toBeUndefined();
  expect(untrusted.sessionId).toBeUndefined();

  await writeFile(path, JSON.stringify({ ...original, harness: "claude" }));
  await expect(reopened.readThread(project.id, original.id)).rejects.toThrow("harness changed");

  const moved = join(directory, "moved");
  await rename(root, moved);
  await reopened.open(moved);
  expect(
    (await reopened.readThread(project.id, imported.id)).settings?.permissionMode,
  ).toBeUndefined();
});

test("existing ignore rules cannot leave private threads and attachments exposed", async () => {
  const { root, store } = await fixture();
  await mkdir(join(root, ".tidy"));
  const path = join(root, ".tidy/.gitignore");
  await writeFile(path, "/threads/\n!/threads/\n!/attachments/\n!/project.json\n");
  await store.open(root);
  const protectedRules = await readFile(path, "utf8");
  expect(protectedRules.endsWith("/threads/\n/attachments/\n/project.json\n")).toBe(true);
  await store.open(root);
  expect(await readFile(path, "utf8")).toBe(protectedRules);
});

test("a copied project identity cannot redirect the original project's data", async () => {
  const { directory, root, store } = await fixture();
  const original = (await store.open(root)).project;
  const conversation = thread(original.id);
  await store.writeThread(conversation);
  const copiedRoot = join(directory, "copy");
  await mkdir(join(copiedRoot, ".tidy"), { recursive: true });
  await writeFile(
    join(copiedRoot, ".tidy/project.json"),
    JSON.stringify({ version: 1, id: original.id }),
  );
  const copy = (await store.open(copiedRoot)).project;
  expect(copy.id).not.toBe(original.id);
  expect(store.project(original.id).path).toBe(original.path);
  expect((await store.readThread(original.id, conversation.id)).sessionId).toBe(
    conversation.sessionId,
  );
  expect((await store.open(copiedRoot)).project.id).toBe(copy.id);
  await expect(store.readThread(copy.id, conversation.id)).rejects.toThrow();
});

test("startup recovery repairs interrupted threads without reading design or folder metadata", async () => {
  const f = await fixture();
  const { project } = await f.store.open(f.root);
  const conversation = thread(project.id);
  await f.store.writeThread(conversation);
  const reopened = new ProjectStore(join(f.directory, "app-data"));
  await reopened.initialize();
  const designs = spyOn(reopened, "designs");
  const folders = spyOn(reopened, "folders");
  try {
    await reopened.recover();
    expect((await reopened.readThread(project.id, conversation.id)).status).toBe("interrupted");
    expect(designs).not.toHaveBeenCalled();
    expect(folders).not.toHaveBeenCalled();
  } finally {
    designs.mockRestore();
    folders.mockRestore();
  }
});

test("project designs and threads survive restart and moving the directory", async () => {
  const { directory, root, store } = await fixture();
  const first = await store.open(root);
  expect((await store.open(root)).project.id).toBe(first.project.id);
  const design = await store.createDesign(first.project.id);
  const conversation = thread(first.project.id);
  conversation.designIds = [design.id];
  conversation.pendingApprovals = [
    { id: "expired", title: "Run command", choices: ["allow", "deny"] },
  ];
  conversation.toolActivities = ["running", "completed", "failed"].map((status) => ({
    id: randomUUID(),
    afterMessageId: conversation.messages[0].id,
    kind: "test",
    title: "bun test",
    toolName: "Shell",
    status: status as "running" | "completed" | "failed",
    startedAt: new Date().toISOString(),
    output: "Recorded output",
  }));
  await store.writeThread(conversation);
  const reopened = new ProjectStore(join(directory, "app-data"));
  await reopened.initialize();
  await reopened.recover();
  expect(reopened.activeProjectId).toBe(first.project.id);
  const recovered = await reopened.readThread(first.project.id, conversation.id);
  expect(recovered.status).toBe("interrupted");
  expect(recovered).not.toHaveProperty("pendingApprovals");
  expect(recovered.revision).toBe(conversation.revision + 1);
  expect(recovered.sessionId).toBe(conversation.sessionId);
  expect(recovered.designIds).toEqual([design.id]);
  expect(recovered.toolActivities?.map((tool) => tool.status)).toEqual([
    "interrupted",
    "completed",
    "failed",
  ]);
  expect(recovered.toolActivities?.[0].output).toBe("Recorded output");
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

test("execution bindings survive restart but cannot be inserted, removed or redirected in portable JSON", async () => {
  const f = await fixture();
  const owner = (await f.store.open(f.root, "Team")).project;
  const executionRoot = join(f.directory, "repository");
  await mkdir(executionRoot);
  const execution = (await f.store.open(executionRoot)).project;
  const value = { ...thread(owner.id), executionProjectId: execution.id };
  await f.store.writeThread(value);
  const restarted = new ProjectStore(join(f.directory, "app-data"));
  await restarted.initialize();
  expect((await restarted.readThread(owner.id, value.id)).executionProjectId).toBe(execution.id);
  const path = await f.store.storagePath(owner.id, "threads", value.id);
  await writeFile(path, JSON.stringify({ ...value, executionProjectId: owner.id }));
  await expect(restarted.readThread(owner.id, value.id)).rejects.toThrow(
    "execution project changed",
  );
  await writeFile(path, JSON.stringify({ ...value, executionProjectId: undefined }));
  await expect(restarted.readThread(owner.id, value.id)).rejects.toThrow(
    "execution project changed",
  );
  const imported = { ...value, id: randomUUID() };
  await writeFile(
    await f.store.storagePath(owner.id, "threads", imported.id),
    JSON.stringify(imported),
  );
  await expect(restarted.readThread(owner.id, imported.id)).rejects.toThrow(
    "execution project changed",
  );
});

test("a checkpoint cannot silently rebind a running workspace thread when its repository moves", async () => {
  const f = await fixture();
  const owner = (await f.store.open(f.root, "Team")).project;
  const executionRoot = join(f.directory, "repository");
  await mkdir(executionRoot);
  const execution = (await f.store.open(executionRoot)).project;
  const value = { ...thread(owner.id), executionProjectId: execution.id };
  await f.store.writeThread(value);
  const moved = join(f.directory, "moved-repository");
  await rename(executionRoot, moved);
  expect((await f.store.open(moved)).project.id).toBe(execution.id);
  await expect(f.store.writeThread({ ...value, revision: value.revision + 1 })).rejects.toThrow(
    "execution project changed",
  );
  await expect(f.store.readThread(owner.id, value.id)).rejects.toThrow("execution project changed");
});
