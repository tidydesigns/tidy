import { test, expect } from "bun:test";
import { blankDesignDocument, buildDrawnNode } from "./document";
import { applyDocumentPatch, diffDocument } from "./document-patch";
import { RoomEditQueue } from "./room-edit-queue";
import { EditHistory } from "./edit-history";

const selection = { selection: "one", selectedIds: ["one"], pageId: "page-1" };
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
function fixture() {
  const initial = {
    revision: 1,
    content: {
      ...blankDesignDocument(),
      nodes: [buildDrawnNode("one", "container", null, { x: 0, y: 0, width: 100, height: 80 })],
    },
  };
  let server = initial,
    sequence = 0;
  const calls = [],
    snapshots = [],
    history = new EditHistory();
  const queue = new RoomEditQueue(initial, (snapshot) => snapshots.push(snapshot));
  const submit = (operationId, patch, expectedSequence, allowedSequences) =>
    new Promise((resolve, reject) =>
      calls.push({ operationId, patch, expectedSequence, allowedSequences, resolve, reject }),
    );
  const commit = (patch, dependency) => queue.commit(patch, submit, dependency);
  const edit = (changes) => {
    const before = queue.getSnapshot().content;
    const after = {
      ...before,
      nodes: before.nodes.map((node) => ({ ...node, box: { ...node.box, ...changes } })),
    };
    const patch = diffDocument(before, after),
      committed = commit(patch);
    history.record(patch, committed, selection);
    return committed;
  };
  const travel = (direction) => history.travel(direction, selection, commit);
  const accept = (index, extra = {}) => {
    const call = calls[index];
    let content = applyDocumentPatch(
      server.content,
      call.patch,
      call.expectedSequence !== undefined,
    );
    content = {
      ...content,
      nodes: content.nodes.map((node) => ({ ...node, box: { ...node.box, ...extra } })),
    };
    const patch = diffDocument(server.content, content);
    server = { revision: server.revision + 1, content };
    call.resolve({ patch, snapshot: server, sequence: ++sequence });
  };
  return { initial, queue, history, calls, snapshots, edit, travel, accept };
}

test("undo and redo are immediately visible before the original acknowledgment, and send confirmed versions in order", async () => {
  const f = fixture();
  const edited = f.edit({ x: 40 });
  const undone = f.travel("undo");
  expect(f.queue.getSnapshot().content.nodes[0].box.x).toBe(0);
  const redone = f.travel("redo");
  expect(f.queue.getSnapshot().content.nodes[0].box.x).toBe(40);
  await flush();
  expect(f.calls.length).toBe(1);
  f.accept(0);
  await flush();
  expect(f.calls[1].expectedSequence).toBe(1);
  f.accept(1);
  await flush();
  expect(f.calls[2].expectedSequence).toBe(2);
  f.accept(2);
  await Promise.all([edited, undone.committed, redone.committed]);
  expect(f.queue.saved.content.nodes[0].box.x).toBe(40);
  expect(new Set(f.calls.map((call) => call.operationId)).size).toBe(3);
});

test("a new edit after pending undo stays visible and replaces redo without acknowledgment rebuilding history", async () => {
  const f = fixture(),
    first = f.edit({ x: 40 }),
    undone = f.travel("undo"),
    latest = f.edit({ x: 12 });
  expect(f.queue.getSnapshot().content.nodes[0].box.x).toBe(12);
  expect(f.travel("redo")).toBeNull();
  await flush();
  f.accept(0);
  await flush();
  expect(f.queue.getSnapshot().content.nodes[0].box.x).toBe(12);
  f.accept(1);
  await flush();
  f.accept(2);
  await Promise.all([first, undone.committed, latest]);
  const undoLatest = f.travel("undo");
  expect(f.queue.getSnapshot().content.nodes[0].box.x).toBe(0);
  await flush();
  f.accept(3);
  await undoLatest.committed;
  expect(f.travel("undo")).toBeNull();
});

test("pending undo includes the canonical server-derived changes, preserving a later independent edit", async () => {
  const f = fixture(),
    first = f.edit({ x: 40 }),
    undone = f.travel("undo"),
    latest = f.edit({ height: 120 });
  await flush();
  f.accept(0, { width: 250 });
  await flush();
  expect(
    f.calls[1].patch.some(
      (item) => item.path.join(".") === "box.width" && item.after.value === 100,
    ),
  ).toBe(true);
  expect(f.queue.getSnapshot().content.nodes[0].box).toMatchObject({
    x: 0,
    width: 100,
    height: 120,
  });
  f.accept(1);
  await flush();
  f.accept(2);
  await Promise.all([first, undone.committed, latest]);
  expect(f.queue.saved.content.nodes[0].box).toMatchObject({ x: 0, width: 100, height: 120 });
});

test("a rejected edit removes its dependent undo without sending it, and the queue continues", async () => {
  const f = fixture(),
    first = f.edit({ x: 40 }),
    undone = f.travel("undo"),
    latest = f.edit({ height: 120 });
  const firstFailure = first.catch((error) => error.message),
    undoFailure = undone.committed.catch((error) => error.message);
  await flush();
  f.calls[0].reject(new Error("Rejected edit"));
  await flush();
  expect(f.calls.length).toBe(2);
  expect(f.calls[1].expectedSequence).toBeUndefined();
  expect(f.queue.getSnapshot().content.nodes[0].box).toMatchObject({ x: 0, height: 120 });
  f.accept(1);
  await latest;
  expect(await firstFailure).toBe("Rejected edit");
  expect(await undoFailure).toBe("Rejected edit");
  const undoLatest = f.travel("undo");
  await flush();
  f.accept(2);
  await undoLatest.committed;
  expect(f.travel("undo")).toBeNull();
});

test("a rejected undo restores its history entry and keeps the confirmed document", async () => {
  const f = fixture(),
    edited = f.edit({ x: 40 });
  await flush();
  f.accept(0);
  await edited;
  const undone = f.travel("undo"),
    failure = undone.committed.catch(() => {});
  await flush();
  f.calls[1].reject(new Error("This property changed elsewhere"));
  await failure;
  await flush();
  expect(f.queue.getSnapshot().content.nodes[0].box.x).toBe(40);
  expect(f.travel("redo")).toBeNull();
  const retry = f.travel("undo");
  expect(retry).not.toBeNull();
  await flush();
  f.accept(2);
  await retry.committed;
});

test("an older acknowledgment cannot replace a newer collaborator snapshot", async () => {
  const f = fixture(),
    edited = f.edit({ x: 40 });
  await flush();
  const remote = {
    ...f.initial.content,
    nodes: f.initial.content.nodes.map((node) => ({ ...node, name: "Remote name" })),
  };
  f.queue.receive({ revision: 10, content: remote });
  expect(f.queue.getSnapshot().content.nodes[0]).toMatchObject({
    name: "Remote name",
    box: { x: 40 },
  });
  f.accept(0);
  await edited;
  expect(f.queue.getSnapshot().content.nodes[0].name).toBe("Remote name");
  expect(f.snapshots.at(-1).revision).toBe(10);
});

test("consecutive pending undos carry the earlier undo version only for overlapping properties", async () => {
  const f = fixture(),
    first = f.edit({ x: 40, height: 120 }),
    second = f.edit({ x: 60 });
  const undoSecond = f.travel("undo"),
    undoFirst = f.travel("undo");
  expect(f.queue.getSnapshot().content.nodes[0].box).toMatchObject({ x: 0, height: 80 });
  await flush();
  f.accept(0);
  await flush();
  f.accept(1);
  await flush();
  f.accept(2);
  await flush();
  expect(f.calls[3].expectedSequence).toBe(1);
  expect(f.calls[3].allowedSequences).toEqual([3]);
  f.accept(3);
  await Promise.all([first, second, undoSecond.committed, undoFirst.committed]);
  const redoFirst = f.travel("redo"),
    redoSecond = f.travel("redo");
  await flush();
  f.accept(4);
  await flush();
  expect(f.calls[5].expectedSequence).toBe(3);
  expect(f.calls[5].allowedSequences).toEqual([5]);
  f.accept(5);
  await Promise.all([redoFirst.committed, redoSecond.committed]);
  expect(f.queue.saved.content.nodes[0].box).toMatchObject({ x: 60, height: 120 });
});

test("history dependencies retain canonical patch/sequence without a document snapshot", async () => {
  const f = fixture();
  const edit = f.edit({ x: 20 });
  await flush();
  f.accept(0);
  await edit;
  await flush();
  let dependency;
  f.history.travel("undo", selection, (_patch, read) => {
    dependency = read();
    return Promise.reject(new Error("test cancellation"));
  });
  const acknowledgment = await dependency;
  expect(acknowledgment.sequence).toBe(1);
  expect(acknowledgment.patch.length).toBeGreaterThan(0);
  expect(Object.hasOwn(acknowledgment, "snapshot")).toBe(false);
  await flush();
});

test("a large history operation is bounded by bytes rather than only entry count", async () => {
  const history = new EditHistory(50, 100);
  const patch = [
    {
      collection: "nodes",
      id: "one",
      path: ["text"],
      before: { exists: true, value: "old" },
      after: { exists: true, value: "x".repeat(1000) },
    },
  ];
  history.record(
    patch,
    Promise.resolve({
      patch,
      sequence: 1,
      snapshot: { revision: 1, content: blankDesignDocument() },
    }),
    selection,
  );
  await flush();
  expect(
    history.travel("undo", selection, () => {
      throw new Error("oversized history should be released");
    }),
  ).toBeNull();
});
