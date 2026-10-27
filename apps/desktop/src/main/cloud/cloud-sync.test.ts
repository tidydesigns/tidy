import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { blankDesignDocument, buildDrawnNode, type DesignDocument } from "@tidy/design/document";
import { applyDocumentPatch } from "@tidy/editor/design/document-patch";
import { ProjectStore } from "../workspace/project-store";
import { PrivateState } from "../platform/private-state";
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
  manifest?: CloudRemote["manifest"];
  rename?: CloudRemote["rename"];
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
      // File metadata is stored independently from document receipts on the server.
      this.snapshot = { ...structuredClone(receipt), name: this.snapshot.name };
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

test("opening a durable cloud document does not wait for a file-list refresh", async () => {
  const f = await fixture();
  await f.sync.stop();
  const entered = Promise.withResolvers<void>();
  const refresh = Promise.withResolvers<void>();
  const sync = new CloudSync(
    f.store,
    f.state,
    f.remote,
    "https://example.test",
    () => {},
    async () => {
      entered.resolve();
      await refresh.promise;
      throw new Error("File list unavailable");
    },
  );
  await sync.initialize();
  await sync.start("alice");
  cleanups.push(() => sync.stop());
  const opening = sync.open(f.project.id, randomUUID(), "Cloud design");
  try {
    await entered.promise;
    const design = await Promise.race([
      opening,
      Bun.sleep(500).then(() => {
        throw new Error("Opening waited for the file list.");
      }),
    ]);
    expect((await f.store.readDesign(f.project.id, design.id)).document).toEqual(design.document);
  } finally {
    refresh.resolve();
    await opening;
  }
});

test("documents remain editable while images download", async () => {
  const f = await fixture();
  const ids = Array.from({ length: 2 }, () => randomUUID());
  f.remote.snapshot.content.nodes.push(
    ...ids.map((assetId, index) => ({
      ...buildDrawnNode(`image-${index}`, "container", "frame", {
        x: 0,
        y: 0,
        width: 20,
        height: 20,
      }),
      type: "image" as const,
      assetId,
    })),
  );
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const image = "data:image/png;base64,c3ludGhldGlj";
  f.remote.downloadAsset = async () => {
    started.resolve();
    await gate.promise;
    return image;
  };
  const opening = f.sync.open(f.project.id, randomUUID(), "Images");
  const design = await Promise.race([
    opening,
    Bun.sleep(1000).then(() => {
      throw new Error("Document waited for images.");
    }),
  ]);
  try {
    await started.promise;
    expect(f.sync.status.find((binding) => binding.designId === design.id)?.assetsPending).toBe(
      true,
    );
    const document = structuredClone(design.document);
    document.nodes[0].name = "Edited while downloading";
    await f.store.updateDesign({
      projectId: f.project.id,
      designId: design.id,
      expectedVersion: design.version,
      document,
    });
    f.sync.notify(f.project.id, design.id);
  } finally {
    gate.resolve();
  }
  await until(
    () => f.sync.status.find((binding) => binding.designId === design.id)?.status === "synced",
  );
  expect(
    f.sync.status.find((binding) => binding.designId === design.id)?.retryAssets,
  ).toBeUndefined();
  expect(f.remote.snapshot.content.nodes[0].name).toBe("Edited while downloading");
  for (const assetId of ids) expect(await f.store.readSyncAsset(f.project.id, assetId)).toBe(image);
});

test("recovering image downloads only asks the renderer to retry failed images", async () => {
  const f = await fixture();
  const assetId = randomUUID();
  f.remote.snapshot.content.nodes.push({
    ...buildDrawnNode("image", "container", "frame", { x: 0, y: 0, width: 20, height: 20 }),
    type: "image",
    assetId,
  });
  f.remote.downloadAsset = async () => {
    throw new Error("Offline");
  };
  const design = await f.sync.open(f.project.id, randomUUID(), "Recovering");
  await until(
    () => f.sync.status.find((binding) => binding.designId === design.id)?.status === "offline",
  );
  f.remote.downloadAsset = async () => "data:image/png;base64,c3ludGhldGlj";
  f.sync.focus(f.project.id, design.id);
  await until(
    () => f.sync.status.find((binding) => binding.designId === design.id)?.status === "synced",
  );
  expect(f.sync.status.find((binding) => binding.designId === design.id)?.retryAssets).toEqual([
    assetId,
  ]);
});

test("incomplete offline images survive restart and only missing images are downloaded", async () => {
  const f = await fixture();
  const ids = [randomUUID(), randomUUID()];
  f.remote.snapshot.content.nodes.push(
    ...ids.map((assetId, index) => ({
      ...buildDrawnNode(`image-${index}`, "container", "frame", {
        x: 0,
        y: 0,
        width: 20,
        height: 20,
      }),
      type: "image" as const,
      assetId,
    })),
  );
  const image = "data:image/png;base64,c3ludGhldGlj";
  f.remote.downloadAsset = async (_fileId, id) => {
    if (id === ids[1]) throw new Error("Offline");
    return image;
  };
  const design = await f.sync.open(f.project.id, randomUUID(), "Incomplete");
  await until(
    () => f.sync.status.find((binding) => binding.designId === design.id)?.status === "offline",
  );
  expect(f.sync.status.find((binding) => binding.designId === design.id)?.assetsPending).toBe(true);
  await f.sync.stop();
  expect((await f.store.readDesign(f.project.id, design.id)).document.nodes).toHaveLength(3);
  const requested: string[] = [];
  f.remote.downloadAsset = async (_fileId, id) => {
    requested.push(id);
    return image;
  };
  const resumed = await f.make();
  await until(
    () => resumed.status.find((binding) => binding.designId === design.id)?.status === "synced",
  );
  expect(
    resumed.status.find((binding) => binding.designId === design.id)?.assetsPending,
  ).toBeUndefined();
  expect(requested).toEqual([ids[1]]);
  expect(await f.store.readSyncAsset(f.project.id, ids[1])).toBe(image);
});

for (const action of ["stop", "disconnect"] as const) {
  test(`${action} waits for active downloads after another asset fails`, async () => {
    const f = await fixture();
    const ids = Array.from({ length: 8 }, () => randomUUID());
    f.remote.snapshot.revision++;
    f.remote.snapshot.content.nodes.push(
      ...ids.map((assetId, index) => ({
        ...buildDrawnNode(`image-${index}`, "container", "frame", {
          x: 0,
          y: 0,
          width: 20,
          height: 20,
        }),
        type: "image" as const,
        assetId,
      })),
    );
    let started = 0,
      active = 0,
      failed = false,
      settled = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.remote.downloadAsset = async (_fileId, assetId) => {
      started++;
      active++;
      try {
        if (assetId === ids[0]) {
          await until(() => started === 3);
          failed = true;
          throw new Error("Image download failed");
        }
        // Model transport that cannot cancel an already-started read.
        await gate;
        return "data:image/png;base64,c3ludGhldGlj";
      } finally {
        active--;
      }
    };
    f.sync.focus(f.project.id, f.design.id);
    let stopping: Promise<void> | undefined;
    try {
      await until(() => failed);
      stopping = (
        action === "stop" ? f.sync.stop() : f.sync.disconnect(f.project.id, f.design.id)
      ).then(() => {
        settled = true;
      });
      await Bun.sleep(10);
      expect(settled).toBe(false);
      expect(active).toBe(3);
      expect(started).toBe(4);
    } finally {
      release();
      await stopping;
    }
    expect(settled).toBe(true);
    expect(active).toBe(0);
    expect(started).toBe(4);
    for (const id of ids) expect(await f.store.readSyncAsset(f.project.id, id)).toBeUndefined();
    if (action === "disconnect") expect(await f.state.read("bindings")).toEqual([]);
  });
}

test("100 unchanged downloaded designs use a single manifest and no document reads or diffs", async () => {
  const f = await fixture();
  for (let i = 1; i < 100; i++) await f.sync.open(f.project.id, randomUUID(), "Cloud design");
  let manifests = 0;
  f.remote.manifest = async (ids) => {
    manifests++;
    expect(ids).toHaveLength(100);
    return ids.map((fileId) => ({
      fileId,
      revision: f.remote.snapshot.revision,
      name: "Cloud design",
      canEdit: true,
    }));
  };
  f.remote.reads = 0;
  let localReads = 0;
  const read = f.store.readDesign.bind(f.store);
  f.store.readDesign = async (...args) => {
    localReads++;
    return read(...args);
  };
  await f.sync.checkRemote();
  const bindings = (await f.state.read("bindings")) as string[];
  for (const binding of bindings) await f.sync.reconcile(binding);
  expect(manifests).toBe(1);
  expect(f.remote.reads).toBe(0);
  expect(localReads).toBe(0);
});

test("manifest changes pull only the changed design and revoked access pauses without reading content", async () => {
  const f = await fixture();
  const other = randomUUID();
  await f.sync.open(f.project.id, other, "Cloud design");
  const revisions = new Map<string, number>([
    [f.fileId, 1],
    [other, 1],
  ]);
  let editable = true;
  f.remote.manifest = async (ids) =>
    ids.map((fileId) => ({
      fileId,
      revision: revisions.get(fileId)!,
      name: "Cloud design",
      canEdit: editable,
    }));
  await f.sync.checkRemote();
  f.remote.reads = 0;
  f.remote.snapshot.revision = 2;
  f.remote.snapshot.content.nodes[0].name = "Remote edit";
  revisions.set(f.fileId, 2);
  await f.sync.checkRemote();
  await until(
    async () =>
      (await f.store.readDesign(f.project.id, f.design.id)).document.nodes[0].name ===
      "Remote edit",
  );
  await until(() => f.sync.status[0]?.status === "synced");
  expect(f.remote.reads).toBe(1);
  editable = false;
  await f.sync.checkRemote();
  expect(f.sync.status.every((binding) => binding.status === "paused")).toBe(true);
  expect(f.remote.reads).toBe(1);
  editable = true;
  await f.sync.checkRemote();
  await until(() => f.sync.status.every((binding) => binding.status === "synced"));
  expect(f.remote.reads).toBe(1);
});

test("metadata transport failure reports offline and reconnects without document downloads", async () => {
  const f = await fixture();
  let offline = true;
  f.remote.manifest = async (ids) => {
    if (offline) throw Error("Connection lost");
    return ids.map((fileId) => ({ fileId, revision: 1, name: "Cloud design", canEdit: true }));
  };
  await expect(f.sync.checkRemote()).rejects.toThrow("Connection lost");
  expect(f.sync.status[0].status).toBe("offline");
  f.remote.reads = 0;
  offline = false;
  await f.sync.checkRemote();
  await until(() => f.sync.status[0]?.status === "synced");
  expect(f.remote.reads).toBe(0);
});

test.each([401, 403])(
  "manifest HTTP %i pauses and resumes pending edits when access returns",
  async (status) => {
    const f = await fixture();
    let denied = true;
    f.remote.manifest = async (ids) => {
      if (denied) throw new CloudHTTPError(status);
      return ids.map((fileId) => ({ fileId, revision: 1, name: "Cloud design", canEdit: true }));
    };
    await expect(f.sync.checkRemote()).rejects.toMatchObject({ status });
    expect(f.sync.status[0].status).toBe("paused");
    await f.edit("Edited while access was paused");
    f.sync.notify(f.project.id, f.design.id);
    denied = false;
    await f.sync.checkRemote();
    await until(() => f.sync.status[0]?.status === "synced");
    expect(f.remote.snapshot.content.nodes[0].name).toBe("Edited while access was paused");
  },
);

for (const phase of ["read", "commit"] as const)
  test.each([401, 403, 404])(
    `${phase} HTTP %i resumes after a permitted manifest without restarting`,
    async (status) => {
      const f = await fixture();
      let denied = true;
      const transfer = f.remote[phase].bind(f.remote) as (
        ...args: unknown[]
      ) => Promise<CloudSnapshot>;
      f.remote[phase] = async (...args: unknown[]) => {
        if (denied) throw new CloudHTTPError(status);
        return transfer(...args);
      };
      f.remote.manifest = async (ids) =>
        ids.map((fileId) => ({ fileId, revision: 1, name: "Cloud design", canEdit: true }));
      await f.edit("Pending transfer");
      f.sync.notify(f.project.id, f.design.id);
      await until(() => f.sync.status[0]?.status === "paused");
      denied = false;
      await f.sync.checkRemote();
      await until(() => f.sync.status[0]?.status === "synced");
      expect(f.remote.snapshot.content.nodes[0].name).toBe("Pending transfer");
    },
  );

test("an active design has capacity while an unrelated background transfer is stalled", async () => {
  const f = await fixture();
  const target = randomUUID();
  const design = await f.sync.open(f.project.id, target, "Cloud design");
  await f.sync.stop();
  const calls: string[] = [],
    releases: (() => void)[] = [];
  const read = f.remote.read.bind(f.remote);
  f.remote.read = async (fileId?: string, _base?: CloudSnapshot, signal?: AbortSignal) => {
    calls.push(fileId!);
    await new Promise<void>((resolve, reject) => {
      releases.push(resolve);
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    return read();
  };
  await f.sync.start("alice");
  await until(() => calls.length === 1);
  f.sync.focus(f.project.id, design.id);
  await until(() => calls.length === 2);
  expect(calls).toEqual([f.fileId, target]);
  for (const release of releases) release();
});

test("a manifest Retry-After defers document transfers for the account", async () => {
  const f = await fixture();
  let limited = true;
  f.remote.manifest = async (ids) => {
    if (limited) throw new CloudHTTPError(429, 600);
    return ids.map((fileId) => ({ fileId, revision: 1, name: "Cloud design", canEdit: true }));
  };
  await expect(f.sync.checkRemote()).rejects.toMatchObject({ status: 429 });
  await f.edit("Pending during limit");
  f.remote.reads = 0;
  f.sync.notify(f.project.id, f.design.id);
  await Bun.sleep(300);
  expect(f.remote.reads).toBe(0);
  limited = false;
  await until(() => f.remote.snapshot.content.nodes[0].name === "Pending during limit");
});

test("a file opened during manifest discovery is not treated as revoked by an older response", async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.remote.manifest = async (ids) => {
    await gate;
    return ids.map((fileId) => ({ fileId, revision: 1, name: "Cloud design", canEdit: true }));
  };
  const request = f.sync.checkRemote();
  const other = await f.sync.open(f.project.id, randomUUID(), "Cloud design");
  f.sync.focus(f.project.id, other.id);
  release();
  await request;
  await Bun.sleep(30);
  expect(f.sync.status.find((binding) => binding.designId === other.id)?.status).toBe("synced");
});

test("an upload acknowledgement cannot hide a file rename made while the upload is running", async () => {
  const f = await fixture();
  f.remote.snapshot.name = "Cloud design";
  f.remote.rename = async (_id, _before, name) => {
    f.remote.snapshot.name = name;
  };
  f.remote.manifest = async (ids) =>
    ids.map((fileId) => ({
      fileId,
      revision: f.remote.snapshot.revision,
      name: f.remote.snapshot.name!,
      canEdit: true,
    }));
  await f.sync.checkRemote();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.remote.beforeCommit = () => gate;
  await f.edit("Document edit");
  f.sync.notify(f.project.id, f.design.id);
  await until(() => f.remote.requests.length === 1);
  const current = await f.store.readDesign(f.project.id, f.design.id);
  await f.store.updateDesign({
    projectId: f.project.id,
    designId: f.design.id,
    expectedVersion: current.version,
    name: "Renamed during upload",
  });
  f.sync.notify(f.project.id, f.design.id);
  f.remote.beforeCommit = undefined;
  release();
  await until(
    () =>
      f.remote.snapshot.name === "Renamed during upload" && f.sync.status[0]?.status === "synced",
  );
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

test("file names sync both ways and concurrent renames preserve both versions", async () => {
  const f = await fixture();
  f.remote.snapshot.name = "Cloud design";
  f.remote.rename = async (_id, before, name) => {
    if (f.remote.snapshot.name !== before && f.remote.snapshot.name !== name)
      throw new CloudHTTPError(409);
    f.remote.snapshot.name = name;
  };
  const rename = async (name: string) => {
    const file = await f.store.readDesign(f.project.id, f.design.id);
    await f.store.updateDesign({
      projectId: f.project.id,
      designId: f.design.id,
      expectedVersion: file.version,
      name,
    });
    f.sync.notify(f.project.id, f.design.id);
  };
  await rename("Desktop name");
  await until(
    () => f.remote.snapshot.name === "Desktop name" && f.sync.status[0]?.status === "synced",
  );
  f.remote.snapshot.name = "Web name";
  f.sync.focus(f.project.id, f.design.id);
  await until(
    async () => (await f.store.readDesign(f.project.id, f.design.id)).name === "Web name",
  );
  await rename("Another local name");
  f.remote.snapshot.name = "Another web name";
  await until(() => f.sync.status[0]?.status === "conflict");
  expect((await f.store.readDesign(f.project.id, f.design.id)).name).toBe("Another local name");
  expect(f.remote.snapshot.name).toBe("Another web name");
});

test("a lost rename response survives restart without replaying over a newer local name", async () => {
  const f = await fixture();
  f.remote.snapshot.name = "Cloud design";
  let calls = 0;
  f.remote.rename = async (_id, _before, name) => {
    calls++;
    f.remote.snapshot.name = name;
    if (calls === 1) throw Error("Lost rename acknowledgement");
  };
  const file = await f.store.readDesign(f.project.id, f.design.id);
  await f.store.updateDesign({
    projectId: f.project.id,
    designId: f.design.id,
    expectedVersion: file.version,
    name: "First name",
  });
  f.sync.notify(f.project.id, f.design.id);
  await until(() => f.sync.status[0]?.status === "offline");
  await f.sync.stop();
  const newer = await f.store.readDesign(f.project.id, f.design.id);
  await f.store.updateDesign({
    projectId: f.project.id,
    designId: f.design.id,
    expectedVersion: newer.version,
    name: "Newest name",
  });
  const resumed = await f.make();
  await until(() => resumed.status[0]?.status === "synced");
  expect(f.remote.snapshot.name).toBe("Newest name");
  expect(calls).toBe(2);
});
