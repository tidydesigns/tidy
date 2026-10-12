import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import sharp from "sharp";

const base = process.env.RASTER_TRACE_TEST_URL ?? "http://localhost:3057";
if (!["localhost", "127.0.0.1"].includes(new URL(base).hostname))
  throw new Error("Local fixture only.");
const output = process.env.RASTER_TRACE_ARTIFACTS ?? "/tmp/tidy-raster-vectorisation";
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
    await writeFile(`${output}/${format}-before.png`, before);
    await writeFile(`${output}/${format}-after.png`, after);
    const a = await sharp(before).raw().toBuffer(),
      b = await sharp(after).raw().toBuffer();
    assert.equal(a.length, b.length);
    const difference = a.reduce((sum, value, i) => sum + Math.abs(value - b[i]), 0) / a.length;
    assert.ok(difference < 8, `${format}: mean rendered channel difference ${difference}`);
    const source = await vectors.first().getAttribute("src");
    assert.ok(source && source.startsWith("data:image/svg+xml,"));
    assert.ok(decodeURIComponent(source.split(",").slice(1).join(",")).includes("<path"));
    await page.screenshot({ path: `${output}/${format}-vectors.png` });
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
      await writeFile(`${output}/native.svg`, exported);
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
} catch (error) {
  await page.screenshot({ path: `${output}/failure.png` });
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
