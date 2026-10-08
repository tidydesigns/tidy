import { expect, test } from "bun:test";
import { blankDesignDocument, buildDrawnNode } from "./document";
import { visibleCanvasRoots } from "./canvas-culling";
import { applyRevisionChanges } from "./revision-sync";
import { fileVersion, fileVersionAtLeast } from "./file-version";
import { mapConcurrent } from "../map-concurrent";
import { FrameStats } from "../performance/frame-stats";

test("culling retains overflowing trees, rotated bounds and selected descendants", () => {
  const frame = buildDrawnNode("frame", "artboard", null, {
    x: 4000,
    y: 0,
    width: 100,
    height: 100,
  });
  const child = buildDrawnNode("child", "text", "frame", { x: 0, y: 0, width: 40, height: 20 });
  const overflowing = { ...frame, id: "overflow", style: { overflow: "visible" as const } };
  const free = { ...frame, id: "free", type: "container" as const };
  const rotated = {
    ...frame,
    id: "rotated",
    box: { x: 1400, y: 0, width: 100, height: 600 },
    style: { rotation: 90 },
  };
  const view = { x: 0, y: 0, zoom: 1 },
    size = { width: 1200, height: 900 };
  expect(visibleCanvasRoots([frame, child, overflowing, free, rotated], view, size, [])).toEqual([
    "overflow",
    "free",
    "rotated",
  ]);
  expect(visibleCanvasRoots([frame, child], view, size, ["child"])).toEqual(["frame"]);
  expect(visibleCanvasRoots([frame], { x: -4000, y: 0, zoom: 1 }, size, [])).toEqual(["frame"]);
});

test("revision synchronization rejects gaps and folds successive edits once", () => {
  const node = buildDrawnNode("node", "container", null, { x: 0, y: 0, width: 100, height: 100 });
  const before = { revision: 1, content: { ...blankDesignDocument(), nodes: [node] } };
  const patch = (x: number, y: number) => [
    {
      collection: "nodes" as const,
      id: "node",
      path: ["box", "x"],
      before: { exists: true, value: x },
      after: { exists: true, value: y },
    },
  ];
  const next = applyRevisionChanges(before, {
    baseRevision: 1,
    revision: 3,
    patches: [
      { baseRevision: 1, revision: 2, patch: patch(0, 10) },
      { baseRevision: 2, revision: 3, patch: patch(10, 20) },
    ],
  });
  expect(next.content.nodes[0].box.x).toBe(20);
  expect(next.revision).toBe(3);
  expect(before.content.nodes[0].box.x).toBe(0);
  expect(() =>
    applyRevisionChanges(before, {
      baseRevision: 1,
      revision: 3,
      patches: [{ baseRevision: 1, revision: 3, patch: patch(0, 20) }],
    }),
  ).toThrow("gap");
  expect(() => applyRevisionChanges(before, { baseRevision: 0, revision: 2, patches: [] })).toThrow(
    "snapshot",
  );
  expect(applyRevisionChanges(next, { baseRevision: 1, revision: 2, patches: [] })).toBe(next);
});

test("thumbnail version distinguishes same-millisecond document edits", () => {
  const time = "2026-10-03T00:00:00.123Z";
  expect(fileVersion(time, 2)).not.toBe(fileVersion(time, 1));
  expect(fileVersionAtLeast(fileVersion(time, 2), fileVersion(time, 1))).toBe(true);
  expect(fileVersionAtLeast(fileVersion(time, 1), fileVersion(time, 2))).toBe(false);
});

test("bounded concurrency preserves order with out-of-order completion", async () => {
  let active = 0,
    maximum = 0;
  const values = await mapConcurrent([4, 3, 2, 1], 2, async (value) => {
    maximum = Math.max(maximum, ++active);
    await Bun.sleep(value);
    active--;
    return value * 2;
  });
  expect(maximum).toBe(2);
  expect(values).toEqual([8, 6, 4, 2]);
  await expect(mapConcurrent([1], 0, async (value) => value)).rejects.toThrow("positive integer");
});

test("frame telemetry uses a bounded histogram and ignores invalid timings", () => {
  const stats = new FrameStats();
  for (let i = 0; i < 95; i++) stats.add(16.6);
  for (let i = 0; i < 5; i++) stats.add(250);
  stats.add(NaN);
  stats.add(-1);
  expect(stats.frames).toBe(100);
  expect(stats.percentile(0.95)).toBe(17);
  expect(stats.maximum).toBe(250);
  expect(stats.slow).toBe(5);
  expect(stats.bins.length).toBe(201);
});
