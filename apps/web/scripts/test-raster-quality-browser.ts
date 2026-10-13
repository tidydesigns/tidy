import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import sharp from "sharp";
import { measureRasterTrace } from "../lib/design/raster-trace-quality";
import { parsePathContours } from "@bella/design/vector-geometry";
import { generalRasterFixtures, rasterShapeSvg } from "./raster-shape-fixtures";

const base = process.env.RASTER_TRACE_TEST_URL ?? "http://localhost:3171";
if (!["localhost", "127.0.0.1"].includes(new URL(base).hostname))
  throw new Error("Local fixture only.");
const output = process.env.RASTER_TRACE_ARTIFACTS ?? "/tmp/tidy-raster-quality-browser";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  recordVideo: { dir: join(output, "recording"), size: { width: 1440, height: 1000 } },
});
const page = await context.newPage(),
  video = page.video();
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
const rows = [];
try {
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
    await writeFile(join(output, `${id}-source.${format}`), png);
    await page.route("**/image-editor-test.svg*", (route) =>
      route.fulfill({ body: png, contentType: `image/${format}` }),
    );
    await page.goto(`${base}/dev/import-preview?edit=1&images=1`);
    await page.getByRole("button", { name: "Select Landscape", exact: true }).click();
    await root.locator("[data-adjustable-image]").evaluate(async (element) => {
      if (element instanceof HTMLImageElement) await element.decode();
    });
    await page.screenshot({ path: join(output, `${id}-before.png`) });
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
      await page.screenshot({ path: join(output, "colour-loss-rejected.png") });
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
      await page.screenshot({ path: join(output, "linear-gradient-editing.png") });
      await page.getByRole("button", { name: "Select Ellipse", exact: true }).click();
      await page.keyboard.press("ControlOrMeta+z");
      await page.getByRole("button", { name: "Select Landscape", exact: true }).click();
    }
    if (fixture.id === "thin-cutout") {
      const contours = await vectors.first().evaluate((element) => {
        const svg = new DOMParser().parseFromString(
          decodeURIComponent((element as HTMLImageElement).src.split(",").slice(1).join(",")),
          "image/svg+xml",
        );
        return svg.querySelector("path")!.getAttribute("d")!;
      });
      assert.equal(parsePathContours(contours).length, 3, "Preserves both intentional holes");
    }
    await page.screenshot({ path: join(output, `${id}-after.png`) });
    const downloading = page.waitForEvent("download");
    await page.getByRole("button", { name: "svg", exact: true }).click();
    const downloaded = await downloading,
      svg = await readFile((await downloaded.path())!, "utf8");
    assert.ok(!svg.includes("<image") && !svg.includes("foreignObject"));
    await writeFile(join(output, `${id}.svg`), svg);
    await sharp(Buffer.from(svg))
      .resize(624, 380)
      .png()
      .toFile(join(output, `${id}-vector.png`));
    for (let i = 0; i < geometry.length; i++)
      await writeFile(join(output, `${id}-layer-${i + 1}.svg`), geometry[i].svg);
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
    rows.push({
      id,
      format,
      quality,
      shapes: geometry.length,
      names: geometry.map((p) => p.name),
      nativeSvg: true,
      undoRedo: true,
    });
    await page.unroute("**/image-editor-test.svg*");
    console.log(`PASS ${id}: ${geometry.length} shapes, ${geometry.map((p) => p.name).join(", ")}`);
  }
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, "browser-results.json"),
    JSON.stringify({ rows, browserErrors: errors }, null, 2),
  );
} catch (error) {
  await page.screenshot({ path: join(output, "failure.png") });
  throw error;
} finally {
  await context.close();
  await video?.saveAs(join(output, "browser-conversions.webm"));
  await browser.close();
}
