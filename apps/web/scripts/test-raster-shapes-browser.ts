import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import sharp from "sharp";
import { rasterShapeFixtures, rasterShapeSvg } from "./raster-shape-fixtures";

const base = process.env.RASTER_TRACE_TEST_URL ?? "http://localhost:3169";
if (!["localhost", "127.0.0.1"].includes(new URL(base).hostname))
  throw new Error("Local fixture only.");
const output = process.env.RASTER_TRACE_ARTIFACTS ?? "/tmp/tidy-raster-shapes-browser";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.route("**/__analytics/**", (route) =>
  route.fulfill({ body: "{}", contentType: "application/json" }),
);
await page.route("**/api/auth/get-session", (route) =>
  route.fulfill({ body: "null", contentType: "application/json" }),
);
await page.route("https://fonts.googleapis.com/**", (route) =>
  route.fulfill({ body: "", contentType: "text/css" }),
);
const root = page.locator('[data-node-id="landscape"]:visible').first();
const panel = page.getByRole("dialog", { name: "Image editor" });
const results = [];
try {
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
    await page.screenshot({ path: join(output, `${fixture.id}-before.png`) });
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
    await page.screenshot({ path: join(output, `${fixture.id}-after.png`) });
    // Inspect every actual canvas layer independently, without merging same-colour objects.
    const layers = [];
    for (let i = 0; i < shapes; i++) {
      const vector = vectors.nth(i);
      const name = await vector.getAttribute("alt");
      const source = await vector.getAttribute("src");
      const svg = decodeURIComponent(source!.slice(source!.indexOf(",") + 1));
      await writeFile(join(output, `${fixture.id}-layer-${i + 1}.svg`), svg);
      await vectors.evaluateAll(
        (elements, visible) =>
          elements.forEach((element, index) => {
            (element as HTMLElement).style.visibility = index === visible ? "visible" : "hidden";
          }),
        i,
      );
      await page
        .getByRole("button", { name: `Select ${name}`, exact: true })
        .first()
        .click();
      await page.screenshot({ path: join(output, `${fixture.id}-layer-${i + 1}.png`) });
      layers.push({ name, svg, box: await vector.boundingBox() });
    }
    await vectors.evaluateAll((elements) =>
      elements.forEach((element) => {
        (element as HTMLElement).style.visibility = "";
      }),
    );
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
      await page.screenshot({ path: join(output, "app-icon-leaf-moved.png") });
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
      await page.screenshot({ path: join(output, "app-icon-leaf-recoloured.png") });
      await page.getByRole("button", { name: "Select Shape 2", exact: true }).click();
      await page.keyboard.press("ControlOrMeta+z");
      await page.getByRole("button", { name: "Select Ellipse", exact: true }).click();
      await page.getByRole("button", { name: "Edit points", exact: true }).click();
      await page.locator("[data-vector-editor]").waitFor();
      assert.equal(await page.locator('[data-vector-control="anchor"]').count(), 4);
      await page.screenshot({ path: join(output, "app-icon-ellipse-edit.png") });
      await page.keyboard.press("Escape");
    }
    results.push({
      id: fixture.id,
      shapes,
      layers: layers.map(({ name, box }) => ({ name, box })),
    });
    await page.unroute("**/image-editor-test.svg*");
    console.log(`PASS ${fixture.id}: ${shapes} independently inspected layers`);
  }
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, "layer-inspection.json"),
    JSON.stringify({ results, browserErrors: errors }, null, 2),
  );
} catch (error) {
  await page.screenshot({ path: join(output, "failure.png") });
  throw error;
} finally {
  await browser.close();
}
