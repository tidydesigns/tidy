import { test, expect } from "bun:test";
import {
  initialImageCrop,
  loadedImageSize,
  panImageCrop,
  resizeImageCrop,
  zoomImageCrop,
} from "./image-crop";
import {
  buildDrawnNode,
  designNodeChangesSchema,
  parseDesignDocument,
  blankDesignDocument,
} from "./document";
import { copyProperties, pasteProperties, readDesignClipboard } from "./clipboard";
import { resizeBox } from "./resize-box";
const box = { x: 10, y: 20, width: 200, height: 200 };
const node = () => ({
  ...buildDrawnNode("photo", "container", null, box),
  type: "image",
  assetId: "00000000-0000-4000-8000-000000000001",
});
test("cropping waits for decoded asset dimensions instead of loading or failure placeholders", () => {
  const image = { complete: true, naturalWidth: 800, naturalHeight: 400, dataset: {} };
  expect(loadedImageSize(undefined)).toBeUndefined();
  expect(loadedImageSize({ ...image, complete: false })).toBeUndefined();
  expect(loadedImageSize({ ...image, naturalWidth: 0 })).toBeUndefined();
  expect(loadedImageSize({ ...image, naturalHeight: 0 })).toBeUndefined();
  expect(
    loadedImageSize({
      ...image,
      naturalWidth: 300,
      naturalHeight: 150,
      dataset: { imageLoading: "true" },
    }),
  ).toBeUndefined();
  expect(
    loadedImageSize({
      ...image,
      naturalWidth: 64,
      naturalHeight: 64,
      dataset: { imageFailed: "true" },
    }),
  ).toBeUndefined();
  const size = loadedImageSize(image);
  expect(size).toEqual({ width: 800, height: 400 });
  expect(initialImageCrop(node(), box, size.width, size.height)).toMatchObject({
    sourceWidth: 800,
    sourceHeight: 400,
    x: 0.25,
    width: 0.5,
  });
});
test("cover crop captures the visible source and focal point without modifying the asset", () => {
  const crop = initialImageCrop(node(), box, 800, 400);
  expect(crop).toEqual({
    x: 0.25,
    y: 0,
    width: 0.5,
    height: 1,
    sourceWidth: 800,
    sourceHeight: 400,
  });
  expect(
    initialImageCrop({ ...node(), style: { objectPositionX: 100, objectScale: 2 } }, box, 800, 400),
  ).toMatchObject({ x: 0.75, y: 0.25, width: 0.25, height: 0.5 });
});
test("image panning moves source coordinates, clamps boundaries, and retains frame dimensions", () => {
  const crop = initialImageCrop(node(), box, 800, 400);
  expect(panImageCrop(crop, box, { x: 40, y: 70 })).toMatchObject({
    x: 0.15,
    y: 0,
    width: 0.5,
    height: 1,
  });
  expect(panImageCrop(crop, box, { x: -1000, y: -1000 })).toMatchObject({ x: 0.5, y: 0 });
});
test("crop handles preserve image scale and the opposite edge rather than stretching", () => {
  const original = { ...node(), style: { imageCrop: initialImageCrop(node(), box, 800, 400) } };
  const after = resizeImageCrop(original, box, resizeBox(box, "w", { x: 50, y: 0 }));
  expect(after.box).toEqual({ x: 60, y: 20, width: 150, height: 200 });
  expect(after.crop).toMatchObject({ x: 0.375, y: 0, width: 0.375, height: 1 });
  expect(after.box.width / (after.crop.width * 800)).toBeCloseTo(box.width / (0.5 * 800));
  const clamped = resizeImageCrop(original, box, resizeBox(box, "w", { x: -1000, y: 0 }));
  expect(clamped.crop.x).toBe(0);
  expect(clamped.box.x + clamped.box.width).toBe(210);
});
test("rotated and flipped crop handles retain the correct source edge", () => {
  for (const rotation of [0, 90, 35])
    for (const flipX of [false, true]) {
      const original = {
        ...node(),
        style: { rotation, flipX, imageCrop: initialImageCrop(node(), box, 800, 400) },
      };
      const after = resizeImageCrop(
        original,
        box,
        resizeBox(box, "w", { x: 30, y: 10 }, { rotation, flipX }),
      );
      expect(after.crop.x + after.crop.width).toBeCloseTo(0.75);
      expect(after.box.height).toBeCloseTo(200);
      expect(after.crop.width / after.box.width).toBeCloseTo(0.5 / 200);
    }
});
test("crop zoom stays centered where possible and cannot expose outside source bounds", () => {
  const crop = initialImageCrop(node(), box, 800, 400);
  expect(zoomImageCrop(crop, 2)).toMatchObject({ x: 0.375, y: 0.25, width: 0.25, height: 0.5 });
  expect(zoomImageCrop(crop, 0.1)).toEqual(crop);
});
test("strict document and patch schemas accept valid crops and reject outside regions", () => {
  const crop = initialImageCrop(node(), box, 800, 400);
  expect(designNodeChangesSchema.safeParse({ style: { imageCrop: crop } }).success).toBe(true);
  expect(
    designNodeChangesSchema.safeParse({ style: { imageCrop: { ...crop, x: 0.8 } } }).success,
  ).toBe(false);
  expect(
    designNodeChangesSchema.safeParse({ style: { imageCrop: { ...crop, sourceWidth: 0 } } })
      .success,
  ).toBe(false);
  expect(
    parseDesignDocument({
      ...blankDesignDocument(),
      nodes: [{ ...node(), style: { imageCrop: crop } }],
    }).nodes[0].style.imageCrop,
  ).toEqual(crop);
});

test("appearance paste preserves the crop belonging to a different image asset", () => {
  const crop = initialImageCrop(node(), box, 800, 400),
    targetCrop = { ...crop, sourceWidth: 1000 };
  const source = { ...node(), style: { imageCrop: crop, radius: 16 } };
  const target = {
    ...node(),
    id: "other",
    assetId: "00000000-0000-4000-8000-000000000002",
    style: { imageCrop: targetCrop },
  };
  const document = { ...blankDesignDocument(), nodes: [source, target] };
  const payload = readDesignClipboard(copyProperties(source, document, "file"));
  const pasted = pasteProperties(document, payload, ["other"]);
  expect(pasted.nodes[1].style.imageCrop).toEqual(targetCrop);
  expect(pasted.nodes[1].style.radius).toBe(16);
  expect(pasted.nodes[1].assetId).toBe(target.assetId);
});

test("re-entering crop after a regular frame resize captures the currently visible region", () => {
  const image = { ...node(), style: { imageCrop: initialImageCrop(node(), box, 800, 400) } };
  const resized = { ...box, width: 100 };
  expect(initialImageCrop(image, resized, 800, 400)).toMatchObject({
    x: 0.375,
    y: 0,
    width: 0.25,
    height: 1,
  });
});
