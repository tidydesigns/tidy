import { afterEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { blankDesignDocument, buildDrawnNode } from "@tidy/design/document";
import { applyDocumentPatch } from "@tidy/editor/design/document-patch";
import { CloudService } from "./cloud-service";
import { CloudAuth } from "./cloud-auth";
import { PrivateState } from "./private-state";
import { ProjectStore } from "./project-store";
import { WorkspaceService } from "./workspace-service";
import * as harnesses from "./harnesses";
import { createWorkspaceRequests } from "./workspace-requests";
import type { CloudCatalog } from "../shared/cloud-sync";
import type { CloudSnapshot, PendingUpload } from "./cloud-remote";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const origin = "https://sync.test";
class Remote {
  async creatorAvatar(): Promise<string | null> {
    return null;
  }
  async rename(id: string, before: string, name: string) {
    const file = this.library.files.find((file) => file.id === id)!;
    if (file.name !== before && file.name !== name) throw Error("Name conflict");
    file.name = name;
    const snapshot = this.snapshots.get(id);
    if (snapshot) snapshot.name = name;
  }
  async thumbnail(): Promise<string | null> {
    return null;
  }
  accountId = "alice";
  reads = 0;
  offline = false;
  catalogWait?: () => Promise<void>;
  library: CloudCatalog = {
    files: [{ id: randomUUID(), name: "Cloud design", folderId: "folder" }],
    folders: [{ id: "folder", name: "Brand" }],
  };
  snapshots = new Map<string, CloudSnapshot>();
  constructor() {
    this.snapshots.set(this.library.files[0].id, {
      revision: 1,
      content: {
        ...blankDesignDocument(),
        nodes: [buildDrawnNode("frame", "artboard", null, { x: 0, y: 0, width: 800, height: 600 })],
      },
    });
  }
  async account() {
    return {
      id: this.accountId,
      organizations: [{ id: "org", name: "Design team", canEdit: true }],
    };
  }
  async catalog() {
    await this.catalogWait?.();
    if (this.offline) throw Error("Offline");
    return structuredClone(this.library);
  }
  async files() {
    return structuredClone(this.library.files);
  }
  async create(_org: string, id: string, name: string) {
    if (this.offline) throw Error("Offline");
    this.snapshots.set(id, { revision: 1, content: blankDesignDocument() });
    this.library.files.push({ id, name, folderId: null });
  }
  async read(id: string) {
    this.reads++;
    if (this.offline) throw Error("Offline");
    return structuredClone(this.snapshots.get(id)!);
  }
  async commit(id: string, pending: PendingUpload) {
    if (this.offline) throw Error("Offline");
    const value = {
      revision: pending.base.revision + 1,
      content: applyDocumentPatch(pending.base.content, pending.patch, false),
    };
    this.snapshots.set(id, value);
    return value;
  }
  async downloadAsset(): Promise<string> {
    throw Error("Unexpected asset");
  }
  async uploadAsset() {
    return randomUUID();
  }
}

test("creator avatars deduplicate across files, cache versions and isolate accounts", async () => {
  const f = await fixture();
  const image = "data:image/png;base64,iVBORw0KGgo=";
  let reads = 0;
  f.remote.creatorAvatar = async () => {
    reads++;
    await Bun.sleep(5);
    return image;
  };
  const first = f.cloud.creatorAvatar(randomUUID(), "creator", "one");
  expect(f.cloud.creatorAvatar(randomUUID(), "creator", "one")).toBe(first);
  expect(await first).toBe(image);
  expect(await f.cloud.creatorAvatar(randomUUID(), "creator", "one")).toBe(image);
  expect(reads).toBe(1);
  await f.cloud.creatorAvatar(randomUUID(), "creator", "two");
  expect(reads).toBe(2);
  const bob = await f.make("bob");
  await bob.creatorAvatar(randomUUID(), "creator", "two");
  expect(reads).toBe(3);
});

test("sign-out fences a cached avatar read before it reaches the renderer", async () => {
  const f = await fixture();
  f.remote.creatorAvatar = async () => "data:image/png;base64,iVBORw0KGgo=";
  const fileId = randomUUID();
  await f.cloud.creatorAvatar(fileId, "creator", "one");
  await Bun.sleep(0);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = f.state.read.bind(f.state);
  const reading = spyOn(f.state, "read").mockImplementation(async (key) => {
    const value = await original(key);
    if (key.startsWith("creator-avatar-")) {
      enter();
      await gate;
    }
    return value;
  });
  try {
    const request = f.cloud.creatorAvatar(fileId, "creator", "one");
    await entered;
    await f.cloud.signOut();
    release();
    expect(await request).toBeNull();
  } finally {
    release();
    reading.mockRestore();
  }
});
async function fixture(launch?: ConstructorParameters<typeof WorkspaceService>[1]) {
  const services: WorkspaceService[] = [];
  const auths: CloudAuth[] = [];
  const root = await mkdtemp(join(tmpdir(), "tidy-cloud-library-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "local-project"));
  const store = new ProjectStore(join(root, "registry"));
  await store.initialize();
  const local = await store.open(join(root, "local-project"));
  const state = new PrivateState(join(root, "private"));
  await state.initialize();
  const remote = new Remote();
  async function make(accountId = "alice") {
    await state.write("credentials", {
      origin,
      encrypted: Buffer.from(
        JSON.stringify({
          clientId: "client",
          accessToken: "test",
          refreshToken: "test",
          expiresAt: Date.now() + 60000,
          accountId,
        }),
      ).toString("base64"),
    });
    const auth = new CloudAuth(
      origin,
      state,
      {
        available: () => true,
        encrypt: (value) => Buffer.from(value),
        decrypt: (value) => value.toString(),
      },
      async () => {},
      (async () => {
        throw Error("Offline");
      }) as unknown as typeof fetch,
    );
    auths.push(auth);
    const service = new WorkspaceService(
      store,
      launch,
      launch ? async () => "/fixture/agent" : undefined,
    );
    services.push(service);
    const cloud = new CloudService(auth, service, state, remote);
    cleanups.push(async () => {
      await cloud.close();
      await service.close();
    });
    await cloud.initialize();
    return cloud;
  }
  const cloud = await make();
  await cloud.account();
  await cloud.catalog("org");
  return { root, store, local, state, remote, cloud, make, service: services[0], auth: auths[0] };
}

test("cloud files open in a private workspace without selecting or uploading the local project", async () => {
  const f = await fixture();
  const first = await f.cloud.openFile("org", f.remote.library.files[0].id);
  expect(f.store.project(first.projectId).cloud).toBe(true);
  expect(
    f.store.project(first.projectId).path.startsWith(await realpath(join(f.root, "private"))),
  ).toBe(true);
  expect(f.store.activeProjectId).toBe(f.local.project.id);
  expect(await f.store.designs(f.local.project.id)).toHaveLength(0);
  expect(first.design.document.nodes[0].box.width).toBe(800);
  f.remote.offline = true;
  const reads = f.remote.reads;
  const cached = await f.cloud.openFile("org", f.remote.library.files[0].id);
  expect(cached.design.id).toBe(first.design.id);
  expect(f.remote.reads).toBe(reads);
  expect(await f.store.designs(first.projectId)).toHaveLength(1);
});

test("a stalled first download cannot block opening an existing offline file", async () => {
  const f = await fixture();
  const cachedId = f.remote.library.files[0].id;
  const cached = await f.cloud.openFile("org", cachedId);
  const slowId = randomUUID();
  f.remote.library.files.push({ id: slowId, name: "Downloading", folderId: null });
  f.remote.snapshots.set(slowId, { revision: 1, content: blankDesignDocument() });
  await f.cloud.catalog("org");
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const downloading = new Promise<void>((resolve) => {
    started = resolve;
  });
  const read = f.remote.read.bind(f.remote);
  f.remote.read = async (id) => {
    if (id === slowId) {
      started();
      await gate;
    }
    return read(id);
  };
  const slow = f.cloud.openFile("org", slowId);
  await downloading;
  try {
    const ready = await Promise.race([
      f.cloud.openFile("org", cachedId),
      Bun.sleep(1000).then(() => {
        throw new Error("Cached open waited behind the download.");
      }),
    ]);
    expect(ready.design.id).toBe(cached.design.id);
  } finally {
    release();
    await slow;
  }
});

test("sign-out invalidates a concurrent cached open before it reaches the renderer", async () => {
  const f = await fixture();
  const id = f.remote.library.files[0].id;
  const cached = await f.cloud.openFile("org", id);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  const read = f.store.readDesign.bind(f.store);
  f.store.readDesign = async (...args) => {
    if (args[1] === cached.design.id && args[2] !== false) {
      started();
      await gate;
    }
    return read(...args);
  };
  const opening = f.cloud.openFile("org", id).then(
    () => null,
    (error: unknown) => error,
  );
  await reading;
  const signingOut = f.cloud.signOut();
  release();
  await signingOut;
  expect(await opening).toEqual(expect.objectContaining({ message: "Cloud sync is stopped." }));
});

test("a binding disconnected during a cached read is reopened through serialized creation", async () => {
  const f = await fixture();
  const id = f.remote.library.files[0].id;
  const cached = await f.cloud.openFile("org", id);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  const read = f.store.readDesign.bind(f.store);
  f.store.readDesign = async (...args) => {
    if (args[1] === cached.design.id && args[2] !== false) {
      started();
      await gate;
    }
    return read(...args);
  };
  const opening = f.cloud.openFile("org", id);
  await reading;
  await f.cloud.disconnect(cached.projectId, cached.design.id);
  release();
  const reopened = await opening;
  expect(reopened.design.id).not.toBe(cached.design.id);
  expect((await f.cloud.state()).bindings.find((binding) => binding.fileId === id)?.designId).toBe(
    reopened.design.id,
  );
});

test("metadata is available offline and isolated between accounts", async () => {
  const f = await fixture();
  f.remote.offline = true;
  expect((await f.cloud.account(true)).id).toBe("alice");
  expect((await f.cloud.catalog("org", true)).folders[0].name).toBe("Brand");
  await f.cloud.close();
  f.remote.accountId = "bob";
  const bob = await f.make("bob");
  await expect(bob.account(true)).rejects.toThrow();
  await expect(bob.catalog("org", true)).rejects.toThrow();
});

test("opening from an older file list uses the current cloud name without renaming it back", async () => {
  const f = await fixture();
  const fileId = f.remote.library.files[0].id;
  f.remote.snapshots.get(fileId)!.name = "Renamed on the web";
  const value = await f.cloud.openFile("org", fileId);
  expect(value.design.name).toBe("Renamed on the web");
  expect(f.remote.snapshots.get(fileId)!.name).toBe("Renamed on the web");
});

test("a new cloud design opens locally while offline and remains discoverable before upload", async () => {
  const f = await fixture();
  f.remote.offline = true;
  const value = await f.cloud.createFile("org");
  expect((await f.store.readDesign(value.projectId, value.design.id)).id).toBe(value.design.id);
  const binding = (await f.cloud.state()).bindings.find((b) => b.designId === value.design.id)!;
  expect(binding.organizationId).toBe("org");
  expect(
    (await f.cloud.catalog("org", true)).files.some((file) => file.id === binding.fileId),
  ).toBe(true);
  expect((await f.cloud.openFile("org", binding.fileId)).design.id).toBe(value.design.id);
});

test("a catalog response arriving after sign-out cannot update the old account cache", async () => {
  const f = await fixture();
  let release!: () => void;
  f.remote.catalogWait = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const request = f.cloud.catalog("org");
  while (!release) await Bun.sleep(1);
  const signedOut = f.cloud.signOut();
  release();
  await expect(request).rejects.toThrow("account changed");
  await signedOut;
  expect((await f.cloud.state()).signedIn).toBe(false);
});

test("keeping both conflict copies preserves local edits in a new cloud file", async () => {
  const f = await fixture(),
    fileId = f.remote.library.files[0].id;
  const opened = await f.cloud.openFile("org", fileId);
  const document = structuredClone(opened.design.document);
  document.nodes[0].name = "Local edit";
  await f.store.updateDesign({
    projectId: opened.projectId,
    designId: opened.design.id,
    expectedVersion: opened.design.version,
    document,
  });
  const remote = f.remote.snapshots.get(fileId)!;
  remote.content.nodes[0].name = "Web edit";
  remote.revision++;
  await f.cloud.focus(opened.projectId, opened.design.id);
  for (let i = 0; i < 300 && (await f.cloud.state()).bindings[0]?.status !== "conflict"; i++)
    await Bun.sleep(10);
  expect((await f.cloud.state()).bindings[0].status).toBe("conflict");
  const resolved = await f.cloud.keepBoth("org", opened.projectId, opened.design.id);
  expect(resolved.design.document.nodes[0].name).toBe("Web edit");
  const local = await f.store.readDesign(opened.projectId, opened.design.id);
  expect(local.name).toEndWith("(local copy)");
  expect(local.document.nodes[0].name).toBe("Local edit");
  const bindings = (await f.cloud.state()).bindings;
  expect(bindings).toHaveLength(2);
  expect(new Set(bindings.map((b) => b.fileId)).size).toBe(2);
});

test("thumbnail requests deduplicate, bound concurrency, and cache one version per file", async () => {
  const f = await fixture();
  let count = 0,
    maximum = 0,
    calls = 0;
  const image = "data:image/png;base64,iVBORw0KGgo=";
  f.remote.thumbnail = async () => {
    calls++;
    maximum = Math.max(maximum, ++count);
    await Bun.sleep(15);
    count--;
    return image;
  };
  const ids = Array.from({ length: 8 }, () => randomUUID());
  const first = f.cloud.thumbnail(ids[0], "one");
  expect(f.cloud.thumbnail(ids[0], "one")).toBe(first);
  await Promise.all([first, ...ids.slice(1).map((id) => f.cloud.thumbnail(id, "one"))]);
  expect(maximum).toBe(3);
  expect(calls).toBe(8);
  expect(await f.cloud.thumbnail(ids[0], "one")).toBe(image);
  expect(calls).toBe(8);
  await f.cloud.thumbnail(ids[0], "two");
  expect(calls).toBe(9);
});

test("opening workspace threads downloads no designs, retains the local project and isolates accounts", async () => {
  const f = await fixture();
  const [first, simultaneous] = await Promise.all([
    f.cloud.openWorkspace("org"),
    f.cloud.openWorkspace("org"),
  ]);
  expect(first.project.id).toBe(simultaneous.project.id);
  expect(first.project.cloud).toBe(true);
  expect(first.designs).toEqual([]);
  expect(f.remote.reads).toBe(0);
  expect(f.store.activeProjectId).toBe(f.local.project.id);
  f.remote.offline = true;
  expect((await f.cloud.openWorkspace("org")).project.id).toBe(first.project.id);
  await expect(f.cloud.openWorkspace("another-org")).rejects.toThrow("editing access");
  const bob = await f.make("bob");
  f.remote.accountId = "bob";
  await bob.account();
  const other = await bob.openWorkspace("org");
  expect(other.project.id).not.toBe(first.project.id);
  expect(other.project.path).not.toBe(first.project.path);
  await f.cloud.signOut();
  await expect(f.cloud.openWorkspace("org")).rejects.toThrow();
});

test("sign-out stops cloud threads and blocks further execution without stopping local threads", async () => {
  const runs: Array<{ stopped: boolean; finish(): void }> = [];
  const f = await fixture(() => {
    const done = Promise.withResolvers<void>();
    const run = { stopped: false, finish: () => done.resolve() };
    runs.push(run);
    return {
      done: done.promise,
      stop: () => {
        run.stopped = true;
        done.resolve();
      },
    };
  });
  const workspace = await f.cloud.openWorkspace("org");
  const localThread = await f.service.startThread({
    projectId: f.local.project.id,
    harness: "codex",
    prompt: "Local work",
    designIds: [],
  });
  const cloudThread = await f.service.startThread({
    projectId: workspace.project.id,
    executionProjectId: f.local.project.id,
    harness: "codex",
    prompt: "Cloud work",
    designIds: [],
  });
  await f.cloud.signOut();
  expect(runs[0].stopped).toBe(false);
  expect(runs[1].stopped).toBe(true);
  await expect(
    f.service.sendMessage({
      projectId: workspace.project.id,
      threadId: cloudThread.id,
      text: "Continue",
    }),
  ).rejects.toThrow();
  await expect(
    f.service.startThread({
      projectId: workspace.project.id,
      executionProjectId: f.local.project.id,
      harness: "codex",
      prompt: "New",
      designIds: [],
    }),
  ).rejects.toThrow();
  expect((await f.service.readThread(f.local.project.id, localThread.id)).status).toBe("running");
});

test("workspace authorization reuses account metadata without disk or network work and adopts membership revocation", async () => {
  const f = await fixture();
  const workspace = await f.cloud.openWorkspace("org");
  const reads = spyOn(f.state, "read");
  const accountReads = spyOn(f.remote, "account");
  try {
    await Promise.all(
      Array.from({ length: 20 }, () => f.service.assertProjectAccess(workspace.project.id)),
    );
    expect(reads).not.toHaveBeenCalled();
    expect(accountReads).not.toHaveBeenCalled();
    accountReads.mockResolvedValue({
      id: "alice",
      organizations: [{ id: "org", name: "Team", canEdit: false }],
    });
    await f.cloud.account();
    await expect(f.service.assertProjectAccess(workspace.project.id)).rejects.toThrow(
      "editing access",
    );
  } finally {
    reads.mockRestore();
    accountReads.mockRestore();
  }
});

test("opening the same workspace concurrently reads its transcript snapshot only once", async () => {
  const f = await fixture();
  const snapshots = spyOn(f.store, "snapshot");
  try {
    const values = await Promise.all(Array.from({ length: 8 }, () => f.cloud.openWorkspace("org")));
    expect(new Set(values.map((value) => value.project.id)).size).toBe(1);
    expect(snapshots).toHaveBeenCalledTimes(1);
  } finally {
    snapshots.mockRestore();
  }
});

test("a late cached account read cannot undo freshly received membership revocation", async () => {
  const f = await fixture();
  const workspace = await f.cloud.openWorkspace("org");
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const original = f.state.read.bind(f.state);
  const reading = spyOn(f.state, "read").mockImplementation(async (key) => {
    const value = await original(key);
    if (key.startsWith("account-")) {
      entered.resolve();
      await gate.promise;
    }
    return value;
  });
  const accounts = spyOn(f.remote, "account");
  try {
    const cached = f.cloud.account(true);
    await entered.promise;
    accounts.mockResolvedValue({
      id: "alice",
      organizations: [{ id: "org", name: "Team", canEdit: false }],
    });
    await f.cloud.account();
    gate.resolve();
    const value = await cached;
    expect(value.organizations[0].canEdit).toBe(false);
    await expect(f.service.assertProjectAccess(workspace.project.id)).rejects.toThrow(
      "editing access",
    );
  } finally {
    gate.resolve();
    reading.mockRestore();
    accounts.mockRestore();
  }
});

test("another account cannot publish a design from a private cloud workspace through the local-design API", async () => {
  const f = await fixture();
  const workspace = await f.cloud.openWorkspace("org");
  const design = await f.store.createDesign(workspace.project.id);
  f.remote.accountId = "bob";
  const bob = await f.make("bob");
  await bob.account();
  await expect(bob.connectLocal(workspace.project.id, design.id, "org")).rejects.toThrow();
  expect((await bob.state()).bindings).toHaveLength(0);
});

test("signing into another account fences a workspace response already reading transcripts", async () => {
  const f = await fixture();
  const workspacePath = f.state.workspace.bind(f.state);
  const canonical = spyOn(f.state, "workspace").mockImplementation(async (key) =>
    realpath(await workspacePath(key)),
  );
  await f.cloud.openWorkspace("org");
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const original = f.store.snapshot.bind(f.store);
  const reading = spyOn(f.store, "snapshot").mockImplementation(async (id) => {
    const value = await original(id);
    entered.resolve();
    await gate.promise;
    return value;
  });
  const login = spyOn(f.auth, "signIn").mockImplementation(async () => {
    Object.defineProperty(f.auth, "accountId", { configurable: true, get: () => "bob" });
    f.remote.accountId = "bob";
  });
  try {
    const pending = f.cloud.openWorkspace("org");
    await entered.promise;
    await f.cloud.signIn();
    gate.resolve();
    await expect(pending).rejects.toThrow();
  } finally {
    gate.resolve();
    reading.mockRestore();
    login.mockRestore();
    Reflect.deleteProperty(f.auth, "accountId");
    canonical.mockRestore();
  }
});

test("workspace request responses cannot return cached designs after sign-out", async () => {
  const f = await fixture();
  const workspace = await f.cloud.openWorkspace("org");
  const design = await f.store.createDesign(workspace.project.id);
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const original = f.store.readDesign.bind(f.store);
  const reading = spyOn(f.store, "readDesign").mockImplementation(async (...args) => {
    const value = await original(...args);
    entered.resolve();
    await gate.promise;
    return value;
  });
  const requests = createWorkspaceRequests(f.service, {
    chooseProject: async () => null,
    chooseDesign: async () => null,
    openExternal: async () => {},
    showItemInFolder: () => {},
  });
  try {
    const pending = requests.invoke(
      "read-design",
      { projectId: workspace.project.id, designId: design.id },
      undefined,
    );
    await entered.promise;
    await f.cloud.signOut();
    gate.resolve();
    await expect(pending).rejects.toThrow();
  } finally {
    gate.resolve();
    reading.mockRestore();
  }
});

test("renderer subscriptions stop forwarding private cloud events after sign-out while local events continue", async () => {
  const f = await fixture();
  const workspace = await f.cloud.openWorkspace("org");
  const received: string[] = [];
  const unsubscribe = f.service.subscribeRenderer((event) => {
    received.push(event.type === "designs" ? event.projectId : event.thread.projectId);
  });
  try {
    await f.service.refreshDesigns(workspace.project.id);
    expect(received).toEqual([workspace.project.id]);
    await f.cloud.signOut();
    await f.service.refreshDesigns(workspace.project.id);
    await f.service.refreshDesigns(f.local.project.id);
    expect(received).toEqual([workspace.project.id, f.local.project.id]);
  } finally {
    unsubscribe();
  }
});

test("cached file metadata cannot return after sign-out", async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>(),
    gate = Promise.withResolvers<void>();
  const original = f.state.read.bind(f.state);
  const reads = spyOn(f.state, "read").mockImplementation(async (key) => {
    const value = await original(key);
    if (key.startsWith("catalog-")) {
      entered.resolve();
      await gate.promise;
    }
    return value;
  });
  try {
    const pending = f.cloud.catalog("org", true);
    await entered.promise;
    await f.cloud.signOut();
    gate.resolve();
    await expect(pending).rejects.toThrow("account changed");
  } finally {
    gate.resolve();
    reads.mockRestore();
  }
});

test("cached workspace opens reuse their registered canonical directory", async () => {
  const f = await fixture();
  await f.cloud.openWorkspace("org");
  const registration = spyOn(f.store, "register");
  try {
    await f.cloud.openWorkspace("org");
    expect(registration).not.toHaveBeenCalled();
  } finally {
    registration.mockRestore();
  }
});

test("sign-out removes the previous account's binding metadata from renderer state", async () => {
  const f = await fixture();
  await f.cloud.openFile("org", f.remote.library.files[0].id);
  expect((await f.cloud.state()).bindings).toHaveLength(1);
  const signingOut = f.cloud.signOut();
  expect((await f.cloud.state()).bindings).toEqual([]);
  await signingOut;
  expect((await f.cloud.state()).bindings).toEqual([]);
});

test("bootstrap never reopens or enumerates private cloud projects after sign-out", async () => {
  const f = await fixture();
  const workspace = await f.cloud.openWorkspace("org");
  await f.store.createDesign(workspace.project.id);
  const requests = createWorkspaceRequests(f.service, {
    chooseProject: async () => null,
    chooseDesign: async () => null,
    openExternal: async () => {},
    showItemInFolder: () => {},
  });
  await requests.invoke("select-project", workspace.project.id, undefined);
  await f.cloud.signOut();
  const discovery = spyOn(harnesses, "checkHarnesses").mockResolvedValue([]);
  try {
    const result = (await requests.invoke("bootstrap", undefined, undefined)) as {
      projects: Array<{ cloud?: boolean }>;
      activeProject: unknown;
    };
    expect(result.activeProject).toBeNull();
    expect(result.projects.every((project) => !project.cloud)).toBe(true);
    expect(result.projects).toHaveLength(1);
  } finally {
    discovery.mockRestore();
  }
});

test("overlapping account refreshes keep the newest revocation durable even if an older cache write stalls", async () => {
  const f = await fixture();
  const firstWrite = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const secondRequested = Promise.withResolvers<void>();
  let requests = 0,
    writes = 0;
  let persisted: { organizations: Array<{ canEdit: boolean }> } | undefined;
  const metadata = spyOn(f.remote, "account").mockImplementation(async () => {
    const canEdit = ++requests === 1;
    if (!canEdit) secondRequested.resolve();
    return { id: "alice", organizations: [{ id: "org", name: "Team", canEdit }] };
  });
  const original = f.state.write.bind(f.state);
  const writing = spyOn(f.state, "write").mockImplementation(async (key, value) => {
    if (!key.startsWith("account-")) return original(key, value);
    if (++writes === 1) {
      firstWrite.resolve();
      await release.promise;
    }
    persisted = value as typeof persisted;
  });
  try {
    const older = f.cloud.account();
    await firstWrite.promise;
    const newer = f.cloud.account();
    await secondRequested.promise;
    await Promise.resolve();
    await Promise.resolve();
    const completed = Promise.allSettled([older, newer]);
    release.resolve();
    const results = await completed;
    expect(results[1].status).toBe("fulfilled");
    expect(persisted?.organizations[0].canEdit).toBe(false);
  } finally {
    release.resolve();
    metadata.mockRestore();
    writing.mockRestore();
  }
});

for (const fails of [false, true]) {
  test(`same-account sign-in ${fails ? "failure" : "success"} restores open workspace access and sync`, async () => {
    const f = await fixture();
    const opened = await f.cloud.openFile("org", f.remote.library.files[0].id);
    const login = spyOn(f.auth, "signIn").mockImplementation(async () => {
      await expect(f.service.assertProjectAccess(opened.projectId)).rejects.toThrow();
      expect(f.service.canAccessCloudProject?.(opened.projectId)).toBe(false);
      if (fails) throw new Error("Login failed");
    });
    try {
      if (fails) await expect(f.cloud.signIn()).rejects.toThrow("Login failed");
      else await f.cloud.signIn();
      await f.service.assertProjectAccess(opened.projectId);
      expect(f.service.canAccessCloudProject?.(opened.projectId)).toBe(true);
      expect((await f.cloud.state()).bindings).toHaveLength(1);
      expect((await f.cloud.openWorkspace("org")).project.id).toBe(opened.projectId);
    } finally {
      login.mockRestore();
    }
  });
}

test("sign-out during failed sign-in never restores the previous workspace authority", async () => {
  const f = await fixture();
  const workspace = await f.cloud.openWorkspace("org");
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const login = spyOn(f.auth, "signIn").mockImplementation(async () => {
    entered.resolve();
    await gate.promise;
    throw new Error("Login cancelled");
  });
  try {
    const signingIn = f.cloud.signIn();
    const rejected = Promise.allSettled([signingIn]);
    await entered.promise;
    const signingOut = f.cloud.signOut();
    gate.resolve();
    expect((await rejected)[0].status).toBe("rejected");
    await signingOut;
    await expect(f.service.assertProjectAccess(workspace.project.id)).rejects.toThrow();
    expect(f.service.canAccessCloudProject?.(workspace.project.id)).toBe(false);
    expect((await f.cloud.state()).bindings).toEqual([]);
  } finally {
    gate.resolve();
    login.mockRestore();
  }
});

test("same-account recovery retains membership revocation received during sign-in", async () => {
  const f = await fixture();
  const workspace = await f.cloud.openWorkspace("org");
  const accounts = spyOn(f.remote, "account").mockResolvedValue({
    id: "alice",
    organizations: [{ id: "org", name: "Team", canEdit: false }],
  });
  const login = spyOn(f.auth, "signIn").mockImplementation(async () => {
    await f.cloud.account();
  });
  try {
    await f.cloud.signIn();
    await expect(f.service.assertProjectAccess(workspace.project.id)).rejects.toThrow(
      "editing access",
    );
    expect(f.service.canAccessCloudProject?.(workspace.project.id)).toBe(false);
  } finally {
    login.mockRestore();
    accounts.mockRestore();
  }
});

test("sign-out fences a delayed same-account recovery read", async () => {
  const f = await fixture();
  const workspace = await f.cloud.openWorkspace("org");
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const original = f.state.read.bind(f.state);
  const reading = spyOn(f.state, "read").mockImplementation(async (key) => {
    const value = await original(key);
    if (key.startsWith("account-")) {
      entered.resolve();
      await gate.promise;
    }
    return value;
  });
  const login = spyOn(f.auth, "signIn").mockResolvedValue(undefined);
  try {
    const signingIn = f.cloud.signIn();
    await entered.promise;
    const signingOut = f.cloud.signOut();
    gate.resolve();
    await Promise.all([signingIn, signingOut]);
    await expect(f.service.assertProjectAccess(workspace.project.id)).rejects.toThrow();
    expect(f.service.canAccessCloudProject?.(workspace.project.id)).toBe(false);
    expect((await f.cloud.state()).bindings).toEqual([]);
  } finally {
    gate.resolve();
    login.mockRestore();
    reading.mockRestore();
  }
});
