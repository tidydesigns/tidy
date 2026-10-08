import { artifactPath } from "./artifact-path.mjs";
import { chooseSelectMenu } from "./select-menu-controls.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ headless: true });
const base = process.env.EDITOR_TEST_URL || "http://127.0.0.1:3107",
  command = process.platform === "darwin" ? "Meta" : "Control";
const asset = "00000000-0000-4000-8000-000000000002";
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
    ignoreHTTPSErrors: true,
  });
  let releaseUpload, uploadStarted;
  const started = new Promise((resolve) => (uploadStarted = resolve)),
    uploadGate = new Promise((resolve) => (releaseUpload = resolve));
  await context.route("**/api/files/preview/assets", async (route) => {
    uploadStarted();
    await uploadGate;
    await route.fulfill({ json: { assetId: asset } });
  });
  await context.route(`**/api/assets/${asset}`, (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400"><rect width="400" height="400" fill="#f00000"/><rect x="400" width="400" height="400" fill="#0000f0"/></svg>',
    }),
  );
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/dev/import-preview?edit=1`);
  await page.getByRole("button", { name: "Select Desktop 1440 · /login", exact: true }).click();
  const frame = page.locator('[data-node-id="desktop-screen"]'),
    canvas = page.getByLabel("Design canvas", { exact: true });
  const set = async (name, value) => {
    const field = page.getByRole("spinbutton", { name, exact: true });
    await field.fill(String(value));
    await field.press("Enter");
  };
  const color = async (name, value) => {
    const field = page.getByRole("textbox", { name, exact: true });
    await field.fill(value);
    await field.press("Enter");
  };
  const undo = async () => {
    await canvas.focus();
    await page.keyboard.press(`${command}+z`);
  };
  const stack = () => frame.locator(":scope > [data-fill-stack] > [data-fill-id]");
  await color("Fill color", "#ff0000");
  await page.getByRole("button", { name: "Add fill", exact: true }).click();
  await color("Fill color", "#0000ff");
  await set("Fill opacity %", 50);
  assert.equal(await stack().count(), 2);
  assert.deepEqual(
    await stack().evaluateAll((elements) =>
      elements.map((element) => [element.style.background, element.style.opacity]),
    ),
    [
      ["rgb(255, 0, 0)", "1"],
      ["rgb(0, 0, 255)", "0.5"],
    ],
  );
  await page.getByRole("button", { name: "Hide fill 1", exact: true }).click();
  assert.equal(await stack().count(), 1);
  await undo();
  assert.equal(await stack().count(), 2);
  await page.getByRole("button", { name: "Move fill 1 down", exact: true }).click();
  assert.deepEqual(
    await stack().evaluateAll((elements) => elements.map((element) => element.style.background)),
    ["rgb(0, 0, 255)", "rgb(255, 0, 0)"],
  );
  await undo();
  assert.deepEqual(
    await stack().evaluateAll((elements) => elements.map((element) => element.style.background)),
    ["rgb(255, 0, 0)", "rgb(0, 0, 255)"],
  );
  // Check the downloaded composited pixel, rather than only the DOM model.
  await page.getByText("Export", { exact: true }).click();
  const blendDownload = page.waitForEvent("download", { timeout: 10000 });
  await page.getByRole("button", { name: "png", exact: true }).click();
  const blendPng = await readFile(await (await blendDownload).path());
  const sample = async (png, points) =>
    page.evaluate(
      async ({ data, points }) => {
        const image = new Image();
        image.src = data;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0);
        return points.map(([x, y]) => Array.from(context.getImageData(x, y, 1, 1).data));
      },
      { data: `data:image/png;base64,${png.toString("base64")}`, points },
    );
  const blend = (await sample(blendPng, [[50, 50]]))[0];
  assert.ok(Math.abs(blend[0] - 127) < 3 && blend[1] < 3 && Math.abs(blend[2] - 128) < 3);
  await page.getByRole("button", { name: "Edit fill 1", exact: true }).click();
  await set("Fill opacity %", 100);
  await chooseSelectMenu(page, "Fill blend mode", "multiply");
  assert.equal(
    await stack()
      .last()
      .evaluate((element) => element.style.mixBlendMode),
    "multiply",
  );
  const multiplyDownload = page.waitForEvent("download", { timeout: 10000 });
  await page.getByRole("button", { name: "png", exact: true }).click();
  const multiplied = (
    await sample(await readFile(await (await multiplyDownload).path()), [[50, 50]])
  )[0];
  assert.ok(
    multiplied[0] < 5 && multiplied[1] < 5 && multiplied[2] < 5,
    `multiply pixel ${multiplied}`,
  );
  await undo();
  assert.equal(
    await stack()
      .last()
      .evaluate((element) => element.style.mixBlendMode),
    "",
  );
  await undo();
  assert.equal(
    await stack()
      .last()
      .evaluate((element) => element.style.opacity),
    "0.5",
  );
  await page.getByRole("button", { name: "Remove fill 2", exact: true }).click();
  await page.getByRole("button", { name: "Edit fill 1", exact: true }).click();
  await set("Fill opacity %", 100);
  await chooseSelectMenu(page, "Fill type", "Linear gradient");
  await set("Gradient angle", 90);
  await color("Stop 1 color", "#ff0000");
  await color("Stop 2 color", "#0000ff");
  await page.getByRole("button", { name: "Add gradient stop", exact: true }).click();
  await color("Stop 3 color", "#00ff00");
  await set("Stop 3 position %", 40);
  assert.ok(
    (await frame.evaluate((element) => element.style.background)).includes("rgb(0, 255, 0) 40%"),
  );
  await chooseSelectMenu(page, "Fill type", "Radial gradient");
  await set("Gradient X %", 25);
  await set("Gradient Y %", 75);
  await set("Gradient radius X %", 30);
  await set("Gradient radius Y %", 40);
  assert.ok(
    (await frame.evaluate((element) => element.style.background)).includes("30% 40% at 25% 75%"),
  );
  await page.screenshot({ path: artifactPath("bella-editor-fill-stops.png") });
  await page.getByRole("button", { name: "Remove stop 3", exact: true }).click();
  assert.equal(
    await page.getByRole("button", { name: "Remove stop 1", exact: true }).isDisabled(),
    true,
  );
  await undo();
  assert.equal(
    await page.getByRole("textbox", { name: "Stop 3 color", exact: true }).inputValue(),
    "#00ff00",
  );
  await chooseSelectMenu(page, "Fill type", "Image");
  await page.getByLabel("Fill image", { exact: true }).setInputFiles({
    name: "fill.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400"/>'),
  });
  await started;
  await set("Fill opacity %", 80);
  await page.getByRole("button", { name: "Select Welcome heading", exact: true }).first().click();
  releaseUpload();
  await frame.locator("[data-fill-stack] img").waitFor();
  await frame.locator("[data-fill-stack] img").evaluate((image) => image.decode());
  assert.equal(
    await page.getByRole("combobox", { name: "Font family", exact: true }).count(),
    1,
    "Upload completion must retain the later selection.",
  );
  assert.equal(
    await stack()
      .first()
      .evaluate((element) => element.style.opacity),
    "0.8",
  );
  await page.getByRole("button", { name: "Select Desktop 1440 · /login", exact: true }).click();
  await set("Fill opacity %", 100);
  await page.getByRole("button", { name: "Crop fill image", exact: true }).click();
  await set("Fill crop width %", 50);
  await set("Fill crop x %", 50);
  assert.equal(await frame.locator("[data-image-crop]").getAttribute("viewBox"), "400 0 400 400");
  await page.getByText("Export", { exact: true }).click();
  const cropDownload = page.waitForEvent("download", { timeout: 10000 });
  await page.getByRole("button", { name: "png", exact: true }).click();
  const croppedPixels = await sample(await readFile(await (await cropDownload).path()), [
    [50, 50],
    [1350, 50],
  ]);
  assert.ok(
    croppedPixels.every((pixel) => pixel[2] > 200 && pixel[0] < 10),
    `cropped fill pixels ${croppedPixels}`,
  );
  await page.getByRole("button", { name: "Reset fill crop", exact: true }).click();
  assert.equal(await frame.locator("[data-image-crop]").count(), 0);
  await undo();
  assert.equal(await frame.locator("[data-image-crop]").count(), 1);
  await page.getByRole("button", { name: "Reset fill crop", exact: true }).click();
  await page.getByText("Export", { exact: true }).click();
  const svgDownload = page.waitForEvent("download", { timeout: 10000 });
  await page.getByRole("button", { name: "svg", exact: true }).click();
  const svg = await readFile(await (await svgDownload).path(), "utf8");
  assert.ok(svg.includes("data:image/svg+xml"));
  assert.ok(!svg.includes(`/api/assets/${asset}`));
  const pngDownload = page.waitForEvent("download", { timeout: 10000 });
  await page.getByRole("button", { name: "png", exact: true }).click();
  const imagePng = await readFile(await (await pngDownload).path());
  const pixels = await sample(imagePng, [
    [50, 50],
    [1350, 50],
  ]);
  assert.ok(pixels[0][0] > 200 && pixels[0][2] < 10);
  assert.ok(pixels[1][2] > 200 && pixels[1][0] < 10);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: fill stacks, per-fill blend and crop pixels, undo, exported alpha composition, positioned stops, radial geometry, stop limits, image fill upload with intervening edit/selection preservation, and self-contained SVG/PNG image fills; no page errors",
  );
} finally {
  await browser.close();
}
