import { test, expect } from "bun:test";
import { blankDesignDocument, buildDrawnNode } from "./document";
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
