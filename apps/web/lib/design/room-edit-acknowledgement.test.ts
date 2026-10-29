import { test, expect } from "bun:test";
import { blankDesignDocument, buildDrawnNode, parseDesignDocument } from "./document";
import { applyDocumentPatch, diffDocument, type DocumentPatch } from "./document-patch";
import { RoomEditQueue, type RoomSnapshot, type RoomCommit } from "./room-edit-queue";

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const delta = (base: RoomSnapshot, patch: DocumentPatch) => ({
  baseRevision: base.revision,
  revision: base.revision + 1,
  patches: [{ baseRevision: base.revision, revision: base.revision + 1, patch }],
});
function fixture() {
  const initial: RoomSnapshot = {
    revision: 1,
    content: {
      ...blankDesignDocument(),
      nodes: [buildDrawnNode("one", "container", null, { x: 0, y: 0, width: 100, height: 80 })],
    },
  };
  let server = initial;
  const calls: {
    operationId: string;
    patch: DocumentPatch;
    resolve: (commit: RoomCommit) => void;
  }[] = [];
  const queue = new RoomEditQueue(initial, () => {});
  const edit = (changes: Partial<{ x: number; height: number }>) => {
    const before = queue.getSnapshot().content;
    const after = {
      ...before,
      nodes: before.nodes.map((node) => ({ ...node, box: { ...node.box, ...changes } })),
    };
    return queue.commit(
      diffDocument(before, after),
      (operationId, patch) =>
        new Promise<RoomCommit>((resolve) => calls.push({ operationId, patch, resolve })),
    );
  };
  const accept = (index: number) => {
    const call = calls[index];
    server = {
      revision: server.revision + 1,
      content: applyDocumentPatch(server.content, call.patch),
    };
    call.resolve({ patch: call.patch, snapshot: server, sequence: index + 1 });
  };
  return { initial, queue, calls, edit, accept };
}

test("an identical server acknowledgement reuses the validated optimistic document", async () => {
  const f = fixture(),
    committed = f.edit({ x: 40 });
  await flush();
  const preview = f.queue.getSnapshot();
  const call = f.calls[0];
  const snapshot = f.queue.acknowledge(
    call.operationId,
    f.initial,
    delta(f.initial, structuredClone(call.patch)),
  );
  expect(snapshot.revision).toBe(2);
  expect(snapshot.content).toBe(preview.content);
  call.resolve({ patch: call.patch, snapshot, sequence: 1 });
  await committed;
  expect(f.queue.saved.content).toBe(preview.content);
});

test("appended previews replay a mutated pending patch before later edits", async () => {
  const f = fixture();
  const first = f.edit({ x: 40 });
  await flush();
  f.calls[0].patch[0].after.value = 60;
  const second = f.edit({ height: 120 });
  expect(f.queue.getSnapshot().content.nodes[0].box).toMatchObject({ x: 60, height: 120 });
  f.accept(0);
  await first;
  await flush();
  f.accept(1);
  await second;
  expect(f.queue.saved.content.nodes[0].box).toMatchObject({ x: 60, height: 120 });
});

test("invalid scalar mutations cannot reuse a prefix with the same JSON encoding", async () => {
  const frame = buildDrawnNode("frame", "artboard", null, {
    x: 0,
    y: 0,
    width: 400,
    height: 300,
  });
  const child = buildDrawnNode("child", "container", frame.id, {
    x: 0,
    y: 0,
    width: 100,
    height: 80,
  });
  const initial = { revision: 1, content: { ...blankDesignDocument(), nodes: [frame, child] } };
  const queue = new RoomEditQueue(initial, () => {});
  const gate = Promise.withResolvers<RoomCommit>();
  const patch: DocumentPatch = [
    {
      collection: "nodes",
      id: child.id,
      path: ["parentId"],
      before: { exists: true, value: frame.id },
      after: { exists: true, value: null },
    },
  ];
  const first = queue.commit(patch, () => gate.promise);
  const rejected = first.catch((error: unknown) => error);
  expect(queue.getSnapshot().content.nodes[1].parentId).toBeNull();
  patch[0].after.value = NaN;
  const changed = {
    ...initial.content,
    nodes: [frame, { ...child, box: { ...child.box, height: 120 } }],
  };
  const second = queue.commit(diffDocument(initial.content, changed), async (_id, patch) => ({
    patch,
    sequence: 1,
    snapshot: { revision: 2, content: applyDocumentPatch(initial.content, patch) },
  }));
  expect(queue.getSnapshot().content.nodes[1]).toMatchObject({
    parentId: frame.id,
    box: { height: 120 },
  });
  gate.reject(new Error("Rejected"));
  expect(await rejected).toEqual(new Error("Rejected"));
  await second;
  expect(queue.saved.content.nodes[1]).toMatchObject({
    parentId: frame.id,
    box: { height: 120 },
  });
});

test("large Unicode prefixes fall back to replay while preserving every edit", async () => {
  const initial = {
    revision: 1,
    content: {
      ...blankDesignDocument(),
      nodes: Array.from({ length: 4 }, (_, index) =>
        buildDrawnNode(`text-${index}`, "text", null, { x: 0, y: 0, width: 100, height: 80 }),
      ),
    },
  };
  let parses = 0;
  const queue = new RoomEditQueue(
    initial,
    () => {},
    (input) => {
      parses++;
      return parseDesignDocument(input);
    },
  );
  const textContent = {
    ...initial.content,
    nodes: initial.content.nodes.map((node) => ({ ...node, text: "\u0100".repeat(9000) })),
  };
  const firstPatch = diffDocument(initial.content, textContent);
  const firstResult = Promise.withResolvers<RoomCommit>();
  const first = queue.commit(firstPatch, () => firstResult.promise);
  const before = queue.getSnapshot().content;
  const after = {
    ...before,
    nodes: before.nodes.map((node) => ({ ...node, box: { ...node.box, x: 40 } })),
  };
  const secondPatch = diffDocument(before, after);
  const secondResult = Promise.withResolvers<RoomCommit>();
  const beforeAppend = parses;
  const second = queue.commit(secondPatch, () => secondResult.promise);
  expect(parses - beforeAppend).toBe(2);
  expect(queue.getSnapshot().content).toEqual(parseDesignDocument(after));
  const saved = { revision: 2, content: applyDocumentPatch(initial.content, firstPatch) };
  firstResult.resolve({ patch: firstPatch, snapshot: saved, sequence: 1 });
  await first;
  secondResult.resolve({
    patch: secondPatch,
    snapshot: { revision: 3, content: applyDocumentPatch(saved.content, secondPatch) },
    sequence: 2,
  });
  await second;
  expect(queue.saved.content).toEqual(parseDesignDocument(after));
});

test("server-derived changes and pending later edits cannot reuse an earlier optimistic document", async () => {
  for (const pending of [false, true]) {
    const f = fixture(),
      first = f.edit({ x: 40 });
    await flush();
    const second = pending ? f.edit({ height: 120 }) : null;
    const preview = f.queue.getSnapshot();
    const call = f.calls[0];
    const canonical: DocumentPatch = pending
      ? call.patch
      : [
          ...call.patch,
          {
            collection: "nodes",
            id: "one",
            path: ["box", "width"],
            before: { exists: true, value: 100 },
            after: { exists: true, value: 250 },
          },
        ];
    const snapshot = f.queue.acknowledge(call.operationId, f.initial, delta(f.initial, canonical));
    expect(snapshot.content).not.toBe(preview.content);
    expect(snapshot.content.nodes[0].box).toMatchObject({
      x: 40,
      width: pending ? 100 : 250,
      height: 80,
    });
    f.accept(0);
    await first;
    if (second) {
      await flush();
      f.accept(1);
      await second;
    }
  }
});

test("acknowledgement reuse rejects stale bases, wrong operations, gaps and changed patch input", async () => {
  const f = fixture(),
    committed = f.edit({ x: 40 });
  await flush();
  const call = f.calls[0],
    changes = delta(f.initial, call.patch),
    preview = f.queue.getSnapshot();
  expect(f.queue.acknowledge("other-operation", f.initial, changes).content).not.toBe(
    preview.content,
  );
  expect(() =>
    f.queue.acknowledge(call.operationId, f.initial, { ...changes, revision: 3 }),
  ).toThrow("incomplete");
  expect(() =>
    f.queue.acknowledge(call.operationId, f.initial, { ...changes, baseRevision: 0 }),
  ).toThrow("snapshot");
  call.patch[0].after.value = 60;
  expect(f.queue.acknowledge(call.operationId, f.initial, changes).content.nodes[0].box.x).toBe(60);
  f.queue.receive({
    revision: 10,
    content: {
      ...f.initial.content,
      nodes: f.initial.content.nodes.map((node) => ({ ...node, name: "Remote" })),
    },
  });
  const latestPreview = f.queue.getSnapshot();
  const ack = f.queue.acknowledge(call.operationId, f.initial, changes);
  expect(ack.content).not.toBe(latestPreview.content);
  expect(ack.content.nodes[0].name).not.toBe("Remote");
  call.resolve({ patch: call.patch, snapshot: ack, sequence: 1 });
  await committed;
  expect(f.queue.saved.revision).toBe(10);
  expect(f.queue.saved.content.nodes[0].name).toBe("Remote");
});

test("a rejected optimistic patch is never reused as an accepted edit", async () => {
  const f = fixture();
  const patch: DocumentPatch = [
    {
      collection: "nodes",
      id: "missing",
      path: ["name"],
      before: { exists: true, value: "Old" },
      after: { exists: true, value: "New" },
    },
  ];
  const committed = f.queue.commit(patch, async (id) => {
    expect(() => f.queue.acknowledge(id, f.initial, delta(f.initial, patch))).toThrow(
      "deleted elsewhere",
    );
    throw new Error("Rejected");
  });
  await expect(committed).rejects.toThrow("Rejected");
  expect(f.queue.saved).toBe(f.initial);
});
