import { expect, test } from "bun:test";
import {
  blankDesignDocument,
  buildDrawnNode,
  parseImmutableDesignDocument,
  type DesignNode,
} from "@/lib/design/document";
import { createArtworkBranches, type ArtworkBranchProps } from "./artwork-branches";

function props(nodes: DesignNode[]): ArtworkBranchProps {
  const children = new Map<string | null, DesignNode[]>();
  for (const node of nodes) {
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node);
    children.set(node.parentId, siblings);
  }
  return {
    nodesById: new Map(nodes.map((node) => [node.id, node])),
    childrenById: children,
    visibleRootIds: new Set(nodes.filter((node) => !node.parentId).map((node) => node.id)),
    tokens: {},
    selectedIds: [],
    prototypeMode: false,
    prototypeArtboardId: null,
    cropId: null,
    editingTextId: null,
  };
}
function scene() {
  return parseImmutableDesignDocument({
    ...blankDesignDocument(),
    nodes: [
      buildDrawnNode("left", "artboard", null, { x: 0, y: 0, width: 500, height: 500 }),
      buildDrawnNode("right", "artboard", null, { x: 800, y: 0, width: 500, height: 500 }),
      buildDrawnNode("group", "container", "left", { x: 0, y: 0, width: 200, height: 200 }),
      buildDrawnNode("leaf", "text", "group", { x: 0, y: 0, width: 100, height: 20 }),
      buildDrawnNode("other", "text", "right", { x: 0, y: 0, width: 100, height: 20 }),
    ],
  }).nodes;
}

test("edits and selection reuse unrelated subtrees while matching a fresh traversal", () => {
  const build = createArtworkBranches();
  let current = props(scene());
  const initial = build(current);
  current = { ...current, selectedIds: ["leaf"] };
  const selected = build(current);
  expect(selected).toEqual(createArtworkBranches()(current));
  expect(selected[1]).toBe(initial[1]);
  const nodes = [...current.nodesById.values()].map((node) =>
    node.id === "leaf" ? { ...node, text: "Changed" } : node,
  );
  current = { ...props(nodes), selectedIds: ["leaf"], tokens: current.tokens };
  const edited = build(current);
  expect(edited).toEqual(createArtworkBranches()(current));
  expect(edited[1]).toBe(selected[1]);
  expect(edited[0].children[0].children[0].node.text).toBe("Changed");
});

test("reparenting invalidates both ancestor chains, including unchanged old parents", () => {
  const build = createArtworkBranches();
  const nodes = scene();
  build(props(nodes));
  const moved = nodes.map((node) => (node.id === "group" ? { ...node, parentId: "right" } : node));
  const current = props(moved);
  expect(build(current)).toEqual(createArtworkBranches()(current));
  expect(build(current)[0].children).toHaveLength(0);
  const deleted = props(moved.filter((node) => node.id !== "leaf"));
  expect(build(deleted)).toEqual(createArtworkBranches()(deleted));
});

test("offscreen branches retain invalidations for selection, tokens, and edits until remounted", () => {
  const build = createArtworkBranches();
  let current = { ...props(scene()), selectedIds: ["leaf"] };
  build(current);
  current = { ...current, visibleRootIds: new Set(["right"]), selectedIds: [] };
  build(current);
  const nodes = [...current.nodesById.values()].map((node) =>
    node.id === "leaf" ? { ...node, text: "Offscreen edit" } : node,
  );
  current = { ...props(nodes), visibleRootIds: new Set(["right"]), tokens: { brand: "#ff0000" } };
  build(current);
  current = { ...current, visibleRootIds: new Set(["left", "right"]) };
  expect(build(current)).toEqual(createArtworkBranches()(current));
  expect(build(current)[0].children[0].children[0].selected).toBe(false);
});

test("responsive width, sibling order, visibility, editing and prototype changes match fresh builds", () => {
  const build = createArtworkBranches();
  let nodes = scene();
  build(props(nodes));
  for (let index = 0; index < 100; index++) {
    nodes = nodes.map((node) =>
      node.id === "left"
        ? { ...node, box: { ...node.box, width: 300 + index } }
        : node.id === "leaf"
          ? { ...node, visible: index % 5 !== 0 }
          : node,
    );
    const current = {
      ...props(index % 2 ? [...nodes].reverse() : nodes),
      editingTextId: index % 3 ? "leaf" : null,
      cropId: index % 4 ? "other" : null,
      prototypeMode: index % 7 === 0,
      prototypeArtboardId: "right",
    };
    expect(build(current)).toEqual(createArtworkBranches()(current));
  }
});
