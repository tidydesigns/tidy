import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import sharp from "sharp";
import { unzipSync } from "fflate";
import { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from "pdf-lib";
const base = process.env.EXPORT_TEST_BASE_URL ?? "http://localhost:3038";
if (!["localhost", "127.0.0.1"].includes(new URL(base).hostname))
  throw new Error("Export browser checks require localhost.");
const font = await readFile(new URL("../app/fonts/InstrumentSerif-Regular.woff2", import.meta.url)),
  crop = await readFile(new URL("../public/crop-test.svg", import.meta.url));
const browser = await chromium.launch({ headless: true }),
  page = await browser.newPage({ viewport: { width: 1600, height: 1100 } }),
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
let failImage = false,
  failFont = false;
await page.route("https://fonts.googleapis.com/**", (route) =>
  route.fulfill({
    contentType: "text/css",
    body: '@font-face{font-family:"Roboto";font-weight:400;font-style:normal;src:url(https://fonts.gstatic.com/tidy/export.woff2) format("woff2");}',
  }),
);
await page.route("https://fonts.gstatic.com/**", (route) =>
  route.fulfill({
    status: failFont ? 503 : 200,
    contentType: "font/woff2",
    body: failFont ? Buffer.from("Unavailable") : font,
  }),
);
await page.route("**/crop-test.svg", (route) =>
  route.fulfill({
    status: failImage ? 503 : 200,
    contentType: "image/svg+xml",
    body: failImage ? Buffer.from("Unavailable") : crop,
  }),
);
const temporary = await mkdtemp(join(tmpdir(), "tidy-exports-"));
const select = async (name, shift = false) => {
  await page
    .getByRole("button", { name: `Select ${name}`, exact: true })
    .first()
    .click(shift ? { modifiers: ["Shift"] } : {});
};
const scale = async (value) => {
  await page.getByLabel("Export scale", { exact: true }).fill(String(value));
  await page.getByLabel("Export scale", { exact: true }).press("Enter");
};
const download = async (format) => {
  const promise = page.waitForEvent("download");
  await page.getByRole("button", { name: format, exact: true }).click();
  const result = await promise,
    file = join(temporary, result.suggestedFilename());
  await result.saveAs(file);
  return { name: result.suggestedFilename(), bytes: await readFile(file) };
};
const pixels = async (bytes) =>
  sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const difference = (a, b) => {
  assert.equal(a.length, b.length);
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
  return total / a.length;
};
const svgPng = (bytes) =>
  page
    .evaluate(async (source) => {
      const image = new Image();
      image.src = `data:image/svg+xml,${encodeURIComponent(source)}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext("2d").drawImage(image, 0, 0);
      return canvas.toDataURL("image/png").split(",")[1];
    }, bytes.toString())
    .then((data) => Buffer.from(data, "base64"));
try {
  await page.goto(`${base}/dev/import-preview?edit=1&exports=1`);
  await page.waitForSelector('[data-node-id="heading"]');
  await page.waitForFunction(() =>
    [...document.fonts].some(
      (f) => f.family.replace(/["']/g, "") === "Roboto" && f.status === "loaded",
    ),
  );
  await select("Export frame");
  // Verify all available scales decode to the requested physical pixel dimensions.
  let baseline;
  for (const factor of [0.25, 0.5, 1, 2, 3, 4]) {
    await scale(factor);
    const png = await download("png"),
      image = await pixels(png.bytes);
    assert.equal(image.info.width, 620 * factor);
    assert.equal(image.info.height, 420 * factor);
    assert.equal(png.name, `Export-frame${factor === 1 ? "" : `@${factor}x`}.png`);
    if (factor === 1) baseline = image;
  }
  await scale(1);
  const svg = await download("svg");
  assert.ok(!svg.bytes.toString().includes("foreignObject"));
  assert.ok(svg.bytes.toString().includes("<text"));
  assert.ok(svg.bytes.toString().includes("<linearGradient"));
  assert.ok(svg.bytes.toString().includes("<filter"));
  assert.ok(svg.bytes.toString().includes("data:font"));
  assert.ok(svg.bytes.toString().includes('fill="#0088cc"'), "Vector paint keeps its hex color");
  const native = await pixels(await svgPng(svg.bytes)),
    delta = difference(baseline.data, native.data);
  assert.ok(delta < 3, `Native SVG mean pixel difference ${delta}`);
  const webp = await download("webp"),
    webpImage = await pixels(webp.bytes);
  assert.equal(webpImage.info.width, 620);
  assert.ok(difference(baseline.data, webpImage.data) < 4);
  const pdf = await download("pdf"),
    document = await PDFDocument.load(pdf.bytes);
  assert.equal(document.getPageCount(), 1);
  assert.equal(document.getPage(0).getWidth(), 465);
  assert.equal(document.getPage(0).getHeight(), 315);
  const image = document.context
    .enumerateIndirectObjects()
    .map(([, object]) => object)
    .find(
      (object) =>
        object instanceof PDFRawStream &&
        object.dict.get(PDFName.of("Subtype")) === PDFName.of("Image") &&
        object.dict.get(PDFName.of("ColorSpace")) === PDFName.of("DeviceRGB"),
    );
  assert.ok(image);
  assert.equal(image.dict.get(PDFName.of("Width")).asNumber(), 620);
  const decoded = decodePDFRawStream(image).decode();
  let rgb = 0;
  for (let i = 0; i < baseline.data.length; i += 4)
    for (let channel = 0; channel < 3; channel++)
      assert.equal(decoded[rgb++], baseline.data[i + channel]);
  // Layer selections honor transforms and duplicate names produce deterministic batch files.
  await select("Gradient panel");
  const layer = await download("png"),
    layerMeta = await sharp(layer.bytes).metadata();
  assert.ok(layerMeta.width > 240 && layerMeta.height > 110);
  await select("Export frame");
  await select("Export frame", true); // The first frame is toggled; explicitly add the second below.
  await page.getByRole("button", { name: "Select Export frame", exact: true }).nth(0).click();
  await page
    .getByRole("button", { name: "Select Export frame", exact: true })
    .nth(1)
    .click({ modifiers: ["Shift"] });
  await page.getByRole("button", { name: /^Export mode / }).click();
  await page.getByRole("menuitemradio", { name: "Batch", exact: true }).click();
  await scale(2);
  const archive = await download("png"),
    files = unzipSync(archive.bytes);
  assert.equal(archive.name, "Layers@2x.zip");
  assert.deepEqual(Object.keys(files), ["Export-frame@2x.png", "Export-frame-2@2x.png"]);
  assert.equal((await sharp(files["Export-frame@2x.png"]).metadata()).width, 1240);
  assert.equal((await sharp(files["Export-frame-2@2x.png"]).metadata()).width, 600);
  const batchSvg = unzipSync((await download("svg")).bytes);
  assert.ok(!Buffer.from(batchSvg["Export-frame@2x.svg"]).toString().includes("foreignObject"));
  assert.ok(Buffer.from(batchSvg["Export-frame-2@2x.svg"]).toString().includes("foreignObject"));
  const details = page.locator("details").filter({ hasText: "SVG rendering details" });
  assert.equal(await details.getAttribute("open"), null);
  await details.locator("summary").click();
  assert.ok((await details.innerText()).includes("Second frame text"));
  const batchPdf = await download("pdf"),
    batch = await PDFDocument.load(batchPdf.bytes);
  assert.equal(batch.getPageCount(), 2);
  assert.deepEqual(
    batch.getPages().map((p) => [p.getWidth(), p.getHeight()]),
    [
      [930, 630],
      [450, 270],
    ],
  );
  await page.getByRole("button", { name: /^Export mode / }).click();
  await page.getByRole("menuitemradio", { name: "Selection", exact: true }).click();
  await scale(1);
  const combined = await download("png");
  assert.equal((await sharp(combined.bytes).metadata()).width, 1060);
  await select("Export frame");
  failImage = true;
  await page.getByRole("button", { name: "png", exact: true }).click();
  await page.getByText("Could not include an image in the export.", { exact: true }).waitFor();
  failImage = false;
  failFont = true;
  await page.getByRole("button", { name: "svg", exact: true }).click();
  await page.getByText("Could not include a font in the export.", { exact: true }).waitFor();
  failFont = false;
  await download("png");
  await page.goto(`${base}/dev/import-preview?edit=1&vector=1`);
  await select("Editable path");
  const vectorPng = await pixels((await download("png")).bytes);
  const vectorSvg = await download("svg");
  assert.ok(vectorSvg.bytes.toString().includes("foreignObject"));
  const vectorRaster = await pixels(await svgPng(vectorSvg.bytes));
  assert.equal(vectorRaster.info.width, vectorPng.info.width);
  assert.equal(vectorRaster.info.height, vectorPng.info.height);
  assert.ok(difference(vectorPng.data, vectorRaster.data) < 1);
  assert.deepEqual(errors, []);
  console.log(
    `PASS: selection/batches, six scales, native SVG parity (${delta.toFixed(3)}), PDF image decoding, mixed fonts/assets/crops/masks/filters/gradients, failure recovery`,
  );
} finally {
  await browser.close();
  await rm(temporary, { recursive: true, force: true });
}
