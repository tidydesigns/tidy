import { expect, test } from "bun:test";
import { createCanvasRootCache } from "../../../../packages/editor/src/editor/retained-artboards";
import { buildDrawnNode } from "./document";

const frame = (id: string) => [
  buildDrawnNode(id, "artboard", null, { x: 0, y: 0, width: 1000, height: 1000 }),
  buildDrawnNode(`${id}-child`, "container", id, { x: 20, y: 20, width: 100, height: 100 }),
];

test("recent artboards keep a bounded number of hidden descendants and stable snapshots", () => {
  const nodes = [...frame("a"), ...frame("b"), ...frame("c")];
  const retain = createCanvasRootCache(2);
  const show = (...ids: string[]) => retain({ nodes, visibleRootIds: new Set(ids) });
  expect([...show("a")]).toEqual(["a"]);
  expect([...show("b")]).toEqual(["b", "a"]);
  const current = show("c");
  expect([...current]).toEqual(["c", "b"]);
  expect(show("c")).toBe(current);
  expect([...show("a")]).toEqual(["a", "c"]);
});

test("active selections do not spend the hidden budget and oversized hidden frames are evicted", () => {
  const nodes = [
    ...frame("a"),
    ...frame("b"),
    buildDrawnNode("extra", "text", "a", { x: 0, y: 0, width: 50, height: 20 }),
  ];
  const retain = createCanvasRootCache(2);
  expect([...retain({ nodes, visibleRootIds: new Set(["a", "b"]) })]).toEqual(["a", "b"]);
  expect([...retain({ nodes, visibleRootIds: new Set(["b"]) })]).toEqual(["b"]);
});

test("overflowing and hug-sized roots are never retained after leaving view", () => {
  const nodes = frame("a").map((node) =>
    node.id === "a" ? { ...node, style: { overflow: "visible" as const } } : node,
  );
  const retain = createCanvasRootCache();
  retain({ nodes, visibleRootIds: new Set(["a"]) });
  expect(retain({ nodes, visibleRootIds: new Set() }).size).toBe(0);
  const hug = frame("b").map((node) =>
    node.id === "b" ? { ...node, heightMode: "hug" as const } : node,
  );
  retain({ nodes: hug, visibleRootIds: new Set(["b"]) });
  expect(retain({ nodes: hug, visibleRootIds: new Set() }).size).toBe(0);
});

test("document edits update retained weights and remove deleted roots", () => {
  const nodes = [...frame("a"), ...frame("b")];
  const retain = createCanvasRootCache(2);
  retain({ nodes, visibleRootIds: new Set(["a", "b"]) });
  const changed = [
    ...nodes,
    buildDrawnNode("extra", "text", "a", { x: 0, y: 0, width: 50, height: 20 }),
  ];
  expect([...retain({ nodes: changed, visibleRootIds: new Set(["b"]) })]).toEqual(["b"]);
  expect(retain({ nodes: [], visibleRootIds: new Set() }).size).toBe(0);
});

test("responsive hug frames do not enter the fixed-size cache", () => {
  const nodes = frame("a").map((node) =>
    node.id === "a"
      ? {
          ...node,
          responsiveBreakpoints: [
            {
              id: "00000000-0000-4000-8000-000000000001",
              frameMaxWidth: 1000,
              heightMode: "hug" as const,
            },
          ],
        }
      : node,
  );
  const retain = createCanvasRootCache();
  retain({ nodes, visibleRootIds: new Set(["a"]) });
  expect(retain({ nodes, visibleRootIds: new Set() }).size).toBe(0);
});

test("position-only snapshots preserve retention while reparenting updates hidden weights", () => {
  const nodes = [...frame("a"), ...frame("b")];
  const retain = createCanvasRootCache(2);
  retain({ nodes, visibleRootIds: new Set(["a", "b"]) });
  const moved = nodes.map((node) => ({ ...node, box: { ...node.box, x: node.box.x + 40 } }));
  expect(retain({ nodes: moved, visibleRootIds: new Set(["b"]) })).toEqual(new Set(["b", "a"]));
  const reparented = moved.map((node) =>
    node.id === "b-child" ? { ...node, parentId: "a" } : node,
  );
  expect([...retain({ nodes: reparented, visibleRootIds: new Set(["b"]) })]).toEqual(["b"]);
});

test("root eligibility changes invalidate retention without changing the hierarchy", () => {
  const nodes = frame("a");
  const retain = createCanvasRootCache();
  retain({ nodes, visibleRootIds: new Set(["a"]) });
  const hidden = nodes.map((node) => (node.id === "a" ? { ...node, visible: false } : node));
  expect(retain({ nodes: hidden, visibleRootIds: new Set() }).size).toBe(0);
  retain({ nodes, visibleRootIds: new Set(["a"]) });
  const overflowing = nodes.map((node) =>
    node.id === "a" ? { ...node, style: { overflow: "visible" as const } } : node,
  );
  expect(retain({ nodes: overflowing, visibleRootIds: new Set() }).size).toBe(0);
});
