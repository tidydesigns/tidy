import { expect, test } from "bun:test";
import {
  blankDesignDocument,
  buildDrawnNode,
  type DesignDocument,
  type DesignNode,
} from "@tidy/design/document";
import {
  prepareMoveLayersPreview,
  previewMoveLayers,
} from "../../../packages/editor/src/design/edit-document";

const root = buildDrawnNode("root", "artboard", null, { x: 0, y: 0, width: 800, height: 600 });
const child = buildDrawnNode("child", "container", "root", {
  x: 30,
  y: 40,
  width: 100,
  height: 60,
});
const compare = (nodes: DesignNode[], ids: string[], context: Partial<DesignDocument> = {}) => {
  const document = { ...blankDesignDocument(), ...context, nodes };
  const frozen = structuredClone(document);
  const parents = new Map([["child", { width: 1600, height: 900 }]]);
  const preview = prepareMoveLayersPreview(document, ids, parents);
  const frames: { actual: DesignDocument; expected: DesignDocument }[] = [];
  for (const [x, y] of [
    [10, 20],
    [-15, 2],
    [100001, -100001],
    [0, 0],
    [30, 15],
  ]) {
    const actual = preview(x, y);
    const expected = previewMoveLayers(document, ids, x, y, parents);
    expect(actual).toEqual(expected);
    frames.push({ actual, expected: structuredClone(expected) });
  }
  expect(document).toEqual(frozen);
  for (const frame of frames) expect(frame.actual).toEqual(frame.expected);
};

test("prepared previews equal fresh moves without accumulating deltas or mutating prior frames", () => {
  compare([root, child], ["child"]);
  compare([root, child], ["root", "child"]);
  compare([root, { ...child, locked: true }], ["child"]);
  compare([root, { ...child, positionMode: "auto" }], []);
});

test("prepared moves retain ancestor transforms, constraints, and token bindings", () => {
  compare([{ ...root, style: { rotation: 37, flipY: true } }, child], ["child"]);
  compare(
    [root, { ...child, horizontalConstraint: "scale", verticalConstraint: "scale" }],
    ["child"],
  );
  compare([root, { ...child, tokenBindings: { width: "start" } }], ["child"], {
    designTokens: { start: { type: "dimension", value: 120 } },
  });
});

test("linked component edits keep the existing propagation and override semantics", () => {
  const master = { ...child, isComponent: true };
  const copy = {
    ...child,
    id: "copy",
    box: { ...child.box, x: 300 },
    instanceOf: "child",
    componentSourceId: "child",
  };
  compare([root, master, copy], ["child"]);
  compare([root, master, copy], ["copy"]);
  compare([root, master, copy], ["child", "copy"]);
});

test("prepared moves retain constraint results for descendants of token-sized layers", () => {
  const grandchild = {
    ...child,
    id: "nested",
    parentId: "child",
    horizontalConstraint: "scale" as const,
  };
  compare([root, { ...child, tokenBindings: { width: "wide" } }, grandchild], ["child"], {
    designTokens: { wide: { type: "dimension", value: 200 } },
  });
});
