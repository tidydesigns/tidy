import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { blankDesignDocument, buildDrawnNode, type DesignDocument } from "@tidy/design/document";
import { applyDocumentPatch } from "@tidy/editor/design/document-patch";
import { ProjectStore } from "./project-store";
import { PrivateState } from "./private-state";
import { CloudSync } from "./cloud-sync";
import { CloudHTTPError } from "./cloud-auth";
import type { CloudRemote, CloudSnapshot, PendingUpload } from "./cloud-remote";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error("Cloud sync did not reach the expected state.");
}
class Remote implements CloudRemote {
  snapshot: CloudSnapshot = {
    revision: 1,
    content: {
      ...blankDesignDocument(),
      nodes: [buildDrawnNode("frame", "artboard", null, { x: 0, y: 0, width: 800, height: 600 })],
    },
  };
  receipts = new Map<string, CloudSnapshot>();
  requests: PendingUpload[] = [];
  assets = new Map<string, string>();
  uploads = 0;
  reads = 0;
  creations: string[] = [];
  failAfterCommit = false;
  beforeCommit?: () => Promise<void>;
  async create(_organizationId: string, fileId: string) {
    this.creations.push(fileId);
    if (this.creations.length === 1)
      this.snapshot = { revision: 1, content: blankDesignDocument() };
  }
  async read() {
    this.reads++;
    return structuredClone(this.snapshot);
  }
  async commit(_fileId: string, pending: PendingUpload) {
    this.requests.push(structuredClone(pending));
    await this.beforeCommit?.();
    let receipt = this.receipts.get(pending.operationId);
    if (!receipt) {
      if (pending.base.revision !== this.snapshot.revision) throw new CloudHTTPError(409);
      receipt = {
        revision: this.snapshot.revision + 1,
        content: applyDocumentPatch(this.snapshot.content, pending.patch, false),
      };
      this.snapshot = structuredClone(receipt);
      this.receipts.set(pending.operationId, receipt);
    }
    if (this.failAfterCommit) {
      this.failAfterCommit = false;
      throw new Error("Lost upload response");
    }
    return structuredClone(receipt);
  }
  async downloadAsset(_fileId: string, assetId: string) {
    return this.assets.get(assetId)!;
  }
  async uploadAsset(_fileId: string, dataUrl: string) {
    this.uploads++;
    const id = [...this.assets].find(([, data]) => data === dataUrl)?.[0] ?? randomUUID();
    this.assets.set(id, dataUrl);
    return id;
  }
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "tidy-cloud-sync-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "project");
  await mkdir(path);
  const store = new ProjectStore(join(directory, "workspace"));
  await store.initialize();
  const { project } = await store.open(path);
  const state = new PrivateState(join(directory, "private"));
  await state.initialize();
  const remote = new Remote(),
    fileId = randomUUID();
  const make = async (account = "alice") => {
    const sync = new CloudSync(store, state, remote, "https://example.test");
    await sync.initialize();
    await sync.start(account);
    cleanups.push(() => sync.stop());
    return sync;
  };
  const sync = await make();
  const design = await sync.open(project.id, fileId, "Cloud design");
  const edit = async (name: string) => {
    const current = await store.readDesign(project.id, design.id, false);
    const document = structuredClone(current.document);
    document.nodes[0].name = name;
    await store.updateDesign({
      projectId: project.id,
      designId: design.id,
      expectedVersion: current.version,
      document,
    });
    return document;
  };
  return { directory, store, state, remote, fileId, sync, make, design, project, edit };
}

test("local editing persists independently, then batches patches to the cloud", async () => {
  const f = await fixture();
  await f.edit("One");
  f.sync.notify(f.project.id);
  await f.edit("Two");
  f.sync.notify(f.project.id);
  expect((await f.store.readDesign(f.project.id, f.design.id)).document.nodes[0].name).toBe("Two");
  expect(f.remote.requests).toHaveLength(0);
  await until(
    () =>
      f.remote.snapshot.content.nodes[0].name === "Two" && f.sync.status[0]?.status === "synced",
  );
  expect(f.remote.requests).toHaveLength(1);
  expect(f.remote.requests[0].patch.length).toBeLessThan(5);
});

test("a lost acknowledgement survives restart and retries the identical operation once", async () => {
  const f = await fixture();
  f.remote.failAfterCommit = true;
  await f.edit("Before restart");
  f.sync.notify(f.project.id);
  await until(() => f.sync.status[0]?.status === "offline");
  const revision = f.remote.snapshot.revision;
  await f.sync.stop();
  const resumed = await f.make();
  await until(() => resumed.status[0]?.status === "synced");
  expect(f.remote.snapshot.revision).toBe(revision);
  expect(f.remote.requests).toHaveLength(2);
  expect(f.remote.requests[1]).toEqual(f.remote.requests[0]);
});

test("an acknowledgement cannot clear local edits made during the upload", async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.remote.beforeCommit = () => gate;
  await f.edit("Submitted");
  f.sync.notify(f.project.id);
  await until(() => f.remote.requests.length === 1);
  await f.edit("Newer local edit");
  f.sync.notify(f.project.id);
  f.remote.beforeCommit = undefined;
  release();
  await until(
    () =>
      f.remote.snapshot.content.nodes[0].name === "Newer local edit" &&
      f.sync.status[0]?.status === "synced",
  );
  expect(f.remote.requests).toHaveLength(2);
});

test("divergent offline edits preserve both copies and pause instead of overwriting", async () => {
  const f = await fixture();
  await f.edit("Local version");
  f.remote.snapshot.content.nodes[0].name = "Cloud version";
  f.remote.snapshot.revision++;
  f.sync.notify(f.project.id);
  await until(() => f.sync.status[0]?.status === "conflict");
  expect(f.remote.requests).toHaveLength(0);
  expect((await f.store.readDesign(f.project.id, f.design.id)).document.nodes[0].name).toBe(
    "Local version",
  );
  expect(f.remote.snapshot.content.nodes[0].name).toBe("Cloud version");
  await f.sync.stop();
  const resumed = await f.make();
  expect(resumed.status[0]?.status).toBe("conflict");
});

test("incoming changes use the checked local write and do not echo back as uploads", async () => {
  const f = await fixture();
  f.remote.snapshot.content.nodes[0].name = "From web";
  f.remote.snapshot.revision++;
  f.sync.notify(f.project.id);
  await until(
    async () =>
      (await f.store.readDesign(f.project.id, f.design.id)).document.nodes[0].name === "From web",
  );
  f.sync.notify(f.project.id);
  await until(() => f.sync.status[0]?.status === "synced");
  expect(f.remote.requests).toHaveLength(0);
});

test("agent edits made while the app is closed reconcile from disk on startup", async () => {
  const f = await fixture();
  await f.sync.stop();
  const document = structuredClone(f.design.document);
  document.nodes[0].name = "Agent edit";
  await writeFile(
    f.design.path,
    JSON.stringify({ id: f.design.id, name: f.design.name, folderId: null, document }),
  );
  const resumed = await f.make();
  await until(
    () =>
      resumed.status[0]?.status === "synced" &&
      f.remote.snapshot.content.nodes[0].name === "Agent edit",
  );
});

test("a different account cannot resume another account's project uploads", async () => {
  const f = await fixture();
  await f.sync.stop();
  await f.edit("Private to Alice");
  const reads = f.remote.reads;
  const bob = await f.make("bob");
  bob.notify(f.project.id);
  await Bun.sleep(300);
  expect(bob.status).toEqual([]);
  expect(f.remote.requests).toHaveLength(0);
  expect(f.remote.reads).toBe(reads);
});

test("disconnect waits for an in-flight transfer and prevents later uploads", async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.remote.beforeCommit = () => gate;
  await f.edit("Submitted before disconnect");
  f.sync.notify(f.project.id);
  await until(() => f.remote.requests.length === 1);
  const disconnecting = f.sync.disconnect(f.project.id, f.design.id);
  f.remote.beforeCommit = undefined;
  release();
  await disconnecting;
  await f.edit("Local after disconnect");
  f.sync.notify(f.project.id);
  await Bun.sleep(300);
  expect(f.sync.status).toEqual([]);
  expect(f.remote.requests).toHaveLength(1);
  expect((await f.store.readDesign(f.project.id, f.design.id)).document.nodes[0].name).toBe(
    "Local after disconnect",
  );
});

test("new images upload before the document and retain stable local asset references", async () => {
  const f = await fixture();
  const image = await f.store.uploadDesignAsset(f.project.id, "data:image/png;base64,aGVsbG8=");
  const current = await f.store.readDesign(f.project.id, f.design.id);
  const document: DesignDocument = {
    ...current.document,
    nodes: current.document.nodes.map((node) => ({ ...node, assetId: image.assetId })),
  };
  await f.store.updateDesign({
    projectId: f.project.id,
    designId: f.design.id,
    expectedVersion: current.version,
    document,
  });
  f.sync.notify(f.project.id);
  await until(() => f.remote.requests.length > 0 && f.sync.status[0]?.status === "synced");
  const cloudId = f.remote.snapshot.content.nodes[0].assetId!;
  expect(f.remote.assets.has(cloudId)).toBe(true);
  expect(cloudId).not.toBe(image.assetId);
  expect((await f.store.readDesign(f.project.id, f.design.id)).document.nodes[0].assetId).toBe(
    image.assetId,
  );
  await f.edit("Still the same image");
  f.sync.notify(f.project.id);
  await until(() => f.remote.snapshot.content.nodes[0].name === "Still the same image");
  expect(f.remote.uploads).toBe(1);
});

test("connecting a local design persists its cloud file identity before background creation", async () => {
  const f = await fixture();
  await f.sync.disconnect(f.project.id, f.design.id);
  await f.sync.connectLocal(f.project.id, f.design.id, "workspace");
  const index = (await f.state.read("bindings")) as string[];
  const persisted = (await f.state.read(index[0])) as { fileId: string; creating: unknown };
  expect(persisted.creating).toBeDefined();
  await until(() => f.sync.status[0]?.status === "synced");
  expect(f.remote.creations).toEqual([persisted.fileId]);
  expect(f.remote.snapshot.content).toEqual(f.design.document);
});
