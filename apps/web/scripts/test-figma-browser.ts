import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import sharp from "sharp";

const base = process.env.FIGMA_TEST_BASE_URL ?? "http://localhost:3057";
if (!["localhost", "127.0.0.1"].includes(new URL(base).hostname))
  throw new Error("Use a local fixture server.");
const output = process.env.FIGMA_TEST_ARTIFACTS ?? "/tmp/tidy-figma-browser";
await mkdir(output, { recursive: true });
const fixture = (name: string) => new URL(`./fixtures/figma/${name}`, import.meta.url);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1600, height: 1050 },
  permissions: ["clipboard-read", "clipboard-write"],
});
const page = await context.newPage(),
  errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript(() => {
  window.addEventListener("tidy:figma-imported", (event) => {
    (window as Window & { figmaFixtureDocument?: unknown }).figmaFixtureDocument = (
      event as CustomEvent
    ).detail;
  });
});
await page.route("**/api/auth/**", (route) =>
  route.fulfill({ contentType: "application/json", body: "null" }),
);
await page.route("**/__analytics/**", (route) =>
  route.fulfill({ contentType: "application/json", body: "{}" }),
);
async function open() {
  // Leave the editor before clearing storage so its queued edits cannot restore an old draft.
  await page.goto(`${base}/icon.svg`);
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase("tidy-figma-prototype");
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      }),
  );
  await page.goto(`${base}/dev/figma-import`);
  await page.waitForFunction(() => {
    const input = document.querySelector('[aria-label="Import Figma file"]');
    return input && Object.keys(input).some((key) => key.startsWith("__reactProps"));
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
async function paste(html: string) {
  await page.evaluate(async (value) => {
    await navigator.clipboard.write([
      new ClipboardItem({ "text/html": new Blob([value], { type: "text/html" }) }),
    ]);
  }, html);
  await page.keyboard.press("Control+v");
}
async function layerCount(count: number) {
  await page.waitForFunction(
    (expected) => document.querySelectorAll("[data-node-id]").length === expected,
    count,
  );
}
async function collectFrames(action: (page: Page) => Promise<void>) {
  await page.evaluate(() => {
    const intervals: number[] = [];
    let last = performance.now(),
      frame = 0;
    const tick = (time: number) => {
      intervals.push(time - last);
      last = time;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    (window as Window & { stopFigmaFrames?: () => number[] }).stopFigmaFrames = () => {
      cancelAnimationFrame(frame);
      return intervals.slice(1);
    };
  });
  await action(page);
  const intervals = await page.evaluate(() =>
    (window as Window & { stopFigmaFrames?: () => number[] }).stopFigmaFrames!(),
  );
  intervals.sort((a, b) => a - b);
  return { samples: intervals.length, p95Ms: intervals[Math.floor(intervals.length * 0.95)] ?? 0 };
}
try {
  await open();
  await page.getByLabel("Import Figma file").setInputFiles(fixture("circle.fig").pathname);
  await layerCount(2);
  const bounds = await page.locator("[data-node-id]").first().boundingBox();
  assert(bounds);
  const screenshot = await page.screenshot({ clip: bounds, path: join(output, "circle.png") });
  const { data, info } = await sharp(screenshot)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixel = (x: number, y: number) => [
    ...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 3),
  ];
  assert.deepEqual(pixel(5, 5), [237, 237, 237], "Figma frame has its fill and no invented stroke");
  assert.deepEqual(
    pixel(Math.floor(info.width / 2), Math.floor(info.height / 2)),
    [255, 0, 0],
    "Ellipse retains exact source fill",
  );
  await page.reload();
  await layerCount(2);
  console.log("PASS: .fig upload, native hierarchy, source colour pixels and retained local draft");

  await open();
  const html = await readFile(fixture("group.clipboard.html"), "utf8");
  await paste(html);
  await layerCount(4);
  await page.screenshot({ path: join(output, "paste.png") });
  await page.keyboard.press("Control+z");
  await layerCount(0);
  await page.keyboard.press("Control+Shift+z");
  await layerCount(4);
  await page.keyboard.press("Control+z");
  await layerCount(0);
  await paste(html);
  await layerCount(4);
  await page.waitForFunction(async () => {
    const request = indexedDB.open("tidy-figma-prototype", 1);
    return new Promise<boolean>((resolve) => {
      request.onsuccess = () => {
        const db = request.result;
        const read = db.transaction("draft").objectStore("draft").get("current");
        read.onsuccess = () => {
          db.close();
          resolve(read.result?.document?.nodes.length === 4);
        };
      };
    });
  });
  await page.reload();
  await layerCount(4);
  console.log("PASS: real keyboard clipboard paste, escaped HTML, undo, redo and repeated paste");
  await page.getByLabel("Import Figma file").setInputFiles({
    name: "broken.fig",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("broken"),
  });
  await page.getByRole("alert").filter({ hasText: "Figma Design" }).waitFor();
  assert.equal(
    await page.locator("[data-node-id]").count(),
    4,
    "Failed imports retain existing work",
  );
  console.log("PASS: malformed file recovery without destroying canvas content");

  await open();
  await paste(await readFile(fixture("component.clipboard.html"), "utf8"));
  await layerCount(2);
  assert.equal(
    await page.locator("[data-node-id]").count(),
    2,
    "Master stays on its dependency page",
  );
  await page.keyboard.press("Control+z");
  await layerCount(0);
  await page.keyboard.press("Control+Shift+z");
  await layerCount(2);
  console.log(
    "PASS: native component paste preserves child overrides without showing its master on the canvas",
  );

  if (process.env.FIGMA_TEST_FILE) {
    await open();
    const bytes = await readFile(process.env.FIGMA_TEST_FILE);
    const start = performance.now();
    await page.getByLabel("Import Figma file").setInputFiles({
      name: "Design System.fig",
      mimeType: "application/octet-stream",
      buffer: bytes,
    });
    const choice = page.getByRole("dialog", { name: "Choose Figma pages" });
    await choice.waitFor();
    const names = await choice.getByRole("checkbox").allTextContents();
    assert(names.length > 1);
    await choice.getByRole("button", { name: "Import pages", exact: true }).click();
    await page.locator("[data-node-id]").first().waitFor({ timeout: 60_000 });
    const importMs = performance.now() - start;
    const model = await page.evaluate(
      () =>
        (window as Window & { figmaFixtureDocument?: { nodes: unknown[]; pages: unknown[] } })
          .figmaFixtureDocument,
    );
    assert(model);
    assert.equal(model.pages.length, names.length, "Full file preserves every chosen page");
    assert(model.nodes.length > 5000);
    await page.reload();
    await page.locator("[data-node-id]").first().waitFor({ timeout: 60_000 });
    const retained = await page.evaluate(async () => {
      const request = indexedDB.open("tidy-figma-prototype", 1);
      return new Promise<{ nodes: number; images: number }>((resolve) => {
        request.onsuccess = () => {
          const db = request.result,
            tx = db.transaction(["draft", "assets"]);
          const draft = tx.objectStore("draft").get("current"),
            images = tx.objectStore("assets").count();
          tx.oncomplete = () => {
            db.close();
            resolve({ nodes: draft.result.document.nodes.length, images: images.result });
          };
        };
      });
    });
    assert.equal(retained.nodes, model.nodes.length);
    assert(retained.images > 0, "Image bytes survive reload alongside the imported document");

    const fitCount = await page.locator("[data-node-id]").count();
    await page.getByRole("button", { name: /^Zoom \d+%$/ }).click();
    await page.getByRole("menuitem", { name: "Zoom to 100%", exact: false }).click();
    await page.waitForFunction(
      (before) => document.querySelectorAll("[data-node-id]").length < before,
      fitCount,
    );
    const actualCount = await page.locator("[data-node-id]").count();
    const canvasTransform = page.locator(".bg-canvas > div > .absolute.left-0.top-0");
    const beforePan = await canvasTransform.getAttribute("style");
    const pan = await collectFrames(async (page) => {
      await page.getByRole("button", { name: /^Hand/ }).click();
      await page.mouse.move(1000, 500);
      await page.mouse.down();
      await page.mouse.move(1200, 550, { steps: 40 });
      await page.mouse.up();
    });
    assert.notEqual(
      await canvasTransform.getAttribute("style"),
      beforePan,
      "Benchmark must move the viewport rather than select or drag layers",
    );
    await page.screenshot({ path: join(output, "design-system-actual.png") });
    console.log(
      JSON.stringify({
        importMs: Math.round(importMs),
        fitMountedLayers: fitCount,
        actualMountedLayers: actualCount,
        pan,
      }),
    );
    console.log(
      "PASS: supplied design-system page selection, image/vector rendering and overflow-aware culling",
    );
  }
  assert.deepEqual(errors, [], "Browser must have no runtime errors");
} finally {
  await browser.close();
}
