import { expect, test } from "bun:test";
import { blankDesignDocument, buildDrawnNode, parseImmutableDesignDocument } from "./document";
import { fileChangesSchema, fileCommitSchema, presenceTicketSchema } from "./sync-protocol";
import { applyRevisionChanges } from "./revision-sync";
import { diffDocument } from "./document-patch";

const envelope = { name: "Design", canEdit: true, sequence: 1 };
const initial = () => ({
  revision: 1,
  content: parseImmutableDesignDocument(blankDesignDocument()),
});

test("snapshot responses validate document semantics and retain frozen identity", () => {
  const snapshot = initial();
  const result = fileChangesSchema.parse({ ...envelope, snapshot, extra: true });
  expect("snapshot" in result && result.snapshot.content).toBe(snapshot.content);
  expect(() =>
    fileChangesSchema.parse({ ...envelope, snapshot: { revision: 1, content: null } }),
  ).toThrow();
  expect(
    fileChangesSchema.safeParse({ ...envelope, snapshot: { revision: 1, content: null } }).success,
  ).toBe(false);
  const document = blankDesignDocument();
  const node = buildDrawnNode("duplicate", "container", null, {
    x: 0,
    y: 0,
    width: 100,
    height: 100,
  });
  expect(() =>
    fileChangesSchema.parse({
      ...envelope,
      snapshot: { revision: 1, content: { ...document, nodes: [node, node] } },
    }),
  ).toThrow();
});

test("delta and no-op acknowledgements preserve revision synchronization", () => {
  const before = initial();
  const next = {
    ...before.content,
    nodes: [buildDrawnNode("added", "container", null, { x: 0, y: 0, width: 100, height: 100 })],
  };
  const patch = diffDocument(before.content, next);
  const changes = fileChangesSchema.parse({
    ...envelope,
    baseRevision: 1,
    revision: 2,
    patches: [{ baseRevision: 1, revision: 2, patch }],
  });
  if ("snapshot" in changes) throw new Error("Expected delta");
  expect(applyRevisionChanges(before, changes).content.nodes.map((node) => node.id)).toEqual([
    "added",
  ]);
  expect(fileCommitSchema.parse({ patch: [], baseRevision: 1, revision: 1, sequence: 0 })).toEqual({
    patch: [],
    baseRevision: 1,
    revision: 1,
    sequence: 0,
  });
  expect(
    fileCommitSchema.parse({ patch, snapshot: { revision: 2, content: next }, sequence: 2 }),
  ).toHaveProperty("snapshot");
  expect(() => applyRevisionChanges(before, { ...changes, baseRevision: 0 })).toThrow("snapshot");
});

test("partial successful acknowledgements cannot enter the edit queue", () => {
  for (const value of [
    null,
    {},
    { patch: [], sequence: 1 },
    { patch: [], baseRevision: 1, sequence: 1 },
    { patch: [], baseRevision: "1", revision: 2, sequence: 1 },
    { patch: [null], baseRevision: 1, revision: 2, sequence: 1 },
  ]) {
    expect(fileCommitSchema.safeParse(value).success).toBe(false);
  }
  expect(fileChangesSchema.safeParse({ ...envelope, baseRevision: 1, revision: 2 }).success).toBe(
    false,
  );
});

test("presence authorization requires a WebSocket URL and a complete ticket", () => {
  const ticket = {
    url: "wss://room.example.test/live?ticket=opaque",
    expiresAt: Date.now() + 60_000,
    sessionId: crypto.randomUUID(),
  };
  expect(presenceTicketSchema.parse(ticket)).toEqual(ticket);
  expect(presenceTicketSchema.parse({ ...ticket, url: "ws://localhost/live" }).url).toBe(
    "ws://localhost/live",
  );
  for (const url of ["", "not a URL", "wss://", "/relative", "https://room.example.test"]) {
    expect(presenceTicketSchema.safeParse({ ...ticket, url }).success).toBe(false);
  }
  expect(
    presenceTicketSchema.safeParse({ ...ticket, url: "https://room.example.test" }).success,
  ).toBe(false);
  expect(presenceTicketSchema.safeParse({ ...ticket, expiresAt: "later" }).success).toBe(false);
});
