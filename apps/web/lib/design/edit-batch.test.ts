import { expect, test } from "bun:test";
import { blankDesignDocument, buildDrawnNode, type DesignNodeChanges } from "./document";
import { changedLayerBatch, changedLayers } from "./edit-document";
import { createComponentInstance } from "./document-operations";

const node = (id: string, parentId: string | null = null) =>
  buildDrawnNode(id, "container", parentId, { x: 10, y: 10, width: 100, height: 80 });

test("batch settles constraints and ancestor locks before the next edit without mutating its input", () => {
  const document = {
    ...blankDesignDocument(),
    nodes: [
      node("root"),
      { ...node("child", "root"), horizontalConstraint: "end" as const },
      { ...node("grandchild", "child"), horizontalConstraint: "scale" as const },
    ],
  };
  const original = structuredClone(document);
  const result = changedLayerBatch(document, [
    { nodeId: "root", changes: { box: { width: 200 } } },
    {
      nodeId: "child",
      changes: (current) => ({ name: `At ${current.box.x}`, box: { width: 200 } }),
    },
    { nodeId: "root", changes: { locked: true } },
    { nodeId: "child", changes: { name: "Must not apply" } },
    { nodeId: "root", changes: { locked: false } },
    { nodeId: "child", changes: { style: { fill: "#112233" } } },
  ]);
  expect(document).toEqual(original);
  expect(result[1].name).toBe("At 110");
  expect(result[1].style.fill).toBe("#112233");
  expect(result[2].box.x).toBe(20);
  expect(result[2].box.width).toBe(200);
});

test("later batch edits see materialized token values and retained style overrides", () => {
  const document = {
    ...blankDesignDocument(),
    designTokens: { corner: { type: "radius" as const, value: 24 } },
    nodes: [{ ...node("a"), styleId: "style", tokenBindings: { radius: "corner" } }],
  };
  const result = changedLayerBatch(document, [
    { nodeId: "a", changes: { tokenBindings: { radius: null } } },
    { nodeId: "a", changes: (current) => ({ style: { radius: current.style.radius! + 4 } }) },
    { nodeId: "a", changes: { style: { fill: "#abcdef" } } },
  ]);
  expect(result[0].style.radius).toBe(28);
  expect(result[0].tokenBindings!.radius).toBeNull();
  expect(result[0].styleOverrides).toEqual(["radius", "fill"]);
  expect(document.nodes[0].tokenBindings.radius).toBe("corner");
});

test("shared batch indexes preserve ordered overrides, references and resize behavior", () => {
  const master = { ...node("master"), isComponent: true };
  let sequence = 0;
  const document = createComponentInstance(
    {
      ...blankDesignDocument(),
      nodes: [
        master,
        { ...node("label", "master"), horizontalConstraint: "end" },
        node("mask", "master"),
      ],
    },
    "master",
    () => `copy-${sequence++}`,
  ).document;
  const edits: { nodeId: string; changes: DesignNodeChanges }[] = [
    { nodeId: "copy-1", changes: { style: { fill: "#abcdef" } } },
    { nodeId: "label", changes: { style: { fill: "#112233" } } },
    {
      nodeId: "master",
      changes: { box: { width: 200 }, mask: { sourceId: "mask", mode: "alpha", enabled: true } },
    },
    {
      nodeId: "label",
      changes: {
        interactions: [
          {
            id: "10000000-0000-4000-8000-000000000001",
            trigger: { type: "click" },
            transition: { type: "instant", duration: 0 },
            action: { type: "setState", target: "mask", state: "focus" },
          },
        ],
      },
    },
    { nodeId: "master", changes: { style: { borderLeftWidth: 4 } } },
    { nodeId: "label", changes: { name: "Final" } },
  ];
  let sequential = document;
  for (const edit of edits)
    sequential = { ...sequential, nodes: changedLayers(sequential, [edit.nodeId], edit.changes) };
  const batched = changedLayerBatch(document, edits);
  expect(batched).toEqual(sequential.nodes);
  expect(batched.find((n) => n.id === "copy-1")!.style.fill).toBe("#abcdef");
  expect(batched.find((n) => n.id === "copy-0")!.mask!.sourceId).toBe("copy-2");
  expect(batched.find((n) => n.id === "copy-1")!.interactions![0].action).toEqual({
    type: "setState",
    target: "copy-2",
    state: "focus",
  });
});
