import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import type { Page } from "playwright";
import { test, required, expect } from "./fixtures";
import { measureRasterTrace } from "../../lib/design/vectorisation/quality";
import { parsePathContours } from "@tidy/design/vector-geometry";
import {
  generalRasterFixtures,
  gradientRasterFixtures,
  rasterShapeFixtures,
  rasterShapeSvg,
} from "../../lib/design/vectorisation/fixtures";
const artwork =
  '<svg xmlns="http://www.w3.org/2000/svg" width="624" height="380"><path fill="#e43d30" fill-rule="evenodd" d="M60 40H340V330H60ZM140 120V250H260V120Z"/><circle fill="#286ccf" cx="450" cy="190" r="100"/></svg>';
function imageEditor(page: Page) {
  const panel = page.getByRole("dialog", { name: "Image editor" });
  const root = page.locator('[data-node-id="landscape"]:visible').first();
  async function openImage() {
    await page.getByRole("button", { name: "Select Landscape", exact: true }).click();
    await root.locator("[data-adjustable-image]").dblclick({ position: { x: 30, y: 30 } });
    await panel.waitFor();
  }
  return { root, panel, openImage };
}
async function exportSvg(page: Page) {
  const exportSection = page
    .locator("details")
    .filter({ has: page.locator("summary").filter({ hasText: /^Export$/ }) })
    .last();
  if (!(await page.getByRole("button", { name: "svg", exact: true }).isVisible()))
    await exportSection.locator("summary").click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "svg", exact: true }).click();
  return download;
}

for (const format of ["png", "jpeg", "webp"] as const) {
  test(`raster ${format}: conversion, adjustments, history and export`, async ({
    page,
    baseURL,
  }) => {
    const base = baseURL!;
    const { root, panel, openImage } = imageEditor(page);
    const pipeline = sharp(Buffer.from(artwork));
    if (format === "jpeg") pipeline.flatten({ background: "#ffffff" });
    const image = await pipeline[format]().toBuffer();
    await page.route("**/image-editor-test.svg*", (route) =>
      route.fulfill({ body: image, contentType: `image/${format}` }),
    );
    await page.goto(`${base}/dev/import-preview?edit=1&images=1`);
    await page.getByRole("button", { name: "Select Landscape", exact: true }).click();
    const before = await root.screenshot();
    await openImage();
    await panel.getByRole("button", { name: "Vectorise image", exact: true }).click();
    await panel.waitFor({ state: "hidden" });
    const vectors = root.locator("img[data-vector-path]");
    await vectors.first().waitFor();
    await vectors.evaluateAll(async (images) => {
      await Promise.all(images.map((image) => (image as HTMLImageElement).decode()));
    });
    assert.ok((await vectors.count()) >= 2, `${format}: separate coloured vector shapes`);
    const after = await root.screenshot();
    const a = await sharp(before).raw().toBuffer(),
      b = await sharp(after).raw().toBuffer();
    assert.equal(a.length, b.length);
    const difference = a.reduce((sum, value, i) => sum + Math.abs(value - b[i]), 0) / a.length;
    assert.ok(difference < 8, `${format}: mean rendered channel difference ${difference}`);
    const source = await vectors.first().getAttribute("src");
    assert.ok(source && source.startsWith("data:image/svg+xml,"));
    assert.ok(decodeURIComponent(source.split(",").slice(1).join(",")).includes("<path"));
    await page.keyboard.press("ControlOrMeta+z");
    await root.locator("[data-adjustable-image]").waitFor();
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await vectors.first().waitFor();
    console.log(
      `PASS ${format}: editable vector layers, appearance (MAE ${difference.toFixed(3)}), undo/redo`,
    );
    if (format === "png") {
      const downloading = exportSvg(page);
      const download = await downloading;
      const exported = await readFile((await download.path())!, "utf8");

      assert.ok(exported.includes("<path"));
      assert.ok(
        !exported.includes("<image"),
        "Vector export contains native geometry, not a raster",
      );
      const screenshotSize = await sharp(after).metadata();
      const renderedExport = await sharp(Buffer.from(exported))
        .resize(screenshotSize.width, screenshotSize.height)
        .flatten({ background: "#f8f6f1" })
        .raw()
        .toBuffer();
      assert.equal(renderedExport.length, b.length);
      const exportDifference =
        renderedExport.reduce((sum, value, index) => sum + Math.abs(value - b[index]), 0) /
        b.length;
      assert.ok(exportDifference < 3, `Native SVG export difference ${exportDifference}`);
      console.log("PASS native SVG export");
      await page.keyboard.press("ControlOrMeta+z");
      await openImage();
      await panel.getByLabel("Contrast value", { exact: true }).fill("15");
      await panel.getByLabel("Contrast value", { exact: true }).press("Enter");
      await panel.getByRole("button", { name: "Crop", exact: true }).click();
      await page.getByRole("button", { name: "Finish crop", exact: true }).click();
      await page.getByRole("button", { name: "Zoom image in", exact: true }).click();
      const croppedBefore = await root.screenshot();
      await page.getByRole("button", { name: "Edit image", exact: true }).click();
      await panel.getByRole("button", { name: "Vectorise image", exact: true }).click();
      await panel.waitFor({ state: "hidden" });
      await vectors.first().waitFor();
      await vectors.evaluateAll(async (images) => {
        await Promise.all(images.map((image) => (image as HTMLImageElement).decode()));
      });
      const croppedAfter = await root.screenshot();
      const cropOriginal = await sharp(croppedBefore).raw().toBuffer(),
        cropRendered = await sharp(croppedAfter).raw().toBuffer();
      assert.equal(cropOriginal.length, cropRendered.length);
      const difference =
        cropOriginal.reduce((sum, value, i) => sum + Math.abs(value - cropRendered[i]), 0) /
        cropOriginal.length;
      assert.ok(difference < 8, `Cropped adjusted image difference ${difference}`);
      console.log(`PASS crop, zoom and image adjustments (MAE ${difference.toFixed(3)})`);
    }
    await page.unroute("**/image-editor-test.svg*");
  });
}
test("closing and cancelling vectorisation preserves the image", async ({ page, baseURL }) => {
  const base = baseURL!;
  const { root, panel, openImage } = imageEditor(page);
  const image = await sharp(Buffer.from(artwork)).png().toBuffer();
  let fetches = 0;
  await page.route("**/image-editor-test.svg*", async (route) => {
    if (++fetches > 1) await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fulfill({ body: image, contentType: "image/png" }).catch(() => {});
  });
  await page.goto(`${base}/dev/import-preview?edit=1&images=1`);
  await openImage();
  await panel.getByRole("button", { name: "Vectorise image", exact: true }).click();
  await panel.getByRole("button", { name: "Close image editor" }).click();
  await page.waitForTimeout(700);
  assert.equal(await root.locator("img[data-vector-path]").count(), 0);
  assert.equal(await root.locator("[data-adjustable-image]").count(), 1);
  await openImage();
  await panel.getByRole("button", { name: "Vectorise image", exact: true }).click();
  await panel.getByRole("button", { name: "Cancel vectorisation", exact: true }).click();
  await page.waitForTimeout(700);
  assert.equal(await root.locator("img[data-vector-path]").count(), 0);
  assert.equal(
    await panel.getByRole("button", { name: "Vectorise image", exact: true }).count(),
    1,
  );
  console.log("PASS cancellation on close/button and no browser errors");
  await page.unroute("**/image-editor-test.svg*");
});
for (const fixture of rasterShapeFixtures) {
  test(`independent editing: ${fixture.id}`, async ({ page, baseURL }) => {
    const base = baseURL!;
    const { root, panel } = imageEditor(page);
    const bytes = await sharp(Buffer.from(rasterShapeSvg(fixture.body)))
      .png()
      .toBuffer();
    await page.route("**/image-editor-test.svg*", (route) =>
      route.fulfill({ body: bytes, contentType: "image/png" }),
    );
    await page.goto(`${base}/dev/import-preview?edit=1&images=1`);
    await page.getByRole("button", { name: "Select Landscape", exact: true }).click();
    await root.locator("[data-adjustable-image]").evaluate(async (element) => {
      if (element instanceof HTMLImageElement) await element.decode();
    });
    await root.locator("[data-adjustable-image]").dblclick({ position: { x: 30, y: 30 } });
    await panel.getByRole("button", { name: "Vectorise image", exact: true }).click();
    await panel.waitFor({ state: "hidden" });
    const vectors = root.locator("img[data-vector-path]");
    await vectors.first().waitFor();
    await vectors.evaluateAll(async (elements) => {
      await Promise.all(elements.map((element) => (element as HTMLImageElement).decode()));
    });
    const shapes = await vectors.count();
    assert.ok(shapes <= fixture.maxShapes);
    const layers = [];
    for (let i = 0; i < shapes; i++) {
      const vector = vectors.nth(i);
      layers.push({
        name: await vector.getAttribute("alt"),
        box: required(await vector.boundingBox()),
      });
    }
    if (fixture.id === "app-icon") {
      assert.deepEqual(
        layers.map((layer) => layer.name),
        ["Rounded rectangle", "Shape 2", "Ellipse"],
      );
      assert.ok(
        layers[2].box!.width < 32 && layers[2].box!.height < 32,
        "Accent has its own small bounds",
      );
      const leaf = vectors.nth(1);
      await page.getByRole("button", { name: "Select Shape 2", exact: true }).click();
      // Layer controls own their arrow keys; artwork nudges belong to the focused canvas.
      await page.getByRole("region", { name: "Design canvas", exact: true }).focus();
      const before = required(await leaf.boundingBox());
      await page.keyboard.press("ArrowRight");
      const after = required(await leaf.boundingBox());
      assert.ok(after!.x > before!.x, "Leaf moves independently");
      for (let i = 0; i < 19; i++) await page.keyboard.press("ArrowRight");

      for (let i = 0; i < 20; i++) await page.keyboard.press("ControlOrMeta+z");
      await page.getByRole("button", { name: "Edit fill 1", exact: true }).click();
      const fill = page.getByLabel("Fill color", { exact: true }).filter({ visible: true });
      await fill.fill("#ee5b32");
      await fill.press("Tab");
      await page.waitForFunction(() => {
        const images = [
          ...document.querySelectorAll<HTMLImageElement>(
            '[data-node-id="landscape"] img[data-vector-path]',
          ),
        ];
        return images.some((image) => decodeURIComponent(image.src).includes("#ee5b32"));
      });

      await page.getByRole("button", { name: "Select Shape 2", exact: true }).click();
      await page.keyboard.press("ControlOrMeta+z");
      await page.getByRole("button", { name: "Select Ellipse", exact: true }).click();
      await page.getByRole("button", { name: "Edit points", exact: true }).click();
      await page.locator("[data-vector-editor]").waitFor();
      assert.equal(await page.locator('[data-vector-control="anchor"]').count(), 4);

      await page.keyboard.press("Escape");
    }
    await page.unroute("**/image-editor-test.svg*");
    console.log(`PASS ${fixture.id}: ${shapes} independently inspected layers`);
  });
}
const cases = generalRasterFixtures.flatMap((fixture) => [
  { fixture, format: "png" as const },
  ...(["rotated-shapes", "concave-shapes", "close-colours"].includes(fixture.id)
    ? [{ fixture, format: "jpeg" as const }]
    : []),
]);
test("small lettering and subpixel strokes survive conversion and native export", async ({
  page,
  baseURL,
}) => {
  const { root, panel, openImage } = imageEditor(page);
  const png = await sharp(
    Buffer.from(
      rasterShapeSvg(
        '<rect width="624" height="380" fill="white"/><text x="35" y="180" font-family="sans-serif" font-size="115" font-weight="bold" fill="#101827">tidy.</text><text x="40" y="240" font-family="sans-serif" font-size="17" fill="#515b70">Small text — curves, counters &amp; spacing</text><path d="M20 300H600" stroke="#111827" stroke-width=".5"/>',
      ),
    ),
  )
    .png()
    .toBuffer();
  await page.route("**/image-editor-test.svg*", (route) =>
    route.fulfill({ body: png, contentType: "image/png" }),
  );
  await page.goto(`${baseURL}/dev/import-preview?edit=1&images=1`);
  await openImage();
  await panel.getByRole("button", { name: "Vectorise image", exact: true }).click();
  await panel.waitFor({ state: "hidden" });
  await root.locator("img[data-vector-path]").first().waitFor();
  const downloading = exportSvg(page);
  const svg = await readFile((await (await downloading).path())!, "utf8");
  expect(svg).not.toMatch(/<image|foreignObject/);
  const original = await sharp(png).ensureAlpha().raw().toBuffer();
  const rendered = await sharp(Buffer.from(svg)).resize(624, 380).ensureAlpha().raw().toBuffer();
  for (const [top, bottom] of [
    [220, 245],
    [295, 305],
  ]) {
    const ink = (data: Buffer) => {
      let sum = 0;
      for (let y = top; y < bottom; y++)
        for (let x = 20; x < 600; x++)
          for (let k = 0; k < 3; k++) sum += 255 - data[(y * 624 + x) * 4 + k];
      return sum;
    };
    expect(ink(rendered)).toBeGreaterThan(ink(original) * 0.6);
    expect(ink(rendered)).toBeLessThan(ink(original) * 1.4);
  }
});

test("cancelling a started worker handles late bootstrap errors exactly once", async ({
  page,
  baseURL,
}) => {
  const { root, panel, openImage } = imageEditor(page);
  const png = await sharp(Buffer.from(rasterShapeSvg(gradientRasterFixtures[1].body)))
    .png()
    .toBuffer();
  await page.route("**/image-editor-test.svg*", (route) =>
    route.fulfill({ body: png, contentType: "image/png" }),
  );
  await page.goto(`${baseURL}/dev/import-preview?edit=1&images=1`);
  await page.evaluate(() => {
    const state = { started: false, terminated: 0, handled: false };
    (window as Window & { traceWorker?: typeof state }).traceWorker = state;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        state.started = true;
      }
      terminate() {
        state.terminated++;
        super.terminate();
        queueMicrotask(() => {
          const error = new ErrorEvent("error", {
            cancelable: true,
            message: "late bootstrap error",
          });
          state.handled = !this.dispatchEvent(error);
        });
      }
    };
  });
  await openImage();
  await panel.getByRole("button", { name: "Vectorise image", exact: true }).click();
  await page.waitForFunction(
    () => (window as Window & { traceWorker?: { started: boolean } }).traceWorker?.started,
  );
  await panel.getByRole("button", { name: "Cancel vectorisation", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as Window & { traceWorker?: { handled: boolean } }).traceWorker?.handled,
      ),
    )
    .toBe(true);
  expect(
    await page.evaluate(
      () => (window as Window & { traceWorker?: { terminated: number } }).traceWorker?.terminated,
    ),
  ).toBe(1);
  await expect(root.locator("[data-adjustable-image]")).toHaveCount(1);
  await expect(root.locator("img[data-vector-path]")).toHaveCount(0);
});

for (const fixture of gradientRasterFixtures) {
  test(`editable gradients and native export: ${fixture.id}`, async ({ page, baseURL }) => {
    const { root, panel, openImage } = imageEditor(page);
    const png = await sharp(Buffer.from(rasterShapeSvg(fixture.body)))
      .png()
      .toBuffer();
    await page.route("**/image-editor-test.svg*", (route) =>
      route.fulfill({ body: png, contentType: "image/png" }),
    );
    await page.goto(`${baseURL}/dev/import-preview?edit=1&images=1`);
    await openImage();
    await panel.getByRole("button", { name: "Vectorise image", exact: true }).click();
    await panel.waitFor({ state: "hidden" });
    const vectors = root.locator("img[data-vector-path]");
    await vectors.first().waitFor();
    expect(await vectors.count()).toBeLessThanOrEqual(fixture.maxShapes);
    const downloading = exportSvg(page);
    const download = await downloading;
    const exported = await readFile((await download.path())!, "utf8");
    expect(exported).not.toMatch(/<image|foreignObject/);
    expect(exported).toContain(fixture.id.includes("radial") ? "radialGradient" : "linearGradient");
    const original = await sharp(png).ensureAlpha().raw().toBuffer();
    const rendered = await sharp(Buffer.from(exported))
      .resize(624, 380)
      .ensureAlpha()
      .raw()
      .toBuffer();
    const quality = measureRasterTrace(
      { width: 624, height: 380, data: new Uint8ClampedArray(original) },
      new Uint8ClampedArray(rendered),
    );
    expect(quality.meanError).toBeLessThan(2);
    expect(quality.alphaError).toBeLessThan(0.6);
    // Exercise the persisted paint after conversion, including radial coordinates
    // rebased to the independently editable shape's bounds.
    if (fixture.maxShapes === 1) {
      const name = await vectors.first().getAttribute("alt");
      await page.getByRole("button", { name: `Select ${name}`, exact: true }).click();
      await page.getByRole("button", { name: "Edit fill 1", exact: true }).click();
      const stop = page.getByLabel("Stop 1 color", { exact: true }).filter({ visible: true });
      await stop.fill("#ff0000");
      await stop.press("Tab");
      await expect.poll(() => vectors.first().getAttribute("src")).toContain("%23ff0000");
      await page.getByRole("button", { name: `Select ${name}`, exact: true }).click();
      await page.keyboard.press("ControlOrMeta+z");
    }
    await page.getByRole("button", { name: "Select Landscape", exact: true }).click();
    await page.keyboard.press("ControlOrMeta+z");
    await root.locator("[data-adjustable-image]").waitFor();
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await vectors.first().waitFor();
    console.log(
      `PASS ${fixture.id}: ${await vectors.count()} shapes, mean error ${quality.meanError.toFixed(3)}`,
    );
  });
}
test("coastal illustration: smooth shading preserves thin highlights and stays editable", async ({
  page,
  baseURL,
}) => {
  const { root, panel, openImage } = imageEditor(page);
  const png = await sharp(await readFile("public/image-editor-test.svg"))
    .png()
    .toBuffer();
  await page.route("**/image-editor-test.svg*", (route) =>
    route.fulfill({ body: png, contentType: "image/png" }),
  );
  await page.goto(`${baseURL}/dev/import-preview?edit=1&images=1`);
  await openImage();
  await panel.getByRole("button", { name: "Vectorise image", exact: true }).click();
  await panel.waitFor({ state: "hidden" });
  const vectors = root.locator("img[data-vector-path]");
  await vectors.first().waitFor();
  expect(await vectors.count()).toBeLessThan(48);
  const downloading = exportSvg(page);
  const download = await downloading;
  const exported = await readFile((await download.path())!, "utf8");
  expect(exported).toContain("linearGradient");
  expect(exported).not.toMatch(/<image|foreignObject/);
  const original = await sharp(png)
    .resize(624, 380, { fit: "cover" })
    .ensureAlpha()
    .raw()
    .toBuffer();
  const rendered = await sharp(Buffer.from(exported))
    .resize(624, 380)
    .ensureAlpha()
    .raw()
    .toBuffer();
  const quality = measureRasterTrace(
    { width: 624, height: 380, data: new Uint8ClampedArray(original) },
    new Uint8ClampedArray(rendered),
  );
  expect(quality.meanError).toBeLessThan(2);
  expect(quality.alphaError).toBeLessThan(0.2);
  console.log(
    `PASS coast: ${await vectors.count()} shapes, mean error ${quality.meanError.toFixed(3)}`,
  );
});
for (const { fixture, format } of cases) {
  test(`quality and native export: ${fixture.id} (${format})`, async ({ page, baseURL }) => {
    const base = baseURL!;
    const { root, panel } = imageEditor(page);
    const id = format === "png" ? fixture.id : `${fixture.id}-jpeg`;
    const pipeline = sharp(Buffer.from(rasterShapeSvg(fixture.body)));
    const png =
      format === "png"
        ? await pipeline.png().toBuffer()
        : await pipeline.flatten({ background: "#fff" }).jpeg().toBuffer();
    await page.route("**/image-editor-test.svg*", (route) =>
      route.fulfill({ body: png, contentType: `image/${format}` }),
    );
    await page.goto(`${base}/dev/import-preview?edit=1&images=1`);
    await page.getByRole("button", { name: "Select Landscape", exact: true }).click();
    await root.locator("[data-adjustable-image]").evaluate(async (element) => {
      if (element instanceof HTMLImageElement) await element.decode();
    });
    await root.locator("[data-adjustable-image]").dblclick({ position: { x: 30, y: 30 } });
    await panel.waitFor();
    assert.ok(
      (await panel.getByRole("button", { name: "Vector colours" }).innerText()).includes("Auto"),
    );
    if (fixture.id === "many-colours") {
      await panel.getByRole("button", { name: "Vector colours" }).click();
      await page.getByRole("menuitemradio", { name: "2 colours", exact: true }).click();
      await panel.getByRole("button", { name: "Vectorise image", exact: true }).click();
      await panel.getByRole("alert").waitFor();
      assert.match(await panel.getByRole("alert").innerText(), /loses too much detail/);
      assert.equal(await root.locator("img[data-vector-path]").count(), 0);
      assert.equal(await root.locator("[data-adjustable-image]").count(), 1);

      await panel.getByRole("button", { name: "Vector colours" }).click();
      await page.getByRole("menuitemradio", { name: "Auto colours", exact: true }).click();
    }
    await panel.getByRole("button", { name: "Vectorise image", exact: true }).click();
    await panel.waitFor({ state: "hidden" });
    const vectors = root.locator("img[data-vector-path]");
    await vectors.first().waitFor();
    const geometry = await vectors.evaluateAll(async (elements) => {
      await Promise.all(elements.map((element) => (element as HTMLImageElement).decode()));
      return elements.map((element) => {
        const image = element as HTMLImageElement;
        return {
          name: image.alt,
          svg: decodeURIComponent(image.src.slice(image.src.indexOf(",") + 1)),
        };
      });
    });
    assert.equal(
      geometry.length,
      fixture.expectedShapes + Number(format === "jpeg"),
      `${fixture.id}: coherent independent shapes`,
    );
    if (fixture.id === "rotated-shapes" && format === "png")
      assert.deepEqual(
        geometry.map((p) => p.name).sort(),
        ["Ellipse", "Rectangle", "Rounded rectangle"].sort(),
      );
    if (fixture.id === "linear-gradient") {
      assert.ok(geometry[0].svg.includes("linearGradient"));
      await page.getByRole("button", { name: "Select Ellipse", exact: true }).click();
      await page.getByRole("button", { name: "Edit fill 1", exact: true }).click();
      const stop = page.getByLabel("Stop 1 color", { exact: true }).filter({ visible: true });
      await stop.fill("#ff0000");
      await stop.press("Tab");
      await page.waitForFunction(() =>
        [...document.querySelectorAll<HTMLImageElement>("img[data-vector-path]")].some((image) =>
          decodeURIComponent(image.src).includes("#ff0000"),
        ),
      );

      await page.getByRole("button", { name: "Select Ellipse", exact: true }).click();
      await page.keyboard.press("ControlOrMeta+z");
      await page.getByRole("button", { name: "Select Landscape", exact: true }).click();
    }
    if (fixture.id === "thin-cutout") {
      // Read the generated path as text rather than reparsing page data into a DOM document.
      const path = geometry[0].svg.match(/<path\b[^>]*\sd="([^"]*)"/);
      assert.ok(path, "Generated SVG contains a path");
      assert.equal(parsePathContours(path[1]).length, 3, "Preserves both intentional holes");
    }
    const downloading = exportSvg(page);
    const downloaded = await downloading,
      svg = await readFile((await downloaded.path())!, "utf8");
    assert.ok(!svg.includes("<image") && !svg.includes("foreignObject"));
    await page.keyboard.press("ControlOrMeta+z");
    await root.locator("[data-adjustable-image]").waitFor();
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await vectors.first().waitFor();
    const original = await sharp(png).ensureAlpha().raw().toBuffer();
    const rendered = await sharp(Buffer.from(svg)).resize(624, 380).ensureAlpha().raw().toBuffer();
    const quality = measureRasterTrace(
      { width: 624, height: 380, data: new Uint8ClampedArray(original) },
      new Uint8ClampedArray(rendered),
    );
    assert.ok(quality.meanError < 4, `${id}: verified appearance`);
    await page.unroute("**/image-editor-test.svg*");
    console.log(`PASS ${id}: ${geometry.length} shapes, ${geometry.map((p) => p.name).join(", ")}`);
  });
}

test("small antialiased circles and one-pixel accents retain compact editable geometry", async ({
  page,
  baseURL,
}) => {
  const source =
    '<svg xmlns="http://www.w3.org/2000/svg" width="624" height="380"><rect width="624" height="380" fill="#fff"/><circle cx="100.25" cy="100.5" r="2" fill="#087f68"/><rect x="200" y="100" width="1" height="1" fill="#e02040"/><rect x="300" y="100" width="80" height="80" fill="#087f68"/></svg>';
  const image = await sharp(Buffer.from(source)).png().toBuffer();
  await page.route("**/image-editor-test.svg*", (route) =>
    route.fulfill({ body: image, contentType: "image/png" }),
  );
  await page.goto(`${baseURL}/dev/import-preview?edit=1&images=1`);
  const { root, panel, openImage } = imageEditor(page);
  await openImage();
  await panel.getByRole("button", { name: "Vectorise image", exact: true }).click();
  await panel.waitFor({ state: "hidden" });
  const vectors = root.locator("img[data-vector-path]");
  await expect(vectors).toHaveCount(4);
  const download = await exportSvg(page);
  const exported = await readFile((await download.path())!, "utf8");
  await test.info().attach("small-shapes.svg", { body: exported, contentType: "image/svg+xml" });
  assert.ok(!exported.includes("<image"));
  const rendered = await sharp(Buffer.from(exported)).ensureAlpha().raw().toBuffer();
  const original = await sharp(image).ensureAlpha().raw().toBuffer();
  assert.equal(rendered.length, original.length);
  for (const [left, top, size] of [
    [97, 97, 7],
    [199, 99, 3],
  ]) {
    let difference = 0;
    for (let y = top; y < top + size; y++)
      for (let x = left; x < left + size; x++)
        for (let channel = 0; channel < 4; channel++) {
          const index = (y * 624 + x) * 4 + channel;
          difference += Math.abs(rendered[index] - original[index]);
        }
    assert.ok(
      difference / (size * size * 4) < 2,
      `small shape at ${left},${top} retains its appearance: ${difference / (size * size * 4)}`,
    );
  }
  await page.keyboard.press("ControlOrMeta+z");
  await root.locator("[data-adjustable-image]").waitFor();
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(vectors).toHaveCount(4);
});

test("a malformed worker request preserves the image and allows retry", async ({
  page,
  baseURL,
}) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    let corruptNextRequest = true;
    window.Worker = class extends NativeWorker {
      postMessage(message: unknown, transfer: Transferable[] | StructuredSerializeOptions = {}) {
        if (
          corruptNextRequest &&
          typeof message === "object" &&
          message !== null &&
          "buffer" in message
        ) {
          corruptNextRequest = false;
          message = { ...message, width: NaN };
        }
        if (Array.isArray(transfer)) super.postMessage(message, transfer);
        else super.postMessage(message, transfer);
      }
    };
  });
  const image = await sharp(Buffer.from(artwork)).png().toBuffer();
  await page.route("**/image-editor-test.svg*", (route) =>
    route.fulfill({ body: image, contentType: "image/png" }),
  );
  await page.goto(`${baseURL}/dev/import-preview?edit=1&images=1`);
  const { root, panel, openImage } = imageEditor(page);
  await openImage();
  await panel.getByRole("button", { name: "Vectorise image", exact: true }).click();
  await expect(panel.getByRole("alert")).toHaveText("Invalid vectorisation request.");
  await expect(root.locator("img[data-vector-path]")).toHaveCount(0);
  await expect(root.locator("[data-adjustable-image]")).toBeVisible();
  await panel.getByRole("button", { name: "Vectorise image", exact: true }).click();
  await panel.waitFor({ state: "hidden" });
  await root.locator("img[data-vector-path]").first().waitFor();
});

test("smooth silhouettes export fewer native curve points", async ({ page, baseURL }) => {
  const points = Array.from({ length: 360 }, (_, i) => {
    const angle = (i * Math.PI) / 180,
      radius = 80 + 12 * Math.cos(3 * angle);
    return `${312 + Math.cos(angle) * radius},${190 + Math.sin(angle) * radius}`;
  });
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="624" height="380"><polygon points="${points.join(" ")}" fill="#087f68"/></svg>`;
  const image = await sharp(Buffer.from(source)).png().toBuffer();
  await page.route("**/image-editor-test.svg*", (route) =>
    route.fulfill({ body: image, contentType: "image/png" }),
  );
  await page.goto(`${baseURL}/dev/import-preview?edit=1&images=1`);
  const { root, panel, openImage } = imageEditor(page);
  await openImage();
  await panel.getByRole("button", { name: "Vectorise image", exact: true }).click();
  await panel.waitFor({ state: "hidden" });
  const vectors = root.locator("img[data-vector-path]");
  await expect(vectors).toHaveCount(1);
  const download = await exportSvg(page);
  const svg = await readFile((await download.path())!, "utf8");
  expect(svg).not.toMatch(/<image|foreignObject/);
  const data = await vectors.first().getAttribute("src");
  assert.ok(data);
  const geometry = decodeURIComponent(data.slice(data.indexOf(",") + 1)).match(
    /<path\b[^>]*\sd="([^"]*)"/,
  );
  assert.ok(geometry);
  expect(
    parsePathContours(geometry[1]).reduce((sum, contour) => sum + contour.points.length, 0),
  ).toBeLessThanOrEqual(27);
  const original = new Uint8ClampedArray(await sharp(image).ensureAlpha().raw().toBuffer());
  const rendered = new Uint8ClampedArray(
    await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer(),
  );
  const quality = measureRasterTrace({ width: 624, height: 380, data: original }, rendered);
  expect(quality.meanError).toBeLessThan(0.3);
  expect(quality.alphaError).toBeLessThan(0.2);
  await page.keyboard.press("ControlOrMeta+z");
  await root.locator("[data-adjustable-image]").waitFor();
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(vectors).toHaveCount(1);
});

test("dense illustration retains hundreds of details in bounded native layers", async ({
  page,
  baseURL,
}) => {
  const windows = Array.from(
    { length: 300 },
    (_, i) =>
      `<rect x="${80 + (i % 20) * 23}" y="${55 + Math.floor(i / 20) * 18}" width="5" height="5" fill="${i % 3 ? "#f6c85f" : "#ffffff"}"/>`,
  ).join("");
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="624" height="380"><rect width="624" height="380" fill="#e8edf3"/><rect x="60" y="35" width="500" height="310" fill="#23486a"/>${windows}</svg>`;
  const image = await sharp(Buffer.from(source)).png().toBuffer();
  await page.route("**/image-editor-test.svg*", (route) =>
    route.fulfill({ body: image, contentType: "image/png" }),
  );
  await page.goto(`${baseURL}/dev/import-preview?edit=1&images=1`);
  const { root, panel, openImage } = imageEditor(page);
  await openImage();
  await panel.getByRole("button", { name: "Vectorise image", exact: true }).click();
  await panel.waitFor({ state: "hidden" });
  const vectors = root.locator("img[data-vector-path]");
  await vectors.first().waitFor();
  const count = await vectors.count();
  expect(count).toBeLessThanOrEqual(8);
  const download = await exportSvg(page);
  const svg = await readFile((await download.path())!, "utf8");
  await test.info().attach("dense-export.svg", { body: svg, contentType: "image/svg+xml" });
  expect(svg).not.toMatch(/<image|foreignObject/);
  const original = new Uint8ClampedArray(await sharp(image).ensureAlpha().raw().toBuffer());
  const rendered = new Uint8ClampedArray(
    await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer(),
  );
  const frameMask = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="624" height="380"><rect width="624" height="380" rx="8" fill="white"/></svg>',
  );
  const framedOriginal = new Uint8ClampedArray(
    await sharp(image)
      .composite([{ input: frameMask, blend: "dest-in" }])
      .ensureAlpha()
      .raw()
      .toBuffer(),
  );
  const quality = measureRasterTrace({ width: 624, height: 380, data: framedOriginal }, rendered);
  await test.info().attach("dense-quality.json", {
    body: JSON.stringify(quality),
    contentType: "application/json",
  });
  expect(quality.meanError).toBeLessThan(0.5);
  expect(quality.alphaError).toBe(0);
  expect(quality.worstTileError).toBeLessThan(1);
  expect(quality.detailLoss).toBeLessThan(0.01);
  for (let i = 0; i < 300; i++) {
    const offset = ((57 + Math.floor(i / 20) * 18) * 624 + 82 + (i % 20) * 23) * 4;
    expect(rendered.slice(offset, offset + 4)).toEqual(original.slice(offset, offset + 4));
  }
  await page.keyboard.press("ControlOrMeta+z");
  await root.locator("[data-adjustable-image]").waitFor();
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(vectors).toHaveCount(count);
});
