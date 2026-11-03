import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore, DesignVersionConflictError } from "../workspace/project-store";
import { CloudCompute, CloudComputeBusyError } from "../cloud/cloud-compute";
import { CanvasService, type CanvasSnapshot } from "./canvas-service";
import type { AgentScope } from "./contracts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "canvas-service-"));
  const root = join(directory, "project");
  await mkdir(root);
  const store = new ProjectStore(join(directory, "private"));
  await store.initialize();
  const project = await store.register(root);
  const file = await store.createDesign(project.id);
  const controller = new AbortController();
  const scope: AgentScope = {
    projectId: project.id,
    threadId: randomUUID(),
    designIds: [file.id],
    writable: true,
    signal: controller.signal,
  };
  const changes: string[] = [];
  const service = new CanvasService({
    store,
    receipts: store.processState,
    authorize: async (caller) => {
      if (caller.projectId !== project.id) throw new Error("Project access denied.");
    },
    onChange: async (projectId) => {
      changes.push(projectId);
    },
  });
  cleanups.push(async () => {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });
  const edit = {
    design_id: file.id,
    expected_version: file.version,
    request_id: randomUUID(),
    operations: [
      { kind: "update", node_ids: [file.document.nodes[0].id], changes: { name: "Updated frame" } },
    ],
  };
  return { directory, store, project, file, scope, controller, service, changes, edit };
}

test("canvas reads are bounded, versioned, and limited to attached designs", async () => {
  const f = await fixture();
  const result = await f.service.read(f.scope, { design_id: f.file.id, limit: 1 });
  expect(result.version).toBe(f.file.version);
  expect(result.nodes).toHaveLength(1);
  expect(result.next_offset).toBeNull();
  expect(result).not.toHaveProperty("tokens");
  expect(result.nodes[0]).not.toHaveProperty("style");
  await expect(
    f.service.read({ ...f.scope, designIds: [] }, { design_id: f.file.id }),
  ).rejects.toThrow("attached");
  await expect(
    f.service.read({ ...f.scope, projectId: randomUUID() }, { design_id: f.file.id }),
  ).rejects.toThrow("Project access");
  await expect(
    f.service.read(f.scope, { design_id: f.file.id, project_id: randomUUID() }),
  ).rejects.toThrow();
  await expect(
    f.service.read(f.scope, { design_id: f.file.id, expected_version: "stale" }),
  ).rejects.toThrow("changed");
  await expect(
    f.service.read(f.scope, { design_id: f.file.id, node_ids: ["missing"] }),
  ).rejects.toThrow("not found");
});

test("large Unicode token and style collections paginate without omissions within the read budget", async () => {
  const f = await fixture();
  const file = await f.store.createDesign(f.project.id, {
    name: "Token library",
    document: {
      ...f.file.document,
      tokens: Object.fromEntries(
        Array.from({ length: 300 }, (_, index) => [`color${index}`, "#ffffff"]),
      ),
      designTokens: Object.fromEntries(
        Array.from({ length: 1000 }, (_, index) => [
          `type${index}`,
          {
            type: "typography",
            value: { fontFamily: "界".repeat(100), fontFace: "界".repeat(200) },
          },
        ]),
      ),
      reusableStyles: Object.fromEntries(
        Array.from({ length: 300 }, (_, index) => [
          `style${index}`,
          {
            name: "界".repeat(120),
            style: {
              fontFamily: "界".repeat(100),
              fontFace: "界".repeat(200),
              shadow: "界".repeat(160),
            },
          },
        ]),
      ),
    },
  });
  const scope = { ...f.scope, designIds: [file.id] };
  const collected = { tokens: {}, designTokens: {}, reusableStyles: {} };
  let offset = 0;
  let pages = 0;
  do {
    const result = await f.service.read(scope, {
      design_id: file.id,
      expected_version: file.version,
      include_tokens: true,
      token_offset: offset,
      token_limit: 200,
      limit: 1,
    });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(128 * 1024);
    expect(result.total_token_entries).toBe(1600);
    const count =
      Object.keys(result.tokens ?? {}).length +
      Object.keys(result.designTokens ?? {}).length +
      Object.keys(result.reusableStyles ?? {}).length;
    expect(count).toBeGreaterThan(0);
    for (const key of ["tokens", "designTokens", "reusableStyles"] as const)
      Object.assign(collected[key], result[key]);
    pages++;
    if (result.next_token_offset === null) break;
    expect(result.next_token_offset).toBe(offset + count);
    offset += count;
  } while (pages < 100);
  expect(pages).toBeGreaterThan(8);
  expect(collected.tokens).toEqual(file.document.tokens);
  expect(collected.designTokens).toEqual(file.document.designTokens ?? {});
  expect(collected.reusableStyles).toEqual(file.document.reusableStyles ?? {});
  await expect(
    f.service.read(scope, { design_id: file.id, include_tokens: true, token_offset: 1 }),
  ).rejects.toThrow("expected_version");
  await expect(
    f.service.read(scope, {
      design_id: file.id,
      include_tokens: true,
      token_offset: 1,
      expected_version: "stale",
    }),
  ).rejects.toThrow("changed");
});

test("page guides paginate within the read budget using the same document version", async () => {
  const f = await fixture();
  const guides = Array.from({ length: 200 }, (_, index) => ({
    id: randomUUID(),
    axis: "x",
    position: index,
  }));
  const file = await f.store.createDesign(f.project.id, {
    name: "Many pages",
    document: {
      ...f.file.document,
      pages: Array.from({ length: 100 }, (_, index) => ({
        id: index ? randomUUID() : f.file.document.pages[0].id,
        name: "界".repeat(120),
        guides,
      })),
    },
  });
  const scope = { ...f.scope, designIds: [file.id] };
  const collected: typeof file.document.pages = [];
  let offset = 0;
  while (offset < file.document.pages.length) {
    const result = await f.service.read(scope, {
      design_id: file.id,
      expected_version: file.version,
      page_offset: offset,
      limit: 1,
    });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(128 * 1024);
    expect(result.total_pages).toBe(100);
    expect(result.pages.length).toBeGreaterThan(0);
    collected.push(...result.pages);
    offset += result.pages.length;
    expect(result.next_page_offset).toBe(offset < 100 ? offset : null);
  }
  expect(collected).toEqual(file.document.pages);
  await expect(f.service.read(scope, { design_id: file.id, page_offset: 1 })).rejects.toThrow(
    "expected_version",
  );
  await expect(
    f.service.read(scope, { design_id: file.id, page_offset: 1, expected_version: "stale" }),
  ).rejects.toThrow("changed");
});

test("a single oversized reusable style offers a bounded node read fallback", async () => {
  const f = await fixture();
  const file = await f.store.createDesign(f.project.id, {
    name: "Detailed style",
    document: {
      ...f.file.document,
      reusableStyles: {
        detailed: {
          name: "Detailed fill",
          style: {
            paints: Array.from({ length: 20 }, (_, index) => ({
              id: `paint${index}`,
              type: "linear",
              stops: Array.from({ length: 20 }, (_, stop) => ({
                id: `${"界".repeat(118)}${stop}`,
                position: stop / 19,
                color: "#ffffff",
              })),
            })),
          },
        },
      },
    },
  });
  const scope = { ...f.scope, designIds: [file.id] };
  await expect(
    f.service.read(scope, {
      design_id: file.id,
      include_tokens: true,
      token_limit: 1,
      limit: 1,
      page_limit: 1,
    }),
  ).rejects.toThrow("set include_tokens: false");
  const result = await f.service.read(scope, {
    design_id: file.id,
    include_tokens: false,
    detail: "summary",
    limit: 1,
  });
  expect(result.nodes).toHaveLength(1);
  expect(result).not.toHaveProperty("reusableStyles");
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(128 * 1024);
});

test("read-only and revoked agents cannot mutate the canvas", async () => {
  const f = await fixture();
  await expect(f.service.edit({ ...f.scope, writable: false }, f.edit)).rejects.toThrow(
    "read-only",
  );
  f.controller.abort(new Error("Turn stopped."));
  await expect(f.service.edit(f.scope, f.edit)).rejects.toThrow("Turn stopped");
  expect((await f.store.readDesign(f.project.id, f.file.id, false)).version).toBe(f.file.version);
});

test("a successful edit is durable and replaying it does not edit or notify twice", async () => {
  const f = await fixture();
  const result = await f.service.edit(f.scope, f.edit);
  const file = await f.store.readDesign(f.project.id, f.file.id, false);
  expect(file.document.nodes[0].name).toBe("Updated frame");
  expect(result.version).toBe(file.version);
  expect(f.changes).toEqual([f.project.id]);
  const reopened = new CanvasService({
    store: f.store,
    receipts: f.store.processState,
    authorize: async () => {},
    onChange: async () => {
      throw new Error("Duplicate notification.");
    },
  });
  cleanups.push(() => reopened.close());
  expect(await reopened.edit(f.scope, f.edit)).toEqual(result);
  expect((await f.store.readDesign(f.project.id, f.file.id, false)).version).toBe(file.version);
  await expect(
    reopened.edit(f.scope, {
      ...f.edit,
      operations: [{ kind: "delete", node_ids: [file.document.nodes[0].id] }],
    }),
  ).rejects.toThrow("different edit");
});

test("invalid operation batches are atomic and stale versions cannot overwrite human edits", async () => {
  const f = await fixture();
  await expect(
    f.service.edit(f.scope, {
      ...f.edit,
      operations: [...f.edit.operations, { kind: "delete", node_ids: ["missing"] }],
    }),
  ).rejects.toThrow("not found");
  expect((await f.store.readDesign(f.project.id, f.file.id, false)).version).toBe(f.file.version);
  await f.store.updateDesign({
    projectId: f.project.id,
    designId: f.file.id,
    expectedVersion: f.file.version,
    name: "Human title",
  });
  await expect(f.service.edit(f.scope, f.edit)).rejects.toThrow("changed");
  expect((await f.store.readDesign(f.project.id, f.file.id, false)).name).toBe("Human title");
});

test("revocation while waiting for the document write queue fences the mutation", async () => {
  const f = await fixture();
  const file = await f.store.updateDesign({
    projectId: f.project.id,
    designId: f.file.id,
    expectedVersion: f.file.version,
  });
  f.edit.expected_version = file.version;
  let release = () => {};
  let entered = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const holding = f.store.updateDesign({
    projectId: f.project.id,
    designId: f.file.id,
    expectedVersion: file.version,
    beforeWrite: async () => {
      entered();
      await blocked;
    },
  });
  await ready;
  let queued = () => {};
  const enqueued = new Promise<void>((resolve) => {
    queued = resolve;
  });
  const update = f.store.updateDesign.bind(f.store);
  const observation = spyOn(f.store, "updateDesign").mockImplementation((input) => {
    queued();
    return update(input);
  });
  const mutation = f.service.edit(f.scope, f.edit).catch((error: unknown) => error);
  await enqueued;
  f.controller.abort(new Error("Turn stopped."));
  release();
  expect((await holding).version).toBe(file.version);
  const failure = await mutation;
  expect(failure).toBeInstanceOf(Error);
  if (!(failure instanceof Error)) throw new Error("Expected revoked authorization.");
  expect(failure.message).toContain("Turn stopped");
  observation.mockRestore();
  expect((await f.store.readDesign(f.project.id, f.file.id, false)).document.nodes[0].name).toBe(
    "Frame",
  );
});

test("an interrupted persisted edit receipt is never automatically replayed", async () => {
  const f = await fixture();
  const key = `canvas-${createHash("sha256").update(`${f.scope.projectId}:${f.scope.threadId}:${f.edit.request_id}`).digest("hex")}`;
  const { canvasEditSchema } = await import("./canvas-service");
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(canvasEditSchema.parse(f.edit)))
    .digest("hex");
  await f.store.processState.write(key, {
    kind: "pending",
    fingerprint,
    owner: { project_id: f.project.id, thread_id: f.scope.threadId, design_id: f.file.id },
    patch: [],
    inverse: [],
  });
  await expect(f.service.edit(f.scope, f.edit)).rejects.toThrow("may have completed");
  expect((await f.store.readDesign(f.project.id, f.file.id, false)).version).toBe(f.file.version);
  expect(f.changes).toHaveLength(0);
});

test("locked layers fail the complete batch instead of silently skipping edits", async () => {
  const f = await fixture();
  const locked = await f.store.updateDesign({
    projectId: f.project.id,
    designId: f.file.id,
    expectedVersion: f.file.version,
    document: {
      ...f.file.document,
      nodes: f.file.document.nodes.map((node) => ({ ...node, locked: true })),
    },
  });
  await expect(
    f.service.edit(f.scope, { ...f.edit, expected_version: locked.version }),
  ).rejects.toThrow("Unlock");
  expect((await f.store.readDesign(f.project.id, f.file.id, false)).version).toBe(locked.version);
  await f.service.edit(f.scope, {
    ...f.edit,
    expected_version: locked.version,
    operations: [
      { kind: "update", node_ids: [locked.document.nodes[0].id], changes: { locked: false } },
      ...f.edit.operations,
    ],
  });
  const unlocked = await f.store.readDesign(f.project.id, f.file.id, false);
  expect(unlocked.document.nodes[0].locked).toBe(false);
  expect(unlocked.document.nodes[0].name).toBe("Updated frame");
});

test("compact node creation and grouping use canonical document operations", async () => {
  const f = await fixture();
  const childId = randomUUID();
  const result = await f.service.edit(f.scope, {
    ...f.edit,
    operations: [
      {
        kind: "add",
        nodes: [
          {
            id: childId,
            name: "Card",
            type: "container",
            parentId: f.file.document.nodes[0].id,
            box: { width: 200, height: 100 },
            style: { fill: "#123456" },
          },
        ],
      },
      { kind: "group", node_ids: [childId] },
    ],
  });
  expect(result.created_node_ids).toHaveLength(2);
  const file = await f.store.readDesign(f.project.id, f.file.id, false);
  const child = file.document.nodes.find((node) => node.id === childId);
  expect(child?.style.fill).toBe("#123456");
  expect(child?.box.width).toBe(200);
  expect(child?.parentId).not.toBe(f.file.document.nodes[0].id);
});

test("concurrent human and agent writes share the same exact-version conflict boundary", async () => {
  const f = await fixture();
  const results = await Promise.allSettled([
    f.service.edit(f.scope, f.edit),
    f.store.updateDesign({
      projectId: f.project.id,
      designId: f.file.id,
      expectedVersion: f.file.version,
      name: "Human title",
    }),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  const file = await f.store.readDesign(f.project.id, f.file.id, false);
  expect(file.name === "Human title" || file.document.nodes[0].name === "Updated frame").toBe(true);
});

test("rendering is revision-bound and uses an immutable isolated snapshot", async () => {
  const f = await fixture();
  const snapshots: CanvasSnapshot[] = [];
  const renderer = new CanvasService({
    store: f.store,
    receipts: f.store.processState,
    authorize: async () => {},
    onChange: async () => {},
    renderSnapshot: async (snapshot) => {
      snapshots.push(snapshot);
      snapshot.document.nodes[0].name = "Renderer-private change";
      return {
        kind: "rendered",
        mime_type: "image/png",
        data: "AA==",
        width: 800,
        height: 600,
        limitations: [],
      };
    },
  });
  cleanups.push(() => renderer.close());
  const request = {
    design_id: f.file.id,
    expected_version: f.file.version,
    node_id: f.file.document.nodes[0].id,
  };
  const result = await renderer.render(f.scope, request);
  expect(result.kind).toBe("rendered");
  expect(result.version).toBe(f.file.version);
  expect(snapshots[0].signal).toBe(f.scope.signal);
  expect((await f.store.readDesign(f.project.id, f.file.id, false)).document.nodes[0].name).toBe(
    "Frame",
  );
  await expect(renderer.render(f.scope, { ...request, expected_version: "stale" })).rejects.toThrow(
    "changed",
  );
  expect((await f.service.render(f.scope, request)).kind).toBe("unavailable");
});

test("undo reverses a recorded edit once and its own receipt supports redo", async () => {
  const f = await fixture();
  const edited = await f.service.edit(f.scope, f.edit);
  expect(edited.undo_available).toBe(true);
  const undo = {
    design_id: f.file.id,
    expected_version: edited.version,
    request_id: randomUUID(),
    operations: [{ kind: "undo", request_id: f.edit.request_id }],
  };
  const reverted = await f.service.edit(f.scope, undo);
  expect((await f.store.readDesign(f.project.id, f.file.id, false)).document).toEqual(
    f.file.document,
  );
  const notifications = f.changes.length;
  expect(await f.service.edit(f.scope, undo)).toEqual(reverted);
  expect(f.changes).toHaveLength(notifications);
  await f.service.edit(f.scope, {
    design_id: f.file.id,
    expected_version: reverted.version,
    request_id: randomUUID(),
    operations: [{ kind: "undo", request_id: undo.request_id }],
  });
  expect((await f.store.readDesign(f.project.id, f.file.id, false)).document.nodes[0].name).toBe(
    "Updated frame",
  );
});

test("undo cannot cross ownership boundaries or overwrite a later human change", async () => {
  const f = await fixture();
  const edited = await f.service.edit(f.scope, f.edit);
  const undo = {
    design_id: f.file.id,
    expected_version: edited.version,
    request_id: randomUUID(),
    operations: [{ kind: "undo", request_id: f.edit.request_id }],
  };
  await expect(f.service.edit({ ...f.scope, threadId: randomUUID() }, undo)).rejects.toThrow(
    "this thread",
  );
  const changed = await f.store.updateDesign({
    projectId: f.project.id,
    designId: f.file.id,
    expectedVersion: edited.version,
    name: "Human title",
  });
  await expect(
    f.service.edit(f.scope, { ...undo, expected_version: changed.version }),
  ).rejects.toThrow("intervening changes");
  expect((await f.store.readDesign(f.project.id, f.file.id, false)).name).toBe("Human title");
});

test("undo cannot be combined with other operations or target another design", async () => {
  const f = await fixture();
  const edited = await f.service.edit(f.scope, f.edit);
  expect(() =>
    f.service.edit(f.scope, {
      ...f.edit,
      request_id: randomUUID(),
      expected_version: edited.version,
      operations: [{ kind: "undo", request_id: f.edit.request_id }, ...f.edit.operations],
    }),
  ).toThrow("only operation");
  const other = await f.store.createDesign(f.project.id);
  await expect(
    f.service.edit(
      { ...f.scope, designIds: [...f.scope.designIds, other.id] },
      {
        design_id: other.id,
        expected_version: other.version,
        request_id: randomUUID(),
        operations: [{ kind: "undo", request_id: f.edit.request_id }],
      },
    ),
  ).rejects.toThrow("another thread or design");
});

test("transactions exceeding the undo receipt budget fail before committing", async () => {
  const f = await fixture();
  const request = {
    ...f.edit,
    operations: [
      {
        kind: "add",
        nodes: Array.from({ length: 10 }, (_, index) => ({
          id: randomUUID(),
          name: `Paragraph ${index}`,
          type: "text",
          parentId: f.file.document.nodes[0].id,
          text: "a".repeat(10000),
        })),
      },
    ],
  };
  await expect(f.service.edit(f.scope, request)).rejects.toThrow("undo history budget");
  expect((await f.store.readDesign(f.project.id, f.file.id, false)).version).toBe(f.file.version);
  expect(f.changes).toHaveLength(0);
});

test("node continuations require the same exact design version", async () => {
  const f = await fixture();
  const document = {
    ...f.file.document,
    nodes: [
      f.file.document.nodes[0],
      { ...f.file.document.nodes[0], id: "second-frame", name: "Second frame" },
    ],
  };
  const file = await f.store.updateDesign({
    projectId: f.project.id,
    designId: f.file.id,
    expectedVersion: f.file.version,
    document,
  });
  const first = await f.service.read(f.scope, { design_id: file.id, limit: 1 });
  expect(first.next_offset).toBe(1);
  await expect(
    f.service.read(f.scope, { design_id: file.id, offset: 1, limit: 1 }),
  ).rejects.toThrow("expected_version");
  expect(
    (
      await f.service.read(f.scope, {
        design_id: file.id,
        offset: 1,
        limit: 1,
        expected_version: first.version,
      })
    ).nodes[0].name,
  ).toBe("Second frame");
  await f.store.updateDesign({
    projectId: f.project.id,
    designId: file.id,
    expectedVersion: file.version,
    document: { ...document, nodes: document.nodes.slice(1) },
  });
  await expect(
    f.service.read(f.scope, {
      design_id: file.id,
      offset: 1,
      limit: 1,
      expected_version: first.version,
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
});

test("canvas worker saturation remains retryable and worker domain errors retain their codes", async () => {
  const f = await fixture();
  const busy = new CloudCompute(0);
  const worker = new CloudCompute();
  const service = new CanvasService({
    store: f.store,
    receipts: f.store.processState,
    authorize: async () => {},
    onChange: async () => {},
    prepareEdit: (document, operations) => busy.prepareCanvas(document, operations),
  });
  cleanups.unshift(async () => {
    await service.close();
    await busy.close();
    await worker.close();
  });
  await expect(service.edit(f.scope, f.edit)).rejects.toBeInstanceOf(CloudComputeBusyError);
  expect((await f.store.readDesign(f.project.id, f.file.id, false)).version).toBe(f.file.version);
  const locked = {
    ...f.file.document,
    nodes: f.file.document.nodes.map((node) => ({ ...node, locked: true })),
  };
  await expect(
    worker.prepareCanvas(locked, [
      { kind: "update", node_ids: [locked.nodes[0].id], changes: { name: "Forbidden" } },
    ]),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  const operations = Array.from({ length: 21 }, () => ({
    kind: "update" as const,
    node_ids: Array.from({ length: 100 }, () => locked.nodes[0].id),
    changes: { name: "Too much" },
  }));
  await expect(worker.prepareCanvas(locked, operations)).rejects.toMatchObject({ code: "BUSY" });
});

test("a rejected encode releases its receipt for an identical retry without inventing undo", async () => {
  const f = await fixture();
  const key = `canvas-${createHash("sha256").update(`${f.scope.projectId}:${f.scope.threadId}:${f.edit.request_id}`).digest("hex")}`;
  const encode = spyOn(CloudCompute.prototype, "encodeDesign").mockRejectedValueOnce(
    new CloudComputeBusyError(),
  );
  try {
    await expect(f.service.edit(f.scope, f.edit)).rejects.toBeInstanceOf(CloudComputeBusyError);
  } finally {
    encode.mockRestore();
  }
  expect(await f.store.processState.read(key)).toMatchObject({ kind: "rejected" });
  expect((await f.store.readDesign(f.project.id, f.file.id, false)).version).toBe(f.file.version);
  await expect(
    f.service.edit(f.scope, {
      ...f.edit,
      operations: [{ kind: "delete", node_ids: [f.file.document.nodes[0].id] }],
    }),
  ).rejects.toThrow("different edit");
  await expect(
    f.service.edit(f.scope, {
      ...f.edit,
      request_id: randomUUID(),
      operations: [{ kind: "undo", request_id: f.edit.request_id }],
    }),
  ).rejects.toThrow("nothing to undo");
  const result = await f.service.edit(f.scope, f.edit);
  expect(await f.store.processState.read(key)).toMatchObject({ kind: "complete", result });
  expect(await f.service.edit(f.scope, f.edit)).toEqual(result);
  expect(f.changes).toHaveLength(1);
});

for (const failure of ["abort", "revocation"] as const) {
  test(`a precommit ${failure} settles the durable pending receipt`, async () => {
    const f = await fixture();
    let revoked = false;
    let receiptKey = "";
    const service = new CanvasService({
      store: f.store,
      receipts: {
        read: (key) => f.store.processState.read(key),
        write: async (key, value) => {
          await f.store.processState.write(key, value);
          receiptKey = key;
          if (
            typeof value !== "object" ||
            value === null ||
            !("kind" in value) ||
            value.kind !== "pending"
          )
            return;
          if (failure === "abort") f.controller.abort(new Error("Turn stopped before commit."));
          else revoked = true;
        },
      },
      authorize: async () => {
        if (revoked) throw new Error("Access revoked.");
      },
      onChange: async () => {
        throw new Error("Rejected edit notified a change.");
      },
    });
    cleanups.push(() => service.close());
    await expect(service.edit(f.scope, f.edit)).rejects.toThrow();
    expect(await f.store.processState.read(receiptKey)).toMatchObject({ kind: "rejected" });
    expect((await f.store.readDesign(f.project.id, f.file.id, false)).version).toBe(f.file.version);
  });
}

test("a known version rejection remains distinguishable from an uncertain write on retry", async () => {
  const f = await fixture();
  const update = spyOn(f.store, "updateDesign").mockRejectedValueOnce(
    new DesignVersionConflictError(),
  );
  try {
    await expect(f.service.edit(f.scope, f.edit)).rejects.toBeInstanceOf(
      DesignVersionConflictError,
    );
  } finally {
    update.mockRestore();
  }
  const key = `canvas-${createHash("sha256").update(`${f.scope.projectId}:${f.scope.threadId}:${f.edit.request_id}`).digest("hex")}`;
  expect(await f.store.processState.read(key)).toMatchObject({ kind: "rejected" });
  expect((await f.service.edit(f.scope, f.edit)).request_id).toBe(f.edit.request_id);
});

test("canonical vector, image, typography, layout and variant authoring stays validated and scoped", async () => {
  const f = await fixture();
  const asset = await f.store.uploadDesignAsset(f.project.id, "data:image/png;base64,iVBORw0KGgo=");
  const root = f.file.document.nodes[0];
  const result = await f.service.edit(f.scope, {
    ...f.edit,
    operations: [
      {
        kind: "update",
        node_ids: [root.id],
        changes: {
          layout: "grid",
          gridColumns: 2,
          columnGap: 8,
          style: { overflow: "hidden", radiusTopLeft: 12 },
        },
      },
      {
        kind: "add",
        nodes: [
          {
            id: "mark",
            parentId: root.id,
            name: "Editable mark",
            type: "vector",
            vectorPath: { d: "M0 0L10 0L5 10Z", viewBox: { x: 0, y: 0, width: 10, height: 10 } },
            style: { fill: "#15803d" },
          },
          {
            id: "photo",
            parentId: root.id,
            name: "Image",
            type: "image",
            assetId: asset.assetId,
            style: { objectFit: "cover" },
          },
          {
            id: "label",
            parentId: root.id,
            name: "Label",
            type: "text",
            text: "Editable text",
            style: {
              fontFamily: "Instrument Sans",
              fontWeight: 500,
              lineHeightMode: "px",
              lineHeightPx: 20,
              textWrap: "nowrap",
              textOverflow: "ellipsis",
              letterSpacing: -0.1,
            },
          },
          {
            id: "component",
            parentId: root.id,
            name: "Status",
            type: "container",
            isComponent: true,
            variants: {
              default: "empty",
              options: { empty: {}, working: { root: { style: { fill: "#1d4ed8" } } } },
            },
            variant: "working",
          },
        ],
      },
    ],
  });
  const document = (await f.store.readDesign(f.project.id, f.file.id)).document;
  expect(document.nodes.find((node) => node.id === "mark")?.vectorPath?.d).toBe("M0 0L10 0L5 10Z");
  expect(document.nodes.find((node) => node.id === "label")?.style.lineHeightPx).toBe(20);
  expect(document.nodes.find((node) => node.id === "component")?.variant).toBe("working");
  await expect(
    f.service.edit(f.scope, {
      ...f.edit,
      request_id: randomUUID(),
      expected_version: result.version,
      operations: [{ kind: "update", node_ids: ["photo"], changes: { assetId: randomUUID() } }],
    }),
  ).rejects.toThrow("Import asset");
  expect(() =>
    f.service.edit(f.scope, {
      ...f.edit,
      request_id: randomUUID(),
      expected_version: result.version,
      operations: [
        {
          kind: "update",
          node_ids: ["label"],
          changes: { style: { arbitraryCss: "url(file:///secret)" } },
        },
      ],
    }),
  ).toThrow();
});

test("asset imports require attached writable scope and bounded project paths without following symlinks", async () => {
  const f = await fixture();
  const { writeFile, symlink, link } = await import("node:fs/promises");
  const root = f.store.project(f.project.id).path;
  await writeFile(
    join(root, "mark.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0H10V10Z"/></svg>',
  );
  await symlink(root, join(root, "linked"));
  const service = new CanvasService({
    store: f.store,
    receipts: f.store.processState,
    authorize: async () => {},
    onChange: async () => {},
    inspectAsset: async () => ({ width: 10, height: 10 }),
  });
  cleanups.push(() => service.close());
  const request = {
    design_id: f.file.id,
    expected_version: f.file.version,
    source: { kind: "project_relative_path", path: "mark.svg" },
  };
  await expect(service.importAsset({ ...f.scope, writable: false }, request)).rejects.toThrow(
    "read-only",
  );
  await expect(service.importAsset({ ...f.scope, designIds: [] }, request)).rejects.toThrow(
    "attached",
  );
  for (const path of [
    "../mark.svg",
    "/mark.svg",
    ".env.svg",
    "linked/mark.svg",
    "mark.txt",
    "C:\\mark.svg",
  ])
    await expect(
      service.importAsset(f.scope, { ...request, source: { ...request.source, path } }),
    ).rejects.toThrow();
  const available =
    process.platform === "linux"
      ? request
      : {
          ...request,
          source: {
            kind: "inline_svg",
            svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0H10V10Z"/></svg>',
          },
        };
  const imported = await service.importAsset(f.scope, available);
  const repeated = await service.importAsset(f.scope, available);
  if (process.platform === "linux") {
    await link(join(root, "mark.svg"), join(root, "hardlink.svg"));
    await expect(service.importAsset(f.scope, request)).rejects.toThrow("without hard links");
  }
  const inline = await service.importAsset(f.scope, {
    ...request,
    source: { kind: "inline_image", data_url: "data:image/png;base64,iVBORw0KGgo=" },
  });
  expect(inline.node.type).toBe("image");
  expect(repeated.asset_id).toBe(imported.asset_id);
  expect(await f.store.readSyncAsset(f.project.id, imported.asset_id)).toStartWith(
    "data:image/svg+xml;base64,",
  );
  expect((await f.store.readDesign(f.project.id, f.file.id)).version).toBe(f.file.version);
  await expect(
    service.importAsset(f.scope, { ...request, expected_version: "stale" }),
  ).rejects.toThrow("changed");
});

test("revocation during queued asset persistence prevents the asset write", async () => {
  const f = await fixture();
  let revoked = false;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let assetId = "";
  const cache = f.store.cacheSyncAsset.bind(f.store);
  const held = spyOn(f.store, "cacheSyncAsset").mockImplementation(async (...args) => {
    assetId = args[1];
    entered.resolve();
    await release.promise;
    return cache(...args);
  });
  const service = new CanvasService({
    store: f.store,
    receipts: f.store.processState,
    authorize: async () => {
      if (revoked) throw new Error("Access revoked");
    },
    onChange: async () => {},
    inspectAsset: async () => ({ width: 10, height: 10 }),
  });
  cleanups.push(() => service.close());
  try {
    const pending = service.importAsset(f.scope, {
      design_id: f.file.id,
      expected_version: f.file.version,
      source: {
        kind: "inline_svg",
        svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"/>',
      },
    });
    await entered.promise;
    revoked = true;
    release.resolve();
    await expect(pending).rejects.toThrow("Access revoked");
    expect(await f.store.readSyncAsset(f.project.id, assetId)).toBeUndefined();
  } finally {
    held.mockRestore();
  }
});

test("render viewport follows resolved component variant dimensions", async () => {
  const f = await fixture();
  const node = f.file.document.nodes[0];
  const file = await f.store.createDesign(f.project.id, {
    name: "Sized variant",
    document: {
      ...f.file.document,
      nodes: [
        {
          ...node,
          isComponent: true,
          variants: {
            default: "compact",
            options: { compact: {}, expanded: { root: { box: { width: 500, height: 300 } } } },
          },
          variant: "expanded",
        },
      ],
    },
  });
  let width = 0,
    height = 0;
  const service = new CanvasService({
    store: f.store,
    receipts: f.store.processState,
    authorize: async () => {},
    onChange: async () => {},
    renderSnapshot: async (snapshot) => {
      width = snapshot.width;
      height = snapshot.document.nodes.find((item) => item.id === node.id)!.box.height;
      return { kind: "rendered", mime_type: "image/png", data: "", width, height, limitations: [] };
    },
  });
  cleanups.push(() => service.close());
  await service.render(
    { ...f.scope, designIds: [file.id] },
    { design_id: file.id, expected_version: file.version, node_id: node.id },
  );
  expect({ width, height }).toEqual({ width: 500, height: 300 });
});
