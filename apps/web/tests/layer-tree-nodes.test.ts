import { expect, test } from "bun:test";
import { buildDrawnNode } from "@tidy/design/document";
import { createLayerTreeNodes } from "../../../packages/editor/src/editor/layer-tree-nodes";

const node = buildDrawnNode("layer", "container", null, { x: 0, y: 0, width: 100, height: 100 });

test("layer tree ignores geometry, paint and text changes during gestures", () => {
  const select = createLayerTreeNodes();
  const before = select([node]);
  expect(
    select([
      { ...node, box: { ...node.box, x: 40, y: 20 }, style: { fill: "#ffffff" }, text: "New text" },
    ]),
  ).toBe(before);
});

test("layer tree tracks every displayed and interactive property", () => {
  for (const changes of [
    { id: "new-id" },
    { parentId: "parent" },
    { name: "Renamed" },
    { sourcePath: "src/card.tsx" },
    { type: "text" as const },
    { instanceOf: "master" },
    { isComponent: true },
    { locked: true },
    { visible: false },
  ]) {
    const select = createLayerTreeNodes();
    const before = select([node]);
    const changed = { ...node, ...changes };
    const after = select([changed]);
    expect(after).not.toBe(before);
    expect(after[0]).toMatchObject(changes);
    expect(select([changed])).toBe(after);
  }
});

test("layer tree retains insertion, deletion and sibling order", () => {
  const select = createLayerTreeNodes();
  const other = { ...node, id: "other" };
  const before = select([node, other]);
  expect(select([other, node]).map((item) => item.id)).toEqual(["other", "layer"]);
  expect(select([node])).not.toBe(before);
  expect(select([])).toEqual([]);
  expect(select([other]).map((item) => item.id)).toEqual(["other"]);
});
