import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import sharp from "sharp";

const base = process.env.VECTOR_TEST_BASE_URL ?? "http://localhost:3032";
if (!["localhost", "127.0.0.1"].includes(new URL(base).hostname))
  throw new Error("Vector browser checks require a localhost app.");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const temporary = await mkdtemp(join(tmpdir(), "tidy-vector-"));
const sourcePath = async (id = "editable-path") =>
  page.locator(`[data-node-id="${id}"] img[data-vector-path]`).evaluate((element) =>
    new DOMParser()
      .parseFromString(decodeURIComponent(element.src.split(",")[1]), "image/svg+xml")
      .querySelector("path")
      .getAttribute("d"),
  );
const countAnchors = () => page.locator('[data-vector-control="anchor"]').count();
const drag = async (locator, dx, dy) => {
  const box = await locator.boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 6 });
  await page.mouse.up();
};
try {
  await page.goto(`${base}/dev/import-preview?edit=1&vector=1`);
  await page.waitForSelector('[data-node-id="editable-path"]');
  // Select through the layer list to avoid a node drag during the double-click gesture.
  await page.getByRole("button", { name: "Editable path", exact: false }).first().click();
  await page.getByRole("button", { name: "Edit points", exact: true }).click();
  await page.waitForSelector("[data-vector-editor]");
  assert.equal(await countAnchors(), 4);
  const original = await sourcePath();
  const delta = await page.locator('[data-node-id="editable-path"]').evaluate((element) => {
    let matrix = new DOMMatrix();
    for (
      let current = element;
      current && !current.hasAttribute("data-canvas-viewport");
      current = current.parentElement
    ) {
      const transform = getComputedStyle(current).transform;
      if (transform !== "none") matrix = new DOMMatrix(transform).multiply(matrix);
    }
    const inverse = matrix.inverse();
    return { x: inverse.a * 30 + inverse.c * -15, y: inverse.b * 30 + inverse.d * -15 };
  });
  await drag(page.getByRole("button", { name: "Anchor p1", exact: true }), 30, -15);
  assert.ok(
    Math.abs(
      Number(await page.getByLabel("Point X", { exact: true }).inputValue()) - (20 + delta.x),
    ) < 0.01,
  );
  assert.ok(
    Math.abs(
      Number(await page.getByLabel("Point Y", { exact: true }).inputValue()) - (30 + delta.y),
    ) < 0.01,
  );
  assert.notEqual(await sourcePath(), original);
  await page.keyboard.press("Meta+z");
  await page.waitForFunction((original) => {
    const image = document.querySelector('[data-node-id="editable-path"] img[data-vector-path]');
    return (
      new DOMParser()
        .parseFromString(decodeURIComponent(image.src.split(",")[1]), "image/svg+xml")
        .querySelector("path")
        .getAttribute("d") === original
    );
  }, original);
  assert.equal(await page.getByLabel("Point X", { exact: true }).inputValue(), "20");
  await drag(page.getByRole("button", { name: "Outgoing handle p1", exact: true }), -15, 12);
  assert.notEqual(await sourcePath(), original);
  await page.keyboard.press("Meta+z");
  await page.getByLabel("Point X", { exact: true }).fill("25");
  await page.getByLabel("Point X", { exact: true }).press("Enter");
  assert.match(await sourcePath(), /^M 25 30/);
  await page.getByRole("button", { name: "Open contour", exact: true }).click();
  assert.ok(!(await sourcePath()).endsWith("Z"));
  await page.getByRole("button", { name: "Close contour", exact: true }).click();
  assert.ok((await sourcePath()).endsWith("Z"));
  const segment = page.locator('[data-vector-editor] svg path[stroke="transparent"]').nth(1);
  const segmentBox = await segment.boundingBox();
  await segment.dblclick({
    position: { x: segmentBox.width / 2, y: segmentBox.height / 2 },
    force: true,
  });
  assert.equal(await countAnchors(), 5);
  await page.getByRole("button", { name: "Delete point", exact: true }).click();
  assert.equal(await countAnchors(), 4);
  await page.getByRole("button", { name: "Finish editing points", exact: true }).click();
  await page.getByRole("button", { name: "Pen tool", exact: true }).click();
  const pen = page.locator("[data-pen-editor]");
  await pen.click({ position: { x: 150, y: 120 } });
  await pen.click({ position: { x: 210, y: 160 } });
  await pen.click({ position: { x: 130, y: 210 } });
  await pen.click({ position: { x: 150, y: 120 } });
  await page.waitForSelector("[data-vector-editor]");
  assert.equal(await countAnchors(), 3);
  const nativeId = await page
    .locator("[data-node-id]:has(>img[data-vector-path])")
    .last()
    .getAttribute("data-node-id");
  assert.ok(nativeId && nativeId !== "editable-path");
  assert.ok((await sourcePath(nativeId)).endsWith("Z"));
  const nativeImage = await page
    .locator(`[data-node-id="${nativeId}"] img[data-vector-path]`)
    .getAttribute("src");
  const svg = decodeURIComponent(nativeImage.split(",")[1]);
  const rendered = await sharp(Buffer.from(svg)).png().toBuffer();
  assert.ok(rendered.length > 100);
  await page.keyboard.press("Meta+z");
  assert.equal(await page.locator(`[data-node-id="${nativeId}"]`).count(), 0);
  await page.getByRole("button", { name: "Pen tool", exact: true }).click();
  await pen.click({ position: { x: 140, y: 120 } });
  await pen.click({ position: { x: 200, y: 160 } });
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("[data-pen-editor]").count(), 0);

  await page
    .getByRole("button", { name: "Frame", exact: false })
    .filter({ hasText: "Frame" })
    .first()
    .click();
  for (const format of ["svg", "png", "webp"]) {
    const control = page.getByRole("button", { name: format, exact: true });
    await control.scrollIntoViewIfNeeded();
    const downloading = page.waitForEvent("download");
    await control.click();
    const download = await downloading,
      destination = join(temporary, `frame.${format}`);
    await download.saveAs(destination);
    const bytes = await readFile(destination);
    if (format === "svg") assert.ok(bytes.toString().includes("data:image/svg+xml"));
    else {
      const image = sharp(bytes),
        metadata = await image.metadata();
      assert.equal(metadata.width, 620);
      assert.equal(metadata.height, 440);
      const pixels = await image.ensureAlpha().raw().toBuffer();
      let orange = 0;
      for (let i = 0; i < pixels.length; i += 4)
        if (pixels[i] > 220 && pixels[i + 1] > 50 && pixels[i + 1] < 150 && pixels[i + 2] < 30)
          orange++;
      assert.ok(orange > 1000, `${format} export must include edited vector pixels`);
    }
  }

  const bundle = execFileSync(
    "bun",
    [
      "build",
      "scripts/fixtures/vector-browser-tools.ts",
      "--target",
      "browser",
      "--format",
      "iife",
    ],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  );
  await page.addScriptTag({ content: bundle });
  const imports = await page.evaluate(() => {
    const wrap = (shape) =>
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="#f60">${shape}</svg>`;
    return [
      '<path d="M10 10h80v80h-80z"/>',
      '<rect x="10" y="10" width="80" height="70" rx="12"/>',
      '<circle cx="50" cy="50" r="30"/>',
      '<ellipse cx="50" cy="50" rx="40" ry="20"/>',
      '<line x1="10" y1="20" x2="80" y2="70"/>',
      '<polyline points="10,10 40,70 90,20"/>',
      '<polygon points="10,10 40,70 90,20"/>',
      '<path d="M0 0L10 10"/><path d="M20 20L30 30"/>',
      '<g transform="rotate(20)"><path d="M0 0L10 10"/></g>',
      '<path d="M0 0L10 10" fill="url(#gradient)"/>',
      '<path d="M0 0L10 10" stroke-width="NaN" stroke="#000"/>',
      '<path d="M0 0 A1 1 0 2 0 5 5"/>',
    ].map((shape) => ({
      source: wrap(shape),
      result: vectorBrowserTools.inspectSvgImport(wrap(shape)),
    }));
  });
  for (const [index, imported] of imports.entries()) {
    if (index < 8) {
      assert.ok(imported.result.editable, imported.result.reason);
      const path = imported.result.editable.vectorPath;
      assert.ok(path.contours.length && path.contours[0].points.length);
      const original = await sharp(Buffer.from(imported.source))
        .resize(300, 300)
        .ensureAlpha()
        .raw()
        .toBuffer();
      const converted = await sharp(
        Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="#f60"><path d="${path.d}" /></svg>`,
        ),
      )
        .resize(300, 300)
        .ensureAlpha()
        .raw()
        .toBuffer();
      let error = 0;
      for (let i = 3; i < original.length; i += 4) error += Math.abs(original[i] - converted[i]);
      assert.ok(error / (original.length / 4) < 0.2, `Imported shape ${index} differs`);
    } else assert.match(imported.result.reason, /^Original SVG retained:/);
  }
  assert.deepEqual(errors, []);
  console.log(
    "Vector browser checks passed: transformed point/handle drags, point controls, curve insertion, pen closure/cancel, undo, SVG/PNG/WebP exports, supported SVG imports, and unsupported-feature fallbacks.",
  );
} finally {
  await browser.close();
  await rm(temporary, { recursive: true, force: true });
}
