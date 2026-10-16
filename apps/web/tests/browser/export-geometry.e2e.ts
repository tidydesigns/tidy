import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { test, expect } from "./fixtures";

test("export geometry preserves painted bounds and refreshes between exports", async ({
  page,
}, testInfo) => {
  const bundle = execFileSync(
    "bun",
    [
      "build",
      "tests/browser/export-geometry.fixture.ts",
      "--target",
      "browser",
      "--format",
      "iife",
    ],
    {
      cwd: resolve(testInfo.project.testDir, "../.."),
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  await page.setContent("<!doctype html><html><body></body></html>");
  await page.addScriptTag({ content: bundle });
  const result = await page.evaluate(() => {
    const result = window.exportGeometryFixture.regression();
    const inspect = (markup: string) => {
      const root = new DOMParser().parseFromString(markup, "text/html").body
        .firstElementChild as HTMLElement;
      const text = root.querySelector<HTMLElement>("[data-design-text]");
      return {
        matrix: root.dataset.exportMatrix!.split(" ").map(Number),
        size: [root.dataset.exportWidth, root.dataset.exportHeight],
        controls: root.querySelectorAll("button, textarea, [data-stroke-measure]").length,
        ids: [...root.querySelectorAll<HTMLElement>("[data-node-id]")].map(
          (node) => node.dataset.nodeId,
        ),
        text: text && {
          content: text.textContent,
          family: text.style.fontFamily,
          size: text.style.fontSize,
          weight: text.style.fontWeight,
          lineHeight: text.style.lineHeight,
        },
      };
    };
    return {
      before: { bounds: result.before.bounds, clone: inspect(result.before.clones[0]) },
      after: { bounds: result.after.bounds, clone: inspect(result.after.clones[0]) },
      individualBounds: result.individualBounds,
      combined: { bounds: result.combined.bounds, clones: result.combined.clones.map(inspect) },
      batchBounds: result.batchBounds,
    };
  });
  expect(result.before.bounds).toEqual({ x: 86, y: 34, width: 329, height: 281 });
  expect(result.after.bounds).toEqual({ x: 43, y: 227, width: 328, height: 373 });
  expect(result.individualBounds).toEqual({
    shadow: { x: 86, y: 202, width: 136, height: 113 },
    clipped: { x: 278, y: 181, width: 87, height: 69 },
    path: { x: 168, y: 34, width: 114, height: 102 },
    boolean: { x: 116, y: 122, width: 117, height: 99 },
  });
  expect(result.before.clone.size).toEqual(["260", "180"]);
  expect(result.after.clone.size).toEqual(["310", "180"]);
  const matrices = [
    [
      -0.994522337957, 0.104528121095, 0.104528121095, 0.994522337957, 291.13308937929,
      39.868560026337,
    ],
    [
      -0.587785196557, -0.809016773267, 0.809016773267, -0.587785196557, 182.33429925661,
      369.960018183289,
    ],
  ];
  for (const [index, snapshot] of [result.before, result.after].entries()) {
    expect(snapshot.clone.controls).toBe(0);
    expect(snapshot.clone.ids).toEqual([
      "text",
      "shadow",
      "clipped",
      "clipped-child",
      "transparent",
      "hidden",
      "path",
      "boolean",
      "boolean-left",
      "boolean-right",
    ]);
    expect(snapshot.clone.text).toEqual({
      content: "Wrapped export text\nwith inherited fonts",
      family: "Arial",
      size: "18px",
      weight: "600",
      lineHeight: "24px",
    });
    for (const [component, expected] of matrices[index].entries())
      expect(snapshot.clone.matrix[component]).toBeCloseTo(expected, 9);
  }
  expect(result.combined.bounds).toEqual({ x: 168, y: 34, width: 247, height: 140 });
  expect(result.combined.clones.map((clone) => clone.size)).toEqual([
    ["130", "54"],
    ["80", "60"],
  ]);
  expect(result.batchBounds).toEqual([
    { x: 279, y: 105, width: 136, height: 69 },
    { x: 168, y: 34, width: 114, height: 102 },
  ]);

  const benchmark = await page.evaluate(() => window.exportGeometryFixture.benchmark(5000, 3));
  expect(benchmark.bounds).toEqual({ x: 0, y: 0, width: 1000, height: 800 });
  // Assert a deterministic amount of DOM measurement work, avoiding CI timing thresholds.
  expect(benchmark.styleReadsPerSample).toBeLessThanOrEqual(benchmark.count * 2);
  const median = [...benchmark.durations].sort((a, b) => a - b)[1];
  console.log(
    `Export bounds, clone and serialization (${benchmark.count} nodes): ${median.toFixed(1)}ms median; ${benchmark.styleReadsPerSample} computed-style reads.`,
  );
});
