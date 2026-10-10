import { expect, test } from "bun:test";
import { blankDesignDocument, buildDrawnNode, type DesignNode } from "./document";
import { cornerRadiusChanges, renderedRadii } from "./corner-radius";
import { editLayers, previewLayerChanges } from "./edit-document";
import { resolvedDocumentNodes } from "./design-tokens";

const size = { width: 260, height: 280 };
const image: DesignNode = {
  ...buildDrawnNode("image", "container", null, { x: 40, y: 60, ...size }),
  type: "image",
  assetId: "00000000-0000-4000-8000-000000000046",
  style: {
    rotation: 12,
    flipX: true,
    radiusTopLeft: 90,
    radiusTopRight: 10,
    radiusBottomRight: 30,
    radiusBottomLeft: 0,
    imageCrop: { x: 0.15, y: 0.1, width: 0.65, height: 0.8, sourceWidth: 400, sourceHeight: 200 },
  },
};

test("linked radius replaces unequal corners without changing the image or its geometry", () => {
  const document = { ...blankDesignDocument(), nodes: [image] };
  const [result] = editLayers(
    document,
    [image.id],
    cornerRadiusChanges(image, size, 0, 60, false),
  ).nodes;
  expect(result.box).toEqual(image.box);
  expect(result.assetId).toBe(image.assetId);
  expect(result.style).toMatchObject({
    imageCrop: image.style.imageCrop,
    rotation: 12,
    flipX: true,
  });
  expect(renderedRadii(result, size)).toEqual([60, 60, 60, 60]);
});

test("single-corner preview and commit detach only that corner's token binding", () => {
  const source = { ...image, style: {}, tokenBindings: { radius: "pill", radiusTopLeft: "pill" } };
  const document = {
    ...blankDesignDocument(),
    designTokens: { pill: { type: "radius" as const, value: 5000 } },
    nodes: [source],
  };
  const [resolved] = resolvedDocumentNodes(document);
  const patch = cornerRadiusChanges(resolved, size, 0, 45, true);
  const committed = editLayers(document, [source.id], patch);
  expect(previewLayerChanges(document, [source.id], patch)).toEqual(committed);
  expect(committed.nodes[0].tokenBindings).toEqual({ radius: "pill", radiusTopLeft: null });
  expect(renderedRadii(resolvedDocumentNodes(committed)[0], size)[0]).toBeCloseTo(45);
});

test("oversized radii decrease from their visible size, with independent edits in every corner", () => {
  const source = { ...image, style: { radius: 5000 } };
  expect(renderedRadii(source, size)).toEqual([130, 130, 130, 130]);
  expect(cornerRadiusChanges(source, size, 0, 120, false).style?.radius).toBe(120);
  for (const corner of [0, 1, 2, 3] as const) {
    const patch = cornerRadiusChanges(source, size, corner, 30, true);
    const actual = renderedRadii({ ...source, style: { ...source.style, ...patch.style } }, size);
    expect(actual[corner]).toBeCloseTo(30);
    expect(Object.keys(patch.style!)).toHaveLength(1);
  }
});

test("radius limits handle zero, fractions, and a single fully rounded corner", () => {
  expect(cornerRadiusChanges(image, size, 0, -50, false).style?.radius).toBe(0);
  expect(cornerRadiusChanges(image, size, 0, 9000, false).style?.radius).toBe(130);
  expect(cornerRadiusChanges(image, size, 0, 12.25, false).style?.radius).toBe(12.25);
  const square = { width: 100, height: 100 };
  const sharp = { ...image, style: {} };
  expect(cornerRadiusChanges(sharp, square, 0, 9000, true).style?.radiusTopLeft).toBe(100);
  expect(cornerRadiusChanges(sharp, square, 0, 0, true).style?.radiusTopLeft).toBe(0);
});
