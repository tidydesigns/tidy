import { test, expect } from "bun:test";
import {
  blankDesignDocument,
  buildDrawnNode,
  designNodeChangesSchema,
  parseDesignDocument,
} from "./document";
import { intrinsicSize, placeAssets, replaceImageAsset } from "./asset-placement";
import { initialImageCrop, panImageCrop, resizeImageCrop } from "./image-crop";
import { imageViewport } from "./image-viewport";
import { diffDocument, applyDocumentPatch, invertPatch } from "./document-patch";
import { editLayers } from "./edit-document";
import { mergeImport } from "./merge-import";
import { rotatePoint } from "./resize-box";
const asset = "00000000-0000-4000-8000-000000000001",
  other = "00000000-0000-4000-8000-000000000002";
const target = { pageId: "page-1", parentId: "frame", x: 20, y: 40 };
function fixture() {
  return parseDesignDocument({
    ...blankDesignDocument(),
    nodes: [
      buildDrawnNode("frame", "artboard", null, { x: 0, y: 0, width: 600, height: 500 }),
      {
        ...buildDrawnNode("photo", "container", "frame", { x: 10, y: 20, width: 260, height: 220 }),
        type: "image",
        assetId: asset,
      },
    ],
  });
}
test("intrinsic placement keeps aspect ratio, batches one undo and preserves intervening edits", () => {
  expect(intrinsicSize(640, 360)).toEqual({ width: 640, height: 360 });
  expect(intrinsicSize(10000, 2000)).toEqual({ width: 5000, height: 1000 });
  expect(() => intrinsicSize(0, 20)).toThrow();
  const before = editLayers(fixture(), ["photo"], { name: "Later edit" });
  const after = placeAssets(
    before,
    target,
    [
      { id: asset, name: "First", width: 96, height: 64 },
      { id: other, name: "Second", width: 300, height: 180 },
    ],
    ["first", "second"],
  );
  expect(after.nodes[2].aspectRatioLocked).toBe(true);
  expect(after.nodes[3].aspectRatioLocked).toBe(true);
  expect(after.nodes[1].name).toBe("Later edit");
  expect(after.nodes[2].box).toEqual({ x: 20, y: 40, width: 96, height: 64 });
  expect(after.nodes[3].box).toEqual({ x: 44, y: 64, width: 300, height: 180 });
  expect(applyDocumentPatch(after, invertPatch(diffDocument(before, after)), true)).toEqual(before);
  expect(parseDesignDocument(JSON.parse(JSON.stringify(after)))).toEqual(after);
});
test("delayed placement rejects removed/moved/locked destinations and stale replacement assets", () => {
  const document = fixture();
  document.nodes[0].locked = true;
  expect(() =>
    placeAssets(document, target, [{ id: asset, name: "A", width: 10, height: 10 }], ["new"]),
  ).toThrow("Unlock");
  expect(() => placeAssets(fixture(), { ...target, pageId: "missing" }, [], [])).toThrow("page");
  expect(() =>
    replaceImageAsset(fixture(), "photo", other, { id: asset, name: "A", width: 10, height: 10 }),
  ).toThrow("while the upload");
});
test("replacement preserves latest placement/styles, clears source crop and supports MCP asset edits", () => {
  const before = fixture();
  before.nodes[1].style = {
    rotation: 35,
    flipX: true,
    objectScale: 2,
    imageCrop: initialImageCrop(before.nodes[1], before.nodes[1].box, 800, 400),
  };
  const fresh = editLayers(before, ["photo"], { box: { x: 99 }, style: { radius: 12 } });
  const after = replaceImageAsset(fresh, "photo", asset, {
    id: other,
    name: "New",
    width: 1000,
    height: 1000,
  });
  expect(after.nodes[1]).toMatchObject({
    box: { x: 99 },
    style: { radius: 12, rotation: 35, flipX: true, objectScale: 1 },
    assetId: other,
  });
  expect(after.nodes[1].style.imageCrop).toBeUndefined();
  expect(applyDocumentPatch(after, invertPatch(diffDocument(fresh, after)), true)).toEqual(fresh);
  const mcp = editLayers(before, ["photo"], designNodeChangesSchema.parse({ assetId: other }));
  expect(mcp.nodes[1].style.imageCrop).toBeUndefined();
  const explicit = editLayers(before, ["photo"], {
    assetId: other,
    style: {
      imageCrop: { x: 0, y: 0, width: 1, height: 1, sourceWidth: 1000, sourceHeight: 1000 },
    },
  });
  expect(explicit.nodes[1].style.imageCrop!.sourceWidth).toBe(1000);
  const raw = diffDocument(before, {
    ...before,
    nodes: before.nodes.map((node) => (node.id === "photo" ? { ...node, assetId: other } : node)),
  });
  expect(applyDocumentPatch(before, raw).nodes[1].style.imageCrop).toBeUndefined();
  const fullStyle = [
    ...raw,
    {
      collection: "nodes" as const,
      id: "photo",
      path: ["style"],
      before: { exists: true, value: before.nodes[1].style },
      after: { exists: true, value: explicit.nodes[1].style },
    },
  ];
  expect(applyDocumentPatch(before, fullStyle).nodes[1].style.imageCrop!.sourceWidth).toBe(1000);
});
test("content/fill crop viewports account for asymmetric borders and padding", () => {
  const node = fixture().nodes[1];
  node.padding = 10;
  node.paddingLeft = 30;
  node.style = { borderWidth: 5, borderRightWidth: 15 };
  expect(imageViewport(node)).toEqual({ x: 45, y: 35, width: 200, height: 190 });
  expect(imageViewport(node, node.box, true)).toEqual({ x: 15, y: 25, width: 240, height: 210 });
  const crop = initialImageCrop(node, node.box, 800, 400);
  expect(crop.width / crop.height).toBeCloseTo(200 / 190 / 2);
  expect(panImageCrop(crop, imageViewport(node), { x: 20, y: 0 }).x).toBeCloseTo(
    crop.x - crop.width / 10,
  );
  const fill = initialImageCrop(node, node.box, 800, 400, true);
  expect(fill.width / fill.height).toBeCloseTo(240 / 210 / 2);
});
test("crop resizing holds source scale and opposite edge with rotation/flips and insets", () => {
  for (const rotation of [0, 35, 90])
    for (const flipX of [false, true])
      for (const flipY of [false, true]) {
        const node = fixture().nodes[1];
        node.padding = 10;
        node.style = { borderWidth: 5, rotation, flipX, flipY };
        node.style.imageCrop = initialImageCrop(node, node.box, 800, 400);
        const delta = rotatePoint({ x: (flipX ? -1 : 1) * 25, y: 0 }, rotation);
        const after = {
          ...node.box,
          x: node.box.x + node.box.width / 2 + delta.x - 210 / 2,
          y: node.box.y + node.box.height / 2 + delta.y - node.box.height / 2,
          width: 210,
        };
        const resized = resizeImageCrop(node, node.box, after);
        expect(imageViewport(node, resized.box).width / resized.crop.width).toBeCloseTo(
          imageViewport(node).width / node.style.imageCrop.width,
        );
        expect(resized.crop.x + resized.crop.width).toBeCloseTo(
          node.style.imageCrop.x + node.style.imageCrop.width,
        );
      }
});
test("reimport resets absent source crops and deliberately keeps authored replacement crops", () => {
  const before = fixture();
  before.source = { project: "test", route: "/" };
  before.nodes = before.nodes.map((node) => ({ ...node, importKey: "test:/", sourceKey: node.id }));
  before.nodes[1].style.imageCrop = initialImageCrop(
    before.nodes[1],
    before.nodes[1].box,
    800,
    400,
  );
  const incoming = structuredClone(before);
  incoming.nodes[1].assetId = other;
  delete incoming.nodes[1].style.imageCrop;
  expect(
    mergeImport(before, incoming, "import", "use_import").nodes[1].style.imageCrop,
  ).toBeUndefined();
  incoming.nodes[1].style.imageCrop = {
    x: 0,
    y: 0,
    width: 0.5,
    height: 1,
    sourceWidth: 900,
    sourceHeight: 900,
  };
  expect(
    mergeImport(before, incoming, "import", "use_import").nodes[1].style.imageCrop!.sourceWidth,
  ).toBe(900);
});

test("placement and replacement retain image MIME metadata through patches and undo", () => {
  const before = fixture();
  const after = placeAssets(
    before,
    target,
    [{ id: other, name: "PNG", width: 20, height: 20, mimeType: "image/png" }],
    ["placed"],
  );
  expect(after.assetMimeTypes?.[other]).toBe("image/png");
  const patch = diffDocument(before, after);
  expect(applyDocumentPatch(before, patch).assetMimeTypes?.[other]).toBe("image/png");
  expect(applyDocumentPatch(after, invertPatch(patch), true)).toEqual(before);
  const replaced = replaceImageAsset(before, "photo", asset, {
    id: other,
    name: "WebP",
    width: 20,
    height: 20,
    mimeType: "image/webp",
  });
  expect(replaced.assetMimeTypes?.[other]).toBe("image/webp");
});
