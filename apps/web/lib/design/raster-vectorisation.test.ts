import { expect, test } from "bun:test";
import { blankDesignDocument, buildDrawnNode, parseDesignDocument } from "./document";
import {
  applyRasterTrace,
  vectorisationSource,
  vectorisationUnavailable,
} from "./raster-vectorisation";
import { traceRaster } from "./raster-trace";
import { diffDocument, applyDocumentPatch } from "./document-patch";

const assetId = "00000000-0000-4000-8000-000000000071";
const document = () =>
  parseDesignDocument({
    ...blankDesignDocument(),
    assetMimeTypes: { [assetId]: "image/png" },
    nodes: [
      {
        ...buildDrawnNode("logo", "container", null, { x: 12, y: 20, width: 200, height: 100 }),
        type: "image",
        assetId,
        style: { objectFit: "contain", rotation: 15, opacity: 0.7 },
      },
    ],
  });
const trace = () =>
  traceRaster(
    {
      width: 16,
      height: 16,
      data: new Uint8ClampedArray(Array.from({ length: 256 }, () => [255, 0, 0, 255]).flat()),
    },
    8,
  );
test("conversion preserves identity, location and outer style; paths are asset independent", () => {
  const before = document();
  const after = applyRasterTrace(before, "logo", vectorisationSource(before.nodes[0]), trace());
  const root = after.nodes[0];
  expect(root.id).toBe("logo");
  expect(root.type).toBe("container");
  expect(root.box).toEqual(before.nodes[0].box);
  expect(root.style.rotation).toBe(15);
  expect(root.style.opacity).toBe(0.7);
  expect(root.assetId).toBeUndefined();
  expect(after.nodes[1].parentId).toBe("logo");
  expect(after.nodes[1].vectorPath?.contours?.length).toBeGreaterThan(0);
  expect(after.nodes[1].assetId).toBeUndefined();
  expect(after.nodes[1].horizontalConstraint).toBe("scale");
  const patch = diffDocument(before, after);
  const committed = applyDocumentPatch(before, patch);
  expect(committed.nodes[0].type).toBe("container");
  expect(committed.nodes[0].assetId).toBeUndefined();
  expect(JSON.stringify(committed.nodes[1].vectorPath)).toBe(
    JSON.stringify(after.nodes[1].vectorPath),
  );
  const restored = applyDocumentPatch(committed, diffDocument(after, before));
  expect(restored.nodes.length).toBe(1);
  expect(restored.nodes[0].assetId).toBe(assetId);
  expect(restored.nodes[0].type).toBe("image");
  expect(restored.nodes[0].box).toEqual(before.nodes[0].box);
  expect(restored.nodes[0].style.objectFit).toBe("contain");
  expect(restored.nodes[0].style.rotation).toBe(15);
});
test("latest moves, renames and unrelated edits survive completion", () => {
  const before = document(),
    expected = vectorisationSource(before.nodes[0]);
  const current = document();
  current.nodes[0].name = "Renamed logo";
  current.nodes[0].box.x = 90;
  current.nodes.push(
    buildDrawnNode("unrelated", "text", null, { x: 2, y: 2, width: 30, height: 30 }),
  );
  const after = applyRasterTrace(current, "logo", expected, trace());
  expect(after.nodes[0].name).toBe("Renamed logo");
  expect(after.nodes[0].box.x).toBe(90);
  expect(after.nodes.at(-1)?.id).toBe("unrelated");
});
test("changed assets, crop, bounds, locks and deletion reject stale conversion", () => {
  const before = document(),
    expected = vectorisationSource(before.nodes[0]);
  for (const mutate of [
    (d: ReturnType<typeof document>) => {
      d.nodes[0].assetId = crypto.randomUUID();
    },
    (d: ReturnType<typeof document>) => {
      d.nodes[0].box.width = 300;
    },
    (d: ReturnType<typeof document>) => {
      d.nodes[0].style.objectFit = "cover";
    },
    (d: ReturnType<typeof document>) => {
      d.nodes[0].locked = true;
    },
    (d: ReturnType<typeof document>) => {
      d.nodes = [];
    },
  ]) {
    const current = document();
    mutate(current);
    expect(() => applyRasterTrace(current, "logo", expected, trace())).toThrow();
  }
});
test("component ancestry, SVGs and reusable styles are explicitly unsupported", () => {
  for (const patch of [{ isComponent: true }, { styleId: "shared" }, { instanceOf: "master" }]) {
    const current = document();
    Object.assign(current.nodes[0], patch);
    expect(vectorisationUnavailable(current, current.nodes[0])).toBeDefined();
  }
  const current = document();
  current.assetMimeTypes![assetId] = "image/svg+xml";
  expect(vectorisationUnavailable(current, current.nodes[0])).toContain("SVG");
});

test("each shape gets its own movable bounds without changing its rendered position", () => {
  const input = { width: 32, height: 32, data: new Uint8ClampedArray(32 * 32 * 4) };
  for (let y = 8; y < 24; y++)
    for (let x = 4; x < 20; x++) input.data.set([255, 0, 0, 255], (y * 32 + x) * 4);
  const traced = traceRaster(input, 8);
  const before = document();
  const after = applyRasterTrace(before, "logo", vectorisationSource(before.nodes[0]), traced);
  const shape = after.nodes[1],
    bounds = shape.vectorPath!.viewBox;
  expect(shape.name).toBe("Rectangle");
  expect(shape.box.width).toBeLessThan(before.nodes[0].box.width);
  expect(shape.box.height).toBeLessThan(before.nodes[0].box.height);
  expect(shape.box.x).toBeCloseTo((bounds.x * 200) / 32);
  expect(shape.box.y).toBeCloseTo((bounds.y * 100) / 32);
  expect(shape.box.width).toBeCloseTo((bounds.width * 200) / 32);
});
