import { expect, test } from "bun:test";
import { blankDesignDocument, buildDrawnNode } from "./document";
import { copyLayers, pasteLayers, readDesignClipboard } from "./clipboard";
import { applyDocumentPatch, diffDocument, invertPatch } from "./document-patch";

const layer = (
  id: string,
  parentId: string | null,
  x: number,
  y: number,
  width = 100,
  height = 50,
) => buildDrawnNode(id, "container", parentId, { x, y, width, height });
const viewport = { x: 0, y: 0, width: 800, height: 600 };
const source = {
  ...blankDesignDocument(),
  nodes: [
    layer("source-frame", null, 1000, 2000, 800, 600),
    layer("copied", "source-frame", 40, 60),
  ],
};
const payload = () => readDesignClipboard(copyLayers(source, ["copied"], "source"))!;
const destination = (x = 100, y = 100, width = 500, height = 400) => ({
  ...blankDesignDocument(),
  nodes: [layer("target-frame", null, x, y, width, height)],
});
const options = {
  fileId: "target",
  pageId: "page-1",
  parentId: "target-frame",
  viewport,
  createId: () => "pasted",
};

test("normal paste preserves the source position relative to the destination frame", () => {
  const copied = payload();
  expect(copied.sourcePosition).toEqual({ x: 40, y: 60 });
  const target = destination();
  const pasted = pasteLayers(target, copied, options);
  expect(pasted.document.nodes[1]).toMatchObject({
    id: "pasted",
    parentId: "target-frame",
    box: { x: 40, y: 60, width: 100, height: 50 },
  });
  expect(
    applyDocumentPatch(pasted.document, invertPatch(diffDocument(target, pasted.document))),
  ).toEqual(target);
});

test("normal paste centers content that does not fit at its original relative position", () => {
  const copied = { ...payload(), sourcePosition: { x: 400, y: 300 } };
  const pasted = pasteLayers(destination(100, 100, 200, 150), copied, options);
  expect(pasted.document.nodes[1].box).toEqual({ x: 50, y: 50, width: 100, height: 50 });
});

test("older clipboard data remains readable and centers inside the selected frame", () => {
  const legacy = { ...payload() };
  delete legacy.sourcePosition;
  const copied = readDesignClipboard(JSON.stringify(legacy))!;
  const pasted = pasteLayers(destination(), copied, options);
  expect(pasted.document.nodes[1].box).toMatchObject({ x: 200, y: 175 });
});

test("a distant selected frame does not pull normal paste away from the current view", () => {
  const pasted = pasteLayers(destination(10000, 10000), payload(), options);
  expect(pasted.document.nodes[1]).toMatchObject({ parentId: null, box: { x: 350, y: 275 } });
});

test("normal paste centers within the visible part of a large destination frame", () => {
  const pasted = pasteLayers(destination(-1000, -1000, 5000, 5000), payload(), options);
  expect(pasted.document.nodes[1]).toMatchObject({
    parentId: "target-frame",
    box: { x: 1350, y: 1275 },
  });
  expect(pasted.bounds).toMatchObject({ x: 350, y: 275 });
});

test("viewport placement accounts for rotated destination bounds", () => {
  const target = destination(1100, -200, 100, 1400);
  target.nodes[0].style.rotation = 90;
  const pasted = pasteLayers(target, payload(), options);
  expect(pasted.document.nodes[1].parentId).toBe("target-frame");
});

test("large-frame placement uses the view center instead of a measured source layer", () => {
  const target = {
    ...destination(-1000, -1000, 5000, 5000),
    nodes: [
      ...destination(-1000, -1000, 5000, 5000).nodes,
      layer("copied", "target-frame", 40, 60),
    ],
  };
  const pasted = pasteLayers(target, payload(), {
    ...options,
    fileId: "source",
    boxes: new Map([["copied", { x: 40, y: 60, width: 100, height: 50 }]]),
  });
  expect(pasted.document.nodes[2].box).toMatchObject({ x: 1350, y: 1275 });
});

test("normal canvas paste brings offscreen content into the visible viewport", () => {
  const pasted = pasteLayers(blankDesignDocument(), payload(), { ...options, parentId: null });
  expect(pasted.document.nodes[0].box).toMatchObject({ x: 350, y: 275 });
});

test("normal canvas paste retains visible source coordinates with a same-file duplicate offset", () => {
  const doc = { ...blankDesignDocument(), nodes: [layer("copied", null, 100, 100)] };
  const copied = readDesignClipboard(copyLayers(doc, ["copied"], "source"))!;
  for (const [fileId, x] of [
    ["source", 124],
    ["target", 100],
  ] as const) {
    const pasted = pasteLayers(blankDesignDocument(), copied, {
      ...options,
      fileId,
      parentId: null,
    });
    expect(pasted.document.nodes[0].box).toMatchObject({ x, y: x });
  }
});

test("paste here honors its explicit point independently of normal viewport placement", () => {
  const pasted = pasteLayers(destination(), payload(), {
    ...options,
    position: { x: 250, y: 200 },
  });
  expect(pasted.document.nodes[1]).toMatchObject({
    parentId: "target-frame",
    box: { x: 150, y: 100 },
  });
  expect(pasted.bounds).toMatchObject({ x: 250, y: 200 });
});

test("paste in place ignores contextual and explicit placement", () => {
  const pasted = pasteLayers(destination(), payload(), {
    ...options,
    position: { x: 250, y: 200 },
    inPlace: true,
  });
  expect(pasted.bounds).toMatchObject({ x: 1040, y: 2060 });
});

test("copy uses measured flow positions for destination-relative placement", () => {
  const copied = readDesignClipboard(
    copyLayers(
      source,
      ["copied"],
      "source",
      new Map([["copied", { x: 70, y: 90, width: 200, height: 50 }]]),
    ),
  )!;
  const pasted = pasteLayers(destination(), copied, options);
  expect(pasted.document.nodes[1].box).toEqual({ x: 70, y: 90, width: 200, height: 50 });
});
