import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measureRasterTrace } from "../lib/design/vectorisation/quality";
import { parsePathContours } from "@bella/design/vector-geometry";
import {
  generalRasterFixtures,
  rasterShapeFixtures,
  rasterShapeSvg,
} from "../lib/design/vectorisation/fixtures";
import { chromium } from "playwright";
import sharp from "sharp";

const base = process.env.RASTER_TRACE_TEST_URL ?? "http://localhost:3000";
if (!["localhost", "127.0.0.1"].includes(new URL(base).hostname))
  throw new Error("Local fixture only.");
const output = process.env.RASTER_TRACE_ARTIFACTS ?? join(tmpdir(), "tidy-vectorisation-browser");
await mkdir(output, { recursive: true });
const artwork =
  '<svg xmlns="http://www.w3.org/2000/svg" width="624" height="380"><path fill="#e43d30" fill-rule="evenodd" d="M60 40H340V330H60ZM140 120V250H260V120Z"/><circle fill="#286ccf" cx="450" cy="190" r="100"/></svg>';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.route("**/__analytics/**", (route) =>
  route.fulfill({ body: "{}", contentType: "application/json" }),
);
await page.route("https://fonts.googleapis.com/**", (route) =>
  route.fulfill({ body: "", contentType: "text/css" }),
);
await page.route("**/api/auth/get-session", (route) =>
  route.fulfill({ body: "null", contentType: "application/json" }),
);
const panel = page.getByRole("dialog", { name: "Image editor" });
const root = page.locator('[data-node-id="landscape"]:visible').first();
async function openImage() {
  await page.getByRole("button", { name: "Select Landscape", exact: true }).click();
  await root.locator("[data-adjustable-image]").dblclick({ position: { x: 30, y: 30 } });
  await panel.waitFor();
}
try {
  for (const format of ["png", "jpeg", "webp"] as const) {
    const pipeline = sharp(Buffer.from(artwork));
    if (format === "jpeg") pipeline.flatten({ background: "#ffffff" });
    const image = await pipeline[format]().toBuffer();
    // The existing local fixture URL is intercepted; no stored user assets or database are used.
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
      const downloading = page.waitForEvent("download");
      await page.getByRole("button", { name: "svg", exact: true }).click();
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
  }
  // Closing the panel during delayed asset loading cancels the operation and leaves the image intact.
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
  assert.deepEqual(errors, []);
  console.log("PASS cancellation on close/button and no browser errors");
  await page.unroute("**/image-editor-test.svg*");
  for (const fixture of rasterShapeFixtures) {
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
      layers.push({ name: await vector.getAttribute("alt"), box: await vector.boundingBox() });
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
      const before = await leaf.boundingBox();
      await page.keyboard.press("ArrowRight");
      const after = await leaf.boundingBox();
      assert.ok(after!.x > before!.x, "Leaf moves independently");
      for (let i = 0; i < 19; i++) await page.keyboard.press("ArrowRight");

      for (let i = 0; i < 20; i++) await page.keyboard.press("ControlOrMeta+z");
      const fill = page.getByLabel("Fill color", { exact: true });
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
  }
  const cases = generalRasterFixtures.flatMap((fixture) => [
    { fixture, format: "png" as const },
    ...(["rotated-shapes", "concave-shapes", "close-colours"].includes(fixture.id)
      ? [{ fixture, format: "jpeg" as const }]
      : []),
  ]);
  for (const { fixture, format } of cases) {
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
      const stop = page.getByLabel("Stop 1 color", { exact: true });
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

    const downloading = page.waitForEvent("download");
    await page.getByRole("button", { name: "svg", exact: true }).click();
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
  }
  assert.deepEqual(errors, []);
} catch (error) {
  await page.screenshot({ path: join(output, "failure.png") });
  console.error(
    "Browser errors:",
    errors,
    "Alerts:",
    await page.getByRole("alert").allTextContents(),
  );
  throw error;
} finally {
  await browser.close();
}
