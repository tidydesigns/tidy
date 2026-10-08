import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import sharp from "sharp";
import { blankDesignDocument, buildDrawnNode, parseDesignDocument } from "./document";
import {
  createVectorBoolean,
  createVectorMask,
  releaseVectorComposite,
} from "./vector-composite-operations";
import { booleanRenderNode, vectorBooleanPath } from "@bella/design/vector-boolean";
import { vectorMaskSvg, vectorCompositeStyle } from "@tidy/design-renderer/vector-composites";
import { vectorImageStyle, vectorSvg } from "./vector-path";
import { editLayers } from "./edit-document";
import { diffDocument, applyDocumentPatch, invertPatch } from "./document-patch";
import { duplicateNodeTree } from "./duplicate-node";
import { copyLayers, pasteLayers, readDesignClipboard } from "./clipboard";
import { createComponentInstance, makeComponent, removeLayers } from "./document-operations";
import { DocumentPreview } from "@/app/files/thumbnail-renderer";
import { DesignSnapshot } from "@/components/github/design-snapshot";
import { TidyDesign } from "./code-runtime";

const assetId = "00000000-0000-4000-8000-000000000033";
const path = (id, x = 0, d = "M0 0H100V100H0Z") => ({
  ...buildDrawnNode(id, "container", "frame", { x, y: 0, width: 100, height: 100 }),
  type: "vector",
  assetId,
  positionMode: "absolute",
  style: {
    paints: [{ id: "fill", type: "solid", color: "#ff6600", opacity: 1, visible: true }],
    strokePaints: [],
  },
  vectorPath: { d, viewBox: { x: 0, y: 0, width: 100, height: 100 }, fillRule: "nonzero" },
});
const document = () =>
  parseDesignDocument({
    ...blankDesignDocument(),
    nodes: [
      {
        ...buildDrawnNode("frame", "artboard", null, { x: 0, y: 0, width: 300, height: 200 }),
        style: {},
      },
      path("a"),
      path("b", 50),
    ],
  });
const raster = async (svg) => {
  const { data, info } = await sharp(Buffer.from(svg))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    info,
    at: (x, y) => [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4)],
  };
};

test("boolean operations have distinct filled areas and preserve their editable operands", async () => {
  const expected = {
    union: [255, 255, 255],
    subtract: [255, 0, 0],
    intersect: [0, 255, 0],
    exclude: [255, 0, 255],
  };
  for (const operation of Object.keys(expected)) {
    const original = document(),
      combined = createVectorBoolean(original, ["a", "b"], operation, "result");
    const result = combined.nodes.find((n) => n.id === "result"),
      rendered = booleanRenderNode(result, combined.nodes);
    const image = await raster(vectorSvg(rendered, {}));
    expect([image.at(25, 50)[3], image.at(75, 50)[3], image.at(125, 50)[3]]).toEqual(
      expected[operation],
    );
    expect(combined.nodes.find((n) => n.id === "a").vectorPath).toEqual(
      original.nodes.find((n) => n.id === "a").vectorPath,
    );
    expect(combined.nodes.find((n) => n.id === "b").style).toEqual(
      original.nodes.find((n) => n.id === "b").style,
    );
    expect(
      vectorCompositeStyle(
        combined.nodes.find((n) => n.id === "a"),
        combined.nodes,
        {},
      ),
    ).toMatchObject({ opacity: 0, pointerEvents: "none" });
    const patch = diffDocument(original, combined);
    expect(applyDocumentPatch(combined, invertPatch(patch))).toEqual(original);
    const released = releaseVectorComposite(combined, "result");
    expect(released.nodes.find((n) => n.id === "result").vectorBoolean).toBeUndefined();
    expect(released.nodes.filter((n) => n.parentId === "result")).toHaveLength(2);
  }
});

test("nested booleans retain curves, apply rotations/flips, and update after operand edits", async () => {
  const original = document();
  original.nodes[1] = path("a", 10, "M100 50 A50 50 0 1 1 0 50 A50 50 0 1 1 100 50Z");
  original.nodes[1].style.rotation = 35;
  original.nodes[1].style.flipX = true;
  let combined = createVectorBoolean(original, ["a", "b"], "union", "inner");
  expect(
    vectorBooleanPath(
      combined.nodes.find((n) => n.id === "inner"),
      combined.nodes,
    ),
  ).toMatch(/[cC]/);
  combined = parseDesignDocument({
    ...combined,
    nodes: [
      ...combined.nodes,
      { ...path("c", 80), box: { x: 80, y: 30, width: 100, height: 100 } },
    ],
  });
  combined = createVectorBoolean(combined, ["inner", "c"], "subtract", "outer");
  const outer = combined.nodes.find((n) => n.id === "outer"),
    before = vectorBooleanPath(outer, combined.nodes);
  const changed = editLayers(combined, ["b"], { box: { x: 140 } });
  const after = vectorBooleanPath(
    changed.nodes.find((n) => n.id === "outer"),
    changed.nodes,
  );
  expect(after).not.toBe(before);
  expect(vectorBooleanPath(outer, combined.nodes)).toBe(before);
  expect(
    (await raster(vectorSvg(booleanRenderNode(outer, combined.nodes), {}))).info.width,
  ).toBeGreaterThan(100);
});

test("alpha and luminance masks preserve source paint opacity, gradients and transformed coordinates", async () => {
  let source = document();
  source.nodes[1] = {
    ...path("a"),
    style: {
      opacity: 0.5,
      paints: [{ id: "black", type: "solid", color: "#000000", opacity: 1, visible: true }],
      strokePaints: [],
    },
  };
  const masked = createVectorMask(source, ["a", "b"], "a", "mask"),
    root = masked.nodes.find((n) => n.id === "mask");
  const alpha = await raster(vectorMaskSvg(root, masked.nodes, {}));
  expect(alpha.at(25, 50)[3]).toBeCloseTo(128, -1);
  expect(alpha.at(125, 50)[3]).toBe(0);
  const lumaRoot = { ...root, mask: { ...root.mask, mode: "luminance" } };
  expect((await raster(vectorMaskSvg(lumaRoot, masked.nodes, {}))).at(25, 50)[3]).toBe(0);
  const gradient = editLayers(masked, ["a"], {
    style: {
      opacity: 1,
      paints: [
        {
          id: "gradient",
          type: "linear",
          angle: 90,
          opacity: 1,
          visible: true,
          stops: [
            { id: "black", position: 0, color: "#000000" },
            { id: "white", position: 1, color: "#ffffff" },
          ],
        },
      ],
    },
  });
  const luma = await raster(vectorMaskSvg(lumaRoot, gradient.nodes, {}));
  expect(luma.at(90, 50)[3]).toBeGreaterThan(luma.at(10, 50)[3]);
  const moved = editLayers(gradient, ["a"], {
    box: { x: 50 },
    style: { rotation: 90, flipY: true },
  });
  const transformed = await raster(vectorMaskSvg(root, moved.nodes, {}));
  expect(transformed.at(25, 50)[3]).toBe(0);
  expect(transformed.at(125, 50)[3]).toBe(255);
  expect(
    vectorCompositeStyle({ ...root, mask: { ...root.mask, enabled: false } }, masked.nodes, {}),
  ).toEqual({});
});

test("nested masks compose their source groups and isolate repeated gradient IDs", async () => {
  const source = document();
  const inside = createVectorMask(source, ["a", "b"], "a", "inner");
  const outerSource = {
    ...path("outer-source", 0, "M0 0H50V100H0Z"),
    box: { x: 0, y: 0, width: 100, height: 100 },
  };
  const outer = createVectorMask(
    {
      ...inside,
      nodes: [
        ...inside.nodes,
        outerSource,
        { ...path("target", 0), box: { x: 0, y: 0, width: 200, height: 100 } },
      ],
    },
    ["inner", "outer-source"],
    "outer-source",
    "nested",
  );
  const final = createVectorMask(outer, ["nested", "target"], "nested", "outer");
  const mask = await raster(
    vectorMaskSvg(
      final.nodes.find((n) => n.id === "outer"),
      final.nodes,
      {},
    ),
  );
  // Inner content starts at x=50; the outer-source ends there, so their shared area is empty.
  expect(mask.at(25, 50)[3]).toBe(0);
  expect(mask.at(75, 50)[3]).toBe(0);
  const svg = vectorMaskSvg(
    final.nodes.find((n) => n.id === "outer"),
    final.nodes,
    {},
  );
  const ids = [...svg.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  expect(new Set(ids).size).toBe(ids.length);
});

test("mask IDs remain local through duplicates, clipboard and multiple component instances", () => {
  const masked = createVectorMask(document(), ["a", "b"], "a", "mask");
  let serial = 0;
  const duplicate = duplicateNodeTree(masked, "mask", () => `d${++serial}`);
  const copyRoot = duplicate.nodes.find((n) => n.id === duplicate.rootId);
  expect(duplicate.nodes.find((n) => n.id === copyRoot.mask.sourceId).parentId).toBe(copyRoot.id);
  const pasted = pasteLayers(
    blankDesignDocument(),
    readDesignClipboard(copyLayers(masked, ["mask"], "source")),
    { fileId: "destination", pageId: "page-1", parentId: null, createId: () => `p${++serial}` },
  );
  const pastedRoot = pasted.document.nodes.find((n) => n.id === pasted.ids[0]);
  expect(pasted.document.nodes.find((n) => n.id === pastedRoot.mask.sourceId).parentId).toBe(
    pastedRoot.id,
  );
  const master = makeComponent(masked, "mask"),
    first = createComponentInstance(master, "mask", () => `i${++serial}`),
    second = createComponentInstance(first.document, "mask", () => `i${++serial}`);
  const edited = editLayers(second.document, ["mask"], {
    mask: { sourceId: "b", mode: "luminance", enabled: true },
  });
  for (const id of [first.rootId, second.rootId]) {
    const root = edited.nodes.find((n) => n.id === id);
    expect(edited.nodes.find((n) => n.id === root.mask.sourceId).parentId).toBe(id);
    expect(edited.nodes.find((n) => n.id === root.mask.sourceId).componentSourceId).toBe("b");
  }
  const transported = applyDocumentPatch(second.document, diffDocument(second.document, edited));
  for (const id of [first.rootId, second.rootId]) {
    const root = transported.nodes.find((n) => n.id === id);
    expect(root.instanceOverrides).not.toContain("mask.sourceId");
    expect(transported.nodes.find((n) => n.id === root.mask.sourceId).parentId).toBe(id);
    expect(transported.nodes.find((n) => n.id === root.mask.sourceId).componentSourceId).toBe("b");
  }
  const restored = applyDocumentPatch(
    transported,
    invertPatch(diffDocument(second.document, edited)),
    true,
  );
  for (const id of ["mask", first.rootId, second.rootId])
    expect(restored.nodes.find((n) => n.id === id).mask).toEqual(
      second.document.nodes.find((n) => n.id === id).mask,
    );
  const removed = removeLayers(masked, ["a"]);
  expect(removed.nodes.find((n) => n.id === "mask").mask).toBeUndefined();
});

test("canvas renderer, thumbnails, reviews, runtime and patches share the same boolean SVG and mask CSS", () => {
  const combined = createVectorBoolean(document(), ["a", "b"], "exclude", "result");
  const rendered = booleanRenderNode(
      combined.nodes.find((n) => n.id === "result"),
      combined.nodes,
    ),
    uri = `data:image/svg+xml,${encodeURIComponent(vectorSvg(rendered, {}))}`;
  const surfaces = [
    createElement(DocumentPreview, { content: combined }),
    createElement(DesignSnapshot, {
      content: combined,
      frameId: "frame",
      reviewId: "review",
      selectedNode: null,
      onSelect: () => {},
    }),
    createElement(TidyDesign, { document: combined, rootId: "frame", assets: {} }),
  ];
  for (const surface of surfaces) expect(renderToStaticMarkup(surface)).toContain(uri);
  const masked = createVectorMask(document(), ["a", "b"], "a", "mask");
  for (const component of [
    createElement(DocumentPreview, { content: masked }),
    createElement(DesignSnapshot, {
      content: masked,
      frameId: "frame",
      reviewId: "review",
      selectedNode: null,
      onSelect: () => {},
    }),
    createElement(TidyDesign, { document: masked, rootId: "frame", assets: {} }),
  ])
    expect(renderToStaticMarkup(component)).toContain("mask-image:");
  const changed = editLayers(combined, ["result"], { vectorBoolean: "intersect" }),
    patch = diffDocument(combined, changed);
  expect(applyDocumentPatch(combined, patch)).toEqual(changed);
  expect(applyDocumentPatch(changed, invertPatch(patch))).toEqual(combined);
  expect(() => createVectorBoolean(document(), ["a", "frame"], "union", "bad")).toThrow();
  expect(() =>
    parseDesignDocument({
      ...masked,
      nodes: masked.nodes.map((n) =>
        n.id === "mask" ? { ...n, mask: { ...n.mask, sourceId: "frame" } } : n,
      ),
    }),
  ).toThrow("Masks require");
});

test("edited operands and mask sources remain visible beyond the original group bounds", async () => {
  const original = createVectorBoolean(document(), ["a", "b"], "union", "result");
  const moved = editLayers(original, ["b"], { box: { x: 140 } });
  const root = moved.nodes.find((n) => n.id === "result");
  const rendered = booleanRenderNode(root, moved.nodes);
  const pixels = await raster(vectorSvg(rendered, {}));
  expect(root.box.width).toBe(150);
  expect(pixels.info.width).toBe(240);
  expect(pixels.at(220, 50)[3]).toBe(255);
  expect(vectorImageStyle(rendered).width).toBe("160%");
  const masked = createVectorMask(document(), ["a", "b"], "a", "mask");
  const edited = editLayers(masked, ["a", "b"], { box: { x: 200 } });
  const mask = edited.nodes.find((n) => n.id === "mask");
  const image = await raster(vectorMaskSvg(mask, edited.nodes, {}));
  expect(image.info.width).toBe(300);
  expect(image.at(225, 50)[3]).toBe(255);
  expect(vectorCompositeStyle(mask, edited.nodes, {})).toMatchObject({
    maskSize: "300px 100px",
    maskClip: "no-clip",
  });
});
