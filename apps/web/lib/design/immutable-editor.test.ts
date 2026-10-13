import { expect, test } from "bun:test";
import {
  blankDesignDocument,
  buildDrawnNode,
  parseImmutableDesignDocument,
  type DesignDocument,
} from "./document";
import { changedLayers, movedLayers, trackDocumentChanges } from "./edit-document";
import { applyDocumentPatch, diffDocument, invertPatch } from "./document-patch";
import { createComponentInstance, makeComponent } from "./document-operations";
import { RoomEditQueue } from "./room-edit-queue";

function fixture() {
  return {
    ...blankDesignDocument(),
    nodes: [
      buildDrawnNode("a", "container", null, { x: 0, y: 0, width: 100, height: 100 }),
      buildDrawnNode("b", "container", "a", { x: 10, y: 10, width: 20, height: 20 }),
      buildDrawnNode("c", "text", null, { x: 200, y: 0, width: 100, height: 20 }),
    ],
  };
}

test("immutable edits, propagation, patches and undo match the mutable reference across successive transactions", () => {
  let reference = makeComponent(fixture(), "a");
  reference = createComponentInstance(
    reference,
    "a",
    (() => {
      let id = 0;
      return () => `copy-${++id}`;
    })(),
  ).document;
  let fast = parseImmutableDesignDocument(reference);
  for (let index = 0; index < 120; index++) {
    const id = index % 3 === 0 ? "a" : index % 3 === 1 ? "b" : "c";
    const transform = (document: DesignDocument) => ({
      ...document,
      nodes:
        index % 4 === 0
          ? movedLayers(document, [id], 1, -1)
          : changedLayers(document, [id], {
              name: `Layer ${index}`,
              style: { radius: index % 20, fill: index % 2 ? "#112233" : "#aabbcc" },
            }),
    });
    const nextReference = trackDocumentChanges(reference, transform(reference));
    const nextFast = trackDocumentChanges(fast, transform(fast), parseImmutableDesignDocument);
    expect(nextFast).toEqual(nextReference);
    const patch = diffDocument(fast, nextFast);
    const applied = applyDocumentPatch(fast, patch, false, parseImmutableDesignDocument);
    expect(applied).toEqual(nextReference);
    expect(
      applyDocumentPatch(applied, invertPatch(patch), false, parseImmutableDesignDocument),
    ).toEqual(
      applyDocumentPatch(nextReference, invertPatch(diffDocument(reference, nextReference))),
    );
    fast = applied;
    reference = nextReference;
  }
});

test("immutable optimistic queues preserve newer remote edits and pending local edits", async () => {
  const initial = { revision: 0, content: parseImmutableDesignDocument(fixture()) };
  const queue = new RoomEditQueue(initial, () => {}, parseImmutableDesignDocument);
  let finish!: (value: {
    patch: ReturnType<typeof diffDocument>;
    snapshot: typeof initial;
    sequence: number;
  }) => void;
  const next = {
    ...initial.content,
    nodes: changedLayers(initial.content, ["b"], { name: "Local" }),
  };
  const patch = diffDocument(initial.content, next);
  const pending = queue.commit(
    patch,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  const remote = {
    revision: 2,
    content: parseImmutableDesignDocument({
      ...initial.content,
      nodes: changedLayers(initial.content, ["c"], { text: "Remote" }),
    }),
  };
  queue.receive(remote);
  expect(queue.getSnapshot().content.nodes[1].name).toBe("Local");
  expect(queue.getSnapshot().content.nodes[2].text).toBe("Remote");
  finish({
    patch,
    snapshot: { revision: 1, content: parseImmutableDesignDocument(next) },
    sequence: 1,
  });
  await pending;
  expect(queue.saved.revision).toBe(2);
  expect(queue.saved.content.nodes[2].text).toBe("Remote");
});
