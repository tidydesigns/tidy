import { imageAdjustmentFilter } from "@bella/design/image-adjustments";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Locator } from "playwright";
import sharp from "sharp";
const base = process.env.IMAGE_EDITOR_TEST_URL ?? "http://localhost:3049";
if (!["localhost", "127.0.0.1"].includes(new URL(base).hostname))
  throw new Error("Local fixture only");
const output = process.env.IMAGE_EDITOR_ARTIFACTS ?? "/tmp/tidy-image-review";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  colorScheme: "light",
});
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.route("**/__analytics/**", (route) =>
  route.fulfill({ body: "{}", contentType: "application/json" }),
);
await page.route("https://fonts.googleapis.com/**", (route) =>
  route.fulfill({ body: "", contentType: "text/css" }),
);
const panel = page.getByRole("dialog", { name: "Image editor" });
const image = page.locator('[data-node-id="landscape"] > [data-adjustable-image]');
const values = async (element: Locator = image) =>
  JSON.parse((await element.getAttribute("data-image-adjustments")) ?? "{}");
async function setValue(label: string, amount: number) {
  await panel.getByLabel(`${label} value`, { exact: true }).fill(String(amount));
  await panel.getByLabel(`${label} value`, { exact: true }).press("Enter");
}
async function exportImage(format: "png" | "svg") {
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: format, exact: true }).click();
  const file = await download;
  const path = join(output, `adjusted.${format}`);
  await file.saveAs(path);
  return readFile(path);
}
async function checkExport() {
  const png = await exportImage("png"),
    svg = await exportImage("svg");
  const a = await sharp(png).ensureAlpha().raw().toBuffer();
  const b = await sharp(svg).ensureAlpha().raw().toBuffer();
  assert.equal(a.length, b.length);
  const difference =
    a.reduce((sum, value, index) => sum + Math.abs(value - b[index]), 0) / a.length;
  assert.ok(difference < 3, `PNG/SVG pixel difference ${difference}`);
  console.log(`PASS: native SVG/PNG parity (mean difference ${difference.toFixed(3)})`);
}
try {
  await page.goto(`${base}/dev/import-preview?edit=1&images=1`);
  const filters = [
    { highlights: 0.8 },
    { shadows: 0.8 },
    {
      exposure: 0.4,
      contrast: 0.2,
      temperature: 0.3,
      tint: -0.2,
      saturation: 0.2,
      highlights: -0.5,
      shadows: 0.5,
    },
  ].map((value) => imageAdjustmentFilter("adjust", value));
  const pixels = await page.evaluate(async (filters) => {
    const results: number[][] = [];
    for (const filter of filters) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="4" height="1"><defs>${filter}</defs><g filter="url(#adjust)"><path fill="#202020" d="M0 0h1v1H0z"/><path fill="#eeeeee" d="M1 0h1v1H1z"/><path fill="#888888" fill-opacity=".5" d="M2 0h1v1H2z"/></g></svg>`;
      const image = new Image();
      image.src = `data:image/svg+xml,${encodeURIComponent(svg)}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = 4;
      canvas.height = 1;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      results.push([...context.getImageData(0, 0, 4, 1).data]);
    }
    return results;
  }, filters);
  assert.equal(pixels[0][0], 32, "Highlights leave dark pixels unchanged");
  assert.equal(pixels[1][4], 238, "Shadows leave light pixels unchanged");
  for (const pixel of pixels) {
    assert.equal(pixel[11], 128, "Filters retain partial alpha");
    assert.equal(pixel[15], 0, "Filters retain fully transparent pixels");
  }
  console.log("PASS: selective tonal masks and alpha preservation");
  await image.waitFor();
  await page.getByRole("button", { name: "Select Landscape", exact: true }).click();
  await image.dblclick({ position: { x: 30, y: 30 } });
  await panel.waitFor();
  assert.equal(await panel.getByRole("slider").count(), 7);
  const bounds = await image.boundingBox();
  assert.ok(bounds);
  const clip = { x: bounds.x + 4, y: bounds.y + 4, width: 180, height: bounds.height - 8 };
  const neutral = await page.screenshot({ clip });
  for (const [key, label] of Object.entries({
    exposure: "Exposure",
    contrast: "Contrast",
    saturation: "Saturation",
    temperature: "Temperature",
    tint: "Tint",
    highlights: "Highlights",
    shadows: "Shadows",
  })) {
    await setValue(label, 60);
    assert.equal((await values())[key], 0.6);
    assert.notDeepEqual(await page.screenshot({ clip }), neutral, `${label} changes image pixels`);
    await panel.getByRole("button", { name: "Reset adjustments" }).click();
  }
  assert.deepEqual(await page.screenshot({ clip }), neutral, "Reset restores original pixels");
  console.log("PASS: all seven controls change pixels; reset restores original exactly");
  const slider = panel.getByRole("slider", { name: "Exposure", exact: true });
  const track = await slider.boundingBox();
  assert.ok(track);
  await page.evaluate(() => {
    const intervals: number[] = [];
    let previous = performance.now(),
      frame = 0;
    const tick = (time: number) => {
      intervals.push(time - previous);
      previous = time;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    Object.assign(window, {
      endImageBenchmark: () => {
        cancelAnimationFrame(frame);
        return intervals.slice(1);
      },
    });
  });
  await page.mouse.move(track.x + track.width / 2, track.y + track.height / 2);
  await page.mouse.down();
  await page.mouse.move(track.x + track.width * 0.85, track.y + track.height / 2, { steps: 80 });
  const intervals = await page.evaluate(() =>
    (window as unknown as { endImageBenchmark: () => number[] }).endImageBenchmark(),
  );
  intervals.sort((a, b) => a - b);
  console.log(
    `Drag frame interval p95: ${intervals[Math.floor(intervals.length * 0.95)]?.toFixed(1)} ms (${intervals.length} frames, local Chromium)`,
  );
  assert.equal((await values()).exposure, 0, "No document changes during gesture");
  assert.notDeepEqual(await page.screenshot({ clip }), neutral, "Canvas previews before commit");
  await page.mouse.up();
  assert.ok((await values()).exposure > 0.5);
  await panel.getByRole("button", { name: "Close image editor" }).click();
  await page.locator('[data-node-id="landscape"]').click({ position: { x: 20, y: 20 } });
  await page.keyboard.press("Control+z");
  assert.equal((await values()).exposure, 0, "Entire drag is one undo entry");
  console.log("PASS: live preview and one undo per drag");
  await image.dblclick({ position: { x: 30, y: 30 } });
  await slider.focus();
  await slider.press("ArrowRight");
  assert.equal((await values()).exposure, 0.01);
  await slider.fill("45");
  await slider.press("Escape");
  assert.equal((await values()).exposure, 0.01, "Escape cancels only unfinished gesture");
  assert.equal(await slider.inputValue(), "1");
  for (const [label, amount] of Object.entries({
    Exposure: 12,
    Contrast: 18,
    Saturation: 22,
    Temperature: 15,
    Tint: -4,
    Highlights: -20,
    Shadows: 16,
  }))
    await setValue(label, amount);
  await page.screenshot({ path: join(output, "after.png") });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: join(output, "after-dark.png") });
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 760, height: 620 });
  const small = await panel.boundingBox();
  assert.ok(small && small.x >= 0 && small.x + small.width <= 760 && small.y + small.height <= 620);
  await panel.getByRole("button", { name: "Reset adjustments" }).scrollIntoViewIfNeeded();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await panel.getByRole("button", { name: "Close image editor" }).click();
  await checkExport();
  await page.getByRole("button", { name: "Edit image", exact: true }).click();
  await panel.getByRole("button", { name: "Crop", exact: true }).click();
  await page.getByRole("button", { name: "Finish crop", exact: true }).waitFor();
  await page.getByRole("button", { name: "Finish crop", exact: true }).click();
  await page.getByRole("button", { name: "Edit image", exact: true }).click();
  await setValue("Contrast", -25);
  await panel.getByRole("button", { name: "Close image editor" }).click();
  await checkExport();
  console.log("PASS: keyboard, cancellation, small viewport and cropped exports");
  await page.goto(`${base}/dev/import-preview?edit=1&exports=1`);
  await page.locator('[data-node-id="image-fill"]').waitFor();
  await page.getByRole("button", { name: "Select Image fill", exact: true }).click();
  await page.getByRole("button", { name: "Edit fill 1", exact: true }).click();
  await panel.waitFor();
  await setValue("Saturation", -100);
  const fillImage = page.locator('[data-node-id="image-fill"] [data-adjustable-image]');
  assert.equal((await values(fillImage)).saturation, -1);
  assert.deepEqual(
    await values(page.locator('[data-node-id="crop"] [data-adjustable-image]')),
    {},
    "Same asset in another layer is untouched",
  );
  await page.getByRole("button", { name: "Select Cropped image", exact: true }).click();
  await panel.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Select Image fill", exact: true }).click();
  assert.equal(await panel.count(), 0, "Selection changes close the editor permanently");
  assert.deepEqual(errors, []);
  console.log("PASS: fill targeting, asset isolation, selection lifecycle; no browser errors");
} finally {
  await browser.close();
}
