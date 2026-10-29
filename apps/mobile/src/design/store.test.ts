import { expect, test } from "bun:test";
import { blankDesignDocument, buildDrawnNode, type DesignDocument } from "@tidy/design/document";
import { applyDocumentPatch } from "@tidy/design/document-patch";
import { DesignStore, type Storage } from "./store";
import { CloudError, type CloudRemote, type Snapshot, type Upload } from "./cloud";

const uuid = () => crypto.randomUUID();
const owner = { origin: "https://cloud.example", accountId: "alice", organizationId: "workspace" };
function document() {
  return {
    ...blankDesignDocument(),
    nodes: [buildDrawnNode(uuid(), "artboard", null, { x: 0, y: 0, width: 390, height: 844 })],
  };
}
function recolor(doc: DesignDocument, fill: string) {
  return { ...doc, nodes: doc.nodes.map((node) => ({ ...node, style: { ...node.style, fill } })) };
}
function setup() {
  const disk = new Map<string, string>();
  const storage: Storage = {
    read: async () => [...disk.values()],
    write: async (id, value) => {
      disk.set(id, value);
    },
  };
  const files = new Map<string, Snapshot>(),
    receipts = new Map<string, Snapshot>();
  let calls = 0;
  const remote: CloudRemote = {
    async create(_org, id, name) {
      if (!files.has(id))
        files.set(id, { revision: 0, content: blankDesignDocument(), name, canEdit: true });
    },
    async read(id) {
      const value = files.get(id);
      if (!value) throw new CloudError(404);
      return structuredClone(value);
    },
    async commit(id, upload) {
      calls++;
      const receipt = receipts.get(upload.operationId);
      if (receipt) return receipt;
      const before = files.get(id)!;
      if (!before.canEdit) throw new CloudError(403);
      if (before.revision !== upload.base.revision) throw new CloudError(409);
      const next = {
        ...before,
        revision: before.revision + 1,
        content: applyDocumentPatch(before.content, upload.patch),
      };
      files.set(id, next);
      receipts.set(upload.operationId, next);
      return next;
    },
  };
  const store = new DesignStore(storage, uuid);
  store.connect({ ...owner, remote });
  return { store, storage, disk, remote, files, receipts, calls: () => calls };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("offline files persist and publish to the existing cloud document protocol", async () => {
  const { store, storage, remote, files } = setup();
  store.connect();
  const file = store.create("Phone design", undefined, document());
  store.edit(file.id, recolor(file.document, "#123456"));
  await settle();
  const reopened = new DesignStore(storage, uuid);
  await reopened.restore();
  expect(reopened.files.get(file.id)!.document.nodes[0].style.fill).toBe("#123456");
  reopened.connect({ ...owner, remote });
  reopened.attach(file.id, owner);
  await reopened.sync();
  const synced = reopened.files.get(file.id)!;
  expect(files.get(synced.cloud!.fileId)!.content).toEqual(synced.document);
  expect(reopened.status(synced)).toBe("Synced");
});

test("lost acknowledgements retry the durable operation ID after a process restart", async () => {
  const { store, remote, storage, files, receipts } = setup();
  const commit = remote.commit;
  let fail = true;
  remote.commit = async (id, upload) => {
    const result = await commit(id, upload);
    if (fail) {
      fail = false;
      throw new Error("Connection lost after commit");
    }
    return result;
  };
  const file = store.create("Receipt", owner, document());
  await store.sync();
  expect(store.files.get(file.id)!.pending).toBeDefined();
  const operation = store.files.get(file.id)!.pending!.operationId;
  const reopened = new DesignStore(storage, uuid);
  await reopened.restore();
  reopened.connect({ ...owner, remote });
  await reopened.sync();
  expect(receipts.size).toBe(1);
  expect(receipts.has(operation)).toBe(true);
  expect(reopened.files.get(file.id)!.pending).toBeUndefined();
  expect(files.get(store.files.get(file.id)!.cloud!.fileId)!.revision).toBe(1);
});

test("edits made while a commit is in flight are preserved and uploaded next", async () => {
  const { store, remote, files } = setup();
  const file = store.create("Concurrent", owner, document());
  await store.sync();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const commit = remote.commit;
  remote.commit = async (id, upload) => {
    entered();
    await gate;
    return commit(id, upload);
  };
  store.edit(file.id, recolor(store.files.get(file.id)!.document, "#111111"));
  const syncing = store.sync();
  await started;
  store.edit(file.id, recolor(store.files.get(file.id)!.document, "#222222"));
  release();
  await syncing;
  expect(store.files.get(file.id)!.document.nodes[0].style.fill).toBe("#222222");
  await store.sync();
  expect(files.get(store.files.get(file.id)!.cloud!.fileId)!.content.nodes[0].style.fill).toBe(
    "#222222",
  );
});

test("independent web edits merge while same-property edits preserve both versions", async () => {
  const { store, files } = setup();
  const file = store.create("Merge", owner, document());
  await store.sync();
  const id = store.files.get(file.id)!.cloud!.fileId;
  let server = files.get(id)!;
  files.set(id, {
    ...server,
    revision: server.revision + 1,
    content: {
      ...server.content,
      nodes: server.content.nodes.map((node) => ({ ...node, name: "Web name" })),
    },
  });
  store.edit(file.id, recolor(store.files.get(file.id)!.document, "#111111"));
  await store.sync();
  expect(store.files.get(file.id)!.document.nodes[0].name).toBe("Web name");
  server = files.get(id)!;
  files.set(id, {
    ...server,
    revision: server.revision + 1,
    content: recolor(server.content, "#333333"),
  });
  store.edit(file.id, recolor(store.files.get(file.id)!.document, "#222222"));
  await store.sync();
  expect(store.files.get(file.id)!.conflict).toBeDefined();
  expect(store.files.get(file.id)!.document.nodes[0].style.fill).toBe("#222222");
  const copy = await store.keepBoth(file.id);
  expect(copy!.document.nodes[0].style.fill).toBe("#222222");
  expect(store.files.get(file.id)!.document.nodes[0].style.fill).toBe("#333333");
  store.connect();
  expect(store.visible()).toHaveLength(0);
});

test("read-only changes preserve offline edits and account changes never upload another account's files", async () => {
  const { store, files, remote, calls } = setup();
  const file = store.create("Private", owner, document());
  await store.sync();
  store.edit(file.id, recolor(store.files.get(file.id)!.document, "#111111"));
  const count = calls();
  store.connect({ origin: owner.origin, accountId: "bob", remote });
  expect(store.visible()).toHaveLength(0);
  await store.sync();
  expect(calls()).toBe(count);
  store.connect({ ...owner, remote });
  const id = store.files.get(file.id)!.cloud!.fileId;
  files.set(id, { ...files.get(id)!, canEdit: false });
  await store.sync();
  expect(store.files.get(file.id)!.conflict?.canEdit).toBe(false);
  expect(calls()).toBe(count);
});

test("failed local persistence prevents remote mutations", async () => {
  const { remote, calls } = setup();
  let creates = 0;
  const create = remote.create;
  remote.create = async (...args) => {
    creates++;
    return create(...args);
  };
  const store = new DesignStore(
    {
      read: async () => [],
      write: async () => {
        throw new Error("Disk full");
      },
    },
    uuid,
  );
  store.connect({ ...owner, remote });
  store.create("Unsaved", owner, document());
  await store.sync();
  expect(creates).toBe(0);
  expect(calls()).toBe(0);
});

test("a previously failed disk write retries without hanging or uploading an undurable edit", async () => {
  const { remote, calls } = setup();
  let available = false;
  const store = new DesignStore(
    {
      read: async () => [],
      write: async () => {
        if (!available) throw new Error("Disk full");
      },
    },
    uuid,
  );
  store.connect({ ...owner, remote });
  store.create("Retry", owner, document());
  await settle();
  await store.sync();
  expect(calls()).toBe(0);
  available = true;
  await store.sync();
  expect(calls()).toBe(1);
});

test("image IDs are uploaded and remapped once before document commits, including recovery", async () => {
  const { store, remote, storage, files } = setup();
  const originalId = uuid(),
    uploadedId = uuid();
  let uploads = 0;
  remote.uploadAsset = async () => {
    uploads++;
    return uploadedId;
  };
  const content = document();
  content.nodes[0] = { ...content.nodes[0], type: "image", assetId: originalId };
  content.assetMimeTypes = { [originalId]: "image/png" };
  const file = store.create("Image", owner, content, {
    [originalId]: "data:image/png;base64,aW1hZ2U=",
  });
  const commit = remote.commit;
  let disconnect = true;
  remote.commit = async (id, upload) => {
    const result = await commit(id, upload);
    if (disconnect) {
      disconnect = false;
      throw new Error("Offline");
    }
    return result;
  };
  await store.sync();
  const restored = new DesignStore(storage, uuid);
  await restored.restore();
  restored.connect({ ...owner, remote });
  await restored.sync();
  expect(uploads).toBe(1);
  const synced = restored.files.get(file.id)!;
  expect(synced.document.nodes[0].assetId).toBe(uploadedId);
  expect(synced.document.assetMimeTypes).toEqual({ [uploadedId]: "image/png" });
  expect(files.get(synced.cloud!.fileId)!.content.nodes[0].assetId).toBe(uploadedId);
});

test("409 after the read rebases safely without reusing a rejected receipt", async () => {
  const { store, remote, files } = setup();
  const file = store.create("Race", owner, document());
  await store.sync();
  const commit = remote.commit;
  const uploads: Upload[] = [];
  let race = true;
  remote.commit = async (id, upload) => {
    uploads.push(upload);
    if (race) {
      race = false;
      const base = files.get(id)!;
      files.set(id, {
        ...base,
        revision: base.revision + 1,
        content: {
          ...base.content,
          nodes: base.content.nodes.map((node) => ({ ...node, name: "Other device" })),
        },
      });
    }
    return commit(id, upload);
  };
  store.edit(file.id, recolor(store.files.get(file.id)!.document, "#aabbcc"));
  await store.sync();
  await store.sync();
  expect(uploads).toHaveLength(2);
  expect(uploads[0].operationId).not.toBe(uploads[1].operationId);
  expect(store.files.get(file.id)!.document.nodes[0].name).toBe("Other device");
  expect(store.status(store.files.get(file.id)!)).toBe("Synced");
});
